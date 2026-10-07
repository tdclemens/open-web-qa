import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runGraph } from "../src/executor/runner";
import type { TestPlanGraph } from "../src/graph/types";

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
