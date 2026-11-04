// GATED, offline Calendar translation. This module has no transport, credentials,
// service grant or production availability. Fixtures establish candidate semantics,
// not proof of the installed executor's account routing or response representation.
import { createHash } from "node:crypto";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import { boundedConnectorText, connectorTextIsWellFormed } from "./connector-text.js";
import { compareImcpWatch, connectorWatchJson, type ConnectorWatchChange, type ConnectorWatchItem } from "./connector-watch-imcp.js";

export const COMPOSIO_CALENDAR_ADAPTER = Object.freeze({ revision: "composio-calendar-v1", available: false as const });
export interface ComposioCalendarSource {
  accountId: string;
  calendarId: string;
  labels: { providerLabel: string; accountLabel: string; resourceLabel: string };
}
export type ComposioCalendarRead =
  | { kind: "listCalendars"; accountId: string; pageToken?: string }
  | { kind: "listEvents"; accountId: string; calendarId: string; timeMin: string; timeMax: string; timezone: string; pageToken?: string }
  | { kind: "getEvent"; accountId: string; calendarId: string; eventId: string; timezone: string };
export interface ComposioCalendarReadPort {
  /** A current host-owned source admission is mandatory; saved IDs are only data.
   * Validate the exact accepted source, one service grant, credentials, rules,
   * schema/account-routing proof, watch revision, lifecycle and cancellation.
   * Never connect, repair, prompt, Search or create an account in this path. */
  assertCurrent(read: ComposioCalendarRead, signal: AbortSignal): Promise<void>;
  /** Host validates the current executor schema and fixed session plumbing before
   * sending the one curated operation. Server errors must not trigger fallback. */
  read(read: ComposioCalendarRead, signal: AbortSignal): Promise<unknown>;
}
export interface ComposioCalendarDiscoveryPort extends ComposioCalendarReadPort {
  assertDiscoveryCurrent(signal: AbortSignal): Promise<void>;
  /** Fresh, guarded Search reply, only for the person's explicit Find sources. */
  currentAccounts(signal: AbortSignal): Promise<unknown>;
}
export interface ComposioCalendarItem extends ConnectorWatchItem {
  eventId: string;
  recurringEventId?: string;
  originalStartsAt?: number;
}
export interface ComposioCalendarBaseline {
  version: 1;
  accountId: string;
  calendarId: string;
  items: ComposioCalendarItem[];
}
export interface ComposioCalendarCondition { lookAheadMinutes: number; timezone: string }
interface Options { timeoutMs?: number }
type RecordValue = Record<string, unknown>;
const LIST_CALENDARS = "GOOGLECALENDAR_LIST_CALENDARS";
const LIST_EVENTS = "GOOGLECALENDAR_EVENTS_LIST";
const GET_EVENT = "GOOGLECALENDAR_EVENTS_GET";
const LIMITS = { pages: 5, items: 250, calendars: 500, accounts: 16, gets: 16, history: 2_000, reply: 256 * 1024, total: 1024 * 1024, timeout: 15_000 } as const;
const EVENT_FIELDS = "items(id,status,summary,location,start,end,recurringEventId,originalStartTime),nextPageToken";
const DAY = 86_400_000;
function fail(message = "Calendar returned incomplete or unsupported data."): never { throw new Error(message); }
function object(value: unknown): RecordValue { if (!value || typeof value !== "object" || Array.isArray(value)) return fail(); return value as RecordValue; }
function text(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || !connectorTextIsWellFormed(value) || /\p{Cc}/u.test(value)) return fail();
  return value;
}
function accountId(value: unknown): string { const id = text(value, 256); if (id !== id.trim()) return fail(); return id; }
function display(value: unknown, fallback: string, maximum: number): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !connectorTextIsWellFormed(value)) return fail();
  return boundedConnectorText(value.replace(/\p{Cc}/gu, " ").trim(), maximum) || fallback;
}
function keys(value: RecordValue, allowed: readonly string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) fail(); }
function calendarId(value: unknown): string {
  const id = text(value);
  if (id !== id.trim() || id.toLowerCase() === "primary" || id.startsWith("ca_")) fail("Choose an explicit calendar returned for the selected account.");
  return id;
}
function zone(value: unknown): string {
  const result = text(value, 100);
  try { new Intl.DateTimeFormat("en", { timeZone: result }); } catch { fail("Choose a valid Calendar timezone."); }
  return result;
}
function timestamp(value: unknown): number {
  const source = text(value, 100);
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/u.exec(source);
  if (!parts) return fail("Calendar returned a time without an explicit offset.");
  const [, year, month, day, hour, minute, second, offset] = parts;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || (offset !== "Z" && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59))) return fail();
  const result = Date.parse(source); if (!Number.isSafeInteger(result)) return fail(); return result;
}
function occurrenceId(eventId: string, series?: string, original?: number): string {
  return createHash("sha256").update(JSON.stringify(series ? ["recurring", series, original] : ["event", eventId])).digest("hex");
}
function noPartial(value: RecordValue, allowPages = false): void {
  for (const key of ["remote_file_info", "remoteFileInfo", "truncated", "has_more", "hasMore", "nextCursor", "next_cursor", ...(allowPages ? [] : ["nextPageToken", "next_page_token"])] as const) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== false && value[key] !== "") fail("Calendar returned a partial or offloaded result.");
  }
}
function action(value: unknown): RecordValue {
  const envelope = object(value);
  // MCP explicitly permits structured-only output with an empty content list.
  const { content, ...withoutEmptyContent } = envelope;
  const result = object(connectorWatchJson(Array.isArray(content) && content.length === 0 && envelope.structuredContent !== undefined ? withoutEmptyContent : envelope));
  if (result.successful !== true || (result.error !== undefined && result.error !== null && result.error !== "")) return fail("The selected Calendar account could not be read.");
  noPartial(result); return object(result.data);
}
/** Correlated successful upstream representation, before optional action unwrap. */
export function parseComposioCalendarExecutorResponse(value: unknown, read: ComposioCalendarRead): RecordValue {
  const data = action(value); noPartial(data);
  if (data.total_count !== 1 || data.success_count !== 1 || data.error_count !== 0 || !Array.isArray(data.results) || data.results.length !== 1) return fail("Calendar did not return exactly one successful operation.");
  const result = object(data.results[0]); noPartial(result);
  const slug = read.kind === "listCalendars" ? LIST_CALENDARS : read.kind === "listEvents" ? LIST_EVENTS : GET_EVENT;
  if (result.index !== 0 || result.tool_slug !== slug || (result.error !== undefined && result.error !== null && result.error !== "")) return fail();
  const response = object(result.response); noPartial(response, true);
  return response;
}
function executorResult(value: unknown, read: ComposioCalendarRead): RecordValue {
  const response = parseComposioCalendarExecutorResponse(value, read);
  // Candidate forms are explicit and non-overlapping. Both remain gated until
  // the installed operation's real output contract is independently accepted.
  if (response.successful !== undefined) {
    if (response.items !== undefined || response.id !== undefined || ["calendars", "calendarList", "calendar_list", "events"].some((key) => Object.prototype.hasOwnProperty.call(response, key))) return fail();
    const inner = action(response); noPartial(inner, true);
    if (read.kind === "getEvent" && ["calendars", "calendarList", "calendar_list", "events"].some((key) => Object.prototype.hasOwnProperty.call(inner, key))) return fail();
    return inner;
  }
  if (response.error !== undefined || response.data !== undefined) return fail();
  if (read.kind === "getEvent" && ["calendars", "calendarList", "calendar_list", "events"].some((key) => Object.prototype.hasOwnProperty.call(response, key))) return fail();
  return response;
}

