// OpenWebQA configuration.
//
// Configuration lives in a directory named `.openwebqa`, read from two
// locations:
//   primary   ./.openwebqa/   (project-local, in the working directory)
//   secondary ~/.openwebqa/   (user-global, in the home directory)
// Each directory may contain two JSON files:
//   config.json        AI connection settings (the `ai` section)
//   credentials.json   named login credentials referenced from test plans
// Both directories may be present. Config fields are merged per section (a
// field set in the primary file wins), and credentials are merged per id
// (an entry with the same id in the primary file replaces the secondary
// one; entries only present in the primary file are appended).
//
// Effective precedence for the AI connection options:
//   CLI flag > environment variable (OPENAI_BASE_URL / OPENAI_API_KEY) >
//   ./.openwebqa/config.json > ~/.openwebqa/config.json > built-in default
//
// Login credentials are referenced in plans by id, never by value: the CLI
// passes each credential's id and description to the AI agent while it
// compiles the plan (see buildCredentialsNote), and test cases reference the
// values with {{credential:<id>.username}} / {{credential:<id>.password}}
// placeholders that the CLI substitutes with the real values before
// execution (see resolveCredentialPlaceholders).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestPlanGraph } from "./graph/types";

/** AI connection settings. */
export interface AiConfig {
  /** Model id (e.g. "gpt-4o-mini"). Maps to `--model`. */
  model?: string;
  /** Base URL of an OpenAI-compatible endpoint (e.g. "http://127.0.0.1:11434/v1"). Maps to `--ai-endpoint`. */
  endpoint?: string;
  /** API key for the endpoint. Maps to `--api-key`. */
  apiKey?: string;
}

/** A named login credential from a credentials.json file. */
export interface Credential {
  /** Stable id referenced from plans (e.g. "admin"). */
  id: string;
  /** Human-readable purpose. Passed to the agent during planning (never the values). */
  description?: string;
  /** Username, referenced as {{credential:<id>.username}}. */
  username?: string;
  /** Password, referenced as {{credential:<id>.password}}. */
  password?: string;
}

/** A merged OpenWebQA configuration (fields the sources did not set are absent). */
export interface OpenWebQaConfig {
  ai?: AiConfig;
}

/** Result of {@link loadConfig}. */
export interface LoadedConfig {
  config: OpenWebQaConfig;
  /** Paths of the config files that were found and merged, most specific first. */
  sources: string[];
}

/** Result of {@link loadCredentials}. */
export interface LoadedCredentials {
  /** Merged credentials, global first (project entries replace/appended by id). */
  credentials: Credential[];
  /** Paths of the credentials files that were found and merged, most specific first. */
  sources: string[];
}

/** Error for an unreadable or invalid config/credentials file; the message is user-facing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Config directory name (project: `./.openwebqa`, global: `~/.openwebqa`). */
export const CONFIG_DIR_NAME = ".openwebqa";

/** AI connection config file name inside a config directory. */
export const CONFIG_FILE_NAME = "config.json";

/** Login credentials file name inside a config directory. */
export const CREDENTIALS_FILE_NAME = "credentials.json";

/** Project-local config directory (resolved against the working directory). */
export function projectConfigDir(cwd: string = process.cwd()): string {
  return path.join(cwd, CONFIG_DIR_NAME);
}

/** User-global config directory (default: `~/.openwebqa`). */
export function globalConfigDir(home: string = os.homedir()): string {
  return path.join(home, CONFIG_DIR_NAME);
}

/** Allowed (string) keys per section. */
const SECTION_FIELDS: Record<"ai", readonly string[]> = {
  ai: ["model", "endpoint", "apiKey"],
};

