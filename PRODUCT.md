# OpenWebQA

A Node.js CLI that turns a markdown QA test plan into a directed acyclic graph of browser test cases and runs them with headless Playwright. It is for QA engineers and developers who want to describe browser tests in markdown and let an AI agent compile and execute them.

## Features

- Compiles a markdown plan into a DAG of test cases using an OpenAI agent or a deterministic offline mock agent.
- With `--no-blind`, the plan step runs a "deep" agent that can explore the current directory while compiling the DAG: direct list_dir/read_file checks plus an `explore` tool that delegates file-heavy questions to exploration subagents, which read in their own context and return only a short, byte-capped findings report, keeping the planner's context clean; a sandbox and ignore list (hidden files, node_modules) keep unexposed files out of reach of both.
- Shows animated planning feedback on stderr while the AI compiles the plan (spinner + elapsed time, in-place on a TTY, plain lines when piped), printing each deep-agent exploration command inline and finalizing it in place with a one-line result summary.
- Supports OpenAI-compatible endpoints, including local models like Ollama and LM Studio, via a custom base URL.
- Validates the graph, detecting circular dependencies and unknown case references.
- Computes topological execution levels so dependent cases run in series and independent cases run in parallel.
- Runs cases up to a configurable worker count concurrently, each in a fresh browser context.
- Supports actions for goto, click, fill, press, wait, screenshot, assertions, and evaluate.
- Cascades skips to dependents when a dependency fails or is skipped.
- Saves a failure screenshot per failed case and streams each case's PASS/FAIL/SKIP line as it settles, finishing with a summary report.
- Returns distinct exit codes for success, test failure, and usage or validation errors.
- Offers a dry-run mode that compiles, validates, and prints execution levels without executing.
- Supports saved JSON plans for version control: `openwebqa compile <plan.md>` compiles, validates, and writes the DAG to a JSON file (default: the plan file's basename plus .json in the current directory, override with `--out`) without executing; `openwebqa run <plan.json>` shape-checks, validates, and executes a saved plan with no AI agent; a `.json` file passed to the root command runs directly. Saved plans keep credential placeholders (never the values), so committed files stay secret-free and hand-editable between runs.
- Reads a JSON config from a `.openwebqa/` directory in the project (`./.openwebqa/config.json`) and in the home directory (`~/.openwebqa/config.json`), merged field by field with the project file winning; it holds AI connection settings (model, endpoint, API key).
- Stores named login credentials in `credentials.json` (in either `.openwebqa/` directory, merged per id with the project entry winning); passes each credential's id and description (never its values) to the AI agent while it compiles the plan, and substitutes `{{credential:<id>.username}}` / `{{credential:<id>.password}}` placeholders in the compiled plan with the real values before execution, so login credentials do not need to appear in the plan markdown; settings resolve as CLI flag > env > project config > global config > default.

## Goals

- Let a user describe browser tests in plain markdown and get a runnable, validated test graph.
- Enable offline and local-model testing without a paid OpenAI key.
- Give clear, actionable pass/fail results with per-case timing and screenshots.
- Provide a fast compile-and-inspect workflow before committing to a full run.
- Let a user keep the compiled test plan in version control as a committed, diffable JSON file that can be hand-edited and re-run without an AI agent or API key.

## Constraints

- Requires Node.js version 18 or higher and runs in TypeScript compiled to JavaScript.
- Depends on commander, openai, and playwright.
- Uses headless Chromium by default; the headful option runs the browser visibly.
- Build with `npm run build`, type-check with `npm run typecheck`, and test with `npm test`.
- Each case runs in its own isolated browser context, so shared state must be re-navigated or expressed as an explicit dependency.
- Exit code 0 means no failed cases, with skips not counted as failures.