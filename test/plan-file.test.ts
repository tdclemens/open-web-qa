import { describe, expect, it } from "vitest";
import { parsePlanText, PlanFileError } from "../src/graph/plan-file";

const SRC = "plan.json";

function validGraph() {
  return {
    cases: [
      {
        id: "load-home",
        name: "Load home",
        dependsOn: [],
        actions: [{ type: "goto", url: "http://localhost:4173/" }],
      },
      {
        id: "login",
        name: "Login",
        dependsOn: ["load-home"],
        timeoutMs: 5000,
        actions: [
          { type: "fill", selector: "#email", value: "{{credential:qa.username}}" },
          { type: "click", selector: "#login" },
        ],
      },
    ],
  };
}

function parseOk(raw: unknown, source = SRC) {
  return parsePlanText(typeof raw === "string" ? raw : JSON.stringify(raw), source);
}

describe("parsePlanText", () => {
  it("parses a valid plan with all optional/credential fields", () => {
    const graph = parseOk(validGraph());
    expect(graph.cases).toHaveLength(2);
    expect(graph.cases[1].dependsOn).toEqual(["load-home"]);
    expect(graph.cases[1].timeoutMs).toBe(5000);
    expect(graph.cases[1].actions[0]).toEqual({
      type: "fill",
      selector: "#email",
      value: "{{credential:qa.username}}",
    });
  });

  it("parses a plan with no cases array entries deferred to validateGraph (empty cases is a shape-valid plan)", () => {
    const graph = parseOk({ cases: [] });
    expect(graph.cases).toEqual([]);
  });

  it("tolerates unknown extra fields (forward compatibility)", () => {
    const graph = parseOk({
      version: 1,
      cases: [
        { id: "a", name: "A", dependsOn: [], actions: [], note: "hand edited" },
      ],
    });
    expect(graph.cases[0].id).toBe("a");
  });

  it("throws PlanFileError naming the file on invalid JSON", () => {
    expect(() => parsePlanText("{ not json", "my-plan.json")).toThrow(
      PlanFileError,
    );
    expect(() => parsePlanText("{ not json", "my-plan.json")).toThrow(
      /invalid JSON in my-plan\.json/,
    );
  });

  it.each([
    ["JSON array at root", "[]"],
    ["JSON string at root", '"plan"'],
    ["null at root", "null"],
  ])("throws when the root is %s", (_label, raw) => {
    expect(() => parsePlanText(raw, SRC)).toThrow(PlanFileError);
    expect(() => parsePlanText(raw, SRC)).toThrow(/must be a JSON object with a "cases" array/);
  });

  it.each([
    ["missing cases", {}],
    ["cases not an array", { cases: "nope" }],
    ["cases is an object", { cases: { 0: {} } }],
  ])("throws when %s", (_label, raw) => {
    expect(() => parseOk(raw)).toThrow(PlanFileError);
    expect(() => parseOk(raw)).toThrow(/"cases" must be an array/);
  });

  it("throws when a case is not an object", () => {
    expect(() => parseOk({ cases: ["load-home"] })).toThrow(
      /plan\.json: case at index 0 must be an object/,
    );
  });

  it("reports the case by id when it has a usable id", () => {
    expect(() =>
      parseOk({ cases: [{ id: "login", name: 42, dependsOn: [], actions: [] }] }),
    ).toThrow(/case "login" must have a string "name"/);
  });

  it("throws when a case id is missing or not a string", () => {
    expect(() => parseOk({ cases: [{ name: "A", dependsOn: [], actions: [] }] })).toThrow(
      /case at index 0 must have a string "id"/,
    );
    expect(() => parseOk({ cases: [{ id: 7, name: "A", dependsOn: [], actions: [] }] })).toThrow(
      /case at index 0 must have a string "id"/,
    );
  });

  it("throws when dependsOn is missing, not an array, or has non-string entries", () => {
    expect(() => parseOk({ cases: [{ id: "a", name: "A", actions: [] }] })).toThrow(
      /"dependsOn" must be an array of strings/,
    );
    expect(() =>
      parseOk({ cases: [{ id: "a", name: "A", dependsOn: "b", actions: [] }] }),
    ).toThrow(/"dependsOn" must be an array of strings/);
    expect(() =>
      parseOk({ cases: [{ id: "a", name: "A", dependsOn: ["b", 2], actions: [] }] }),
    ).toThrow(/"dependsOn" must be an array of strings/);
  });

  it("throws when actions is missing or not an array", () => {
    expect(() => parseOk({ cases: [{ id: "a", name: "A", dependsOn: [] }] })).toThrow(
      /"actions" must be an array/,
    );
    expect(() =>
      parseOk({ cases: [{ id: "a", name: "A", dependsOn: [], actions: "nope" }] }),
    ).toThrow(/"actions" must be an array/);
  });

  it("throws when an action is not an object", () => {
    expect(() =>
      parseOk({ cases: [{ id: "a", name: "A", dependsOn: [], actions: ["goto x"] }] }),
    ).toThrow(/case "a" action 0 must be an object/);
  });

  it.each([
    ["string timeoutMs", "fast"],
    ["negative timeoutMs", -1],
    ["infinite timeoutMs", Infinity],
  ])("throws when timeoutMs is %s", (_label, raw) => {
    expect(() =>
      parseOk({
        cases: [{ id: "a", name: "A", dependsOn: [], actions: [], timeoutMs: raw }],
      }),
    ).toThrow(/"timeoutMs" must be a non-negative number/);
  });

  it("accepts timeoutMs 0 and omits it entirely", () => {
    expect(parseOk({ cases: [{ id: "a", name: "A", dependsOn: [], actions: [], timeoutMs: 0 }] }).cases[0].timeoutMs).toBe(
      0,
    );
    expect(parseOk({ cases: [{ id: "a", name: "A", dependsOn: [], actions: [] }] }).cases[0].timeoutMs).toBeUndefined();
  });

  it.each([
    ["string retries", "2"],
    ["negative retries", -1],
    ["fractional retries", 1.5],
  ])("throws when retries is %s", (_label, raw) => {
    expect(() =>
      parseOk({
        cases: [{ id: "a", name: "A", dependsOn: [], actions: [], retries: raw }],
      }),
    ).toThrow(PlanFileError);
    expect(() =>
      parseOk({
        cases: [{ id: "a", name: "A", dependsOn: [], actions: [], retries: raw }],
      }),
    ).toThrow(/"retries" must be a non-negative integer/);
  });

  it("accepts retries 0 and retries 2, and leaves retries undefined when the field is absent", () => {
    expect(parseOk({ cases: [{ id: "a", name: "A", dependsOn: [], actions: [], retries: 2 }] }).cases[0].retries).toBe(
      2,
    );
    expect(parseOk({ cases: [{ id: "a", name: "A", dependsOn: [], actions: [], retries: 0 }] }).cases[0].retries).toBe(
      0,
    );
    expect(parseOk({ cases: [{ id: "a", name: "A", dependsOn: [], actions: [] }] }).cases[0].retries).toBeUndefined();
  });

  it("does not check action types or required fields (validateGraph's job)", () => {
    // Shape-valid (an object with a string type) but semantically wrong.
    const graph = parseOk({
      cases: [
        { id: "a", name: "A", dependsOn: [], actions: [{ type: "teleport", where: "moon" }] },
      ],
    });
    expect(graph.cases[0].actions[0].type).toBe("teleport");
  });
});
