// Foreground catalog inspection only. Nothing here can execute an app operation,
// manage a connection, disclose vendor prose, or enable a connector watch.
import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import { connectorWatchJson } from "./connector-watch-imcp.js";
import { connectorTextIsWellFormed } from "./connector-text.js";

export type ComposioWatchProbeKind = "email" | "calendar";
export type ComposioWatchProbeTool = "COMPOSIO_SEARCH_TOOLS" | "COMPOSIO_GET_TOOL_SCHEMAS";
type RecordValue = Record<string, unknown>;
export interface ComposioWatchProbePort {
  /** Constructed only by an explicit host foreground action, never a Bot or poll. */
  readonly foreground: true;
  /** Revalidate the one Composio service grant and owning foreground document. */
  assertCurrent(signal: AbortSignal): Promise<void>;
  listTools(cursor: string | undefined, signal: AbortSignal): Promise<{ tools: readonly unknown[]; nextCursor?: string | null }>;
  /** The host must also fence the actual send, and honor cancellation/deadlines. */
  call(tool: ComposioWatchProbeTool, args: RecordValue, signal: AbortSignal): Promise<unknown>;
}

const SEARCH = "COMPOSIO_SEARCH_TOOLS";
const SCHEMAS = "COMPOSIO_GET_TOOL_SCHEMAS";
const EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CANDIDATES = {
  email: ["GMAIL_GET_PROFILE", "GMAIL_LIST_LABELS", "GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_LIST_HISTORY"],
  calendar: ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET", "GOOGLECALENDAR_EVENTS_INSTANCES"],
} as const;
const QUERIES: Record<ComposioWatchProbeKind, string> = {
  email: "Find read-only Gmail tools for profile and label IDs, message IDs and header metadata, and mailbox change history.",
  calendar: "Find read-only Google Calendar tools for calendar IDs, timed events in a time window, an event by ID, and recurring event instances.",
};
const FIELD_NAMES = new Set(["account", "connected_account_id", "user_id", "query", "label_ids", "ids_only", "include_payload", "verbose", "page_token", "max_results", "message_id", "format", "start_history_id", "history_types", "label_id", "calendarId", "timeMin", "timeMax", "timeZone", "singleEvents", "showDeleted", "maxResults", "pageToken", "syncToken", "fields", "eventId", "originalStart", "calendar_id", "event_id"]);
const MAX_REPLY_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_PAGES = 4;
const MAX_TOOLS = 128;
const TIMEOUT_MS = 15_000;

export type ComposioWatchProbeCode = "account_routing_unverified" | "foreground_required" | "unsupported_request" | "access_changed" | "cancelled" | "timed_out" | "invalid_inventory" | "unsupported_meta_schema" | "tool_failed" | "invalid_response" | "schemas_incomplete" | "no_matching_tools" | "limit_exceeded" | "inspection_failed";
export interface ComposioWatchProbePrivateProof {
  revision: "composio-watch-inspection-v1";
  meta: { tool: ComposioWatchProbeTool; schemaHash: string; readOnlyHint: boolean | null }[];
  /** These are declarations only; none proves selector semantics. */
  accountDeclarations: { executor: boolean; executorItem: boolean; upstream: boolean };
  candidates: {
    kind: ComposioWatchProbeKind;
    slug: string;
    inputSchemaHash: string;
    outputSchemaHash?: string;
    /** Known vocabulary only; unknown keys, examples and defaults are never retained. */
    inputFields: string[];
  }[];
  activeConnectionReported: { email: boolean; calendar: boolean };
}
export interface ComposioWatchProbeResult {
  available: false;
  checkedAt: number;
  status: "inspected" | "unavailable" | "cancelled";
  code: ComposioWatchProbeCode;
  /** Host-private structural evidence. Never send this object to a renderer or phone. */
  privateProof?: ComposioWatchProbePrivateProof;
}
export interface ComposioWatchProbePublicResult {
  available: false;
  checkedAt: number;
  status: ComposioWatchProbeResult["status"];
  code: ComposioWatchProbeCode;
  message: string;
}
const CODES = new Set<ComposioWatchProbeCode>(["account_routing_unverified", "foreground_required", "unsupported_request", "access_changed", "cancelled", "timed_out", "invalid_inventory", "unsupported_meta_schema", "tool_failed", "invalid_response", "schemas_incomplete", "no_matching_tools", "limit_exceeded", "inspection_failed"]);

