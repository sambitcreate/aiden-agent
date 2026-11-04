// Calendar OUTPUT validation only. Semantic readers always receive the original
// response. New semantic/guard fields require reviewing this protected policy.
import { copyBoundedJson, utf8Size } from "../bounded-json.js";

export const CALENDAR_OUTPUT_COMPATIBILITY_VERSION = "optional-null-page-records-v4";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const PROTECTED = new Set([
  // Semantic identities, display/occurrence fields and action representations.
  "id", "accountId", "calendarId", "eventId", "accessRole", "status", "deleted", "summary", "title", "description", "location",
  "start", "end", "date", "dateTime", "timeZone", "recurringEventId", "originalStartTime", "recurrence",
  "successful", "error", "data", "items", "results", "response", "tool_slug", "index", "total_count", "success_count", "error_count",
  "content", "structuredContent", "isError", "session", "session_id", "log_id", "toolkit", "accounts", "has_active_connection", "user_info",
  // Every existing partial/offload/page guard and known continuation variant.
  "remote_file_info", "remoteFileInfo", "truncated", "has_more", "hasMore", "nextCursor", "next_cursor", "nextPageToken", "next_page_token", "nextSyncToken", "next_sync_token",
  "correlation", "correlations", "correlation_id", "correlation_ids", "correlation_key", "correlation_keys", "correlation_token", "correlation_tokens", "correlation_index", "correlation_indices",
  "constructor", "prototype", "__proto__",
].map((key) => key.replace(/_/gu, "").toLowerCase()));
const PROTECTED_WORDS = new Set([
  "id", "ids", "uid", "uuid", "identifier", "identifiers", "account", "calendar", "event", "slug", "session",
  "cursor", "token", "page", "pagination", "continuation", "next", "sync", "partial", "truncated", "offload", "remote", "count", "error", "success", "status",
  "start", "starts", "end", "ends", "date", "time", "timestamp", "summary", "title", "description", "location", "access", "role", "recurrence", "recurring", "original",
  "permission", "auth", "credential", "scope", "grant", "default", "cancelled", "canceled", "signature", "baseline", "history",
  // Explicit common plurals, not stemming: these remain semantic/authority
  // metadata even when the current consumer only reads the singular form.
  "accounts", "calendars", "events", "slugs", "sessions", "cursors", "tokens", "pages", "continuations", "partials", "offloads", "counts", "errors", "successes", "statuses",
  "dates", "times", "timestamps", "summaries", "titles", "descriptions", "locations", "accesses", "roles", "recurrences", "originals",
  "permissions", "credentials", "scopes", "grants", "defaults", "signatures", "baselines", "histories",
  "item", "items", "response", "responses", "result", "results", "index", "indexes", "indices", "tool", "tools", "toolkit", "toolkits",
  "correlation", "correlations", "correlated", "correlator", "correlators",
]);
const PROTECTED_LITERALS = [...new Set([...PROTECTED, ...PROTECTED_WORDS])];
const FIELD_KEYS = new Set(["type", "minLength", "maxLength", "title", "description", "default", "examples", "deprecated", "$comment"]);
function eligibleName(key: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(key)) return false;
  const lower = key.toLowerCase(), flat = lower.replace(/_/gu, "");
  if (PROTECTED.has(flat) || PROTECTED_WORDS.has(flat) || lower.split("_").some((word) => PROTECTED.has(word) || PROTECTED_WORDS.has(word))) return false;
  // Literal denial is deliberately conservative, including incidental matches
  // such as "vendor" containing "end". Never infer camel-case word boundaries.
  return !PROTECTED_LITERALS.some((term) => flat.includes(term));
}
function simpleObjectSchema(schema: unknown): ObjectValue | undefined {
  const value = object(schema);
  if (!value || value.type !== "object" || !object(value.properties) ||
      ["anyOf", "oneOf", "allOf", "enum", "const", "minProperties", "maxProperties"].some((key) => value[key] !== undefined) ||
      (value.required !== undefined && !Array.isArray(value.required))) return undefined;
  return value;
}
function optionalPlainString(schema: ObjectValue, key: string): boolean {
  const properties = object(schema.properties)!;
  if (!own(properties, key) || (schema.required as unknown[] | undefined)?.includes(key)) return false;
  const field = object(properties[key]);
  return !!field && field.type === "string" && !Object.keys(field).some((keyword) => !FIELD_KEYS.has(keyword)) && (!own(field, "default") || field.default === null);
}
function omitInertNulls(value: ObjectValue, schema: ObjectValue): void {
  for (const key of Object.keys(value)) {
    if (value[key] === null && optionalPlainString(schema, key) && eligibleName(key)) delete value[key];
  }
}
const COLLECTIONS = ["items", "calendars", "calendarList", "calendar_list", "events"] as const;
function pageContext(root: ObjectValue, schema: ObjectValue): { value: ObjectValue; schema: ObjectValue } | undefined {
  if (root.successful === undefined && root.error === undefined && root.data === undefined) return { value: root, schema };
  const data = object(root.data), dataSchema = simpleObjectSchema(object(schema.properties)?.data);
  if (root.successful === true && (root.error === undefined || root.error === null || root.error === "") && root.id === undefined && !COLLECTIONS.some((key) => own(root, key)) && data && dataSchema) return { value: data, schema: dataSchema };
  return undefined;
}
function declaredCalendars(value: ObjectValue, schema: ObjectValue): boolean {
  const collections = COLLECTIONS.filter((key) => own(value, key));
  return collections.length === 1 && collections[0] === "calendars" && Array.isArray(value.calendars) && object(object(schema.properties)?.calendars)?.type === "array";
}
function omitNullPageEnd(value: ObjectValue, schema: ObjectValue, operation: "listCalendars" | "listEvents"): void {
  const collections = COLLECTIONS.filter((key) => own(value, key));
  if (!(collections.length === 1 && collections[0] === "items" && Array.isArray(value.items)) && !(operation === "listCalendars" && declaredCalendars(value, schema))) return;
  for (const key of ["nextPageToken", "next_page_token"]) if (value[key] === null && optionalPlainString(schema, key)) delete value[key];
}
const ARRAY_KEYS = new Set(["type", "items", "minItems", "maxItems", "title", "description", "default", "examples", "deprecated", "$comment"]);
function omitPageRecordNulls(value: ObjectValue, schema: ObjectValue, operation: "listCalendars" | "listEvents"): void {
  const collections = COLLECTIONS.filter((key) => own(value, key));
  if (collections.length !== 1) return;
  const key = collections[0]!;
  if (key !== "items" && !(operation === "listCalendars" && key === "calendars" && declaredCalendars(value, schema))) return;
  const records = value[key], array = object(object(schema.properties)?.[key]);
  if (!Array.isArray(records) || !array || array.type !== "array" || Object.keys(array).some((keyword) => !ARRAY_KEYS.has(keyword)) || (own(array, "default") && array.default !== null)) return;
  const itemSchema = simpleObjectSchema(array.items);
  if (!itemSchema || (own(itemSchema, "default") && itemSchema.default !== null)) return;
  // Array entries, length/order and nested values remain untouched. The original
  // array's min/max/unique constraints still run in the unchanged validator.
  for (const entry of records) { const record = object(entry); if (record) omitInertNulls(record, itemSchema); }
}
function bounded(value: unknown): unknown {
  const copy = copyBoundedJson(value, { maxNodes: 12_000, maxDepth: 18, maxSize: 256 * 1024, measure: utf8Size });
  if (copy === undefined || Buffer.byteLength(JSON.stringify(copy), "utf8") > 256 * 1024) throw new Error("Calendar output exceeded validation bounds.");
  return copy;
}
/** Call only AFTER the original output schema and every unused definition have
 * passed restricted compilation/audit. No defaults or schema edits are applied.
 * Only direct records of a declared simple page array receive record metadata
 * compatibility; their nested objects/arrays and all whole entries stay intact. */
