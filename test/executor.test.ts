import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runGraph } from "../src/executor/runner";
import type { CaseResult, TestPlanGraph } from "../src/graph/types";

// In this container Chromium's shared libraries live in a user-writable
// prefix rather than system directories; make them resolvable before any
// browser is launched. No-op on systems where the libraries are installed.
const localLibDir = path.join(os.homedir(), "pw-libs", "usr", "lib", "x86_64-linux-gnu");
if (fs.existsSync(localLibDir)) {
  process.env.LD_LIBRARY_PATH = [process.env.LD_LIBRARY_PATH, localLibDir].filter(Boolean).join(":");
}

const html = `<!doctype html>
<html>
  <head><title>openwebqa fixture</title></head>
  <body>
    <input id="email" />
    <button id="go">Go</button>
    <div id="out">idle</div>
    <script>
      document.getElementById("go").addEventListener("click", function () {
        var email = document.getElementById("email").value;
        document.getElementById("out").textContent = email ? "sent:" + email : "sent:empty";
      });
    </script>
  </body>
</html>`;

let pageUrl: string;
let resultsDir: string;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwebqa-exec-"));
  const file = path.join(dir, "fixture.html");
  fs.writeFileSync(file, html);
  pageUrl = pathToFileURL(file).href;
  resultsDir = path.join(dir, "results");
});

