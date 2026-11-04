import { createHash } from "node:crypto";
import type { ValidateFunction } from "ajv";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import { connectorWatchJson } from "./connector-watch-imcp.js";
import { compileComposioWatchInputSchema, composioWatchSchemaDiagnosticDialect, composioWatchSchemaDiagnosticKeyword, type ComposioWatchSchemaCompileFacts } from "./connector-watch-composio-probe.js";
import { buildComposioCalendarExecutorRequest, parseComposioCalendarExecutorResponse, type ComposioCalendarRead } from "./connector-watch-composio.js";
import type { ComposioCalendarContract } from "./composio-calendar-host-port.js";
import { ComposioCalendarOutputSchemaError, normalizeComposioCalendarOutputSchema, type ComposioCalendarReferenceFailure } from "./composio-calendar-output-schema.js";

export const CALENDAR_SCHEMA_SLUGS = ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET"] as const;
type ObjectValue = Record<string, unknown>;
const EXECUTOR = "COMPOSIO_MULTI_EXECUTE_TOOL";
const SEARCH = "COMPOSIO_SEARCH_TOOLS";
const SCHEMAS = "COMPOSIO_GET_TOOL_SCHEMAS";
export type ComposioCalendarExecutorOutputSource = "declared" | "host_contract";
const HOST_EXECUTOR_OUTPUT_VERSION = "calendar-single-read-output-v3";
// MCP outputSchema is optional. This fixed contract applies ALWAYS; a declared
// schema can only narrow it. No vendor schema can enable batching or partial data.
const hostObject = (properties: ObjectValue, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const emptyError = { anyOf: [{ type: "null" }, { type: "string", maxLength: 0 }] };
// The documented execution response's action metadata is inert, never routing
// or account authority, and never copied into persisted proof.
const logMetadata = { log_id: { type: "string", maxLength: 256 } };
const resultIdentity = { tool_slug: { type: "string", enum: [...CALENDAR_SCHEMA_SLUGS] }, index: { type: "integer", const: 0 } };
const resultSchema = (success: boolean) => hostObject({ ...resultIdentity, response: { type: success ? "object" : "null" }, error: success ? emptyError : { type: "string", minLength: 1, maxLength: 4_096 } }, ["tool_slug", "index", success ? "response" : "error"]);
const dataSchema = (success: boolean) => hostObject({
  results: { type: "array", minItems: 1, maxItems: 1, items: resultSchema(success) },
  total_count: { type: "integer", const: 1 }, success_count: { type: "integer", const: success ? 1 : 0 }, error_count: { type: "integer", const: success ? 0 : 1 },
  remote_file_info: { type: "null" }, next_steps: { type: ["string", "null"], maxLength: 4_096 },
  session: { anyOf: [{ type: "null" }, hostObject({ id: { type: "string", maxLength: 256 }, instructions: { type: "string", maxLength: 4_096 } })] },
}, ["results", "total_count", "success_count", "error_count"]);
const HOST_EXECUTOR_OUTPUT = { type: "object", properties: {}, oneOf: [
  hostObject({ successful: { type: "boolean", const: true }, error: emptyError, data: dataSchema(true), ...logMetadata }, ["successful", "data"]),
  // A tool-level failure can set successful:false and provide an action error.
  // Only a complete failed item with NO application response is eligible.
  hostObject({ successful: { type: "boolean" }, error: { anyOf: [{ type: "null" }, { type: "string", maxLength: 4_096 }] }, data: dataSchema(false), ...logMetadata }, ["successful", "data"]),
] };
type ExecutorExtraField = "log_id" | "request_id" | "session_id" | "execution_time" | "toolkit" | "other";
interface ExecutorResponseFacts {
  extraFields: Record<"action" | "data" | "result", ExecutorExtraField[]>;
  mcpIsError: boolean;
  actionSuccessful: boolean | "other";
  oneResult: boolean; totalOne: boolean; successZero: boolean; errorOne: boolean;
  indexZero: boolean; calendarListSlug: boolean; responseAbsentOrNull: boolean;
  itemError: "exact_known" | "other" | "missing";
}
export interface ComposioCalendarFailureFacts {
  keyword: ComposioWatchSchemaCompileFacts["keyword"];
  dialect: ComposioWatchSchemaCompileFacts["dialect"];
  rejectionReason?: ComposioWatchSchemaCompileFacts["reason"];
  work?: ComposioWatchSchemaCompileFacts["work"];
  operation?: ComposioCalendarRead["kind"];
  direction?: "input" | "output";
  referenceFailure?: ComposioCalendarReferenceFailure;
  executorResponse?: ExecutorResponseFacts;
}
export class ComposioCalendarContractError extends Error {
  constructor(readonly stage: "inventory" | "search" | "schemas" | "executor" | "read_arguments" | "read_response" | "schema_drift", readonly reason: "shape" | "missing" | "unsupported" | "invalid" | "changed", readonly facts?: ComposioCalendarFailureFacts, readonly field?: "executor_input" | "executor_output" | "account_selector") {
    super("Calendar's current read contract could not be verified.");
  }
}
function fail(stage: ComposioCalendarContractError["stage"], reason: ComposioCalendarContractError["reason"] = "shape", field?: ComposioCalendarContractError["field"]): never { throw new ComposioCalendarContractError(stage, reason, undefined, field); }
export function calendarContractObject(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("schemas");
  return value as ObjectValue;
}
function optionalObject(value: unknown): ObjectValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined; }
/** Diagnostic projection only. Inputs have already passed bounded JSON copying;
 * unknown names collapse to one fixed category and values are never retained. */
