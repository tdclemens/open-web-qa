import fs from "node:fs";
import path from "node:path";
import { Agent, ToolGuardrailFunctionOutputFactory, defineToolOutputGuardrail, tool } from "@openai/agents";
import type { OpenAIChatCompletionsModel } from "@openai/agents";
import type { TestPlanGraph } from "../graph/types";
import {
  buildSystemPrompt,
  createChatModel,
  extractJson,
  runAgentRequest,
  sharedRunner,
} from "./openai";
import type { OpenAiAgent, OpenAiAgentOptions } from "./openai";
import type { PlanningFeedback } from "./feedback";

/**
 * "Deep" AI agent for OpenWebQA (plan-time directory exploration).
 *
 * Wraps the OpenAI-compatible chat endpoint used by ./openai.ts in a
 * tool-calling loop: while compiling the markdown QA plan into a
 * TestPlanGraph, the model may inspect the local project directory with
 * three tools so it can verify page URLs, CSS selectors, and expected text
 * against the actual application source:
 *
 *   - `list_dir` / `read_file`: direct, sandboxed reads. Cheap for a quick
 *     orientation listing, but every byte read this way stays in the
 *     planner's context for the rest of the run.
 *   - `explore`: delegates a focused question to an exploration subagent —
 *     a fresh agent with the SAME sandboxed list_dir/read_file tools but its
 *     OWN conversation context. The subagent runs its own tool loop and only
 *     its short findings report is returned to the planner, so file reads
 *     done by the subagent never enter the planner's context. This keeps the
 *     planner's context small on large projects. Two caps keep the pattern
 *     safe in both directions: the subagent's run is turn-limited
 *     ({@link MAX_EXPLORE_TURNS}) and its report is truncated to
 *     {@link MAX_EXPLORE_REPORT_BYTES} before it reaches the planner.
 *
 * Exploration is sandboxed:
 *   - Every tool path is resolved against `rootDir` and must stay inside it
 *     (no absolute-path or `..` escapes; symlinks are re-checked after
 *     realpath, so a link pointing outside the root is rejected).
 *   - An ignore list of name globs (default: `.*` for hidden files/dirs and
 *     `node_modules`) is enforced on both listings and reads, so files that
 *     should not be exposed (`.env`, `.git`, ...) are never shown to the
 *     model.
 *
 * The tool loop is driven by the Agents SDK runner: the model is offered the
 * three tools, tool argument errors (including invalid JSON arguments) are
 * returned to the model as `role: "tool"` messages so it can self-correct,
 * and the loop runs with no turn cap: the agent keeps exploring until it
 * decides it has enough information, stops calling tools, and emits the plan
 * JSON. Because an uncapped loop is only as safe as the model's willingness
 * to converge, a per-run loop breaker ({@link PlannerLoopBreaker}) watches
 * the planner's tool calls: the same tool called with the same arguments
 * {@link LOOP_BREAKER_NUDGE_AFTER} times in a row gets a "stop repeating"
 * note appended to its result, and a streak of
 * {@link LOOP_BREAKER_ABORT_AFTER} aborts the run with an error instead of
 * letting a stuck model spin forever.
 * The endpoint must support OpenAI-style function calling (OpenAI, Ollama,
 * LM Studio, ...). The final message is parsed with the same `extractJson`
 * used by the plain OpenAI agent, so the returned TestPlanGraph shape is
 * identical.
 */

/** Default ignore list: any hidden file/directory (name starting with ".") plus node_modules. */
export const DEFAULT_IGNORE_LIST = [".*", "node_modules"];

/** Maximum number of bytes `read_file` shows per call (64 KiB). */
export const MAX_READ_BYTES = 64 * 1024;

/** Maximum number of entries `list_dir` reports per call. */
export const MAX_LIST_ENTRIES = 200;

/**
 * Turn cap for one exploration subagent run. The SDK throws
 * MaxTurnsExceededError once the subagent burns this many turns without
 * stopping to write its report, which is turned into an error tool result
 * the planner can react to (ask a narrower question, or read directly).
 */
export const MAX_EXPLORE_TURNS = 25;

/**
 * Maximum UTF-8 bytes of an exploration subagent report that are returned to
 * the planner. Longer reports are truncated (with a note), so a chatty
 * subagent cannot bloat the planner's context.
 */
