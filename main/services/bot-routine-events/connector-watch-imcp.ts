// Offline, source-verified iMCP adapters. This module never discovers, connects
// or launches a server. A host-owned port supplies the already approved binding.
import { isDeepStrictEqual } from "node:util";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";

export type ImcpWatch =
  | { kind: "email"; mailbox: string; account: string; sender?: string; subject?: string; unreadOnly?: boolean }
  | { kind: "calendar"; calendar: string; source: string; lookAheadMinutes: number; timezone: string };

export type ImcpWatchTool = "mail_mailboxes_list" | "mail_messages_search" | "calendars_list" | "events_fetch";

/** An adapter revision identifies understood contracts, not a claim about an installed server. */
export const IMCP_WATCH_ADAPTER = Object.freeze({
  revision: "imcp-watch-v1",
  sourceRevision: "ec7bef349e032574aecc8660ca427ba9489e8cc1",
  ontologyRevision: "7e3937c46057ec9afcfb347da2241033d311bd34",
  platform: "darwin",
  tools: Object.freeze(["mail_mailboxes_list", "mail_messages_search", "calendars_list", "events_fetch"] as const),
});

export interface ConnectorWatchItem {
  /** Mail ID, or the unambiguous tuple [event ID, absolute occurrence start]. */
  id: string;
  title: string;
  /** Meaningful comparison fields only; no fetch times, notes, bodies or arbitrary metadata. */
  signature: string;
  startsAt?: number;
  cancelled?: boolean;
}

export interface ImcpWatchPort {
  /**
   * Revalidate the exact bound Bot/connection/account and current unattended
   * watch approval, trusted app identity, understood tool schema and affirmative
   * read metadata before EVERY call (including pages). Throw on drift or revoked
   * access. An arbitrary server's readOnlyHint does not establish trust.
   * This check must not connect, install, sign in or prompt in the background.
   */
  assertEligible(tool: ImcpWatchTool, signal: AbortSignal): Promise<void>;
  call(tool: ImcpWatchTool, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

const MAX_ITEMS = 250;
const MAX_PAGES = 5;
const PAGE_SIZE = 50;
const MAX_CALENDARS_OR_MAILBOXES = 500;
const TIMEOUT_MS = 15_000;
const DAY = 86_400_000;
const MAX_CALENDAR_HISTORY = 2_000;
const JSON_BOUNDS = { maxNodes: 10_000, maxDepth: 16, maxSize: 256 * 1024, measure: utf8Size };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The connector returned an unexpected result.");
  return value as Record<string, unknown>;
}

function bounded(value: unknown): unknown {
  const result = copyBoundedJson(value, JSON_BOUNDS);
  if (result === undefined) throw new Error("The connector result is too large or incomplete.");
  return result;
}

/** Accept bounded raw JSON or one complete MCP JSON envelope; reject conflicting representations. */
export function connectorWatchJson(value: unknown): unknown {
  const result = bounded(value);
  if (Array.isArray(result)) return result;
  const envelope = object(result);
  if (envelope.isError !== undefined && typeof envelope.isError !== "boolean") throw new Error("The connector returned an invalid error state.");
  if (envelope.isError === true) throw new Error("The connector read failed.");
  let content: unknown;
  if (envelope.content !== undefined) {
    if (!Array.isArray(envelope.content) || envelope.content.length !== 1) throw new Error("The connector did not return one complete JSON result.");
    const part = object(envelope.content[0]);
    if (part.type !== "text" || typeof part.text !== "string") throw new Error("The connector did not return JSON.");
    try { content = bounded(JSON.parse(part.text)); } catch { throw new Error("The connector returned incomplete or excessive JSON."); }
  }
  if (envelope.structuredContent !== undefined) {
    if (content !== undefined && !isDeepStrictEqual(content, envelope.structuredContent)) throw new Error("The connector returned conflicting JSON results.");
    return envelope.structuredContent;
  }
  if (content !== undefined) return content;
  if (envelope.isError !== undefined) throw new Error("The connector returned no result.");
  return result;
}

function text(value: unknown, limit = 500, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > limit) throw new Error("The connector returned an invalid item.");
  return value;
}

