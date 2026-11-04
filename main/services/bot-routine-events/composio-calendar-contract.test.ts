import assert from "node:assert/strict";
import test from "node:test";
import { buildCalendarSchemasRequest, buildCalendarSearchRequest, CALENDAR_SCHEMA_SLUGS, ComposioCalendarContractError, verifyCalendarContract } from "./composio-calendar-contract.js";
import { syntheticCalendarExecutor, syntheticCalendarMetadata, syntheticCalendarSchemas } from "./composio-calendar-test-support.js";
import { compileComposioWatchInputSchema, type ComposioWatchSchemaCompileFacts } from "./connector-watch-composio-probe.js";
import { normalizeComposioCalendarOutputSchema } from "./composio-calendar-output-schema.js";

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

test("Calendar output type failures report closed expected/actual types at known fields and collapsed array positions", () => {
  const cases = [
    { index: 0, read: { kind: "listCalendars", accountId: "account" }, schema: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } }, value: { items: [{ id: null }] }, expected: ["string"], actual: "null", path: ["items", "array_index", "id"] },
    { index: 1, read: { kind: "listEvents", accountId: "account", calendarId: "calendar", timeMin: "2026-11-04T15:00:00Z", timeMax: "2026-11-04T16:00:00Z", timezone: "UTC" }, schema: { data: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { start: { type: "object", properties: { dateTime: { type: "string" } } } } } } } } }, value: { data: { items: [{ start: { dateTime: 918273645 } }] } }, expected: ["string"], actual: "number", path: ["data", "items", "array_index", "start", "dateTime"] },
    { index: 2, read: { kind: "getEvent", accountId: "account", calendarId: "calendar", eventId: "event", timezone: "UTC" }, schema: { error: { type: ["string", "null"] } }, value: { error: { private_secret: "private-value" } }, expected: ["string", "null"], actual: "object", path: ["error"] },
  ] as const;
  for (const fixture of cases) {
    const schemas = syntheticCalendarSchemas();
    schemas.data.tool_schemas[CALENDAR_SCHEMA_SLUGS[fixture.index]]!.output_schema = { type: "object", properties: fixture.schema } as never;
    const verified = verifyCalendarContract(syntheticCalendarMetadata(), schemas);
    let failure: unknown;
    try { verified.response(fixture.read, syntheticCalendarExecutor(fixture.read, fixture.value)); } catch (error) { failure = error; }
    assert.ok(failure instanceof ComposioCalendarContractError); assert.equal(failure.stage, "read_response"); assert.equal(failure.reason, "invalid");
    const facts = failure.facts;
    assert.deepEqual(facts?.typeMismatch, { expected: fixture.expected, actual: fixture.actual, path: fixture.path, truncated: false, declaration: { required: false, default: "missing", nullableAllowed: fixture.index === 2 } });
    for (const secret of ["918273645", "private_secret", "private-value"]) assert.equal(JSON.stringify(facts).includes(secret), false);
  }
});

test("type diagnostics resolve escaped and dynamic names without exposing names, indexes, paths or values", () => {
  const schemas = syntheticCalendarSchemas();
  schemas.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema = { type: "object", properties: { data: { type: "object", properties: { "private~/secret": { type: "object", properties: { "314159": { type: "integer" } } } } } } } as never;
  const read = { kind: "listCalendars" as const, accountId: "private-account" };
  let failure: unknown;
  try { verifyCalendarContract(syntheticCalendarMetadata(), schemas).response(read, syntheticCalendarExecutor(read, { data: { "private~/secret": { "314159": false } } })); } catch (error) { failure = error; }
  assert.ok(failure instanceof ComposioCalendarContractError);
  const facts = failure.facts;
  assert.deepEqual(facts?.typeMismatch, { expected: ["integer"], actual: "boolean", path: ["data", "other", "other"], truncated: false, declaration: { required: false, default: "missing", nullableAllowed: false } });
  for (const secret of ["private~/secret", "private~0~1secret", "314159", "private-account", "instancePath", "schemaPath"]) assert.equal(JSON.stringify(facts).includes(secret), false);
});

