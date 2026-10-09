import type { Action, TestCase, TestPlanGraph } from "../graph/types";

/**
 * Deterministic offline AI agent for OpenWebQA.
 *
 * Mirrors the OpenAI agent interface (see ./openai.ts): `run(planMarkdown)`
 * returns a `Promise<TestPlanGraph>`. Performs no network I/O — it compiles
 * the markdown QA plan into a TestPlanGraph using a fixed grammar, so runs
 * are fully deterministic and work offline (handy for CI and the CLI's
 * `--mock` mode).
 *
 * Grammar:
 *   - The plan is split on level-2 headings: lines matching "## " (with up to
 *     3 leading spaces). Each section becomes one test case:
 *       id   = kebab-case slug of the heading ("Login Flow (v2)" -> "login-flow-v2")
 *       name = the heading text
 *   - Inside a section, "- " bullets are parsed as actions, in order:
 *       - goto <url>
 *       - click <selector>
 *       - fill <selector> <text>         (text = rest of the line; may contain spaces;
 *                                        may be a {{credential:<id>.username|password}}
 *                                        placeholder that the CLI resolves before execution)
 *       - press <key>
 *       - waitForSelector <selector> [ms] (selector = rest of the line, which may contain
 *                                          spaces; when the FINAL token is a non-negative
 *                                          number it is the timeout in ms instead)
 *       - wait <ms>                      (non-negative number)
 *       - screenshot [path]              (path = rest of the line, may contain spaces; with
 *                                        a path the image is saved to that file, without
 *                                        one the capture is discarded)
 *       - assertUrl <url>                (exact match against the current URL)
 *       - assertUrlPartial <url>         (substring match against the current URL)
 *       - assertText <selector> <text>   (text = rest of the line; may contain spaces)
 *       - evaluate <expression>          (expression = rest of the line; may contain spaces)
 *       - depends <id1>, <id2>, ...      (populates the case's dependsOn)
 *       - timeout <ms>                   (non-negative number; case-level like depends — not
 *                                        an action, may appear anywhere in the section, last
 *                                        bullet wins; sets the case's timeoutMs)
 *   - Everything else (prose, non-"- " lines, unknown bullet keywords,
 *     bullets before the first heading) is ignored.
 *   - A recognized keyword missing its argument (e.g. "- goto" with no URL,
 *     "- wait abc") is a malformed plan and throws.
 *   - A plan with no "## " sections throws Error("no test sections found").
 *   - Headings that slug to an empty string or to a duplicate id throw.
 */

/** An AI agent that compiles a markdown QA plan into a TestPlanGraph (offline). */
export interface MockAgent {
  run(planMarkdown: string): Promise<TestPlanGraph>;
}

/** Convert a heading to a kebab-case slug, e.g. "Login Flow (v2)" -> "login-flow-v2". */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Split "selector text..." into [firstToken, restOfLine]. `restOfLine` may
 * contain spaces (it is the remainder of the line, trimmed). Throws when the
 * input has no space-separated second token.
 */
function splitFirst(input: string, keyword: string, section: string): { first: string; rest: string } {
  const space = input.search(/\s/);
  if (space === -1) {
    throw new Error(
      `mock agent: bullet "- ${keyword} ${input}" in section "${section}" is missing its second argument`,
    );
  }
  return { first: input.slice(0, space).trim(), rest: input.slice(space).trim() };
}

/** Return the (non-empty) remainder of a bullet, or throw. */
function requireRest(rest: string, keyword: string, section: string): string {
  if (rest.length === 0) {
    throw new Error(
      `mock agent: bullet "- ${keyword}" in section "${section}" is missing its argument`,
    );
  }
  return rest;
}

/**
 * Split the rest of a "- waitForSelector" bullet into [selector, timeout?].
 * When the FINAL whitespace-separated token is a non-negative number it is
 * the timeout in ms and the selector is everything before it (selectors may
 * contain spaces, e.g. "div > p"); otherwise the entire rest is the selector.
 */
function splitTrailingMs(rest: string): { selector: string; ms?: number } {
  const tokens = rest.split(/\s+/);
  if (tokens.length >= 2) {
    const ms = Number(tokens[tokens.length - 1]);
    if (Number.isFinite(ms) && ms >= 0) {
      return { selector: tokens.slice(0, -1).join(" "), ms };
    }
  }
  return { selector: rest };
}

