// Parsing and structural (type) validation for saved test-plan JSON files.
//
// A saved plan is exactly the TestPlanGraph JSON shape that the agents
// compile to (see types.ts):
//
//   { "cases": [ { "id", "name", "dependsOn", "actions", "timeoutMs"? } ] }
//
// These files are meant to be committed to the user's project and
// hand-edited over time (see the `openwebqa compile` / `openwebqa run`
// commands), so this module checks that the JSON has the right shape (the
// right kinds in the right places) before the graph is used. Semantic checks
// (unique ids, known dependencies, required action fields, acyclicity) are
// intentionally left to validateGraph(), which the CLI runs right after
// parsing. Unknown extra fields are tolerated so the format can grow.

import type { TestCase, TestPlanGraph } from "./types";

/** Thrown when a saved plan file is not valid JSON or does not have the TestPlanGraph shape. */
export class PlanFileError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human-readable reference to a case: `case "x"` or `case at index i`. */
function caseRef(index: number, id: unknown): string {
  return typeof id === "string" && id !== "" ? `case "${id}"` : `case at index ${index}`;
}

/**
 * Parse and shape-check a saved test-plan JSON document.
 *
 * Checks (type errors become PlanFileError, naming the source file):
 *  - the document is valid JSON and is a plain object with a `cases` array;
 *  - every case is an object with a string `id`, a string `name`,
 *    a string array `dependsOn`, and an array `actions`;
 *  - a present `timeoutMs` is a finite, non-negative number;
 *  - every action is an object (its `type` and required fields are checked
 *    by validateGraph).
 *
 * @param raw The file contents.
 * @param source The file path, used in error messages.
 * @returns The parsed graph, typed as TestPlanGraph (validated in shape).
 * @throws PlanFileError on invalid JSON or a wrong shape.
 */
export function parsePlanText(raw: string, source: string): TestPlanGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PlanFileError(`invalid JSON in ${source}: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new PlanFileError(`${source}: a test plan must be a JSON object with a "cases" array`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new PlanFileError(`${source}: "cases" must be an array`);
  }

  const cases = parsed.cases;
  for (let i = 0; i < cases.length; i++) {
    const rawCase = cases[i];
    if (!isRecord(rawCase)) {
      throw new PlanFileError(`${source}: ${caseRef(i, undefined)} must be an object`);
    }
    const ref = caseRef(i, rawCase.id);

    if (typeof rawCase.id !== "string") {
      throw new PlanFileError(`${source}: ${ref} must have a string "id"`);
    }
    if (typeof rawCase.name !== "string") {
      throw new PlanFileError(`${source}: ${ref} must have a string "name"`);
    }
    if (
      !Array.isArray(rawCase.dependsOn) ||
      !rawCase.dependsOn.every((d) => typeof d === "string")
    ) {
      throw new PlanFileError(`${source}: ${ref}: "dependsOn" must be an array of strings`);
    }
    if (!Array.isArray(rawCase.actions)) {
      throw new PlanFileError(`${source}: ${ref}: "actions" must be an array`);
    }
    if (rawCase.timeoutMs !== undefined) {
      const t = rawCase.timeoutMs;
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
        throw new PlanFileError(`${source}: ${ref}: "timeoutMs" must be a non-negative number`);
      }
    }
    rawCase.actions.forEach((action, j) => {
      if (!isRecord(action)) {
        throw new PlanFileError(`${source}: ${ref} action ${j} must be an object`);
      }
    });
  }

  return { cases: cases as TestCase[] };
}
