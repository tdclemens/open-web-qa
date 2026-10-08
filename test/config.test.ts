import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CREDENTIALS_FILE_NAME,
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  ConfigError,
  buildCredentialsNote,
  globalConfigDir,
  loadConfig,
  loadCredentials,
  mergeConfig,
  mergeCredentials,
  projectConfigDir,
  resolveAiOptions,
  resolveCredentialPlaceholders,
} from "../src/config";
import type { Credential } from "../src/config";
import type { TestPlanGraph } from "../src/graph/types";

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

/** Write `value` to <dir>/.openwebqa/config.json and return its path. */
function writeConfig(dir: string, value: unknown): string {
  const file = path.join(dir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

/** Write `value` to <dir>/.openwebqa/credentials.json and return its path. */
function writeCredentials(dir: string, value: unknown): string {
  const file = path.join(dir, CONFIG_DIR_NAME, CREDENTIALS_FILE_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

const projectConfigFile = (dir: string) => path.join(dir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
const projectCredentialsFile = (dir: string) =>
  path.join(dir, CONFIG_DIR_NAME, CREDENTIALS_FILE_NAME);

describe("loadConfig", () => {
  it("returns an empty config when neither file exists", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({});
    expect(loaded.sources).toEqual([]);
  });

  it("skips an empty project config directory and still loads the global one", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    fs.mkdirSync(path.join(cwd, CONFIG_DIR_NAME)); // directory exists, no file inside
    writeConfig(home, { ai: { model: "global-model" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({ ai: { model: "global-model" } });
    expect(loaded.sources).toEqual([projectConfigFile(home)]);
  });

  it("treats a legacy .openwebqa file (instead of a directory) as a read error", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    fs.writeFileSync(path.join(cwd, CONFIG_DIR_NAME), JSON.stringify({ ai: { model: "legacy" } }));
    expect(() => loadConfig({ cwd, home })).toThrowError(ConfigError);
    expect(() => loadConfig({ cwd, home })).toThrowError(/cannot read config file/);
  });

  it("loads only the global file when the project file is missing", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(home, { ai: { model: "global-model" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({ ai: { model: "global-model" } });
    expect(loaded.sources).toEqual([projectConfigFile(home)]);
  });

  it("loads only the project file when the global file is missing", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: { apiKey: "project-key" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({ ai: { apiKey: "project-key" } });
    expect(loaded.sources).toEqual([projectConfigFile(cwd)]);
  });

  it("merges both files field by field, with the project file winning", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(home, {
      ai: { model: "global-model", endpoint: "http://global:11434/v1", apiKey: "global-key" },
    });
    writeConfig(cwd, { ai: { model: "project-model", apiKey: "project-key" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({
      ai: { model: "project-model", endpoint: "http://global:11434/v1", apiKey: "project-key" },
    });
    // Sources are reported most specific first.
    expect(loaded.sources).toEqual([projectConfigFile(cwd), projectConfigFile(home)]);
  });

  it("skips an empty project file and still loads the global one", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, "   \n");
    writeConfig(home, { ai: { apiKey: "global-key" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config).toEqual({ ai: { apiKey: "global-key" } });
    expect(loaded.sources).toEqual([projectConfigFile(home)]);
  });

  it("throws ConfigError naming the file for invalid JSON", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(home, "{ not json");
    expect(() => loadConfig({ cwd, home })).toThrowError(
      ConfigError,
      new RegExp(`config file "${projectConfigFile(home)}" is not valid JSON`),
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

  it("throws ConfigError for an unknown top-level key (the login section is gone)", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { agents: {} });
    expect(() => loadConfig({ cwd, home })).toThrowError(/unknown top-level key "agents"/);
    writeConfig(cwd, { login: { username: "x" } });
    expect(() => loadConfig({ cwd, home })).toThrowError(
      /unknown top-level key "login" \(allowed: ai\)/,
    );
  });

  it("throws ConfigError for an unknown key inside a section", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: { modelName: "x" } });
    expect(() => loadConfig({ cwd, home })).toThrowError(/unknown key "ai.modelName"/);
  });

  it("throws ConfigError when a section is not an object", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: "gpt-4o-mini" });
    expect(() => loadConfig({ cwd, home })).toThrowError(/"ai" must be a JSON object/);
  });

  it("throws ConfigError for non-string field values", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: { model: 42 } });
    expect(() => loadConfig({ cwd, home })).toThrowError(/"ai.model" must be a string/);
  });

  it("treats empty strings as unset", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeConfig(cwd, { ai: { apiKey: "", model: "m" } });
    const loaded = loadConfig({ cwd, home });
    expect(loaded.config.ai).toEqual({ model: "m" });
  });
});