function executorResponseFacts(action: ObjectValue, response: unknown): ExecutorResponseFacts {
  const known = ["log_id", "request_id", "session_id", "execution_time", "toolkit"] as const;
  const extras = (value: ObjectValue, allowed: readonly string[]): ExecutorExtraField[] => {
    const keys = Object.keys(value).filter((key) => !allowed.includes(key));
    return [...known.filter((key) => keys.includes(key)), ...(keys.some((key) => !(known as readonly string[]).includes(key)) ? ["other" as const] : [])];
  };
  const data = optionalObject(action.data) ?? {}, results = data.results;
  const result = Array.isArray(results) ? optionalObject(results[0]) ?? {} : {};
  const envelope = calendarContractObject(boundedCalendarContractJson(response));
  return {
    extraFields: {
      action: extras(action, ["successful", "error", "data", "log_id"]),
      data: extras(data, ["results", "total_count", "success_count", "error_count", "remote_file_info", "next_steps", "session"]),
      result: extras(result, ["tool_slug", "index", "response", "error"]),
    },
    mcpIsError: envelope.isError === true, actionSuccessful: typeof action.successful === "boolean" ? action.successful : "other",
    oneResult: Array.isArray(results) && results.length === 1, totalOne: data.total_count === 1, successZero: data.success_count === 0, errorOne: data.error_count === 1,
    indexZero: result.index === 0, calendarListSlug: result.tool_slug === "GOOGLECALENDAR_LIST_CALENDARS", responseAbsentOrNull: result.response === undefined || result.response === null,
    // Same five exact strings as the negative oracle. This classification is
    // never consumed as authority, including when extra fields caused refusal.
    itemError: result.error === undefined ? "missing" : ["ACCOUNT_NOT_FOUND", "CONNECTED_ACCOUNT_NOT_FOUND", "INVALID_CONNECTED_ACCOUNT", "Connected account not found", "Connected account does not exist"].includes(result.error as string) ? "exact_known" : "other",
  };
}
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
/** Calendar executor failures can legitimately use MCP's isError flag. Decode
 * that representation only for a coherent failed item; this never establishes
 * account rejection or a successful read. All other callers stay strict. */
