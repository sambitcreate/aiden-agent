import assert from "node:assert/strict";
import test from "node:test";
import { checkComposioCalendarRead, publicComposioCalendarReadCheckResult, type ComposioCalendarReadCheckPort } from "./composio-calendar-read-check.js";
import { syntheticCalendarExecutor, syntheticCalendarMetadata, syntheticCalendarSchemas, syntheticCalendarSearch } from "./composio-calendar-test-support.js";
import type { ComposioCalendarRead } from "./connector-watch-composio.js";
import { McpError } from "@earendil-works/pi-mcp";
import { verifyCalendarContract } from "./composio-calendar-contract.js";

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

test("coherent MCP error JSON proves only an exact known failed-account item", async () => {
  for (const [error, accepted] of [["CONNECTED_ACCOUNT_NOT_FOUND", true], ["No active connected account found", false], ["Account ca_private_secret not found", false], ["permission denied", false]] as const) {
    const f = fixture(), original = f.port.readCalendar!; delete f.metadata[2]!.outputSchema;
    f.port.readCalendar = async (read, session) => {
      if (read.accountId === actualAccount) return original(read, session);
      f.reads.push(read);
      const action = { ...syntheticCalendarExecutor(read, undefined, error), successful: false, error: "Operation failed" };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(action) }] };
    };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, accepted ? "verified" : "invalid_account_unverified");
    assert.equal(result.privateProof.invalidAccountRejected, accepted);
    assert.equal(result.privateProof.negative!.result.slugMatches, true); assert.equal(result.privateProof.negative!.result.indexMatches, true);
    assert.equal(result.privateProof.negative!.data.errorCount, 1);
    assert.equal(f.reads.length, accepted ? 4 : 1);
    assert.equal(JSON.stringify(result).includes("ca_private_secret"), false);
  }
});

test("MCP error flag cannot hide an invalid correlation, payload or success behind an exact account error", async () => {
  for (const mutate of [
    (action: Record<string, unknown>) => { (action.data as { results: { tool_slug: string }[] }).results[0]!.tool_slug = "GOOGLECALENDAR_EVENTS_LIST"; },
    (action: Record<string, unknown>) => { (action.data as { results: { index: number }[] }).results[0]!.index = 1; },
    (action: Record<string, unknown>) => { Object.assign((action.data as { results: object[] }).results[0]!, { response: { items: [{ id: "default-account-leak" }] } }); },
    (action: Record<string, unknown>) => { Object.assign(action.data as object, { total_count: 2, success_count: 1 }); },
  ]) {
    const f = fixture(); delete f.metadata[2]!.outputSchema;
    f.port.readCalendar = async (read) => {
      f.reads.push(read);
      const action = { ...syntheticCalendarExecutor(read, undefined, "CONNECTED_ACCOUNT_NOT_FOUND"), successful: false, error: "Failed" };
      mutate(action);
      return { isError: true, content: [{ type: "text", text: JSON.stringify(action) }] };
    };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.notEqual(result.code, "verified"); assert.equal(result.privateProof.invalidAccountRejected, false);
    assert.equal(f.reads.length, 1); assert.equal(result.privateProof.calls.calendars, 0); assert.equal(result.privateProof.calls.events, 0); assert.equal(result.privateProof.calls.get, false);
    assert.equal(JSON.stringify(result).includes("default-account-leak"), false);
  }
});

test("a host rejection before returning the negative reply preserves closed extra-field facts without routing proof", async () => {
  const f = fixture(); delete f.metadata[2]!.outputSchema;
  const host = verifyCalendarContract(f.metadata, f.schemas);
  f.port.readCalendar = async (read) => {
    f.reads.push(read);
    const action = { ...syntheticCalendarExecutor(read, undefined, "No active connected account found"), successful: false, error: "private-top-error", log_id: "private-log-id", private_extra: "private-extra-value" };
    const reply = { isError: true, content: [{ type: "text", text: JSON.stringify(action) }] };
    host.executorResponse(reply); return reply;
  };
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "unsupported_contract"); assert.equal(result.privateProof.invalidAccountRejected, false);
  assert.equal(f.reads.length, 1); assert.equal(result.privateProof.calls.calendars, 0); assert.equal(result.privateProof.negative, undefined);
  const facts = result.privateProof.contractFailure!.facts!.executorResponse!;
  assert.deepEqual(facts.extraFields.action, ["other"]); assert.equal(facts.mcpIsError, true);
  assert.equal(facts.oneResult && facts.totalOne && facts.successZero && facts.errorOne && facts.indexZero && facts.calendarListSlug && facts.responseAbsentOrNull, true);
  assert.equal(facts.itemError, "other");
  for (const secret of ["private-top-error", "private-log-id", "private_extra", "private-extra-value", "No active connected account found"]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal("privateProof" in publicComposioCalendarReadCheckResult(result), false);
});

