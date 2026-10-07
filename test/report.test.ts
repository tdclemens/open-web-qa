import { describe, expect, it } from "vitest";
import { exitCodeFor, formatReport } from "../src/report";
import type { CaseResult, RunReport } from "../src/graph/types";

function makeResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    id: "c1",
    name: "Case One",
    status: "passed",
    durationMs: 123,
    ...overrides,
  };
}

function makeReport(
  results: CaseResult[],
  startedAtMs = 0,
  finishedAtMs = 2500
): RunReport {
  return { results, startedAtMs, finishedAtMs };
}

describe("formatReport", () => {
  it("prints one line per case plus the summary line for an all-pass report", () => {
    const report = makeReport(
      [
        makeResult({ id: "c1", name: "Login", durationMs: 120 }),
        makeResult({ id: "c2", name: "Checkout", durationMs: 340 }),
      ],
      0,
      2500
    );
    expect(formatReport(report)).toBe(
      [
        "PASS c1 Login (120ms)",
        "PASS c2 Checkout (340ms)",
        "Total 2 | passed 2 | failed 0 | skipped 0 | elapsed 2.50s",
      ].join("\n")
    );
  });

  it("computes correct summary counts for mixed results", () => {
    const report = makeReport(
      [
        makeResult({ id: "c1", name: "A" }),
        makeResult({ id: "c2", name: "B", status: "failed", error: "boom" }),
        makeResult({ id: "c3", name: "C", status: "skipped", durationMs: 0 }),
        makeResult({ id: "c4", name: "D" }),
      ],
      1000,
      9500
    );
    const lines = formatReport(report).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("PASS c1 A (123ms)");
    expect(lines[1]).toContain("FAIL c2 B");
    expect(lines[2]).toBe("SKIP c3 C (0ms)");
    expect(lines[3]).toBe("PASS c4 D (123ms)");
    expect(lines[4]).toBe(
      "Total 4 | passed 2 | failed 1 | skipped 1 | elapsed 8.50s"
    );
  });

  it("appends the error message and screenshot path on failure", () => {
    const report = makeReport([
      makeResult({
        id: "c2",
        name: "Checkout",
        status: "failed",
        durationMs: 456,
        error: "Timeout 30000ms exceeded",
        screenshotPath: "/tmp/shots/c2.png",
      }),
    ]);
    const out = formatReport(report);
    expect(out).toContain("FAIL c2 Checkout (456ms)");
    expect(out).toContain("error: Timeout 30000ms exceeded");
    expect(out).toContain("screenshot: /tmp/shots/c2.png");
  });

  it("keeps a failed case on a single line when the error spans lines", () => {
    const report = makeReport([
      makeResult({
        id: "c1",
        name: "A",
        status: "failed",
        error: "line one\nline two",
      }),
    ]);
    expect(formatReport(report).split("\n")).toHaveLength(2);
    expect(formatReport(report)).toContain("error: line one line two");
  });

  it("omits error/screenshot details for passing and skipped cases", () => {
    const report = makeReport([
      makeResult({ id: "c1", name: "A", screenshotPath: "/tmp/a.png" }),
      makeResult({
        id: "c2",
        name: "B",
        status: "skipped",
        error: "ignored",
        screenshotPath: "/tmp/b.png",
      }),
    ]);
    const out = formatReport(report);
    expect(out).not.toContain("error:");
    expect(out).not.toContain("screenshot:");
  });

  it("prints a summary line for an empty report", () => {
    expect(formatReport(makeReport([], 5, 5))).toBe(
      "Total 0 | passed 0 | failed 0 | skipped 0 | elapsed 0.00s"
    );
  });
});

describe("exitCodeFor", () => {
  it("returns 0 for an all-pass report", () => {
    const report = makeReport([
      makeResult({ id: "c1" }),
      makeResult({ id: "c2", name: "B" }),
    ]);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("returns 0 when only passed and skipped results are present", () => {
    const report = makeReport([
      makeResult({ id: "c1" }),
      makeResult({ id: "c2", name: "B", status: "skipped" }),
    ]);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("returns 1 when one case failed", () => {
    const report = makeReport([
      makeResult({ id: "c1" }),
      makeResult({
        id: "c2",
        name: "B",
        status: "failed",
        error: "boom",
      }),
      makeResult({ id: "c3", name: "C", status: "skipped" }),
    ]);
    expect(exitCodeFor(report)).toBe(1);
    expect(formatReport(report)).toContain("error: boom");
  });

  it("returns 0 for an empty report", () => {
    expect(exitCodeFor(makeReport([]))).toBe(0);
  });
});