test("type diagnostics canonicalize only bounded known ASCII aliases and describe direct field declarations", () => {
  for (const [name, canonical, required, defaultValue, defaultCategory] of [
    ["next_sync_token", "nextSyncToken", false, null, "null"],
    ["NEXT_PAGE_TOKEN", "nextPageToken", true, "private-default-value", "other"],
    ["Time_Zone", "timeZone", false, undefined, "missing"],
    ["private_next_sync_token", "other", true, null, "null"],
    [" next_sync_token", "other", false, undefined, "missing"],
    ["next_sуnc_token", "other", false, undefined, "missing"],
    ["n_ext_sync_token", "other", false, undefined, "missing"],
  ] as const) {
    const schemas = syntheticCalendarSchemas();
    schemas.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema = { type: "object", properties: { DATA: { type: "object", properties: { [name]: { type: "string", ...(defaultValue === undefined ? {} : { default: defaultValue }) } }, ...(required ? { required: [name] } : {}) } } } as never;
    const read = { kind: "listCalendars" as const, accountId: "private-account" };
    let failure: unknown;
    try { verifyCalendarContract(syntheticCalendarMetadata(), schemas).response(read, syntheticCalendarExecutor(read, { DATA: { [name]: null } })); } catch (error) { failure = error; }
    assert.ok(failure instanceof ComposioCalendarContractError);
    const mismatch = failure.facts!.typeMismatch!;
    assert.deepEqual(mismatch.path, ["data", canonical]);
    assert.deepEqual(mismatch.declaration, { required, default: defaultCategory, nullableAllowed: false });
    for (const secret of ["private-default-value", "private_next_sync_token", "next_sуnc_token", "n_ext_sync_token", "private-account"]) assert.equal(JSON.stringify(failure.facts).includes(secret), false);
  }
});

test("composed field constraints leave ambiguous required declarations unknown without weakening validation", () => {
  const schemas = syntheticCalendarSchemas();
  schemas.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema = { type: "object", properties: { next_sync_token: { type: "string", default: null } }, allOf: [{ required: ["next_sync_token"] }] } as never;
  const read = { kind: "listCalendars" as const, accountId: "account" };
  let failure: unknown;
  try { verifyCalendarContract(syntheticCalendarMetadata(), schemas).response(read, syntheticCalendarExecutor(read, { next_sync_token: null })); } catch (error) { failure = error; }
  assert.ok(failure instanceof ComposioCalendarContractError);
  assert.deepEqual(failure.facts!.typeMismatch!.declaration, { required: "unknown", default: "null", nullableAllowed: false });
});

test("parent and deeper ancestor composition prevent a local nullable declaration from claiming effective null acceptance", async (t) => {
  for (const nested of [false, true]) await t.test(nested ? "ancestor" : "parent", () => {
    const schemas = syntheticCalendarSchemas();
    const property = { type: ["string", "null"] };
    const local = { type: "object", properties: { items: property } };
    const restriction = { properties: { items: { enum: [true, "valid"] } } };
    schemas.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema = nested ? {
      type: "object", properties: { data: local }, allOf: [{ properties: { data: restriction } }],
    } as never : { ...local, allOf: [restriction] } as never;
    const read = { kind: "listCalendars" as const, accountId: "account" }, verified = verifyCalendarContract(syntheticCalendarMetadata(), schemas);
    const response = (items: unknown) => syntheticCalendarExecutor(read, nested ? { data: { items } } : { items });
    let typeFailure: unknown, nullFailure: unknown;
    try { verified.response(read, response(true)); } catch (error) { typeFailure = error; }
    try { verified.response(read, response(null)); } catch (error) { nullFailure = error; }
    assert.ok(typeFailure instanceof ComposioCalendarContractError); assert.equal(typeFailure.facts!.keyword, "type");
    assert.deepEqual(typeFailure.facts!.typeMismatch!.declaration, { required: "unknown", default: "missing", nullableAllowed: "unknown" });
    assert.ok(nullFailure instanceof ComposioCalendarContractError); assert.equal(nullFailure.stage, "read_response"); assert.equal(nullFailure.facts!.keyword, "enum");
    verified.response(read, response("valid"));
  });
});

