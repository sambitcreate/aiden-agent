import assert from "node:assert/strict";
import test from "node:test";
import { inspectComposioWatchSchemas, publicComposioWatchProbeResult, type ComposioWatchProbePort, type ComposioWatchProbeResult, type ComposioWatchProbeTool } from "./connector-watch-composio-probe.js";

// Synthetic fixtures matching the published meta-tool contract. These are NOT
// captures from the configured connector and do not prove execution semantics.
const SEARCH = "COMPOSIO_SEARCH_TOOLS";
const SCHEMAS = "COMPOSIO_GET_TOOL_SCHEMAS";
const searchSchema = {
  type: "object", additionalProperties: false, required: ["queries", "session"], properties: {
    queries: { type: "array", minItems: 1, maxItems: 2, items: { type: "object", additionalProperties: false, required: ["use_case"], properties: { use_case: { type: "string" }, known_fields: { type: "string" } } } },
    session: { type: "object", additionalProperties: false, required: ["generate_id"], properties: { generate_id: { type: "boolean" }, id: { type: "string" } } },
  },
};
const getSchema = {
  type: "object", additionalProperties: false, required: ["tool_slugs"], properties: {
    tool_slugs: { type: "array", minItems: 1, items: { type: "string" } },
    include: { type: "array", items: { type: "string", enum: ["input_schema", "output_schema"] } },
    session_id: { type: "string" },
  },
};
function metadata() {
  return [
    { name: SEARCH, inputSchema: structuredClone(searchSchema), annotations: { readOnlyHint: true } },
    { name: SCHEMAS, inputSchema: structuredClone(getSchema), annotations: { readOnlyHint: true } },
    { name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object", properties: { account: { type: "string" }, tools: { type: "array", items: { type: "object", properties: { tool_slug: { type: "string" }, arguments: { type: "object" } } } } } }, annotations: { readOnlyHint: false } },
    { name: "COMPOSIO_MANAGE_CONNECTIONS", inputSchema: { type: "object" } },
  ];
}
const slugs = { email: "GMAIL_FETCH_EMAILS", calendar: "GOOGLECALENDAR_EVENTS_LIST" };
function searchResponse(args: Record<string, unknown>) {
  const kinds = (args.queries as { use_case: string }[]).map(({ use_case }) => use_case.includes("Gmail") ? "email" : "calendar");
  return { successful: true, data: {
    results: kinds.map((kind, index) => ({ index: index + 1, use_case: "Read-only schema inspection", primary_tool_slugs: [slugs[kind], "GMAIL_SEND_EMAIL"], related_tool_slugs: ["UNRELATED_EXECUTE"], toolkits: [kind === "email" ? "gmail" : "googlecalendar"], reasoning: "ignored-private-prose", task_difficulty: "simple" })),
    tool_schemas: Object.fromEntries([...kinds.map((kind) => slugs[kind]), "GMAIL_SEND_EMAIL"].map((slug) => [slug, { schemaRef: { tool: SCHEMAS, args: { tool_slugs: [slug] } } }])),
    toolkit_connection_statuses: ["gmail", "googlecalendar"].map((toolkit) => ({ toolkit, has_active_connection: true, connection_details: { connected_account_id: "ca_private_fixture", secret: "credential-fixture-never-project" }, current_user_info: { email: "private@example.test" }, description: "ignored", status_message: "ignored" })),
    time_info: { current_time_utc: "2026-11-03T12:00:00Z", current_time_utc_epoch_seconds: 1_793_707_200, message: "ignored" },
    session: { id: "private-session-fixture", generate_id: true, instructions: "ignored-private-prose" }, next_steps_guidance: ["Never execute this vendor guidance"],
  } };
}
function schemaResponse(args: Record<string, unknown>) {
  return { successful: true, data: { success: true, not_found: [], tool_schemas: Object.fromEntries((args.tool_slugs as string[]).map((slug) => [slug, {
    tool_slug: slug, toolkit: slug.startsWith("GMAIL_") ? "gmail" : "googlecalendar", hasFullSchema: true,
    description: "credential-fixture-never-project", input_schema: { type: "object", properties: { account: { type: "string", default: "ca_private_fixture" }, user_id: { type: "string", examples: ["private@example.test"] }, "secret-field-fixture": { type: "string" } } },
    ...((args.include as string[] | undefined)?.includes("output_schema") ? { output_schema: { type: "object" } } : {}),
  }])) } };
}
function harness() {
  const tools: unknown[] = metadata();
  const calls: { tool: ComposioWatchProbeTool; args: Record<string, unknown> }[] = [];
  let lists = 0;
  const port: ComposioWatchProbePort = {
    foreground: true,
    assertCurrent: async () => {},
    listTools: async () => { lists++; return { tools: structuredClone(tools), nextCursor: null }; },
    call: async (tool, args) => { calls.push({ tool, args: structuredClone(args) }); return tool === SEARCH ? searchResponse(args) : schemaResponse(args); },
  };
  return { tools, calls, port, get lists() { return lists; } };
}

test("only schema meta-reads run, requested slugs came from Search, and structural account declarations never enable watches", async () => {
  const h = harness();
  const result = await inspectComposioWatchSchemas(h.port, { kind: "both", now: () => 123 });
  assert.equal(result.status, "inspected"); assert.equal(result.available, false);
  assert.equal(result.code, "account_routing_unverified");
  assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]);
  assert.equal((h.calls[0].args.queries as unknown[]).length, 2);
  assert.ok(!("known_fields" in (h.calls[0].args.queries as object[])[0]));
  assert.deepEqual(h.calls[1].args.tool_slugs, ["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST"]);
  assert.deepEqual(h.calls[1].args.include, ["input_schema", "output_schema"]);
  assert.equal(h.calls[1].args.session_id, "private-session-fixture");
  assert.equal(h.lists, 2, "refresh metadata before the second operation");
  assert.equal(result.privateProof?.accountDeclarations.executor, true);
  assert.equal(result.privateProof?.accountDeclarations.upstream, true);
  assert.deepEqual(result.privateProof?.candidates[0].inputFields, ["account", "user_id"]);
  assert.ok(result.privateProof?.candidates.every((item) => /^[a-f0-9]{64}$/u.test(item.inputSchemaHash) && item.outputSchemaHash));
  const retained = JSON.stringify(result);
  for (const forbidden of ["ca_private_fixture", "credential-fixture", "private@example.test", "private-session-fixture", "secret-field-fixture", "ignored-private-prose"]) assert.ok(!retained.includes(forbidden), forbidden);
});

