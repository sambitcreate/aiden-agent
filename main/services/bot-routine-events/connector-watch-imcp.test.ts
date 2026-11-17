import assert from "node:assert/strict";
import test from "node:test";
import {
  compareImcpWatch, connectorWatchJson, readImcpWatch,
  type ConnectorWatchBaseline, type ImcpWatch, type ImcpWatchPort, type ImcpWatchTool,
} from "./connector-watch-imcp.js";

// Synthetic semantic fixtures, never captured account data or invented live output.
const NOW = Date.parse("2026-11-03T15:00:00Z");
const EMAIL: ImcpWatch = { kind: "email", mailbox: "V10:12", account: "account-one" };
const CALENDAR: ImcpWatch = { kind: "calendar", calendar: "Work", source: "iCloud", lookAheadMinutes: 60, timezone: "America/New_York" };
const signal = () => new AbortController().signal;
const list = (items: unknown[]) => ({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: items });
const mailboxes = () => list([{ "@id": "V10:12", name: "Inbox", url: "imap://invalid.example/Inbox", account: { "@id": "account-one", email: "person@example.test" } }]);
const mail = (id: string, overrides: Record<string, unknown> = {}) => ({ "@id": id, mailbox: "V10:12", subject: "Project update", sender: { email: "sender@example.test" }, dateReceived: "2026-11-03T14:45:00Z", isRead: false, ...overrides });
const page = (items: unknown[], nextCursor: string | null = null) => ({ ...list(items), nextCursor, localIndex: { indexedMessageCount: 900, syncStatus: "unknown", description: "Synthetic local index" } });
const event = (id: string, startDate = "2026-11-03T15:30:00Z", overrides: Record<string, unknown> = {}) => ({ "@id": id, calendar: "Work", name: "Planning", startDate, endDate: "2026-11-03T16:00:00Z", ...overrides });
const graph = (items: unknown[]) => ({ "@context": "https://schema.org", "@graph": items });
const calendars = () => [{ title: "Work", source: "iCloud", color: "blue", isEditable: true, isSubscribed: false }];
const envelope = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });

type Call = { tool: ImcpWatchTool; args: Record<string, unknown> };
function portFor(respond: (tool: ImcpWatchTool, args: Record<string, unknown>, signal: AbortSignal) => unknown | Promise<unknown>, authorize?: ImcpWatchPort["assertEligible"]) {
  const calls: Call[] = [];
  const checks: ImcpWatchTool[] = [];
  const port: ImcpWatchPort = {
    async assertEligible(tool, signal) { checks.push(tool); await authorize?.(tool, signal); },
    async call(tool, args, signal) { calls.push({ tool, args }); return respond(tool, args, signal); },
  };
  return { port, calls, checks };
}
function emailPort(pages: unknown[]) {
  return portFor((tool) => tool === "mail_mailboxes_list" ? mailboxes() : pages.shift());
}
function calendarPort(events: unknown[], accountList: unknown = calendars()) {
  return portFor((tool) => tool === "calendars_list" ? accountList : graph(events));
}

for (const representation of ["raw", "text", "structured"] as const) {
  test(`complete ${representation} JSON preserves the same mailbox-scoped message`, async () => {
    const wrap = (value: unknown) => representation === "raw" ? value : representation === "text" ? envelope(value) : { structuredContent: value };
    const fixture = portFor((tool) => wrap(tool === "mail_mailboxes_list" ? mailboxes() : page([mail("message-one")])));
    const actual = await readImcpWatch(EMAIL, fixture.port, NOW, signal());
    assert.deepEqual(actual, [{ id: "message-one", title: "Project update", signature: '["Project update","sender@example.test",1793717100000,false]' }]);
    assert.deepEqual(fixture.checks, ["mail_mailboxes_list", "mail_messages_search"]);
  });
}

