import type { CaseResult, RunReport } from "./graph/types";

/** Map a result status to its console label. */
function statusLabel(status: CaseResult["status"]): "PASS" | "FAIL" | "SKIP" {
  switch (status) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "skipped":
      return "SKIP";
  }
}

/** Flatten to a single line so each case always occupies exactly one line. */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Format one case result as a single console line:
 *     `<PASS|FAIL|SKIP> <id> <name> (<durationMs>ms)`
 * For failed cases, the error message (if any) is appended as
 * `error: <message>`, followed by ` | screenshot: <path>` when a screenshot
 * path is present. Always exactly one line (multi-line errors are flattened),
 * which keeps streamed per-case output readable.
 */
export function formatCaseLine(result: CaseResult): string {
  let line = `${statusLabel(result.status)} ${result.id} ${result.name} (${result.durationMs}ms)`;
  if (result.status === "failed") {
    if (result.error !== undefined) {
      line += ` error: ${singleLine(result.error)}`;
    }
    if (result.screenshotPath !== undefined) {
      line += ` | screenshot: ${singleLine(result.screenshotPath)}`;
    }
  }
  return line;
}

/**
 * Format the final summary line:
 *     `Total <n> | passed <x> | failed <y> | skipped <z> | elapsed <s>s`
 * where `<s>` is the total elapsed seconds (finishedAtMs - startedAtMs, two
 * decimal places).
 */
export function formatSummary(report: RunReport): string {
  const passed = report.results.filter((r) => r.status === "passed").length;
  const failed = report.results.filter((r) => r.status === "failed").length;
  const skipped = report.results.filter((r) => r.status === "skipped").length;
  const elapsedSecs = (report.finishedAtMs - report.startedAtMs) / 1000;

  return `Total ${report.results.length} | passed ${passed} | failed ${failed} | skipped ${skipped} | elapsed ${elapsedSecs.toFixed(2)}s`;
}

/**
 * Format a RunReport as a plain-text console summary.
 *
 * Layout (lines joined with "\n", no trailing newline): one
 * `formatCaseLine` line per case in report order, followed by the
 * `formatSummary` line. Use for batch output; for live streaming, print
 * `formatCaseLine` per settlement and `formatSummary` at the end.
 */
export function formatReport(report: RunReport): string {
  const lines = report.results.map(formatCaseLine);
  lines.push(formatSummary(report));
  return lines.join("\n");
}

/**
 * Exit code for the CLI process: 1 if any case result has status
 * "failed", otherwise 0 (skipped cases do not affect the exit code).
 */
export function exitCodeFor(report: RunReport): number {
  return report.results.some((r) => r.status === "failed") ? 1 : 0;
}
