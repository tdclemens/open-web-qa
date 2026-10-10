import { describe, expect, it } from "vitest";
import type { TestPlanGraph } from "../src/graph/types";
import { createMockAgent, slugify } from "../src/agent/mock";

/**
 * A 2-section plan that exercises:
 *  - every mock-grammar action type (goto, click, fill, press,
 *    waitForSelector, wait, screenshot, assertUrl, assertText, evaluate)
 *  - a fill value containing spaces ("jane does@example.com")
 *  - an assertText value containing spaces ("Welcome back Jane")
 *  - depends parsing
 *  - ignored content: preamble prose, a paragraph line inside a section,
 *    and an unknown bullet ("- hover ...")
 */
const plan = [
  "# Full smoke plan",
  "",
  "Preamble prose before the first section is ignored.",
  "",
  "## Smoke the login flow",
  "",
  "Walks through the primary login flow end to end.",
  "",
  "- goto https://example.com/login",
  "- fill #email jane does@example.com",
  "- fill #password S3cret!",
  "- click #login",
  "- press Enter",
  "- waitForSelector .dashboard",
  "- wait 300",
  "- screenshot",
  "- assertUrl https://example.com/dashboard",
  "- assertText .welcome Welcome back Jane",
  "- hover .tooltip  (unknown bullet keyword: ignored)",
  "",
  "## Check the profile page",
  "",
  "- depends smoke-the-login-flow",
  "- goto https://example.com/profile",
  "- assertText h1 Jane Doe's Profile",
].join("\n");

const expected: TestPlanGraph = {
  cases: [
    {
      id: "smoke-the-login-flow",
      name: "Smoke the login flow",
      dependsOn: [],
      actions: [
        { type: "goto", url: "https://example.com/login" },
        { type: "fill", selector: "#email", value: "jane does@example.com" },
        { type: "fill", selector: "#password", value: "S3cret!" },
        { type: "click", selector: "#login" },
        { type: "press", key: "Enter" },
        { type: "waitForSelector", selector: ".dashboard" },
        { type: "wait", ms: 300 },
        { type: "screenshot" },
        { type: "assertUrl", url: "https://example.com/dashboard" },
        { type: "assertText", selector: ".welcome", text: "Welcome back Jane" },
      ],
    },
    {
      id: "check-the-profile-page",
      name: "Check the profile page",
      dependsOn: ["smoke-the-login-flow"],
      actions: [
        { type: "goto", url: "https://example.com/profile" },
        { type: "assertText", selector: "h1", text: "Jane Doe's Profile" },
      ],
    },
  ],
};

describe("createMockAgent", () => {
  it("compiles the 2-section plan: all action types, fill with spaces, depends", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(plan);
    expect(graph).toEqual(expected);
  });

  it("is deterministic: repeated runs on the same plan produce identical graphs", async () => {
    const agent = createMockAgent();
    const first = await agent.run(plan);
    const second = await createMockAgent().run(plan);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(expected));
  });

  it("parses a depends bullet with multiple comma-separated ids (order preserved, whitespace trimmed)", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(
      [
        "## alpha",
        "- screenshot",
        "",
        "## beta",
        "- depends gamma , alpha ,delta",
        "",
        "## gamma",
        "- wait 10",
      ].join("\n"),
    );
    expect(graph.cases.map((c) => c.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(graph.cases[1].dependsOn).toEqual(["gamma", "alpha", "delta"]);
  });

  it("treats bullets before the first '## ' heading as ignored prose", async () => {
    const agent = createMockAgent();
    const graph = await agent.run("- goto https://example.com\n\n## real section\n- wait 5\n");
    expect(graph.cases).toHaveLength(1);
    expect(graph.cases[0].id).toBe("real-section");
    expect(graph.cases[0].actions).toEqual([{ type: "wait", ms: 5 }]);
  });

  it("throws Error('no test sections found') when there are no '## ' sections", async () => {
    const agent = createMockAgent();
    await expect(agent.run("")).rejects.toThrow("no test sections found");
    await expect(agent.run("# Only a title\n\nJust prose, no sections.\n")).rejects.toThrow(
      "no test sections found",
    );
    await expect(agent.run("- goto https://example.com\n- click #x\n")).rejects.toThrow(
      "no test sections found",
    );
  });

  it("throws when a recognized action bullet is missing its argument", async () => {
    const agent = createMockAgent();
    await expect(agent.run("## a\n- goto\n")).rejects.toThrow(/bullet "- goto".*missing its argument/);
    await expect(agent.run("## a\n- fill #only-selector\n")).rejects.toThrow(
      /missing its second argument/,
    );
    await expect(agent.run("## a\n- wait\n")).rejects.toThrow(/missing its argument/);
    await expect(agent.run("## a\n- depends\n")).rejects.toThrow(/missing a comma-separated list/);
  });

  it("parses evaluate bullets (expression = rest of line, may contain spaces) and rejects a bare '- evaluate'", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(
      [
        "## evaluate checks",
        "- evaluate 1 + 1",
        "- evaluate document.title",
      ].join("\n"),
    );
    expect(graph.cases[0].actions).toEqual([
      { type: "evaluate", expression: "1 + 1" },
      { type: "evaluate", expression: "document.title" },
    ]);
    await expect(agent.run("## a\n- evaluate\n")).rejects.toThrow(/missing its argument/);
  });

  it("throws when wait <ms> is not a non-negative number", async () => {
    const agent = createMockAgent();
    await expect(agent.run("## a\n- wait abc\n")).rejects.toThrow(/ms must be a non-negative number/);
    await expect(agent.run("## a\n- wait -5\n")).rejects.toThrow(/ms must be a non-negative number/);
  });

  it("throws on duplicate case ids produced by different headings", async () => {
    const agent = createMockAgent();
    await expect(agent.run("## Login\n- wait 1\n\n## login\n- wait 2\n")).rejects.toThrow(
      /duplicate case id "login"/,
    );
  });

  it("throws on a '## ' section with an empty heading", async () => {
    const agent = createMockAgent();
    await expect(agent.run("## \n- wait 1\n")).rejects.toThrow(/empty heading/);
  });
});

