#!/usr/bin/env node
// OpenWebQA CLI: submits a markdown QA test plan to an AI agent, validates
// the resulting test-case DAG (including circular-dependency detection), and
// executes it with headless Playwright.

import fs from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { createMockAgent } from "./agent/mock";
import { createOpenAiAgent } from "./agent/openai";
import type { OpenAiAgent } from "./agent/openai";
import { createDeepAgent, DEFAULT_IGNORE_LIST } from "./agent/deep";
import { PlanningFeedback } from "./agent/feedback";
import {
  ConfigError,
  buildCredentialsNote,
  loadConfig,
  loadCredentials,
  resolveAiOptions,
  resolveCredentialPlaceholders,
} from "./config";
import type { LoadedConfig, LoadedCredentials } from "./config";
import { validateGraph } from "./graph/validate";
import { computeLevels } from "./graph/topo";
import { runGraph } from "./executor/runner";
import { exitCodeFor, formatReport } from "./report";
import type { TestPlanGraph } from "./graph/types";

const program = new Command();

program
  .name("openwebqa")
  .description(
    "Submit a markdown QA test plan to an AI agent, validate the resulting DAG of " +
      "browser test cases (including circular-dependency detection), and execute it " +
      "with headless Playwright.",
  )
  .argument("<plan-file>", "path to the markdown QA test plan")
  .option("--agent <openai|mock>", "agent that compiles the plan into a DAG (default: openai)", "openai")
  .option("--model <id>", "model id for the OpenAI agent")
  .option(
    "--ai-endpoint <url>",
    "custom OpenAI-compatible base URL for locally running or home-network AI (takes precedence over env OPENAI_BASE_URL)",
  )
  .option("--api-key <key>", "API key for the AI endpoint (env OPENAI_API_KEY fallback)")
  .option(
    "--workers <n>",
    "max number of test cases running in parallel (default: 4)",
    (value: string) => {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new InvalidArgumentError("must be a positive integer");
      }
      return n;
    },
    4,
  )
  .option(
    "--timeout <ms>",
    "default per-case timeout in milliseconds (default: 30000)",
    (value: string) => {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 0) {
        throw new InvalidArgumentError("must be a non-negative integer");
      }
      return n;
    },
    30000,
  )
  .option("--headful", "run the browser headful (visible) instead of headless", false)
  .option(
    "--no-blind",
    "let the OpenAI agent explore the current directory (list_dir/read_file) while it compiles the " +
      "plan; the ignore list keeps hidden files and node_modules out of its reach (requires --agent openai)",
  )
  .option("--dry-run", "compile, validate, and print the execution levels, then exit without executing", false)
  .option(
    "--no-anim",
    "disable the in-place animated planning spinner; print plain status lines instead (also OPENWEBQA_NO_ANIM=1)",
  )
  .option(
    "--base-url <url>",
    "base URL for resolving relative goto URLs (default: file:// + the plan file's directory)",
  )
  .option("--results-dir <dir>", "directory for failure screenshots (default: openwebqa-results)", "openwebqa-results")
  .showHelpAfterError("-h, --help for usage")
  .parse(process.argv);

interface CliOptions {
  agent: string;
  model?: string;
  aiEndpoint?: string;
  apiKey?: string;
  workers: number;
  timeout: number;
  headful: boolean;
  /** Commander negation flag: true by default, false only when --no-blind is passed. */
  blind: boolean;
  /** Commander negation flag: true by default, false only when --no-anim is passed. */
  anim: boolean;
  dryRun: boolean;
  baseUrl?: string;
  resultsDir: string;
}