test("declarations inside alternative schema branches never claim global nullability", async (t) => {
  for (const keyword of ["anyOf", "oneOf"]) await t.test(keyword, () => {
    const schemas = syntheticCalendarSchemas();
    schemas.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema = { type: "object", properties: { data: { type: "object", [keyword]: [
      { type: "object", properties: { items: { type: "string" } } },
      { type: "object", properties: { items: { type: "null" } } },
    ] } } } as never;
    const read = { kind: "listCalendars" as const, accountId: "account" }, verified = verifyCalendarContract(syntheticCalendarMetadata(), schemas);
    let failure: unknown;
    try { verified.response(read, syntheticCalendarExecutor(read, { data: { items: true } })); } catch (error) { failure = error; }
    assert.ok(failure instanceof ComposioCalendarContractError); assert.equal(failure.facts!.keyword, "type");
    assert.equal(failure.facts!.typeMismatch!.declaration, undefined);
    verified.response(read, syntheticCalendarExecutor(read, { data: { items: null } }));
  });
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

test("Calendar executor accepts a complete MCP error JSON failure without making it a successful read", () => {
  const metadata = syntheticCalendarMetadata(); delete metadata[2]!.outputSchema;
  const verified = verifyCalendarContract(metadata, syntheticCalendarSchemas()), read = { kind: "listCalendars" as const, accountId: "generated-invalid-account" };
  const failure = { ...syntheticCalendarExecutor(read, undefined, "Connected account not found"), successful: false, error: "One operation failed" };
  const envelope = { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] };
  verified.executorResponse(envelope);
  verified.executorResponse({ isError: true, structuredContent: failure });
  assert.throws(() => verified.response(read, envelope));
  for (const mutate of [
    (value: typeof failure) => { value.data.success_count = 1; },
    (value: typeof failure) => { Object.assign(value.data.results[0]!, { response: { items: [] } }); },
    (value: typeof failure) => { value.data.results[0]!.index = 1; },
    (value: typeof failure) => { Object.assign(value.data, { remote_file_info: { path: "private" } }); },
  ]) {
    const changed = structuredClone(failure); mutate(changed);
    assert.throws(() => verified.executorResponse({ isError: true, content: [{ type: "text", text: JSON.stringify(changed) }] }));
  }
  const success = syntheticCalendarExecutor(read, { items: [] });
  assert.throws(() => verified.executorResponse({ isError: true, structuredContent: success }));
  assert.throws(() => verified.response(read, { ...success, successful: false }));
  assert.throws(() => verified.executorResponse({ ...envelope, structuredContent: success }));
  const declared = syntheticCalendarMetadata();
  Object.assign((declared[2]!.outputSchema as { properties: { successful: object } }).properties.successful, { const: true });
  assert.throws(() => verifyCalendarContract(declared, syntheticCalendarSchemas()).executorResponse(envelope), "a declared output still narrows failures");
});

test("executor rejection exposes only closed extra-field locations and correlated failure facts", () => {
  const metadata = syntheticCalendarMetadata(); delete metadata[2]!.outputSchema;
  const verified = verifyCalendarContract(metadata, syntheticCalendarSchemas());
  const read = { kind: "listCalendars" as const, accountId: "private-account" };
  for (const error of ["CONNECTED_ACCOUNT_NOT_FOUND", "Account private-account was not found"]) {
    const action = { ...syntheticCalendarExecutor(read, undefined, error), successful: false, error: "private-error-prose", log_id: "private-log-value" };
    Object.assign(action.data, { request_id: "private-request-value", private_data_key: { credential: "private-credential" } });
    Object.assign(action.data.results[0]!, { session_id: "private-session-value", execution_time: 918273645, toolkit: "private-toolkit-value", private_result_key: "private" });
    let rejected: unknown;
    try { verified.executorResponse({ isError: true, content: [{ type: "text", text: JSON.stringify(action) }] }); } catch (caught) { rejected = caught; }
    assert.ok(rejected instanceof Error);
    const facts = (rejected as { facts?: { executorResponse?: unknown } }).facts!.executorResponse;
    assert.deepEqual(facts, {
      extraFields: { action: [], data: ["request_id", "other"], result: ["session_id", "execution_time", "toolkit", "other"] },
      mcpIsError: true, actionSuccessful: false,
      oneResult: true, totalOne: true, successZero: true, errorOne: true,
      indexZero: true, calendarListSlug: true, responseAbsentOrNull: true,
      itemError: error === "CONNECTED_ACCOUNT_NOT_FOUND" ? "exact_known" : "other",
    });
    for (const secret of ["private-account", "private-error", "private-log", "private-request", "private_data_key", "private_result_key", "private-session", "private-toolkit", "918273645", "private-credential"]) assert.equal(JSON.stringify(facts).includes(secret), false);
  }
});

test("only bounded action-level log metadata is inert in the executor contract", () => {
  const metadata = syntheticCalendarMetadata(); delete metadata[2]!.outputSchema;
  const verified = verifyCalendarContract(metadata, syntheticCalendarSchemas()), read = { kind: "listCalendars" as const, accountId: "exact-account" };
  const success = { ...syntheticCalendarExecutor(read, { items: [] }), log_id: "log_synthetic-only" };
  verified.response(read, success);
  const failure = { ...syntheticCalendarExecutor(read, undefined, "CONNECTED_ACCOUNT_NOT_FOUND"), successful: false, error: "Failed", log_id: "log_synthetic-only" };
  verified.executorResponse({ isError: true, structuredContent: failure });
  verified.executorResponse({ ...failure, log_id: "x".repeat(256) });
  for (const log_id of [null, 7, {}, "x".repeat(257)]) assert.throws(() => verified.executorResponse({ ...failure, log_id }));
  for (const location of ["data", "result"] as const) {
    const changed = structuredClone(failure);
    Object.assign(location === "data" ? changed.data : changed.data.results[0]!, { log_id: "log_synthetic-only" });
    assert.throws(() => verified.executorResponse(changed));
  }
  assert.throws(() => verified.executorResponse({ ...failure, request_id: "still-unsupported" }));
});

test("closed compilation diagnostics distinguish definitions, unknown keywords and schema compiler failures", () => {
  for (const [extra, keyword, rejectionReason] of [
    [{ $defs: [] }, "$defs", "schema_structure"],
    [{ definitions: false }, "definitions", "schema_structure"],
    [{ private_unknown_keyword: "private provider prose" }, "other", "unsupported_keyword"],
    [{ required: "private_missing_field" }, "type", "schema_compile"],
    [{ anyOf: Array.from({ length: 9 }, () => ({ type: "object" })) }, "anyOf", "schema_structure"],
  ] as const) {
    const schemas = syntheticCalendarSchemas(); Object.assign(schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET!.output_schema, extra);
    let error: unknown;
    try { verifyCalendarContract(syntheticCalendarMetadata(), schemas); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error); const facts = (error as { facts?: { keyword: string; rejectionReason: string; direction: string; operation: string; work: { nodes: number; depth: number } } }).facts!;
    assert.equal(facts.keyword, keyword); assert.equal(facts.rejectionReason, rejectionReason); assert.equal(facts.operation, "getEvent"); assert.equal(facts.direction, "output");
    if (keyword === "$defs" || keyword === "definitions") assert.equal(facts.work.nodes, 0, "malformed root tables are refused before expansion");
    else assert.ok(facts.work.nodes > 0 && facts.work.nodes <= 513);
    assert.ok(facts.work.depth <= 13);
    for (const secret of ["private_schema_name", "private provider prose", "private_unknown_keyword", "private_missing_field"]) assert.equal(JSON.stringify(facts).includes(secret), false);
  }
});

test("schema work diagnostics report actual bounded node and depth refusals", () => {
  const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`private_${index}`, { type: "string" }])) };
  let facts: ComposioWatchSchemaCompileFacts | undefined;
  assert.throws(() => compileComposioWatchInputSchema(wide, (value) => { facts = value; }));
  assert.equal(facts!.reason, "schema_limit"); assert.deepEqual(facts!.work, { nodes: 513, depth: 1, nodeLimit: 512, depthLimit: 12 });
  let nested: Record<string, unknown> = { type: "string" };
  for (let level = 0; level < 14; level++) nested = { type: "array", items: nested };
  assert.throws(() => compileComposioWatchInputSchema({ type: "object", properties: { child: nested } }, (value) => { facts = value; }));
  assert.equal(facts!.reason, "schema_limit"); assert.equal(facts!.work.depth, 13); assert.ok(facts!.work.nodes <= 513);
});

