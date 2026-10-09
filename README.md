# OpenWebQA

A CLI that takes a **markdown QA test plan**, sends it to an **AI agent** (OpenAI or any
OpenAI-compatible endpoint, including local models), receives a **DAG of browser test
cases**, validates it (including circular-dependency detection), and **executes it with
headless Playwright** — running cases in series/parallel according to their dependencies.

```
plan.md ──► AI agent ──► TestPlanGraph (DAG) ──► validate ──► levels ──► Playwright run ──► report
           (JSON Plan)   (cases + dependsOn)              (topological)  (headless Chromium)
```

## Requirements

- Node.js >= 22

## Install

```bash
npm run setup
```

That runs `npm install`, `npm run build`, and `npx playwright install chromium`
(downloads the Chromium browser binary). On a bare Linux system, OS libraries may also
be needed (requires root): `sudo npm run setup:deps`.

Run directly with `node dist/cli.js <plan-file> ...`, or link the binary:

```bash
npm link   # exposes the `openwebqa` command
```

## Usage

```bash
openwebqa <plan-file> [options]
```

| Option | Description |
| --- | --- |
| `--agent <openai\|mock>` | Agent that compiles the plan (default `openai`; `mock` is deterministic and offline) |
| `--model <id>` | Model id for the OpenAI agent (default `gpt-4o-mini`) |
| `--ai-endpoint <url>` | Custom OpenAI-compatible base URL (takes precedence over `OPENAI_BASE_URL`) |
| `--api-key <key>` | API key for the endpoint (falls back to `OPENAI_API_KEY`, then `not-needed` for keyless local servers) |
| `--workers <n>` | Max test cases running in parallel (default 4) |
| `--timeout <ms>` | Default per-case timeout (default 30000) |
| `--headful` | Run the browser visibly instead of headless |
| `--no-blind` | Let the agent explore the current directory (`list_dir`/`read_file`) while it compiles the plan. An ignore list keeps hidden files and `node_modules` out of its reach. Requires `--agent openai`. |
| `--dry-run` | Compile + validate + print execution levels, then exit without executing |
| `--base-url <url>` | Base for resolving relative `goto` URLs (default: `file://` + the plan file's directory) |
| `--results-dir <dir>` | Directory for failure screenshots (default `openwebqa-results`) |

### Examples

Run the bundled sample plan against the demo blog app (from the `examples/`
directory, so the demo credentials in `examples/.openwebqa/credentials.json`
are picked up):

```bash
cd examples
node blog/server.js &   # starts the demo server on http://localhost:4173
node ../dist/cli.js sample-plan.md --agent mock
```

The server must be running first because the app is client/server.

Run against a local model (e.g. Ollama or LM Studio):

```bash
openwebqa plan.md --ai-endpoint http://127.0.0.1:11434/v1 --api-key not-needed --model llama3
```

Compile and inspect the plan without executing:

```bash
openwebqa plan.md --dry-run
# Level 0: load-blog, login, logout, create-blog-post
# Level 1: read-blog-post
```

## Configuration

OpenWebQA reads JSON config from a `.openwebqa` **directory** in two
locations. The **project** directory (`./.openwebqa/`, in the directory you
run `openwebqa` from) takes precedence over the **global** directory
(`~/.openwebqa/`, in your home directory); settings the project files do not
set fall back to the global files, so both may be present at the same time.

Each directory may hold two files:

| File | Purpose |
| --- | --- |
| `config.json` | AI connection settings (the `ai` section) |
| `credentials.json` | Named login credentials for test plans |

### config.json

| Key | Meaning | Equivalent flag |
| --- | --- | --- |
| `ai.model` | Model id for the AI agent | `--model` |
| `ai.endpoint` | OpenAI-compatible base URL | `--ai-endpoint` |
| `ai.apiKey` | API key for the endpoint | `--api-key` |

```json
{
  "ai": {
    "model": "llama3",
    "endpoint": "http://127.0.0.1:11434/v1",
    "apiKey": "not-needed"
  }
}
```

Precedence for every setting: **CLI flag > environment variable
(`OPENAI_BASE_URL`, `OPENAI_API_KEY`) > `./.openwebqa/config.json` >
`~/.openwebqa/config.json` > built-in default**. All values are strings; empty
strings are treated as unset. Unknown keys, non-string values, or invalid JSON
are configuration errors (exit code 2) that name the offending file and key. A
missing or empty file is fine.

### credentials.json

A JSON array of named login credentials. Each entry has an `id` (referenced
from plans), a `description` (what the credential is for), and a `username`
and/or `password`:

```json
[
  {
    "id": "qa",
    "description": "Regular demo user seeded in the blog app",
    "username": "qa@example.com",
    "password": "s3cret"
  }
]
```

When credentials are configured, their **ids and descriptions (never the
values)** are automatically passed to the AI agent while it compiles the plan,
so the agent can choose the right one for each login. Test cases reference a
credential's values with placeholders in `fill` actions (or any string
action field):

```
{{credential:<id>.username}}    {{credential:<id>.password}}
```

