// Explicit foreground acceptance check only. No transport, credentials, saved
// authority, account creation, publication or production enablement lives here.
import { randomBytes } from "node:crypto";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import type { ComposioCalendarContract } from "./composio-calendar-host-port.js";
import { buildCalendarSchemasRequest, buildCalendarSearchRequest, calendarContractAction, calendarContractObject, ComposioCalendarContractError, verifyCalendarContract, type ComposioCalendarExecutorOutputSource } from "./composio-calendar-contract.js";
import { discoverComposioCalendarSources, normalizeComposioCalendarEventGet, parseComposioCalendarAccounts, readComposioCalendarWatch, type ComposioCalendarRead } from "./connector-watch-composio.js";
import { composioCalendarReadFailure, type ComposioCalendarReadFailure } from "./composio-calendar-call-diagnostics.js";

export const COMPOSIO_CALENDAR_READ_CHECK_CODES = ["verified", "get_proof_incomplete", "needs_account_selection", "no_active_account", "unsupported_contract", "invalid_account_unverified", "source_unavailable", "invalid_response", "limit_exceeded", "access_changed", "cancelled", "timed_out", "inspection_failed"] as const;
export type ComposioCalendarReadCheckCode = typeof COMPOSIO_CALENDAR_READ_CHECK_CODES[number];
type Stage = "inventory" | "search" | "schemas" | "account_selection" | "invalid_account" | "calendars" | "events" | "event_get" | "complete";
type Reason = "accepted" | "not_started" | "shape" | "missing" | "unsupported" | "invalid" | "changed" | "multiple_accounts" | "no_account" | "routing_unverified" | "no_readable_calendar" | "no_timed_event" | "limit" | "access_changed" | "cancelled" | "timed_out" | "failed";
type ValueType = "missing" | "null" | "object" | "array" | "string" | "number" | "boolean" | "other";
type NegativeBlock = "none" | "envelope" | "unexpected_action_field" | "unexpected_data_field" | "remote_file_info" | "counts" | "unexpected_result_field" | "correlation" | "response" | "error";
interface NegativeShape {
  blockedField: NegativeBlock;
  action: { successful: ValueType; data: ValueType; error: ValueType };
  data: { results: ValueType; resultCount?: number; totalCount?: number; successCount?: number; errorCount?: number };
  result: { value: ValueType; response: ValueType; error: ValueType; slugMatches: boolean; indexMatches: boolean; errorCategory: "exact_known" | "account_not_found_text" | "auth_or_permission" | "other" | "missing" };
}
export interface ComposioCalendarReadCheckProof {
  revision: "composio-calendar-read-check-v1";
  stage: Stage;
  reason: Reason;
  calls: { search: boolean; schemas: boolean; invalidAccount: boolean; calendars: number; events: number; get: boolean };
  counts: { activeAccounts: number; calendars: number; events: number; gets: number };
  invalidAccountRejected: boolean;
  contract?: ComposioCalendarContract;
  executorOutputSource?: ComposioCalendarExecutorOutputSource;
  negative?: NegativeShape;
  readFailure?: ComposioCalendarReadFailure;
  contractFailure?: { stage: ComposioCalendarContractError["stage"]; reason: ComposioCalendarContractError["reason"]; facts?: ComposioCalendarContractError["facts"]; field?: ComposioCalendarContractError["field"] };
}
export interface ComposioCalendarReadCheckPublicResult {
  available: false;
  checkedAt: number;
  status: "verified" | "unavailable" | "cancelled";
  code: ComposioCalendarReadCheckCode;
  message: string;
}
export interface ComposioCalendarReadCheckResult extends ComposioCalendarReadCheckPublicResult { privateProof: ComposioCalendarReadCheckProof }
export interface ComposioCalendarReadCheckPort {
  list(): Promise<readonly SubagentMcpRemoteTool[]>;
  call(tool: "COMPOSIO_SEARCH_TOOLS" | "COMPOSIO_GET_TOOL_SCHEMAS", args: Record<string, unknown>): Promise<unknown>;
  /** The real host privately owns a validator derived from its ACTUAL guarded
   * full-schema reply. Caller-supplied diagnostics/schemas cannot authorize it. */
  readCalendar?(read: ComposioCalendarRead, sessionId?: string): Promise<unknown>;
}
function message(code: ComposioCalendarReadCheckCode): string {
  if (code === "verified") return "Calendar's exact-account read check passed. Watch availability still requires the reviewed host integration.";
  if (code === "get_proof_incomplete") return "Calendar's event GET proof is incomplete because no eligible timed event was available. Calendar watches remain unavailable.";
  if (code === "needs_account_selection") return "More than one Calendar account is active. Choose an account before testing reads.";
  if (code === "no_active_account") return "No active Calendar account was returned. Review existing access in Composio.";
  if (code === "cancelled") return "Calendar read check was cancelled.";
  if (code === "timed_out") return "Calendar read check timed out. Try again in the foreground.";
  return "Calendar's exact-account reads could not be verified. Calendar watches remain unavailable.";
}
/** Fixed public projection; a diagnostic record can never enable this feature. */
export function publicComposioCalendarReadCheckResult(value: Partial<ComposioCalendarReadCheckPublicResult>): ComposioCalendarReadCheckPublicResult {
  const code = COMPOSIO_CALENDAR_READ_CHECK_CODES.includes(value.code as ComposioCalendarReadCheckCode) ? value.code as ComposioCalendarReadCheckCode : "inspection_failed";
  return { available: false, checkedAt: Number.isSafeInteger(value.checkedAt) && value.checkedAt! >= 0 ? value.checkedAt! : 0, status: code === "verified" ? "verified" : code === "cancelled" ? "cancelled" : "unavailable", code, message: message(code) };
}
class CheckFailure extends Error { constructor(readonly code: ComposioCalendarReadCheckCode, readonly reason: Reason) { super("Calendar read check stopped."); } }
function reject(code: ComposioCalendarReadCheckCode, reason: Reason): never { throw new CheckFailure(code, reason); }