/** Allowed keys in a credentials.json entry. */
const CREDENTIAL_FIELDS = ["id", "description", "username", "password"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and parse one JSON config file. Returns undefined when the file is
 * missing, is a directory, or is empty (all silently skipped). Throws
 * ConfigError (naming the file) for unreadable or non-JSON files.
 */
function readJsonFile(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "EISDIR") return undefined; // missing, or not a file: skip
    throw new ConfigError(
      `cannot read config file "${file}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw.trim().length === 0) return undefined; // empty file = no config
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `config file "${file}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validate one section (`"ai"`). Returns undefined when the section is
 * absent, or an object of its string fields. Empty strings are treated as
 * unset and dropped. Throws ConfigError on unknown keys or non-string
 * values, naming the file and the offending key.
 */
function validateSection(
  value: unknown,
  section: "ai",
  file: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ConfigError(`config file "${file}": "${section}" must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!SECTION_FIELDS[section].includes(key)) {
      throw new ConfigError(
        `config file "${file}": unknown key "${section}.${key}" (allowed: ${SECTION_FIELDS[section].join(", ")})`,
      );
    }
    if (typeof fieldValue !== "string") {
      throw new ConfigError(`config file "${file}": "${section}.${key}" must be a string`);
    }
    if (fieldValue.length > 0) out[key] = fieldValue; // empty string = unset
  }
  return out;
}

/** Validate a parsed config.json's top level. Throws ConfigError on bad shape. */
function validateConfigFile(value: unknown, file: string): OpenWebQaConfig {
  if (!isPlainObject(value)) {
    throw new ConfigError(`config file "${file}": top-level value must be a JSON object`);
  }
  const out: OpenWebQaConfig = {};
  for (const [key, sectionValue] of Object.entries(value)) {
    if (key === "ai") {
      out.ai = validateSection(sectionValue, "ai", file) as AiConfig | undefined;
    } else {
      throw new ConfigError(
        `config file "${file}": unknown top-level key "${key}" (allowed: ai)`,
      );
    }
  }
  return out;
}

/**
 * Field-level merge of two configs: every field set in `override` wins, and
 * fields only present in `base` are kept (e.g. a project file setting only
 * `ai.model` keeps the global file's `ai.endpoint`).
 */
export function mergeConfig(base: OpenWebQaConfig, override: OpenWebQaConfig): OpenWebQaConfig {
  const out: OpenWebQaConfig = {};
  if (base.ai !== undefined || override.ai !== undefined) {
    out.ai = { ...base.ai, ...override.ai };
  }
  return out;
}

/**
 * Validate a parsed credentials.json. The top level must be a JSON array of
 * objects; each entry needs a non-empty unique `id` plus at least one of
 * `username`/`password` (all values are strings; empty strings are treated
 * as unset). Throws ConfigError naming the file and entry on any violation.
 */
function validateCredentialsFile(value: unknown, file: string): Credential[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`credentials file "${file}": top-level value must be a JSON array`);
  }
  const seenIds = new Set<string>();
  return value.map((entry, index): Credential => {
    const where = `credentials file "${file}": entry at index ${index}`;
    if (!isPlainObject(entry)) {
      throw new ConfigError(`${where} must be a JSON object`);
    }
    for (const key of Object.keys(entry)) {
      if (!(CREDENTIAL_FIELDS as readonly string[]).includes(key)) {
        throw new ConfigError(
          `${where}: unknown key "${key}" (allowed: ${CREDENTIAL_FIELDS.join(", ")})`,
        );
      }
    }
    const id = entry.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new ConfigError(`${where}: "id" must be a non-empty string`);
    }
    if (seenIds.has(id)) {
      throw new ConfigError(`${where}: duplicate credential id "${id}"`);
    }
    seenIds.add(id);
    const credential: Credential = { id };
    for (const key of ["description", "username", "password"] as const) {
      const fieldValue = entry[key];
      if (fieldValue === undefined) continue;
      if (typeof fieldValue !== "string") {
        throw new ConfigError(`${where}: "${key}" must be a string`);
      }
      if (fieldValue.length > 0) credential[key] = fieldValue; // empty string = unset
    }
    if (credential.username === undefined && credential.password === undefined) {
      throw new ConfigError(
        `${where}: credential "${id}" must include "username" and/or "password"`,
      );
    }
    return credential;
  });
}

/**
 * Merge two credential lists: entries from `override` replace entries in
 * `base` with the same id (in place, wholesale), and override-only entries
 * are appended in order.
 */
export function mergeCredentials(base: Credential[], override: Credential[]): Credential[] {
  const merged: Credential[] = base.map((c) => ({ ...c }));
  for (const entry of override) {
    const existingIndex = merged.findIndex((c) => c.id === entry.id);
    if (existingIndex >= 0) merged[existingIndex] = { ...entry };
    else merged.push({ ...entry });
  }
  return merged;
}

export interface LoadConfigOptions {
  /** Working directory that contains the project config directory. Default: process.cwd(). */
  cwd?: string;
  /** Home directory that contains the global config directory. Default: os.homedir(). */
  home?: string;
}

/**
 * Load and merge the OpenWebQA config files.
 *
 * Reads `~/.openwebqa/config.json` (secondary) and `./.openwebqa/config.json`
 * (primary) when they exist, validating each (see {@link validateConfigFile}),
 * and merges them field-by-field with the primary file winning. Missing files
 * and empty files are skipped silently. Unreadable, non-JSON, or
 * structurally invalid files throw {@link ConfigError} with a user-facing
 * message naming the file.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  // Least specific first: each file that exists overrides the previous one.
  const files = [
    path.join(globalConfigDir(home), CONFIG_FILE_NAME),
    path.join(projectConfigDir(cwd), CONFIG_FILE_NAME),
  ];
  const sources: string[] = [];
  let merged: OpenWebQaConfig = {};
  for (const file of files) {
    const parsed = readJsonFile(file);
    if (parsed === undefined) continue;
    merged = mergeConfig(merged, validateConfigFile(parsed, file));
    sources.unshift(file); // report most specific first
  }
  return { config: merged, sources };
}

/**
 * Load and merge the login credentials.
 *
 * Reads `~/.openwebqa/credentials.json` (secondary) and
 * `./.openwebqa/credentials.json` (primary) when they exist, validating each
 * (see {@link validateCredentialsFile}), and merges them per id with the
 * primary file winning (see {@link mergeCredentials}). Missing and empty
 * files are skipped silently; malformed files throw {@link ConfigError}.
 */
export function loadCredentials(options: LoadConfigOptions = {}): LoadedCredentials {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const files = [
    path.join(globalConfigDir(home), CREDENTIALS_FILE_NAME),
    path.join(projectConfigDir(cwd), CREDENTIALS_FILE_NAME),
  ];
  const sources: string[] = [];
  let merged: Credential[] = [];
  for (const file of files) {
    const parsed = readJsonFile(file);
    if (parsed === undefined) continue;
    merged = mergeCredentials(merged, validateCredentialsFile(parsed, file));
    sources.unshift(file); // report most specific first
  }
  return { credentials: merged, sources };
}

/** CLI flags that override config-file AI settings (mirrors cli.ts options). */
export interface CliAiOptions {
  model?: string;
  aiEndpoint?: string;
  apiKey?: string;
}

/**
 * Resolve the effective AI connection options.
 *
 * Precedence (first set value wins):
 *   CLI flag > environment variable (OPENAI_BASE_URL / OPENAI_API_KEY) >
 *   merged .openwebqa/config.json > unset (the agent then applies its own
 *   defaults, e.g. "not-needed" for keyless local endpoints).
 */
export function resolveAiOptions(
  config: OpenWebQaConfig,
  env: NodeJS.ProcessEnv = process.env,
  cli: CliAiOptions = {},
): { model?: string; baseUrl?: string; apiKey?: string } {
  return {
    model: cli.model ?? config.ai?.model,
    baseUrl: cli.aiEndpoint ?? env.OPENAI_BASE_URL ?? config.ai?.endpoint,
    apiKey: cli.apiKey ?? env.OPENAI_API_KEY ?? config.ai?.apiKey,
  };
}

/**
 * Build the text the CLI appends to the plan markdown so the AI agent can
 * see which login credentials are configured while it compiles the plan.
 * Only the ids and descriptions are included — the credential values are
 * never shown to the agent (they are substituted in at execution time by
 * {@link resolveCredentialPlaceholders}). Returns null when no credentials
 * are configured.
 *
 * The block is deliberately plain text that the mock agent's bullet grammar
 * would ignore (no "- " bullets, no "## " headings) and that the JSON-plan
 * system prompt treats as context rather than as plan content.
 */
export function buildCredentialsNote(credentials: Credential[] | undefined): string | null {
  if (credentials === undefined || credentials.length === 0) return null;
  const lines = [
    "",
    "",
    "[OpenWebQA configuration: available login credentials]",
    'Configured credentials, one per line as "id | description":',
  ];
  for (const credential of credentials) {
    lines.push(`id: ${credential.id} | description: ${credential.description ?? "(none)"}`);
  }
  lines.push(
    "When this test plan requires logging in or authenticating, choose the credential whose description fits and reference it by id in fill actions using the value placeholders \"{{credential:<id>.username}}\" and \"{{credential:<id>.password}}\". Do not invent, guess, or hard-code credential values: every placeholder is replaced with the real value just before execution, and the values themselves are never shown to you.",
  );
  return lines.join("\n");
}

/** Matches every {{credential:...}} placeholder (contents may be anything but braces). */
const CREDENTIAL_PLACEHOLDER_RE = /\{\{credential:([^{}]+)\}\}/g;

/** A valid reference: <id>.username or <id>.password. */
const CREDENTIAL_REFERENCE_RE = /^(.+)\.(username|password)$/;

/**
 * Substitute {{credential:<id>.username}} / {{credential:<id>.password}}
 * placeholders in every string field of every action of `graph` with the
 * values from `credentials` (in place).
 *
 * Throws ConfigError (user-facing, naming the case, action field, and the
 * offending placeholder) when a placeholder is malformed, references an
 * unknown credential id, references a field the credential does not define,
 * or when the plan uses placeholders but no credentials are configured.
 */
export function resolveCredentialPlaceholders(
  graph: TestPlanGraph,
  credentials: Credential[],
): void {
  const byId = new Map<string, Credential>(credentials.map((c) => [c.id, c]));
  for (const testCase of graph.cases) {
    for (const action of testCase.actions) {
      const record = action as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== "string") continue;
        record[key] = substituteCredentialPlaceholders(value, byId, testCase.id, key);
      }
    }
  }
}

function substituteCredentialPlaceholders(
  text: string,
  byId: Map<string, Credential>,
  caseId: string,
  field: string,
): string {
  if (!text.includes("{{credential:")) return text;
  return text.replace(CREDENTIAL_PLACEHOLDER_RE, (match, inner: string) => {
    const reference = CREDENTIAL_REFERENCE_RE.exec(inner.trim());
    if (reference === null) {
      throw new ConfigError(
        `plan case "${caseId}": malformed credential placeholder "${match}" in action field "${field}" (expected {{credential:<id>.username}} or {{credential:<id>.password}})`,
      );
    }
    const id = reference[1];
    const fieldName = reference[2] as "username" | "password";
    const credential = byId.get(id);
    if (credential === undefined) {
      if (byId.size === 0) {
        throw new ConfigError(
          `plan case "${caseId}": "${match}" references credential id "${id}" but no login credentials are configured (add entries to .openwebqa/credentials.json)`,
        );
      }
      throw new ConfigError(
        `plan case "${caseId}": unknown credential id "${id}" in "${match}" (configured: ${[...byId.keys()].join(", ")})`,
      );
    }
    const value = credential[fieldName];
    if (value === undefined) {
      const fields = (["username", "password"] as const)
        .filter((f) => credential[f] !== undefined)
        .join(", ");
      throw new ConfigError(
        `plan case "${caseId}": credential "${id}" has no "${fieldName}" field in "${match}" (configured fields: ${fields})`,
      );
    }
    return value;
  });
}
