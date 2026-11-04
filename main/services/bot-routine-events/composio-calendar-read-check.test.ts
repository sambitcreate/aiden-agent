import assert from "node:assert/strict";
import test from "node:test";
import { checkComposioCalendarRead, publicComposioCalendarReadCheckResult, type ComposioCalendarReadCheckPort } from "./composio-calendar-read-check.js";
import { syntheticCalendarExecutor, syntheticCalendarMetadata, syntheticCalendarSchemas, syntheticCalendarSearch } from "./composio-calendar-test-support.js";
import type { ComposioCalendarRead } from "./connector-watch-composio.js";

const NOW = Date.parse("2026-11-04T15:00:00Z");
const actualAccount = "ca_syntheticactive00001";
const observedEvent = { id: "actual-observed-event", status: "confirmed", summary: "Private timed event", recurringEventId: "actual-series", originalStartTime: { dateTime: "2026-11-04T18:00:00Z" }, start: { dateTime: "2026-11-04T18:00:00Z" }, end: { dateTime: "2026-11-04T18:15:00Z" } };
function fixture() {
  const metadata = syntheticCalendarMetadata(); const schemas = syntheticCalendarSchemas(); const search = syntheticCalendarSearch();
  const metaCalls: string[] = [], reads: ComposioCalendarRead[] = [];
  const port: ComposioCalendarReadCheckPort = {
    async list() { return metadata; },
    async call(tool, args) { metaCalls.push(tool); if (tool === "COMPOSIO_SEARCH_TOOLS") return search; assert.deepEqual(args.tool_slugs, ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET"]); return schemas; },
    async readCalendar(read) {
      reads.push(read);
      if (read.accountId !== actualAccount) return syntheticCalendarExecutor(read, undefined, "Connected account not found");
      if (read.kind === "listCalendars") return syntheticCalendarExecutor(read, { items: [{ id: "calendar@example.test", summary: "Synthetic calendar title", accessRole: "reader" }] });
      return syntheticCalendarExecutor(read, read.kind === "listEvents" ? { items: [observedEvent] } : observedEvent);
    },
  };
  return { port, metadata, schemas, search, reads, metaCalls };
}
const options = () => ({ signal: new AbortController().signal, current: async () => {}, now: () => NOW });

test("foreground check proves unknown-account rejection before explicit-account/calendar read", async () => {
  const f = fixture(); const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "verified"); assert.equal(result.available, false); assert.equal(result.privateProof.invalidAccountRejected, true);
  assert.equal(result.privateProof.executorOutputSource, "declared");
  assert.deepEqual(f.metaCalls, ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
  assert.deepEqual(f.reads.map((read) => read.kind), ["listCalendars", "listCalendars", "listEvents", "getEvent"]);
  assert.notEqual(f.reads[0]!.accountId, actualAccount); assert.match(f.reads[0]!.accountId, /^ca_[a-f0-9]+$/u);
  assert.equal(f.reads[1]!.accountId, actualAccount); const events = f.reads[2]!; assert.equal(events.kind, "listEvents");
  if (events.kind !== "listEvents") return;
  assert.equal(events.calendarId, "calendar@example.test"); assert.equal(Date.parse(events.timeMax) - Date.parse(events.timeMin), 24 * 60 * 60_000);
  assert.deepEqual(f.reads[3], { kind: "getEvent", accountId: actualAccount, calendarId: "calendar@example.test", eventId: observedEvent.id, timezone: "UTC" });
  const evidence = JSON.stringify(result);
  for (const secret of [actualAccount, "calendar@example.test", observedEvent.id, observedEvent.summary, observedEvent.recurringEventId, "secret-owner", "Synthetic calendar title", "synthetic-private-session", "GOOGLECALENDAR_EVENTS_GET", "input_schema"]) assert.equal(evidence.includes(secret), false);
  assert.deepEqual(result.privateProof.counts, { activeAccounts: 1, calendars: 1, events: 1, gets: 1 }); assert.equal(result.privateProof.calls.get, true);
});

test("multiple or missing ACTIVE accounts perform no executor read and never choose a default", async () => {
  for (const ids of [[], [actualAccount, "ca_another_account"]]) {
    const f = fixture(); f.port.call = async (tool) => tool === "COMPOSIO_SEARCH_TOOLS" ? syntheticCalendarSearch(ids) : f.schemas;
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, ids.length ? "needs_account_selection" : "no_active_account"); assert.equal(f.reads.length, 0); assert.equal(result.privateProof.calls.invalidAccount, false);
  }
});

test("invalid-account fallback, generic failure and payload beside an account error remain unverified", async () => {
  for (const [resultForInvalid, expectedCode] of [
    [(read: ComposioCalendarRead) => syntheticCalendarExecutor(read, { items: [{ id: "leaked-default-calendar" }] }), "invalid_account_unverified"],
    [(read: ComposioCalendarRead) => syntheticCalendarExecutor(read, undefined, "provider temporarily unavailable"), "invalid_account_unverified"],
    [(read: ComposioCalendarRead) => { const value = syntheticCalendarExecutor(read, undefined, "CONNECTED_ACCOUNT_NOT_FOUND"); Object.assign(value.data.results[0]!, { response: { items: [{ id: "unexpected data" }] } }); return value; }, "unsupported_contract"],
    [(read: ComposioCalendarRead) => { const value = syntheticCalendarExecutor(read, undefined, "CONNECTED_ACCOUNT_NOT_FOUND"); value.data.results[0]!.index = 1; return value; }, "unsupported_contract"],
  ] as const) {
    const f = fixture(); let calls = 0; f.port.readCalendar = async (read) => { calls++; return resultForInvalid(read); };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, expectedCode); assert.equal(result.privateProof.invalidAccountRejected, false); assert.equal(calls, 1);
  }
});