/** Deliberately copies a closed public view instead of redacting arbitrary metadata. */
export function publicComposioWatchProbeResult(result: ComposioWatchProbeResult): ComposioWatchProbePublicResult {
  const code = CODES.has(result.code) ? result.code : "inspection_failed";
  const status = code === "account_routing_unverified" ? "inspected" : code === "cancelled" ? "cancelled" : "unavailable";
  return { available: false, checkedAt: Number.isSafeInteger(result.checkedAt) && result.checkedAt >= 0 ? result.checkedAt : 0, status, code,
    message: status === "inspected"
      ? "Composio’s watch schemas were inspected. Exact account routing is not verified, so these watches remain unavailable."
      : status === "cancelled" ? "Composio inspection was cancelled."
        : "Composio’s watch schema information is unavailable. Review its existing setup on this computer and try again." };
}

class ProbeFailure extends Error {
  constructor(readonly code: ComposioWatchProbeCode) { super("Composio watch inspection could not be completed."); }
}
function fail(code: ComposioWatchProbeCode): never { throw new ProbeFailure(code); }
function record(value: unknown, code: ComposioWatchProbeCode = "invalid_response"): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(code);
  return value as RecordValue;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || !connectorTextIsWellFormed(value)) return fail("invalid_response");
  return value;
}
function strings(value: unknown, max = 32): string[] {
  if (!Array.isArray(value) || value.length > max) return fail("invalid_response");
  return value.map((item) => text(item, 4096));
}
function complete(value: RecordValue): void {
  for (const key of ["nextCursor", "next_cursor", "nextPageToken", "next_page_token", "has_more", "hasMore", "truncated", "remote_file_info", "remoteFileInfo"]) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== false && value[key] !== "") fail("invalid_response");
  }
}
function hash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

// Only a bounded, understood JSON Schema subset is compiled. In particular,
// no remote references, arbitrary regular expressions or custom formats run.
const SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "allOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "title", "description", "default", "examples", "deprecated", "$comment"]);
function metaValidator(schema: unknown): ValidateFunction {
  let nodes = 0;
  const inspect = (value: unknown, depth = 0): void => {
    if (++nodes > 512 || depth > 12) fail("unsupported_meta_schema");
    if (typeof value === "boolean") return;
    const part = record(value, "unsupported_meta_schema");
    if (Object.keys(part).some((key) => !SCHEMA_KEYS.has(key))) fail("unsupported_meta_schema");
    if (part.properties !== undefined) for (const child of Object.values(record(part.properties, "unsupported_meta_schema"))) inspect(child, depth + 1);
    for (const key of ["items", "additionalProperties"] as const) if (part[key] !== undefined) inspect(part[key], depth + 1);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) if (part[key] !== undefined) {
      if (!Array.isArray(part[key]) || part[key].length > 8) fail("unsupported_meta_schema");
      for (const child of part[key]) inspect(child, depth + 1);
    }
  };
  try {
    inspect(schema);
    const root = record(schema, "unsupported_meta_schema");
    if (root.type !== "object" || !root.properties) fail("unsupported_meta_schema");
    const ajv = new Ajv({ strict: false, allErrors: false, validateSchema: true });
    return ajv.compile(root);
  } catch { return fail("unsupported_meta_schema"); }
}
function property(schema: unknown, name: string): RecordValue | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const properties = (schema as RecordValue).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const value = (properties as RecordValue)[name];
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function supportsString(schema: unknown, name: string, value: string): boolean {
  const field = property(schema, name);
  return field?.type === "string" && (field.enum === undefined || Array.isArray(field.enum) && field.enum.includes(value));
}

