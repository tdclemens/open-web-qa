# OpenWebQA

A CLI tool that turns a **markdown QA test plan** into a **DAG JSON plan** with an **AI agent**,
then runs the plan with Playwright to test a web application.

```
plan.md ──► AI agent ──► TestPlanGraph (DAG) ──► validate ──► levels ──► Playwright run ──► report
           (JSON Plan)   (cases + dependsOn)              (topological)  (headless Chromium)
```

The JSON plan is a DAG — a directed acyclic graph — that accomplishes a few things:
1. translates the actual QA test plan written in plain english to a plan that can be executed with playwright
2. ensures that tests are run in order
3. parallelizes tests that can run at the same time

## Requirements

- Node.js >= 22

## Install

```bash
npm run setup
```

That runs `npm install`, `npm run build`, and `npx playwright install chromium`,
the last of which downloads the Chromium browser binary. On a bare Linux system,
OS libraries may also be needed, and they require root: `sudo npm run setup:deps`.

Run directly with `node dist/cli.js <plan-file> ...`, or link the binary:

```bash
npm link   # exposes the `openwebqa` command
```

## Usage

Three modes:

```bash
openwebqa <plan-file> [options]          # compile a markdown plan, then execute it
openwebqa compile <plan-file> [options]  # compile, validate, and save a JSON plan file without executing it
openwebqa run <plan-file> [options]      # validate and execute a saved JSON plan, skipping AI planning
```

A `.json` file passed to the root command is executed directly, exactly as `run`
does, so `openwebqa plan.json` is a shortcut for `openwebqa run plan.json`. The table
below notes which mode each option applies to. Full lists: `openwebqa --help`,
`openwebqa compile --help`, `openwebqa run --help`.

