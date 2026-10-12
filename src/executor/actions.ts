// Maps OpenWebQA actions to Playwright page calls.
// Plain throws only — no test-framework imports.

import { Page } from "playwright";
import { Action } from "../graph/types";

/**
 * Race a promise against a timeout.
 *
 * If `timeoutMs` is undefined or <= 0 the promise is returned unchanged
 * (0 = no timeout, matching Playwright's own convention). Otherwise the
 * promise is raced against a timer that rejects with a descriptive error
 * after `timeoutMs` milliseconds.
 *
 * The input promise always gets BOTH a fulfill and a reject handler, so a
 * late settlement after we have already resolved/rejected cannot become an
 * unhandled rejection, and the timer is cleared on settle so it cannot fire
 * after the race is decided.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string
): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't keep the event loop alive just for the watchdog timer.
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Execute a single action against the given Playwright page.
 *
 * `timeoutMs` optionally bounds the `evaluate` action: `page.evaluate`
 * ignores Playwright's default timeout in some versions/scenarios and can
 * otherwise hang a run forever. 0 or undefined means no bound.
 *
 * Throws an Error when an assertion fails or when the underlying
 * Playwright call rejects (e.g. selector not found, timeout).
 */
export async function executeAction(
  page: Page,
  action: Action,
  timeoutMs?: number
): Promise<void> {
  switch (action.type) {
    case "goto": {
      await page.goto(action.url);
      break;
    }
    case "click": {
      await page.click(action.selector);
      break;
    }
    case "fill": {
      await page.fill(action.selector, action.value);
      break;
    }
    case "press": {
      await page.keyboard.press(action.key);
      break;
    }
    case "waitForSelector": {
      await page.waitForSelector(action.selector, { timeout: action.timeout });
      break;
    }
    case "wait": {
      await page.waitForTimeout(action.ms);
      break;
    }
    case "screenshot": {
      if (action.path) {
        await page.screenshot({ path: action.path });
      } else {
        await page.screenshot();
      }
      break;
    }
    case "assertUrl": {
      const actual = page.url();
      const ok = action.partial ? actual.includes(action.url) : actual === action.url;
      if (!ok) {
        throw new Error(`URL assertion failed: expected '${action.url}', got '${actual}'`);
      }
      break;
    }
    case "assertText": {
      const actual = await page.locator(action.selector).innerText();
      if (!actual.includes(action.text)) {
        throw new Error(
          `Text assertion failed: expected '${action.text}' in element '${action.selector}', got '${actual}'`
        );
      }
      break;
    }
    case "evaluate": {
      await withTimeout(page.evaluate(action.expression), timeoutMs, "page.evaluate");
      break;
    }
    default: {
      // Exhaustiveness guard: unreachable if all Action discriminants are handled.
      const exhaustive: never = action;
      throw new Error(`Unknown action type: ${(exhaustive as Action).type}`);
    }
  }
}