The CLI replaces every placeholder with the real value just before execution
(and before `--dry-run` exits), so the values never appear in the plan
markdown or on the console, and the offline `--agent mock` never receives them
— its plans can use the same placeholders, and they are resolved at run time.
A placeholder that cannot be resolved (unknown id, missing field, malformed
placeholder, or no credentials configured at all) is a usage error (exit code
2) that names the offending case and placeholder. Entries with the same `id`
in the project and global files merge with the project entry winning.

The repository's `.gitignore` ignores `.openwebqa/` by default because it may
hold an API key and passwords; the sample demo credential under
`examples/.openwebqa/` is force-included with negation rules. Use `git add -f`
(or a negation rule) to commit a keyless project config if you want one.

## Plan-time exploration (`--no-blind`)

By default the agent compiles the plan "blind" — from the markdown alone. With
`--no-blind`, the plan step runs a **deep agent**: a tool-calling loop in which
the model may inspect the current directory before it commits to the DAG.

- Tools: `list_dir` (directory listing, capped at 200 entries) and `read_file`
  (first 64 KB of a text file; binary files are refused).
- The sandbox root is the directory you launched `openwebqa` from. Paths can
  never leave it — `..`, absolute paths, and symlinks pointing outside are all
  rejected.
- The **ignore list** (default: `.*` for any hidden file/directory such as
  `.env`/`.git`, plus `node_modules`) is enforced on every listing and read,
  so files that should not be exposed are never shown to the model. Ignored
  paths produce an `error:` tool result instead of content.
- The loop runs with no turn cap: it stops as soon as the model replies with
  the plan JSON.

Your endpoint must support OpenAI-style function calling (OpenAI, Ollama,
LM Studio, ...). The deep agent uses the same `--model`/`--ai-endpoint`/
`--api-key` options and produces the same validated DAG.

```bash
# Explore the app source in the current directory while compiling the plan
openwebqa plan.md --no-blind
```

### Live planning feedback

While the AI agent compiles the plan the CLI shows animated feedback on
**stderr** so you can see that it is still working (a plain agent call can
take a while):

```text
  ✓ list_dir src
  ✓ read_file src/client/app.ts — 2 KB
  ✗ read_file .env — no such file or directory: .env
⠼ compiling plan with gpt-4o-mini… 12s
```

- The bottom line is an animated spinner with the elapsed planning time; it
  is rewritten in place while the model thinks and while tools run.
- With `--no-blind`, every exploration command is printed **inline, in
  place**: the line appears with its own spinner when the tool starts and is
  rewritten in place with a one-line summary of the result when it finishes
  (entry counts for `list_dir`, bytes shown for `read_file`, or the error
  text).
- On a TTY the status block is redrawn in place (no scrolling noise); when
  stderr is piped (CI, scripts) plain lines are printed instead and no
  animation is used. When `--agent mock` is selected no feedback is shown
  (the mock compiler is instant).
- Planning ends with a summary line (`✓ plan compiled in 12s` or
  `✗ planning failed in 12s`); the command history stays on screen above it.

## Plan format

With `--agent openai`, the plan is free-form markdown — the model converts it to a DAG.
With `--agent mock`, the plan uses a fixed grammar:

- Each `## ` heading is one test case; its id is the kebab-case slug of the heading.
- `- ` bullets are actions, in order; everything else is ignored.

```markdown
## Submit form
- depends enter-email
- goto http://localhost:4173/
- fill #email test@example.com
- click #submit
- assertText #msg Welcome test@example.com
```

Actions: `goto`, `click`, `fill`, `press`, `waitForSelector`, `wait`, `screenshot`,
`assertUrl`, `assertText`, `evaluate` (plus `depends <id1>, <id2>, ...` for dependencies).

The text of a `fill`/`assertText` action may include a
`{{credential:<id>.username}}` or `{{credential:<id>.password}}` placeholder;
the CLI substitutes it from `credentials.json` before execution (see
Configuration).

## Execution model

- Cases run as soon as all their `dependsOn` cases have **passed**, up to `--workers`
  cases concurrently; independent branches run in parallel, dependent ones in series.
- Each case runs in a **fresh browser context** (isolation; cases that share state must
  re-navigate or depend explicitly).
- If a dependency fails or is skipped, dependents are **skipped** (cascade) without
  launching browser work.
- Failures record the error and save a screenshot to `<results-dir>/<case-id>.png`.

## Output & exit codes

```
Level 0: load-home
Level 1: enter-email
Level 2: submit-form
PASS load-home Load home (210ms)
PASS enter-email Enter email (180ms)
FAIL submit-form Submit form (305ms) error: ... | screenshot: openwebqa-results/submit-form.png
Total 3 | passed 2 | failed 1 | skipped 0 | elapsed 0.95s
```

Exit codes: `0` = no failed cases (skips don't count), `1` = one or more failures or a
runtime error, `2` = bad usage, unreadable plan, or graph validation errors (e.g.
circular dependencies, unknown case references).

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emit dist/
```

Layout: `src/graph/` (types, validation/cycle detection, topological levels),
`src/agent/` (OpenAI + mock plan compilers), `src/executor/` (action mapping + DAG
runner), `src/config.ts` (config/credentials loading + merging, credential
planning note, placeholder resolution), `src/cli.ts`, `src/report.ts`,
`examples/` (demo blog app: server + client, sample plan, and demo credentials), `test/`.

This project is being developed with [pi-dag-planner](https://github.com/tdclemens/pi-dag-planner).