export async function inspectComposioWatchSchemas(port: ComposioWatchProbePort, options: {
  kind: ComposioWatchProbeKind | "both";
  signal?: AbortSignal;
  /** A host test seam; callers cannot extend the fixed foreground deadline. */
  timeoutMs?: number;
  now?: () => number;
}): Promise<ComposioWatchProbeResult> {
  const checkedAt = (options.now ?? Date.now)();
  const result = (code: ComposioWatchProbeCode, privateProof?: ComposioWatchProbePrivateProof): ComposioWatchProbeResult => ({ available: false, checkedAt,
    status: code === "account_routing_unverified" ? "inspected" : code === "cancelled" ? "cancelled" : "unavailable", code, ...(privateProof ? { privateProof } : {}) });
  if (port.foreground !== true) return result("foreground_required");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!["email", "calendar", "both"].includes(options.kind) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) return result("unsupported_request");
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(new ProbeFailure("cancelled"));
  if (options.signal?.aborted) onParentAbort();
  else options.signal?.addEventListener("abort", onParentAbort, { once: true });
  let rejectAbort!: (error: ProbeFailure) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason instanceof ProbeFailure ? controller.signal.reason : new ProbeFailure("cancelled"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new ProbeFailure("timed_out")), timeoutMs);
  let totalBytes = 0;
  const bounded = (value: unknown): unknown => {
    const copy = copyBoundedJson(value, { maxNodes: 12_000, maxDepth: 18, maxSize: MAX_REPLY_BYTES, measure: utf8Size });
    if (copy === undefined) return fail("limit_exceeded");
    const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8");
    totalBytes += bytes;
    if (bytes > MAX_REPLY_BYTES || totalBytes > MAX_TOTAL_BYTES) fail("limit_exceeded");
    return copy;
  };
  const current = async () => {
    controller.signal.throwIfAborted();
    try { await port.assertCurrent(controller.signal); } catch { controller.signal.throwIfAborted(); fail("access_changed"); }
    controller.signal.throwIfAborted();
  };
  type Meta = { schema: RecordValue; validate?: ValidateFunction; readOnlyHint: boolean | null };
  const inventory = async (): Promise<Map<string, Meta>> => {
    const selected = new Map<string, Meta>(); const seen = new Set<string>(); const cursors = new Set<string>();
    let cursor: string | undefined; let toolCount = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      await current();
      const response = record(bounded(await port.listTools(cursor, controller.signal)), "invalid_inventory");
      await current();
      if (!Array.isArray(response.tools) || (toolCount += response.tools.length) > MAX_TOOLS) fail("invalid_inventory");
      for (const entry of response.tools) {
        const tool = record(entry, "invalid_inventory"); const name = text(tool.name, 128);
        if (seen.has(name)) fail("invalid_inventory"); seen.add(name);
        if (![SEARCH, SCHEMAS, EXECUTE].includes(name)) continue;
        const schema = record(tool.inputSchema, "unsupported_meta_schema");
        const annotations = tool.annotations === undefined ? {} : record(tool.annotations, "invalid_inventory");
        if (annotations.readOnlyHint !== undefined && typeof annotations.readOnlyHint !== "boolean") fail("invalid_inventory");
        if (name !== EXECUTE) {
          if (annotations.readOnlyHint === false) fail("unsupported_meta_schema");
          selected.set(name, { schema, validate: metaValidator(schema), readOnlyHint: typeof annotations.readOnlyHint === "boolean" ? annotations.readOnlyHint : null });
        } else selected.set(name, { schema, readOnlyHint: typeof annotations.readOnlyHint === "boolean" ? annotations.readOnlyHint : null });
      }
      if (response.nextCursor === undefined || response.nextCursor === null || response.nextCursor === "") return selected;
      cursor = text(response.nextCursor, 256);
      if (cursors.has(cursor)) fail("invalid_inventory"); cursors.add(cursor);
    }
    return fail("invalid_inventory");
  };
  const call = async (name: ComposioWatchProbeTool, metadata: Map<string, Meta>, build: (schema: RecordValue) => RecordValue): Promise<RecordValue> => {
    const meta = metadata.get(name); if (!meta?.validate) return fail("unsupported_meta_schema");
    const args = build(meta.schema);
    if (!meta.validate(args)) fail("unsupported_meta_schema");
    await current();
    let raw: unknown;
    try { raw = await port.call(name, args, controller.signal); } catch { controller.signal.throwIfAborted(); return fail("inspection_failed"); }
    await current();
    const envelope = record(bounded(raw));
    let value: RecordValue;
    try {
      // MCP permits structured-only results with an explicitly empty content list.
      if (Array.isArray(envelope.content) && envelope.content.length === 0 && envelope.structuredContent !== undefined) {
        const { content: _empty, ...structuredOnly } = envelope;
        value = record(connectorWatchJson(structuredOnly));
      } else value = record(connectorWatchJson(envelope));
    } catch { return fail("tool_failed"); }
    if (value.successful !== true || value.error !== undefined && value.error !== null && value.error !== "") return fail("tool_failed");
    complete(value); const data = record(value.data); complete(data); return data;
  };
  const run = async (): Promise<ComposioWatchProbeResult> => {
    const kinds: ComposioWatchProbeKind[] = options.kind === "both" ? ["email", "calendar"] : [options.kind];
    const metadata = await inventory();
    if (!metadata.has(SEARCH) || !metadata.has(SCHEMAS)) fail("unsupported_meta_schema");
    const search = await call(SEARCH, metadata, (schema) => {
      const queries = property(schema, "queries"); const item = queries?.items;
      if (queries?.type !== "array" || !supportsString(item, "use_case", QUERIES[kinds[0]!]) || property(schema, "session")?.type !== "object" || property(property(schema, "session"), "generate_id")?.type !== "boolean") return fail("unsupported_meta_schema");
      return { queries: kinds.map((kind) => ({ use_case: QUERIES[kind] })), session: { generate_id: true } };
    });
    if (!Array.isArray(search.results) || search.results.length !== kinds.length || !search.tool_schemas || !Array.isArray(search.toolkit_connection_statuses) || search.toolkit_connection_statuses.length > 16 || !search.time_info || !Array.isArray(search.next_steps_guidance)) fail("invalid_response");
    const searchSchemas = record(search.tool_schemas);
    if (Object.keys(searchSchemas).length > 64) fail("limit_exceeded");
    const session = record(search.session); const sessionId = text(session.id, 256);
    if (typeof session.generate_id !== "boolean" || typeof session.instructions !== "string") fail("invalid_response");
    const time = record(search.time_info);
    if (typeof time.current_time_utc !== "string" || !Number.isSafeInteger(time.current_time_utc_epoch_seconds) || typeof time.message !== "string") fail("invalid_response");
    strings(search.next_steps_guidance);
    const requested = new Map<string, ComposioWatchProbeKind>();
    for (const [index, kind] of kinds.entries()) {
      const entry = record(search.results[index]);
      if (entry.index !== index + 1 || typeof entry.use_case !== "string" || !Array.isArray(entry.toolkits) || typeof entry.reasoning !== "string" || typeof entry.task_difficulty !== "string" || entry.error !== undefined && entry.error !== null && entry.error !== "") fail("invalid_response");
      strings(entry.toolkits, 16);
      const returned = [...strings(entry.primary_tool_slugs), ...strings(entry.related_tool_slugs)];
      for (const slug of CANDIDATES[kind]) if (returned.includes(slug)) {
        if (!Object.prototype.hasOwnProperty.call(searchSchemas, slug)) fail("invalid_response");
        requested.set(slug, kind);
      }
    }
    if (!requested.size) return result("no_matching_tools");
    const activeConnectionReported = { email: false, calendar: false };
    const toolkitSeen = new Set<string>();
    for (const entry of search.toolkit_connection_statuses) {
      const status = record(entry); const toolkit = text(status.toolkit, 100);
      if (toolkitSeen.has(toolkit) || typeof status.has_active_connection !== "boolean" || !status.connection_details || typeof status.description !== "string" || typeof status.status_message !== "string") fail("invalid_response");
      record(status.connection_details);
      toolkitSeen.add(toolkit);
      if (toolkit === "gmail") activeConnectionReported.email = status.has_active_connection;
      if (toolkit === "googlecalendar") activeConnectionReported.calendar = status.has_active_connection;
    }
    const fresh = await inventory();
    const schemas = await call(SCHEMAS, fresh, (schema) => {
      const slugs = property(schema, "tool_slugs");
      if (slugs?.type !== "array" || (slugs.items as RecordValue | undefined)?.type !== "string") return fail("unsupported_meta_schema");
      const args: RecordValue = { tool_slugs: [...requested.keys()] };
      const include = property(schema, "include");
      if (include?.type === "array" && supportsString({ properties: { item: include.items } }, "item", "input_schema") && supportsString({ properties: { item: include.items } }, "item", "output_schema")) args.include = ["input_schema", "output_schema"];
      if (property(schema, "session_id")) {
        if (!supportsString(schema, "session_id", sessionId)) return fail("unsupported_meta_schema");
        args.session_id = sessionId;
      }
      return args;
    });
    if (schemas.success !== true || schemas.not_found !== undefined && strings(schemas.not_found).length) fail("schemas_incomplete");
    const definitions = record(schemas.tool_schemas);
    if (Object.keys(definitions).length !== requested.size || Object.keys(definitions).some((slug) => !requested.has(slug))) fail("schemas_incomplete");
    const candidates: ComposioWatchProbePrivateProof["candidates"] = [];
    for (const [slug, kind] of requested) {
      const definition = record(definitions[slug]);
      if (definition.tool_slug !== slug || definition.toolkit !== (kind === "email" ? "gmail" : "googlecalendar") || definition.hasFullSchema === false || definition.schemaRef !== undefined) fail("schemas_incomplete");
      const input = record(definition.input_schema);
      if (input.type !== "object" || !input.properties) fail("invalid_response");
      const properties = record(input.properties);
      const output = definition.output_schema === undefined ? undefined : record(definition.output_schema);
      candidates.push({ kind, slug, inputSchemaHash: hash(input), ...(output ? { outputSchemaHash: hash(output) } : {}), inputFields: Object.keys(properties).filter((field) => FIELD_NAMES.has(field)).sort() });
    }
    const executor = fresh.get(EXECUTE)?.schema;
    const executorItem = property(executor, "tools")?.items;
    const proof: ComposioWatchProbePrivateProof = { revision: "composio-watch-inspection-v1",
      meta: [SEARCH, SCHEMAS].map((tool) => { const meta = (tool === SEARCH ? metadata : fresh).get(tool)!; return { tool: tool as ComposioWatchProbeTool, schemaHash: hash(meta.schema), readOnlyHint: meta.readOnlyHint }; }),
      accountDeclarations: { executor: Boolean(property(executor, "account") || property(executor, "connected_account_id")), executorItem: Boolean(property(executorItem, "account") || property(executorItem, "connected_account_id")), upstream: candidates.some((entry) => entry.inputFields.includes("account") || entry.inputFields.includes("connected_account_id")) },
      candidates, activeConnectionReported };
    await current();
    return result("account_routing_unverified", proof);
  };
  try { return await Promise.race([run(), aborted]); }
  catch (error) { return result(error instanceof ProbeFailure ? error.code : controller.signal.aborted && controller.signal.reason instanceof ProbeFailure ? controller.signal.reason.code : "inspection_failed"); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onParentAbort); controller.signal.removeEventListener("abort", onAbort); }
}