test("local argument rejection is not a successful negative routing test", async () => {
  const f = fixture(); const input = f.metadata[2]!.inputSchema as { properties: { tools: { items: { properties: { account: object } } } } };
  input.properties.tools.items.properties.account = { type: "string", enum: [actualAccount] };
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "unsupported_contract"); assert.equal(result.privateProof.calls.invalidAccount, false); assert.equal(f.reads.length, 0);
});

test("missing GET schema or missing host-owned read method stops before app-data reads", async () => {
  const incomplete = fixture(); delete incomplete.schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET;
  assert.equal((await checkComposioCalendarRead(incomplete.port, options())).code, "unsupported_contract"); assert.equal(incomplete.reads.length, 0);
  const unavailable = fixture(); delete unavailable.port.readCalendar;
  assert.equal((await checkComposioCalendarRead(unavailable.port, options())).code, "unsupported_contract"); assert.equal(unavailable.reads.length, 0);
});

test("revocation during metadata stops schemas and all app-data reads", async () => {
  const f = fixture(); let active = true;
  f.port.call = async () => { active = false; return f.search; };
  const result = await checkComposioCalendarRead(f.port, { ...options(), current: async () => { if (!active) throw new Error("secret revocation details"); } });
  assert.equal(result.code, "access_changed"); assert.equal(result.privateProof.calls.schemas, false); assert.equal(f.reads.length, 0); assert.equal(JSON.stringify(result).includes("secret revocation"), false);
});

test("a cancelled noncooperative admission returns promptly and never later lists or executes", async () => {
  const f = fixture(); let release!: () => void, lists = 0; const held = new Promise<void>((resolve) => { release = resolve; });
  f.port.list = async () => { lists++; return f.metadata; };
  const result = await checkComposioCalendarRead(f.port, { ...options(), timeoutMs: 10, current: async () => held });
  assert.equal(result.code, "timed_out"); assert.equal(lists, 0); release(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(lists, 0); assert.equal(f.reads.length, 0);
});

test("read reply byte bounds and partial pagination never publish successful proof", async () => {
  const f = fixture(); const original = f.port.readCalendar!;
  f.port.readCalendar = async (read, session) => read.kind === "listEvents" ? syntheticCalendarExecutor(read, { items: [], unused: "\u0001".repeat(50_000) }) : original(read, session);
  const result = await checkComposioCalendarRead(f.port, options()); assert.equal(result.code, "limit_exceeded"); assert.equal(result.privateProof.stage, "events"); assert.equal(result.available, false);
});

test("public projection derives fixed messages/status and cannot expose private proof", async () => {
  const result = await checkComposioCalendarRead(fixture().port, options());
  const projected = publicComposioCalendarReadCheckResult({ ...result, message: "untrusted secret", available: false });
  assert.equal("privateProof" in projected, false); assert.equal(projected.message.includes("untrusted"), false); assert.equal(projected.available, false);
  const malformed = publicComposioCalendarReadCheckResult({ checkedAt: NaN, code: "invented" as never, status: "verified" });
  assert.equal(malformed.checkedAt, 0); assert.equal(malformed.code, "inspection_failed"); assert.equal(malformed.status, "unavailable");
});

test("explicit null response permits negative proof but an app-data object never does", async () => {
  const f = fixture(), original = f.port.readCalendar!;
  f.port.readCalendar = async (read, session) => {
    const response = await original(read, session) as ReturnType<typeof syntheticCalendarExecutor>;
    if (read.accountId !== actualAccount) { Object.assign(response.data.results[0]!, { response: null }); Object.assign(response.data, { remote_file_info: null }); }
    return response;
  };
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "verified"); assert.equal(result.privateProof.negative!.result.response, "null");
  assert.equal(result.privateProof.negative!.blockedField, "none");
  const offloaded = fixture(); offloaded.port.readCalendar = async (read) => { const reply = syntheticCalendarExecutor(read, undefined, "Connected account not found"); Object.assign(reply.data, { remote_file_info: { path: "/private/app-data" } }); return reply; };
  const refused = await checkComposioCalendarRead(offloaded.port, options()); assert.equal(refused.code, "unsupported_contract"); assert.equal(refused.privateProof.contractFailure!.field, "executor_output");
});