function nullableText(value: unknown, limit = 500): string | null {
  return value === null ? null : text(value, limit, true);
}

// Swift String equality is canonically equivalent. Match that behavior before
// reproducing iMCP's lowercased calendar-name selection, so NFC/NFD duplicates
// cannot make a single-account read select calendars from two accounts.
function calendarNameKey(value: string): string {
  return value.normalize("NFC").toLowerCase().normalize("NFC");
}

function sameCalendarText(left: unknown, right: string): boolean {
  return typeof left === "string" && left.normalize("NFC") === right.normalize("NFC");
}

function timestamp(value: unknown): number {
  const source = text(value, 100);
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/u.exec(source);
  if (!parts) throw new Error("The connector returned a time without a valid timezone.");
  const [, year, month, day, hour, minute, second, zone] = parts;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== "Z" && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59))) {
    throw new Error("The connector returned an invalid time.");
  }
  const at = Date.parse(source);
  if (!Number.isFinite(at)) throw new Error("The connector returned an invalid time.");
  return at;
}

function sorted(items: ConnectorWatchItem[], maximum = MAX_ITEMS): ConnectorWatchItem[] {
  if (items.length > maximum || new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error("The connector result is too large or has duplicate identities.");
  }
  return items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function graph(value: unknown, key: "itemListElement" | "@graph", maximum: number, extraKeys: readonly string[] = []): unknown[] {
  const result = object(value);
  const keys = key === "@graph" ? ["@context", "@graph"] : ["@context", "@type", "itemListElement", ...extraKeys];
  if (Object.keys(result).some((field) => !keys.includes(field))) throw new Error("The connector returned an unsupported list contract.");
  if (result["@context"] !== "https://schema.org" || (key === "itemListElement" && result["@type"] !== "ItemList")
    || !Array.isArray(result[key]) || result[key].length > maximum) throw new Error("The connector returned an incomplete or excessive list.");
  return result[key];
}

function configOf(value: ImcpWatch): ImcpWatch {
  const config = object(bounded(value));
  const allowed = config.kind === "email" ? ["kind", "mailbox", "account", "sender", "subject", "unreadOnly"]
    : config.kind === "calendar" ? ["kind", "calendar", "source", "lookAheadMinutes", "timezone"] : [];
  if (!allowed.length || Object.keys(config).some((key) => !allowed.includes(key))) throw new Error("Choose a supported watch template.");
  if (config.kind === "email") {
    text(config.mailbox, 200); text(config.account, 500);
    if (config.sender !== undefined) text(config.sender, 200);
    if (config.subject !== undefined) text(config.subject, 200);
    if (config.unreadOnly !== undefined && typeof config.unreadOnly !== "boolean") throw new Error("Choose a valid mail filter.");
  } else {
    text(config.calendar, 200); text(config.source, 200); text(config.timezone, 100);
    if (!Number.isSafeInteger(config.lookAheadMinutes) || (config.lookAheadMinutes as number) < 15 || (config.lookAheadMinutes as number) > 1_440) throw new Error("Choose a calendar window between 15 minutes and a day.");
    try { new Intl.DateTimeFormat("en", { timeZone: config.timezone as string }); } catch { throw new Error("Choose a valid calendar timezone."); }
  }
  return config as unknown as ImcpWatch;
}

/**
 * A complete bounded traversal or a rejection: partial pages never become a baseline.
 * Mail pages are separate local-index snapshots, not an atomic server snapshot.
 * The optional deadline may only shorten the host-owned 15-second total bound.
 */
export async function readImcpWatch(config: ImcpWatch, port: ImcpWatchPort, now: number, signal: AbortSignal, options: { timeoutMs?: number } = {}): Promise<ConnectorWatchItem[]> {
  const selected = configOf(config);
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8.64e15 - DAY) throw new Error("The host clock is invalid.");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw new Error("The connector deadline is invalid.");
  signal.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    timer = setTimeout(() => controller.abort(new Error("The connector watch timed out.")), timeoutMs);
  });
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const call = async (tool: ImcpWatchTool, args: Record<string, unknown>) => {
    controller.signal.throwIfAborted();
    await port.assertEligible(tool, controller.signal);
    controller.signal.throwIfAborted();
    const result = await port.call(tool, args, controller.signal);
    controller.signal.throwIfAborted();
    return connectorWatchJson(result);
  };
  try {
    return await Promise.race([read(selected, call, now), interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

type ReadCall = (tool: ImcpWatchTool, args: Record<string, unknown>) => Promise<unknown>;

async function read(config: ImcpWatch, call: ReadCall, now: number): Promise<ConnectorWatchItem[]> {
  if (config.kind === "email") {
    const mailboxes = graph(await call("mail_mailboxes_list", {}), "itemListElement", MAX_CALENDARS_OR_MAILBOXES).map(object);
    for (const item of mailboxes) { text(item["@id"], 200); if (item.account !== null) text(object(item.account)["@id"], 500); }
    const matches = mailboxes.filter((item) => item["@id"] === config.mailbox);
    if (matches.length !== 1 || matches[0]!.account === null || object(matches[0]!.account)["@id"] !== config.account) throw new Error("This mailbox or account changed. Choose it again.");
    const filters = {
      mailbox: config.mailbox, limit: PAGE_SIZE,
      ...(config.sender !== undefined ? { sender: config.sender } : {}),
      ...(config.subject !== undefined ? { subject: config.subject } : {}),
      ...(config.unreadOnly ? { isRead: false } : {}),
    };
    const items: ConnectorWatchItem[] = [];
    const identities = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = object(await call("mail_messages_search", { ...filters, ...(cursor !== undefined ? { cursor } : {}) }));
      const rows = graph(result, "itemListElement", PAGE_SIZE, ["nextCursor", "localIndex"]);
      const localIndex = object(result.localIndex);
      if (localIndex.syncStatus !== "unknown" || !(localIndex.indexedMessageCount === null || (Number.isSafeInteger(localIndex.indexedMessageCount) && (localIndex.indexedMessageCount as number) >= 0))) throw new Error("Mail returned incomplete local-index metadata.");
      for (const value of rows) {
        const item = object(value);
        const id = text(item["@id"], 500);
        if (identities.has(id)) throw new Error("Mail repeated a message across pages.");
        identities.add(id);
        if (item.mailbox !== config.mailbox || typeof item.isRead !== "boolean" || (config.unreadOnly && item.isRead)) throw new Error("Mail returned a different mailbox or an invalid item.");
        const subject = nullableText(item.subject);
        const sender = nullableText(object(item.sender).email, 500);
        items.push({ id, title: subject || "(No subject)", signature: JSON.stringify([subject, sender, timestamp(item.dateReceived), item.isRead]) });
      }
      if (result.nextCursor === null) return sorted(items);
      cursor = text(result.nextCursor, 4_000);
      if (cursors.has(cursor) || rows.length === 0) throw new Error("Mail repeated a cursor or returned an incomplete page.");
      cursors.add(cursor);
    }
    throw new Error("The mail result has more pages than this watch can safely read. Narrow its filter.");
  }
  const calendars = await call("calendars_list", {});
  if (!Array.isArray(calendars) || calendars.length > MAX_CALENDARS_OR_MAILBOXES) throw new Error("Calendar returned an incomplete account list.");
  const entries = calendars.map(object);
  for (const item of entries) { text(item.title, 200); text(item.source, 200); }
  const matches = entries.filter((item) => calendarNameKey(item.title as string) === calendarNameKey(config.calendar));
  if (matches.length !== 1 || !sameCalendarText(matches[0]!.title, config.calendar) || !sameCalendarText(matches[0]!.source, config.source)) throw new Error("This calendar name is missing, changed or ambiguous across accounts.");
  const end = now + config.lookAheadMinutes * 60_000;
  const result = await call("events_fetch", {
    calendars: [config.calendar], start: new Date(now).toISOString(), end: new Date(end).toISOString(), includeAllDay: false,
  });
  const items: ConnectorWatchItem[] = [];
  const identities = new Set<string>();
  for (const value of graph(result, "@graph", MAX_ITEMS)) {
    const event = object(value);
    // iMCP omits nested JSON-LD types; an explicit conflicting type is invalid.
    if ((event["@type"] !== undefined && event["@type"] !== "Event") || !sameCalendarText(event.calendar, config.calendar) || (event.isAllDay !== undefined && event.isAllDay !== false)) throw new Error("Calendar returned a different calendar or an invalid event.");
    const startsAt = timestamp(event.startDate);
    const endsAt = timestamp(event.endDate);
    if (endsAt < startsAt) throw new Error("Calendar returned an invalid event range.");
    const id = JSON.stringify([text(event["@id"], 500), startsAt]);
    if (identities.has(id)) throw new Error("Calendar repeated an occurrence.");
    identities.add(id);
    const title = event.name === undefined ? "(Untitled event)" : text(event.name, 500, true);
    const location = event.location === undefined ? null : nullableText(event.location, 2_000);
    const status = event.eventStatus ?? null;
    if (status !== null && !["EventScheduled", "EventCancelled", "EventPostponed", "EventRescheduled"].includes(status as string)) throw new Error("Calendar returned an unknown event status.");
    // EventKit's predicate returns overlaps; already-started events are not upcoming.
    if (startsAt < now || startsAt >= end) continue;
    items.push({ id, title, startsAt, cancelled: status === "EventCancelled", signature: JSON.stringify([title, startsAt, endsAt, location, status]) });
  }
  return sorted(items);
}

export interface ConnectorWatchBaseline {
  kind: ImcpWatch["kind"];
  /** Calendar keeps a bounded occurrence ledger, not just the previous moving window. */
  items: ConnectorWatchItem[];
}

export interface ConnectorWatchChange {
  kind: "entered" | "updated" | "cancelled";
  item: ConnectorWatchItem;
}

/**
 * Mail first establishes a baseline; disappearing local results never prove a
 * server deletion. Calendar can fire immediately, remembers occurrences across
 * window edits/restarts, and reports explicit cancellation only for seen items.
 * Persist the returned baseline atomically with the pending watch transition.
 */
export function compareImcpWatch(kind: ImcpWatch["kind"], before: ConnectorWatchBaseline | undefined, after: readonly ConnectorWatchItem[], now: number): { baseline: ConnectorWatchBaseline; changes: ConnectorWatchChange[] } {
  if (before && before.kind !== kind) throw new Error("The watch baseline belongs to a different template.");
  if (!Number.isSafeInteger(now)) throw new Error("The host clock is invalid.");
  sorted([...after]);
  const previous = new Map(sorted([...(before?.items ?? [])], kind === "calendar" ? MAX_CALENDAR_HISTORY : MAX_ITEMS).map((item) => [item.id, item]));
  const changes: ConnectorWatchChange[] = [];
  for (const item of after) {
    const old = previous.get(item.id);
    if (kind === "calendar" && !Number.isSafeInteger(item.startsAt)) throw new Error("The calendar occurrence has no start time.");
    if (kind === "email" && !before) continue;
    if (item.cancelled) {
      if (old && !old.cancelled) changes.push({ kind: "cancelled", item });
    } else if (!old) changes.push({ kind: "entered", item });
    else if (old.signature !== item.signature) changes.push({ kind: "updated", item });
  }
  let items = [...after];
  if (kind === "calendar") {
    for (const item of after) previous.set(item.id, item);
    // Keep a day after occurrence start for clock corrections. Overflow refuses
    // the check instead of evicting a future occurrence and later repeating it.
    items = sorted([...previous.values()].filter((item) => (item.startsAt ?? -Infinity) >= now - DAY), MAX_CALENDAR_HISTORY);
  }
  return { baseline: { kind, items: items.map((item) => ({ ...item })) }, changes: changes.map((change) => ({ ...change, item: { ...change.item } })) };
}
