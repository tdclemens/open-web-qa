import fs from "node:fs";
import path from "node:path";
import { Agent, tool } from "@openai/agents";
import type { TestPlanGraph } from "../graph/types";
import {
  buildSystemPrompt,
  createChatModel,
  extractJson,
  runAgentRequest,
  sharedRunner,
} from "./openai";
import type { OpenAiAgent, OpenAiAgentOptions } from "./openai";

/**
 * "Deep" AI agent for OpenWebQA (plan-time directory exploration).
 *
 * Wraps the OpenAI-compatible chat endpoint used by ./openai.ts in a
 * tool-calling loop: while compiling the markdown QA plan into a
 * TestPlanGraph, the model may inspect the local project directory with two
 * tools — `list_dir` and `read_file` — so it can verify page URLs, CSS
 * selectors, and expected text against the actual application source.
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
 * two tools, tool argument errors (including invalid JSON arguments) are
 * returned to the model as `role: "tool"` messages so it can self-correct,
 * and the loop runs with no turn cap: the agent keeps exploring until it
 * decides it has enough information, stops calling tools, and emits the plan
 * JSON.
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
  let real = resolved;
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
 */
function createExplorationTools(realRoot: string, rootDir: string, patterns: RegExp[]) {
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
      execute: (input: unknown) =>
        runExplorationTool("list_dir", input, realRoot, rootDir, patterns),
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
      execute: (input: unknown) =>
        runExplorationTool("read_file", input, realRoot, rootDir, patterns),
    }),
  ];
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
  const obj =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const rawPath = typeof obj.path === "string" && obj.path.length > 0 ? obj.path : ".";
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
 * TestPlanGraph" instructions plus the exploration-mode rules.
 */
export function buildDeepSystemPrompt(): string {
  return [
    buildSystemPrompt(),
    "",
    "Exploration mode is enabled: the pages under test come from a web application",
    "whose source is in the current project directory. Before writing the plan you",
    "MAY inspect that application with two tools:",
    '- list_dir: list a directory relative to the project root (omit "path" to list',
    "  the root). Hidden files and other ignored entries are never listed.",
    '- read_file: read a text file relative to the project root (first 64 KB).',
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
        throw new Error(`deep agent: cannot resolve exploration root "${rootDir}": ${message}`);
      }

      const agent = new Agent({
        name: "openwebqa-plan-compiler-deep",
        instructions: buildDeepSystemPrompt(),
        model: chatModel,
        tools: createExplorationTools(realRoot, rootDir, patterns),
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
