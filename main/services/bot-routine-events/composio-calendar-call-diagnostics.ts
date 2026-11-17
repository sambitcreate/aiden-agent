// Private failure facts only. Never retain error messages/data or response values.
import { types as utilTypes } from "node:util";
import { McpAbortError, McpAuthRequiredError, McpConnectionClosedError, McpError, McpHttpError, McpSessionExpiredError, McpTimeoutError } from "@earendil-works/pi-mcp";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";

type ValueType = "missing" | "null" | "object" | "array" | "string" | "number" | "boolean" | "other";
type CallStage = "admission" | "send" | "reply" | "validation";
type ErrorTextCategory = "account_not_found" | "auth_or_permission" | "invalid_arguments" | "other" | "missing";
export interface ComposioCalendarReadFailure {
  /** Send means the RPC request was entered, not proof of a remote effect. */
  stage: CallStage;
  validation?: "mcp" | "calendar";
  error: { category: "rpc" | "auth" | "session" | "http" | "timeout" | "closed" | "abort" | "syntax" | "error" | "other"; rpcCode?: "parse_error" | "invalid_request" | "method_not_found" | "invalid_params" | "internal_error" | "server_error" | "other_integer" | "missing_or_invalid"; rpcErrorDataPresent?: boolean; textCategory: ErrorTextCategory };
  reply?: {
    bounded: boolean;
    value: ValueType;
    isError?: "missing" | "true" | "false" | "other";
    content?: ValueType;
    contentCount?: number;
    structuredContent?: ValueType;
    firstContent?: { value: ValueType; typeIsText: boolean; text: ValueType; textJson: "missing" | "valid" | "invalid" | "excessive" };
    actionSource?: "structured" | "text_json" | "direct";
    action?: Record<"successful" | "error" | "data", ValueType>;
    data?: Record<"results" | "total_count" | "success_count" | "error_count", ValueType>;
    firstResult?: Record<"value" | "tool_slug" | "index" | "error" | "response", ValueType>;
    errorTextCategory?: ErrorTextCategory;
  };
}
const failures = new WeakMap<object, ComposioCalendarReadFailure>();
const bounds = { maxNodes: 12_000, maxDepth: 18, maxSize: 256 * 1024, measure: utf8Size };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const valueType = (value: unknown): ValueType => value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : ["object", "string", "number", "boolean"].includes(typeof value) ? typeof value as ValueType : "other";
const fields = <K extends string>(value: unknown, keys: readonly K[]): Record<K, ValueType> => Object.fromEntries(keys.map((key) => [key, valueType(object(value) ? value[key] : undefined)])) as Record<K, ValueType>;
function bounded(value: unknown): unknown {
  const copy = copyBoundedJson(value, bounds);
  return copy === undefined || Buffer.byteLength(JSON.stringify(copy), "utf8") > bounds.maxSize ? undefined : copy;
}
function errorTextCategory(value: unknown): ErrorTextCategory {
  if (typeof value !== "string") return "missing";
  if (value.length > 4_096) return "other";
  const text = value.replace(/_/gu, " ");
  if (/\baccount\b.{0,80}(?:not found|does not exist)|\bunknown\b.{0,40}\baccount\b|\bno\b.{0,80}\baccount\b.{0,40}\bfound\b|\bno active connection\b/iu.test(text)) return "account_not_found";
  if (/\bauth(?:entication|orization)?\b|\bunauthorized\b|\bforbidden\b|\bpermission\b/iu.test(text)) return "auth_or_permission";
  if (/invalid (?:params|parameters|arguments)|(?:missing|required|unexpected).{0,40}(?:argument|parameter|field)|validation/iu.test(text)) return "invalid_arguments";
  return "other";
}
function replyFacts(value: unknown): NonNullable<ComposioCalendarReadFailure["reply"]> {
  const copy = bounded(value);
  if (copy === undefined) return { bounded: false, value: valueType(value) };
  const result: NonNullable<ComposioCalendarReadFailure["reply"]> = { bounded: true, value: valueType(copy) };
  if (!object(copy)) return result;
  result.isError = copy.isError === undefined ? "missing" : copy.isError === true ? "true" : copy.isError === false ? "false" : "other";
  result.content = valueType(copy.content); result.structuredContent = valueType(copy.structuredContent);
  let parsed: unknown;
  if (Array.isArray(copy.content)) {
    result.contentCount = Math.min(copy.content.length, 65);
    if (copy.content.length) {
      const first = copy.content[0]; let textJson: "missing" | "valid" | "invalid" | "excessive" = "missing";
      if (object(first) && typeof first.text === "string") {
        try { parsed = bounded(JSON.parse(first.text)); textJson = parsed === undefined ? "excessive" : "valid"; } catch { textJson = "invalid"; }
      }
      result.firstContent = { value: valueType(first), typeIsText: object(first) && first.type === "text", text: valueType(object(first) ? first.text : undefined), textJson };
    }
  }
  const action = copy.structuredContent !== undefined ? copy.structuredContent : parsed !== undefined ? parsed : copy;
  result.actionSource = copy.structuredContent !== undefined ? "structured" : parsed !== undefined ? "text_json" : "direct";
  result.action = fields(action, ["successful", "error", "data"]);
  const data = object(action) ? action.data : undefined;
  result.data = fields(data, ["results", "total_count", "success_count", "error_count"]);
  const first = object(data) && Array.isArray(data.results) ? data.results[0] : undefined;
  result.firstResult = { value: valueType(first), ...fields(first, ["tool_slug", "index", "error", "response"]) };
  const firstContent = Array.isArray(copy.content) ? copy.content[0] : undefined;
  // A malformed plain-text reply may omit isError. Classification is diagnostic
  // only and never contributes to the strict account-selection oracle.
  result.errorTextCategory = errorTextCategory(object(first) && typeof first.error === "string" ? first.error : object(action) && typeof action.error === "string" ? action.error : object(firstContent) ? firstContent.text : undefined);
  return result;
}
function errorFacts(error: unknown): ComposioCalendarReadFailure["error"] {
  if (error !== null && (typeof error === "object" || typeof error === "function") && utilTypes.isProxy(error)) return { category: "other", textCategory: "missing" };
  const descriptor = error !== null && (typeof error === "object" || typeof error === "function") ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
  const textCategory = errorTextCategory(descriptor && "value" in descriptor ? descriptor.value : undefined);
  if (error instanceof McpError) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code"), code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    const data = Object.getOwnPropertyDescriptor(error, "data");
    const rpcCode = code === -32700 ? "parse_error" : code === -32600 ? "invalid_request" : code === -32601 ? "method_not_found" : code === -32602 ? "invalid_params" : code === -32603 ? "internal_error" : Number.isSafeInteger(code) ? code >= -32099 && code <= -32000 ? "server_error" : "other_integer" : "missing_or_invalid";
    return { category: "rpc", rpcCode, rpcErrorDataPresent: !!data && "value" in data && data.value !== undefined, textCategory };
  }
  if (error instanceof McpAuthRequiredError) return { category: "auth", textCategory };
  if (error instanceof McpSessionExpiredError) return { category: "session", textCategory };
  if (error instanceof McpHttpError) return { category: "http", textCategory };
  if (error instanceof McpTimeoutError) return { category: "timeout", textCategory };
  if (error instanceof McpConnectionClosedError) return { category: "closed", textCategory };
  const name = error !== null && (typeof error === "object" || typeof error === "function") ? Object.getOwnPropertyDescriptor(error, "name") : undefined;
  if (error instanceof McpAbortError || name && "value" in name && name.value === "AbortError") return { category: "abort", textCategory };
  if (error instanceof SyntaxError) return { category: "syntax", textCategory };
  return { category: error instanceof Error ? "error" : "other", textCategory };
}
function project(error: unknown, stage: CallStage, reply?: unknown, validation?: ComposioCalendarReadFailure["validation"]): ComposioCalendarReadFailure {
  return { stage, ...(validation ? { validation } : {}), error: errorFacts(error), ...(reply !== undefined || stage === "reply" || stage === "validation" ? { reply: replyFacts(reply) } : {}) };
}
export function composioCalendarReadFailure(error: unknown, stage: CallStage, reply?: unknown, validation?: ComposioCalendarReadFailure["validation"]): ComposioCalendarReadFailure {
  const previous = error !== null && (typeof error === "object" || typeof error === "function") ? failures.get(error) : undefined;
  return previous ? structuredClone(previous) : project(error, stage, reply, validation);
}
/** Preserve real error identity/classification; only primitive throws need a safe carrier. */
export function recordComposioCalendarReadFailure(error: unknown, stage: CallStage, reply?: unknown, validation?: ComposioCalendarReadFailure["validation"]): unknown {
  const facts = project(error, stage, reply, validation);
  const carrier = error !== null && (typeof error === "object" || typeof error === "function") ? error : new Error("Calendar read failed.");
  failures.set(carrier, facts); return carrier;
}