/** Only explicit account-selection failures with ONE correlated failed item
 * and NO response/data establish the negative oracle. Generic errors, client
 * argument refusal, auth failure and timeout are inconclusive. */
function negativeShape(value: unknown, blockedField: NegativeBlock): NegativeShape {
  const type = (value: unknown): ValueType => value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : ["object", "string", "number", "boolean"].includes(typeof value) ? typeof value as ValueType : "other";
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  let action: Record<string, unknown> = {}; try { action = calendarContractAction(value); } catch { /* Shape remains explicitly missing. */ }
  const data = record(action.data), first = Array.isArray(data.results) ? data.results[0] : undefined, result = record(first);
  const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? Math.min(value as number, 12_001) : undefined;
  const error = typeof result.error === "string" ? result.error : undefined;
  const exact = error !== undefined && ["ACCOUNT_NOT_FOUND", "CONNECTED_ACCOUNT_NOT_FOUND", "INVALID_CONNECTED_ACCOUNT", "Connected account not found", "Connected account does not exist"].includes(error);
  return { blockedField, action: { successful: type(action.successful), data: type(action.data), error: type(action.error) }, data: { results: type(data.results), ...(Array.isArray(data.results) ? { resultCount: Math.min(data.results.length, 12_001) } : {}), ...(count(data.total_count) === undefined ? {} : { totalCount: count(data.total_count) }), ...(count(data.success_count) === undefined ? {} : { successCount: count(data.success_count) }), ...(count(data.error_count) === undefined ? {} : { errorCount: count(data.error_count) }) }, result: { value: type(first), response: type(result.response), error: type(result.error), slugMatches: result.tool_slug === "GOOGLECALENDAR_LIST_CALENDARS", indexMatches: result.index === 0, errorCategory: exact ? "exact_known" : error === undefined ? "missing" : /account.{0,80}(?:not found|does not exist)/iu.test(error) ? "account_not_found_text" : /auth|permission|forbidden/iu.test(error) ? "auth_or_permission" : "other" } };
}
function accountSelectionFailure(value: unknown): NegativeBlock {
  try {
    const action = calendarContractAction(value);
    if (Object.keys(action).some((key) => !["successful", "data", "error"].includes(key))) return "unexpected_action_field";
    if (action.successful !== true || (action.error !== undefined && action.error !== null && action.error !== "")) return "envelope";
    const data = calendarContractObject(action.data);
    if (Object.keys(data).some((key) => !["results", "total_count", "success_count", "error_count", "session", "next_steps", "remote_file_info"].includes(key))) return "unexpected_data_field";
    if (data.remote_file_info !== undefined && data.remote_file_info !== null) return "remote_file_info";
    if (data.total_count !== 1 || data.success_count !== 0 || data.error_count !== 1 || !Array.isArray(data.results) || data.results.length !== 1) return "counts";
    const result = calendarContractObject(data.results[0]);
    if (Object.keys(result).some((key) => !["tool_slug", "index", "error", "response"].includes(key))) return "unexpected_result_field";
    if (result.response !== undefined && result.response !== null) return "response";
    if (result.index !== 0 || result.tool_slug !== "GOOGLECALENDAR_LIST_CALENDARS") return "correlation";
    if (typeof result.error !== "string" || result.error.length > 4_096) return "error";
    return ["ACCOUNT_NOT_FOUND", "CONNECTED_ACCOUNT_NOT_FOUND", "INVALID_CONNECTED_ACCOUNT", "Connected account not found", "Connected account does not exist"].includes(result.error) ? "none" : "error";
  } catch { return "envelope"; }
}

