// Maps OpenWebQA actions to Playwright page calls.
// Plain throws only — no test-framework imports.

import { Page } from "playwright";
import { Action } from "../graph/types";

/**
 * Execute a single action against the given Playwright page.
 *
 * Throws an Error when an assertion fails or when the underlying
 * Playwright call rejects (e.g. selector not found, timeout).
 */
export async function executeAction(page: Page, action: Action): Promise<void> {
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
      await page.evaluate(action.expression);
      break;
    }
    default: {
      // Exhaustiveness guard: unreachable if all Action discriminants are handled.
      const exhaustive: never = action;
      throw new Error(`Unknown action type: ${(exhaustive as Action).type}`);
    }
  }
}
