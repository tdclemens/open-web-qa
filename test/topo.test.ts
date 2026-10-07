import { describe, expect, it } from "vitest";
import { computeLevels } from "../src/graph/topo";
import type { TestCase, TestPlanGraph } from "../src/graph/types";

function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "a",
    name: "Case A",
    dependsOn: [],
    actions: [],
    ...overrides,
  };
}

function graphOf(cases: TestCase[]): TestPlanGraph {
  return { cases };
}

describe("computeLevels", () => {
  it("returns one level per case for a 3-case linear chain", () => {
    const graph = graphOf([
      makeCase({ id: "a" }),
      makeCase({ id: "b", dependsOn: ["a"] }),
      makeCase({ id: "c", dependsOn: ["b"] }),
    ]);
    expect(computeLevels(graph)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("groups a diamond a->(b,c)->d into 3 order-preserving levels", () => {
    const graph = graphOf([
      makeCase({ id: "a" }),
      makeCase({ id: "b", dependsOn: ["a"] }),
      makeCase({ id: "c", dependsOn: ["a"] }),
      makeCase({ id: "d", dependsOn: ["b", "c"] }),
    ]);
    expect(computeLevels(graph)).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("puts all independent cases in a single level, in input order", () => {
    const graph = graphOf([
      makeCase({ id: "x" }),
      makeCase({ id: "y" }),
      makeCase({ id: "z" }),
    ]);
    expect(computeLevels(graph)).toEqual([["x", "y", "z"]]);
  });

  it("preserves input order within a level even when readiness differs", () => {
    // c0 depends on both c1 and c2 (ready only after c2 is processed, which
    // comes after c3 became ready via c1); c3 depends only on c1.
    // Input order within level 1 must be [c0, c3], not [c3, c0].
    const graph = graphOf([
      makeCase({ id: "c0", dependsOn: ["c2", "c1"] }),
      makeCase({ id: "c1" }),
      makeCase({ id: "c2" }),
      makeCase({ id: "c3", dependsOn: ["c1"] }),
    ]);
    expect(computeLevels(graph)).toEqual([["c1", "c2"], ["c0", "c3"]]);
  });

  it("throws 'circular dependency detected' for a cycle", () => {
    const graph = graphOf([
      makeCase({ id: "a", dependsOn: ["c"] }),
      makeCase({ id: "b", dependsOn: ["a"] }),
      makeCase({ id: "c", dependsOn: ["b"] }),
    ]);
    expect(() => computeLevels(graph)).toThrowError("circular dependency detected");
  });

  it("throws for a cycle that leaves independent cases behind", () => {
    const graph = graphOf([
      makeCase({ id: "free" }),
      makeCase({ id: "a", dependsOn: ["b"] }),
      makeCase({ id: "b", dependsOn: ["a"] }),
    ]);
    expect(() => computeLevels(graph)).toThrowError("circular dependency detected");
  });

  it("does not mutate the input graph", () => {
    const graph = graphOf([
      makeCase({ id: "a" }),
      makeCase({ id: "b", dependsOn: ["a"] }),
    ]);
    const snapshot = JSON.stringify(graph);
    computeLevels(graph);
    expect(JSON.stringify(graph)).toBe(snapshot);
  });

  it("returns [] for an empty graph", () => {
    expect(computeLevels(graphOf([]))).toEqual([]);
  });
});
