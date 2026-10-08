// OpenWebQA configuration.
//
// The config is a JSON file read from two locations:
//   primary   ./.openwebqa   (project-local, in the working directory)
//   secondary ~/.openwebqa   (user-global, in the home directory)
// Both may be present. Fields are merged per section: a field set in the
// primary file wins, and fields the primary file does not set fall through
// to the secondary file.
//
// Effective precedence for the AI connection options:
//   CLI flag > environment variable (OPENAI_BASE_URL / OPENAI_API_KEY) >
//   ./.openwebqa > ~/.openwebqa > built-in default
//
// The `login` section holds default credentials that the CLI automatically
// passes to the AI agent while it compiles the plan (see buildLoginNote),
// so test cases that need to log in can use them without the credentials
// ever appearing in the plan markdown.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** AI connection settings. */
export interface AiConfig {
  /** Model id (e.g. "gpt-4o-mini"). Maps to `--model`. */
  model?: string;
  /** Base URL of an OpenAI-compatible endpoint (e.g. "http://127.0.0.1:11434/v1"). Maps to `--ai-endpoint`. */
  endpoint?: string;
  /** API key for the endpoint. Maps to `--api-key`. */
  apiKey?: string;
}

/** Default login credentials passed to the agent during planning. */
export interface LoginConfig {
  /** Default username. */
  username?: string;
  /** Default password. */
  password?: string;
}

/** A merged OpenWebQA configuration (fields the sources did not set are absent). */
export interface OpenWebQaConfig {
  ai?: AiConfig;
  login?: LoginConfig;
}

/** Result of {@link loadConfig}. */
export interface LoadedConfig {
  config: OpenWebQaConfig;
  /** Paths of the config files that were found and merged, most specific first. */
  sources: string[];
}

/** Error for an unreadable or invalid config file; the message is user-facing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Project-local config file name (resolved against the working directory). */
export const PROJECT_CONFIG_FILE = ".openwebqa";

/** Path of the user-global config file (default: ~/.openwebqa). */
export function globalConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".openwebqa");
}

/** Allowed (string) keys per section. */
const SECTION_FIELDS: Record<"ai" | "login", readonly string[]> = {
  ai: ["model", "endpoint", "apiKey"],
  login: ["username", "password"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one section (`"ai"` or `"login"`). Returns undefined when the
 * section is absent, or an object of its string fields. Empty strings are
 * treated as unset and dropped. Throws ConfigError on unknown keys or
 * non-string values, naming the file and the offending key.
 */
function validateSection(
  value: unknown,
  section: "ai" | "login",
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

/** Validate a parsed config file's top level. Throws ConfigError on bad shape. */
function validateConfigFile(value: unknown, file: string): OpenWebQaConfig {
  if (!isPlainObject(value)) {
    throw new ConfigError(`config file "${file}": top-level value must be a JSON object`);
  }
  const out: OpenWebQaConfig = {};
  for (const [key, sectionValue] of Object.entries(value)) {
    if (key === "ai") {
      out.ai = validateSection(sectionValue, "ai", file) as AiConfig | undefined;
    } else if (key === "login") {
      out.login = validateSection(sectionValue, "login", file) as LoginConfig | undefined;
    } else {
      throw new ConfigError(
        `config file "${file}": unknown top-level key "${key}" (allowed: ai, login)`,
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
  if (base.login !== undefined || override.login !== undefined) {
    out.login = { ...base.login, ...override.login };
  }
  return out;
}

export interface LoadConfigOptions {
  /** Directory that contains the project config. Default: process.cwd(). */
  cwd?: string;
  /** Home directory that contains the global config. Default: os.homedir(). */
  home?: string;
}

/**
 * Load and merge the OpenWebQA config files.
 *
 * Reads `~/.openwebqa` (secondary) and `./.openwebqa` (primary) when they
 * exist, validating each (see {@link validateConfigFile}), and merges them
 * field-by-field with the primary file winning. Missing files and empty
 * files are skipped silently; a directory where a file is expected is also
 * skipped. Unreadable, non-JSON, or structurally invalid files throw
 * {@link ConfigError} with a user-facing message naming the file.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  // Least specific first: each file that exists overrides the previous one.
  const files = [globalConfigPath(home), path.join(cwd, PROJECT_CONFIG_FILE)];
  const sources: string[] = [];
  let merged: OpenWebQaConfig = {};
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "EISDIR") continue; // missing, or not a file: skip
      throw new ConfigError(
        `cannot read config file "${file}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (raw.trim().length === 0) continue; // empty file = no config
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(
        `config file "${file}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    merged = mergeConfig(merged, validateConfigFile(parsed, file));
    sources.unshift(file); // report most specific first
  }
  return { config: merged, sources };
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
 *   merged .openwebqa config > unset (the agent then applies its own
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
 * Build the text the CLI appends to the plan markdown so the AI agent
 * receives the configured default login credentials while it compiles the
 * plan. Returns null when no credentials are configured.
 *
 * The block is deliberately plain text that the mock agent's bullet grammar
 * would ignore (no "- " bullets, no "## " headings) and that the JSON-plan
 * system prompt treats as context rather than as plan content.
 */
export function buildLoginNote(login: LoginConfig | undefined): string | null {
  if (login === undefined) return null;
  const username = login.username;
  const password = login.password;
  if (username === undefined && password === undefined) return null;
  const lines = [
    "",
    "",
    "[OpenWebQA configuration: default login credentials]",
    `username: ${username ?? "(not configured)"}`,
    `password: ${password ?? "(not configured)"}`,
    "If this test plan requires logging in or authenticating, use these exact credentials in the generated test cases (for example, fill actions for the login form).",
  ];
  return lines.join("\n");
}
