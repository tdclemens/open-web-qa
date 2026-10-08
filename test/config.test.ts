import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  buildLoginNote,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  resolveAiOptions,
} from "../src/config";

/** Temp dirs created by this suite, removed in afterAll. */
const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwebqa-config-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a config file into `dir` (as raw text or serialized JSON) and return its path. */
function writeConfig(dir: string, value: unknown): string {
  const file = path.join(dir, ".openwebqa");
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

describe("loadConfig", () => {
  it("returns an empty config when neither file exists", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({});
    expect(loaded.sources).toEqual([]);
  });

  it("loads only the global file when the project file is missing", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(home, { ai: { model: "global-model" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({ ai: { model: "global-model" } });
    expect(loaded.sources).toEqual([path.join(home, ".openwebqa")]);
  });

  it("loads only the project file when the global file is missing", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { login: { username: "project-user" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({ login: { username: "project-user" } });
    expect(loaded.sources).toEqual([path.join(cwd, ".openwebqa")]);
  });

  it("merges both files field by field, with the project file winning", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(home, {
      ai: { model: "global-model", endpoint: "http://global:11434/v1", apiKey: "global-key" },
      login: { username: "global-user", password: "global-pass" },
    });
    writeConfig(cwd, {
      ai: { model: "project-model", apiKey: "project-key" },
      login: { password: "project-pass" },
    });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({
      ai: { model: "project-model", endpoint: "http://global:11434/v1", apiKey: "project-key" },
      login: { username: "global-user", password: "project-pass" },
    });
    // Sources are reported most specific first.
    expect(loaded.sources).toEqual([path.join(cwd, ".openwebqa"), path.join(home, ".openwebqa")]);
  });

  it("skips an empty project file and still loads the global one", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, "   \n");
    writeConfig(home, { ai: { apiKey: "global-key" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({ ai: { apiKey: "global-key" } });
    expect(loaded.sources).toEqual([path.join(home, ".openwebqa")]);
  });

  it("skips a directory where the project config file is expected", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    fs.mkdirSync(path.join(cwd, ".openwebqa"));
    writeConfig(home, { ai: { model: "global-model" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({ ai: { model: "global-model" } });
  });

  it("throws ConfigError naming the file for invalid JSON", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(home, "{ not json");
    expect(() => loadConfig({ cwd, home })).toThrowError(
      ConfigError,
      new RegExp(`config file "${path.join(home, ".openwebqa")}" is not valid JSON`),
    );
  });

  it("throws ConfigError when the top level is not a JSON object", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, [1, 2, 3]);
    expect(() => loadConfig({ cwd, home })).toThrowError(/top-level value must be a JSON object/);
    writeConfig(cwd, '"just a string"');
    expect(() => loadConfig({ cwd, home })).toThrowError(/top-level value must be a JSON object/);
  });

  it("throws ConfigError for an unknown top-level key", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { agents: {} });
    expect(() => loadConfig({ cwd, home })).toThrowError(/unknown top-level key "agents"/);
  });

  it("throws ConfigError for an unknown key inside a section", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: { modelName: "x" } });
    expect(() => loadConfig({ cwd, home })).toThrowError(/unknown key "ai.modelName"/);
    writeConfig(cwd, { login: { user: "x" } });
    expect(() => loadConfig({ cwd, home })).toThrowError(/unknown key "login.user"/);
  });

  it("throws ConfigError when a section is not an object", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: "gpt-4o-mini" });
    expect(() => loadConfig({ cwd, home })).toThrowError(/"ai" must be a JSON object/);
    writeConfig(cwd, { login: ["u", "p"] });
    expect(() => loadConfig({ cwd, home })).toThrowError(/"login" must be a JSON object/);
  });

  it("throws ConfigError for non-string field values", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: { model: 42 } });
    expect(() => loadConfig({ cwd, home })).toThrowError(/"ai.model" must be a string/);
    writeConfig(cwd, { login: { password: null } });
    expect(() => loadConfig({ cwd, home })).toThrowError(/"login.password" must be a string/);
  });

  it("treats empty strings as unset", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: { apiKey: "" }, login: { username: "", password: "p" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config.ai).toEqual({});
    expect(loaded.config.login).toEqual({ password: "p" });
  });
});

