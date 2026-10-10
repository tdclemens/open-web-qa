#!/usr/bin/env node
// OpenWebQA CLI. Three ways to use a plan:
//
//   1. openwebqa <plan.md>            compile with the AI agent, then execute
//   2. openwebqa compile <plan.md>    compile, validate, and save the DAG as a
//                                     JSON plan file (default: <plan>.json in
//                                     the current directory); no execution
//   3. openwebqa run <plan.json>      validate and execute an existing saved
//                                     JSON plan; no AI agent involved
//
// Modes 2 and 3 let you keep a committed plan.json in your project: the file
// is the exact TestPlanGraph shape, so diffs are reviewable and the plan can
// be hand-edited between runs. The root command also accepts a .json file
// directly (same as `run`).
//
// Each mode is a separate commander program (dispatched on the first
// argument) so their option sets do not overlap in parsing.

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
import { parsePlanText, PlanFileError } from "./graph/plan-file";
import { runGraph } from "./executor/runner";
import { exitCodeFor, formatCaseLine, formatSummary } from "./report";
import type { TestPlanGraph } from "./graph/types";

// --- Option groups (shared between the mode programs) ---

/** Planning options: which agent compiles the markdown and how it connects. */
function addAgentOptions(cmd: Command): Command {
  return cmd
    .option("--agent <openai|mock>", "agent that compiles the plan into a DAG", "openai")
    .option("--model <id>", "model id for the OpenAI agent")
    .option(
      "--ai-endpoint <url>",
      "custom OpenAI-compatible base URL for locally running or home-network AI (takes precedence over env OPENAI_BASE_URL)",
    )
    .option("--api-key <key>", "API key for the AI endpoint (env OPENAI_API_KEY fallback)")
    .option(
      "--no-blind",
      "let the OpenAI agent explore the current directory while it compiles the plan: quick " +
        "list_dir/read_file checks plus an explore subagent that does file-heavy digging in its own " +
        "context so the planner's context stays clean; the ignore list keeps hidden files and " +
        "node_modules out of its reach (requires --agent openai)",
    )
    .option(
      "--no-anim",
      "disable the in-place animated planning spinner; print plain status lines instead (also OPENWEBQA_NO_ANIM=1)",
    );
}

/** Execution options: how the validated DAG runs in Playwright. */
function addExecOptions(cmd: Command): Command {
  return cmd
    .option(
      "--workers <n>",
      "max number of test cases running in parallel",
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
      "default per-case timeout in milliseconds",
      (value: string) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n < 0) {
          throw new InvalidArgumentError("must be a non-negative integer");
        }
        return n;
      },
      30000,
    )
    .option(
      "--retries <n>",
      'number of times to retry a test case that fails (default 0; a case can override it with a per-case "retries" in the plan)',
      (value: string) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n < 0) {
          throw new InvalidArgumentError("must be a non-negative integer");
        }
        return n;
      },
      0,
    )
    .option("--headful", "run the browser headful (visible) instead of headless")
    .option(
      "--base-url <url>",
      "base URL for resolving relative goto URLs (default: file:// + the plan file's directory)",
    )
    .option(
      "--results-dir <dir>",
      "directory for failure screenshots",
      "openwebqa-results",
    );
}

const PLANNING_MODES_HELP = `
The three plan modes:

  1. openwebqa <plan.md>            compile the markdown plan with an AI agent, validate the
                                    DAG, and execute it (the classic one-shot flow)
  2. openwebqa compile <plan.md>    compile and validate the plan and save it as a JSON plan
                                    file (default: the plan file's basename with a .json
                                    extension, in the current directory); no execution
  3. openwebqa run <plan.json>      validate and execute an existing saved JSON plan; no AI
                                    planning involved

A saved plan is the exact TestPlanGraph JSON shape (see --help of this program for the
option groups). Keeping the JSON plan committed in your project makes it easy to review
diffs and hand-edit the plan between runs. Passing a .json file to the root command
(like \`openwebqa plan.json\`) is the same as mode 3.`;

// --- Mode programs ---

/** Mode 1 (and the legacy entry point): markdown -> compile -> execute; .json -> execute. */
function buildRootCommand(): Command {
  const cmd = new Command();
  addAgentOptions(addExecOptions(cmd))
    .option("--dry-run", "compile, validate, and print the execution levels, then exit without executing", false)
    .name("openwebqa")
    .description(
      "Compile a markdown QA test plan into a DAG of browser test cases (via an AI agent or " +
        "the offline mock), validate it (including circular-dependency detection), and execute " +
        "it with headless Playwright. A saved .json plan can be executed directly instead. See " +
        "the modes listed at the bottom of this help for compile/run.",
    )
    .argument("<plan-file>", "path to a markdown QA test plan, or a saved .json plan to execute directly")
    .addHelpText("after", PLANNING_MODES_HELP)
    .showHelpAfterError("-h, --help for usage")
    .action(
      guard(async (planFile: string, opts: Record<string, unknown>) => {
        const exec = execOptsOf(opts);
        if (isJsonPlanFile(planFile)) {
          await runSavedPlan(planFile, exec, { dryRun: Boolean(opts.dryRun) });
        } else {
          await compileAndRun(planFile, agentOptsOf(opts), exec, { dryRun: Boolean(opts.dryRun) });
        }
      }),
    );
  return cmd;
}

