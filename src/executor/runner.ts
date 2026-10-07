// DAG executor: runs a TestPlanGraph with headless Playwright.
//
// Scheduling model (dependency-driven):
// - A case becomes eligible to start once every id in `dependsOn` has settled
//   (reached a terminal status).
// - If all of its dependencies passed, the case runs in a fresh browser
//   context; if any dependency failed or was skipped, the case is marked
//   'skipped' without doing any browser work (cascade), and its dependents
//   are re-evaluated immediately.
// - A semaphore caps the number of concurrently-running cases at
//   `options.workers`; ready cases wait in a FIFO queue for a free slot.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { CaseResult, RunReport, TestCase, TestPlanGraph } from "../graph/types";
import { computeLevels } from "../graph/topo";
import { executeAction } from "./actions";

export interface RunnerOptions {
  /** Maximum number of test cases executing at the same time. Default: 4. */
  workers?: number;
  /** Launch Chromium in headless mode. Default: true. */
  headless?: boolean;
  /** Default per-case timeout in milliseconds (overridable per case via `timeoutMs`). Default: 30000. */
  timeoutMs?: number;
  /** Directory for failure screenshots, saved as `<resultsDir>/<caseId>.png`. Default: 'openwebqa-results'. */
  resultsDir?: string;
}

type InternalStatus = "pending" | "running" | "passed" | "failed" | "skipped";

/**
 * Execute a test plan graph with headless Playwright.
 *
 * Cases run as soon as all of their `dependsOn` have passed, up to
 * `options.workers` cases in parallel. A case whose dependency failed or was
 * skipped is itself marked 'skipped' (cascade). Each case runs in its own
 * browser context with a per-case timeout (`case.timeoutMs ??
 * options.timeoutMs`). On failure the case's error message is recorded and a
 * screenshot is saved to `<resultsDir>/<caseId>.png`.
 *
 * @throws Error('circular dependency detected') if the graph is not a DAG
 *   (checked before any browser is launched).
 */
export async function runGraph(graph: TestPlanGraph, options: RunnerOptions = {}): Promise<RunReport> {
  const workers = options.workers ?? 4;
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 30000;
  const resultsDir = options.resultsDir ?? "openwebqa-results";

  fs.mkdirSync(resultsDir, { recursive: true });

  // Validate acyclicity before launching a browser (throws on a cycle).
  computeLevels(graph);

  const caseById = new Map<string, TestCase>(graph.cases.map((c) => [c.id, c]));
  const dependents = new Map<string, string[]>();
  for (const c of graph.cases) dependents.set(c.id, []);
  for (const c of graph.cases) {
    for (const dep of c.dependsOn) {
      // Defensive: a validated graph only references existing ids.
      if (dependents.has(dep)) dependents.get(dep)!.push(c.id);
    }
  }

  const total = graph.cases.length;
  const startedAtMs = Date.now();
  const statusById = new Map<string, InternalStatus>();
  const remainingDeps = new Map<string, number>();
  const resultsById = new Map<string, CaseResult>();
  for (const c of graph.cases) {
    statusById.set(c.id, "pending");
    remainingDeps.set(c.id, c.dependsOn.filter((d) => caseById.has(d)).length);
  }

  let running = 0;
  let settledCount = 0;
  let resolveAllSettled!: () => void;
  const allSettled = new Promise<void>((resolve) => {
    resolveAllSettled = resolve;
  });
  if (total === 0) resolveAllSettled();

  const settle = (id: string, result: CaseResult): void => {
    statusById.set(id, result.status);
    resultsById.set(id, result);
    settledCount += 1;
    if (settledCount >= total) resolveAllSettled();
  };

  const browser = await chromium.launch({ headless });
  try {
    const waiting: string[] = []; // ready cases waiting for a free worker slot

    /** Run one case in a fresh context; never throws (returns a failed result instead). */
    const launchCase = async (tc: TestCase): Promise<CaseResult> => {
      const caseStart = Date.now();
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const caseTimeout = tc.timeoutMs ?? timeoutMs;
        page.setDefaultTimeout(caseTimeout);
        page.setDefaultNavigationTimeout(caseTimeout);
        try {
          for (const action of tc.actions) {
            await executeAction(page, action);
          }
          return { id: tc.id, name: tc.name, status: "passed", durationMs: Date.now() - caseStart };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          let screenshotPath: string | undefined;
          try {
            screenshotPath = path.join(resultsDir, `${tc.id}.png`);
            await page.screenshot({ path: screenshotPath });
          } catch {
            screenshotPath = undefined; // page may be unusable; keep the error only
          }
          const result: CaseResult = {
            id: tc.id,
            name: tc.name,
            status: "failed",
            durationMs: Date.now() - caseStart,
            error: message,
          };
          if (screenshotPath !== undefined) result.screenshotPath = screenshotPath;
          return result;
        }
      } finally {
        await context.close().catch(() => undefined);
      }
    };

    const onDepSettled = (id: string): void => {
      for (const depId of dependents.get(id) ?? []) {
        if (statusById.get(depId) !== "pending") continue;
        remainingDeps.set(depId, (remainingDeps.get(depId) ?? 0) - 1);
        if ((remainingDeps.get(depId) ?? 0) > 0) continue;
        const tc = caseById.get(depId)!;
        const depDidNotPass = tc.dependsOn.some(
          (d) => caseById.has(d) && statusById.get(d) !== "passed"
        );
        if (depDidNotPass) {
          // Cascade skip: no browser work is needed.
          settle(depId, {
            id: depId,
            name: tc.name,
            status: "skipped",
            durationMs: 0,
            error: `skipped: dependency did not pass (case '${id}')`,
          });
          onDepSettled(depId);
        } else if (running < workers) {
          void runCase(depId);
        } else {
          waiting.push(depId);
        }
      }
    };

    const runCase = async (id: string): Promise<void> => {
      const tc = caseById.get(id)!;
      const startedAt = Date.now();
      statusById.set(id, "running");
      running += 1;
      try {
        let result: CaseResult;
        try {
          result = await launchCase(tc);
        } catch (err) {
          // Context/page creation failed; record the failure anyway.
          result = {
            id: tc.id,
            name: tc.name,
            status: "failed",
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        settle(id, result);
      } finally {
        running -= 1;
        // Hand the freed worker slot to the next waiting case.
        const next = waiting.shift();
        if (next !== undefined) void runCase(next);
        onDepSettled(id);
      }
    };

    // Kick off every case with no dependencies (in input order).
    for (const tc of graph.cases) {
      if ((remainingDeps.get(tc.id) ?? 0) === 0) {
        if (running < workers) void runCase(tc.id);
        else waiting.push(tc.id);
      }
    }

    await allSettled;
  } finally {
    await browser.close();
  }

  // Report results in the original input order.
  const results = graph.cases.map((c) => resultsById.get(c.id)!);
  return { results, startedAtMs, finishedAtMs: Date.now() };
}