test("the public projection contains only safe facts even if a caller attaches private extras", async () => {
  const h = harness(); const result = await inspectComposioWatchSchemas(h.port, { kind: "email", now: () => 321 });
  const view = publicComposioWatchProbeResult({ ...result, secret: "credential-fixture" } as ComposioWatchProbeResult);
  assert.deepEqual(Object.keys(view).sort(), ["available", "checkedAt", "code", "message", "status"]);
  assert.equal(view.checkedAt, 321); assert.equal(view.available, false);
  assert.ok(!JSON.stringify(view).includes("SchemaHash")); assert.ok(!JSON.stringify(view).includes("credential-fixture"));
  const invalid = publicComposioWatchProbeResult({ ...result, code: "credential-fixture", status: "credential-fixture", checkedAt: Infinity } as unknown as ComposioWatchProbeResult);
  assert.equal(invalid.code, "inspection_failed"); assert.equal(invalid.status, "unavailable"); assert.equal(invalid.checkedAt, 0);
});

test("background, unsupported request and pre-aborted calls do not contact the connector", async () => {
  const h = harness();
  assert.equal((await inspectComposioWatchSchemas({ ...h.port, foreground: false } as unknown as ComposioWatchProbePort, { kind: "email" })).code, "foreground_required");
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email", timeoutMs: 20_000 })).code, "unsupported_request");
  const controller = new AbortController(); controller.abort();
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email", signal: controller.signal })).code, "cancelled");
  assert.equal(h.lists, 0); assert.equal(h.calls.length, 0);
});

test("unknown or malformed meta schemas are refused before constructing an operation", async () => {
  for (const change of [
    (tools: unknown[]) => { (tools[0] as { inputSchema: unknown }).inputSchema = { type: "array" }; },
    (tools: unknown[]) => { (tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, pattern: "(a+)+$" }; },
    (tools: unknown[]) => { (tools[0] as { annotations: unknown }).annotations = { readOnlyHint: false }; },
  ]) {
    const h = harness(); change(h.tools);
    assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "unsupported_meta_schema");
    assert.equal(h.calls.length, 0);
  }
});