/** A candidate host-only request builder, not a generic Composio dispatcher.
 * Required executor/session fields must separately match the current live schema. */
export function buildComposioCalendarExecutorRequest(input: ComposioCalendarRead) {
  const read = object(copyBoundedJson(input, { maxNodes: 30, maxDepth: 3, maxSize: 8_192, measure: utf8Size }));
  const account = accountId(read.accountId);
  let tool_slug: typeof LIST_CALENDARS | typeof LIST_EVENTS | typeof GET_EVENT;
  let args: RecordValue;
  if (read.kind === "listCalendars") {
    keys(read, ["kind", "accountId", "pageToken"]); tool_slug = LIST_CALENDARS;
    args = { max_results: 100, ...(read.pageToken === undefined ? {} : { page_token: text(read.pageToken, 2_000) }) };
  } else if (read.kind === "listEvents") {
    keys(read, ["kind", "accountId", "calendarId", "timeMin", "timeMax", "timezone", "pageToken"]); tool_slug = LIST_EVENTS;
    const start = timestamp(read.timeMin), end = timestamp(read.timeMax);
    if (end <= start || end - start > DAY) fail();
    args = { calendarId: calendarId(read.calendarId), timeMin: read.timeMin, timeMax: read.timeMax, timeZone: zone(read.timezone), singleEvents: true, showDeleted: true, maxResults: 50, fields: EVENT_FIELDS,
      ...(read.pageToken === undefined ? {} : { pageToken: text(read.pageToken, 2_000) }) };
  } else if (read.kind === "getEvent") {
    keys(read, ["kind", "accountId", "calendarId", "eventId", "timezone"]); tool_slug = GET_EVENT;
    args = { calendar_id: calendarId(read.calendarId), event_id: text(read.eventId), time_zone: zone(read.timezone) };
  } else return fail("This Calendar read operation is not supported.");
  return { tools: [{ tool_slug, arguments: args, account }] as const, sync_response_to_workbench: false as const };
}