describe("loadCredentials", () => {
  it("returns an empty list when neither file exists", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    const loaded = loadCredentials({ cwd, home });
    expect(loaded.credentials).toEqual([]);
    expect(loaded.sources).toEqual([]);
  });

  it("loads only the global file when the project file is missing", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(home, [{ id: "qa", username: "qa@example.com", password: "global-pass" }]);
    const loaded = loadCredentials({ cwd, home });
    expect(loaded.credentials).toEqual([
      { id: "qa", username: "qa@example.com", password: "global-pass" },
    ]);
    expect(loaded.sources).toEqual([projectCredentialsFile(home)]);
  });

  it("loads only the project file when the global file is missing", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, [{ id: "qa", description: "Regular demo user", password: "p" }]);
    const loaded = loadCredentials({ cwd, home });
    expect(loaded.credentials).toEqual([{ id: "qa", description: "Regular demo user", password: "p" }]);
    expect(loaded.sources).toEqual([projectCredentialsFile(cwd)]);
  });

  it("merges per id: project entries replace global ones in place, new ones are appended", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(home, [
      { id: "qa", description: "global desc", username: "g@example.com", password: "global-pass" },
      { id: "legacy", username: "legacy@example.com" },
    ]);
    writeCredentials(cwd, [
      { id: "qa", username: "qa@example.com" },
      { id: "admin", description: "Admin account", password: "admin-pass" },
    ]);
    const loaded = loadCredentials({ cwd, home });
    expect(loaded.credentials).toEqual([
      { id: "qa", username: "qa@example.com" }, // project entry replaces wholesale
      { id: "legacy", username: "legacy@example.com" }, // global-only entry kept
      { id: "admin", description: "Admin account", password: "admin-pass" }, // appended
    ]);
    expect(loaded.sources).toEqual([projectCredentialsFile(cwd), projectCredentialsFile(home)]);
  });

  it("skips an empty project file and still loads the global one", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, "   \n");
    writeCredentials(home, [{ id: "qa", password: "global-pass" }]);
    const loaded = loadCredentials({ cwd, home });
    expect(loaded.credentials).toEqual([{ id: "qa", password: "global-pass" }]);
    expect(loaded.sources).toEqual([projectCredentialsFile(home)]);
  });

  it("throws ConfigError naming the file for invalid JSON", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(home, "{ not json");
    expect(() => loadCredentials({ cwd, home })).toThrowError(
      ConfigError,
      new RegExp(`credentials file "${projectCredentialsFile(home)}"`),
    );
  });

  it("throws ConfigError when the top level is not a JSON array", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, { id: "qa" });
    expect(() => loadCredentials({ cwd, home })).toThrowError(
      /top-level value must be a JSON array/,
    );
  });

  it("throws ConfigError when an entry is not an object", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, ["qa"]);
    expect(() => loadCredentials({ cwd, home })).toThrowError(/entry at index 0 must be a JSON object/);
  });

  it("throws ConfigError when an entry is missing its id or the id is empty", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, [{ username: "u" }]);
    expect(() => loadCredentials({ cwd, home })).toThrowError(/"id" must be a non-empty string/);
    writeCredentials(cwd, [{ id: "  ", password: "p" }]);
    expect(() => loadCredentials({ cwd, home })).toThrowError(/"id" must be a non-empty string/);
  });

  it("throws ConfigError for duplicate ids within one file", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, [
      { id: "qa", username: "a@example.com" },
      { id: "qa", password: "p" },
    ]);
    expect(() => loadCredentials({ cwd, home })).toThrowError(/duplicate credential id "qa"/);
  });

  it("throws ConfigError for unknown keys in an entry", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, [{ id: "qa", description: "d", user: "x", password: "p" }]);
    expect(() => loadCredentials({ cwd, home })).toThrowError(
      /unknown key "user" \(allowed: id, description, username, password\)/,
    );
  });

  it("throws ConfigError for non-string entry values", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, [{ id: "qa", password: 123 }]);
    expect(() => loadCredentials({ cwd, home })).toThrowError(/"password" must be a string/);
  });

  it("throws ConfigError when an entry has neither username nor password", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, [{ id: "qa" }]);
    expect(() => loadCredentials({ cwd, home })).toThrowError(
      /credential "qa" must include "username" and\/or "password"/,
    );
    // Empty strings count as unset, so this is rejected as well.
    writeCredentials(cwd, [{ id: "qa", username: "", password: "" }]);
    expect(() => loadCredentials({ cwd, home })).toThrowError(
      /credential "qa" must include "username" and\/or "password"/,
    );
  });

  it("treats empty strings as unset and allows a username-only credential", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeCredentials(cwd, [{ id: "qa", description: "", username: "qa@example.com", password: "" }]);
    const loaded = loadCredentials({ cwd, home });
    expect(loaded.credentials).toEqual([{ id: "qa", username: "qa@example.com" }]);
  });
});