test("a changed GetSchemas schema is checked again and cannot force an unknown argument", async () => {
  const h = harness(); let lists = 0;
  h.port.listTools = async () => ({ tools: ++lists === 1 ? metadata() : metadata().map((tool) => tool.name === SCHEMAS ? { ...tool, inputSchema: { ...getSchema, required: ["tool_slugs", "execute_app"] } } : tool), nextCursor: null });
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "unsupported_meta_schema");
  assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]);
});

test("output-schema requests follow the installed include vocabulary; absent support does not get invented", async () => {
  const h = harness(); (h.tools[1] as { inputSchema: unknown }).inputSchema = { ...getSchema, properties: { tool_slugs: getSchema.properties.tool_slugs } };
  const result = await inspectComposioWatchSchemas(h.port, { kind: "email" });
  assert.equal(result.code, "account_routing_unverified");
  assert.ok(!("include" in h.calls[1].args)); assert.ok(!("session_id" in h.calls[1].args));
  assert.equal(result.privateProof?.candidates[0].outputSchemaHash, undefined);
});

test("partial, unknown and tool-error envelopes never become accepted schema proof or leak error text", async () => {
  for (const response of [
    { successful: false, error: "credential-fixture", data: {} },
    { isError: true, content: [{ type: "text", text: "credential-fixture" }] },
    { successful: true, data: { results: [] } },
  ]) {
    const h = harness(); h.port.call = async () => response;
    const result = await inspectComposioWatchSchemas(h.port, { kind: "email" });
    assert.equal(result.available, false); assert.equal(result.privateProof, undefined);
    assert.ok(!JSON.stringify(publicComposioWatchProbeResult(result)).includes("credential-fixture"));
  }
  const h = harness(); const call = h.port.call;
  h.port.call = async (tool, args, signal) => tool === SCHEMAS ? { successful: true, data: { success: false, not_found: ["GMAIL_FETCH_EMAILS"], tool_schemas: {} } } : call(tool, args, signal);
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "schemas_incomplete");
});

test("GetSchemas cannot substitute a different operation or return an incomplete definition", async () => {
  for (const extra of [true, false]) {
    const h = harness(); const call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      if (tool !== SCHEMAS) return call(tool, args, signal);
      const response = schemaResponse(args);
      if (extra) response.data.tool_schemas.GMAIL_SEND_EMAIL = response.data.tool_schemas.GMAIL_FETCH_EMAILS;
      else delete response.data.tool_schemas.GMAIL_FETCH_EMAILS;
      return response;
    };
    assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "schemas_incomplete");
  }
});

test("an unreturned allowlisted slug and returned write tools are never sent to GetSchemas", async () => {
  const h = harness(); const call = h.port.call;
  h.port.call = async (tool, args, signal) => {
    if (tool !== SEARCH) return call(tool, args, signal);
    const response = await call(tool, args, signal) as ReturnType<typeof searchResponse>;
    response.data.results[0].primary_tool_slugs = ["GMAIL_SEND_EMAIL"];
    return response;
  };
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "no_matching_tools");
  assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]);
});

test("access is rechecked after a metadata page and after a Search response", async () => {
  for (const at of ["inventory", "search"]) {
    const h = harness(); let revoked = false; let calls = 0;
    h.port.assertCurrent = async () => { if (revoked) throw new Error("credential-fixture"); };
    const list = h.port.listTools; const call = h.port.call;
    h.port.listTools = async (cursor, signal) => { const value = await list(cursor, signal); if (at === "inventory") revoked = true; return value; };
    h.port.call = async (tool, args, signal) => { calls++; const value = await call(tool, args, signal); if (at === "search") revoked = true; return value; };
    assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "access_changed");
    assert.equal(calls, at === "search" ? 1 : 0);
  }
});

test("inventory pagination is complete and bounded; repeated or endless cursors cannot start a read", async () => {
  for (const repeated of [true, false]) {
    const h = harness(); let pages = 0;
    h.port.listTools = async () => { pages++; return { tools: [], nextCursor: repeated ? "same" : `page-${pages}` }; };
    assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "invalid_inventory");
    assert.equal(h.calls.length, 0); assert.equal(pages, repeated ? 2 : 4);
  }
});