describe("mergeConfig", () => {
  it("keeps base fields that the override does not set", () => {
    expect(
      mergeConfig({ ai: { endpoint: "e", apiKey: "k" } }, { ai: { model: "m" } }),
    ).toEqual({ ai: { endpoint: "e", apiKey: "k", model: "m" } });
  });

  it("drops section objects that end up empty and keeps independent sections", () => {
    expect(mergeConfig({}, { login: { username: "u" } })).toEqual({
      login: { username: "u" },
    });
    expect(
      mergeConfig({ ai: {}, login: { username: "u" } }, { ai: { model: "m" } }),
    ).toEqual({ ai: { model: "m" }, login: { username: "u" } });
  });
});

describe("resolveAiOptions", () => {
  const config = {
    ai: { model: "cfg-model", endpoint: "http://cfg:1/v1", apiKey: "cfg-key" },
  };

  it("prefers CLI flags over env vars and config", () => {
    const env = { OPENAI_BASE_URL: "http://env:1/v1", OPENAI_API_KEY: "env-key" };
    expect(
      resolveAiOptions(config, env, {
        model: "cli-model",
        aiEndpoint: "http://cli:1/v1",
        apiKey: "cli-key",
      }),
    ).toEqual({ model: "cli-model", baseUrl: "http://cli:1/v1", apiKey: "cli-key" });
  });

  it("prefers env vars over config (model has no env var, so config applies)", () => {
    const env = { OPENAI_BASE_URL: "http://env:1/v1", OPENAI_API_KEY: "env-key" };
    expect(resolveAiOptions(config, env, {})).toEqual({
      model: "cfg-model",
      baseUrl: "http://env:1/v1",
      apiKey: "env-key",
    });
  });

  it("falls back to config when CLI and env are unset", () => {
    expect(resolveAiOptions(config, {}, {})).toEqual({
      model: "cfg-model",
      baseUrl: "http://cfg:1/v1",
      apiKey: "cfg-key",
    });
  });

  it("returns all-undefined when nothing is configured", () => {
    expect(resolveAiOptions({}, {}, {})).toEqual({ model: undefined, baseUrl: undefined, apiKey: undefined });
  });
});

describe("buildLoginNote", () => {
  it("returns null when no login section or no credentials are configured", () => {
    expect(buildLoginNote(undefined)).toBeNull();
    expect(buildLoginNote({})).toBeNull();
  });

  it("includes both credentials when both are configured", () => {
    const note = buildLoginNote({ username: "qa@example.com", password: "s3cret" });
    expect(note).toContain("username: qa@example.com");
    expect(note).toContain("password: s3cret");
  });

  it("marks a missing credential explicitly", () => {
    const userOnly = buildLoginNote({ username: "qa@example.com" });
    expect(userOnly).toContain("username: qa@example.com");
    expect(userOnly).toContain("password: (not configured)");

    const passOnly = buildLoginNote({ password: "s3cret" });
    expect(passOnly).toContain("username: (not configured)");
    expect(passOnly).toContain("password: s3cret");
  });

  it("never emits lines the mock agent grammar would parse as bullets or headings", () => {
    const note = buildLoginNote({ username: "u", password: "p" });
    if (note === null) throw new Error("expected a note");
    for (const line of note.split("\n")) {
      expect(line.startsWith("- ")).toBe(false);
      expect(line.startsWith("## ")).toBe(false);
    }
  });
});

describe("globalConfigPath", () => {
  it("joins the home directory with .openwebqa", () => {
    expect(globalConfigPath("/home/user")).toBe(path.join("/home/user", ".openwebqa"));
  });
});