export const MAX_EXPLORE_REPORT_BYTES = 16 * 1024;

/**
 * Consecutive identical planner tool calls (same tool, same normalized
 * arguments) from which the loop breaker appends a "stop repeating" note to
 * the tool result. Small local models can get stuck re-issuing the same
 * call — most often `list_dir` of the root — where every result is identical
 * and nothing in the conversation changes to steer them on.
 */
export const LOOP_BREAKER_NUDGE_AFTER = 2;

/**
 * Consecutive identical planner tool calls after which the planning run is
 * aborted with an error: the model has ignored the nudge notes, the loop is
 * not converging, and — with no turn cap on the planner loop — the only
 * safe exit is a clean failure. The abort is enforced by the tools' output
 * guardrail ({@link createPlannerLoopBreakerGuardrail}), which throws when
 * the streak reaches this threshold; the SDK propagates guardrail errors,
 * failing the run. (Throwing from a tool's execute would NOT abort: for
 * tools without an outputSchema the SDK converts such errors into a generic
 * error result and feeds it back into the stuck model.)
 */
export const LOOP_BREAKER_ABORT_AFTER = 5;

/** Options for {@link createDeepAgent}. */
export interface DeepAgentOptions extends OpenAiAgentOptions {
  /** Directory the agent may explore (resolved against the process cwd). */
  rootDir: string;
  /**
   * Name globs (`*` and `?` supported) matched against each path segment
   * relative to the root; matching paths can neither be listed nor read.
   * Defaults to {@link DEFAULT_IGNORE_LIST}.
   */
  ignore?: string[];
  /**
   * Optional live feedback for the planning phase (see ./feedback.ts). When
   * set, each list_dir/read_file call is printed inline as it runs and its
   * line is finalized in place with a one-line summary of the result.
   */
  feedback?: PlanningFeedback;
}

// --- Ignore-list matching --------------------------------------------------

/** Compile a name glob ("*", "?") into an anchored RegExp. */
function compileNamePattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function isIgnoredName(name: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(name));
}

/**
 * Return the first path segment of `rel` (relative to the root) that matches
 * the ignore patterns, or null. `rel === ""` (the root itself) is never
 * ignored — the root is what the operator explicitly pointed the agent at.
 */
function ignoredSegment(rel: string, patterns: RegExp[]): string | null {
  if (rel === "" || rel === ".") return null;
  for (const segment of rel.split(path.sep)) {
    if (isIgnoredName(segment, patterns)) return segment;
  }
  return null;
}

// --- Path sandboxing --------------------------------------------------------

/** True when `candidate` is `rootDir` itself or a path strictly inside it. */
function isPathInsideRoot(rootDir: string, candidate: string): boolean {
  if (candidate === rootDir) return true;
  const rel = path.relative(rootDir, candidate);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).includes("..");
}

/**
 * Resolve `requested` (relative to `rootDir`, "." allowed) and throw an
 * Error when it escapes the root. Returns the resolved path plus its
 * root-relative form ("" for the root itself).
 */
function resolveWithinRoot(rootDir: string, requested: string): { resolved: string; rel: string } {
  const resolved = path.resolve(rootDir, requested);
  if (!isPathInsideRoot(rootDir, resolved)) {
    throw new Error("path escapes the project root");
  }
  const rel = path.relative(rootDir, resolved);
  return { resolved, rel };
}

/**
 * Re-check containment after resolving symlinks. When `resolved` does not
 * (yet) exist, realpath fails and the logical path is returned unchanged so
 * the caller can produce a clean "no such file" error.
 */
async function realInsideRoot(
  realRoot: string,
  rootDir: string,
  resolved: string,
): Promise<string> {
  let real: string;
  try {
    real = await fs.promises.realpath(resolved);
  } catch {
    return resolved; // does not exist; caller will report the ENOENT itself
  }
  if (!isPathInsideRoot(realRoot, real)) {
    throw new Error("path escapes the project root via a symlink");
  }
  return real;
}

