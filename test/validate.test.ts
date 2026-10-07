import { describe, expect, it } from "vitest";
import { validateGraph } from "../src/graph/validate";
import type { Action, TestCase, TestPlanGraph } from "../src/graph/types";

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

describe("validateGraph", () => {
  it("returns [] for a valid linear graph with typed actions and dependencies", () => {
    const graph = graphOf([
      makeCase({
        id: "setup",
        name: "Setup",
        actions: [{ type: "goto", url: "https://example.com" }],
      }),
      makeCase({
        id: "login",
        name: "Login",
        dependsOn: ["setup"],
        actions: [
          { type: "fill", selector: "#email", value: "jane@example.com" },
          { type: "fill", selector: "#password", value: "S3cret!" },
          { type: "click", selector: "#login" },
        ],
      }),
      makeCase({
        id: "profile",
        name: "Profile",
        dependsOn: ["login"],
        timeoutMs: 5000,
        actions: [
          { type: "assertUrl", url: "https://example.com/profile", partial: true },
          { type: "assertText", selector: "h1", text: "Welcome" },
        ],
      }),
    ]);
    expect(validateGraph(graph)).toEqual([]);
  });

  it("returns [] when every action type is used with only its required fields", () => {
    const graph = graphOf([
      makeCase({
        id: "a",
        actions: [
          { type: "press", key: "Enter" },
          { type: "waitForSelector", selector: ".dashboard" },
          { type: "wait", ms: 100 },
          { type: "screenshot" },
          { type: "assertUrl", url: "https://example.com/dashboard" },
          { type: "evaluate", expression: "document.title" },
        ],
      }),
    ]);
    expect(validateGraph(graph)).toEqual([]);
  });

  it("rejects an empty graph", () => {
    expect(validateGraph({ cases: [] })).toEqual(["test plan has no test cases"]);
  });

  it("reports duplicate case ids (once per duplicated id)", () => {
    const errors = validateGraph(
      graphOf([makeCase({ id: "a" }), makeCase({ id: "a" }), makeCase({ id: "a" })]),
    );
    expect(errors).toContain('duplicate case id: "a"');
    expect(errors.filter((e) => e === 'duplicate case id: "a"')).toHaveLength(1);
  });

  it("reports an empty case id", () => {
    expect(validateGraph(graphOf([makeCase({ id: "" })]))).toContain(
      "case at index 0 has an empty id",
    );
  });

  it("reports unknown dependency targets", () => {
    const errors = validateGraph(
      graphOf([
        makeCase({ id: "a", dependsOn: ["ghost"] }),
        makeCase({ id: "b" }),
      ]),
    );
    expect(errors).toContain('case "a" depends on unknown case id: "ghost"');
  });

  it("reports self-dependency without also flagging it as a cycle", () => {
    const errors = validateGraph(graphOf([makeCase({ id: "a", dependsOn: ["a"] })]));
    expect(errors).toContain('case "a" depends on itself');
    expect(errors.some((e) => e.startsWith("circular dependency"))).toBe(false);
  });

  it("detects a 2-node cycle and includes the cycle path in the error", () => {
    const errors = validateGraph(
      graphOf([
        makeCase({ id: "a", dependsOn: ["b"] }),
        makeCase({ id: "b", dependsOn: ["a"] }),
      ]),
    );
    expect(
      errors.some((e) =>
        /^(circular dependency: a -> b -> a|circular dependency: b -> a -> b)$/.test(e),
      ),
    ).toBe(true);
  });

  it("detects a 3-node cycle and includes the cycle path in the error", () => {
    const errors = validateGraph(
      graphOf([
        makeCase({ id: "a", dependsOn: ["b"] }),
        makeCase({ id: "b", dependsOn: ["c"] }),
        makeCase({ id: "c", dependsOn: ["a"] }),
      ]),
    );
    expect(
      errors.some((e) =>
        /^(circular dependency: a -> b -> c -> a|circular dependency: b -> c -> a -> b|circular dependency: c -> a -> b -> c)$/.test(
          e,
        ),
      ),
    ).toBe(true);
  });

  it("detects a cycle in a diamond graph where only part of the graph is cyclic", () => {
    // a -> b -> d -> b (cycle b<->d), plus an unrelated case c
    const errors = validateGraph(
      graphOf([
        makeCase({ id: "a" }),
        makeCase({ id: "b", dependsOn: ["a", "d"] }),
        makeCase({ id: "c", dependsOn: ["a"] }),
        makeCase({ id: "d", dependsOn: ["b"] }),
      ]),
    );
    expect(
      errors.some((e) =>
        /^(circular dependency: b -> d -> b|circular dependency: d -> b -> d)$/.test(e),
      ),
    ).toBe(true);
  });

  it("reports an action with an unknown type discriminant", () => {
    const errors = validateGraph(
      graphOf([
        makeCase({
          id: "a",
          actions: [{ type: "hover", selector: ".tooltip" } as unknown as Action],
        }),
      ]),
    );
    expect(errors).toContain('case "a" action 0 has unknown type: "hover"');
  });

  it("reports an action missing the type field", () => {
    const errors = validateGraph(
      graphOf([makeCase({ id: "a", actions: [{} as unknown as Action] })]),
    );
    expect(errors).toContain('case "a" action 0 is missing the "type" field');
  });

  it("reports an action missing a required field", () => {
    const errors = validateGraph(
      graphOf([makeCase({ id: "a", actions: [{ type: "click" } as unknown as Action] })]),
    );
    expect(errors).toContain(
      'case "a" action 0 (type "click") is missing required field: selector',
    );
  });

  it("reports every missing required field for a multi-field action", () => {
    const errors = validateGraph(
      graphOf([makeCase({ id: "a", actions: [{ type: "fill" } as unknown as Action] })]),
    );
    expect(errors).toContain(
      'case "a" action 0 (type "fill") is missing required field: selector',
    );
    expect(errors).toContain(
      'case "a" action 0 (type "fill") is missing required field: value',
    );
  });

  it("reports a non-object action", () => {
    const errors = validateGraph(
      graphOf([makeCase({ id: "a", actions: ["goto https://x" as unknown as Action] })]),
    );
    expect(errors).toContain("case \"a\" action 0 is not an object");
  });

  it("reports multiple independent problems in one graph", () => {
    const errors = validateGraph(
      graphOf([
        makeCase({ id: "a", dependsOn: ["b", "ghost"], actions: [{ type: "click" } as unknown as Action] }),
        makeCase({ id: "b", dependsOn: ["a"] }),
      ]),
    );
    expect(errors).toContain('case "a" depends on unknown case id: "ghost"');
    expect(errors).toContain(
      'case "a" action 0 (type "click") is missing required field: selector',
    );
    expect(
      errors.some((e) =>
        /^(circular dependency: a -> b -> a|circular dependency: b -> a -> b)$/.test(e),
      ),
    ).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("is pure: does not mutate the input graph", () => {
    const graph = graphOf([
      makeCase({ id: "a", dependsOn: ["b"] }),
      makeCase({ id: "b", dependsOn: ["a"] }),
    ]);
    const before = JSON.stringify(graph);
    validateGraph(graph);
    expect(JSON.stringify(graph)).toBe(before);
  });
});