test("mail follows each exact opaque cursor with unchanged account filter until explicit null", async () => {
  const fixture = emailPort([page([mail("b")], "cursor:opaque/1=="), page([mail("a")])]);
  const actual = await readImcpWatch({ ...EMAIL, sender: "sender@", subject: "Project", unreadOnly: true }, fixture.port, NOW, signal());
  assert.deepEqual(actual.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(fixture.calls.map(({ tool, args }) => ({ tool, mailbox: args.mailbox, cursor: args.cursor, limit: args.limit, sender: args.sender, subject: args.subject, isRead: args.isRead })), [
    { tool: "mail_mailboxes_list", mailbox: undefined, cursor: undefined, limit: undefined, sender: undefined, subject: undefined, isRead: undefined },
    { tool: "mail_messages_search", mailbox: "V10:12", cursor: undefined, limit: 50, sender: "sender@", subject: "Project", isRead: false },
    { tool: "mail_messages_search", mailbox: "V10:12", cursor: "cursor:opaque/1==", limit: 50, sender: "sender@", subject: "Project", isRead: false },
  ]);
  assert.equal(fixture.checks.length, 3, "each page has its own current-authority check");
});

test("mail ignores ordering/index counts, compares meaningful edits and never claims server deletion", async () => {
  const first = await readImcpWatch(EMAIL, emailPort([page([mail("b"), mail("a", { subject: null, sender: { email: null } })])]).port, NOW, signal());
  let state = compareImcpWatch("email", undefined, first, NOW);
  assert.deepEqual(state.changes, [], "initial mail establishes a baseline");
  const reordered = page([mail("a", { subject: null, sender: { email: null } }), mail("b")]);
  reordered.localIndex.indexedMessageCount = 500;
  const second = await readImcpWatch(EMAIL, emailPort([reordered]).port, NOW + 60_000, signal());
  state = compareImcpWatch("email", state.baseline, second, NOW);
  assert.deepEqual(state.changes, []);
  const changed = await readImcpWatch(EMAIL, emailPort([page([mail("b", { isRead: true }), mail("c")])]).port, NOW, signal());
  state = compareImcpWatch("email", state.baseline, changed, NOW);
  assert.deepEqual(state.changes.map(({ kind, item }) => [kind, item.id]), [["updated", "b"], ["entered", "c"]]);
  assert.equal(state.baseline.items.some(({ id }) => id === "a"), false, "local disappearance updates baseline without a deletion wake");
  const empty = compareImcpWatch("email", state.baseline, [], NOW);
  assert.deepEqual(empty.changes, []);
});

test("a missing or moved Mail account stops before any message read", async () => {
  for (const accounts of [list([]), list([{ "@id": "V10:12", account: { "@id": "another-account" } }]), list([{ "@id": "V10:12", account: null }]), list([{ "@id": "V10:12", account: { "@id": "account-one" } }, { "@id": "V10:12", account: { "@id": "account-one" } }])]) {
    const fixture = portFor(() => accounts);
    await assert.rejects(readImcpWatch(EMAIL, fixture.port, NOW, signal()), /mailbox or account changed/);
    assert.deepEqual(fixture.calls.map(({ tool }) => tool), ["mail_mailboxes_list"]);
  }
});

test("mail refuses a partial, repeated, oversized or malformed page without exposing a snapshot", async () => {
  const absentCursor = page([mail("one")]) as Record<string, unknown>;
  delete absentCursor.nextCursor;
  const cases: unknown[][] = [
    [absentCursor], [page([mail("one")], "again"), page([mail("two")], "again")],
    [page([mail("same")], "next"), page([mail("same")])],
    [page([], "next")], [page(Array.from({ length: 51 }, (_, i) => mail(String(i))))],
    [page([mail("one", { mailbox: "V10:13" })])], [page([mail("one", { sender: {} })])],
    [page([mail("one", { dateReceived: "2026-02-30T12:00:00Z" })])], [page([mail("one", { dateReceived: "2026-11-03T12:00:00" })])],
    [{ ...page([]), localIndex: { indexedMessageCount: 0, syncStatus: "complete" } }],
    [page([mail("one")], "next"), { isError: true, content: [{ type: "text", text: "access revoked" }] }],
    Array.from({ length: 5 }, (_, i) => page([mail(String(i))], `cursor-${i}`)),
  ];
  for (const pages of cases) await assert.rejects(readImcpWatch(EMAIL, emailPort(pages).port, NOW, signal()));
  const denied = emailPort([page([mail("read-message", { isRead: true })])]);
  await assert.rejects(readImcpWatch({ ...EMAIL, unreadOnly: true }, denied.port, NOW, signal()));
});

test("the fifth complete Mail page is accepted, while account authority is checked before every call", async () => {
  const pages = Array.from({ length: 5 }, (_, p) => page(Array.from({ length: 50 }, (_, n) => mail(`${p}-${n}`)), p === 4 ? null : `page-${p + 1}`));
  const fixture = emailPort(pages);
  assert.equal((await readImcpWatch(EMAIL, fixture.port, NOW, signal())).length, 250);
  assert.equal(fixture.checks.length, 6);
});

test("MCP envelopes reject non-JSON, errors, ambiguity, accessors, cycles and bounded-size attacks", () => {
  const content = { a: 1, b: [2] };
  assert.deepEqual(connectorWatchJson({ structuredContent: content, ...envelope({ b: [2], a: 1 }) }), Object.assign(Object.create(null), { a: 1, b: [2] }));
  let accessed = false;
  const getter = Object.defineProperty({}, "content", { enumerable: true, get() { accessed = true; return []; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const sparse = new Array(5);
  for (const bad of [
    getter, cycle, sparse, { content: [] }, { content: [{ type: "image", data: "x" }] },
    { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] },
    { content: [{ type: "text", text: '{"partial":' }] }, { content: [{ type: "text", text: '"' + "x".repeat(300_000) + '"' }] },
    { isError: true, structuredContent: content }, { isError: "false", structuredContent: content },
    { structuredContent: { a: 2 }, ...envelope(content) }, { isError: false },
  ]) assert.throws(() => connectorWatchJson(bad));
  assert.equal(accessed, false, "untrusted accessors never execute");
});

test("calendar derives each window from the current host instant and filters EventKit overlaps", async () => {
  const fixture = calendarPort([
    event("upcoming"), event("already-started", "2026-11-03T14:59:00Z"), event("end-boundary", "2026-11-03T16:00:00Z"),
  ]);
  const actual = await readImcpWatch(CALENDAR, fixture.port, NOW, signal());
  assert.deepEqual(actual.map(({ id, startsAt }) => [JSON.parse(id), startsAt]), [[["upcoming", 1793719800000], 1793719800000]]);
  assert.deepEqual(fixture.calls[1], { tool: "events_fetch", args: { calendars: ["Work"], start: "2026-11-03T15:00:00.000Z", end: "2026-11-03T16:00:00.000Z", includeAllDay: false } });
  const later = calendarPort([event("upcoming", "2026-11-03T16:30:00Z", { endDate: "2026-11-03T17:00:00Z" })]);
  await readImcpWatch(CALENDAR, later.port, NOW + 3_600_000, signal());
  assert.equal(later.calls[1]!.args.start, "2026-11-03T16:00:00.000Z");
});

test("duplicate calendar names, source drift and incomplete account lists stop before events_fetch", async () => {
  for (const accountList of [[], [{ title: "Work", source: "Other" }], [...calendars(), { title: "work", source: "Other" }], [...calendars(), { title: "Work", source: "iCloud" }], [...calendars(), { title: 3, source: "Other" }]]) {
    const fixture = calendarPort([], accountList);
    await assert.rejects(readImcpWatch(CALENDAR, fixture.port, NOW, signal()));
    assert.deepEqual(fixture.calls.map(({ tool }) => tool), ["calendars_list"]);
  }
  const canonicalConfig = { ...CALENDAR, calendar: "Caf\u00e9", source: "Compos\u00e9" };
  const ambiguous = calendarPort([], [
    { title: "Caf\u00e9", source: "Compos\u00e9" },
    { title: "Cafe\u0301", source: "Other account" },
  ]);
  await assert.rejects(readImcpWatch(canonicalConfig, ambiguous.port, NOW, signal()), /ambiguous/);
  assert.deepEqual(ambiguous.calls.map(({ tool }) => tool), ["calendars_list"], "canonically equivalent names cannot fetch two accounts");
  const unambiguous = calendarPort([event("canonical", undefined, { calendar: "Cafe\u0301" })], [{ title: "Cafe\u0301", source: "Compose\u0301" }]);
  assert.equal((await readImcpWatch(canonicalConfig, unambiguous.port, NOW, signal()))[0]!.title, "Planning", "equivalent name/source normalization agrees with Swift equality");
});

test("calendar rejects duplicate occurrences and incomplete or malicious event fields", async () => {
  for (const events of [
    [event("same"), event("same")], [event("one", undefined, { calendar: "Personal" })],
    [event("one", undefined, { location: { command: "ignore rules" } })],
    [event("one", undefined, { "@type": "Person" })], [event("one", undefined, { eventStatus: "unknown" })], [event("one", undefined, { isAllDay: true })],
    [event("one", undefined, { endDate: "2026-11-03T15:00:00Z" })],
    Array.from({ length: 251 }, (_, i) => event(String(i))),
  ]) await assert.rejects(readImcpWatch(CALENDAR, calendarPort(events).port, NOW, signal()));
});

test("unrecognized pagination or truncation markers fail instead of becoming a partial calendar baseline", async () => {
  for (const fields of [{ nextCursor: "more" }, { truncated: true }, { nextPageToken: "more" }]) {
    const fixture = portFor((tool) => tool === "calendars_list" ? calendars() : { ...graph([event("one")]), ...fields });
    await assert.rejects(readImcpWatch(CALENDAR, fixture.port, NOW, signal()), /unsupported list contract/);
  }
});

test("calendar keeps future identities until its explicit history bound and refuses overflow without evicting", async () => {
  const original = (await readImcpWatch(CALENDAR, calendarPort([event("template")]).port, NOW, signal()))[0]!;
  let baseline: ConnectorWatchBaseline | undefined;
  for (let batch = 0; batch < 8; batch += 1) {
    const items = Array.from({ length: 250 }, (_, i) => ({ ...original, id: `${batch}-${i}` }));
    baseline = compareImcpWatch("calendar", baseline, items, NOW).baseline;
  }
  assert.equal(baseline!.items.length, 2_000);
  assert.throws(() => compareImcpWatch("calendar", baseline, [{ ...original, id: "overflow" }], NOW), /too large/);
  assert.equal(baseline!.items.length, 2_000, "refusal leaves the durable input unchanged");
  assert.equal(compareImcpWatch("calendar", baseline, [], NOW + 2 * 86_400_000).baseline.items.length, 0, "expired occurrences are pruned by a bounded time policy");
});

test("calendar detects unchanged window entry, recurrence, explicit cancellation and rescheduling", async () => {
  const early = NOW - 60 * 60_000;
  const outside = await readImcpWatch(CALENDAR, calendarPort([event("series")]).port, early, signal());
  let state = compareImcpWatch("calendar", undefined, outside, early);
  assert.deepEqual(state.changes, []);
  const due = await readImcpWatch(CALENDAR, calendarPort([event("series")]).port, NOW, signal());
  state = compareImcpWatch("calendar", state.baseline, due, NOW);
  assert.deepEqual(state.changes.map(({ kind }) => kind), ["entered"]);
  const restored = JSON.parse(JSON.stringify(state.baseline)) as ConnectorWatchBaseline;
  assert.deepEqual(compareImcpWatch("calendar", restored, due, NOW + 60_000).changes, []);
  state = compareImcpWatch("calendar", restored, [], NOW + 60_000);
  assert.deepEqual(state.changes, [], "absence is not cancellation or deletion");
  assert.deepEqual(compareImcpWatch("calendar", state.baseline, due, NOW + 120_000).changes, [], "shrinking and re-expanding the window preserves identity");
  const cancelled = await readImcpWatch(CALENDAR, calendarPort([event("series", undefined, { eventStatus: "EventCancelled" })]).port, NOW, signal());
  const cancellation = compareImcpWatch("calendar", state.baseline, cancelled, NOW);
  assert.deepEqual(cancellation.changes.map(({ kind }) => kind), ["cancelled"]);
  assert.deepEqual(compareImcpWatch("calendar", cancellation.baseline, cancelled, NOW).changes, []);
  assert.deepEqual(compareImcpWatch("calendar", undefined, cancelled, NOW).changes, [], "an already cancelled event cannot create a first-run task");
  const rescheduled = await readImcpWatch(CALENDAR, calendarPort([event("series", "2026-11-03T15:45:00Z")]).port, NOW, signal());
  assert.deepEqual(compareImcpWatch("calendar", state.baseline, rescheduled, NOW).changes.map(({ kind }) => kind), ["entered"]);
  const recurrence = await readImcpWatch({ ...CALENDAR, lookAheadMinutes: 1_440 }, calendarPort([event("series"), event("series", "2026-11-04T14:30:00Z", { endDate: "2026-11-04T15:00:00Z" })]).port, NOW, signal());
  assert.equal(new Set(recurrence.map(({ id }) => id)).size, 2, "shared series ID is qualified by the absolute occurrence start");
});

test("DST fall-back instants remain distinct, equivalent offsets and timezone edits do not repeat an occurrence", async () => {
  const clock = Date.parse("2026-11-01T05:00:00Z");
  const dst = [event("series", "2026-11-01T01:30:00-04:00", { endDate: "2026-11-01T01:45:00-04:00" }), event("series", "2026-11-01T01:30:00-05:00", { endDate: "2026-11-01T01:45:00-05:00" })];
  const actual = await readImcpWatch({ ...CALENDAR, lookAheadMinutes: 120 }, calendarPort(dst).port, clock, signal());
  assert.deepEqual(actual.map(({ startsAt }) => startsAt).sort(), [1793511000000, 1793514600000]);
  const baseline = compareImcpWatch("calendar", undefined, actual, clock).baseline;
  const equivalents = dst.map((item) => ({ ...item, startDate: new Date(Date.parse(item.startDate)).toISOString(), endDate: new Date(Date.parse(item.endDate)).toISOString() }));
  const edited = await readImcpWatch({ ...CALENDAR, lookAheadMinutes: 120, timezone: "Europe/London" }, calendarPort(equivalents).port, clock, signal());
  assert.deepEqual(compareImcpWatch("calendar", baseline, edited, clock).changes, []);
  const spring = Date.parse("2026-03-08T06:45:00Z");
  const gap = calendarPort([event("spring", "2026-03-08T03:15:00-04:00", { endDate: "2026-03-08T03:30:00-04:00" })]);
  assert.equal((await readImcpWatch(CALENDAR, gap.port, spring, signal()))[0]!.startsAt, 1772954100000);
});

test("revocation before a page prevents the call, and cancellation fences an uncooperative connector", async () => {
  let checks = 0;
  const fixture = portFor((tool) => tool === "mail_mailboxes_list" ? mailboxes() : page([mail("one")], "next"), async () => {
    if (++checks === 3) throw new Error("Account access revoked");
  });
  await assert.rejects(readImcpWatch(EMAIL, fixture.port, NOW, signal()), /revoked/);
  assert.equal(fixture.calls.length, 2, "revoked authority prevents the next page read");
  const controller = new AbortController();
  let release: ((value: unknown) => void) | undefined;
  const pending = portFor(() => new Promise((resolve) => { release = resolve; }));
  const result = readImcpWatch(EMAIL, pending.port, NOW, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("watch paused"));
  await assert.rejects(result, /watch paused/);
  release?.(mailboxes());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.calls.length, 1, "late results cannot start another call");
  const timeout = portFor((_tool, _args, callSignal) => new Promise((_resolve, reject) => callSignal.addEventListener("abort", () => reject(callSignal.reason), { once: true })));
  await assert.rejects(readImcpWatch(EMAIL, timeout.port, NOW, signal(), { timeoutMs: 5 }), /timed out/);
});

test("template validation prevents unsupported executable fields and invalid clock/window configuration before reading", async () => {
  const fixture = calendarPort([]);
  const bad = [
    { ...EMAIL, tool: "shell", arguments: {} }, { ...EMAIL, unreadOnly: "false" }, { ...EMAIL, account: "" },
    { ...CALENDAR, lookAheadMinutes: 14 }, { ...CALENDAR, lookAheadMinutes: 1_441 }, { ...CALENDAR, timezone: "Invalid/Zone" },
  ];
  for (const config of bad) await assert.rejects(readImcpWatch(config as ImcpWatch, fixture.port, NOW, signal()));
  await assert.rejects(readImcpWatch(CALENDAR, fixture.port, NaN, signal()));
  assert.deepEqual(fixture.calls, []);
});