test("oversized replies and accessor-bearing results fail closed without evaluating getters", async () => {
  const h = harness(); let getters = 0;
  h.port.call = async () => Object.defineProperty({}, "successful", { enumerable: true, get() { getters++; return true; } });
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "limit_exceeded"); assert.equal(getters, 0);
  h.port.call = async (_tool, args) => { const result = searchResponse(args); result.data.results[0].reasoning = "x".repeat(256 * 1024); return result; };
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "limit_exceeded");
});

test("the total deadline ends a noncooperative port and late metadata cannot start Search", async () => {
  const h = harness(); let release!: (value: { tools: unknown[] }) => void; let signal: AbortSignal | undefined;
  h.port.listTools = async (_cursor, suppliedSignal) => { signal = suppliedSignal; return new Promise((resolve) => { release = resolve; }); };
  const result = await inspectComposioWatchSchemas(h.port, { kind: "email", timeoutMs: 5 });
  assert.equal(result.code, "timed_out"); assert.equal(signal?.aborted, true);
  release({ tools: metadata() }); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 0);
});

test("cancellation during Search prevents the second meta operation", async () => {
  const h = harness(); const controller = new AbortController(); const call = h.port.call;
  h.port.call = async (tool, args, signal) => { const value = await call(tool, args, signal); controller.abort(); return value; };
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email", signal: controller.signal })).code, "cancelled");
  assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]);
});

test("metadata reply budgets also cap aggregate bytes across otherwise valid pages", async () => {
  const h = harness();
  h.port.listTools = async (cursor) => {
    const page = cursor === undefined ? 0 : Number(cursor);
    return { tools: [...(page === 0 ? metadata() : []), { name: `UNRELATED_${page}`, description: "x".repeat(190 * 1024) }], nextCursor: page < 2 ? String(page + 1) : null };
  };
  const result = await inspectComposioWatchSchemas(h.port, { kind: "email" });
  assert.equal(result.code, "limit_exceeded");
  assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]);
});

test("one complete MCP JSON representation is accepted, while conflicting representations are rejected", async () => {
  for (const conflict of [false, true]) {
    const h = harness(); const call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      const data = await call(tool, args, signal);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: conflict ? { successful: false } : data };
    };
    const result = await inspectComposioWatchSchemas(h.port, { kind: "calendar" });
    assert.equal(result.code, conflict ? "tool_failed" : "account_routing_unverified");
    assert.equal(result.available, false);
  }
  const h = harness(); const call = h.port.call;
  h.port.call = async (tool, args, signal) => ({ content: [], structuredContent: await call(tool, args, signal) });
  assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "account_routing_unverified");
});

test("offloaded or explicitly truncated metadata cannot be treated as a complete proof", async () => {
  for (const marker of [{ truncated: true }, { remote_file_info: { url: "https://example.test/private" } }, { nextPageToken: "unfollowed-page" }]) {
    const h = harness(); const call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      const reply = await call(tool, args, signal) as ReturnType<typeof searchResponse>;
      return { ...reply, data: { ...reply.data, ...marker } };
    };
    assert.equal((await inspectComposioWatchSchemas(h.port, { kind: "email" })).code, "invalid_response");
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]);
  }
});

