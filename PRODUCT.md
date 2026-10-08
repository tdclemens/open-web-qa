# OpenWebQA

A Node.js CLI that turns a markdown QA test plan into a directed acyclic graph of browser test cases and runs them with headless Playwright. It is for QA engineers and developers who want to describe browser tests in markdown and let an AI agent compile and execute them.

## Features

- Compiles a markdown plan into a DAG of test cases using an OpenAI agent or a deterministic offline mock agent.
- With `--no-blind`, the plan step runs a "deep" agent that can explore the current directory (list_dir/read_file) while compiling the DAG; a sandbox and ignore list (hidden files, node_modules) keep unexposed files out of reach.
- Supports OpenAI-compatible endpoints, including local models like Ollama and LM Studio, via a custom base URL.
- Validates the graph, detecting circular dependencies and unknown case references.
- Computes topological execution levels so dependent cases run in series and independent cases run in parallel.
- Runs cases up to a configurable worker count concurrently, each in a fresh browser context.
- Supports actions for goto, click, fill, press, wait, screenshot, assertions, and evaluate.
- Cascades skips to dependents when a dependency fails or is skipped.
- Saves a failure screenshot per failed case and prints a summary report.
- Returns distinct exit codes for success, test failure, and usage or validation errors.
- Offers a dry-run mode that compiles, validates, and prints execution levels without executing.
- Reads a JSON config from a `.openwebqa/` directory in the project (`./.openwebqa/config.json`) and in the home directory (`~/.openwebqa/config.json`), merged field by field with the project file winning; it holds AI connection settings (model, endpoint, API key).
- Stores named login credentials in `credentials.json` (in either `.openwebqa/` directory, merged per id with the project entry winning); passes each credential's id and description (never its values) to the AI agent while it compiles the plan, and substitutes `{{credential:<id>.username}}` / `{{credential:<id>.password}}` placeholders in the compiled plan with the real values before execution, so login credentials do not need to appear in the plan markdown; settings resolve as CLI flag > env > project config > global config > default.

## Goals

- Let a user describe browser tests in plain markdown and get a runnable, validated test graph.
- Enable offline and local-model testing without a paid OpenAI key.
- Give clear, actionable pass/fail results with per-case timing and screenshots.
- Provide a fast compile-and-inspect workflow before committing to a full run.

## Constraints

- Requires Node.js version 18 or higher and runs in TypeScript compiled to JavaScript.
- Depends on commander, openai, and playwright.
- Uses headless Chromium by default; the headful option runs the browser visibly.
- Build with `npm run build`, type-check with `npm run typecheck`, and test with `npm test`.
- Each case runs in its own isolated browser context, so shared state must be re-navigated or expressed as an explicit dependency.
- Exit code 0 means no failed cases, with skips not counted as failures.