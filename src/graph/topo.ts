// Topological level computation for a TestPlanGraph (Kahn's algorithm, grouping variant).
//
// Pure function: no I/O, no mutation of the input. Intended to run on a
// graph that has already passed validateGraph, so case ids are assumed to be
// non-empty, unique, and to reference only existing ids.

import type { TestPlanGraph } from "./types";

/**
 * Group the test cases of a DAG into execution levels using Kahn's algorithm.
 *
 * - Level 0 contains the ids of all cases with no dependencies.
 * - Level n contains the ids of all cases whose dependencies all appear in
 *   levels 0..n-1 (i.e. every dependency has just been placed).
 *
 * Within each level, ids appear in the order the cases were given in the
 * input graph. The returned array is in execution order: a case in level n
 * may only start once every case in levels 0..n-1 has completed.
 *
 * Cases within the same level are independent of each other and can run in
 * parallel; levels themselves must run in series.
 *
 * @throws Error('circular dependency detected') if the graph contains a cycle
 *   (i.e. Kahn's algorithm finishes without placing every case).
 */
export function computeLevels(graph: TestPlanGraph): string[][] {
  const cases = graph.cases;
  const n = cases.length;

  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i++) indexById.set(cases[i].id, i);

  // indegree[i] = number of dependencies of case i (within the graph).
  // dependents[j] = indices of cases that depend on case j.
  const indegree = new Array<number>(n).fill(0);
  const dependents: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    for (const dep of cases[i].dependsOn) {
      const depIndex = indexById.get(dep);
      if (depIndex === undefined) continue; // defensive: validated input only
      indegree[i] += 1;
      dependents[depIndex].push(i);
    }
  }

  const levels: string[][] = [];
  let placed = 0;

  // Frontier = cases whose dependencies are all placed. Built by scanning the
  // input order, so it is already sorted by input index.
  let frontier: number[] = [];
  for (let i = 0; i < n; i++) {
    if (indegree[i] === 0) frontier.push(i);
  }

  while (frontier.length > 0) {
    levels.push(frontier.map((i) => cases[i].id));
    placed += frontier.length;

    const next: number[] = [];
    for (const i of frontier) {
      for (const j of dependents[i]) {
        indegree[j] -= 1;
        if (indegree[j] === 0) next.push(j);
      }
    }

    // Preserve input order within the level: a case becomes ready when its
    // last dependency is processed, which is not necessarily in index order.
    next.sort((a, b) => a - b);
    frontier = next;
  }

  if (placed !== n) {
    throw new Error("circular dependency detected");
  }

  return levels;
}
