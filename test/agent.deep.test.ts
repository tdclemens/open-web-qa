import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  createDeepAgent,
  DEFAULT_IGNORE_LIST,
  LOOP_BREAKER_ABORT_AFTER,
  LOOP_BREAKER_NUDGE_AFTER,
  MAX_EXPLORE_REPORT_BYTES,
  MAX_EXPLORE_TURNS,
} from "../src/agent/deep";
import type { TestPlanGraph } from "../src/graph/types";

/** A valid canned TestPlanGraph the mock endpoint can return as the final answer. */
const cannedGraph: TestPlanGraph = {
  cases: [
    {
      id: "tc-01",
      name: "Smoke test",
      dependsOn: [],
      actions: [{ type: "goto", url: "index.html" }, { type: "assertText", selector: "#title", text: "Hello" }],
    },
  ],
};

/** Build a chat.completions response body with either content or tool calls. */
function chatResponse(opts: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: opts.content ?? null };
  if (opts.toolCalls) {
    message.tool_calls = opts.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
  }
  return {
    id: "chatcmpl-deep-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [
      {
        index: 0,
        message,
        finish_reason: opts.toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

interface MockServer {
  url: string;
  /** Every request body received by the endpoint, in order. */
  requests: Array<Record<string, unknown>>;
  stop: () => Promise<void>;
}

async function startServer(
  handler: (body: Record<string, unknown>, index: number) => Record<string, unknown>,
): Promise<MockServer> {
  const requests: Array<Record<string, unknown>> = [];
  let index = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handler(body, index++)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** True when any message in the request body has role "tool". */
function sawToolResult(body: Record<string, unknown>): boolean {
  const messages = (body.messages as Array<{ role: string }> | undefined) ?? [];
  return messages.some((m) => m.role === "tool");
}

/**
 * True when the request belongs to the exploration SUBAGENT rather than the
 * planner: both run against the same endpoint, but the subagent's system
 * prompt is the explorer prompt ("exploration subagent"), while the
 * planner's is the deep-plan-compiler prompt ("Exploration mode is").
 */
function isSubagentRequest(body: Record<string, unknown>): boolean {
  const messages = (body.messages as Array<{ role: string; content?: string }> | undefined) ?? [];
  const system = messages.find((m) => m.role === "system")?.content;
  return typeof system === "string" && system.includes("exploration subagent");
}

/** The role-"tool" message contents of a request, in order. */
function toolResultsOf(body: Record<string, unknown>): string[] {
  const messages = (body.messages as Array<{ role: string; content?: string }> | undefined) ?? [];
  return messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
}

describe("createDeepAgent (plan-time directory exploration)", () => {
  let root: string;
  let outsideDir: string;
  const servers: MockServer[] = [];

  beforeAll(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openwebqa-deep-"));
    outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openwebqa-deep-outside-"));
    const outsideFile = path.join(outsideDir, "outside-secret.txt");
    await fs.promises.writeFile(outsideFile, "OUTSIDE SECRET\n");
    await fs.promises.writeFile(path.join(root, "index.html"), "<html><body><h1 id=title>Hello</h1></body></html>\n");
    await fs.promises.writeFile(path.join(root, ".env"), "SECRET=topsecret\n");
    await fs.promises.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.promises.writeFile(path.join(root, ".git", "config"), "[core]\n");
    await fs.promises.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.promises.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await fs.promises.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.promises.writeFile(path.join(root, "sub", "page.html"), "<html></html>\n");
    await fs.promises.writeFile(path.join(root, "big.txt"), "a".repeat(200_000));
    await fs.promises.writeFile(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    // Symlink pointing OUTSIDE the root: used to verify the realpath escape check.
    await fs.promises.symlink(outsideFile, path.join(root, "outside-link"));
  });

  afterAll(async () => {
    for (const server of servers) await server.stop();
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outsideDir, { recursive: true, force: true });
  });

  it("advertises list_dir/read_file tools, runs a tool round, and returns the parsed graph", async () => {
    const server = await startServer((body) =>
      sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [
              { id: "call-1", name: "list_dir", args: {} },
              { id: "call-2", name: "read_file", args: { path: "index.html" } },
            ],
          }),
    );
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# smoke plan");
    expect(graph).toEqual(cannedGraph);
    expect(server.requests).toHaveLength(2);

    // First request: system + user messages, both tools advertised, JSON mode.
    const first = server.requests[0];
    const firstMessages = first.messages as Array<{ role: string }>;
    expect(firstMessages.map((m) => m.role)).toEqual(["system", "user"]);
    const tools = first.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools.map((t) => t.function.name).sort()).toEqual(["explore", "list_dir", "read_file"]);
    // Plain text output: no response_format on the wire (see openai.ts).
    expect(first.response_format).toBeUndefined();

    // Second request: assistant tool_calls message + one tool result per call.
    const secondMessages = server.requests[1].messages as Array<{
      role: string;
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string } }>;
      tool_call_id?: string;
    }>;
    const assistant = secondMessages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.map((c) => c.function.name)).toEqual(["list_dir", "read_file"]);
    const toolResults = secondMessages
      .filter((m) => m.role === "tool")
      .map((m) => m.content)
      .sort();
    expect(toolResults).toHaveLength(2);
    const listing = toolResults.find((t) => t?.startsWith("Directory:")) ?? "";
    expect(listing).toContain("[file] index.html");
    expect(listing).toContain("[dir ] sub");
    // Ignore list: hidden files/dirs and node_modules are never listed.
    expect(listing).not.toContain(".env");
    expect(listing).not.toContain(".git");
    expect(listing).not.toContain("node_modules");
    const fileRead = toolResults.find((t) => t?.startsWith("File:")) ?? "";
    expect(fileRead).toContain("id=title");
  });

  it("refuses ignored paths, path escapes, and symlink escapes with error tool results", async () => {
    const server = await startServer((body) =>
      sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [
              { id: "c1", name: "read_file", args: { path: ".env" } },
              { id: "c2", name: "read_file", args: { path: "sub/../.git/config" } },
              { id: "c3", name: "read_file", args: { path: "../outside.txt" } },
              { id: "c4", name: "list_dir", args: { path: ".git" } },
              { id: "c5", name: "read_file", args: { path: "outside-link" } },
            ],
          }),
    );
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# probe plan");
    expect(graph).toEqual(cannedGraph);

    const secondMessages = server.requests[1].messages as Array<{ role: string; content?: string | null }>;
    const byCallId = new Map(
      secondMessages
        .filter((m) => m.role === "tool")
        .map((m) => [((m as unknown as { tool_call_id: string }).tool_call_id), m.content ?? ""]),
    );
    expect(byCallId.get("c1")).toMatch(/^error: .*ignore list/);
    expect(byCallId.get("c2")).toMatch(/^error: .*ignore list/);
    expect(byCallId.get("c3")).toMatch(/escapes the project root/);
    expect(byCallId.get("c4")).toMatch(/^error: .*ignore list/);
    expect(byCallId.get("c5")).toMatch(/escapes the project root/);
    for (const content of byCallId.values()) {
      expect(content).not.toContain("topsecret");
      expect(content).not.toContain("OUTSIDE SECRET");
    }
  });

  it("truncates large reads, flags binary files, and reports clean fs errors", async () => {
    const server = await startServer((body) =>
      sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [
              { id: "b1", name: "read_file", args: { path: "big.txt" } },
              { id: "b2", name: "read_file", args: { path: "bin.dat" } },
              { id: "b3", name: "read_file", args: { path: "missing.txt" } },
              { id: "b4", name: "list_dir", args: { path: "index.html" } },
            ],
          }),
    );
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# edge plan");
    expect(graph).toEqual(cannedGraph);

    const secondMessages = server.requests[1].messages as Array<{ role: string; content?: string | null }>;
    const byCallId = new Map(
      secondMessages
        .filter((m) => m.role === "tool")
        .map((m) => [((m as unknown as { tool_call_id: string }).tool_call_id), m.content ?? ""]),
    );
    expect(byCallId.get("b1")).toContain("[showing first 65536 of 200000 bytes]");
    expect(byCallId.get("b2")).toContain("[binary file; content not shown]");
    expect(byCallId.get("b3")).toMatch(/no such file or directory/);
    expect(byCallId.get("b4")).toMatch(/not a directory/);
  });

  it("runs with no turn cap: the agent keeps exploring until it emits the plan JSON", async () => {
    // 15 tool rounds exceeds the SDK's 10-turn default, so this only passes
    // when the deep agent runs with the cap disabled (maxTurns: null).
    // The calls ALTERNATE directories on purpose: the loop breaker only trips
    // on the SAME call repeated in a row (covered by its own tests below),
    // and a model that keeps making different calls is not stuck.
    const toolRounds = 15;
    const server = await startServer((body, i) =>
      i < toolRounds
        ? chatResponse({
            toolCalls: [
              { id: `call-${i}`, name: "list_dir", args: i % 2 === 0 ? {} : { path: "sub" } },
            ],
          })
        : chatResponse({ content: JSON.stringify(cannedGraph) }),
    );
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# long exploration plan");
    expect(graph).toEqual(cannedGraph);
    expect(server.requests).toHaveLength(toolRounds + 1);
  });

  it("appends a loop-breaker note to a repeated identical tool call", async () => {
    const server = await startServer((body, i) => {
      if (i === 0) {
        return chatResponse({ toolCalls: [{ id: "r1", name: "list_dir", args: {} }] });
      }
      if (i === 1) {
        return chatResponse({ toolCalls: [{ id: "r2", name: "list_dir", args: { path: "." } }] });
      }
      return chatResponse({ content: JSON.stringify(cannedGraph) });
    });
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# repeated list plan");
    expect(graph).toEqual(cannedGraph);
    expect(server.requests).toHaveLength(3);

    // First call (omitted path) and second call (explicit ".") normalize to
    // the same signature, so the second one gets the steering note.
    const second = server.requests[1].messages as Array<{ role: string; content?: string | null }>;
    const firstResults = second.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(firstResults).toHaveLength(1);
    expect(firstResults[0]).toMatch(/^Directory:/);
    expect(firstResults[0]).not.toContain("loop breaker");

    const third = server.requests[2].messages as Array<{ role: string; content?: string | null }>;
    const both = third.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(both).toHaveLength(2);
    const noted = both.filter((t) => t.includes("loop breaker"));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain("Directory:"); // original result intact
    expect(noted[0]).toContain(`${LOOP_BREAKER_NUDGE_AFTER} times in a row`);
    expect(noted[0]).toContain("Stop repeating");
  });

  it("aborts the planning run when the model repeats one tool call in a row", async () => {
    // The model never stops calling the same tool: with no turn cap on the
    // planner loop, the loop breaker must abort the run after
    // LOOP_BREAKER_ABORT_AFTER consecutive identical calls instead of
    // looping forever.
    const server = await startServer((body, i) =>
      chatResponse({ toolCalls: [{ id: `call-${i}`, name: "list_dir", args: {} }] }),
    );
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    await expect(agent.run("# stuck plan")).rejects.toThrow(/loop breaker/);
    expect(server.requests.length).toBeGreaterThanOrEqual(LOOP_BREAKER_ABORT_AFTER);
    expect(server.requests.length).toBeLessThanOrEqual(LOOP_BREAKER_ABORT_AFTER + 1);

    // The nudge notes were actually delivered to the model on the repeated
    // calls before the abort.
    const last = server.requests[server.requests.length - 1].messages as Array<{
      role: string;
      content?: string | null;
    }>;
    const noted = last
      .filter((m) => m.role === "tool")
      .map((m) => m.content ?? "")
      .filter((t) => t.includes("loop breaker"));
    expect(noted.length).toBeGreaterThanOrEqual(LOOP_BREAKER_NUDGE_AFTER - 1);
  });

  it("explore delegates to a sandboxed subagent and returns only its report to the planner", async () => {
    const report =
      'Findings:\n- Title element: <h1 id="title"> in index.html (line 1).\n' +
      "- .env is on the ignore list and was not readable.";
    const server = await startServer((body) => {
      if (isSubagentRequest(body)) {
        return sawToolResult(body)
          ? chatResponse({ content: report })
          : chatResponse({
              toolCalls: [
                { id: "s1", name: "read_file", args: { path: ".env" } },
                { id: "s2", name: "list_dir", args: {} },
              ],
            });
      }
      return sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [
              { id: "p1", name: "explore", args: { task: "Which element renders the page title?" } },
            ],
          });
    });
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# explore plan");
    expect(graph).toEqual(cannedGraph);

    const plannerRequests = server.requests.filter((b) => !isSubagentRequest(b));
    const subagentRequests = server.requests.filter(isSubagentRequest);
    expect(plannerRequests).toHaveLength(2);
    expect(subagentRequests).toHaveLength(2);

    // The subagent got its own context: system + user(task), nothing from
    // the planner's conversation.
    const subFirst = subagentRequests[0].messages as Array<{ role: string; content?: string }>;
    expect(subFirst.map((m) => m.role)).toEqual(["system", "user"]);
    expect(subFirst[1].content).toBe("Which element renders the page title?");

    // The sandbox applies INSIDE the subagent too: the .env read is refused
    // and its content never appears in either agent's history.
    expect(toolResultsOf(subagentRequests[1]).some((t) => t.startsWith("error:") && t.includes("ignore list"))).toBe(true);
    for (const req of server.requests) {
      expect(JSON.stringify(req.messages)).not.toContain("topsecret");
    }

    // The planner receives ONLY the subagent's report - no directory
    // listings, no raw file contents from the subagent's own reads.
    const plannerResults = toolResultsOf(plannerRequests[1]);
    expect(plannerResults).toEqual([`explore subagent report:\n${report}`]);
    const plannerHistory = JSON.stringify(plannerRequests[1].messages);
    expect(plannerHistory).not.toContain("Directory:");
    expect(plannerHistory).not.toContain("<h1 id=title>");
  });

  it("caps the subagent at MAX_EXPLORE_TURNS and reports the failure back to the planner", async () => {
    const server = await startServer((body) => {
      if (isSubagentRequest(body)) {
        // The subagent never stops calling tools; the turn cap must stop it.
        return chatResponse({ toolCalls: [{ id: `loop-${server.requests.length}`, name: "list_dir", args: {} }] });
      }
      return sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [{ id: "p1", name: "explore", args: { task: "explore forever" } }],
          });
    });
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# runaway subagent plan");
    expect(graph).toEqual(cannedGraph);

    const subagentRequests = server.requests.filter(isSubagentRequest);
    expect(subagentRequests.length).toBeGreaterThan(1);
    // The SDK allows maxTurns + 1 model calls before throwing.
    expect(subagentRequests.length).toBeLessThanOrEqual(MAX_EXPLORE_TURNS + 2);

    const plannerRequests = server.requests.filter((b) => !isSubagentRequest(b));
    const plannerResults = toolResultsOf(plannerRequests[plannerRequests.length - 1]);
    expect(plannerResults[0]).toMatch(/^error: explore subagent hit its \d+-turn limit/);
  });

  it("truncates an oversized subagent report before it reaches the planner", async () => {
    const hugeReport = "R".repeat(MAX_EXPLORE_REPORT_BYTES + 4096);
    const server = await startServer((body) => {
      if (isSubagentRequest(body)) return chatResponse({ content: hugeReport });
      return sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [{ id: "p1", name: "explore", args: { task: "very long answer" } }],
          });
    });
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# big report plan");
    expect(graph).toEqual(cannedGraph);

    const plannerRequests = server.requests.filter((b) => !isSubagentRequest(b));
    const result = toolResultsOf(plannerRequests[1])[0] ?? "";
    expect(result).toContain(
      `[report truncated: showing first ${MAX_EXPLORE_REPORT_BYTES} of ${MAX_EXPLORE_REPORT_BYTES + 4096} bytes]`,
    );
    // The planner's copy of the report respects the byte cap (plus the
    // header/truncation-note overhead); the full report never reaches it: the
    // longest run of R's is the cap, not the original length.
    const body = result.slice("explore subagent report:\n".length);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_EXPLORE_REPORT_BYTES + 80);
    const longestRun = (result.match(/R+/g) ?? []).reduce((a, b) => Math.max(a, b.length), 0);
    expect(longestRun).toBe(MAX_EXPLORE_REPORT_BYTES);
  });

  it("rejects an empty explore task with an error tool result and starts no subagent", async () => {
    const server = await startServer((body) => {
      if (isSubagentRequest(body)) throw new Error("subagent must not be started for an empty task");
      return sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [{ id: "p1", name: "explore", args: {} }],
          });
    });
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# empty task plan");
    expect(graph).toEqual(cannedGraph);

    const plannerRequests = server.requests.filter((b) => !isSubagentRequest(b));
    const result = toolResultsOf(plannerRequests[1])[0] ?? "";
    expect(result).toMatch(/^error: explore requires a non-empty "task"/);
    expect(server.requests.filter(isSubagentRequest)).toHaveLength(0);
  });

  it("reports a subagent that produced no output as an error tool result", async () => {
    const server = await startServer((body) => {
      if (isSubagentRequest(body)) return chatResponse({ content: "" });
      return sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [{ id: "p1", name: "explore", args: { task: "answer in silence" } }],
          });
    });
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# silent subagent plan");
    expect(graph).toEqual(cannedGraph);

    const plannerRequests = server.requests.filter((b) => !isSubagentRequest(b));
    const result = toolResultsOf(plannerRequests[1])[0] ?? "";
    expect(result).toMatch(/^error: explore subagent failed: .*empty report/);
  });

  it("honors a custom ignore list via the ignore option", async () => {
    const server = await startServer((body) =>
      sawToolResult(body)
        ? chatResponse({ content: JSON.stringify(cannedGraph) })
        : chatResponse({
            toolCalls: [{ id: "i1", name: "list_dir", args: {} }],
          }),
    );
    servers.push(server);

    const agent = createDeepAgent({
      baseUrl: server.url,
      apiKey: "test",
      rootDir: root,
      ignore: [".env", "sub"],
    });
    await agent.run("# custom ignore plan");

    const secondMessages = server.requests[1].messages as Array<{ role: string; content?: string }>;
    const listing = secondMessages.find((m) => m.role === "tool")?.content ?? "";
    expect(listing).not.toContain(".env");
    expect(listing).not.toContain("sub");
    // .git and node_modules are now visible again (default list was replaced).
    expect(listing).toContain(".git");
    expect(listing).toContain("node_modules");
  });

  it("exposes the default ignore list for documentation/logging", () => {
    expect(DEFAULT_IGNORE_LIST).toEqual([".*", "node_modules"]);
  });
});