describe("runGraph", () => {
  it("runs parallel and dependent cases, screenshots the failed one", async () => {
    const graph: TestPlanGraph = {
      cases: [
        {
          id: "case-a",
          name: "parallel case a",
          dependsOn: [],
          actions: [
            { type: "goto", url: pageUrl },
            { type: "fill", selector: "#email", value: "a@example.com" },
            { type: "click", selector: "#go" },
            { type: "assertText", selector: "#out", text: "sent:a@example.com" },
          ],
        },
        {
          id: "case-b",
          name: "parallel case b",
          dependsOn: [],
          actions: [
            { type: "goto", url: pageUrl },
            { type: "fill", selector: "#email", value: "b@example.com" },
            { type: "click", selector: "#go" },
            { type: "assertText", selector: "#out", text: "sent:b@example.com" },
          ],
        },
        {
          id: "case-c",
          name: "dependent case c",
          dependsOn: ["case-a", "case-b"],
          actions: [
            { type: "goto", url: pageUrl },
            { type: "fill", selector: "#email", value: "c@example.com" },
            { type: "click", selector: "#go" },
            { type: "assertText", selector: "#out", text: "sent:c@example.com" },
          ],
        },
        {
          id: "case-d",
          name: "bad selector case",
          dependsOn: [],
          timeoutMs: 1500,
          actions: [
            { type: "goto", url: pageUrl },
            { type: "click", selector: "#no-such-element" },
          ],
        },
      ],
    };

    const report = await runGraph(graph, {
      workers: 2,
      headless: true,
      timeoutMs: 10000,
      resultsDir,
    });

    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(report.results).toHaveLength(4);
    expect(byId.get("case-a")?.status).toBe("passed");
    expect(byId.get("case-b")?.status).toBe("passed");
    expect(byId.get("case-c")?.status).toBe("passed");
    expect(byId.get("case-a")?.error).toBeUndefined();
    expect(byId.get("case-b")?.error).toBeUndefined();
    expect(byId.get("case-c")?.error).toBeUndefined();

    const d = byId.get("case-d")!;
    expect(d.status).toBe("failed");
    expect(d.error).toBeTruthy();
    expect(d.screenshotPath).toBe(path.join(resultsDir, "case-d.png"));
    expect(fs.existsSync(d.screenshotPath!)).toBe(true);

    expect(report.finishedAtMs).toBeGreaterThanOrEqual(report.startedAtMs);
    for (const r of report.results) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 60000);

  it("skips dependents of failed/skipped cases (cascade)", async () => {
    const graph: TestPlanGraph = {
      cases: [
        {
          id: "fail-first",
          name: "will fail",
          dependsOn: [],
          timeoutMs: 1000,
          actions: [
            { type: "goto", url: pageUrl },
            { type: "click", selector: "#missing" },
          ],
        },
        {
          id: "child",
          name: "depends on failure",
          dependsOn: ["fail-first"],
          actions: [{ type: "goto", url: pageUrl }],
        },
        {
          id: "grandchild",
          name: "depends on skipped",
          dependsOn: ["child"],
          actions: [{ type: "goto", url: pageUrl }],
        },
      ],
    };

    const report = await runGraph(graph, {
      workers: 4,
      headless: true,
      resultsDir: path.join(resultsDir, "cascade"),
    });

    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(report.results).toHaveLength(3);
    expect(byId.get("fail-first")?.status).toBe("failed");
    expect(byId.get("child")?.status).toBe("skipped");
    expect(byId.get("grandchild")?.status).toBe("skipped");
    expect(byId.get("child")?.error).toContain("fail-first");
    expect(byId.get("grandchild")?.error).toContain("child");
    expect(byId.get("child")?.screenshotPath).toBeUndefined();
  }, 60000);

  it("streams results via onCaseSettled as cases settle, before the run resolves", async () => {
    const settled: CaseResult[] = [];
    const settledAtById = new Map<string, number>();
    let resolvedAt = 0;
    const graph: TestPlanGraph = {
      cases: [
        {
          id: "early",
          name: "early case",
          dependsOn: [],
          actions: [{ type: "goto", url: pageUrl }, { type: "wait", ms: 150 }],
        },
        {
          id: "late",
          name: "late case",
          dependsOn: [],
          actions: [{ type: "goto", url: pageUrl }, { type: "wait", ms: 700 }],
        },
      ],
    };

    const report = await runGraph(graph, {
      headless: true,
      resultsDir: path.join(resultsDir, "stream"),
      onCaseSettled: (result) => {
        settled.push(result);
        settledAtById.set(result.id, Date.now());
      },
    });
    resolvedAt = Date.now();

    // One callback per case, in completion order (not input/report order).
    expect(settled.map((r) => r.id)).toEqual(["early", "late"]);
    expect(settled[0]).toBe(report.results[0]);
    expect(settled[1]).toBe(report.results[1]);

    // Liveness: the early case was reported well before the run resolved,
    // i.e. results stream as they happen rather than in one batch at the end.
    expect(resolvedAt - (settledAtById.get("early") ?? 0)).toBeGreaterThanOrEqual(300);
  }, 60000);

  it("reports cascade skips via onCaseSettled as they are decided", async () => {
    const settled: CaseResult[] = [];
    const graph: TestPlanGraph = {
      cases: [
        {
          id: "fail-first",
          name: "will fail",
          dependsOn: [],
          timeoutMs: 1000,
          actions: [{ type: "goto", url: pageUrl }, { type: "click", selector: "#missing" }],
        },
        {
          id: "child",
          name: "depends on failure",
          dependsOn: ["fail-first"],
          actions: [{ type: "goto", url: pageUrl }],
        },
        {
          id: "grandchild",
          name: "depends on skipped",
          dependsOn: ["child"],
          actions: [{ type: "goto", url: pageUrl }],
        },
      ],
    };

    const report = await runGraph(graph, {
      headless: true,
      resultsDir: path.join(resultsDir, "stream-cascade"),
      onCaseSettled: (result) => settled.push(result),
    });

    expect(settled.map((r) => [r.id, r.status])).toEqual([
      ["fail-first", "failed"],
      ["child", "skipped"],
      ["grandchild", "skipped"],
    ]);
    expect(settled[0]).toBe(report.results[0]);
    expect(settled[1]).toBe(report.results[1]);
    expect(settled[2]).toBe(report.results[2]);
  }, 60000);

  it("keeps running when the onCaseSettled callback throws", async () => {
    let calls = 0;
    const report = await runGraph(
      {
        cases: [
          { id: "a", name: "a", dependsOn: [], actions: [{ type: "goto", url: pageUrl }] },
          { id: "b", name: "b", dependsOn: [], actions: [{ type: "goto", url: pageUrl }] },
        ],
      },
      {
        headless: true,
        resultsDir: path.join(resultsDir, "stream-throw"),
        onCaseSettled: () => {
          calls += 1;
          throw new Error("broken reporter");
        },
      }
    );

    expect(calls).toBe(2);
    expect(report.results.map((r) => r.status)).toEqual(["passed", "passed"]);
  }, 60000);

  it("returns an empty report for an empty graph", async () => {
    const report = await runGraph({ cases: [] }, {
      resultsDir: path.join(resultsDir, "empty"),
    });
    expect(report.results).toHaveLength(0);
    expect(report.finishedAtMs).toBeGreaterThanOrEqual(report.startedAtMs);
  });

  it("rejects on circular dependency without running cases", async () => {
    const graph: TestPlanGraph = {
      cases: [
        { id: "x", name: "x", dependsOn: ["y"], actions: [] },
        { id: "y", name: "y", dependsOn: ["x"], actions: [] },
      ],
    };
    await expect(
      runGraph(graph, { resultsDir: path.join(resultsDir, "cyc") })
    ).rejects.toThrow("circular dependency detected");
  });
});
