import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createDeepAgent, DEFAULT_IGNORE_LIST } from "../src/agent/deep";
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
    expect(tools.map((t) => t.function.name).sort()).toEqual(["list_dir", "read_file"]);
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
    const toolRounds = 15;
    const server = await startServer((body, i) =>
      i < toolRounds
        ? chatResponse({ toolCalls: [{ id: `call-${i}`, name: "list_dir", args: {} }] })
        : chatResponse({ content: JSON.stringify(cannedGraph) }),
    );
    servers.push(server);

    const agent = createDeepAgent({ baseUrl: server.url, apiKey: "test", rootDir: root });
    const graph = await agent.run("# long exploration plan");
    expect(graph).toEqual(cannedGraph);
    expect(server.requests).toHaveLength(toolRounds + 1);
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
