import fs from "node:fs";
import path from "node:path";

/**
 * Read the package version from package.json at runtime.
 *
 * Resolves `../package.json` relative to this file's directory:
 * - from the built `dist/version.js` that is the package root
 * - from `src/version.ts` when run under vitest
 *
 * Both locations sit one level below the package root, so the same
 * relative path works in development and after `tsc`.
 */
export function readVersion(): string {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  return packageJson.version;
}