async function main(): Promise<void> {
  const opts = program.opts() as CliOptions;
  const planFile = program.args[0];
  if (typeof planFile !== "string") {
    console.error("openwebqa: missing required argument <plan-file>");
    process.exit(2);
  }

  if (opts.agent !== "openai" && opts.agent !== "mock") {
    console.error(`openwebqa: invalid --agent "${opts.agent}" (expected "openai" or "mock")`);
    process.exit(2);
  }

  // --no-blind is a commander negation flag: opts.blind defaults to true and
  // becomes false only when the user passes --no-blind.
  const noBlind = opts.blind === false;
  if (noBlind && opts.agent !== "openai") {
    console.error(
      "openwebqa: --no-blind requires --agent openai (the mock agent is offline and cannot explore)",
    );
    process.exit(2);
  }

  // 0. Load config + credentials: ./.openwebqa/ (project) overrides
  //    ~/.openwebqa/ (global); config fields merge per field and credential
  //    entries per id (project wins). A malformed file is a usage error (2).
  let loaded: LoadedConfig;
  let loadedCredentials: LoadedCredentials;
  try {
    loaded = loadConfig();
    loadedCredentials = loadCredentials();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`openwebqa: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  // 1. Read the plan file (missing/unreadable -> error, exit 2).
  let markdown: string;
  try {
    markdown = fs.readFileSync(planFile, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`openwebqa: cannot read plan file "${planFile}": ${message}`);
    process.exit(2);
  }

  // 2. Compile the plan into a test-case DAG with the chosen agent.
  //    Effective AI options: CLI flag > env (OPENAI_BASE_URL / OPENAI_API_KEY)
  //    > ./.openwebqa/config.json > ~/.openwebqa/config.json (see src/config.ts);
  //    the env fallbacks and the "not-needed" default are handled by the
  //    agent itself.
  //    --no-blind upgrades the OpenAI agent to the "deep" agent, which may
  //    explore the current directory (list_dir/read_file, sandboxed by the
  //    ignore list) while it is coming up with the DAG plan.
  const ai = resolveAiOptions(loaded.config, process.env, {
    model: opts.model,
    aiEndpoint: opts.aiEndpoint,
    apiKey: opts.apiKey,
  });
  const openAiOptions = { model: ai.model, apiKey: ai.apiKey, baseUrl: ai.baseUrl };

  // Configured login credentials: their ids and descriptions (never the
  // values) are passed to the agent during planning by appending a short
  // note to the plan markdown, and the {{credential:<id>.field}} placeholders
  // in the compiled plan are substituted with the real values just before
  // execution. The offline mock agent never receives the values either.
  const credentials = loadedCredentials.credentials;
  const credentialsNote = opts.agent === "openai" ? buildCredentialsNote(credentials) : null;
  if (credentialsNote !== null) {
    console.log(
      `openwebqa: ${credentials.length} login credential(s) configured; passing their ids and descriptions to the agent during planning`,
    );
  }

  // Animated planning feedback (src/agent/feedback.ts): a spinner line on
  // stderr while the AI compiles the DAG (plain lines when stderr is not a
  // TTY or --no-anim is given), plus an inline, in-place line for each
  // exploration command the deep agent runs. The offline mock agent is
  // instant, so it gets none.
  // --no-anim is a commander negation flag: opts.anim defaults to true and
  // becomes false only when the user passes --no-anim. The env override
  // exists for terminals where in-place redraw is unreliable.
  const noAnim = opts.anim === false || process.env.OPENWEBQA_NO_ANIM === "1";
  const anim: boolean | undefined = noAnim ? false : undefined;
  let agent: OpenAiAgent;
  let feedback: PlanningFeedback | null = null;
  if (opts.agent === "mock") {
    agent = createMockAgent();
  } else if (noBlind) {
    feedback = new PlanningFeedback({ label: `compiling plan with ${ai.model}`, animate: anim });
    agent = createDeepAgent({ ...openAiOptions, rootDir: process.cwd(), feedback });
  } else {
    feedback = new PlanningFeedback({ label: `compiling plan with ${ai.model}`, animate: anim });
    agent = createOpenAiAgent(openAiOptions);
  }
  if (noBlind) {
    console.log(
      `openwebqa: exploration enabled (root: ${process.cwd()}, ignore: ${DEFAULT_IGNORE_LIST.join(", ")})`,
    );
  }
  feedback?.start();
  let graph: TestPlanGraph;
  try {
    graph = await agent.run(
      credentialsNote !== null ? markdown + credentialsNote : markdown,
    );
  } catch (err) {
    feedback?.fail();
    throw err;
  }
  feedback?.finish();

  // 3. Validate the graph (includes circular-dependency detection).
  const errors = validateGraph(graph);
  if (errors.length > 0) {
    for (const error of errors) console.error(`openwebqa: ${error}`);
    process.exit(2);
  }

  // 3b. Substitute {{credential:<id>.username|password}} placeholders in the
  //     compiled plan with the configured values (in place). An unresolvable
  //     placeholder is a usage error (exit 2). Runs before --dry-run so a
  //     dry run also validates the references.
  try {
    resolveCredentialPlaceholders(graph, credentials);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`openwebqa: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  // 4. Resolve relative goto URLs: base = --base-url, or 'file://' + the plan
  //    file's directory + '/'. Absolute URLs pass through unchanged.
  const base = opts.baseUrl ?? `file://${path.dirname(path.resolve(planFile))}/`;
  for (const testCase of graph.cases) {
    for (const action of testCase.actions) {
      if (action.type === "goto") {
        action.url = new URL(action.url, base).toString();
      }
    }
  }

  // 5. Print the topological execution levels, one line per level.
  const levels = computeLevels(graph);
  levels.forEach((level, i) => {
    console.log(`Level ${i}: ${level.join(", ")}`);
  });

  // 6. Stop here for --dry-run.
  if (opts.dryRun) {
    process.exit(0);
  }

  // 7. Execute the graph and print the report.
  const report = await runGraph(graph, {
    workers: opts.workers,
    headless: !opts.headful,
    timeoutMs: opts.timeout,
    resultsDir: opts.resultsDir,
  });
  console.log(formatReport(report));
  process.exitCode = exitCodeFor(report);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`openwebqa: ${message}`);
  process.exitCode = 1;
});