function source(value: ComposioCalendarSource): ComposioCalendarSource {
  const record = object(copyBoundedJson(value, { maxNodes: 20, maxDepth: 3, maxSize: 12_000, measure: utf8Size }));
  keys(record, ["accountId", "calendarId", "labels"]); const labels = object(record.labels); keys(labels, ["providerLabel", "accountLabel", "resourceLabel"]);
  return { accountId: accountId(record.accountId), calendarId: calendarId(record.calendarId), labels: { providerLabel: text(labels.providerLabel), accountLabel: text(labels.accountLabel), resourceLabel: text(labels.resourceLabel) } };
}
function page(value: RecordValue, maximum: number, operation: "listCalendars" | "listEvents"): { items: unknown[]; next?: string } {
  noPartial(value, true);
  const collections = ["items", "calendars", "calendarList", "calendar_list", "events"].filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (collections.length !== 1 || (collections[0] !== "items" && !(operation === "listCalendars" && collections[0] === "calendars"))) return fail();
  const items = value[collections[0]!];
  if (!Array.isArray(items) || items.length > maximum) return fail();
  const camel = value.nextPageToken, snake = value.next_page_token;
  if (camel !== undefined && snake !== undefined) return fail("Calendar returned conflicting page cursors.");
  const cursor = camel ?? snake;
  if (cursor === undefined || cursor === null || cursor === "") return { items };
  return { items, next: text(cursor, 2_000) };
}
/** Parse only a freshly guarded Search reply; this data never grants a read. */
export function parseComposioCalendarAccounts(value: unknown): Array<{ id: string; label: string }> {
  const data = action(value); noPartial(data);
  if (!Array.isArray(data.toolkit_connection_statuses) || data.toolkit_connection_statuses.length > 16) return fail("Calendar account discovery was incomplete.");
  const matches = data.toolkit_connection_statuses.map(object).filter((entry) => typeof entry.toolkit === "string" && /^[a-z]+$/iu.test(entry.toolkit) && entry.toolkit.toLowerCase() === "googlecalendar");
  if (matches.length !== 1) return fail("Calendar account discovery was ambiguous or incomplete.");
  const status = matches[0]!; noPartial(status);
  if (typeof status.has_active_connection !== "boolean" || !Array.isArray(status.accounts) || status.accounts.length > LIMITS.accounts) return fail("Calendar did not return its connected-account list.");
  const result: Array<{ id: string; label: string }> = []; const seen = new Set<string>();
  for (const value of status.accounts) {
    const account = object(value); noPartial(account); const id = accountId(account.id); const state = text(account.status, 100);
    if (seen.has(id)) fail("Calendar repeated or changed an account identity."); seen.add(id);
    if (state !== "ACTIVE") continue;
    let label = "Connected Calendar account";
    if (account.user_info !== undefined && account.user_info !== null) {
      const info = object(account.user_info);
      const candidate = typeof info.email === "string" && info.email.trim() ? info.email : info.name;
      if (typeof candidate === "string" && candidate.trim()) label = display(candidate, label, 500);
    }
    result.push({ id, label });
  }
  if (status.has_active_connection !== (result.length > 0)) fail("Calendar account status changed during discovery.");
  return result;
}