/** Mode 2: markdown -> compile -> validate -> save JSON (no execution, so no exec options). */
function buildCompileCommand(): Command {
  const cmd = new Command();
  addAgentOptions(cmd)
    .name("openwebqa compile")
    .description("compile a markdown QA plan into a JSON plan file: validate the DAG and save it, without executing")
    .argument("<plan-file>", "path to the markdown QA test plan")
    .option(
      "--out <file>",
      "output JSON plan path (default: the plan file's basename with a .json extension, in the current directory)",
    )
    .addHelpText("after", PLANNING_MODES_HELP)
    .showHelpAfterError("-h, --help for usage")
    .action(
      guard(async (planFile: string, opts: Record<string, unknown>) => {
        if (isJsonPlanFile(planFile)) {
          failUsage(
            `compile expects a markdown plan (got "${planFile}"); use "openwebqa run ${planFile}" to execute a saved plan`,
          );
        }
        await compileAndSave(planFile, agentOptsOf(opts), typeof opts.out === "string" ? opts.out : undefined);
      }),
    );
  return cmd;
}

/** Mode 3: saved JSON -> validate -> execute (no AI planning, so no agent options). */
function buildRunCommand(): Command {
  const cmd = new Command();
  addExecOptions(cmd)
    .option("--dry-run", "validate and print the execution levels, then exit without executing", false)
    .name("openwebqa run")
    .description("validate and execute a saved JSON plan file (no AI planning)")
    .argument("<plan-file>", "path to the saved .json plan file")
    .addHelpText("after", PLANNING_MODES_HELP)
    .showHelpAfterError("-h, --help for usage")
    .action(
      guard(async (planFile: string, opts: Record<string, unknown>) => {
        await runSavedPlan(planFile, execOptsOf(opts), { dryRun: Boolean(opts.dryRun) });
      }),
    );
  return cmd;
}

// --- Helpers ---

/**
 * Wrap an async commander action so an unhandled error prints a clean
 * `openwebqa: <message>` line and exits 1 (runtime error), instead of an
 * unhandled rejection with a stack trace.
 */
function guard<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`openwebqa: ${message}`);
      process.exitCode = 1;
    }
  };
}

interface AgentOpts {
  agent: string;
  model?: string;
  aiEndpoint?: string;
  apiKey?: string;
  /** Commander negation flag: true by default, false only when --no-blind is passed. */
  blind: boolean;
  /** Commander negation flag: true by default, false only when --no-anim is passed. */
  anim: boolean;
}

interface ExecOpts {
  workers: number;
  timeout: number;
  retries: number;
  headful: boolean;
  baseUrl?: string;
  resultsDir: string;
}

function agentOptsOf(opts: Record<string, unknown>): AgentOpts {
  return {
    agent: opts.agent as string,
    model: opts.model as string | undefined,
    aiEndpoint: opts.aiEndpoint as string | undefined,
    apiKey: opts.apiKey as string | undefined,
    blind: opts.blind as boolean,
    anim: opts.anim as boolean,
  };
}

function execOptsOf(opts: Record<string, unknown>): ExecOpts {
  return {
    workers: opts.workers as number,
    timeout: opts.timeout as number,
    retries: opts.retries as number,
    headful: opts.headful as boolean,
    baseUrl: opts.baseUrl as string | undefined,
    resultsDir: opts.resultsDir as string,
  };
}

/** Print `openwebqa: <message>` and exit 2 (bad usage / unreadable plan / validation error). */
function failUsage(message: string): never {
  console.error(`openwebqa: ${message}`);
  process.exit(2);
}

/** True when the given path looks like a saved JSON plan. */
function isJsonPlanFile(file: string): boolean {
  return file.toLowerCase().endsWith(".json");
}

/** Default compile output: the plan file's basename + ".json" in the current directory. */
function defaultOutForPlan(planFile: string): string {
  return path.join(process.cwd(), path.basename(planFile, path.extname(planFile)) + ".json");
}

