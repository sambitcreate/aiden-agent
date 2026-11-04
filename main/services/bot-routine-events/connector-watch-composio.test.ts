import assert from "node:assert/strict";
import test from "node:test";
import { verifyCalendarContract } from "./composio-calendar-contract.js";
import { syntheticCalendarMetadata, syntheticCalendarSchemas } from "./composio-calendar-test-support.js";
import {
  COMPOSIO_CALENDAR_ADAPTER, buildComposioCalendarExecutorRequest, discoverComposioCalendarSources,
  parseComposioCalendarBaseline, readComposioCalendarWatch,
  type ComposioCalendarBaseline, type ComposioCalendarDiscoveryPort, type ComposioCalendarRead,
  type ComposioCalendarReadPort, type ComposioCalendarSource,
} from "./connector-watch-composio.js";

// Synthetic candidate contracts only. No fixture is captured account data or
// evidence that the installed executor honors its account selector/envelope.
const NOW = Date.parse("2026-11-03T15:00:00Z");
const source: ComposioCalendarSource = { accountId: "immutable_account_one", calendarId: "calendar-one@example.test", labels: { providerLabel: "Composio Calendar", accountLabel: "Work account", resourceLabel: "Planning" } };
const condition = { lookAheadMinutes: 60, timezone: "America/New_York" };
const signal = () => new AbortController().signal;
const event = (id: string, overrides: Record<string, unknown> = {}) => ({ id, status: "confirmed", summary: "Planning", start: { dateTime: "2026-11-03T15:30:00Z" }, end: { dateTime: "2026-11-03T15:45:00Z" }, ...overrides });
const slug = (read: ComposioCalendarRead) => read.kind === "listCalendars" ? "GOOGLECALENDAR_LIST_CALENDARS" : read.kind === "listEvents" ? "GOOGLECALENDAR_EVENTS_LIST" : "GOOGLECALENDAR_EVENTS_GET";
function executor(read: ComposioCalendarRead, response: unknown) { return { successful: true, data: { results: [{ tool_slug: slug(read), index: 0, response }], total_count: 1, success_count: 1, error_count: 0 } }; }
function search(accountList: unknown[] = [{ id: source.accountId, alias: "default_alias", status: "ACTIVE", is_default: true, user_info: { email: "owner@example.test" } }]) {
  return { successful: true, data: { toolkit_connection_statuses: [{ toolkit: "GOOGLECALENDAR", has_active_connection: true, accounts: accountList }] } };
}
function fixture(respond: (read: ComposioCalendarRead) => unknown | Promise<unknown>, guard?: ComposioCalendarReadPort["assertCurrent"]) {
  const calls: ComposioCalendarRead[] = []; const checks: ComposioCalendarRead[] = [];
  const port: ComposioCalendarReadPort = {
    async assertCurrent(read, current) { checks.push({ ...read }); current.throwIfAborted(); await guard?.(read, current); },
    async read(read) { calls.push({ ...read }); return executor(read, await respond(read)); },
  };
  return { port, calls, checks };
}
function discovery(metadata = search(), respond: (read: ComposioCalendarRead) => unknown = () => ({ items: [{ id: source.calendarId, summary: "Planning", accessRole: "reader" }] })) {
  const f = fixture(respond); let searches = 0, discoveryChecks = 0;
  const port: ComposioCalendarDiscoveryPort = { ...f.port, async assertDiscoveryCurrent() { discoveryChecks++; }, async currentAccounts() { searches++; return metadata; } };
  return { ...f, port, counts: () => ({ searches, discoveryChecks }) };
}
const read = (f: ReturnType<typeof fixture>, previous?: ComposioCalendarBaseline, now = NOW) => readComposioCalendarWatch(source, condition, previous, f.port, now, signal());
function validatedPages<T extends { port: ComposioCalendarReadPort }>(value: T, wrapped = false): T {
  const schemas = syntheticCalendarSchemas();
  const page = { type: "object", properties: { items: { type: "array", items: { type: "object" } }, nextPageToken: { type: "string" }, next_page_token: { type: "string" } }, required: ["items"] };
  for (const slug of ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST"]) schemas.data.tool_schemas[slug]!.output_schema = (wrapped ? { type: "object", properties: { successful: { type: "boolean" }, data: page } } : page) as never;
  const verified = verifyCalendarContract(syntheticCalendarMetadata(), schemas), original = value.port.read.bind(value.port);
  value.port.read = async (request, current) => { const reply = await original(request, current); verified.response(request, reply); return reply; };
  return value;
}

test("Calendar remains gated and its builder emits one explicit-account curated read", () => {
  assert.equal(COMPOSIO_CALENDAR_ADAPTER.available, false);
  const request = buildComposioCalendarExecutorRequest({ kind: "listEvents", accountId: "chosen_account", calendarId: "explicit@example.test", timeMin: "2026-11-03T15:00:00Z", timeMax: "2026-11-03T16:00:00Z", timezone: "UTC", pageToken: "opaque==/cursor" });
  assert.equal(request.tools.length, 1); assert.equal(request.sync_response_to_workbench, false);
  assert.equal(request.tools[0].account, "chosen_account"); assert.equal(request.tools[0].tool_slug, "GOOGLECALENDAR_EVENTS_LIST");
  assert.equal(request.tools[0].arguments.calendarId, "explicit@example.test"); assert.equal(request.tools[0].arguments.pageToken, "opaque==/cursor");
  assert.equal(request.tools[0].arguments.singleEvents, true); assert.equal(request.tools[0].arguments.showDeleted, true);
  assert.equal(request.tools[0].arguments.syncToken, undefined); assert.equal(request.tools[0].arguments.query, undefined);
  for (const invalid of [
    { kind: "proxy", accountId: "chosen_account", url: "https://example.test" },
    { kind: "listCalendars", accountId: "chosen_account", tools: [{ tool_slug: "DELETE" }] },
    { kind: "getEvent", accountId: "chosen_account", calendarId: "primary", eventId: "one", timezone: "UTC" },
    { kind: "getEvent", accountId: "chosen_account", calendarId: "ca_account", eventId: "one", timezone: "UTC" },
    { kind: "listCalendars", accountId: "chosen_account", sync_response_to_workbench: true },
  ]) assert.throws(() => buildComposioCalendarExecutorRequest(invalid as ComposioCalendarRead));
});

test("foreground discovery selects actual ACTIVE account IDs, never alias/default/manual identity", async () => {
  const f = discovery(search([
    { id: "immutable_A", alias: "same_alias", status: "ACTIVE", is_default: false },
    { id: "immutable_B", alias: "same_alias", status: "ACTIVE", is_default: true },
    { id: "inactive_C", status: "EXPIRED", is_default: true },
  ]), (request) => ({ items: [{ id: `${request.accountId}@example.test`, summary: "Same title", accessRole: "owner" }] }));
  const choices = await discoverComposioCalendarSources(f.port, signal());
  assert.deepEqual(choices.map((item) => [item.accountId, item.calendarId]), [["immutable_A", "immutable_A@example.test"], ["immutable_B", "immutable_B@example.test"]]);
  assert.equal(f.counts().searches, 1); assert.equal(f.calls.every((call) => call.kind === "listCalendars"), true);
  assert.equal(JSON.stringify(f.calls).includes("same_alias"), false);
  assert.equal(choices.every((item) => item.labels.accountLabel === "Connected Calendar account"), true);
});

test("discovery refuses incomplete account identity without any executor call", async () => {
  const invalid = [search([{ alias: "looks_like_an_id", status: "ACTIVE" }]), search([{ id: "duplicate", status: "ACTIVE" }, { id: "duplicate", status: "ACTIVE" }]), search([{ id: "only_inactive", status: "EXPIRED" }]), { available: false, privateProof: { activeConnectionReported: { calendar: true } } }, { successful: true, data: { toolkit_connection_statuses: [{ toolkit: "googlecalendar", has_active_connection: true }] } }];
  for (const metadata of invalid) {
    const f = discovery(metadata as ReturnType<typeof search>);
    await assert.rejects(discoverComposioCalendarSources(f.port, signal())); assert.equal(f.calls.length, 0);
  }
});

test("source enumeration follows exact empty-page cursors and excludes insufficient access", async () => {
  const f = validatedPages(discovery(search(), (request) => request.kind === "listCalendars" && request.pageToken ? { items: [{ id: "busy@example.test", summary: "Busy", accessRole: "freeBusyReader" }, { id: source.calendarId, summary: "Planning", accessRole: "reader" }], next_page_token: null } : { items: [], next_page_token: "opaque account page==" }));
  const choices = await discoverComposioCalendarSources(f.port, signal());
  assert.equal(choices.length, 1); assert.equal(choices[0]!.calendarId, source.calendarId);
  assert.deepEqual(f.calls.map((call) => call.kind === "listCalendars" ? call.pageToken : "wrong"), [undefined, "opaque account page=="]);
  const loop = validatedPages(discovery(search(), () => ({ items: [], next_page_token: "again" })));
  await assert.rejects(discoverComposioCalendarSources(loop.port, signal())); assert.equal(loop.calls.length, 2);
  let count = 0; const fifth = validatedPages(discovery(search(), () => ({ items: [], next_page_token: `next-${++count}` })));
  await assert.rejects(discoverComposioCalendarSources(fifth.port, signal())); assert.equal(fifth.calls.length, 5, "never requests a sixth page");
});

test("source display truncation preserves surrogate pairs without exposing arbitrary user_info", async () => {
  const f = discovery(search([{ id: source.accountId, status: "ACTIVE", user_info: { email: "X" + "😀".repeat(250), instruction: "execute this script" } }]), () => ({ items: [{ id: source.calendarId, summary: "Y" + "😀".repeat(250), accessRole: "reader" }] }));
  const [choice] = await discoverComposioCalendarSources(f.port, signal());
  for (const label of Object.values(choice!.labels)) { assert.ok(label.length <= 500); assert.equal(/\ud83d$/u.test(label), false); }
  assert.equal(JSON.stringify(choice).includes("execute this script"), false);
});

test("background reads never Search and saved binding data cannot bypass current admission", async () => {
  let searches = 0;
  const f = fixture(() => ({ items: [event("one")] }));
  const port = { ...f.port, async currentAccounts() { searches++; throw new Error("Search is foreground-only"); } };
  const result = await readComposioCalendarWatch(source, condition, undefined, port, NOW, signal());
  assert.equal(result.changes[0]!.kind, "entered"); assert.equal(searches, 0);
  assert.equal(f.checks.length, 2, "actual send has both current-admission boundaries");
  const denied = fixture(() => ({ items: [] }), async () => { throw new Error("source proof was revoked"); });
  await assert.rejects(read(denied)); assert.equal(denied.calls.length, 0);
});

test("rolling window uses host time and explicit timezone, ignores overlaps/all-day, then detects entry", async () => {
  const f = fixture(() => ({ items: [event("past", { start: { dateTime: "2026-11-03T14:59:00Z" } }), event("at-start", { start: { dateTime: "2026-11-03T15:00:00Z" } }), event("at-end", { start: { dateTime: "2026-11-03T16:00:00Z" }, end: { dateTime: "2026-11-03T16:30:00Z" } }), event("all-day", { start: { date: "2026-11-03" }, end: { date: "2026-11-04" }, recurringEventId: "all-day-series", originalStartTime: { date: "2026-11-03" } })] }));
  const first = await read(f); assert.deepEqual(first.items.map((item) => item.eventId), ["at-start"]);
  const request = f.calls[0]!; assert.equal(request.kind, "listEvents"); if (request.kind !== "listEvents") return;
  assert.equal(request.timeMin, "2026-11-03T15:00:00.000Z"); assert.equal(request.timeMax, "2026-11-03T16:00:00.000Z"); assert.equal(request.timezone, "America/New_York");
  const next = fixture(() => ({ items: [event("at-end", { start: { dateTime: "2026-11-03T16:00:00Z" }, end: { dateTime: "2026-11-03T16:30:00Z" } })] }));
  const entered = await read(next, first.baseline, NOW + 60 * 60_000); assert.deepEqual(entered.changes.map((change) => [change.kind, change.item.title]), [["entered", "Planning"]]);
});

test("empty event pages continue exact cursor without changing account, calendar or window", async () => {
  const f = validatedPages(fixture((request) => request.kind === "listEvents" && request.pageToken ? { items: [event("one")], nextPageToken: null } : { items: [], nextPageToken: "cursor::/opaque==" }));
  const result = await read(f); assert.equal(result.items.length, 1);
  const [first, second] = f.calls; assert.equal(first!.kind, "listEvents"); assert.equal(second!.kind, "listEvents");
  assert.deepEqual(second, { ...first, pageToken: "cursor::/opaque==" });
  assert.equal(f.checks.length, 4);
});

test("validated null page ends and absent cursors have identical whole-reader source and event behavior", async () => {
  for (const wrapped of [false, true]) {
    const results: unknown[] = [];
    for (const nullEnd of [false, true]) {
      const represent = (page: Record<string, unknown>) => wrapped ? { successful: true, data: page } : page;
      const ending = nullEnd ? { nextPageToken: null } : {};
      const sources = validatedPages(discovery(search(), (request) => represent(request.kind === "listCalendars" && request.pageToken ? { items: [{ id: source.calendarId, summary: "Planning", accessRole: "reader" }], ...ending } : { items: [], nextPageToken: "source-page==" })), wrapped);
      const choices = await discoverComposioCalendarSources(sources.port, signal());
      const events = validatedPages(fixture((request) => represent(request.kind === "listEvents" && request.pageToken ? { items: [event("one")], ...ending } : { items: [], nextPageToken: "event-page==" })), wrapped);
      const result = await read(events);
      assert.deepEqual(sources.calls.map((request) => request.kind === "listCalendars" ? request.pageToken : "wrong"), [undefined, "source-page=="]);
      assert.deepEqual(events.calls.map((request) => request.kind === "listEvents" ? request.pageToken : "wrong"), [undefined, "event-page=="]);
      results.push({ choices, items: result.items, changes: result.changes, baseline: result.baseline });
    }
    assert.deepEqual(results[0], results[1]);
    const empty = validatedPages(fixture(() => wrapped ? { successful: true, data: { items: [], next_page_token: null } } : { items: [], next_page_token: null }), wrapped);
    assert.deepEqual((await read(empty)).items, []); assert.equal(empty.calls.length, 1);
  }
});

test("null-end validation preserves conflicting cursors and partial/offload refusal in the original reply", async () => {
  for (const payload of [
    { items: [], nextPageToken: null, next_page_token: null },
    { items: [], nextPageToken: null, truncated: true },
    { items: [], nextPageToken: null, remote_file_info: { path: "private-offload" } },
    { items: [], nextPageToken: null, has_more: true },
  ]) {
    const f = validatedPages(fixture(() => ({ successful: true, data: payload })), true);
    await assert.rejects(read(f)); assert.equal(f.calls.length, 1);
  }
});

test("recurrence identity survives rescheduling, ordering and restart without a second entry", async () => {
  const recurring = (overrides: Record<string, unknown> = {}) => event("instance", { recurringEventId: "series", originalStartTime: { dateTime: "2026-11-03T15:30:00Z" }, ...overrides });
  const first = await read(fixture(() => ({ items: [recurring()] })));
  assert.deepEqual(first.changes.map((change) => change.kind), ["entered"]);
  const saved = parseComposioCalendarBaseline(JSON.parse(JSON.stringify(first.baseline))); assert.ok(saved);
  const rescheduled = await read(fixture(() => ({ items: [recurring({ start: { dateTime: "2026-11-03T15:40:00Z" }, end: { dateTime: "2026-11-03T15:55:00Z" } })] })), saved);
  assert.equal(rescheduled.items[0]!.id, first.items[0]!.id); assert.deepEqual(rescheduled.changes.map((change) => change.kind), ["updated"]);
  const unchanged = await read(fixture(() => ({ items: [recurring({ start: { dateTime: "2026-11-03T10:40:00-05:00" }, end: { dateTime: "2026-11-03T10:55:00-05:00" }, updated: "cosmetic fetch field" })] })), rescheduled.baseline);
  assert.deepEqual(unchanged.changes, []);
});

test("missing future event is fetched by exact saved event ID; movement outside window is one update", async () => {
  const first = await read(fixture(() => ({ items: [event("one")] })));
  const f = fixture((request) => request.kind === "listEvents" ? { items: [] } : event("one", { start: { dateTime: "2026-11-03T20:00:00Z" }, end: { dateTime: "2026-11-03T20:30:00Z" } }));
  const moved = await read(f, first.baseline);
  assert.deepEqual(f.calls.map((request) => request.kind), ["listEvents", "getEvent"]);
  assert.deepEqual(f.calls[1], { kind: "getEvent", accountId: source.accountId, calendarId: source.calendarId, eventId: "one", timezone: condition.timezone });
  assert.deepEqual(moved.changes.map((change) => change.kind), ["updated"]); assert.equal(moved.items[0]!.id, first.items[0]!.id);
  const again = await read(f, moved.baseline); assert.deepEqual(again.changes, []);
  const cancelled = await read(fixture((request) => request.kind === "listEvents" ? { items: [] } : { id: "one", status: "cancelled" }), moved.baseline);
  assert.deepEqual(cancelled.changes.map((change) => change.kind), ["cancelled"]);
  const noRepeat = await read(fixture(() => ({ items: [] })), cancelled.baseline); assert.deepEqual(noRepeat.changes, []);
});

test("minimal recurring cancellation uses original occurrence or saved event ID, never disappearance", async () => {
  const first = await read(fixture(() => ({ items: [event("instance", { recurringEventId: "series", originalStartTime: { dateTime: "2026-11-03T15:30:00Z" } })] })));
  for (const cancelled of [{ id: "instance", status: "cancelled" }, { id: "instance", status: "cancelled", recurringEventId: "series", originalStartTime: { dateTime: "2026-11-03T15:30:00Z" } }]) {
    const actual = await read(fixture(() => ({ items: [cancelled] })), first.baseline);
    assert.deepEqual(actual.changes.map((change) => change.kind), ["cancelled"]); assert.equal(actual.items[0]!.id, first.items[0]!.id);
  }
  const unknown = await read(fixture(() => ({ items: [{ id: "unobserved", status: "cancelled" }] })));
  assert.deepEqual(unknown.changes, []);
  const failed = fixture((request) => { if (request.kind === "getEvent") throw new Error("404 or account revoked"); return { items: [] }; });
  const frozen = JSON.stringify(first.baseline); await assert.rejects(read(failed, first.baseline)); assert.equal(JSON.stringify(first.baseline), frozen);
});

test("malformed, repeated and incomplete results never become a partial baseline", async () => {
  const cases = [
    { items: [event("duplicate"), event("duplicate")] },
    { items: [event("one", { start: { dateTime: "2026-02-30T15:00:00Z" } })] },
    { items: [event("one", { start: { dateTime: "2026-11-03T15:00:00" } })] },
    { items: [event("one", { recurringEventId: "series" })] },
    { items: [event("one", { status: "unknown" })] },
    { items: [event("one", { location: { executable: "bad" } })] },
    { items: [], remote_file_info: { path: "not-a-page" } },
    { items: [], nextPageToken: "one", next_page_token: "two" },
    { items: [] , truncated: true },
    { nextPageToken: "one" },
  ];
  for (const response of cases) await assert.rejects(read(fixture(() => response)));
  const loop = validatedPages(fixture(() => ({ items: [], nextPageToken: "again" }))); await assert.rejects(read(loop)); assert.equal(loop.calls.length, 2);
  let cursor = 0; const fifth = validatedPages(fixture(() => ({ items: [], nextPageToken: `page-${++cursor}` }))); await assert.rejects(read(fifth)); assert.equal(fifth.calls.length, 5);
});

test("executor envelope requires one exact correlated success, with no partial/offloaded result", async () => {
  const changes: Array<(value: ReturnType<typeof executor>) => void> = [
    (value) => { value.successful = false; }, (value) => { value.data.total_count = 2; },
    (value) => { value.data.success_count = 0; }, (value) => { value.data.error_count = 1; },
    (value) => { value.data.results[0]!.index = 1; }, (value) => { value.data.results[0]!.tool_slug = "GOOGLECALENDAR_EVENTS_GET"; },
    (value) => { value.data.results.push({ ...value.data.results[0]! }); },
    (value) => { Object.assign(value.data, { remote_file_info: { path: "/private/data" } }); },
    (value) => { Object.assign(value.data.results[0]!, { error: "account not found" }); },
    (value) => { Object.assign(value.data, { nextPageToken: "partial executor result" }); },
  ];
  for (const mutate of changes) {
    let calls = 0;
    const port: ComposioCalendarReadPort = { async assertCurrent() {}, async read(request) { calls++; const result = executor(request, { items: [event("one")] }); mutate(result); return result; } };
    await assert.rejects(readComposioCalendarWatch(source, condition, undefined, port, NOW, signal())); assert.equal(calls, 1);
  }
});

test("complete MCP/nested action representations agree, conflicting JSON and malformed data reject", async () => {
  for (const form of ["text", "structured", "structured-empty", "nested"] as const) {
    const port: ComposioCalendarReadPort = { async assertCurrent() {}, async read(request) {
      const result = executor(request, form === "nested" ? { successful: true, data: { items: [event("one")] } } : { items: [event("one")] });
      return form === "text" ? { content: [{ type: "text", text: JSON.stringify(result) }] } : form === "structured" ? { structuredContent: result } : form === "structured-empty" ? { content: [], structuredContent: result } : result;
    } };
    const result = await readComposioCalendarWatch(source, condition, undefined, port, NOW, signal()); assert.equal(result.items[0]!.eventId, "one");
  }
  let accessed = false;
  const accessor = Object.defineProperty({}, "successful", { enumerable: true, get() { accessed = true; return true; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const bad of [accessor, cycle, { isError: true }, { content: [] }, { content: [{ type: "text", text: "{}" }], structuredContent: { disagree: true } }]) {
    const port: ComposioCalendarReadPort = { async assertCurrent() {}, async read() { return bad; } };
    await assert.rejects(readComposioCalendarWatch(source, condition, undefined, port, NOW, signal()));
  }
  assert.equal(accessed, false);
});

test("revocation after a read and pause during a page fence prevent later I/O/publication", async () => {
  let current = true;
  const f = fixture(() => { current = false; return { items: [event("one")], nextPageToken: "more" }; }, async () => { if (!current) throw new Error("paused"); });
  await assert.rejects(read(f)); assert.equal(f.calls.length, 1);
  const controller = new AbortController(); let release!: () => void, started!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { started = resolve; });
  const slow = fixture(async () => { started(); await barrier; return { items: [], nextPageToken: "more" }; });
  const pending = readComposioCalendarWatch(source, condition, undefined, slow.port, NOW, controller.signal);
  await entered; controller.abort(); await assert.rejects(pending); release(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(slow.calls.length, 1);
});

test("whole deadline includes noncooperative admission and late completion cannot start a read", async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(() => ({ items: [] }), async () => held);
  await assert.rejects(readComposioCalendarWatch(source, condition, undefined, f.port, NOW, signal(), { timeoutMs: 10 }), /timed out/u);
  assert.equal(f.calls.length, 0); release(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.calls.length, 0);
});

test("invalid saved source/history and excessive missing-future work refuse before GET", async () => {
  const first = await read(fixture(() => ({ items: Array.from({ length: 17 }, (_, index) => event(`event-${index}`)) })));
  const f = fixture(() => ({ items: [] })); const before = JSON.stringify(first.baseline);
  await assert.rejects(read(f, first.baseline), /Too many changed/u); assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(first.baseline), before);
  for (const corrupt of [{ ...first.baseline, accountId: "other-account" }, { ...first.baseline, version: 2 }, { ...first.baseline, items: [{ ...first.baseline.items[0]!, eventId: "forged-event" }] }]) {
    const untouched = fixture(() => ({ items: [] })); await assert.rejects(read(untouched, corrupt as ComposioCalendarBaseline)); assert.equal(untouched.calls.length, 0);
  }
});

test("per-reply and aggregate byte bounds include JSON escaping", async () => {
  const oversized = fixture(() => ({ items: [], unused: "\u0001".repeat(50_000) })); await assert.rejects(read(oversized), /excessive/u);
  let count = 0;
  const aggregate = fixture(() => ({ items: [], unused: "x".repeat(220_000), ...++count < 5 ? { nextPageToken: `page-${count}` } : {} }));
  await assert.rejects(read(aggregate), /response budget/u); assert.equal(aggregate.calls.length, 5);
});

test("fifth complete page returns all 250 events; a duplicate recurrence across IDs is refused", async () => {
  let page = 0;
  const f = validatedPages(fixture(() => { const index = page++; return { items: Array.from({ length: 50 }, (_, item) => event(`${index}-${item}`)), nextPageToken: index < 4 ? `page-${index + 1}` : null }; }));
  const result = await read(f); assert.equal(result.items.length, 250); assert.equal(result.changes.length, 250); assert.equal(f.calls.length, 5);
  const repeated = fixture(() => ({ items: ["first", "second"].map((id) => event(id, { recurringEventId: "same-series", originalStartTime: { dateTime: "2026-11-03T15:30:00Z" } })) }));
  await assert.rejects(read(repeated), /repeated an occurrence/u);
});

test("GET must return the exact event/occurrence and cannot substitute another account result", async () => {
  const first = await read(fixture(() => ({ items: [event("instance", { recurringEventId: "series", originalStartTime: { dateTime: "2026-11-03T15:30:00Z" } })] })));
  for (const replacement of [event("different"), event("instance"), event("instance", { recurringEventId: "series", originalStartTime: { dateTime: "2026-11-03T15:40:00Z" } })]) {
    const f = fixture((request) => request.kind === "listEvents" ? { items: [] } : replacement);
    await assert.rejects(read(f, first.baseline)); assert.equal(f.calls.length, 2);
  }
});

test("ordinary elapsed events and history pruning do not wake or GET", async () => {
  const first = await read(fixture(() => ({ items: [event("one")] })));
  const f = fixture(() => ({ items: [] }));
  const later = await read(f, first.baseline, NOW + 2 * 86_400_000);
  assert.deepEqual(later.changes, []); assert.deepEqual(later.baseline.items, []); assert.equal(f.calls.length, 1);
});

test("history capacity refuses a complete new snapshot instead of evicting future occurrence identities", async () => {
  let baseline: ComposioCalendarBaseline | undefined;
  for (let batch = 0; batch < 8; batch++) {
    let page = 0;
    baseline = (await read(fixture(() => { const index = page++; return { items: Array.from({ length: 50 }, (_, item) => event(`${batch}-${index}-${item}`)), ...(index < 4 ? { nextPageToken: `p-${index}` } : {}) }; }), baseline)).baseline;
    let cancellationPage = 0;
    baseline = (await read(fixture(() => { const index = cancellationPage++; return { items: Array.from({ length: 50 }, (_, item) => ({ id: `${batch}-${index}-${item}`, status: "cancelled" })), ...(index < 4 ? { nextPageToken: `p-${index}` } : {}) }; }), baseline)).baseline;
  }
  assert.equal(baseline!.items.length, 2_000);
  const before = JSON.stringify(baseline);
  await assert.rejects(read(fixture(() => ({ items: [event("overflow")] })), baseline), /too large/u);
  assert.equal(JSON.stringify(baseline), before);
});

test("discovery lifetime invalidation during Search prevents calendar metadata reads", async () => {
  let active = true; const f = discovery();
  f.port.assertDiscoveryCurrent = async () => { if (!active) throw new Error("document closed"); };
  f.port.currentAccounts = async () => { active = false; return search(); };
  await assert.rejects(discoverComposioCalendarSources(f.port, signal()), /document closed/u); assert.equal(f.calls.length, 0);
});

test("blank optional metadata gets safe labels and all-day conversion stays unavailable", async () => {
  const d = discovery(search(), () => ({ items: [{ id: source.calendarId, summary: "   ", accessRole: "reader" }] }));
  const choices = await discoverComposioCalendarSources(d.port, signal()); assert.equal(choices[0]!.labels.resourceLabel, "Calendar");
  const first = await read(fixture(() => ({ items: [event("one", { summary: "", location: "" })] })));
  assert.equal(first.items[0]!.title, "Untitled event");
  const conversion = fixture((request) => request.kind === "listEvents" ? { items: [] } : event("one", { start: { date: "2026-11-03" }, end: { date: "2026-11-04" } }));
  await assert.rejects(read(conversion, first.baseline), /all-day/u);
});
