import { createHash } from "node:crypto";
import type { ValidateFunction } from "ajv";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import { connectorWatchJson } from "./connector-watch-imcp.js";
import { compileComposioWatchInputSchema } from "./connector-watch-composio-probe.js";
import { buildComposioCalendarExecutorRequest, parseComposioCalendarExecutorResponse, type ComposioCalendarRead } from "./connector-watch-composio.js";
import type { ComposioCalendarContract } from "./composio-calendar-host-port.js";

export const CALENDAR_SCHEMA_SLUGS = ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET"] as const;
type ObjectValue = Record<string, unknown>;
const EXECUTOR = "COMPOSIO_MULTI_EXECUTE_TOOL";
const SEARCH = "COMPOSIO_SEARCH_TOOLS";
const SCHEMAS = "COMPOSIO_GET_TOOL_SCHEMAS";
export type ComposioCalendarExecutorOutputSource = "declared" | "host_contract";
const HOST_EXECUTOR_OUTPUT_VERSION = "calendar-single-read-output-v1";
// MCP outputSchema is optional. This fixed contract applies ALWAYS; a declared
// schema can only narrow it. No vendor schema can enable batching or partial data.
const hostObject = (properties: ObjectValue, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const emptyError = { anyOf: [{ type: "null" }, { type: "string", maxLength: 0 }] };
const resultIdentity = { tool_slug: { type: "string", enum: [...CALENDAR_SCHEMA_SLUGS] }, index: { type: "integer", const: 0 } };
const resultSchema = (success: boolean) => hostObject({ ...resultIdentity, response: { type: success ? "object" : "null" }, error: success ? emptyError : { type: "string", minLength: 1, maxLength: 4_096 } }, ["tool_slug", "index", success ? "response" : "error"]);
const dataSchema = (success: boolean) => hostObject({
  results: { type: "array", minItems: 1, maxItems: 1, items: resultSchema(success) },
  total_count: { type: "integer", const: 1 }, success_count: { type: "integer", const: success ? 1 : 0 }, error_count: { type: "integer", const: success ? 0 : 1 },
  remote_file_info: { type: "null" }, next_steps: { type: ["string", "null"], maxLength: 4_096 },
  session: { anyOf: [{ type: "null" }, hostObject({ id: { type: "string", maxLength: 256 }, instructions: { type: "string", maxLength: 4_096 } })] },
}, ["results", "total_count", "success_count", "error_count"]);
const HOST_EXECUTOR_OUTPUT = hostObject({ successful: { type: "boolean", const: true }, error: emptyError, data: { oneOf: [dataSchema(true), dataSchema(false)] } }, ["successful", "data"]);
export class ComposioCalendarContractError extends Error {
  constructor(readonly stage: "inventory" | "search" | "schemas" | "executor" | "read_arguments" | "read_response" | "schema_drift", readonly reason: "shape" | "missing" | "unsupported" | "invalid" | "changed", readonly facts?: { keyword: "ref" | "pattern" | "nullable" | "format" | "dialect" | "other"; dialect: "draft-07" | "draft-2020-12" | "missing" | "other" }, readonly field?: "executor_input" | "executor_output" | "account_selector") {
    super("Calendar's current read contract could not be verified.");
  }
}
function fail(stage: ComposioCalendarContractError["stage"], reason: ComposioCalendarContractError["reason"] = "shape", field?: ComposioCalendarContractError["field"]): never { throw new ComposioCalendarContractError(stage, reason, undefined, field); }
export function calendarContractObject(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("schemas");
  return value as ObjectValue;
}
function optionalObject(value: unknown): ObjectValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined; }
export function boundedCalendarContractJson(value: unknown): unknown {
  const result = copyBoundedJson(value, { maxDepth: 18, maxNodes: 12_000, maxSize: 256 * 1024, measure: utf8Size });
  if (result === undefined || Buffer.byteLength(JSON.stringify(result), "utf8") > 256 * 1024) return fail("schemas", "invalid");
  return result;
}
export function calendarContractAction(value: unknown): ObjectValue {
  const envelope = calendarContractObject(boundedCalendarContractJson(value));
  const { content, ...withoutEmptyContent } = envelope;
  const action = calendarContractObject(connectorWatchJson(Array.isArray(content) && content.length === 0 && envelope.structuredContent !== undefined ? withoutEmptyContent : envelope));
  for (const field of ["remote_file_info", "remoteFileInfo", "truncated", "has_more", "hasMore", "nextCursor", "next_cursor", "nextPageToken", "next_page_token"]) if (action[field] !== undefined && action[field] !== null && action[field] !== false && action[field] !== "") return fail("schemas", "invalid");
  return action;
}
export function calendarContractData(value: unknown): ObjectValue {
  const action = calendarContractAction(value);
  if (action.successful !== true || (action.error !== undefined && action.error !== null && action.error !== "")) return fail("schemas", "invalid");
  const data = calendarContractObject(action.data);
  for (const field of ["remote_file_info", "remoteFileInfo", "truncated", "has_more", "hasMore", "nextCursor", "next_cursor", "nextPageToken", "next_page_token"]) if (data[field] !== undefined && data[field] !== null && data[field] !== false && data[field] !== "") return fail("schemas", "invalid");
  return data;
}
function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function compile(value: unknown, stage: ComposioCalendarContractError["stage"], field?: ComposioCalendarContractError["field"]): ValidateFunction {
  try { return compileComposioWatchInputSchema(value); } catch (error) {
    const rejected = optionalObject(optionalObject(error)?.rejection)?.keyword;
    const keyword = rejected === "$ref" ? "ref" : rejected === "pattern" ? "pattern" : rejected === "nullable" ? "nullable" : rejected === "format" ? "format" : rejected === "$schema" ? "dialect" : "other";
    const annotation = optionalObject(value)?.$schema;
    const dialect = annotation === undefined ? "missing" : typeof annotation === "string" && /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/u.test(annotation) ? "draft-07" : typeof annotation === "string" && /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/u.test(annotation) ? "draft-2020-12" : "other";
    throw new ComposioCalendarContractError(stage, "unsupported", { keyword, dialect }, field);
  }
}
function property(value: unknown, key: string): ObjectValue | undefined { return optionalObject(optionalObject(value)?.properties)?.[key] as ObjectValue | undefined; }
function uniqueTool(metadata: readonly SubagentMcpRemoteTool[], name: string): SubagentMcpRemoteTool {
  const copy = boundedCalendarContractJson(metadata);
  if (!Array.isArray(copy) || copy.length > 128) return fail("inventory", "invalid");
  const seen = new Set<string>();
  for (const value of copy) {
    const tool = calendarContractObject(value);
    if (typeof tool.name !== "string" || !tool.name || seen.has(tool.name)) return fail("inventory", "invalid"); seen.add(tool.name);
  }
  const tools = (copy as unknown as SubagentMcpRemoteTool[]).filter((tool) => tool.name === name);
  if (tools.length !== 1) return fail("inventory", "missing");
  return tools[0]!;
}
function sessionArgs(schema: unknown, sessionId?: string): { session_id?: string } {
  if (sessionId === undefined) return {};
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256 || /\p{Cc}/u.test(sessionId)) return fail("schemas", "invalid");
  return property(schema, "session_id") ? { session_id: sessionId } : {};
}
export function buildCalendarSearchRequest(metadata: readonly SubagentMcpRemoteTool[]) {
  const tool = uniqueTool(metadata, SEARCH);
  if (optionalObject(tool.annotations)?.readOnlyHint !== true) return fail("search", "unsupported");
  const args = { queries: [{ use_case: "Find read-only Google Calendar tools for explicit calendar IDs, timed events in a time window and an event by ID." }], session: { generate_id: true } };
  if (!compile(tool.inputSchema, "search")(args)) return fail("search", "invalid");
  return args;
}
export function buildCalendarSchemasRequest(metadata: readonly SubagentMcpRemoteTool[], sessionId?: string) {
  const tool = uniqueTool(metadata, SCHEMAS);
  if (optionalObject(tool.annotations)?.readOnlyHint !== true) return fail("schemas", "unsupported");
  const args = { tool_slugs: [...CALENDAR_SCHEMA_SLUGS], ...(property(tool.inputSchema, "include") ? { include: ["input_schema", "output_schema"] } : {}), ...sessionArgs(tool.inputSchema, sessionId) };
  if (!compile(tool.inputSchema, "schemas")(args)) return fail("schemas", "invalid");
  return args;
}

