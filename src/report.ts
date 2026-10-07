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
 * Format a RunReport as a plain-text console summary.
 *
 * Layout (lines joined with "\n", no trailing newline):
 * - One line per case, in report order:
 *     `<PASS|FAIL|SKIP> <id> <name> (<durationMs>ms)`
 *   For failed cases, the error message (if any) is appended as
 *   `error: <message>`, followed by ` | screenshot: <path>` when a
 *   screenshot path is present.
 * - A final summary line:
 *     `Total <n> | passed <x> | failed <y> | skipped <z> | elapsed <s>s`
 *   where `<s>` is the total elapsed seconds (finishedAtMs - startedAtMs,
 *   two decimal places).
 */
export function formatReport(report: RunReport): string {
  const lines = report.results.map((r) => {
    let line = `${statusLabel(r.status)} ${r.id} ${r.name} (${r.durationMs}ms)`;
    if (r.status === "failed") {
      if (r.error !== undefined) {
        line += ` error: ${singleLine(r.error)}`;
      }
      if (r.screenshotPath !== undefined) {
        line += ` | screenshot: ${singleLine(r.screenshotPath)}`;
      }
    }
    return line;
  });

  const passed = report.results.filter((r) => r.status === "passed").length;
  const failed = report.results.filter((r) => r.status === "failed").length;
  const skipped = report.results.filter((r) => r.status === "skipped").length;
  const elapsedSecs = (report.finishedAtMs - report.startedAtMs) / 1000;

  lines.push(
    `Total ${report.results.length} | passed ${passed} | failed ${failed} | skipped ${skipped} | elapsed ${elapsedSecs.toFixed(2)}s`
  );

  return lines.join("\n");
}

/**
 * Exit code for the CLI process: 1 if any case result has status
 * "failed", otherwise 0 (skipped cases do not affect the exit code).
 */
export function exitCodeFor(report: RunReport): number {
  return report.results.some((r) => r.status === "failed") ? 1 : 0;
}