test("argument and response diagnostics expose only fixed validation keyword, operation and direction", () => {
  const schemas = syntheticCalendarSchemas(); schemas.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET!.input_schema!.required.push("private_required_input");
  const verified = verifyCalendarContract(syntheticCalendarMetadata(), schemas);
  let failure: unknown;
  try { verified.request({ kind: "getEvent", accountId: "actual-account", calendarId: "actual-calendar@example.test", eventId: "private-event-id", timezone: "UTC" }); } catch (caught) { failure = caught; }
  const input = (failure as { facts: Record<string, unknown> }).facts;
  assert.deepEqual(input, { keyword: "required", dialect: "missing", operation: "getEvent", direction: "input" });
  const outputs = syntheticCalendarSchemas(); outputs.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema.required.push("private_required_output");
  const outputContract = verifyCalendarContract(syntheticCalendarMetadata(), outputs), read = { kind: "listCalendars" as const, accountId: "actual-account" };
  try { outputContract.response(read, syntheticCalendarExecutor(read, { items: [] })); } catch (caught) { failure = caught; }
  const output = (failure as { facts: Record<string, unknown> }).facts;
  assert.deepEqual(output, { keyword: "required", dialect: "missing", operation: "listCalendars", direction: "output" });
  for (const secret of ["private_required_input", "private_required_output", "private-event-id", "actual-calendar", "instancePath", "schemaPath", "params"]) assert.equal(JSON.stringify([input, output]).includes(secret), false);
});