/** An ephemeral validator from the current client inventory and fixed schema read.
 * Fingerprints detect drift; neither fingerprints nor editable diagnostics grant access. */
export function verifyCalendarContract(metadata: readonly SubagentMcpRemoteTool[], response: unknown, expected?: ComposioCalendarContract) {
  const executor = uniqueTool(metadata, EXECUTOR);
  const executorInput = optionalObject(executor.inputSchema);
  if (!executorInput) return fail("executor", executor.inputSchema === undefined ? "missing" : "invalid", "executor_input");
  const items = property(executorInput, "tools")?.items;
  const selector = property(items, "account");
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return fail("executor", "missing", "account_selector");
  const executeValidator = compile(executorInput, "executor", "executor_input");
  const executorOutputSource: ComposioCalendarExecutorOutputSource = executor.outputSchema === undefined ? "host_contract" : "declared";
  const hostOutputValidator = compile(HOST_EXECUTOR_OUTPUT, "executor");
  const executorOutputValidator = executor.outputSchema === undefined ? undefined : compile(executor.outputSchema, "executor", "executor_output");
  const data = calendarContractData(response);
  if (data.success !== true || (data.not_found !== undefined && (!Array.isArray(data.not_found) || data.not_found.length))) return fail("schemas", "missing");
  const definitions = calendarContractObject(data.tool_schemas);
  if (Object.keys(definitions).length !== CALENDAR_SCHEMA_SLUGS.length || Object.keys(definitions).some((slug) => !CALENDAR_SCHEMA_SLUGS.includes(slug as typeof CALENDAR_SCHEMA_SLUGS[number]))) return fail("schemas", "missing");
  const validators = new Map<string, ValidateFunction>();
  const outputValidators = new Map<string, ValidateFunction>();
  const hashes: string[] = [];
  for (const slug of CALENDAR_SCHEMA_SLUGS) {
    const definition = calendarContractObject(definitions[slug]);
    if (definition.tool_slug !== slug || typeof definition.toolkit !== "string" || !/^[A-Za-z]+$/u.test(definition.toolkit) || definition.toolkit.toLowerCase() !== "googlecalendar" || definition.hasFullSchema === false || definition.schemaRef !== undefined) return fail("schemas", "invalid");
    const input = calendarContractObject(definition.input_schema), output = calendarContractObject(definition.output_schema);
    if (output.type !== "object" || !optionalObject(output.properties)) return fail("schemas", "unsupported");
    validators.set(slug, compile(input, "read_arguments"));
    outputValidators.set(slug, compile(output, "read_response"));
    hashes.push(digest({ input, output }));
  }
  const contract: ComposioCalendarContract = { revision: "composio-calendar-v1", executorSchemaHash: digest({ input: executor.inputSchema, output: executor.outputSchema ?? null, outputSource: executorOutputSource, hostOutputVersion: HOST_EXECUTOR_OUTPUT_VERSION, hostOutput: HOST_EXECUTOR_OUTPUT }), readSchemaHashes: { listCalendars: hashes[0]!, listEvents: hashes[1]!, getEvent: hashes[2]! } };
  if (expected && digest(expected) !== digest(contract)) return fail("schema_drift", "changed");
  Object.freeze(contract.readSchemaHashes); Object.freeze(contract);
  const validateExecutorOutput = (response: unknown): void => {
    const action = calendarContractAction(response);
    if (!hostOutputValidator(action) || (executorOutputValidator && !executorOutputValidator(action))) return fail("executor", "invalid", "executor_output");
    const data = calendarContractObject(action.data), result = calendarContractObject((data.results as unknown[])[0]);
    if (data.error_count === 1 && !(result.error as string).trim()) return fail("executor", "invalid", "executor_output");
  };
  return Object.freeze({
    contract,
    executorOutputSource,
    request(read: ComposioCalendarRead, sessionId?: string) {
      const args = buildComposioCalendarExecutorRequest(read);
      const item = args.tools[0];
      if (!validators.get(item.tool_slug)?.(item.arguments)) return fail("read_arguments", "invalid");
      const result = { ...args, ...sessionArgs(executorInput, sessionId) };
      if (!executeValidator(result)) return fail("executor", "invalid", "executor_input");
      return result;
    },
    /** Includes genuine failed items; their account semantics remain a separate
     * strict negative oracle. Compile eligibility is checked BEFORE any send. */
    executorResponse(response: unknown): void {
      validateExecutorOutput(response);
    },
    response(read: ComposioCalendarRead, response: unknown): void {
      validateExecutorOutput(response);
      const item = buildComposioCalendarExecutorRequest(read).tools[0];
      const upstream = parseComposioCalendarExecutorResponse(boundedCalendarContractJson(response), read);
      if (!outputValidators.get(item.tool_slug)?.(upstream)) return fail("read_response", "invalid");
    },
  });
}
