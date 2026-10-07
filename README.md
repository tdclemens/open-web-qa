# OpenWebQA

A CLI that takes a **markdown QA test plan**, sends it to an **AI agent** (OpenAI or any
OpenAI-compatible endpoint, including local models), receives a **DAG of browser test
cases**, validates it (including circular-dependency detection), and **executes it with
headless Playwright** — running cases in series/parallel according to their dependencies.

```
plan.md ──► AI agent ──► TestPlanGraph (DAG) ──► validate ──► levels ──► Playwright run ──► report
              (JSON)        (cases + dependsOn)   (cycles, bad refs)   (topological)  (headless Chromium)
```

## Requirements

- Node.js >= 18

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
| `--dry-run` | Compile + validate + print execution levels, then exit without executing |
| `--base-url <url>` | Base for resolving relative `goto` URLs (default: `file://` + the plan file's directory) |
| `--results-dir <dir>` | Directory for failure screenshots (default `openwebqa-results`) |

### Examples

Run the bundled sample plan fully offline:

```bash
node dist/cli.js examples/sample-plan.md --agent mock
```

Run against a local model (e.g. Ollama or LM Studio):

```bash
openwebqa plan.md --ai-endpoint http://127.0.0.1:11434/v1 --api-key not-needed --model llama3
```

Compile and inspect the plan without executing:

```bash
openwebqa plan.md --dry-run
# Level 0: load-home
# Level 1: enter-email
# Level 2: submit-form
```

## Plan format

With `--agent openai`, the plan is free-form markdown — the model converts it to a DAG.
With `--agent mock`, the plan uses a fixed grammar:

- Each `## ` heading is one test case; its id is the kebab-case slug of the heading.
- `- ` bullets are actions, in order; everything else is ignored.

```markdown
## Submit form
- depends enter-email
- goto demo.html
- fill #email test@example.com
- click #submit
- assertText #msg Welcome test@example.com
```

Actions: `goto`, `click`, `fill`, `press`, `waitForSelector`, `wait`, `screenshot`,
`assertUrl`, `assertText`, `evaluate` (plus `depends <id1>, <id2>, ...` for dependencies).

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
runner), `src/cli.ts`, `src/report.ts`, `examples/` (demo page + sample plan), `test/`.

This project is being developed with [pi-dag-planner](https://github.com/tdclemens/pi-dag-planner).