function operation<T>(signal: AbortSignal, options: Options, work: (signal: AbortSignal, bounded: (value: unknown) => unknown) => Promise<T>): Promise<T> {
  const timeout = options.timeoutMs ?? LIMITS.timeout;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > LIMITS.timeout) return Promise.reject(new Error("Invalid Calendar read deadline."));
  const controller = new AbortController(); const combined = AbortSignal.any([signal, controller.signal]);
  let total = 0;
  const bounded = (value: unknown) => {
    const copy = copyBoundedJson(value, { maxNodes: 12_000, maxDepth: 18, maxSize: LIMITS.reply, measure: utf8Size });
    if (copy === undefined) return fail("Calendar returned an excessive or invalid result.");
    const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8");
    if (bytes > LIMITS.reply) return fail("Calendar returned an excessive result.");
    total += bytes;
    if (total > LIMITS.total) return fail("Calendar exceeded this check's response budget.");
    return copy;
  };
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(combined.reason); combined.addEventListener("abort", onAbort, { once: true }); if (combined.aborted) onAbort();
  });
  const timer = setTimeout(() => controller.abort(new Error("Calendar check timed out.")), timeout);
  const running = Promise.resolve().then(() => { combined.throwIfAborted(); return work(combined, bounded); });
  return Promise.race([running, cancelled]).finally(() => { clearTimeout(timer); combined.removeEventListener("abort", onAbort); controller.abort(); });
}
async function read(port: ComposioCalendarReadPort, request: ComposioCalendarRead, signal: AbortSignal, bounded: (value: unknown) => unknown): Promise<RecordValue> {
  buildComposioCalendarExecutorRequest(request); // Independently close/validate every typed request.
  const frozen = Object.freeze({ ...request });
  signal.throwIfAborted(); await port.assertCurrent(frozen, signal); signal.throwIfAborted();
  const result = await port.read(frozen, signal);
  signal.throwIfAborted(); await port.assertCurrent(frozen, signal); signal.throwIfAborted();
  return executorResult(bounded(result), frozen);
}

export function discoverComposioCalendarSources(port: ComposioCalendarDiscoveryPort, signal: AbortSignal, options: Options = {}): Promise<ComposioCalendarSource[]> {
  return operation(signal, options, async (current, bounded) => {
    current.throwIfAborted(); await port.assertDiscoveryCurrent(current); current.throwIfAborted();
    const metadata = await port.currentAccounts(current);
    current.throwIfAborted(); await port.assertDiscoveryCurrent(current); current.throwIfAborted();
    const activeAccounts = parseComposioCalendarAccounts(bounded(metadata)); const result: ComposioCalendarSource[] = [];
    for (const account of activeAccounts) {
      let token: string | undefined; const cursors = new Set<string>(); const calendars = new Set<string>();
      for (let index = 0; index < LIMITS.pages; index++) {
        const response = page(await read(port, { kind: "listCalendars", accountId: account.id, ...(token ? { pageToken: token } : {}) }, current, bounded), 100, "listCalendars");
        for (const value of response.items) {
          const calendar = object(value); const id = calendarId(calendar.id);
          if (calendars.has(id)) fail("Calendar repeated a source identity."); calendars.add(id);
          if (calendar.deleted !== undefined && typeof calendar.deleted !== "boolean") fail();
          if (calendar.deleted === true) continue;
          if (!["reader", "writer", "owner"].includes(text(calendar.accessRole, 100))) continue;
          const resourceLabel = display(calendar.summary, "Calendar", 500);
          result.push({ accountId: account.id, calendarId: id, labels: { providerLabel: "Composio Calendar", accountLabel: account.label, resourceLabel } });
          if (result.length > LIMITS.calendars) fail("Too many Calendar sources. Narrow the connected accounts.");
        }
        if (!response.next) break;
        if (index + 1 === LIMITS.pages || cursors.has(response.next)) fail("Calendar source discovery was incomplete.");
        cursors.add(response.next); token = response.next;
      }
    }
    current.throwIfAborted(); await port.assertDiscoveryCurrent(current); current.throwIfAborted(); return result;
  });
}

