import assert from "node:assert/strict";
import test from "node:test";
import { buildCalendarSchemasRequest, buildCalendarSearchRequest, CALENDAR_SCHEMA_SLUGS, verifyCalendarContract } from "./composio-calendar-contract.js";
import { syntheticCalendarExecutor, syntheticCalendarMetadata, syntheticCalendarSchemas } from "./composio-calendar-test-support.js";

test("contract validates all three fixed read schemas and one account-selected executor item", () => {
  const metadata = syntheticCalendarMetadata();
  assert.equal(buildCalendarSearchRequest(metadata).queries.length, 1);
  assert.deepEqual(buildCalendarSchemasRequest(metadata, "chosen-session"), { tool_slugs: [...CALENDAR_SCHEMA_SLUGS], include: ["input_schema", "output_schema"], session_id: "chosen-session" });
  const verified = verifyCalendarContract(metadata, syntheticCalendarSchemas());
  const request = verified.request({ kind: "getEvent", accountId: "actual-account", calendarId: "actual-calendar@example.test", eventId: "actual-event", timezone: "UTC" }, "chosen-session");
  assert.equal(request.tools.length, 1); assert.equal(request.tools[0].account, "actual-account"); assert.equal(request.tools[0].tool_slug, "GOOGLECALENDAR_EVENTS_GET");
  assert.equal(request.tools[0].arguments.event_id, "actual-event"); assert.equal(request.session_id, "chosen-session"); assert.equal(request.sync_response_to_workbench, false);
  assert.match(verified.contract.executorSchemaHash, /^[0-9a-f]{64}$/u);
});

