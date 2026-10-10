import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createDeepAgent } from "../src/agent/deep";
import {
  PlanningFeedback,
  formatBytes,
  formatElapsed,
  summarizeToolResult,
  type FeedbackStream,
} from "../src/agent/feedback";
import type { TestPlanGraph } from "../src/graph/types";

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

/** Capturing stream stand-in for process.stderr. */
function fakeStream(opts: { tty?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = [];
  const stream: FeedbackStream = {
    isTTY: opts.tty,
    columns: opts.columns,
    rows: opts.rows,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  };
  return { stream, output: () => chunks.join("") };
}

describe("summarizeToolResult", () => {
  it("summarizes list_dir results with the entry count", () => {
    const listing = "Directory: .\n  [dir ] src\n  [file] index.html (58 bytes)";
    const s = summarizeToolResult("list_dir", listing);
    expect(s.ok).toBe(true);
    expect(s.detail).toMatch(/^2 entries, .+$/);

    const one = summarizeToolResult("list_dir", "Directory: .\n  [file] a.txt (5 bytes)");
    expect(one.detail).toMatch(/^1 entry, /);

    const empty = summarizeToolResult("list_dir", "Directory: .\n  (empty)");
    expect(empty.detail).toMatch(/^empty, /);

    const truncated =
      "Directory: .\n  [file] a.txt (5 bytes)\n  ... (truncated: showing 200 of 512 entries)";
    expect(summarizeToolResult("list_dir", truncated).detail).toContain("(truncated)");
  });

  it("summarizes read_file results with the size shown", () => {
    expect(summarizeToolResult("read_file", "File: a.txt (2048 bytes)\nhello")).toEqual({
      ok: true,
      detail: "2 KB",
    });
    expect(
      summarizeToolResult(
        "read_file",
        "File: big.txt (200000 bytes) [showing first 65536 of 200000 bytes]\n...",
      ),
    ).toEqual({ ok: true, detail: "64 KB of 195.3 KB" });
    expect(summarizeToolResult("read_file", "File: bin.dat (4 bytes)\n[binary file; content not shown]")).toEqual({
      ok: true,
      detail: "binary, 4 B",
    });
  });

  it("flags error results", () => {
    const s = summarizeToolResult("read_file", "error: no such file or directory: missing.txt");
    expect(s.ok).toBe(false);
    expect(s.detail).toBe("no such file or directory: missing.txt");
    // Long error details are clipped from the front, keeping the tail.
    const long = summarizeToolResult(
      "read_file",
      "error: " + "x".repeat(200),
    );
    expect(long.detail.length).toBeLessThanOrEqual(70);
    expect(long.detail.startsWith("…")).toBe(true);
  });

  it("summarizes explore subagent reports by size", () => {
    const report = summarizeToolResult(
      "explore",
      "explore subagent report:\n- button: #submit-btn (src/app.ts)",
    );
    expect(report.ok).toBe(true);
    expect(report.detail).toMatch(/^report, \d+(\.\d+)? (B|KB|MB)$/);

    // A truncated report still summarizes as the size the planner received.
    const big = summarizeToolResult(
      "explore",
      `explore subagent report:\n${"y".repeat(20 * 1024)}\n[report truncated: showing first 16384 of 20480 bytes]`,
    );
    expect(big.ok).toBe(true);
    expect(big.detail).toBe("report, 20.1 KB");
  });
});

describe("formatBytes / formatElapsed", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(65536)).toBe("64 KB");
    expect(formatBytes(200000)).toBe("195.3 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(11999)).toBe("12s");
    expect(formatElapsed(61000)).toBe("1m 01s");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("PlanningFeedback (plain mode, non-TTY)", () => {
  it("prints tool lines on completion and a summary line, with no ANSI", () => {
    const { stream, output } = fakeStream();
    const fb = new PlanningFeedback({ stream });
    expect(fb.isAnimated).toBe(false);

    fb.start();
    expect(output()).toBe("");

    const h1 = fb.toolStart("list_dir", ".");
    expect(output()).toBe(""); // plain mode: nothing until the tool completes
    h1.end("Directory: .\n  [dir ] src\n  [file] index.html (58 bytes)");

    const h2 = fb.toolStart("read_file", ".env");
    h2.end('error: .env is on the ignore list (segment ".env") and cannot be explored');

    fb.finish();
    const lines = output().trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("✓ list_dir . —");
    expect(lines[0]).toContain("2 entries");
    expect(lines[1]).toContain("✗ read_file .env —");
    expect(lines[1]).toContain("ignore list");
    expect(lines[2]).toMatch(/^✓ plan compiled in \d+s$/);
    expect(output()).not.toContain("\x1b");
  });

  it("prints a failure summary line on fail()", () => {
    const { stream, output } = fakeStream();
    const fb = new PlanningFeedback({ stream });
    fb.start();
    fb.fail();
    expect(output().trim()).toMatch(/^✗ planning failed in \d+s$/);
  });

  it("ignores events outside a start/finish window", () => {
    const { stream, output } = fakeStream();
    const fb = new PlanningFeedback({ stream });
    const late = fb.toolStart("list_dir", ".");
    late.end("Directory: .\n  (empty)");
    expect(output()).toBe("");
    fb.start();
    fb.finish();
    expect(output().trim()).toMatch(/^✓ plan compiled in \d+s$/);
  });
});

describe("PlanningFeedback (animation gating)", () => {
  it("animates by default on a TTY with a known size", () => {
    const { stream } = fakeStream({ tty: true, columns: 80, rows: 24 });
    expect(new PlanningFeedback({ stream }).isAnimated).toBe(true);
  });

  it("stays plain when the TTY reports no size (in-place redraw can't be verified)", () => {
    const { stream } = fakeStream({ tty: true }); // no columns/rows
    expect(new PlanningFeedback({ stream }).isAnimated).toBe(false);
  });

  it("stays plain when the TTY is too narrow to show a useful label", () => {
    const { stream } = fakeStream({ tty: true, columns: 20, rows: 24 });
    expect(new PlanningFeedback({ stream }).isAnimated).toBe(false);
  });

  it("honors animate: false (CLI --no-anim) even on a full TTY", () => {
    const { stream, output } = fakeStream({ tty: true, columns: 80, rows: 24 });
    const fb = new PlanningFeedback({ stream, animate: false });
    expect(fb.isAnimated).toBe(false);
    fb.start();
    fb.finish();
    // plain summary line: no CR, no spinner, no ANSI
    expect(output()).toMatch(/^✓ plan compiled in \d+s\n$/);
    expect(output()).not.toContain("\r");
    expect(output()).not.toContain("\x1b");
  });
});

describe("PlanningFeedback (animated mode, TTY)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("animates the planning line and finalizes tool lines in place", () => {
    vi.useFakeTimers();
    const { stream, output } = fakeStream({ tty: true, columns: 100, rows: 40 });
    const fb = new PlanningFeedback({ stream, intervalMs: 80 });
    expect(fb.isAnimated).toBe(true);

    fb.start();
    expect(output()).toContain("⠋ planning… 0s"); // frame 0, no trailing newline

    vi.advanceTimersByTime(160); // two frames -> frame 2
    const afterTick = output();
    expect(afterTick).toContain("\r"); // each redraw returns to column 0
    expect(afterTick).toContain("⠹ planning… 0s"); // planning line redrawn in place

    const h = fb.toolStart("list_dir", ".");
    expect(output()).toMatch(/⠹ list_dir \.…/); // tool line appears with a spinner
    const h2 = fb.toolStart("read_file", "src/app.ts"); // block grows to 3 lines
    expect(output()).toContain("\x1b[1A"); // cursor moves back to the block top
    vi.advanceTimersByTime(80);
    h.end("Directory: .\n  [dir ] src\n  [file] index.html (58 bytes)");
    h2.end("File: src/app.ts (2048 bytes)\nhello");
    const afterEnd = output();
    expect(afterEnd).toContain("✓ list_dir . —"); // finalized in place
    expect(afterEnd).toContain("2 entries");
    expect(afterEnd).toContain("✓ read_file src/app.ts — 2 KB");

    fb.finish();
    const finalOut = output();
    expect(finalOut.endsWith("\n")).toBe(true); // ready for the next CLI output
    expect(finalOut).toContain("✓ plan compiled in 0s");
  });

  it("redraws the single planning line in place without drift or ghost lines", () => {
    vi.useFakeTimers();
    const { stream, output } = fakeStream({ tty: true, columns: 80, rows: 24 });
    const fb = new PlanningFeedback({ stream, intervalMs: 80 });
    fb.start();
    vi.advanceTimersByTime(80 * 30); // 30 frames over ~2.4s
    const out = output();
    // Only CUU (n>0), CR and LF are allowed on the wire: no 0-param CUU
    // (some terminals read it as "up 1"), no EL (\x1b[2K) or CHA (\x1b[1G)
    // (terminals without them drop the sequence and the block drifts).
    expect(out).not.toContain("\x1b[0A");
    expect(out).not.toContain("\x1b[2K");
    expect(out).not.toContain("\x1b[1G");
    expect(out).toContain("\r");
    // Spec-compliant replay: exactly one visible line, starting in column 0
    // — no mid-line drift, no wrapped fragments, no leftover frames.
    expect(visibleLines(out, { cols: 80, rows: 24 }).filter((l) => l !== ""))
      .toEqual(["⠋ planning… 2s"]);
    // Even a terminal that silently drops EL and CHA still renders one clean
    // line, because stale tails are overwritten with spaces and \r resets
    // the column.
    expect(
      visibleLines(out, { cols: 80, rows: 24, ignoreFinal: ["K", "G"] }).filter((l) => l !== ""),
    ).toEqual(["⠋ planning… 2s"]);
    fb.finish();
    const finalScreen = visibleLines(output(), { cols: 80, rows: 24 });
    expect(finalScreen.filter((l) => l !== "")).toEqual(["✓ plan compiled in 2s"]);
  });

  it("clips lines to the terminal width", () => {
    vi.useFakeTimers();
    const longTarget = "a/".repeat(30) + "very-long-file-name-that-never-fits.txt";
    const { stream, output } = fakeStream({ tty: true, columns: 50, rows: 40 });
    const fb = new PlanningFeedback({ stream });
    fb.start();
    const h = fb.toolStart("read_file", longTarget);
    for (const line of visibleLines(output())) {
      expect(line.length).toBeLessThanOrEqual(50);
    }
    h.end("File: x (5 bytes)\ny");
    fb.finish();
    for (const line of visibleLines(output())) {
      expect(line.length).toBeLessThanOrEqual(50);
    }
  });

  it("degrades to plain mode when the block outgrows the terminal", () => {
    vi.useFakeTimers();
    const { stream, output } = fakeStream({ tty: true, columns: 80, rows: 2 });
    const fb = new PlanningFeedback({ stream });
    fb.start();
    const h1 = fb.toolStart("list_dir", "one");
    const h2 = fb.toolStart("list_dir", "two"); // 3rd line > 2 rows -> degrade
    const h3 = fb.toolStart("list_dir", "three");
    expect(fb.isAnimated).toBe(false);
    h2.end("Directory: two\n  (empty)"); // plain line from now on
    h3.end("Directory: three\n  (empty)");
    fb.finish();
    const out = output();
    expect(out).toContain("✓ list_dir two — empty");
    expect(out).toContain("✓ list_dir three — empty");
    expect(out.trim().endsWith("✓ plan compiled in 0s")).toBe(true);
    h1.end("Directory: one\n  (empty)"); // late completion after finish: no-op
    expect(output()).toBe(out);
  });
});