test("action log metadata preserves exact routing and private attempted-ID diagnostics", async () => {
  for (const [makeError, grammar, mentionsAttempt, availableAccounts, prefix, toolkitMention] of [
    [(_id: string) => "CONNECTED_ACCOUNT_NOT_FOUND", "exact_known", false, "none", "other", false],
    [(id: string) => `Account '${id}' not found for toolkit 'googlecalendar'. Available accounts: []`, "account_not_found", true, "empty", "account", true],
    [(id: string) => `Connected account "${id}" does not exist`, "connected_account_not_found", true, "none", "connected_account", false],
    [(id: string) => `Unknown account ${id}`, "unknown_account", true, "none", "unknown_account", false],
    [(id: string) => `No account found with id '${id}' for toolkit googlecalendar. Available accounts: ['private-other-account']`, "no_account_found", true, "bracketed", "no_account_found", true],
    [(id: string) => `Invalid account ${id}`, "invalid_account", true, "none", "invalid_account", false],
    [(id: string) => `Account ${id}suffix not found`, "other", false, "none", "account", false],
    [(_id: string) => "Account ca_wrongaccount not found", "other", false, "none", "account", false],
    [(id: string) => `Account ${id} not found; permission denied`, "other", true, "none", "account", false],
    [(id: string) => `Account ${id} not found for toolkit gmail`, "other", true, "none", "account", false],
  ] as const) {
    const f = fixture(), original = f.port.readCalendar!; delete f.metadata[2]!.outputSchema;
    f.port.readCalendar = async (read, session) => {
      if (read.accountId === actualAccount) return original(read, session);
      f.reads.push(read);
      return { isError: true, structuredContent: { ...syntheticCalendarExecutor(read, undefined, makeError(read.accountId)), successful: false, error: "Failed", log_id: "private-log-value" } };
    };
    const result = await checkComposioCalendarRead(f.port, options());
    const accepted = grammar === "exact_known" || (grammar === "connected_account_not_found" && availableAccounts === "none");
    assert.equal(result.code, accepted ? "verified" : "invalid_account_unverified"); assert.equal(result.privateProof.invalidAccountRejected, accepted);
    const facts = result.privateProof.negative!.errorGrammar;
    assert.equal(facts.grammar, grammar); assert.equal(facts.attemptedAccountMention, mentionsAttempt); assert.equal(facts.availableAccounts, availableAccounts);
    assert.equal(facts.prefix, prefix); assert.equal(facts.curatedToolkitMention, toolkitMention);
    assert.equal(f.reads.length, accepted ? 4 : 1);
    for (const secret of [f.reads[0]!.accountId, "private-log-value", "private-other-account", "ca_wrongaccount"]) assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("only complete explicit account-not-found templates naming this attempt authorize the negative oracle", async () => {
  for (const makeError of [
    (id: string) => `Account '${id}' not found`,
    (id: string) => `Connected account "${id}" does not exist.`,
    (id: string) => `No account found for id: ${id}`,
    (id: string) => `No active account found with ID '${id}'.`,
    (id: string) => `No connected account found for identifier: "${id}" for toolkit 'googlecalendar'.`,
    (id: string) => `No active connected account found with alias: '${id}'`,
    (id: string) => `No connected account found for '${id}'.`,
    (id: string) => `No account with id ${id}`,
  ]) {
    const f = fixture(), original = f.port.readCalendar!;
    f.port.readCalendar = async (read, session) => {
      if (read.accountId === actualAccount) return original(read, session);
      f.reads.push(read);
      return { isError: true, structuredContent: { ...syntheticCalendarExecutor(read, undefined, makeError(read.accountId)), successful: false, error: "Failed" } };
    };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, "verified"); assert.equal(result.privateProof.invalidAccountRejected, true);
    assert.equal(result.privateProof.negative!.result.errorCategory, "attempt_bound_not_found");
    assert.equal(f.reads.length, 4); assert.equal(result.available, false);
    assert.equal(JSON.stringify(result).includes(f.reads[0]!.accountId), false);
  }
});

test("wrong identities, auth, negation, generic errors, extra text and default data never prove account rejection", async () => {
  for (const makeError of [
    (_id: string) => "No active connected account found with ID ca_differentaccount",
    (id: string) => `No active connected account found with ID ${id}suffix`,
    (id: string) => `No active connected account found with ID ${id}. Permission denied`,
    (id: string) => `Permission denied for account ${id}`,
    (id: string) => `Invalid account ${id}`,
    (id: string) => `Unknown account ${id}`,
    (id: string) => `Account ${id} not found is false`,
    (id: string) => `No active connected account found with ID ${id} for toolkit gmail`,
    (id: string) => `No active connected account found with ID ${id}\n`,
    (id: string) => `No active connected account found with ID ${id}\u0000`,
    (id: string) => `No active connected account found with ID ${id}. Available accounts: []`,
    (id: string) => `No active connected account found with ID ${id}; use the default`,
    (id: string) => ` No active connected account found with ID ${id}`,
    (id: string) => `No active connected account found with ID ${id}..`,
  ]) {
    const f = fixture();
    f.port.readCalendar = async (read) => { f.reads.push(read); return syntheticCalendarExecutor(read, undefined, makeError(read.accountId)); };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, "invalid_account_unverified"); assert.equal(result.privateProof.invalidAccountRejected, false); assert.equal(f.reads.length, 1);
    assert.equal(JSON.stringify(result).includes(f.reads[0]!.accountId), false);
    if (makeError("token").startsWith("No active connected")) assert.equal(result.privateProof.negative!.errorGrammar.prefix, "no_account_found");
  }
  const f = fixture();
  f.port.readCalendar = async (read) => {
    f.reads.push(read);
    const reply = syntheticCalendarExecutor(read, undefined, `No connected account found for id: ${read.accountId}`);
    Object.assign(reply.data.results[0]!, { response: { items: [{ id: "private-default-data" }] } }); return reply;
  };
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "unsupported_contract"); assert.equal(result.privateProof.invalidAccountRejected, false); assert.equal(f.reads.length, 1);
  assert.equal(JSON.stringify(result).includes("private-default-data"), false);
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

test("private checker diagnostics preserve exact known compilation refusal without enabling any read", async () => {
  const f = fixture();
  Object.assign(f.schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_LIST!.output_schema, { definitions: { private_type: { type: "string", $id: "https://example.test/private-schema-text" } } });
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "unsupported_contract"); assert.equal(result.privateProof.contractFailure!.facts!.rejectionReason, "unsupported_keyword");
  assert.equal(result.privateProof.contractFailure!.facts!.keyword, "$id"); assert.equal(result.privateProof.contractFailure!.facts!.operation, "listEvents"); assert.equal(result.privateProof.contractFailure!.facts!.direction, "output");
  assert.equal(f.reads.length, 0); assert.equal(result.privateProof.calls.invalidAccount, false);
  for (const secret of ["private_type", "private schema text", "instancePath", "schemaPath"]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test("local-reference failure proof contains no target names, pointers, fragments or schema values", async () => {
  const f = fixture();
  f.schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_LIST!.output_schema = { type: "object", properties: { items: { $ref: "#/$defs/private_missing_target" } }, $defs: { private_other_target: { type: "string", description: "private schema prose" } } } as never;
  const result = await checkComposioCalendarRead(f.port, options());
  assert.equal(result.code, "unsupported_contract"); assert.equal(result.privateProof.contractFailure!.facts!.referenceFailure, "missing_target");
  assert.equal(result.privateProof.contractFailure!.facts!.operation, "listEvents"); assert.equal(result.privateProof.contractFailure!.facts!.keyword, "$ref");
  assert.equal(f.reads.length, 0); assert.equal(result.privateProof.calls.invalidAccount, false);
  for (const secret of ["private_missing_target", "private_other_target", "#/$defs/", "private schema prose"]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test("thrown RPC failures retain only closed numeric-code and text categories, never negative routing proof", async () => {
  for (const [code, category] of [[-32700, "parse_error"], [-32600, "invalid_request"], [-32601, "method_not_found"], [-32602, "invalid_params"], [-32603, "internal_error"], [-32033, "server_error"], [987654321, "other_integer"]] as const) {
    const f = fixture(), marker = "private-rpc-account-calendar-credential";
    f.port.readCalendar = async () => { throw new McpError(code, `Invalid arguments for ${marker}`, { accountId: marker, response: marker }); };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.code, "invalid_response"); assert.equal(result.privateProof.readFailure?.stage, "send");
    assert.deepEqual(result.privateProof.readFailure?.error, { category: "rpc", rpcCode: category, rpcErrorDataPresent: true, textCategory: "invalid_arguments" });
    assert.equal(result.privateProof.invalidAccountRejected, false); assert.equal(result.privateProof.calls.calendars, 0); assert.equal(result.privateProof.calls.events, 0); assert.equal(result.privateProof.calls.get, false);
    assert.equal(JSON.stringify(result).includes(marker), false); assert.equal(JSON.stringify(result).includes(String(code)), false);
    assert.equal("readFailure" in publicComposioCalendarReadCheckResult(result), false);
  }
});

test("an MCP text error is distinguished from RPC throws without retaining its content or accepting account failure", async () => {
  for (const isError of [true, false, undefined]) {
    const f = fixture(), marker = "private-account-user-and-calendar";
    f.port.readCalendar = async () => ({ ...(isError === undefined ? {} : { isError }), content: [{ type: "text", text: `Account ${marker} not found` }] });
    const result = await checkComposioCalendarRead(f.port, options()), diagnostic = result.privateProof.readFailure;
    assert.equal(diagnostic?.stage, "validation"); assert.equal(diagnostic?.validation, "calendar");
    assert.equal(diagnostic?.reply?.isError, isError === undefined ? "missing" : isError ? "true" : "false"); assert.equal(diagnostic?.reply?.contentCount, 1); assert.equal(diagnostic?.reply?.firstContent?.textJson, "invalid");
    assert.equal(diagnostic?.reply?.errorTextCategory, "account_not_found"); assert.equal(diagnostic?.reply?.action?.successful, "missing");
    assert.equal(result.privateProof.invalidAccountRejected, false); assert.equal(result.privateProof.calls.calendars, 0); assert.equal(result.privateProof.calls.get, false);
    assert.equal(JSON.stringify(result).includes(marker), false); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32 * 1024);
  }
});

test("common account and connection failure wording changes diagnostics only, never routing acceptance", async () => {
  for (const message of ["No active connected account found", "CONNECTED_ACCOUNT_NOT_FOUND", "Unknown connected_account", "No active connection exists"]) {
    const f = fixture();
    f.port.readCalendar = async () => { throw new McpError(-32000, message + " private-account-identity"); };
    const result = await checkComposioCalendarRead(f.port, options());
    assert.equal(result.privateProof.readFailure?.error.textCategory, "account_not_found");
    assert.equal(result.privateProof.invalidAccountRejected, false); assert.equal(result.privateProof.calls.calendars, 0); assert.equal(result.privateProof.calls.get, false);
    assert.equal(JSON.stringify(result).includes(message), false); assert.equal(JSON.stringify(result).includes("private-account-identity"), false);
  }
});

test("structured MCP errors expose known action/result types without retaining error data or unknown names", async () => {
  const f = fixture(), marker = "private-structured-account-event-and-unknown-field";
  f.port.readCalendar = async () => ({ isError: true, content: [], structuredContent: { successful: false, error: marker, data: { results: [{ tool_slug: marker, index: 987654321, error: "Connected account not found", response: { [marker]: marker } }], [marker]: marker } } });
  const result = await checkComposioCalendarRead(f.port, options()), facts = result.privateProof.readFailure?.reply;
  assert.equal(facts?.actionSource, "structured"); assert.deepEqual(facts?.action, { successful: "boolean", error: "string", data: "object" });
  assert.equal(facts?.data?.results, "array"); assert.deepEqual(facts?.firstResult, { value: "object", tool_slug: "string", index: "number", error: "string", response: "object" });
  assert.equal(result.privateProof.invalidAccountRejected, false); assert.equal(result.privateProof.calls.calendars, 0);
  assert.equal(JSON.stringify(result).includes(marker), false); assert.equal(JSON.stringify(result).includes("987654321"), false);
});

test("cancellation during a noncooperative executor throw keeps the returned proof stable and prevents later reads", async () => {
  const f = fixture(), controller = new AbortController();
  let enter!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
  f.port.readCalendar = async () => { calls++; enter(); await held; throw new McpError(-32000, "No account found: private-late-error"); };
  const pending = checkComposioCalendarRead(f.port, { ...options(), signal: controller.signal });
  await entered; controller.abort();
  const result = await pending, frozen = JSON.stringify(result);
  assert.equal(result.code, "cancelled"); assert.equal(result.privateProof.invalidAccountRejected, false); assert.equal(result.privateProof.calls.calendars, 0); assert.equal(result.privateProof.calls.get, false);
  release(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(JSON.stringify(result), frozen); assert.equal(frozen.includes("private-late-error"), false);
});

test("reply and error accessors never run while projecting failed Calendar reads", async () => {
  let getters = 0;
  const thrown = new McpError(-32602, "unused");
  Object.defineProperty(thrown, "message", { get() { getters++; return "private error"; } });
  Object.defineProperty(thrown, "code", { get() { getters++; return -32602; } });
  const f = fixture(); f.port.readCalendar = async () => { throw thrown; };
  const result = await checkComposioCalendarRead(f.port, options());
  assert.deepEqual(result.privateProof.readFailure?.error, { category: "rpc", rpcCode: "missing_or_invalid", rpcErrorDataPresent: false, textCategory: "missing" });
  const reply = Object.defineProperty({}, "successful", { enumerable: true, get() { getters++; return true; } });
  f.port.readCalendar = async () => reply;
  const invalid = await checkComposioCalendarRead(f.port, options());
  assert.equal(invalid.code, "limit_exceeded"); assert.deepEqual(invalid.privateProof.readFailure?.reply, { bounded: false, value: "object" });
  assert.equal(getters, 0);
});