function localOutput(output: unknown) {
  const schemas = syntheticCalendarSchemas(); schemas.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema = output as never;
  return { schemas, verified: () => verifyCalendarContract(syntheticCalendarMetadata(), schemas) };
}

test("Calendar outputs enforce nested shared local definitions for both supported root containers", () => {
  const read = { kind: "listCalendars" as const, accountId: "actual-account" };
  for (const container of ["$defs", "definitions"] as const) {
    const fixture = localOutput({ type: "object", properties: { items: { $ref: `#/${container}/CalendarList`, title: "inert ref title", default: { $ref: "https://example.test/not-a-schema" }, examples: [{ definitions: { ignored: { format: "unknown" } } }] }, featured: { $ref: `#/${container}/Calendar` } }, required: ["items"], additionalProperties: false, [container]: {
      Identifier: { type: "string", minLength: 5 },
      Calendar: { type: "object", properties: { id: { $ref: `#/${container}/Identifier` }, accessRole: { type: "string", enum: ["reader", "owner"] } }, required: ["id", "accessRole"], additionalProperties: false },
      CalendarList: { type: "array", items: { $ref: `#/${container}/Calendar` } },
    } });
    const verified = fixture.verified(), response = { items: [{ id: "calendar@example.test", accessRole: "reader" }], featured: { id: "other@example.test", accessRole: "owner" } };
    const original = JSON.stringify(response); verified.response(read, syntheticCalendarExecutor(read, response)); assert.equal(JSON.stringify(response), original, "defaults never mutate returned data");
    for (const invalid of [{ items: [{ id: 42, accessRole: "reader" }] }, { items: [{ id: "tiny", accessRole: "reader" }] }, { items: [{ id: "calendar@example.test", accessRole: "freeBusyReader" }] }, { items: [], featured: { id: 42, accessRole: "owner" } }]) assert.throws(() => verified.response(read, syntheticCalendarExecutor(read, invalid)));
  }
});

test("safe unused definitions are audited but the ORIGINAL schema still controls drift detection", () => {
  const fixture = localOutput({ type: "object", properties: { items: { type: "array" } }, required: ["items"], $defs: { Unused: { type: "string", minLength: 5 } } });
  const accepted = fixture.verified();
  const raw = fixture.schemas.data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.output_schema as unknown as { $defs: { Unused: { title?: string } } };
  raw.$defs.Unused.title = "unused annotation changed";
  assert.throws(() => verifyCalendarContract(syntheticCalendarMetadata(), fixture.schemas, accepted.contract));
});