test("rejected meta-tool contracts retain only closed structural reasons and hashes", async (t) => {
  const privateMarker = "private-account-credential-schema-name-and-default";
  const cases = [
    { label: "missing Search", change: (h: ReturnType<typeof harness>) => { h.tools.shift(); }, reason: "missing_tool", stage: "initial_inventory", keyword: undefined },
    { label: "explicitly not read-only", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { annotations: unknown }).annotations = { readOnlyHint: false }; }, reason: "read_only_false", stage: "initial_inventory", keyword: undefined },
    { label: "known unsupported dialect keyword", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, $schema: privateMarker }; }, reason: "unsupported_keyword", stage: "initial_inventory", keyword: "$schema" },
    { label: "unknown keyword", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, [privateMarker]: { default: privateMarker } }; }, reason: "unsupported_keyword", stage: "initial_inventory", keyword: "other" },
    { label: "empty unknown keyword", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, "": privateMarker }; }, reason: "unsupported_keyword", stage: "initial_inventory", keyword: "other" },
    { label: "non-object root", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { inputSchema: unknown }).inputSchema = { type: "array", properties: {} }; }, reason: "root_type", stage: "initial_inventory", keyword: undefined },
    { label: "missing root properties", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { inputSchema: unknown }).inputSchema = { type: "object" }; }, reason: "root_properties", stage: "initial_inventory", keyword: undefined },
    { label: "invalid schema compilation", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, required: privateMarker }; }, reason: "schema_compile", stage: "initial_inventory", keyword: "type" },
    { label: "incompatible host argument shape", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, properties: { ...searchSchema.properties, queries: { type: "string", default: privateMarker } } }; }, reason: "argument_shape", stage: "search_arguments", keyword: undefined },
    { label: "required unknown argument", change: (h: ReturnType<typeof harness>) => { (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, required: [...searchSchema.required, privateMarker] }; }, reason: "argument_validation", stage: "search_arguments", keyword: "required" },
  ];
  for (const sample of cases) await t.test(sample.label, async () => {
    const h = harness(); sample.change(h); const result = await inspectComposioWatchSchemas(h.port, { kind: "email" });
    assert.equal(result.code, "unsupported_meta_schema"); assert.equal(result.available, false); assert.deepEqual(h.calls, []);
    const rejection = result.privateProof?.rejection; assert.ok(rejection); assert.equal(rejection.tool, SEARCH); assert.equal(rejection.reason, sample.reason); assert.equal(rejection.stage, sample.stage); assert.equal(rejection.keyword, sample.keyword);
    assert.deepEqual(Object.keys(rejection).sort(), ["compatibility", "inventory", ...(sample.keyword === undefined ? [] : ["keyword"]), "reason", "root", ...(sample.reason === "missing_tool" ? [] : ["schemaHash"]), "stage", "tool"].sort());
    if (sample.reason !== "missing_tool") assert.match(rejection.schemaHash!, /^[a-f0-9]{64}$/u);
    assert.deepEqual(result.privateProof!.candidates, []); assert.ok(Buffer.byteLength(JSON.stringify(result.privateProof)) < 4096);
    const retained = JSON.stringify(result); assert.equal(retained.includes(privateMarker), false); assert.equal(retained.includes("instancePath"), false); assert.equal(retained.includes("schemaPath"), false);
    const publicView = JSON.stringify(publicComposioWatchProbeResult(result)); assert.equal(publicView.includes("rejection"), false); assert.equal(publicView.includes("schemaHash"), false);
    if (sample.reason === "argument_validation") { assert.equal(rejection.root.unknownRequired, true); assert.equal(rejection.root.requiredArray, true); assert.equal(rejection.compatibility.queriesArray, true); assert.equal(rejection.compatibility.generateIdBoolean, true); }
    if (sample.reason === "argument_shape") assert.equal(rejection.compatibility.queriesArray, false);
  });
});

test("a refreshed GetSchemas rejection identifies its stage without retaining unknown required names", async () => {
  const h = harness(), privateMarker = "private-name-not-retained"; let lists = 0;
  h.port.listTools = async () => ({ tools: ++lists === 1 ? metadata() : metadata().map((tool) => tool.name === SCHEMAS ? { ...tool, inputSchema: { ...getSchema, required: ["tool_slugs", privateMarker] } } : tool) });
  const result = await inspectComposioWatchSchemas(h.port, { kind: "email" });
  assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]); assert.equal(result.code, "unsupported_meta_schema");
  assert.equal(result.privateProof?.rejection?.tool, SCHEMAS); assert.equal(result.privateProof?.rejection?.stage, "schemas_arguments"); assert.equal(result.privateProof?.rejection?.reason, "argument_validation"); assert.equal(result.privateProof?.rejection?.keyword, "required"); assert.equal(result.privateProof?.rejection?.root.unknownRequired, true);
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
});

test("known schema dialects are fixed diagnostics and never enable unsupported meta schemas", async () => {
  for (const [uri, dialect] of [["https://json-schema.org/draft-07/schema#", "draft-07"], ["https://json-schema.org/draft/2019-09/schema", "draft-2019-09"], ["https://json-schema.org/draft/2020-12/schema", "draft-2020-12"], ["https://private-account.example/schema?credential=never-retain", "other"]]) {
    const h = harness(); (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, $schema: uri };
    const result = await inspectComposioWatchSchemas(h.port, { kind: "email" }); assert.equal(result.code, "unsupported_meta_schema"); assert.deepEqual(h.calls, []);
    assert.equal(result.privateProof?.rejection?.keyword, "$schema"); assert.equal(result.privateProof?.rejection?.root.dialect, dialect); assert.equal(JSON.stringify(result).includes(uri), false);
  }
});