/** Load .openwebqa config + credentials; a malformed file is a usage error (exit 2). */
function loadShared(): { loaded: LoadedConfig; credentials: LoadedCredentials } {
  let loaded: LoadedConfig;
  let credentials: LoadedCredentials;
  try {
    loaded = loadConfig();
    credentials = loadCredentials();
  } catch (err) {
    if (err instanceof ConfigError) failUsage(err.message);
    throw err;
  }
  return { loaded, credentials };
}

/** Read a text file; missing/unreadable is a usage error (exit 2). */
function readPlanText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failUsage(`cannot read plan file "${file}": ${message}`);
  }
}

/**
 * Compile a markdown plan with the chosen agent (mock / OpenAI / deep).
 * Prints the credentials note and exploration banner, and manages the
 * animated planning feedback. Returns the raw (unvalidated) graph.
 */
async function compilePlan(
  markdown: string,
  agentOpts: AgentOpts,
  loaded: LoadedConfig,
  credentials: LoadedCredentials,
): Promise<TestPlanGraph> {
  if (agentOpts.agent !== "openai" && agentOpts.agent !== "mock") {
    failUsage(`invalid --agent "${agentOpts.agent}" (expected "openai" or "mock")`);
  }

  // --no-blind is a commander negation flag: opts.blind defaults to true and
  // becomes false only when the user passes --no-blind.
  const noBlind = agentOpts.blind === false;
  if (noBlind && agentOpts.agent !== "openai") {
    failUsage("--no-blind requires --agent openai (the mock agent is offline and cannot explore)");
  }

  // Effective AI options: CLI flag > env (OPENAI_BASE_URL / OPENAI_API_KEY)
  // > ./.openwebqa/config.json > ~/.openwebqa/config.json (see src/config.ts);
  // the env fallbacks and the "not-needed" default are handled by the agent.
  const ai = resolveAiOptions(loaded.config, process.env, {
    model: agentOpts.model,
    aiEndpoint: agentOpts.aiEndpoint,
    apiKey: agentOpts.apiKey,
  });
  const openAiOptions = { model: ai.model, apiKey: ai.apiKey, baseUrl: ai.baseUrl };

  // Configured login credentials: their ids and descriptions (never the
  // values) are passed to the agent during planning by appending a short
  // note to the plan markdown, and the {{credential:<id>.field}} placeholders
  // in the compiled plan are substituted with the real values just before
  // execution (see prepareGraphForRun). The offline mock agent never
  // receives the values either.
  const credentialsNote = agentOpts.agent === "openai" ? buildCredentialsNote(credentials.credentials) : null;
  if (credentialsNote !== null) {
    console.log(
      `openwebqa: ${credentials.credentials.length} login credential(s) configured; passing their ids and descriptions to the agent during planning`,
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
  const noAnim = agentOpts.anim === false || process.env.OPENWEBQA_NO_ANIM === "1";
  const anim: boolean | undefined = noAnim ? false : undefined;

  // --no-blind upgrades the OpenAI agent to the "deep" agent, which may
  // explore the current directory while it is coming up with the DAG plan:
  // direct list_dir/read_file (sandboxed by the ignore list) plus an explore
  // subagent that does file-heavy digging in its own context and returns
  // only a short findings report, keeping the planner's context clean.
  let agent: OpenAiAgent;
  let feedback: PlanningFeedback | null = null;
  if (agentOpts.agent === "mock") {
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
      `openwebqa: exploration enabled (root: ${process.cwd()}, ignore: ${DEFAULT_IGNORE_LIST.join(", ")}; ` +
        `file-heavy questions are delegated to explore subagents)`,
    );
  }

  feedback?.start();
  let graph: TestPlanGraph;
  try {
    graph = await agent.run(credentialsNote !== null ? markdown + credentialsNote : markdown);
  } catch (err) {
    feedback?.fail();
    throw err;
  }
  feedback?.finish();
  return graph;
}

/** Validate the graph (includes circular-dependency detection); exit 2 on errors. */
function validateOrExit(graph: TestPlanGraph): void {
  const errors = validateGraph(graph);
  if (errors.length > 0) {
    for (const error of errors) console.error(`openwebqa: ${error}`);
    process.exit(2);
  }
}

/**
 * Make a validated graph ready to execute: substitute
 * {{credential:<id>.username|password}} placeholders with the configured
 * values (unresolvable -> usage error, exit 2), then resolve relative goto
 * URLs against `base` (absolute URLs pass through unchanged).
 */
function prepareGraphForRun(graph: TestPlanGraph, credentials: LoadedCredentials, base: string): void {
  try {
    resolveCredentialPlaceholders(graph, credentials.credentials);
  } catch (err) {
    if (err instanceof ConfigError) failUsage(err.message);
    throw err;
  }
  for (const testCase of graph.cases) {
    for (const action of testCase.actions) {
      if (action.type === "goto") {
        action.url = new URL(action.url, base).toString();
      }
    }
  }
}

/** Print the topological execution levels, one line per level. */
function printLevels(graph: TestPlanGraph): void {
  computeLevels(graph).forEach((level, i) => {
    console.log(`Level ${i}: ${level.join(", ")}`);
  });
}

/**
 * Execute the graph, streaming one line per case as each case settles
 * (completion order — lines interleave in parallel runs), then print the
 * final summary line. Sets the process exit code.
 */
async function executeGraph(graph: TestPlanGraph, exec: ExecOpts): Promise<void> {
  const report = await runGraph(graph, {
    workers: exec.workers,
    headless: !exec.headful,
    timeoutMs: exec.timeout,
    retries: exec.retries,
    resultsDir: exec.resultsDir,
    onCaseSettled: (result) => console.log(formatCaseLine(result)),
  });
  console.log(formatSummary(report));
  process.exitCode = exitCodeFor(report);
}

// --- Mode flows ---

/** Mode 1: read the markdown, compile with the agent, validate, and execute. */
async function compileAndRun(
  planFile: string,
  agentOpts: AgentOpts,
  exec: ExecOpts,
  flags: { dryRun: boolean },
): Promise<void> {
  const { loaded, credentials } = loadShared();
  const markdown = readPlanText(planFile);
  const graph = await compilePlan(markdown, agentOpts, loaded, credentials);
  validateOrExit(graph);
  prepareGraphForRun(
    graph,
    credentials,
    exec.baseUrl ?? `file://${path.dirname(path.resolve(planFile))}/`,
  );
  printLevels(graph);
  if (flags.dryRun) process.exit(0);
  await executeGraph(graph, exec);
}

/** Mode 2: read the markdown, compile with the agent, validate, save JSON. No execution. */
async function compileAndSave(
  planFile: string,
  agentOpts: AgentOpts,
  out: string | undefined,
): Promise<void> {
  const { loaded, credentials } = loadShared();
  const markdown = readPlanText(planFile);
  const graph = await compilePlan(markdown, agentOpts, loaded, credentials);
  validateOrExit(graph);

  const outFile = out ?? defaultOutForPlan(planFile);
  try {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(graph, null, 2) + "\n", "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failUsage(`cannot write plan file "${outFile}": ${message}`);
  }

  printLevels(graph);
  console.log(`openwebqa: saved ${graph.cases.length} test case(s) to ${path.resolve(outFile)}`);
}

/** Mode 3: read a saved JSON plan, shape-check, validate, and execute (no AI). */
async function runSavedPlan(
  planFile: string,
  exec: ExecOpts,
  flags: { dryRun?: boolean } = {},
): Promise<void> {
  if (!isJsonPlanFile(planFile)) {
    failUsage(
      `run expects a saved JSON plan file (got "${planFile}"); ` +
        `compile one with: openwebqa compile ${planFile} (or run the markdown directly: openwebqa ${planFile})`,
    );
  }

  const { credentials } = loadShared();
  const raw = readPlanText(planFile);
  let graph: TestPlanGraph;
  try {
    graph = parsePlanText(raw, planFile);
  } catch (err) {
    if (err instanceof PlanFileError) failUsage(err.message);
    throw err;
  }
  validateOrExit(graph);
  prepareGraphForRun(
    graph,
    credentials,
    exec.baseUrl ?? `file://${path.dirname(path.resolve(planFile))}/`,
  );
  printLevels(graph);
  if (flags.dryRun) process.exit(0);
  await executeGraph(graph, exec);
}

// --- Dispatch ---

// The first argument selects the mode program. Each mode is its own commander
// program so its option set is parsed in isolation (options shared between
// modes, like --agent on the root and on `compile`, would otherwise collide
// when a single root command parsed the whole argv).
if (process.argv.length < 3) {
  console.error("openwebqa: missing required argument <plan-file>");
  process.exit(2);
}
const firstArg = process.argv[2];
if (firstArg === "compile" && process.argv.length < 4) {
  console.error('openwebqa: missing required argument <plan-file> for "openwebqa compile"');
  process.exit(2);
}
if (firstArg === "run" && process.argv.length < 4) {
  console.error('openwebqa: missing required argument <plan-file> for "openwebqa run"');
  process.exit(2);
}
// Subcommand programs parse the argv with the mode word removed, so it is
// not mistaken for the <plan-file> argument.
const subArgv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
if (firstArg === "compile") {
  buildCompileCommand().parse(subArgv);
} else if (firstArg === "run") {
  buildRunCommand().parse(subArgv);
} else {
  buildRootCommand().parse(process.argv);
}