export async function checkComposioCalendarRead(raw: ComposioCalendarReadCheckPort, options: { signal: AbortSignal; current(): Promise<void>; now?(): number; timeoutMs?: number }): Promise<ComposioCalendarReadCheckResult> {
  const checkedAt = (options.now ?? Date.now)();
  const proof: ComposioCalendarReadCheckProof = { revision: "composio-calendar-read-check-v1", stage: "inventory", reason: "not_started", calls: { search: false, schemas: false, invalidAccount: false, calendars: 0, events: 0, get: false }, counts: { activeAccounts: 0, calendars: 0, events: 0, gets: 0 }, invalidAccountRejected: false };
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return { ...publicComposioCalendarReadCheckResult({ code: "inspection_failed" }), privateProof: { ...proof, reason: "invalid" } };
  const controller = new AbortController(), signal = AbortSignal.any([options.signal, controller.signal]);
  const timeout = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000) return { ...publicComposioCalendarReadCheckResult({ checkedAt, code: "inspection_failed" }), privateProof: { ...proof, reason: "invalid" } };
  const timer = setTimeout(() => controller.abort(new CheckFailure("timed_out", "timed_out")), timeout);
  let total = 0;
  const bounded = (value: unknown) => {
    const copy = copyBoundedJson(value, { maxDepth: 18, maxNodes: 12_000, maxSize: 256 * 1024, measure: utf8Size });
    if (copy === undefined) return reject("limit_exceeded", "limit");
    const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8"); total += bytes;
    if (bytes > 256 * 1024 || total > 1024 * 1024) return reject("limit_exceeded", "limit"); return copy;
  };
  const current = async () => {
    signal.throwIfAborted();
    try { await options.current(); } catch { signal.throwIfAborted(); reject("access_changed", "access_changed"); }
    signal.throwIfAborted();
  };
  const call = async <T>(operation: () => Promise<T>): Promise<T> => { await current(); signal.throwIfAborted(); const result = await operation(); await current(); return result; };
  const run = async (): Promise<ComposioCalendarReadCheckCode> => {
    const metadata = bounded(await call(() => raw.list())) as unknown as readonly SubagentMcpRemoteTool[];
    proof.stage = "search";
    const searchArgs = buildCalendarSearchRequest(metadata); proof.calls.search = true;
    const accountReply = bounded(await call(() => raw.call("COMPOSIO_SEARCH_TOOLS", searchArgs)));
    const searchAction = calendarContractAction(accountReply);
    if (searchAction.successful !== true || (searchAction.error !== undefined && searchAction.error !== null && searchAction.error !== "")) reject("invalid_response", "invalid");
    const searchData = calendarContractObject(searchAction.data);
    const session = calendarContractObject(searchData.session);
    if (typeof session.id !== "string" || !session.id || session.id.length > 256 || /\p{Cc}/u.test(session.id)) reject("invalid_response", "invalid");
    const sessionId = session.id;
    const active = parseComposioCalendarAccounts(accountReply); proof.counts.activeAccounts = active.length;
    proof.stage = "schemas";
    const schemaArgs = buildCalendarSchemasRequest(metadata, sessionId); proof.calls.schemas = true;
    const schemaReply = bounded(await call(() => raw.call("COMPOSIO_GET_TOOL_SCHEMAS", schemaArgs)));
    const executors = metadata.filter((tool) => tool.name === "COMPOSIO_MULTI_EXECUTE_TOOL");
    if (executors.length === 1) proof.executorOutputSource = executors[0]!.outputSchema === undefined ? "host_contract" : "declared";
    const verified = verifyCalendarContract(metadata, schemaReply); proof.contract = verified.contract;
    proof.stage = "account_selection";
    if (active.length === 0) reject("no_active_account", "no_account");
    if (active.length !== 1) reject("needs_account_selection", "multiple_accounts");
    if (!raw.readCalendar) reject("unsupported_contract", "missing");
    const rawRead = raw.readCalendar.bind(raw);
    const readCalendar = async (read: ComposioCalendarRead, validate: (reply: unknown) => void): Promise<unknown> => {
      let reply: unknown, returned = false;
      try {
        reply = await call(() => rawRead(read, sessionId)); returned = true;
        const copy = bounded(reply); validate(copy); return copy;
      } catch (error) {
        proof.readFailure = composioCalendarReadFailure(error, returned ? "validation" : "send", reply, returned ? "calendar" : undefined);
        throw error;
      }
    };
    proof.stage = "invalid_account";
    const invalidId = `ca_${randomBytes(16).toString("hex")}`;
    if (active.some((account) => account.id === invalidId)) reject("invalid_account_unverified", "routing_unverified");
    const negative: ComposioCalendarRead = { kind: "listCalendars", accountId: invalidId };
    verified.request(negative, sessionId); // Client refusal is not routing proof.
    proof.calls.invalidAccount = true;
    await readCalendar(negative, (reply) => {
      const blocked = accountSelectionFailure(reply); proof.negative = negativeShape(reply, blocked);
      verified.executorResponse(reply);
      if (blocked !== "none") reject("invalid_account_unverified", "routing_unverified");
    });
    proof.invalidAccountRejected = true;
    const port = {
      assertCurrent: async (read: ComposioCalendarRead) => { await current(); verified.request(read, sessionId); },
      read: async (read: ComposioCalendarRead) => {
        if (read.accountId !== active[0]!.id) reject("access_changed", "changed");
        verified.request(read, sessionId);
        proof.stage = read.kind === "listCalendars" ? "calendars" : read.kind === "getEvent" ? "event_get" : "events";
        if (read.kind === "listCalendars") proof.calls.calendars++; else if (read.kind === "getEvent") proof.calls.get = true; else proof.calls.events++;
        return readCalendar(read, (reply) => verified.response(read, reply));
      },
    };
    const sources = await discoverComposioCalendarSources({ ...port, assertDiscoveryCurrent: current, currentAccounts: async () => accountReply }, signal);
    proof.counts.calendars = sources.length;
    if (!sources.length) reject("source_unavailable", "no_readable_calendar");
    const result = await readComposioCalendarWatch(sources[0]!, { lookAheadMinutes: 1_440, timezone: "UTC" }, undefined, port, checkedAt, signal);
    proof.counts.events = result.items.length;
    proof.stage = "event_get";
    const observed = result.items.find((item) => !item.cancelled);
    if (!observed) reject("get_proof_incomplete", "no_timed_event");
    const get: Extract<ComposioCalendarRead, { kind: "getEvent" }> = { kind: "getEvent", accountId: sources[0]!.accountId, calendarId: sources[0]!.calendarId, eventId: observed.eventId, timezone: "UTC" };
    await port.assertCurrent(get);
    const fetched = normalizeComposioCalendarEventGet(await port.read(get), get, observed);
    if (fetched.cancelled) reject("get_proof_incomplete", "changed");
    proof.counts.gets = 1;
    await current(); proof.stage = "complete"; proof.reason = "accepted"; return "verified";
  };
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, failed) => { onAbort = () => failed(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); });
  try {
    const code = await Promise.race([Promise.resolve().then(run), cancelled]);
    return { ...publicComposioCalendarReadCheckResult({ checkedAt, code }), privateProof: structuredClone(proof) };
  } catch (error) {
    const code = options.signal.aborted ? "cancelled" : controller.signal.aborted ? "timed_out" : error instanceof CheckFailure ? error.code : error instanceof ComposioCalendarContractError && (error.stage !== "read_response" || error.reason === "unsupported") ? "unsupported_contract" : "invalid_response";
    proof.reason = options.signal.aborted ? "cancelled" : controller.signal.aborted ? "timed_out" : error instanceof CheckFailure ? error.reason : error instanceof ComposioCalendarContractError ? error.reason : "failed";
    if (error instanceof ComposioCalendarContractError) proof.contractFailure = { stage: error.stage, reason: error.reason, ...(error.facts ? { facts: error.facts } : {}), ...(error.field ? { field: error.field } : {}) };
    return { ...publicComposioCalendarReadCheckResult({ checkedAt, code }), privateProof: structuredClone(proof) };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); controller.abort(); }
}
