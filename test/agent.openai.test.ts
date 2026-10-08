import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type { TestPlanGraph } from "../src/graph/types";
import { createOpenAiAgent, extractJson } from "../src/agent/openai";

/** A valid canned TestPlanGraph used by the local mock endpoint. */
const cannedGraph: TestPlanGraph = {
  cases: [
    {
      id: "tc-01",
      name: "Login as admin",
      dependsOn: [],
      actions: [
        { type: "goto", url: "https://example.com/login" },
        { type: "fill", selector: "#email", value: "admin@example.com" },
        { type: "fill", selector: "#password", value: "hunter2" },
        { type: "click", selector: "button[type=submit]" },
        { type: "assertUrl", url: "https://example.com/dashboard", partial: false },
      ],
    },
    {
      id: "tc-02",
      name: "Verify dashboard content",
      dependsOn: ["tc-01"],
      actions: [
        { type: "waitForSelector", selector: "#greeting", timeout: 5000 },
        { type: "assertText", selector: "#greeting", text: "Hello, admin" },
        { type: "screenshot" },
      ],
    },
  ],
};

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson(JSON.stringify(cannedGraph))).toEqual(cannedGraph);
  });

  it("parses markdown-fenced JSON", () => {
    const fenced = "```json\n" + JSON.stringify(cannedGraph, null, 2) + "\n```";
    expect(extractJson(fenced)).toEqual(cannedGraph);
  });

  it("parses prose-wrapped JSON", () => {
    const prose =
      "Sure! Here is the test plan graph as a DAG:\n" +
      JSON.stringify(cannedGraph) +
      "\nLet me know if you need any changes.";
    expect(extractJson(prose)).toEqual(cannedGraph);
  });

  it("throws TypeError with a specific message when no JSON object is present", () => {
    expect(() => extractJson("I cannot produce a graph right now.")).toThrow(
      expect.objectContaining({ name: "TypeError" }),
    );
    expect(() => extractJson("I cannot produce a graph right now.")).toThrow(/no JSON object/);
  });

  it("throws TypeError on malformed JSON", () => {
    expect(() => extractJson('{ "cases": [ }')).toThrow(/malformed JSON/);
  });

  it("throws TypeError when the top level is not an object with a cases array", () => {
    expect(() => extractJson('{"foo": 1}')).toThrow(/"cases" must be an array/);
    // No braces at all: caught earlier by the concrete "no JSON object" check.
    expect(() => extractJson('[1, 2, 3]')).toThrow(/no JSON object/);
  });

  it("throws TypeError for unknown action discriminants", () => {
    const text =
      '{"cases":[{"id":"a","name":"A","dependsOn":[],"actions":[{"type":"hop"}]}]}';
    expect(() => extractJson(text)).toThrow(/"type" must be one of/);
  });

  it("throws TypeError for actions missing required fields", () => {
    // click without selector
    const missingSelector =
      '{"cases":[{"id":"a","name":"A","dependsOn":[],"actions":[{"type":"click"}]}]}';
    expect(() => extractJson(missingSelector)).toThrow(/missing required field "selector"/);
    // fill without value
    const missingValue =
      '{"cases":[{"id":"a","name":"A","dependsOn":[],"actions":[{"type":"fill","selector":"#x"}]}]}';
    expect(() => extractJson(missingValue)).toThrow(/missing required field "value"/);
    // wait without ms
    const missingMs =
      '{"cases":[{"id":"a","name":"A","dependsOn":[],"actions":[{"type":"wait"}]}]}';
    expect(() => extractJson(missingMs)).toThrow(/missing required field "ms"/);
  });

  it("throws TypeError for malformed case shapes", () => {
    const badId = '{"cases":[{"id":42,"name":"A","dependsOn":[],"actions":[]}]}';
    expect(() => extractJson(badId)).toThrow(/"id" must be a non-empty string/);
    const badDeps = '{"cases":[{"id":"a","name":"A","dependsOn":"b","actions":[]}]}';
    expect(() => extractJson(badDeps)).toThrow(/"dependsOn" must be an array of strings/);
    const badActions = '{"cases":[{"id":"a","name":"A","dependsOn":[],"actions":"goto"}]}';
    expect(() => extractJson(badActions)).toThrow(/"actions" must be an array/);
  });
});

describe("createOpenAiAgent with a custom OpenAI-compatible endpoint", () => {
  interface CapturedRequest {
    path: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
  }

  let server: http.Server | null = null;
  let baseUrl: string;
  // Mutable object property so TypeScript doesn't narrow it to `null` across awaits.
  const captured: { request: CapturedRequest | null } = { request: null };

  afterAll(async () => {
    if (!server) return;
    const s = server;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("POSTs to {baseUrl}/chat/completions and parses the canned TestPlanGraph", async () => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        captured.request = {
          path: req.url ?? "",
          authorization: req.headers.authorization,
          body: JSON.parse(raw),
        };
        // Standard chat.completions response shape with the canned graph as
        // choices[0].message.content.
        const reply = {
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(cannedGraph) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    server = srv;
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;

    const agent = createOpenAiAgent({ baseUrl, apiKey: "test" });
    const graph = await agent.run("# plan");

    expect(graph).toEqual(cannedGraph);
    expect(captured.request?.path).toBe("/v1/chat/completions");
    expect(captured.request?.authorization).toBe("Bearer test");
    expect(captured.request?.body.model).toBe("gpt-4o-mini");
    // The Agents SDK sends plain text output (no response_format) so that
    // arbitrary OpenAI-compatible endpoints keep working; extractJson
    // tolerates prose or code fences around the JSON object.
    expect(captured.request?.body.response_format).toBeUndefined();
    const messages = captured.request?.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("JSON");
    expect(messages[1]).toEqual({ role: "user", content: "# plan" });
  });

  it("falls back to OPENAI_API_KEY / OPENAI_BASE_URL env vars when options are omitted", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    const prevBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "env-key";
    process.env.OPENAI_BASE_URL = baseUrl;
    try {
      captured.request = null;
      const agent = createOpenAiAgent(); // no options: env fallbacks must apply
      const graph = await agent.run("plan via env");
      expect(graph).toEqual(cannedGraph);
      const req = captured.request as CapturedRequest | null; // reset narrowing from the null assignment above
      expect(req?.path).toBe("/v1/chat/completions");
      expect(req?.authorization).toBe("Bearer env-key");
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (prevBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevBase;
    }
  });

  it("handles fenced JSON in choices[0].message.content", async () => {
    // A second server whose model wraps the graph in a code fence, proving
    // extractJson strips fences on the real request path.
    const fencedServer = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const reply = {
          id: "chatcmpl-fenced",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Here you go:\n```json\n" + JSON.stringify(cannedGraph) + "\n```",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => fencedServer.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = fencedServer.address() as AddressInfo;
      const agent = createOpenAiAgent({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test" });
      const graph = await agent.run("# plan");
      expect(graph).toEqual(cannedGraph);
    } finally {
      fencedServer.closeAllConnections?.();
      await new Promise<void>((resolve) => fencedServer.close(() => resolve()));
    }
  });
});