function normalizedEvent(value: unknown, oldByEvent: Map<string, ComposioCalendarItem>, oldByIdentity: Map<string, ComposioCalendarItem>, expected?: ComposioCalendarItem): ComposioCalendarItem | undefined {
  const event = object(value); noPartial(event); const eventId = text(event.id);
  if (expected && eventId !== expected.eventId) fail("Calendar returned a different event.");
  const status = text(event.status, 100); if (!["confirmed", "tentative", "cancelled"].includes(status)) fail();
  const dateOnly = (value: unknown): number => {
    const valueText = text(value, 10);
    if (!/^\d{4}-\d\d-\d\d$/u.test(valueText)) return fail();
    return timestamp(`${valueText}T00:00:00Z`);
  };
  const series = event.recurringEventId === undefined ? undefined : text(event.recurringEventId);
  const originalValue = event.originalStartTime === undefined ? undefined : object(event.originalStartTime);
  if ((status !== "cancelled" && (object(event.start).date !== undefined || object(event.end).date !== undefined)) || originalValue?.date !== undefined) {
    if (expected || oldByEvent.has(eventId)) fail("An observed timed Calendar event changed to an unsupported all-day event.");
    if (status !== "cancelled") {
      const start = object(event.start), end = object(event.end);
      if (start.dateTime !== undefined || end.dateTime !== undefined || dateOnly(end.date) <= dateOnly(start.date)) fail();
    }
    if (originalValue) { if (!series || originalValue.dateTime !== undefined) fail(); dateOnly(originalValue.date); }
    else if (series) fail();
    return undefined;
  }
  const original = originalValue === undefined ? undefined : timestamp(originalValue.dateTime);
  if ((series === undefined) !== (original === undefined)) fail("Calendar omitted an occurrence identity.");
  const id = occurrenceId(eventId, series, original);
  const old = oldByIdentity.get(id) ?? oldByEvent.get(eventId);
  if ((expected && expected.id !== id && (status !== "cancelled" || series !== undefined)) || (old && old.id !== id && (status !== "cancelled" || series !== undefined))) fail("Calendar changed an occurrence identity.");
  if (status === "cancelled") {
    if (!old) return undefined;
    return { ...old, eventId, cancelled: true, signature: old.cancelled ? old.signature : JSON.stringify(["cancelled", old.signature]) };
  }
  const start = object(event.start), end = object(event.end);
  const startsAt = timestamp(start.dateTime), endsAt = timestamp(end.dateTime);
  if (endsAt < startsAt) fail();
  const title = display(event.summary, "Untitled event", 500);
  const location = event.location === undefined || event.location === "" ? "" : text(event.location, 2_000);
  return { id, eventId, title, signature: JSON.stringify([title, startsAt, endsAt, location, status]), startsAt, ...(series ? { recurringEventId: series, originalStartsAt: original } : {}) };
}

export function parseComposioCalendarBaseline(value: unknown): ComposioCalendarBaseline | undefined {
  try {
    const record = object(copyBoundedJson(value, { maxNodes: 24_000, maxDepth: 5, maxSize: 4 * 1024 * 1024, measure: utf8Size }));
    keys(record, ["version", "accountId", "calendarId", "items"]);
    if (record.version !== 1 || !Array.isArray(record.items) || record.items.length > LIMITS.history) return undefined;
    const account = accountId(record.accountId), calendar = calendarId(record.calendarId); const ids = new Set<string>(), eventIds = new Set<string>();
    const items = record.items.map((value) => {
      const item = object(value); keys(item, ["id", "eventId", "title", "signature", "startsAt", "cancelled", "recurringEventId", "originalStartsAt"]);
      const eventId = text(item.eventId); const series = item.recurringEventId === undefined ? undefined : text(item.recurringEventId);
      if ((series === undefined) !== (item.originalStartsAt === undefined) || (item.originalStartsAt !== undefined && !Number.isSafeInteger(item.originalStartsAt)) || !Number.isSafeInteger(item.startsAt) || (item.cancelled !== undefined && typeof item.cancelled !== "boolean")) return fail();
      const id = text(item.id); if (id !== occurrenceId(eventId, series, item.originalStartsAt as number | undefined) || ids.has(id) || eventIds.has(eventId)) return fail(); ids.add(id); eventIds.add(eventId);
      return { id, eventId, title: text(item.title), signature: text(item.signature, 10_000), startsAt: item.startsAt as number, ...(item.cancelled === undefined ? {} : { cancelled: item.cancelled }), ...(series ? { recurringEventId: series, originalStartsAt: item.originalStartsAt as number } : {}) };
    });
    return { version: 1, accountId: account, calendarId: calendar, items };
  } catch { return undefined; }
}

/** Validate a real GET against a timed occurrence already returned by the
 * selected Calendar's bounded window. No lookup or authority is minted here. */