export function calendarOutputValidationCopy(compiledSchema: unknown, response: unknown, operation?: "listCalendars" | "listEvents" | "getEvent"): unknown {
  const schema = simpleObjectSchema(bounded(compiledSchema)), copy = bounded(response), root = object(copy);
  if (!schema || !root) return copy;
  omitInertNulls(root, schema);
  const data = own(root, "data") ? object(root.data) : undefined;
  const dataSchema = simpleObjectSchema(object(schema.properties)?.data);
  if (data && dataSchema) omitInertNulls(data, dataSchema);
  if (operation === "listCalendars" || operation === "listEvents") {
    // These are exactly the two page representations consumed by the semantic
    // reader. It still receives the original cursors, including null/conflicts.
    const page = pageContext(root, schema);
    if (page) { omitNullPageEnd(page.value, page.schema, operation); omitPageRecordNulls(page.value, page.schema, operation); }
  }
  return copy;
}
/** The only additional collection is the observed LIST_CALENDARS array, and
 * only an explicit current array declaration can authorize that representation.
 * Call after the unchanged output validator; no aliases/defaults are supplied. */
export function calendarOutputRepresentationAllowed(compiledSchema: unknown, response: unknown, operation: "listCalendars" | "listEvents" | "getEvent"): boolean {
  const root = object(bounded(response)), schema = simpleObjectSchema(bounded(compiledSchema));
  if (!root) return false;
  const data = object(root.data);
  const aliasPresent = [root, ...(data ? [data] : [])].some((value) => COLLECTIONS.slice(1).some((key) => own(value, key)));
  if (!aliasPresent) return true;
  if (operation !== "listCalendars" || !schema) return false;
  const page = pageContext(root, schema);
  return !!page && declaredCalendars(page.value, page.schema);
}
