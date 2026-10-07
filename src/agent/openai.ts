import OpenAI from "openai";
import type { Action, ActionType, TestCase, TestPlanGraph } from "../graph/types";

/**
 * AI-agent integration for OpenWebQA.
 *
 * Submits a markdown QA test plan to an OpenAI-compatible chat model (the
 * official OpenAI API, or any local/home-network server such as Ollama or
 * LM Studio) and returns the parsed TestPlanGraph.
 */

/** Options for {@link createOpenAiAgent}. */
export interface OpenAiAgentOptions {
  /** Model name. Defaults to "gpt-4o-mini". */
  model?: string;
  /**
   * API key. Precedence: explicit option > process.env.OPENAI_API_KEY >
   * "not-needed" (so keyless local endpoints work).
   */
  apiKey?: string;
  /**
   * Base URL of an OpenAI-compatible server (e.g. "http://127.0.0.1:11434/v1").
   * Precedence: explicit option > process.env.OPENAI_BASE_URL. When neither is
   * set the option is omitted so the SDK default (https://api.openai.com/v1)
   * applies.
   */
  baseUrl?: string;
}

/** An AI agent that compiles a markdown QA plan into a TestPlanGraph. */
export interface OpenAiAgent {
  run(planMarkdown: string): Promise<TestPlanGraph>;
}

/**
 * System prompt instructing the model to reply ONLY with a JSON
 * TestPlanGraph conforming to the Action union in graph/types.ts.
 */
export function buildSystemPrompt(): string {
  return [
    "You are a test-plan compiler for OpenWebQA.",
    "The user gives you a QA test plan written in markdown. Convert it into a",
    "directed acyclic graph (DAG) of browser test cases.",
    "",
    "Reply ONLY with a single JSON object. No prose, no markdown, no code fences.",
    "The JSON object must have exactly this shape:",
    "",
    '{',
    '  "cases": [',
    "    {",
    '      "id": "unique string id for this test case",',
    '      "name": "human-readable test case name",',
    '      "dependsOn": ["ids of test cases that must complete before this one"],',
    '      "actions": [ /* ordered list of browser actions, see below */ ]',
    "    }",
    "  ]",
    "}",
    "",
    'Each action is an object with a "type" field. Allowed types and their',
    "required fields:",
    '  {"type":"goto","url":"<url>"}',
    '  {"type":"click","selector":"<css selector>"}',
    '  {"type":"fill","selector":"<css selector>","value":"<text to type>"}',
    '  {"type":"press","key":"<keyboard key, e.g. "Enter">"}',
    '  {"type":"waitForSelector","selector":"<css selector>","timeout":<optional ms>}',
    '  {"type":"wait","ms":<milliseconds to wait>}',
    '  {"type":"screenshot","path":"<optional file path>"}',
    '  {"type":"assertUrl","url":"<expected url>","partial":<optional boolean>}',
    '  {"type":"assertText","selector":"<css selector>","text":"<expected text>"}',
    '  {"type":"evaluate","expression":"<javascript expression>"}',
    "",
    "Rules:",
    '- Use only the action types listed above; omit optional fields instead of using null.',
    '- "dependsOn" entries must reference ids of other cases in "cases".',
    "- Do not create circular dependencies.",
    "- Order actions within each case in the sequence they must execute.",
    "",
    "Output only the JSON object.",
  ].join("\n");
}

// --- Structural validation of the model's JSON ----------------------------

type FieldType = "string" | "number" | "boolean";

interface FieldSpec {
  key: string;
  type: FieldType;
  required: boolean;
}

/** Required/optional fields per action discriminant (mirrors graph/types.ts). */
const ACTION_FIELDS: Record<ActionType, FieldSpec[]> = {
  goto: [{ key: "url", type: "string", required: true }],
  click: [{ key: "selector", type: "string", required: true }],
  fill: [
    { key: "selector", type: "string", required: true },
    { key: "value", type: "string", required: true },
  ],
  press: [{ key: "key", type: "string", required: true }],
  waitForSelector: [
    { key: "selector", type: "string", required: true },
    { key: "timeout", type: "number", required: false },
  ],
  wait: [{ key: "ms", type: "number", required: true }],
  screenshot: [{ key: "path", type: "string", required: false }],
  assertUrl: [
    { key: "url", type: "string", required: true },
    { key: "partial", type: "boolean", required: false },
  ],
  assertText: [
    { key: "selector", type: "string", required: true },
    { key: "text", type: "string", required: true },
  ],
  evaluate: [{ key: "expression", type: "string", required: true }],
};

const KNOWN_ACTION_TYPES = Object.keys(ACTION_FIELDS) as ActionType[];