/** Format an fs error as a short tool-result error string. */
function fsErrorMessage(err: unknown, rel: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const what = rel || ".";
  if (code === "ENOENT" || code === "ENOTDIR") return `error: no such file or directory: ${what}`;
  if (code === "EACCES" || code === "EPERM") return `error: permission denied: ${what}`;
  const message = err instanceof Error ? err.message : String(err);
  return `error: ${message}`;
}

// --- Tools -------------------------------------------------------------------

/** List a directory inside the root, hiding ignored entries. */
async function listDir(
  realRoot: string,
  rootDir: string,
  requested: string,
  patterns: RegExp[],
): Promise<string> {
  const { resolved, rel } = resolveWithinRoot(rootDir, requested);
  const ignored = ignoredSegment(rel, patterns);
  if (ignored !== null) {
    return `error: ${rel || "."} is on the ignore list (segment "${ignored}") and cannot be explored`;
  }
  const real = await realInsideRoot(realRoot, rootDir, resolved);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(real);
  } catch (err) {
    return fsErrorMessage(err, rel || ".");
  }
  if (!stat.isDirectory()) return `error: not a directory: ${rel || "."}`;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(real, { withFileTypes: true });
  } catch (err) {
    return fsErrorMessage(err, rel || ".");
  }
  const visible = entries.filter((e) => !isIgnoredName(e.name, patterns));
  visible.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });
  const shown = visible.slice(0, MAX_LIST_ENTRIES);

  const lines: string[] = [`Directory: ${rel || "."}`];
  for (const entry of shown) {
    const kind = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
    let sizeNote = "";
    if (!entry.isDirectory()) {
      try {
        const entryStat = await fs.promises.stat(path.join(real, entry.name));
        sizeNote = ` (${entryStat.size} bytes)`;
      } catch {
        sizeNote = " (unstatable)"; // e.g. broken symlink
      }
    }
    lines.push(`  [${kind}] ${entry.name}${sizeNote}`);
  }
  if (shown.length === 0) lines.push("  (empty)");
  if (visible.length > shown.length) {
    lines.push(`  ... (truncated: showing ${shown.length} of ${visible.length} entries)`);
  }
  return lines.join("\n");
}

/** Read a text file inside the root (first MAX_READ_BYTES bytes). */
async function readLimited(
  real: string,
  size: number,
): Promise<{ text: string; truncated: boolean; binary: boolean }> {
  const limit = Math.min(size, MAX_READ_BYTES);
  const handle = await fs.promises.open(real, "r");
  try {
    const buf = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buf, 0, limit, 0);
    const chunk = buf.subarray(0, bytesRead);
    if (chunk.includes(0)) return { text: "", truncated: size > MAX_READ_BYTES, binary: true };
    return { text: chunk.toString("utf8"), truncated: size > MAX_READ_BYTES, binary: false };
  } finally {
    await handle.close();
  }
}

/** Read a file inside the root, hiding ignored paths. */
async function readFile(
  realRoot: string,
  rootDir: string,
  requested: string,
  patterns: RegExp[],
): Promise<string> {
  const { resolved, rel } = resolveWithinRoot(rootDir, requested);
  const ignored = ignoredSegment(rel, patterns);
  if (ignored !== null) {
    return `error: ${rel} is on the ignore list (segment "${ignored}") and cannot be explored`;
  }
  const real = await realInsideRoot(realRoot, rootDir, resolved);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(real);
  } catch (err) {
    return fsErrorMessage(err, rel || ".");
  }
  if (stat.isDirectory()) return `error: is a directory (use list_dir): ${rel || "."}`;
  if (stat.size === 0) return `File: ${rel || "."} (0 bytes)\n(empty file)`;

  const { text, truncated, binary } = await readLimited(real, stat.size);
  const header =
    `File: ${rel || "."} (${stat.size} bytes)` +
    (truncated ? ` [showing first ${MAX_READ_BYTES} of ${stat.size} bytes]` : "");
  if (binary) return `${header}\n[binary file; content not shown]`;
  return `${header}\n${text}`;
}

/**
 * The two sandboxed exploration tools, bound to this run's resolved root.
 * The SDK parses the model's tool arguments and serializes the returned
 * string back as a `role: "tool"` message.
 *
 * When `feedback` is set, each execution is reported to it: the command is
 * shown inline when it starts and its line is finalized in place with a
 * summary of the result (see ./feedback.ts).
 */
