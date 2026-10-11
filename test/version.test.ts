import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readVersion } from "../src/version";

/** The version field of the package.json at the repository root. */
const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

describe("readVersion", () => {
  it("matches the version field of package.json", () => {
    expect(readVersion()).toBe(packageJson.version);
  });

  it("is a semantic MAJOR.MINOR.PATCH version", () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