test("failure diagnostics retain only capped shape/classification and output compatibility facts", async () => {
  const f = fixture();
  f.port.readCalendar = async (read) => syntheticCalendarExecutor(read, undefined, "Account ca_private_secret was not found; owner private@example.test");
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "invalid_account_unverified"); assert.equal(result.privateProof.negative!.result.errorCategory, "account_not_found_text");
  for (const secret of ["ca_private_secret", "private@example.test", "not found;"]) assert.equal(JSON.stringify(result).includes(secret), false);
  const unsupported = fixture(); Object.assign(unsupported.schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET!.output_schema, { nullable: true });
  const refusal = await checkComposioCalendarRead(unsupported.port, options());
  assert.equal(refusal.code, "unsupported_contract"); assert.equal(refusal.privateProof.contractFailure!.stage, "read_response"); assert.equal(refusal.privateProof.contractFailure!.facts!.keyword, "nullable"); assert.equal(unsupported.reads.length, 0);
});

test("empty one-day window is incomplete GET proof and sends no fabricated lookup", async () => {
  const f = fixture(), original = f.port.readCalendar!;
  f.port.readCalendar = async (read, session) => read.kind === "listEvents" ? syntheticCalendarExecutor(read, { items: [] }) : original(read, session);
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "get_proof_incomplete"); assert.equal(result.status, "unavailable"); assert.equal(result.available, false);
  assert.equal(result.privateProof.stage, "event_get"); assert.equal(result.privateProof.calls.get, false); assert.equal(result.privateProof.counts.gets, 0);
  assert.equal(f.reads.some((read) => read.kind === "getEvent"), false);
});

test("GET must match the actually observed event and recurring occurrence", async () => {
  for (const different of [
    { ...observedEvent, id: "different-event" },
    { ...observedEvent, originalStartTime: { dateTime: "2026-11-04T19:00:00Z" } },
    { ...observedEvent, start: { dateTime: "2026-02-30T18:00:00Z" } },
  ]) {
    const f = fixture(), original = f.port.readCalendar!; let gets = 0;
    f.port.readCalendar = async (read, session) => { if (read.kind === "getEvent") { gets++; return syntheticCalendarExecutor(read, different); } return original(read, session); };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, "invalid_response"); assert.equal(result.privateProof.stage, "event_get"); assert.equal(result.privateProof.counts.gets, 0); assert.equal(gets, 1);
  }
});

test("stale or partial GET cannot complete proof after successful window reads", async () => {
  const partial = fixture(), originalPartial = partial.port.readCalendar!;
  partial.port.readCalendar = async (read, session) => read.kind === "getEvent" ? syntheticCalendarExecutor(read, { ...observedEvent, nextPageToken: "partial GET" }) : originalPartial(read, session);
  const refused = await checkComposioCalendarRead(partial.port, options()); assert.notEqual(refused.code, "verified"); assert.equal(refused.privateProof.counts.gets, 0);
  const stale = fixture(), originalStale = stale.port.readCalendar!; let active = true;
  stale.port.readCalendar = async (read, session) => { const response = await originalStale(read, session); if (read.kind === "getEvent") active = false; return response; };
  const invalidated = await checkComposioCalendarRead(stale.port, { ...options(), current: async () => { if (!active) throw new Error("revoked during GET"); } });
  assert.equal(invalidated.code, "access_changed"); assert.equal(invalidated.privateProof.counts.gets, 0); assert.equal(invalidated.privateProof.calls.get, true);
});

test("unsafe or malformed declared executor output refuses before raw executor I/O", async () => {
  for (const invalidOutput of [null, {}, [], { type: "object", properties: { data: { type: "string", pattern: "(a+)+$" } } }, { type: "object", properties: { data: { $ref: "https://example.test/output" } } }]) {
    const f = fixture(); f.metadata[2]!.outputSchema = invalidOutput;
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, "unsupported_contract"); assert.equal(f.reads.length, 0); assert.equal(result.privateProof.calls.invalidAccount, false);
  }
});

test("an omitted output declaration permits host-contract proof without inventing server schema evidence", async () => {
  const f = fixture(); delete f.metadata[2]!.outputSchema;
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "verified"); assert.equal(result.available, false); assert.equal(result.privateProof.executorOutputSource, "host_contract");
  assert.equal(result.privateProof.invalidAccountRejected, true); assert.equal(result.privateProof.counts.gets, 1); assert.equal(f.reads.length, 4);
});

test("absent output declaration cannot accept contradictory counts or payload on failed routing", async () => {
  for (const withPayload of [false, true]) {
    const f = fixture(); delete f.metadata[2]!.outputSchema;
    f.port.readCalendar = async (read) => { const reply = syntheticCalendarExecutor(read, undefined, "Connected account not found"); if (withPayload) Object.assign(reply.data.results[0]!, { response: { items: [] } }); else reply.data.success_count = 1; return reply; };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, "unsupported_contract"); assert.equal(result.privateProof.executorOutputSource, "host_contract"); assert.equal(result.privateProof.contractFailure!.field, "executor_output"); assert.equal(result.privateProof.invalidAccountRejected, false);
  }
});
