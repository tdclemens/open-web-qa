// Runtime validation for a TestPlanGraph (the DAG returned by the AI agent).
//
// Pure function: no I/O, no mutation of the input. The input is typed as
// TestPlanGraph, but at runtime it comes from parsed agent JSON, so every
// access is defensive and type-checked dynamically.

import type { ActionType, TestPlanGraph } from "./types";

/** Required fields per action discriminant (the `type` field itself is checked separately). */
const REQUIRED_FIELDS: Record<ActionType, readonly string[]> = {
  goto: ["url"],
  click: ["selector"],
  fill: ["selector", "value"],
  press: ["key"],
  waitForSelector: ["selector"],
  wait: ["ms"],
  screenshot: [],
  assertUrl: ["url"],
  assertText: ["selector", "text"],
  evaluate: ["expression"],
};

/** All known action discriminant strings. */
const KNOWN_TYPES: readonly ActionType[] = [
  "goto",
  "click",
  "fill",
  "press",
  "waitForSelector",
  "wait",
  "screenshot",
  "assertUrl",
  "assertText",
  "evaluate",
];

/** Normalized view of one case, safe even if the raw data is malformed. */
interface NormCase {
  id: string;
  deps: string[];
  actions: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human-readable reference to a case: `case "x"` or `case at index i` when the id is empty. */
function caseRef(index: number, id: string): string {
  return id !== "" ? `case "${id}"` : `case at index ${index}`;
}

/**
 * Iterative DFS (white/gray/black) over the dependency edges.
 * Returns the cycle path as case ids (first node repeated at the end), or null when acyclic.
 * Unknown deps and self-edges are skipped here; they are reported separately by validateGraph.
 */
function findCyclePath(norm: NormCase[], idToIndex: Map<string, number>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Uint8Array(norm.length);
  const path: number[] = [];

  for (let start = 0; start < norm.length; start++) {
    if (color[start] !== WHITE) continue;

    color[start] = GRAY;
    path.push(start);
    const frames: Array<{ index: number; nextDep: number }> = [
      { index: start, nextDep: 0 },
    ];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const deps = norm[frame.index].deps;

      if (frame.nextDep < deps.length) {
        const depId = deps[frame.nextDep];
        frame.nextDep += 1;

        // Self-edge: reported separately by validateGraph.
        if (depId === norm[frame.index].id) continue;

        const depIndex = idToIndex.get(depId);
        if (depIndex === undefined) continue; // unknown dep: reported separately

        if (color[depIndex] === GRAY) {
          // Back edge: the cycle is path[from..top] plus the repeated node.
          const from = path.indexOf(depIndex);
          return [...path.slice(from), depIndex].map((i) => norm[i].id);
        }
        if (color[depIndex] === WHITE) {
          color[depIndex] = GRAY;
          path.push(depIndex);
          frames.push({ index: depIndex, nextDep: 0 });
        }
      } else {
        color[frame.index] = BLACK;
        frames.pop();
        path.pop();
      }
    }
  }
  return null;
}

/**
 * Validate a test-plan graph.
 *
 * Checks, in order:
 *  1. the graph has at least one case;
 *  2. case ids are non-empty and unique;
 *  3. every `dependsOn` entry references an existing id (and no self-dependency);
 *  4. every action has a known `type` discriminant and all fields required by it;
 *  5. the dependency graph is acyclic (cycle path included in the error).
 *
 * @returns Human-readable error strings; an empty array when the graph is valid.
 */
export function validateGraph(graph: TestPlanGraph): string[] {
  const errors: string[] = [];

  // 1. At least one case.
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.cases)) {
    errors.push("test plan graph is missing its cases array");
    return errors;
  }
  if (graph.cases.length === 0) {
    errors.push("test plan has no test cases");
    return errors;
  }

  // Normalize (defensively) so later passes never throw on malformed data.
  const norm: NormCase[] = graph.cases.map((c) => {
    const raw = isRecord(c) ? (c as Record<string, unknown>) : ({} as Record<string, unknown>);
    return {
      id: typeof raw.id === "string" ? raw.id : "",
      deps: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d): d is string => typeof d === "string") : [],
      actions: Array.isArray(raw.actions) ? (raw.actions as unknown[]) : [],
    };
  });

  // 2. Non-empty, unique ids.
  const idToIndex = new Map<string, number>();
  const reportedDuplicates = new Set<string>();
  for (let i = 0; i < norm.length; i++) {
    const id = norm[i].id;
    if (id === "") {
      errors.push(`case at index ${i} has an empty id`);
      continue;
    }
    if (idToIndex.has(id)) {
      if (!reportedDuplicates.has(id)) {
        errors.push(`duplicate case id: "${id}"`);
        reportedDuplicates.add(id);
      }
      continue;
    }
    idToIndex.set(id, i);
  }

  // 3. Dependencies reference existing ids; no self-dependency.
  for (let i = 0; i < norm.length; i++) {
    const ref = caseRef(i, norm[i].id);
    for (const dep of norm[i].deps) {
      if (dep === norm[i].id) {
        errors.push(`${ref} depends on itself`);
        continue;
      }
      if (!idToIndex.has(dep)) {
        errors.push(`${ref} depends on unknown case id: "${dep}"`);
      }
    }
  }

  // 4. Action discriminants and required fields.
  for (let i = 0; i < norm.length; i++) {
    const ref = caseRef(i, norm[i].id);
    norm[i].actions.forEach((action, j) => {
      if (!isRecord(action)) {
        errors.push(`${ref} action ${j} is not an object`);
        return;
      }
      if (typeof action.type !== "string") {
        errors.push(`${ref} action ${j} is missing the "type" field`);
        return;
      }
      const type = action.type as ActionType;
      if (!KNOWN_TYPES.includes(type)) {
        errors.push(`${ref} action ${j} has unknown type: "${type}"`);
        return;
      }
      for (const field of REQUIRED_FIELDS[type]) {
        if (action[field] == null) {
          errors.push(`${ref} action ${j} (type "${type}") is missing required field: ${field}`);
        }
      }
    });
  }

  // 5. Acyclicity (iterative DFS, cycle path included in the error).
  const cycle = findCyclePath(norm, idToIndex);
  if (cycle !== null) {
    errors.push(`circular dependency: ${cycle.join(" -> ")}`);
  }

  return errors;
}