describe("parity extensions (optional fields the OpenAI agent can set in JSON)", () => {
  it("parses waitForSelector with an optional trailing timeout (selector may contain spaces)", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(
      [
        "## waits",
        "- waitForSelector .plain",
        "- waitForSelector .timed 5000",
        "- waitForSelector div > p 250",
        "- waitForSelector #posts article:nth-of-type(2)",
        "- waitForSelector .weird token",
      ].join("\n"),
    );
    expect(graph.cases[0].actions).toEqual([
      { type: "waitForSelector", selector: ".plain" },
      { type: "waitForSelector", selector: ".timed", timeout: 5000 },
      { type: "waitForSelector", selector: "div > p", timeout: 250 },
      { type: "waitForSelector", selector: "#posts article:nth-of-type(2)" },
      // A final token that is not a non-negative number stays part of the selector.
      { type: "waitForSelector", selector: ".weird token" },
    ]);
  });

  it("parses screenshot with an optional trailing path (path may contain spaces)", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(
      [
        "## shots",
        "- screenshot",
        "- screenshot shot-out/step.png",
        "- screenshot my shots/a b.png",
      ].join("\n"),
    );
    expect(graph.cases[0].actions).toEqual([
      { type: "screenshot" },
      { type: "screenshot", path: "shot-out/step.png" },
      { type: "screenshot", path: "my shots/a b.png" },
    ]);
  });

  it("parses assertUrlPartial as a partial assertUrl and rejects a bare bullet", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(
      ["## urls", "- assertUrl https://example.com/full", "- assertUrlPartial /dash"].join("\n"),
    );
    expect(graph.cases[0].actions).toEqual([
      { type: "assertUrl", url: "https://example.com/full" },
      { type: "assertUrl", url: "/dash", partial: true },
    ]);
    await expect(agent.run("## a\n- assertUrlPartial\n")).rejects.toThrow(
      /bullet "- assertUrlPartial".*missing its argument/,
    );
  });

  it("parses a case-level timeout bullet into timeoutMs (not an action; last one wins)", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(
      [
        "## timed case",
        "- timeout 12345",
        "- goto https://example.com",
        "- timeout 999",
      ].join("\n"),
    );
    expect(graph.cases[0].actions).toEqual([{ type: "goto", url: "https://example.com" }]);
    expect(graph.cases[0].timeoutMs).toBe(999);
  });

  it("omits timeoutMs entirely when no timeout bullet is present", async () => {
    const agent = createMockAgent();
    const graph = await agent.run("## plain\n- wait 1\n");
    expect(graph.cases[0]).not.toHaveProperty("timeoutMs");
  });

  it("throws when the timeout bullet is missing its argument or not a non-negative number", async () => {
    const agent = createMockAgent();
    await expect(agent.run("## a\n- timeout\n")).rejects.toThrow(
      /bullet "- timeout".*missing its argument/,
    );
    await expect(agent.run("## a\n- timeout abc\n")).rejects.toThrow(
      /ms must be a non-negative number/,
    );
    await expect(agent.run("## a\n- timeout -5\n")).rejects.toThrow(
      /ms must be a non-negative number/,
    );
  });

  it("parses a case-level retries bullet into retries (not an action)", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(
      [
        "## retried case",
        "- retries 2",
        "- goto https://example.com",
        "- click #submit",
      ].join("\n"),
    );
    expect(graph.cases[0].actions).toEqual([
      { type: "goto", url: "https://example.com" },
      { type: "click", selector: "#submit" },
    ]);
    expect(graph.cases[0].retries).toBe(2);
  });

  it("applies last-retries-bullet-wins when multiple retries bullets are present", async () => {
    const agent = createMockAgent();
    const graph = await agent.run(
      [
        "## retried case",
        "- retries 1",
        "- goto https://example.com",
        "- retries 3",
      ].join("\n"),
    );
    expect(graph.cases[0].actions).toEqual([{ type: "goto", url: "https://example.com" }]);
    expect(graph.cases[0].retries).toBe(3);
  });

  it("omits retries entirely when no retries bullet is present", async () => {
    const agent = createMockAgent();
    const graph = await agent.run("## plain\n- wait 1\n");
    expect(graph.cases[0]).not.toHaveProperty("retries");
  });

  it("throws when the retries bullet is missing its argument or not a non-negative integer", async () => {
    const agent = createMockAgent();
    await expect(agent.run("## a\n- retries\n")).rejects.toThrow(
      /bullet "- retries".*missing its argument/,
    );
    await expect(agent.run("## a\n- retries x\n")).rejects.toThrow(
      /n must be a non-negative integer/,
    );
    await expect(agent.run("## a\n- retries -1\n")).rejects.toThrow(
      /n must be a non-negative integer/,
    );
  });
});

describe("slugify", () => {
  it("kebab-cases headings", () => {
    expect(slugify("Smoke the login flow")).toBe("smoke-the-login-flow");
    expect(slugify("Check The Profile Page")).toBe("check-the-profile-page");
    expect(slugify("Login Flow (v2) — final!")).toBe("login-flow-v2-final");
    expect(slugify("  padded heading  ")).toBe("padded-heading");
  });
});