| Option | Applies to | Description |
| --- | --- | --- |
| `--agent <openai\|mock>` | root .md, `compile` | Agent that compiles the plan. Default `openai`; `mock` is deterministic and offline |
| `--model <id>` | root .md, `compile` | Model id for the OpenAI agent. Default `gpt-4o-mini` |
| `--ai-endpoint <url>` | root .md, `compile` | Custom OpenAI-compatible base URL; takes precedence over `OPENAI_BASE_URL` |
| `--api-key <key>` | root .md, `compile` | API key for the endpoint. Falls back to `OPENAI_API_KEY`, then `not-needed` for keyless local servers |
| `--workers <n>` | root, `run` | Max test cases running in parallel. Default 4 |
| `--timeout <ms>` | root, `run` | Per-case timeout. Default 30000 |
| `--headful` | root, `run` | Run the browser visibly instead of headless |
| `--no-blind` | root .md, `compile` | Let the agent explore the current directory while it compiles the plan (file-heavy digging via explore subagents, to keep the planner's context clean) — see [Plan-time exploration](#plan-time-exploration). Requires `--agent openai`. |
| `--no-anim` | root .md, `compile` | Disable the animated planning feedback; print plain status lines instead. `OPENWEBQA_NO_ANIM=1` does the same |
| `--dry-run` | root, `run` | Compile/validate + print execution levels, then exit without executing |
| `--out <file>` | `compile` | Output JSON plan path. Default: the plan file's basename with a `.json` extension, in the current directory |
| `--base-url <url>` | root, `run` | Base for resolving relative `goto` URLs. Default: `file://` + the plan file's directory |
| `--results-dir <dir>` | root, `run` | Directory for failure screenshots. Default `openwebqa-results` |

### Examples

Run the bundled sample plan against the demo blog app. Run it from the `examples/`
directory so the demo credentials in `examples/.openwebqa/credentials.json`
are picked up:

```bash
cd examples
node blog/server.js &   # starts the demo server on http://localhost:4173
node ../dist/cli.js sample-plan.md --agent mock
```

The server must be running first because the app is client/server.

Run against a local model such as Ollama or LM Studio:

```bash
openwebqa plan.md --ai-endpoint http://127.0.0.1:11434/v1 --api-key not-needed --model llama3
```

Compile and inspect the plan without executing:

```bash
openwebqa plan.md --dry-run
# Level 0: load-blog, login, logout, create-blog-post
# Level 1: read-blog-post
```

## Saved JSON plans

To keep a test plan in version control, save the compiled DAG as a JSON file
and run it back without an AI agent — no API key and no model needed:

```bash
# compile the markdown plan and save it as ./sample-plan.json; override the path with --out
openwebqa compile sample-plan.md

# later, or in CI: validate and execute the saved plan
openwebqa run sample-plan.json
```

- The JSON file is the exact `TestPlanGraph` shape: a `cases` array whose
  entries have `id`, `name`, `dependsOn`, an `actions` array built from the
  action types in the Plan format section below, and an optional `timeoutMs`.
  It is pretty-printed so diffs in review are readable.
- `run` validates the saved file before any browser work. Structurally: it
  must be well-formed JSON with the right shape. Semantically: no duplicate
  ids, unknown case references, unknown action types, or circular
  dependencies. A hand-edited plan that fails validation exits with code 2
  and a clear message.
- `{{credential:<id>.username}}` / `{{credential:<id>.password}}` placeholders
  work in saved plans exactly as in compiled ones: the values are substituted
  from `credentials.json` just before execution and never appear in the
  committed file.
- Relative `goto` URLs resolve against `--base-url`, which defaults to the
  saved plan's directory. After a hand-edit, `openwebqa run plan.json
  --dry-run` is a quick sanity check: it validates and prints the execution
  levels without launching a browser.

## Configuration

OpenWebQA reads JSON config from a `.openwebqa` **directory** in two
locations. The **project** directory, `./.openwebqa/` in the directory you run
`openwebqa` from, takes precedence over the **global** directory,
`~/.openwebqa/` in your home directory; settings the project files do not
set fall back to the global files, so both may be present at the same time.

Each directory may hold two files:

| File | Purpose |
| --- | --- |
| `config.json` | AI connection settings, in the `ai` section |
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

Precedence for every setting, highest first: the CLI flag, then the
environment variables `OPENAI_BASE_URL` and `OPENAI_API_KEY`, then
`./.openwebqa/config.json`, then `~/.openwebqa/config.json`, then the
built-in default. All values are strings; empty strings are treated as
unset. Unknown keys, non-string values, or invalid JSON are configuration
errors: the CLI exits with code 2 and names the offending file and key. A
missing or empty file is fine.

### credentials.json

A JSON array of named login credentials. Each entry has an `id` that plans
reference, a `description` of what the credential is for, and a `username`
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

When credentials are configured, the AI agent automatically receives each
credential's **id and description — never its values** — while it compiles
the plan, so it can choose the right one for each login. Test cases reference
a credential's values with placeholders in `fill` actions, or in any string
action field:

```
{{credential:<id>.username}}    {{credential:<id>.password}}
```

- The CLI substitutes each placeholder **just before execution**, including
  before `--dry-run` exits, so the real values never appear in the plan
  markdown or on the console. The offline `--agent mock` never receives them
  either — its plans use the same placeholders, resolved at run time.
- A placeholder that cannot be resolved — unknown id, missing field,
  malformed placeholder, or no credentials configured at all — is a usage
  error: the CLI exits with code 2 and names the offending case and
  placeholder.
- Entries with the same `id` in the project and global files merge, with the
  project entry winning.

The repository's `.gitignore` ignores `.openwebqa/` by default because it may
hold an API key and passwords; the sample demo credential under
`examples/.openwebqa/` is force-included with negation rules. Use `git add -f`,
or a negation rule, to commit a keyless project config if you want one.

## Plan-time exploration

By default the agent compiles the plan "blind" — from the markdown alone. With
`--no-blind`, the plan step runs a **deep agent**: a tool-calling loop in which
the model may inspect the current directory before it commits to the DAG.

- Tools: `list_dir` lists a directory, capped at 200 entries; `read_file`
  reads the first 64 KB of a text file and refuses binary files; `explore`
  delegates a focused question to an **exploration subagent** (below).
- **Explore subagents keep the planner's context clean.** A tool result —
  especially a file read — stays in the planner's context for the whole run,
  which is expensive and unreliable on large projects. `explore` hands one
  focused question (e.g. "what CSS selector does the sign-in form use for the
  email field?") to a fresh subagent that has the same sandboxed tools but
  its **own context**: the subagent runs its own tool loop, and only its short
  findings report comes back to the planner. Files the subagent reads never
  enter the planner's context. The system prompt steers the planner to use
  `list_dir` directly for quick orientation and `explore` for anything that
  requires opening files.
- Subagent runs are bounded in both directions: the subagent is turn-capped
  (a subagent that never converges becomes an `error:` result the planner can
  react to), and its report is truncated to 16 KB before it reaches the
  planner.
- The sandbox root is the directory you launched `openwebqa` from. Paths can
  never leave it — `..`, absolute paths, and symlinks pointing outside are all
  rejected. This applies inside subagents too.
- The **ignore list** defaults to `.*`, covering any hidden file or directory
  such as `.env` and `.git`, plus `node_modules`. It is enforced on every
  listing and read, so files that should not be exposed are never shown to the
  model; ignored paths produce an `error:` tool result instead of content.
- The planner loop runs with no turn cap: it stops as soon as the model
  replies with the plan JSON.

Your endpoint must support OpenAI-style function calling; OpenAI, Ollama,
and LM Studio all do. The deep agent uses the same `--model`/`--ai-endpoint`/
`--api-key` options and produces the same validated DAG.

```bash
# Explore the app source in the current directory while compiling the plan
openwebqa plan.md --no-blind
```

### Live planning feedback

While the AI agent compiles the plan the CLI shows animated feedback on
**stderr** so you can see that it is still working; a plain agent call can
take a while:

```text
  ✓ explore which selector does the login form use… — report, 1.1 KB
  ✓ list_dir src
  ✓ read_file src/client/app.ts — 2 KB
  ✗ read_file .env — no such file or directory: .env
⠼ compiling plan with gpt-4o-mini… 12s
```

- The bottom line is an animated spinner with the elapsed planning time; it
  is rewritten in place while the model thinks and while tools run.
- With `--no-blind`, every exploration command is printed **inline, in
  place**: the line appears with its own spinner when the tool starts and is
  rewritten in place with a one-line result summary when it finishes: entry
  counts for `list_dir`, bytes shown for `read_file`, the report size for
  `explore`, or the error text. A subagent's internal file reads are not
  printed — one `explore` line covers the whole delegated task.
- On a TTY the status block is redrawn in place, with no scrolling noise.
  Plain lines are printed instead when stderr is piped, as in CI or scripts,
  or when `--no-anim` or `OPENWEBQA_NO_ANIM=1` is set. With `--agent mock` no
  feedback is shown; the mock compiler is instant.
- Planning ends with a summary line such as `✓ plan compiled in 12s` or
  `✗ planning failed in 12s`; the command history stays on screen above it.

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
`assertUrl`, `assertUrlPartial`, `assertText`, and `evaluate`. Two actions take an
optional trailing argument: `waitForSelector <selector> [ms]` (the final token is
the timeout in milliseconds when it is a non-negative number; the selector may
itself contain spaces) and `screenshot [path]` (save the capture to that file
instead of discarding it). `assertUrl` matches the full URL; `assertUrlPartial`
matches a substring.
Dependencies between cases are declared with a `depends <id1>, <id2>, ...` bullet,
and a case's overall timeout can be overridden with a case-level `timeout <ms>`
bullet (last one wins; otherwise the `--timeout` default applies).

The text of a `fill`/`assertText` action may include a
`{{credential:<id>.username}}` or `{{credential:<id>.password}}` placeholder;
the CLI substitutes it from `credentials.json` before execution. See the
Configuration section.

## Execution model

- Cases run as soon as all their `dependsOn` cases have **passed**, up to `--workers`
  cases concurrently; independent branches run in parallel, dependent ones in series.
- Each case runs in a **fresh browser context** for isolation; cases that
  share state must re-navigate or depend explicitly.
- If a dependency fails or is skipped, dependents are **skipped** in a
  cascade, without launching browser work.
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

Exit codes: `0` = no failed cases, skips don't count. `1` = one or more
failures or a runtime error. `2` = bad usage, unreadable plan, or graph
validation errors, for example circular dependencies or unknown case
references.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emit dist/
```

Layout:

- `src/graph/` — types, validation/cycle detection, topological levels, saved-plan JSON parsing
- `src/agent/` — OpenAI + mock plan compilers, deep agent, planning feedback
- `src/executor/` — action mapping + DAG runner
- `src/config.ts` — config/credentials loading + merging, credential planning note, placeholder resolution
- `src/cli.ts` — root + `compile`/`run` mode programs
- `src/report.ts` — console output formatting + exit codes
- `examples/` — demo blog app: server + client, sample plan, and demo credentials
- `test/` — vitest test suite

This project is being developed with [pi-dag-planner](https://github.com/tdclemens/pi-dag-planner).
