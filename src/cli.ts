#!/usr/bin/env node
// OpenWebQA CLI: submits a markdown QA test plan to an AI agent, validates
// the resulting test-case DAG (including circular-dependency detection), and
// executes it with headless Playwright.

import fs from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { createMockAgent } from "./agent/mock";
import { createOpenAiAgent } from "./agent/openai";
import { createDeepAgent, DEFAULT_IGNORE_LIST } from "./agent/deep";
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
  //    --ai-endpoint is passed as baseUrl (precedence over env OPENAI_BASE_URL);
  //    --api-key is passed as apiKey (env OPENAI_API_KEY fallback handled by the agent).
  //    --no-blind upgrades the OpenAI agent to the "deep" agent, which may
  //    explore the current directory (list_dir/read_file, sandboxed by the
  //    ignore list) while it is coming up with the DAG plan.
  const openAiOptions = { model: opts.model, apiKey: opts.apiKey, baseUrl: opts.aiEndpoint };
  const agent =
    opts.agent === "mock"
      ? createMockAgent()
      : noBlind
        ? createDeepAgent({ ...openAiOptions, rootDir: process.cwd() })
        : createOpenAiAgent(openAiOptions);
  if (noBlind) {
    console.log(
      `openwebqa: exploration enabled (root: ${process.cwd()}, ignore: ${DEFAULT_IGNORE_LIST.join(", ")})`,
    );
  }
  const graph: TestPlanGraph = await agent.run(markdown);

  // 3. Validate the graph (includes circular-dependency detection).
  const errors = validateGraph(graph);
  if (errors.length > 0) {
    for (const error of errors) console.error(`openwebqa: ${error}`);
    process.exit(2);
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