function createExplorationTools(
  realRoot: string,
  rootDir: string,
  patterns: RegExp[],
  feedback?: PlanningFeedback,
  loopBreaker?: PlannerLoopBreaker,
) {
  const execute = (name: "list_dir" | "read_file") => (input: unknown) => {
    const handle = feedback?.toolStart(name, toolPathArg(input));
    const streak = loopBreaker ? loopBreaker.beginCall(name, input) : 0;
    return runExplorationTool(name, input, realRoot, rootDir, patterns).then(
      (result) => {
        handle?.end(result);
        return loopBreaker && streak > 0 ? loopBreaker.annotate(name, streak, result) : result;
      },
      (err: unknown) => {
        handle?.end(`error: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      },
    );
  };
  return [
    tool({
      name: "list_dir",
      description:
        "List the entries of a directory inside the project. Hidden files and other " +
        "ignored entries are never shown. Omit 'path' to list the project root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to the project root (default: \".\")",
          },
        },
        required: [],
        additionalProperties: false,
      },
      execute: execute("list_dir"),
      // The breaker's output guardrail aborts the whole planning run when
      // this tool's call streak is stuck (see createPlannerLoopBreakerGuardrail).
      outputGuardrails: loopBreaker ? [createPlannerLoopBreakerGuardrail(loopBreaker)] : undefined,
    }),
    tool({
      name: "read_file",
      description:
        "Read a text file inside the project (only the first 64 KB are shown; binary " +
        "files are not shown).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: execute("read_file"),
      outputGuardrails: loopBreaker ? [createPlannerLoopBreakerGuardrail(loopBreaker)] : undefined,
    }),
  ];
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * multibyte character. Returns the (possibly unchanged) text and whether a
 * truncation happened.
 */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let cut = text.slice(0, maxBytes);
  while (Buffer.byteLength(cut, "utf8") > maxBytes) {
    cut = cut.slice(0, -1);
  }
  return { text: cut, truncated: true };
}

/**
 * System prompt for an exploration subagent: a focused inspector with the
 * sandboxed tools, asked to reply with a short, fact-dense findings report
 * instead of raw file dumps. The report is the ONLY thing the planner ever
 * sees of the subagent's work, so it must carry the verified values.
 */
export function buildExploreSubagentPrompt(): string {
  return [
    "You are an exploration subagent for OpenWebQA plan compilation.",
    "You receive one focused question or task about a web application whose",
    "source is in the current project directory. Inspect the application with",
    "the two tools available to you:",
    '- list_dir: list a directory relative to the project root (omit "path" to',
    "  list the root). Hidden files and other ignored entries are never listed.",
    '- read_file: read a text file relative to the project root (first 64 KB).',
    "",
    "Keep every path inside the project root, and never request ignored paths",
    '(hidden files, node_modules, or anything else refused with an "error:"',
    "result).",
    "",
    "When you have enough information, stop calling tools and reply with a",
    "concise plain-text findings report (no markdown, no code fences):",
    "- the direct answer to the task,",
    "- each exact page URL, element id, CSS selector, or expected text you",
    "  verified, with the file (and line, when practical) where you found it,",
    "- brief notes on related facts the planner should know.",
    "Quote only the few lines you need - do not paste whole file contents. Keep",
    "the report short (about 40 lines or fewer).",
  ].join("\n");
}

/**
 * The `explore` tool: delegate one focused question to an exploration
 * subagent. The subagent is a fresh agent with its own conversation context
 * and the same sandboxed list_dir/read_file tools (built WITHOUT feedback,
 * so its internal reads do not clutter the console); it runs its own tool
 * loop until it stops calling tools, and only its final report — turn-capped
 * and byte-capped — is returned to the planner as the tool result.
 *
 * Never throws for expected failures: the subagent's errors come back as
 * "error: ..." strings so the planner can adjust and keep going.
 */
function createExploreTool(
  realRoot: string,
  rootDir: string,
  patterns: RegExp[],
  chatModel: OpenAIChatCompletionsModel,
  feedback?: PlanningFeedback,
  loopBreaker?: PlannerLoopBreaker,
) {
  return tool({
    name: "explore",
    description:
      "Delegate a focused question about the application to an exploration " +
      "subagent. Pass ONE specific question or task (for example: \"what CSS " +
      "selector does the sign-in form use for the email field, and what text " +
      "appears after a failed submit?\"). The subagent has the same sandboxed " +
      "list_dir/read_file tools in its OWN context: everything it reads stays " +
      "out of your context and only its short findings report is returned. " +
      "Prefer this over reading many files yourself; batch related questions " +
      "about the same area into a single task.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The focused exploration question or task for the subagent",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      const obj =
        input !== null && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      // Loop breaker (planner level), recorded before anything else so even a
      // repeated empty-task error cannot spin the uncapped planner forever.
      const streak = loopBreaker ? loopBreaker.beginCall("explore", input) : 0;
      const finish = (out: string): string =>
        loopBreaker && streak > 0 ? loopBreaker.annotate("explore", streak, out) : out;
      const task = typeof obj.task === "string" ? obj.task.trim() : "";
      if (task === "") {
        return finish('error: explore requires a non-empty "task" string');
      }
      const handle = feedback?.toolStart("explore", task);
      try {
        const subAgent = new Agent({
          name: "openwebqa-explore-subagent",
          instructions: buildExploreSubagentPrompt(),
          model: chatModel,
          tools: createExplorationTools(realRoot, rootDir, patterns),
        });
        const result = await sharedRunner.run(subAgent, task, {
          // The subagent must converge on a report: unlike the planner loop
          // (uncapped), a subagent that never stops is a failure, not depth.
          maxTurns: MAX_EXPLORE_TURNS,
          toolNotFoundBehavior: "return_error_to_model",
        });
        const report = typeof result.finalOutput === "string" ? result.finalOutput : "";
        if (report === "") {
          throw new Error("the subagent returned an empty report");
        }
        const { text: body, truncated } = truncateUtf8(report, MAX_EXPLORE_REPORT_BYTES);
        const note = truncated
          ? `\n[report truncated: showing first ${MAX_EXPLORE_REPORT_BYTES} of ${Buffer.byteLength(report, "utf8")} bytes]`
          : "";
        const out = `explore subagent report:\n${body}${note}`;
        handle?.end(out);
        return finish(out);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const out = message.startsWith("Max turns")
          ? `error: explore subagent hit its ${MAX_EXPLORE_TURNS}-turn limit before producing a report; ask a narrower question or read the relevant file directly`
          : `error: explore subagent failed: ${message}`;
        handle?.end(out);
        return finish(out);
      }
    },
    // The breaker's output guardrail aborts the whole planning run when
    // this tool's call streak is stuck (see createPlannerLoopBreakerGuardrail).
    outputGuardrails: loopBreaker ? [createPlannerLoopBreakerGuardrail(loopBreaker)] : undefined,
  });
}

/** The path a tool call requests ("." when absent), for display and dispatch. */
function toolPathArg(args: unknown): string {
  const obj =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  return typeof obj.path === "string" && obj.path.length > 0 ? obj.path : ".";
}

/**
 * Normalize a planner tool call's arguments to a plain object. The execute
 * closures receive parsed objects, while the loop breaker's output guardrail
 * receives the raw protocol item whose `arguments` is still a JSON string —
 * both must normalize identically.
 */
function parseToolCallArgs(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON never reaches execute (the SDK feeds it back to the
      // model before invocation), so there is no signature to compute.
    }
  }
  return {};
}

/**
 * Canonical identity of one planner tool call, used by the loop breaker to
 * detect repetitions. `list_dir` with a missing, empty, `"."`, or `"/"` path
 * all mean "list the project root" and collapse to one signature; `read_file`
 * paths and `explore` tasks compare as trimmed strings.
 */
function toolCallSignature(name: string, input: unknown): string {
  const obj = parseToolCallArgs(input);
  const raw =
    name === "explore"
      ? typeof obj.task === "string"
        ? obj.task.trim()
        : ""
      : typeof obj.path === "string"
        ? obj.path.trim()
        : name === "list_dir"
          ? "."
          : "";
  return `${name} ${raw === "/" ? "." : raw}`;
}

/**
 * Per-run loop breaker for the PLANNER's tool loop (the explore subagent's
 * own tools are not watched: that run is already turn-capped).
 *
 * {@link PlannerLoopBreaker.beginCall} records each planner tool call as it
 * starts executing and returns the streak of consecutive identical calls
 * (same tool, same normalized arguments — see {@link toolCallSignature});
 * any different call resets it. {@link PlannerLoopBreaker.annotate} passes
 * the tool result through (streak below the nudge threshold) or appends a
 * "stop repeating" steering note (streak ≥ {@link LOOP_BREAKER_NUDGE_AFTER}).
 * {@link PlannerLoopBreaker.abortIfStuck} — invoked from the tools' output
 * guardrail after each call executes — throws when the streak reached
 * {@link LOOP_BREAKER_ABORT_AFTER}, and the SDK propagates the guardrail
 * error, aborting the whole planning run instead of letting a stuck model
 * spin in the uncapped loop forever.
 *
 * Streaks are tracked per signature (not just for the last call) so the
 * guardrail can look up the streak of the call it is checking even when the
 * SDK executes several tool calls from one model turn concurrently.
 */
export class PlannerLoopBreaker {
  private lastSignature = "";
  private streaks = new Map<string, number>();

  /** Record one planner tool call starting execution; returns its streak. */
  beginCall(name: string, input: unknown): number {
    const signature = toolCallSignature(name, input);
    const streak =
      signature === this.lastSignature ? (this.streaks.get(signature) ?? 0) + 1 : 1;
    if (signature !== this.lastSignature) {
      this.streaks.clear();
    }
    this.lastSignature = signature;
    this.streaks.set(signature, streak);
    return streak;
  }

  /** The current consecutive-identical streak for this call's signature. */
  streakFor(name: string, input: unknown): number {
    return this.streaks.get(toolCallSignature(name, input)) ?? 0;
  }

  /**
   * Guardrail-side check: throw when the streak of this call's signature
   * reached the abort threshold, aborting the run (see the class docs for
   * why the abort lives in a guardrail rather than in the tool's execute).
   */
  abortIfStuck(name: string, input: unknown): void {
    const streak = this.streakFor(name, input);
    if (streak >= LOOP_BREAKER_ABORT_AFTER) {
      throw new Error(
        `loop breaker: the model called ${name} with the same arguments ${streak} times in a row; ` +
          `the planning tool loop is stuck repeating itself, so the run was aborted`,
      );
    }
  }

  /** Append the "stop repeating" steering note to a repeated call's result. */
  annotate(name: string, streak: number, result: string): string {
    if (streak >= LOOP_BREAKER_NUDGE_AFTER) {
      return `${result}\n${loopBreakerNote(name, streak)}`;
    }
    return result;
  }
}

/**
 * The output guardrail enforcing the abort threshold: it runs after each
 * planner tool call has executed and throws (aborting the whole planning
 * run) when that call's streak of consecutive identical calls reached
 * {@link LOOP_BREAKER_ABORT_AFTER}.
 */
function createPlannerLoopBreakerGuardrail(breaker: PlannerLoopBreaker) {
  return defineToolOutputGuardrail({
    name: "openwebqa-planner-loop-breaker",
    run: async ({ toolCall }) => {
      breaker.abortIfStuck(toolCall.name, toolCall.arguments);
      return ToolGuardrailFunctionOutputFactory.allow();
    },
  });
}

/** The steering note appended to a repeated tool result. */
function loopBreakerNote(name: string, streak: number): string {
  return (
    `[openwebqa loop breaker: you have now called ${name} with the same arguments ` +
    `${streak} times in a row; repeating it will not change the result. Stop repeating ` +
    `this call — inspect a different path, delegate to explore, or stop calling tools ` +
    `and reply with the plan JSON now.]`
  );
}

/**
 * Dispatch one model tool call to a sandboxed exploration tool. Never throws
 * for expected failures — returns an "error: ..." string so the model can
 * adjust and keep going.
 */
async function runExplorationTool(
  name: string,
  args: unknown,
  realRoot: string,
  rootDir: string,
  patterns: RegExp[],
): Promise<string> {
  const rawPath = toolPathArg(args);
  try {
    if (name === "list_dir") {
      return await listDir(realRoot, rootDir, rawPath, patterns);
    }
    if (name === "read_file") {
      if (rawPath === ".") {
        return 'error: read_file requires a file "path" (the project root is a directory; use list_dir)';
      }
      return await readFile(realRoot, rootDir, rawPath, patterns);
    }
    return `error: unknown tool "${name}"`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `error: ${message}`;
  }
}

/**
 * System prompt for deep mode: the standard "reply with ONLY the JSON
 * TestPlanGraph" instructions plus the exploration-mode rules, including the
 * context-discipline guidance that steers file-heavy questions to the
 * explore subagent instead of direct reads.
 */
export function buildDeepSystemPrompt(): string {
  return [
    buildSystemPrompt(),
    "",
    "Exploration mode is enabled: the pages under test come from a web application",
    "whose source is in the current project directory. Before writing the plan you",
    "MAY inspect that application with three tools:",
    '- list_dir: list a directory relative to the project root (omit "path" to list',
    "  the root). Hidden files and other ignored entries are never listed.",
    '- read_file: read a text file relative to the project root (first 64 KB).',
    "- explore: hand ONE focused question about the application to an exploration",
    "  subagent. It has the same sandboxed list_dir/read_file tools in its OWN",
    "  context: everything it reads stays OUT of your context, and only its short",
    "  findings report is returned to you.",
    "",
    "Context discipline:",
    "- Every tool result you receive stays in your context for the whole run, so",
    "  files you read_file yourself are a permanent cost. Keep your own reads to a",
    "  few quick checks (e.g. a list_dir of the root for orientation).",
    "- Use explore for anything that requires opening files - especially when the",
    "  answer spans several files - and batch related questions about the same",
    "  area into a single explore task.",
    "",
    "Use the tools to verify page URLs, element ids/CSS selectors, and expected text",
    "so the generated test cases match the real application. Keep every path inside",
    "the project root, and never request ignored paths (hidden files, node_modules,",
    "or anything else the server refuses with an \"error:\" result).",
    "When you have enough information, stop calling tools and reply with ONLY the",
    "JSON object described above.",
  ].join("\n");
}

/**
 * Create a "deep" agent that may explore `options.rootDir` with
 * list_dir/read_file (sandboxed by the ignore list) while it compiles the
 * markdown plan into a TestPlanGraph.
 *
 * Key/base-URL precedence is the same as {@link createOpenAiAgent}.
 */
export function createDeepAgent(options: DeepAgentOptions): OpenAiAgent {
  const rootDir = path.resolve(options.rootDir);
  const patterns = (options.ignore ?? DEFAULT_IGNORE_LIST).map(compileNamePattern);
  const chatModel = createChatModel(options);

  return {
    async run(planMarkdown: string): Promise<TestPlanGraph> {
      let realRoot: string;
      try {
        realRoot = await fs.promises.realpath(rootDir);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`deep agent: cannot resolve exploration root "${rootDir}": ${message}`, {
          cause: err,
        });
      }

      // One loop breaker per run (see PlannerLoopBreaker): the planner loop
      // has no turn cap, so a model stuck repeating one call must be broken
      // out of, not just nudged.
      const loopBreaker = new PlannerLoopBreaker();
      const agent = new Agent({
        name: "openwebqa-plan-compiler-deep",
        instructions: buildDeepSystemPrompt(),
        model: chatModel,
        tools: [
          ...createExplorationTools(realRoot, rootDir, patterns, options.feedback, loopBreaker),
          createExploreTool(
            realRoot,
            rootDir,
            patterns,
            chatModel,
            options.feedback,
            loopBreaker,
          ),
        ],
      });

      const result = await runAgentRequest(
        () =>
          sharedRunner.run(agent, planMarkdown, {
            // No turn cap: the loop ends when the model stops calling tools
            // and emits the plan JSON (null disables the SDK's 10-turn default).
            maxTurns: null,
            toolNotFoundBehavior: "return_error_to_model",
          }),
        "OpenWebQA deep agent",
      );
      const content = typeof result.finalOutput === "string" ? result.finalOutput : "";
      if (!content) {
        throw new TypeError("OpenWebQA deep agent returned an empty response; expected a JSON TestPlanGraph");
      }
      return extractJson(content);
    },
  };
}