export function normalizeComposioCalendarEventGet(reply: unknown, request: Extract<ComposioCalendarRead, { kind: "getEvent" }>, expected: ComposioCalendarItem): ComposioCalendarItem {
  if (request.eventId !== expected.eventId) return fail("Calendar GET did not request the observed event.");
  const item = normalizedEvent(executorResult(reply, request), new Map([[expected.eventId, expected]]), new Map([[expected.id, expected]]), expected);
  if (!item) return fail("Calendar GET did not return the observed timed occurrence.");
  return item;
}

export function readComposioCalendarWatch(binding: ComposioCalendarSource, condition: ComposioCalendarCondition, previous: ComposioCalendarBaseline | undefined, port: ComposioCalendarReadPort, now: number, signal: AbortSignal, options: Options = {}): Promise<{ items: ComposioCalendarItem[]; baseline: ComposioCalendarBaseline; changes: ConnectorWatchChange[] }> {
  return operation(signal, options, async (current, bounded) => {
    const selected = source(binding); const controls = object(copyBoundedJson(condition, { maxNodes: 5, maxDepth: 2, maxSize: 500, measure: utf8Size })); keys(controls, ["lookAheadMinutes", "timezone"]);
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(controls.lookAheadMinutes) || (controls.lookAheadMinutes as number) < 15 || (controls.lookAheadMinutes as number) > 1_440) fail("Choose a Calendar window between 15 minutes and a day.");
    const timezone = zone(controls.timezone), end = now + (controls.lookAheadMinutes as number) * 60_000;
    if (!Number.isSafeInteger(end)) fail();
    const before = previous === undefined ? undefined : parseComposioCalendarBaseline(previous);
    if (previous !== undefined && (!before || before.accountId !== selected.accountId || before.calendarId !== selected.calendarId)) fail("The Calendar history belongs to a different or invalid source.");
    const oldByIdentity = new Map((before?.items ?? []).map((item) => [item.id, item]));
    const oldByEvent = new Map((before?.items ?? []).map((item) => [item.eventId, item]));
    const items: ComposioCalendarItem[] = [], received = new Set<string>(), identities = new Set<string>(), cursors = new Set<string>();
    let token: string | undefined, eventCount = 0;
    const add = (item: ComposioCalendarItem) => { if (identities.has(item.id) || items.length >= LIMITS.items) fail("Calendar repeated an occurrence or exceeded this check's item limit."); identities.add(item.id); items.push(item); };
    for (let index = 0; index < LIMITS.pages; index++) {
      const response = page(await read(port, { kind: "listEvents", accountId: selected.accountId, calendarId: selected.calendarId, timeMin: new Date(now).toISOString(), timeMax: new Date(end).toISOString(), timezone, ...(token ? { pageToken: token } : {}) }, current, bounded), 50, "listEvents");
      eventCount += response.items.length; if (eventCount > LIMITS.items) fail();
      for (const value of response.items) {
        const eventId = text(object(value).id); if (received.has(eventId)) fail("Calendar repeated an event across pages."); received.add(eventId);
        const item = normalizedEvent(value, oldByEvent, oldByIdentity);
        if (item && (item.cancelled || oldByIdentity.has(item.id) || (item.startsAt! >= now && item.startsAt! < end))) add(item);
      }
      if (!response.next) break;
      if (index + 1 === LIMITS.pages || cursors.has(response.next)) fail("Calendar event pagination was incomplete.");
      cursors.add(response.next); token = response.next;
    }
    // A moving window is not a cancellation feed. Resolve each missing future
    // event explicitly, without interpreting absence or 404 as deletion.
    const missing = (before?.items ?? []).filter((item) => !item.cancelled && item.startsAt! >= now && !identities.has(item.id));
    if (missing.length > LIMITS.gets) fail("Too many changed Calendar occurrences to check safely at once.");
    for (const old of missing) {
      const value = await read(port, { kind: "getEvent", accountId: selected.accountId, calendarId: selected.calendarId, eventId: old.eventId, timezone }, current, bounded);
      const item = normalizedEvent(value, oldByEvent, oldByIdentity, old); if (!item) fail(); add(item);
    }
    const compared = compareImcpWatch("calendar", before ? { kind: "calendar", items: before.items } : undefined, items, now);
    const baseline = parseComposioCalendarBaseline({ version: 1, accountId: selected.accountId, calendarId: selected.calendarId, items: compared.baseline.items });
    if (!baseline) fail("Calendar history exceeded its safe limit.");
    current.throwIfAborted(); return { items: items.map((item) => ({ ...item })), baseline, changes: compared.changes };
  });
}