test("cycles, dangling targets, external/anchor/escaped pointers and prototype lookup are refused", () => {
  for (const [ref, definitions, expected] of [
    ["#/$defs/A", { A: { $ref: "#/$defs/A" } }, "cycle"],
    ["#/$defs/A", { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } }, "cycle"],
    ["#/$defs/Missing", {}, "missing_target"],
    ["#/$defs/toString", {}, "missing_target"],
    ["https://example.test/schema#/$defs/A", {}, "unsupported_reference"],
    ["#anchor", {}, "unsupported_reference"],
    ["#", {}, "unsupported_reference"],
    ["#/$defs/A/properties/x", {}, "unsupported_reference"],
    ["#/$defs/A~1B", {}, "unsupported_reference"],
    ["#/$defs/%41", {}, "unsupported_reference"],
    ["#/$defs/../A", {}, "unsupported_reference"],
    ["#/$defs/__proto__", {}, "unsupported_reference"],
    ["#/properties/items", {}, "unsupported_reference"],
  ] as const) {
    const fixture = localOutput({ type: "object", properties: { items: { $ref: ref } }, $defs: definitions });
    assert.throws(fixture.verified, (error: unknown) => { const facts = (error as { facts: { referenceFailure: string; keyword: string } }).facts; assert.equal(facts.referenceFailure, expected); assert.equal(facts.keyword, "$ref"); return true; });
  }
  const proto = localOutput(JSON.parse('{"type":"object","properties":{},"$defs":{"__proto__":{"polluted":true}}}'));
  assert.throws(proto.verified); assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("reference constraints are never merged or ignored; nonvalidating annotations remain inert", () => {
  for (const sibling of [{ type: "array" }, { minItems: 1 }, { required: ["items"] }, { allOf: [] }, { $id: "https://example.test/id" }]) {
    const fixture = localOutput({ type: "object", properties: { items: { $ref: "#/$defs/Array", ...sibling } }, $defs: { Array: { type: "array" } } });
    assert.throws(fixture.verified, (error: unknown) => { assert.equal((error as { facts: { referenceFailure: string } }).facts.referenceFailure, "reference_siblings"); return true; });
  }
});

test("unsafe targets are rejected even when their definitions are never referenced", () => {
  for (const used of [true, false]) for (const target of [
    { type: "string", pattern: "(a+)+$" }, { type: "string", format: "custom" },
    { type: "string", $id: "https://example.test/id" }, { type: "string", $schema: "http://json-schema.org/draft-07/schema#" },
    { $ref: "https://example.test/remote" }, { type: "object", properties: {}, $defs: { Nested: { type: "string" } } },
    { type: "string", $dynamicRef: "#dynamic" }, { type: "string", $anchor: "dynamic" },
  ]) {
    const fixture = localOutput({ type: "object", properties: { items: used ? { $ref: "#/$defs/Target" } : { type: "array" } }, $defs: { Target: target } });
    assert.throws(fixture.verified);
  }
});

test("local definitions never widen Search, GetSchemas, executor or upstream INPUT compilation", () => {
  const addition = { $defs: { Safe: { type: "string" } } };
  const search = syntheticCalendarMetadata(); Object.assign(search[0]!.inputSchema as object, addition); assert.throws(() => buildCalendarSearchRequest(search));
  const getSchemas = syntheticCalendarMetadata(); Object.assign(getSchemas[1]!.inputSchema as object, addition); assert.throws(() => buildCalendarSchemasRequest(getSchemas));
  for (const direction of ["inputSchema", "outputSchema"] as const) { const metadata = syntheticCalendarMetadata(); Object.assign(metadata[2]![direction] as object, addition); assert.throws(() => verifyCalendarContract(metadata, syntheticCalendarSchemas())); }
  const upstream = syntheticCalendarSchemas(); Object.assign(upstream.data.tool_schemas.GOOGLECALENDAR_EVENTS_GET!.input_schema!, addition); assert.throws(() => verifyCalendarContract(syntheticCalendarMetadata(), upstream));
  const dialect = localOutput({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { items: { $ref: "#/$defs/Array" } }, $defs: { Array: { type: "array" } } }); assert.throws(dialect.verified);
});

test("acyclic reference amplification hits the existing expanded node/depth limits", () => {
  const definitions: Record<string, unknown> = { L0: { type: "string" } };
  for (let index = 1; index <= 9; index++) definitions[`L${index}`] = { type: "object", properties: { left: { $ref: `#/$defs/L${index - 1}` }, right: { $ref: `#/$defs/L${index - 1}` } } };
  const wide = localOutput({ type: "object", properties: { payload: { $ref: "#/$defs/L9" } }, $defs: definitions });
  assert.throws(wide.verified, (error: unknown) => { const facts = (error as { facts: { referenceFailure: string; rejectionReason: string; work: { nodes: number } } }).facts; assert.equal(facts.referenceFailure, "expansion_limit"); assert.equal(facts.rejectionReason, "schema_limit"); assert.equal(facts.work.nodes, 513); return true; });
  const deep: Record<string, unknown> = { L0: { type: "string" } };
  for (let index = 1; index <= 13; index++) deep[`L${index}`] = { type: "array", items: { $ref: `#/$defs/L${index - 1}` } };
  const depth = localOutput({ type: "object", properties: { payload: { $ref: "#/$defs/L13" } }, $defs: deep });
  assert.throws(depth.verified, (error: unknown) => { assert.equal((error as { facts: { work: { depth: number } } }).facts.work.depth, 13); return true; });
});

test("repeated inert annotations also obey the expanded byte budget", () => {
  const fixture = localOutput({ type: "object", properties: { a: { $ref: "#/$defs/Annotated" }, b: { $ref: "#/$defs/Annotated" }, c: { $ref: "#/$defs/Annotated" } }, $defs: { Annotated: { type: "string", examples: ["x".repeat(90_000)] } } });
  assert.throws(fixture.verified, (error: unknown) => { const facts = (error as { facts: { referenceFailure: string; work: { nodes: number } } }).facts; assert.equal(facts.referenceFailure, "expansion_limit"); assert.ok(facts.work.nodes < 513, "this refuses byte amplification before reaching the schema-node cap"); return true; });
});

function usedAndUnusedAnnotationSchema(annotation: string) {
  const ref = () => ({ $ref: "#/$defs/Text" });
  return { type: "object", properties: { one: ref(), two: ref() }, $defs: { Text: { type: "string", examples: [annotation] }, Unused: { type: "object", properties: { one: ref(), two: ref() } } } };
}

test("shared expansion byte budget rejects combined schema and unused audit overflow", () => {
  for (const annotation of ["x".repeat(80_000), "\u0001".repeat(14_000)]) {
    const schema = usedAndUnusedAnnotationSchema(annotation);
    assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 256 * 1024, "the original schema fits before four semantic uses amplify its annotation");
    const fixture = localOutput(schema);
    assert.throws(fixture.verified, (error: unknown) => { assert.equal((error as { facts: { referenceFailure: string } }).facts.referenceFailure, "expansion_limit"); return true; });
  }
});

test("shared expansion byte budget accepts schema and unused audit below the combined limit", () => {
  const read = { kind: "listCalendars" as const, accountId: "actual-account" };
  for (const annotation of ["x".repeat(60_000), "\u0001".repeat(9_000)]) {
    const schema = usedAndUnusedAnnotationSchema(annotation), expanded = normalizeComposioCalendarOutputSchema(schema);
    assert.ok(expanded.audit);
    const combinedBytes = Buffer.byteLength(JSON.stringify(expanded.schema)) + Buffer.byteLength(JSON.stringify(expanded.audit));
    assert.ok(combinedBytes > 200_000 && combinedBytes <= 256 * 1024);
    const verified = localOutput(schema).verified();
    verified.response(read, syntheticCalendarExecutor(read, { one: "valid", two: "also valid" }));
    assert.throws(() => verified.response(read, syntheticCalendarExecutor(read, { one: 42 })));
  }
});