describe("mergeConfig", () => {
  it("keeps base fields that the override does not set", () => {
    expect(mergeConfig({ ai: { endpoint: "e", apiKey: "k" } }, { ai: { model: "m" } })).toEqual({
      ai: { endpoint: "e", apiKey: "k", model: "m" },
    });
  });

  it("returns an empty config when neither side has an ai section", () => {
    expect(mergeConfig({}, {})).toEqual({});
  });
});

describe("mergeCredentials", () => {
  it("does not mutate its inputs", () => {
    const base: Credential[] = [{ id: "a", password: "1" }];
    const override: Credential[] = [{ id: "a", username: "2" }];
    const merged = mergeCredentials(base, override);
    expect(merged).toEqual([{ id: "a", username: "2" }]);
    expect(base).toEqual([{ id: "a", password: "1" }]);
    expect(override).toEqual([{ id: "a", username: "2" }]);
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

describe("buildCredentialsNote", () => {
  it("returns null when no credentials are configured", () => {
    expect(buildCredentialsNote(undefined)).toBeNull();
    expect(buildCredentialsNote([])).toBeNull();
  });

  it("lists each credential as id and description", () => {
    const note = buildCredentialsNote([
      { id: "qa", description: "Regular demo user", username: "qa@example.com", password: "s3cret" },
      { id: "admin", username: "admin@example.com", password: "admin-pass" },
    ]);
    if (note === null) throw new Error("expected a note");
    expect(note).toContain("[OpenWebQA configuration: available login credentials]");
    expect(note).toContain("id: qa | description: Regular demo user");
    expect(note).toContain('id: admin | description: (none)');
    expect(note).toContain("{{credential:<id>.username}}");
    expect(note).toContain("{{credential:<id>.password}}");
  });

  it("never includes the credential values", () => {
    const note = buildCredentialsNote([
      { id: "qa", description: "Regular demo user", username: "qa@example.com", password: "s3cret" },
    ]);
    if (note === null) throw new Error("expected a note");
    expect(note).not.toContain("qa@example.com");
    expect(note).not.toContain("s3cret");
  });

  it("never emits lines the mock agent grammar would parse as bullets or headings", () => {
    const note = buildCredentialsNote([
      { id: "qa", description: "Regular demo user", username: "u", password: "p" },
    ]);
    if (note === null) throw new Error("expected a note");
    for (const line of note.split("\n")) {
      expect(line.startsWith("- ")).toBe(false);
      expect(line.startsWith("## ")).toBe(false);
    }
  });
});

describe("resolveCredentialPlaceholders", () => {
  const credentials: Credential[] = [
    { id: "qa", description: "Regular demo user", username: "qa@example.com", password: "s3cret" },
    { id: "admin", description: "Admin account", password: "admin-pass" },
  ];

  function graphWithFill(value: string): TestPlanGraph {
    return {
      cases: [
        {
          id: "login",
          name: "Login",
          dependsOn: [],
          actions: [{ type: "fill", selector: "#password", value }],
        },
      ],
    };
  }

  it("substitutes username and password placeholders in fill values", () => {
    const user = graphWithFill("{{credential:qa.username}}");
    resolveCredentialPlaceholders(user, credentials);
    expect((user.cases[0].actions[0] as { value: string }).value).toBe("qa@example.com");

    const pass = graphWithFill("{{credential:qa.password}}");
    resolveCredentialPlaceholders(pass, credentials);
    expect((pass.cases[0].actions[0] as { value: string }).value).toBe("s3cret");
  });

  it("substitutes multiple placeholders and mixed text in any string field", () => {
    const graph: TestPlanGraph = {
      cases: [
        {
          id: "probe",
          name: "Probe",
          dependsOn: [],
          actions: [
            {
              type: "evaluate",
              expression: "console.log({{credential:qa.username}}, {{credential:admin.password}})",
            },
            { type: "assertText", selector: "#status", text: "Logged in as {{credential:qa.username}}" },
          ],
        },
      ],
    };
    resolveCredentialPlaceholders(graph, credentials);
    const evaluate = graph.cases[0].actions[0] as { expression: string };
    expect(evaluate.expression).toBe("console.log(qa@example.com, admin-pass)");
    const assertText = graph.cases[0].actions[1] as { text: string };
    expect(assertText.text).toBe("Logged in as qa@example.com");
  });

  it("leaves strings without placeholders untouched", () => {
    const graph = graphWithFill("plain-text-value");
    resolveCredentialPlaceholders(graph, credentials);
    expect((graph.cases[0].actions[0] as { value: string }).value).toBe("plain-text-value");
  });

  it("throws ConfigError naming the case and id for an unknown credential", () => {
    const graph = graphWithFill("{{credential:root.password}}");
    expect(() => resolveCredentialPlaceholders(graph, credentials)).toThrowError(
      ConfigError,
      /plan case "login": unknown credential id "root" in "\{\{credential:root\.password\}\}" \(configured: qa, admin\)/,
    );
  });

  it("throws ConfigError when the plan uses placeholders but no credentials are configured", () => {
    const graph = graphWithFill("{{credential:qa.password}}");
    expect(() => resolveCredentialPlaceholders(graph, [])).toThrowError(
      ConfigError,
      /references credential id "qa" but no login credentials are configured/,
    );
  });

  it("throws ConfigError when the credential lacks the referenced field", () => {
    const graph = graphWithFill("{{credential:admin.username}}");
    expect(() => resolveCredentialPlaceholders(graph, credentials)).toThrowError(
      ConfigError,
      /credential "admin" has no "username" field.*configured fields: password/,
    );
  });

  it("throws ConfigError for malformed placeholders (missing or unknown field)", () => {
    expect(() => resolveCredentialPlaceholders(graphWithFill("{{credential:qa}}"), credentials)).toThrowError(
      ConfigError,
      /malformed credential placeholder "\{\{credential:qa\}\}"/,
    );
    expect(() =>
      resolveCredentialPlaceholders(graphWithFill("{{credential:qa.token}}"), credentials),
    ).toThrowError(ConfigError, /malformed credential placeholder "\{\{credential:qa\.token\}\}"/);
  });
});

describe("config directory helpers", () => {
  it("joins the home directory with the config dir name", () => {
    expect(globalConfigDir("/home/user")).toBe(path.join("/home/user", CONFIG_DIR_NAME));
  });

  it("joins the working directory with the config dir name", () => {
    expect(projectConfigDir("/work/proj")).toBe(path.join("/work/proj", CONFIG_DIR_NAME));
  });
});
