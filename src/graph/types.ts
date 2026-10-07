// Shared domain types for OpenWebQA.
// Pure types only — no runtime imports.

// --- Actions ---

/** Navigate the browser to a URL. */
export interface GotoAction {
  type: "goto";
  url: string;
}

/** Click an element matching the CSS selector. */
export interface ClickAction {
  type: "click";
  selector: string;
}

/** Fill a form field matching the CSS selector with the given value. */
export interface FillAction {
  type: "fill";
  selector: string;
  value: string;
}

/** Press a keyboard key (e.g. "Enter"). */
export interface PressAction {
  type: "press";
  key: string;
}

/** Wait until an element matching the CSS selector is present (default timeout applies if omitted). */
export interface WaitForSelectorAction {
  type: "waitForSelector";
  selector: string;
  timeout?: number;
}

/** Wait for a fixed number of milliseconds. */
export interface WaitAction {
  type: "wait";
  ms: number;
}

/** Capture a screenshot; optional target path (otherwise a generated path is used). */
export interface ScreenshotAction {
  type: "screenshot";
  path?: string;
}

/** Assert the current page URL (full, or partial if `partial` is true). */
export interface AssertUrlAction {
  type: "assertUrl";
  url: string;
  partial?: boolean;
}

/** Assert that the element matching the CSS selector contains the given text. */
export interface AssertTextAction {
  type: "assertText";
  selector: string;
  text: string;
}

/** Evaluate a JavaScript expression in the page context. */
export interface EvaluateAction {
  type: "evaluate";
  expression: string;
}

/**
 * A single browser command/action.
 * Discriminated union on `type`.
 *
 * Discriminant strings:
 * "goto" | "click" | "fill" | "press" | "waitForSelector" |
 * "wait" | "screenshot" | "assertUrl" | "assertText" | "evaluate"
 */
export type Action =
  | GotoAction
  | ClickAction
  | FillAction
  | PressAction
  | WaitForSelectorAction
  | WaitAction
  | ScreenshotAction
  | AssertUrlAction
  | AssertTextAction
  | EvaluateAction;

/** All valid action discriminant strings. */
export type ActionType = Action["type"];

// --- Test plan graph ---

/** A single test case: an ordered list of actions plus DAG dependencies. */
export interface TestCase {
  id: string;
  name: string;
  /** IDs of test cases that must complete before this one starts. */
  dependsOn: string[];
  actions: Action[];
  /** Overall timeout for this test case in milliseconds (optional). */
  timeoutMs?: number;
}

/** The directed acyclic graph of test cases returned by the AI agent. */
export interface TestPlanGraph {
  cases: TestCase[];
}

// --- Execution results ---

/** Outcome of a single test case execution. */
export interface CaseResult {
  id: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  screenshotPath?: string;
}

/** Aggregate report for one run of a test plan graph. */
export interface RunReport {
  results: CaseResult[];
  startedAtMs: number;
  finishedAtMs: number;
}