/** Parse the "- " bullets of one section into actions, dependsOn, and timeoutMs. */
function parseSection(
  lines: string[],
  section: string,
): { actions: Action[]; dependsOn: string[]; timeoutMs?: number } {
  const actions: Action[] = [];
  let dependsOn: string[] = [];
  let timeoutMs: number | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue; // prose and non-bullet lines are ignored
    const content = line.slice(2).trim();
    if (content.length === 0) continue;

    const space = content.search(/\s/);
    const keyword = space === -1 ? content : content.slice(0, space);
    const rest = space === -1 ? "" : content.slice(space).trim();

    if (keyword === "depends") {
      if (rest.length === 0) {
        throw new Error(
          `mock agent: bullet "- depends" in section "${section}" is missing a comma-separated list of case ids`,
        );
      }
      dependsOn = rest
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (dependsOn.length === 0) {
        throw new Error(
          `mock agent: bullet "- depends ${rest}" in section "${section}" lists no case ids`,
        );
      }
      continue;
    }

    if (keyword === "timeout") {
      const msRaw = requireRest(rest, "timeout", section);
      const ms = Number(msRaw);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(
          `mock agent: bullet "- timeout ${msRaw}" in section "${section}": ms must be a non-negative number`,
        );
      }
      timeoutMs = ms; // a later "- timeout" bullet overrides an earlier one
      continue;
    }

    switch (keyword) {
      case "goto": {
        actions.push({ type: "goto", url: requireRest(rest, "goto", section) });
        break;
      }
      case "click": {
        actions.push({ type: "click", selector: requireRest(rest, "click", section) });
        break;
      }
      case "fill": {
        const { first, rest: value } = splitFirst(rest, "fill", section);
        actions.push({ type: "fill", selector: first, value });
        break;
      }
      case "press": {
        actions.push({ type: "press", key: requireRest(rest, "press", section) });
        break;
      }
      case "waitForSelector": {
        const { selector, ms } = splitTrailingMs(requireRest(rest, "waitForSelector", section));
        const action: Action =
          ms !== undefined ? { type: "waitForSelector", selector, timeout: ms } : { type: "waitForSelector", selector };
        actions.push(action);
        break;
      }
      case "wait": {
        const msRaw = requireRest(rest, "wait", section);
        const ms = Number(msRaw);
        if (!Number.isFinite(ms) || ms < 0) {
          throw new Error(
            `mock agent: bullet "- wait ${msRaw}" in section "${section}": ms must be a non-negative number`,
          );
        }
        actions.push({ type: "wait", ms });
        break;
      }
      case "screenshot": {
        // Grammar is "- screenshot [path]"; path = the rest of the line (may
        // contain spaces). Without a path the capture is discarded.
        actions.push(rest.length > 0 ? { type: "screenshot", path: rest } : { type: "screenshot" });
        break;
      }
      case "assertUrl": {
        actions.push({ type: "assertUrl", url: requireRest(rest, "assertUrl", section) });
        break;
      }
      case "assertUrlPartial": {
        actions.push({ type: "assertUrl", url: requireRest(rest, "assertUrlPartial", section), partial: true });
        break;
      }
      case "assertText": {
        const { first, rest: text } = splitFirst(rest, "assertText", section);
        actions.push({ type: "assertText", selector: first, text });
        break;
      }
      case "evaluate": {
        actions.push({ type: "evaluate", expression: requireRest(rest, "evaluate", section) });
        break;
      }
      default:
        // Unknown bullet keyword: ignore (per the grammar's "ignore everything else").
        break;
    }
  }

  return { actions, dependsOn, timeoutMs };
}

function buildCase(
  heading: string,
  lines: string[],
  seenIds: Set<string>,
): TestCase {
  const id = slugify(heading);
  if (id.length === 0) {
    throw new Error(
      `mock agent: heading "${heading}" produced an empty kebab-case id; headings must contain at least one letter or digit`,
    );
  }
  if (seenIds.has(id)) {
    throw new Error(
      `mock agent: duplicate case id "${id}" (heading "${heading}"); headings must slug to unique ids`,
    );
  }
  seenIds.add(id);
  const { actions, dependsOn, timeoutMs } = parseSection(lines, heading);
  const testCase: TestCase = { id, name: heading, dependsOn, actions };
  if (timeoutMs !== undefined) {
    testCase.timeoutMs = timeoutMs;
  }
  return testCase;
}

/**
 * Create a deterministic offline agent that compiles a markdown QA plan into
 * a TestPlanGraph using the fixed bullet grammar documented above.
 */
export function createMockAgent(): MockAgent {
  return {
    async run(planMarkdown: string): Promise<TestPlanGraph> {
      if (typeof planMarkdown !== "string") {
        throw new Error(`mock agent: planMarkdown must be a string, got ${typeof planMarkdown}`);
      }

      const cases: TestCase[] = [];
      const seenIds = new Set<string>();
      let currentHeading: string | null = null;
      let currentLines: string[] = [];

      for (const rawLine of planMarkdown.split(/\r?\n/)) {
        // A level-2 heading: up to 3 leading spaces, "## ", then the heading
        // text (possibly empty/all-whitespace, which is rejected below).
        // "### deeper" or "##nospace" do NOT match — they are plain content.
        const headingMatch = rawLine.match(/^ {0,3}## /);
        if (headingMatch !== null) {
          if (currentHeading !== null) {
            cases.push(buildCase(currentHeading, currentLines, seenIds));
          }
          const heading = rawLine.slice(headingMatch[0].length).trim();
          if (heading.length === 0) {
            throw new Error('mock agent: a "## " section has an empty heading');
          }
          currentHeading = heading;
          currentLines = [];
          continue;
        }
        if (currentHeading !== null) {
          currentLines.push(rawLine); // lines before the first heading are ignored
        }
      }
      if (currentHeading !== null) {
        cases.push(buildCase(currentHeading, currentLines, seenIds));
      }

      if (cases.length === 0) {
        throw new Error("no test sections found");
      }
      return { cases };
    },
  };
}