test("current schema drift refuses saved contract while key order alone is harmless", () => {
  const metadata = syntheticCalendarMetadata(), schemas = syntheticCalendarSchemas();
  const first = verifyCalendarContract(metadata, schemas);
  const reordered = JSON.parse(JSON.stringify(schemas, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
  assert.deepEqual(verifyCalendarContract(metadata, reordered, first.contract).contract, first.contract);
  schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET!.output_schema.properties.error = { type: "string", maxLength: 50 } as { type: string };
  assert.throws(() => verifyCalendarContract(metadata, schemas, first.contract), /current read contract/u);
});

test("missing read-only metadata, duplicate tools and an absent item selector fail closed", () => {
  for (const hint of [false, undefined]) {
    const metadata = syntheticCalendarMetadata(); metadata[0]!.annotations = hint === undefined ? {} : { readOnlyHint: hint };
    assert.throws(() => buildCalendarSearchRequest(metadata));
  }
  const duplicated = syntheticCalendarMetadata(); duplicated.push({ ...duplicated[0]! }); assert.throws(() => buildCalendarSearchRequest(duplicated));
  const metadata = syntheticCalendarMetadata(); const executor = metadata[2]!.inputSchema as { properties: { tools: { items: { properties: Record<string, unknown> } } } };
  delete executor.properties.tools.items.properties.account;
  assert.throws(() => verifyCalendarContract(metadata, syntheticCalendarSchemas()));
});

test("remote references, unfamiliar dialects, regex and unsupported argument constraints do not execute", () => {
  for (const addition of [{ $ref: "https://example.test/schema" }, { $schema: "https://json-schema.org/draft/2020-12/schema" }, { pattern: "(a+)+$" }]) {
    const metadata = syntheticCalendarMetadata(); Object.assign(metadata[0]!.inputSchema as object, addition); assert.throws(() => buildCalendarSearchRequest(metadata));
  }
  const schemas = syntheticCalendarSchemas(); const input = schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET!.input_schema!;
  input.required.push("not_supported_by_curated_read");
  const verified = verifyCalendarContract(syntheticCalendarMetadata(), schemas);
  assert.throws(() => verified.request({ kind: "getEvent", accountId: "account", calendarId: "calendar@example.test", eventId: "event", timezone: "UTC" }));
});

test("incomplete/full-schema claims, wrong namespaces and missing GET cannot become a contract", () => {
  for (const mutate of [
    (schemas: ReturnType<typeof syntheticCalendarSchemas>) => { delete schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET; },
    (schemas: ReturnType<typeof syntheticCalendarSchemas>) => { schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET!.hasFullSchema = false; },
    (schemas: ReturnType<typeof syntheticCalendarSchemas>) => { schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET!.toolkit = "Google Calendar"; },
    (schemas: ReturnType<typeof syntheticCalendarSchemas>) => { Object.assign(schemas.data, { remote_file_info: { path: "data elsewhere" } }); },
  ]) { const schemas = syntheticCalendarSchemas(); mutate(schemas); assert.throws(() => verifyCalendarContract(syntheticCalendarMetadata(), schemas)); }
});

test("malicious inventory accessors are never run", () => {
  let accessed = false; const tool = Object.defineProperty({}, "name", { enumerable: true, get() { accessed = true; return "COMPOSIO_SEARCH_TOOLS"; } });
  assert.throws(() => buildCalendarSearchRequest([tool as never])); assert.equal(accessed, false);
});

test("declared upstream output is enforced separately from executor correlation and drift hashes", () => {
  const read = { kind: "listCalendars" as const, accountId: "actual-account" };
  const schemas = syntheticCalendarSchemas();
  schemas.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema.properties.items = { type: "string" } as never;
  const verified = verifyCalendarContract(syntheticCalendarMetadata(), schemas);
  assert.throws(() => verified.response(read, syntheticCalendarExecutor(read, { items: [] })));
  verified.response(read, syntheticCalendarExecutor(read, { items: "declared representation" }));
  const mismatched = syntheticCalendarExecutor(read, { items: "declared representation" }); mismatched.data.results[0]!.index = 1;
  assert.throws(() => verified.response(read, mismatched));
});

test("present executor output uses the restricted compiler before requests, including genuine failure representation", () => {
  for (const output of [null, {}, [], { type: "object", properties: { data: { type: "string", pattern: "(a+)+$" } } }, { type: "object", properties: { data: { $ref: "https://example.test/output" } } }, { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} }]) {
    const metadata = syntheticCalendarMetadata(); metadata[2]!.outputSchema = output;
    assert.throws(() => verifyCalendarContract(metadata, syntheticCalendarSchemas()));
  }
  const verified = verifyCalendarContract(syntheticCalendarMetadata(), syntheticCalendarSchemas());
  const read = { kind: "listCalendars" as const, accountId: "account" };
  const negative = syntheticCalendarExecutor(read, undefined, "Connected account not found");
  Object.assign(negative.data.results[0]!, { response: null }); Object.assign(negative.data, { remote_file_info: null });
  verified.executorResponse(negative);
  const wrongType = { ...negative, successful: "true" };
  assert.throws(() => verified.executorResponse(wrongType));
});

test("absent executor output uses the fixed host contract and declaration changes invalidate bindings", () => {
  const metadata = syntheticCalendarMetadata(), schemas = syntheticCalendarSchemas();
  const declared = verifyCalendarContract(metadata, schemas);
  delete metadata[2]!.outputSchema;
  const fallback = verifyCalendarContract(metadata, schemas);
  assert.equal(declared.executorOutputSource, "declared"); assert.equal(fallback.executorOutputSource, "host_contract");
  assert.notEqual(declared.contract.executorSchemaHash, fallback.contract.executorSchemaHash);
  assert.throws(() => verifyCalendarContract(metadata, schemas, declared.contract));
  assert.throws(() => verifyCalendarContract(syntheticCalendarMetadata(), schemas, fallback.contract));
  const read = { kind: "listCalendars" as const, accountId: "account" };
  fallback.response(read, syntheticCalendarExecutor(read, { items: [] }));
  fallback.executorResponse(syntheticCalendarExecutor(read, undefined, "Connected account not found"));
});

test("host result invariants apply even when a declared output schema permits anything", () => {
  const metadata = syntheticCalendarMetadata(); metadata[2]!.outputSchema = { type: "object", properties: {}, additionalProperties: true };
  const verified = verifyCalendarContract(metadata, syntheticCalendarSchemas()), read = { kind: "listCalendars" as const, accountId: "account" };
  const contradictory = syntheticCalendarExecutor(read, { items: [] }); contradictory.data.error_count = 1;
  const withPayload = syntheticCalendarExecutor(read, undefined, "Connected account not found"); Object.assign(withPayload.data.results[0]!, { response: { items: [] } });
  const offloaded = syntheticCalendarExecutor(read, { items: [] }); Object.assign(offloaded.data, { remote_file_info: { path: "not-inline" } });
  const wrongIndex = syntheticCalendarExecutor(read, { items: [] }); wrongIndex.data.results[0]!.index = 1;
  const extraResult = syntheticCalendarExecutor(read, { items: [] }); extraResult.data.results.push({ ...extraResult.data.results[0]! });
  for (const reply of [contradictory, withPayload, offloaded, wrongIndex, extraResult]) assert.throws(() => verified.executorResponse(reply));
});