function isFieldType(value: unknown, type: FieldType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function validateAction(value: unknown, caseId: string, index: number): Action {
  const where = `action at index ${index} in case "${caseId}"`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`extractJson: invalid ${where}: expected an object`);
  }
  const obj = value as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || !(type in ACTION_FIELDS)) {
    throw new TypeError(
      `extractJson: invalid ${where}: "type" must be one of ${KNOWN_ACTION_TYPES.join(", ")} (got ${JSON.stringify(type)})`,
    );
  }
  const specs = ACTION_FIELDS[type as ActionType];
  const clean: Record<string, unknown> = { type };
  for (const spec of specs) {
    const fieldValue = obj[spec.key];
    if (fieldValue === undefined) {
      if (spec.required) {
        throw new TypeError(
          `extractJson: invalid ${where}: missing required field "${spec.key}" for action type "${type}"`,
        );
      }
      continue;
    }
    if (!isFieldType(fieldValue, spec.type)) {
      throw new TypeError(
        `extractJson: invalid ${where}: field "${spec.key}" must be of type ${spec.type} for action type "${type}" (got ${JSON.stringify(fieldValue)})`,
      );
    }
    clean[spec.key] = fieldValue;
  }
  return clean as unknown as Action;
}

function validateCase(value: unknown, index: number): TestCase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`extractJson: invalid case at index ${index}: expected an object`);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new TypeError(`extractJson: invalid case at index ${index}: "id" must be a non-empty string`);
  }
  const caseId = obj.id as string;
  if (typeof obj.name !== "string") {
    throw new TypeError(`extractJson: invalid case "${caseId}": "name" must be a string`);
  }
  if (!Array.isArray(obj.dependsOn) || (obj.dependsOn as unknown[]).some((d) => typeof d !== "string")) {
    throw new TypeError(`extractJson: invalid case "${caseId}": "dependsOn" must be an array of strings`);
  }
  if (!Array.isArray(obj.actions)) {
    throw new TypeError(`extractJson: invalid case "${caseId}": "actions" must be an array`);
  }
  if (obj.timeoutMs !== undefined && typeof obj.timeoutMs !== "number") {
    throw new TypeError(`extractJson: invalid case "${caseId}": "timeoutMs" must be a number when present`);
  }
  const actions = (obj.actions as unknown[]).map((a, j) => validateAction(a, caseId, j));
  const testCase: TestCase = {
    id: caseId,
    name: obj.name,
    dependsOn: obj.dependsOn as string[],
    actions,
  };
  if (typeof obj.timeoutMs === "number") {
    testCase.timeoutMs = obj.timeoutMs;
  }
  return testCase;
}

/**
 * Extract and structurally validate a TestPlanGraph from raw model text.
 *
 * Strips markdown code fences, slices from the first '{' to the last '}',
 * JSON.parses, and verifies the shape: a top-level object with a `cases`
 * array; each case has a string `id`, string `name`, string[] `dependsOn`,
 * and an `actions` array whose elements use only known discriminants with
 * their required fields present.
 *
 * @throws {TypeError} with a specific message if extraction or validation fails.
 */
export function extractJson(text: string): TestPlanGraph {
  if (typeof text !== "string") {
    throw new TypeError(`extractJson: expected a string, got ${typeof text}`);
  }
  // Strip markdown code fences (```lang ... ```), keeping the inner content.
  const stripped = text.replace(/```[a-zA-Z0-9_-]*[^\S\n]*\n?/g, " ").replace(/```/g, " ");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new TypeError("extractJson: no JSON object found in text (no '{' ... '}' pair present)");
  }
  const candidate = stripped.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TypeError(`extractJson: malformed JSON in model response: ${reason}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("extractJson: invalid TestPlanGraph: expected an object with a \"cases\" array");
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.cases)) {
    throw new TypeError('extractJson: invalid TestPlanGraph: "cases" must be an array');
  }
  const cases = (obj.cases as unknown[]).map((c, i) => validateCase(c, i));
  return { cases };
}

/**
 * Create an AI agent backed by an OpenAI-compatible chat-completions endpoint.
 *
 * Key/base-URL precedence:
 *   apiKey  = options.apiKey ?? process.env.OPENAI_API_KEY ?? "not-needed"
 *   baseURL = options.baseUrl ?? process.env.OPENAI_BASE_URL
 * When baseURL is unset the option is omitted entirely so the openai SDK
 * default (https://api.openai.com/v1) applies.
 */
export function createOpenAiAgent(options: OpenAiAgentOptions = {}): OpenAiAgent {
  const model = options.model ?? "gpt-4o-mini";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "not-needed";
  const baseURL = options.baseUrl ?? process.env.OPENAI_BASE_URL;
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  return {
    async run(planMarkdown: string): Promise<TestPlanGraph> {
      let completion;
      try {
        completion = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: planMarkdown },
          ],
          response_format: { type: "json_object" },
        });
      } catch (err) {
        throw new Error(
          `OpenWebQA agent request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const content = completion.choices[0]?.message?.content ?? null;
      if (!content) {
        throw new TypeError("OpenWebQA agent returned an empty response; expected a JSON TestPlanGraph");
      }
      return extractJson(content);
    },
  };
}