export function calendarContractExecutorAction(value: unknown): ObjectValue {
  const envelope = calendarContractObject(boundedCalendarContractJson(value));
  const action = calendarContractAction(envelope.isError === true ? { ...envelope, isError: false } : envelope);
  if (envelope.isError === true) {
    const data = optionalObject(action.data), results = data?.results;
    const result = Array.isArray(results) && results.length === 1 ? optionalObject(results[0]) : undefined;
    if (data?.total_count !== 1 || data.success_count !== 0 || data.error_count !== 1 || !result ||
        typeof result.error !== "string" || !result.error.trim() || result.error.length > 4_096 ||
        (result.response !== undefined && result.response !== null)) return fail("executor", "invalid", "executor_output");
  }
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
function compile(value: unknown, stage: ComposioCalendarContractError["stage"], field?: ComposioCalendarContractError["field"], context: Pick<ComposioCalendarFailureFacts, "operation" | "direction"> = {}): ValidateFunction {
  let rejection: ComposioWatchSchemaCompileFacts | undefined;
  try { return compileComposioWatchInputSchema(value, (facts) => { rejection = facts; }); } catch {
    throw new ComposioCalendarContractError(stage, "unsupported", { keyword: rejection?.keyword ?? "other", dialect: rejection?.dialect ?? composioWatchSchemaDiagnosticDialect(optionalObject(value)?.$schema), ...(rejection ? { rejectionReason: rejection.reason, work: rejection.work } : {}), ...context }, field);
  }
}
function validationFailure(stage: ComposioCalendarContractError["stage"], validator: ValidateFunction, context: Pick<ComposioCalendarFailureFacts, "operation" | "direction" | "executorResponse">, field?: ComposioCalendarContractError["field"]): never {
  throw new ComposioCalendarContractError(stage, "invalid", { keyword: composioWatchSchemaDiagnosticKeyword(validator.errors?.[0]?.keyword ?? ""), dialect: composioWatchSchemaDiagnosticDialect(optionalObject(validator.schema)?.$schema), ...context }, field);
}
function compileCalendarOutput(value: unknown, operation: ComposioCalendarRead["kind"]): ValidateFunction {
  let normalized: ReturnType<typeof normalizeComposioCalendarOutputSchema>;
  try { normalized = normalizeComposioCalendarOutputSchema(value); }
  catch (error) {
    if (!(error instanceof ComposioCalendarOutputSchemaError)) throw error;
    throw new ComposioCalendarContractError("read_response", "unsupported", { keyword: error.keyword, dialect: composioWatchSchemaDiagnosticDialect(optionalObject(value)?.$schema), rejectionReason: error.failure === "expansion_limit" ? "schema_limit" : "schema_structure", work: error.work, operation, direction: "output", referenceFailure: error.failure });
  }
  // Never silently discard an unused unsafe definition or interpret its metadata
  // as another schema. All semantic targets pass the unchanged restricted subset.
  if (normalized.audit !== undefined) compile(normalized.audit, "read_response", undefined, { operation, direction: "output" });
  return compile(normalized.schema, "read_response", undefined, { operation, direction: "output" });
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
  const validator = compile(tool.inputSchema, "search", undefined, { direction: "input" });
  if (!validator(args)) return validationFailure("search", validator, { direction: "input" });
  return args;
}
export function buildCalendarSchemasRequest(metadata: readonly SubagentMcpRemoteTool[], sessionId?: string) {
  const tool = uniqueTool(metadata, SCHEMAS);
  if (optionalObject(tool.annotations)?.readOnlyHint !== true) return fail("schemas", "unsupported");
  const args = { tool_slugs: [...CALENDAR_SCHEMA_SLUGS], ...(property(tool.inputSchema, "include") ? { include: ["input_schema", "output_schema"] } : {}), ...sessionArgs(tool.inputSchema, sessionId) };
  const validator = compile(tool.inputSchema, "schemas", undefined, { direction: "input" });
  if (!validator(args)) return validationFailure("schemas", validator, { direction: "input" });
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
  const executeValidator = compile(executorInput, "executor", "executor_input", { direction: "input" });
  const executorOutputSource: ComposioCalendarExecutorOutputSource = executor.outputSchema === undefined ? "host_contract" : "declared";
  const hostOutputValidator = compile(HOST_EXECUTOR_OUTPUT, "executor", "executor_output", { direction: "output" });
  const executorOutputValidator = executor.outputSchema === undefined ? undefined : compile(executor.outputSchema, "executor", "executor_output", { direction: "output" });
  const data = calendarContractData(response);
  if (data.success !== true || (data.not_found !== undefined && (!Array.isArray(data.not_found) || data.not_found.length))) return fail("schemas", "missing");
  const definitions = calendarContractObject(data.tool_schemas);
  if (Object.keys(definitions).length !== CALENDAR_SCHEMA_SLUGS.length || Object.keys(definitions).some((slug) => !CALENDAR_SCHEMA_SLUGS.includes(slug as typeof CALENDAR_SCHEMA_SLUGS[number]))) return fail("schemas", "missing");
  const validators = new Map<string, ValidateFunction>();
  const outputValidators = new Map<string, ValidateFunction>();
  const hashes: string[] = [];
  for (const [index, slug] of CALENDAR_SCHEMA_SLUGS.entries()) {
    const definition = calendarContractObject(definitions[slug]);
    if (definition.tool_slug !== slug || typeof definition.toolkit !== "string" || !/^[A-Za-z]+$/u.test(definition.toolkit) || definition.toolkit.toLowerCase() !== "googlecalendar" || definition.hasFullSchema === false || definition.schemaRef !== undefined) return fail("schemas", "invalid");
    const input = calendarContractObject(definition.input_schema), output = calendarContractObject(definition.output_schema);
    if (output.type !== "object" || !optionalObject(output.properties)) return fail("schemas", "unsupported");
    const operation = (["listCalendars", "listEvents", "getEvent"] as const)[index]!;
    validators.set(slug, compile(input, "read_arguments", undefined, { operation, direction: "input" }));
    outputValidators.set(slug, compileCalendarOutput(output, operation));
    hashes.push(digest({ input, output }));
  }
  const contract: ComposioCalendarContract = { revision: "composio-calendar-v1", executorSchemaHash: digest({ input: executor.inputSchema, output: executor.outputSchema ?? null, outputSource: executorOutputSource, hostOutputVersion: HOST_EXECUTOR_OUTPUT_VERSION, hostOutput: HOST_EXECUTOR_OUTPUT }), readSchemaHashes: { listCalendars: hashes[0]!, listEvents: hashes[1]!, getEvent: hashes[2]! } };
  if (expected && digest(expected) !== digest(contract)) return fail("schema_drift", "changed");
  Object.freeze(contract.readSchemaHashes); Object.freeze(contract);
  const validateExecutorOutput = (response: unknown, operation?: ComposioCalendarRead["kind"]): void => {
    const action = calendarContractExecutorAction(response);
    if (!hostOutputValidator(action)) return validationFailure("executor", hostOutputValidator, { ...(operation ? { operation } : {}), direction: "output", executorResponse: executorResponseFacts(action, response) }, "executor_output");
    if (executorOutputValidator && !executorOutputValidator(action)) return validationFailure("executor", executorOutputValidator, { ...(operation ? { operation } : {}), direction: "output", executorResponse: executorResponseFacts(action, response) }, "executor_output");
    const data = calendarContractObject(action.data), result = calendarContractObject((data.results as unknown[])[0]);
    if (data.error_count === 1 && !(result.error as string).trim()) return fail("executor", "invalid", "executor_output");
  };
  return Object.freeze({
    contract,
    executorOutputSource,
    request(read: ComposioCalendarRead, sessionId?: string) {
      const args = buildComposioCalendarExecutorRequest(read);
      const item = args.tools[0];
      const validator = validators.get(item.tool_slug)!;
      if (!validator(item.arguments)) return validationFailure("read_arguments", validator, { operation: read.kind, direction: "input" });
      const result = { ...args, ...sessionArgs(executorInput, sessionId) };
      if (!executeValidator(result)) return validationFailure("executor", executeValidator, { operation: read.kind, direction: "input" }, "executor_input");
      return result;
    },
    /** Includes genuine failed items; their account semantics remain a separate
     * strict negative oracle. Compile eligibility is checked BEFORE any send. */
    executorResponse(response: unknown): void {
      validateExecutorOutput(response);
    },
    response(read: ComposioCalendarRead, response: unknown): void {
      validateExecutorOutput(response, read.kind);
      const item = buildComposioCalendarExecutorRequest(read).tools[0];
      const upstream = parseComposioCalendarExecutorResponse(boundedCalendarContractJson(response), read);
      const validator = outputValidators.get(item.tool_slug)!;
      if (!validator(upstream)) return validationFailure("read_response", validator, { operation: read.kind, direction: "output" });
    },
  });
}