describe("PlanningFeedback + deep agent wiring", () => {
  it("shows deep-agent tool calls inline through the feedback handle", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openwebqa-fb-"));
    await fs.promises.writeFile(
      path.join(dir, "index.html"),
      "<html><body><h1 id=title>Hello</h1></body></html>\n",
    );
    const { url, stop } = await startMockServer();
    try {
      const { stream, output } = fakeStream(); // plain (non-TTY) for determinism
      const fb = new PlanningFeedback({ stream, label: "compiling plan with test-model" });
      const agent = createDeepAgent({ baseUrl: url, apiKey: "test", rootDir: dir, feedback: fb });
      fb.start();
      let graph: TestPlanGraph;
      try {
        graph = await agent.run("# smoke plan");
      } finally {
        fb.finish();
      }
      expect(graph).toEqual(cannedGraph);
      const lines = output().replace(/\n$/, "").split("\n");
      expect(lines.some((l) => l.startsWith("  ✓ list_dir . —"))).toBe(true);
      expect(lines[lines.length - 1]).toMatch(/^✓ plan compiled in /);
    } finally {
      await stop();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Replay a captured output buffer on a simulated terminal grid and return
 * the visible lines. Models the cursor's column (CR returns to column 0,
 * \x1b[nA moves up n lines keeping the column, text wraps and the screen
 * scrolls) — exactly the behavior in-place redraw depends on. `ignoreFinal`
 * emulates a terminal that silently drops the listed CSI final bytes (e.g.
 * a terminal without EL/CHA support).
 */
function visibleLines(
  out: string,
  opts: { cols?: number; rows?: number; ignoreFinal?: string[] } = {},
): string[] {
  const cols = opts.cols ?? 1000;
  const rows = opts.rows ?? 1000;
  const ignored = new Set(opts.ignoreFinal ?? []);
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let r = 0;
  let c = 0;
  const scroll = () => {
    grid.shift();
    grid.push(Array<string>(cols).fill(" "));
    if (r > 0) r--;
  };
  const put = (ch: string) => {
    if (c >= cols) {
      r++;
      c = 0;
      if (r >= rows) scroll();
    }
    grid[r][c] = ch;
    c++;
  };
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === "\x1b") {
      // ESC itself is matched by the string comparison above (no-control-regex
      // forbids it in the pattern); the rest of the CSI sequence is matched here.
      const m = /^\[(\d*)([A-Z])/.exec(out.slice(i + 1));
      if (!m) {
        i++;
        continue;
      }
      if (ignored.has(m[2])) {
        i += 1 + m[0].length; // dropped by the terminal (ESC + sequence)
        continue;
      }
      const p = m[1] === "" ? 1 : parseInt(m[1], 10);
      if (m[2] === "A") r = Math.max(0, r - p); // 0 => no-op, column preserved
      else if (m[2] === "K") for (let x = c; x < cols; x++) grid[r][x] = " ";
      else if (m[2] === "G") c = Math.max(0, p - 1);
      i += 1 + m[0].length; // skip ESC + sequence
      continue;
    }
    if (ch === "\n") {
      r++;
      c = 0;
      if (r >= rows) scroll();
    } else if (ch === "\r") {
      c = 0;
    } else {
      put(ch);
    }
    i++;
  }
  return grid.map((l) => l.join("").replace(/\s+$/, ""));
}

/** Minimal OpenAI-compatible mock: one list_dir round, then the canned graph. */
async function startMockServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  let seenToolResult = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role: string }>;
      };
      if (!seenToolResult && (body.messages ?? []).some((m) => m.role === "tool")) {
        seenToolResult = true;
      }
      const message = seenToolResult
        ? { role: "assistant", content: JSON.stringify(cannedGraph) }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call-1", type: "function", function: { name: "list_dir", arguments: "{}" } },
            ],
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fb",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message,
              finish_reason: seenToolResult ? "stop" : "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
