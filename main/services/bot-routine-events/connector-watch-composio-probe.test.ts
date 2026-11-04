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

test("unused Search description fields can be omitted independently while tool correlation and watch gating remain intact", async (t) => {
  for (const omitted of [["reasoning", "task_difficulty"], ["reasoning"], ["task_difficulty"]]) await t.test(omitted.join("+"), async () => {
    const h = harness(), call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      const response = await call(tool, args, signal) as { data: { results: Record<string, unknown>[] } };
      if (tool === SEARCH) for (const result of response.data.results) for (const field of omitted) delete result[field];
      return response;
    };
    const inspected = await inspectComposioWatchSchemas(h.port, { kind: "both" });
    assert.equal(inspected.code, "account_routing_unverified"); assert.equal(inspected.status, "inspected"); assert.equal(inspected.available, false);
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]); assert.deepEqual(h.calls[1].args.tool_slugs, ["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST"]);
    assert.deepEqual(inspected.privateProof?.candidates.map((candidate) => candidate.kind), ["email", "calendar"]);
    assert.equal(inspected.privateProof?.responseRejection, undefined);
    for (const forbidden of ["ca_private_fixture", "private-session-fixture", "private@example.test", "ignored-private-prose"]) assert.ok(!JSON.stringify(inspected).includes(forbidden));
  });
});

test("optional Search description fields reject malformed present values and never retain accepted prose", async (t) => {
  for (const field of ["reasoning", "task_difficulty"]) {
    for (const value of [null, 123, {}, [], "x".repeat(4097), "\ud800"]) await t.test(`${field}/${typeof value}/${value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "string" ? value.length : "value"}`, async () => {
      const h = harness(), call = h.port.call;
      h.port.call = async (tool, args, signal) => {
        const response = await call(tool, args, signal) as { data: { results: Record<string, unknown>[] } };
        if (tool === SEARCH) response.data.results[0]![field] = value;
        return response;
      };
      const inspected = await inspectComposioWatchSchemas(h.port, { kind: "email" });
      assert.equal(inspected.code, "invalid_response"); assert.equal(inspected.available, false); assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]);
      assert.equal(inspected.privateProof?.responseRejection?.field, field === "reasoning" ? "result.reasoning" : "result.task_difficulty");
      assert.equal(inspected.privateProof?.responseRejection?.reason, typeof value === "string" ? "invalid_text" : "expected_string");
      assert.ok(!JSON.stringify(inspected).includes("ca_private_fixture")); assert.ok(!JSON.stringify(inspected).includes("private-session-fixture"));
    });
    const h = harness(), call = h.port.call, prose = "private-descriptive-prose-never-authorization";
    h.port.call = async (tool, args, signal) => {
      const response = await call(tool, args, signal) as { data: { results: Record<string, unknown>[] } };
      if (tool === SEARCH) { response.data.results[0]![field] = prose; response.data.results[0]![field === "reasoning" ? "task_difficulty" : "reasoning"] = ""; }
      return response;
    };
    const inspected = await inspectComposioWatchSchemas(h.port, { kind: "email" });
    assert.equal(inspected.code, "account_routing_unverified"); assert.equal(inspected.available, false);
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]); assert.ok(!JSON.stringify(inspected).includes(prose));
  }
});

test("unused legacy connection details can be omitted independently without granting account routing", async (t) => {
  for (const omitted of [["gmail"], ["googlecalendar"], ["gmail", "googlecalendar"]]) await t.test(omitted.join("+"), async () => {
    const h = harness(), call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      const response = await call(tool, args, signal) as { data: { toolkit_connection_statuses: Record<string, unknown>[] } };
      if (tool === SEARCH) for (const status of response.data.toolkit_connection_statuses) if (omitted.includes(status.toolkit as string)) delete status.connection_details;
      return response;
    };
    const inspected = await inspectComposioWatchSchemas(h.port, { kind: "both" });
    assert.equal(inspected.status, "inspected"); assert.equal(inspected.code, "account_routing_unverified"); assert.equal(inspected.available, false);
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]); assert.deepEqual(h.calls[1].args.tool_slugs, ["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST"]);
    assert.deepEqual(inspected.privateProof?.activeConnectionReported, { email: true, calendar: true });
    assert.ok(!JSON.stringify(inspected).includes("ca_private_fixture"));
  });
});

test("present legacy connection details must be objects without incomplete markers", async (t) => {
  for (const details of [null, false, 123, "private-connection-details", [], { truncated: true }, { next_cursor: "private-connection-cursor" }]) await t.test(JSON.stringify(details), async () => {
    const h = harness(), call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      const response = await call(tool, args, signal) as { data: { toolkit_connection_statuses: Record<string, unknown>[] } };
      if (tool === SEARCH) response.data.toolkit_connection_statuses[0]!.connection_details = details;
      return response;
    };
    const inspected = await inspectComposioWatchSchemas(h.port, { kind: "email" }), diagnostic = inspected.privateProof?.responseRejection;
    assert.equal(inspected.code, "invalid_response"); assert.equal(inspected.available, false); assert.equal(diagnostic?.stage, "connections");
    assert.equal(diagnostic?.reason, details !== null && !Array.isArray(details) && typeof details === "object" ? "incomplete" : "expected_object");
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]);
    assert.ok(!JSON.stringify(inspected).includes("private-connection-details")); assert.ok(!JSON.stringify(inspected).includes("private-connection-cursor"));
  });
});

test("connection account diagnostics retain only fixed types/counts on success and later schema rejection", async (t) => {
  for (const failLater of [false, true]) await t.test(failLater ? "later rejection" : "inspection", async () => {
    const marker = "private-account-id-alias-user-status-and-unknown-key", number = 9876543210123;
    const h = harness(), call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      const response = await call(tool, args, signal) as { data: Record<string, unknown> };
      if (tool === SEARCH) {
        const statuses = response.data.toolkit_connection_statuses as Record<string, unknown>[];
        delete statuses[0]!.connection_details;
        statuses[0]!.accounts = [
          { id: marker, alias: null, user_info: { [marker]: marker }, status: marker, created_at: number, is_default: true, account_type: marker, [marker]: marker },
          { id: "second-private-account-must-not-be-retained" },
        ];
        statuses[0]!.account_selection = { [marker]: marker };
        statuses[1]!.accounts = []; statuses[1]!.account_selection = marker;
      } else if (failLater) response.data.success = false;
      return response;
    };
    const inspected = await inspectComposioWatchSchemas(h.port, { kind: "both" }), shapes = inspected.privateProof?.connectionMetadata;
    assert.equal(inspected.code, failLater ? "schemas_incomplete" : "account_routing_unverified"); assert.equal(inspected.available, false);
    assert.deepEqual(shapes, [
      { kind: "email", accounts: { type: "array", count: 2 }, account_selection: { type: "object", count: 1 }, firstAccount: { value: { type: "object", count: 8 }, statusIsActive: false, idFormat: "other", fields: {
        id: { type: "string", count: marker.length }, alias: { type: "null" }, user_info: { type: "object", count: 1 }, status: { type: "string", count: marker.length }, created_at: { type: "number" }, is_default: { type: "boolean" }, account_type: { type: "string", count: marker.length },
      } } },
      { kind: "calendar", accounts: { type: "array", count: 0 }, account_selection: { type: "string", count: marker.length } },
    ]);
    const retained = JSON.stringify(inspected);
    for (const forbidden of [marker, String(number), "second-private-account-must-not-be-retained", "ca_private_fixture", "private@example.test"]) assert.ok(!retained.includes(forbidden));
    assert.ok(Buffer.byteLength(retained) < 32 * 1024); assert.ok(!JSON.stringify(publicComposioWatchProbeResult(inspected)).includes("connectionMetadata"));
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]); assert.ok(!JSON.stringify(h.calls).includes(marker), "account metadata never supplies operation arguments");
  });
});

test("account metadata diagnostics do not validate identities, choose defaults or retain unknown toolkit names", async () => {
  const h = harness(), call = h.port.call;
  h.port.call = async (tool, args, signal) => {
    const response = await call(tool, args, signal) as { data: { toolkit_connection_statuses: Record<string, unknown>[] } };
    if (tool === SEARCH) {
      const status = response.data.toolkit_connection_statuses[0]!;
      status.toolkit = "private-unknown-toolkit"; status.accounts = [null]; status.account_selection = false;
    }
    return response;
  };
  const inspected = await inspectComposioWatchSchemas(h.port, { kind: "email" }), shape = inspected.privateProof?.connectionMetadata?.[0];
  assert.equal(inspected.code, "account_routing_unverified"); assert.equal(inspected.available, false);
  assert.equal(shape?.kind, "other"); assert.deepEqual(shape?.account_selection, { type: "boolean" }); assert.deepEqual(shape?.firstAccount?.value, { type: "null" });
  assert.equal(shape?.firstAccount?.idFormat, "missing"); assert.equal(shape?.firstAccount?.statusIsActive, false);
  assert.ok(Object.values(shape!.firstAccount!.fields).every((field) => field.type === "missing"));
  assert.ok(!JSON.stringify(inspected).includes("private-unknown-toolkit")); assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]);
});

test("account diagnostics classify only fixed ID syntax and exact ACTIVE status without retaining either value", async (t) => {
  const cases = [
    { id: "ca_0123abcdABCD", status: "ACTIVE", format: "ca_id", active: true },
    { id: "12345678-1234-5678-9abc-def012345678", status: "active", format: "uuid", active: false },
    { id: "private-account-identity", status: "PRIVATE-STATUS", format: "other", active: false },
    { id: "ca_short", status: null, format: "other", active: false },
    { id: "ca_0123abcd/injected", status: "ACTIVE ", format: "other", active: false },
    { id: undefined, status: undefined, format: "missing", active: false },
  ];
  for (const entry of cases) await t.test(entry.format + "/" + String(entry.status), async () => {
    const h = harness(), call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      const response = await call(tool, args, signal) as { data: { toolkit_connection_statuses: Record<string, unknown>[] } };
      if (tool === SEARCH) response.data.toolkit_connection_statuses[0]!.accounts = [{ ...(entry.id === undefined ? {} : { id: entry.id }), ...(entry.status === undefined ? {} : { status: entry.status }) }];
      return response;
    };
    const inspected = await inspectComposioWatchSchemas(h.port, { kind: "email" }), facts = inspected.privateProof?.connectionMetadata?.[0]?.firstAccount;
    assert.equal(inspected.code, "account_routing_unverified"); assert.equal(inspected.available, false); assert.equal(facts?.idFormat, entry.format); assert.equal(facts?.statusIsActive, entry.active);
    if (entry.id !== undefined) assert.ok(!JSON.stringify(inspected).includes(entry.id));
    if (typeof entry.status === "string") assert.ok(!JSON.stringify(inspected).includes(JSON.stringify(entry.status)));
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]);
  });
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
    assert.equal(result.available, false); assert.deepEqual(result.privateProof?.candidates, []);
    assert.equal(result.privateProof?.responseRejection?.calls.searchStarted, true); assert.equal(result.privateProof?.responseRejection?.calls.schemasStarted, false);
    assert.ok(!JSON.stringify(result).includes("credential-fixture"));
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

test("unsupported schema dialects remain fixed diagnostics and never enable unsupported meta schemas", async () => {
  for (const [uri, dialect] of [["https://json-schema.org/draft/2019-09/schema", "draft-2019-09"], ["https://json-schema.org/draft/2020-12/schema", "draft-2020-12"], ["https://private-account.example/schema?credential=never-retain", "other"]]) {
    const h = harness(); (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, $schema: uri };
    const result = await inspectComposioWatchSchemas(h.port, { kind: "email" }); assert.equal(result.code, "unsupported_meta_schema"); assert.deepEqual(h.calls, []);
    assert.equal(result.privateProof?.rejection?.keyword, "$schema"); assert.equal(result.privateProof?.rejection?.root.dialect, dialect); assert.equal(JSON.stringify(result).includes(uri), false);
  }
});

test("both metadata tools accept only canonical root draft-07 annotations through the existing schema subset", async () => {
  for (const uri of ["http://json-schema.org/draft-07/schema", "http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema", "https://json-schema.org/draft-07/schema#"]) {
    const h = harness();
    for (const tool of h.tools as { name: string; inputSchema: unknown }[]) if (tool.name === SEARCH || tool.name === SCHEMAS) tool.inputSchema = { ...(tool.inputSchema as Record<string, unknown>), $schema: uri };
    const result = await inspectComposioWatchSchemas(h.port, { kind: "both" });
    assert.equal(result.code, "account_routing_unverified"); assert.equal(result.available, false); assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]); assert.equal(h.lists, 2);
    assert.deepEqual(h.calls[1]!.args.tool_slugs, ["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST"]); assert.equal(result.privateProof?.rejection, undefined); assert.equal(JSON.stringify(result).includes(uri), false);
  }
});

test("root draft-07 does not permit nested dialects, references, identifiers, regular expressions or formats", async (t) => {
  for (const toolName of [SEARCH, SCHEMAS]) for (const [label, forbidden] of [
    ["nested dialect", { $schema: "http://json-schema.org/draft-07/schema#" }],
    ["remote reference", { $ref: "https://private.invalid/schema?account=never-retain" }],
    ["local reference", { $ref: "#/definitions/private" }],
    ["identifier", { $id: "https://private.invalid/schema" }],
    ["regular expression", { pattern: "(a+)+$" }],
    ["custom format", { format: "private-custom-format" }],
  ] as const) await t.test(`${toolName}/${label}`, async () => {
    const h = harness(), tool = (h.tools as { name: string; inputSchema: unknown }[]).find((entry) => entry.name === toolName)!;
    const schema = structuredClone(toolName === SEARCH ? searchSchema : getSchema) as Record<string, unknown>;
    schema.$schema = "https://json-schema.org/draft-07/schema#";
    const properties = schema.properties as Record<string, unknown>;
    properties.private_nested_field = { type: "string", ...forbidden }; tool.inputSchema = schema;
    const result = await inspectComposioWatchSchemas(h.port, { kind: "email" });
    assert.equal(result.code, "unsupported_meta_schema"); assert.deepEqual(h.calls, []); assert.equal(result.privateProof?.rejection?.tool, toolName); assert.equal(result.privateProof?.rejection?.reason, "unsupported_keyword"); assert.equal(result.privateProof?.rejection?.root.dialect, "draft-07"); assert.equal(JSON.stringify(result).includes("private.invalid"), false);
  });
});

test("draft-07 compatibility refuses lookalike root URIs and rechecks dialect drift before GetSchemas", async () => {
  for (const uri of ["http://json-schema.org/draft-07/schema?account=private", "https://json-schema.org/draft-07/schema/", "https://json-schema.org.evil.invalid/draft-07/schema#"]) {
    const h = harness(); (h.tools[0] as { inputSchema: unknown }).inputSchema = { ...searchSchema, $schema: uri };
    const result = await inspectComposioWatchSchemas(h.port, { kind: "email" }); assert.equal(result.code, "unsupported_meta_schema"); assert.deepEqual(h.calls, []); assert.equal(result.privateProof?.rejection?.root.dialect, "other");
  }
  const h = harness(); let lists = 0;
  h.port.listTools = async () => { lists++; return { tools: metadata().map((tool) => tool.name === SEARCH || tool.name === SCHEMAS ? { ...tool, inputSchema: { ...tool.inputSchema, $schema: lists === 1 || tool.name === SEARCH ? "https://json-schema.org/draft-07/schema#" : "https://json-schema.org/draft/2020-12/schema" } } : tool) }; };
  const result = await inspectComposioWatchSchemas(h.port, { kind: "email" }); assert.equal(result.code, "unsupported_meta_schema"); assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]); assert.equal(result.privateProof?.rejection?.tool, SCHEMAS); assert.equal(result.privateProof?.rejection?.stage, "refreshed_inventory"); assert.equal(result.privateProof?.rejection?.root.dialect, "draft-2020-12");
});

test("response diagnostics distinguish MCP, action and data gates for both permitted operations without retaining values", async (t) => {
  const marker = "private-response-schema-account-session-credential-and-unknown-key";
  const cases = [
    { name: "non-object response", reply: () => marker, code: "invalid_response", field: "response", reason: "expected_object" },
    { name: "multiple MCP parts", reply: () => ({ content: [{ type: "text", text: marker }, { type: "text", text: marker }] }), code: "tool_failed", field: "mcp_json", reason: "mcp_json_rejected" },
    { name: "non-JSON MCP text", reply: () => ({ content: [{ type: "text", text: marker }] }), code: "tool_failed", field: "mcp_json", reason: "mcp_json_rejected" },
    { name: "primitive MCP JSON", reply: () => ({ content: [{ type: "text", text: JSON.stringify(marker) }] }), code: "tool_failed", field: "mcp_json", reason: "mcp_json_rejected" },
    { name: "MCP error", reply: () => ({ isError: true, content: [{ type: "text", text: marker }] }), code: "tool_failed", field: "mcp_json", reason: "mcp_json_rejected" },
    { name: "conflicting MCP representations", reply: () => ({ content: [{ type: "text", text: JSON.stringify({ successful: true, data: {} }) }], structuredContent: { successful: false, error: marker } }), code: "tool_failed", field: "mcp_json", reason: "mcp_json_rejected" },
    { name: "missing action success", reply: () => ({ success: true, data: { [marker]: marker } }), code: "tool_failed", field: "successful", reason: "action_unsuccessful" },
    { name: "action error", reply: () => ({ successful: true, error: marker, data: {} }), code: "tool_failed", field: "error", reason: "reported_error" },
    { name: "non-object action data", reply: () => ({ content: [], structuredContent: { successful: true, data: [marker] } }), code: "invalid_response", field: "data", reason: "expected_object" },
  ];
  for (const tool of [SEARCH, SCHEMAS] as const) for (const entry of cases) await t.test(`${tool}/${entry.name}`, async () => {
    const h = harness(), call = h.port.call;
    h.port.call = async (name, args, signal) => { const value = await call(name, args, signal); return name === tool ? entry.reply() : value; };
    const result = await inspectComposioWatchSchemas(h.port, { kind: "email" }), diagnostic = result.privateProof?.responseRejection;
    assert.equal(result.code, entry.code); assert.equal(result.available, false); assert.equal(diagnostic?.tool, tool);
    assert.equal(diagnostic?.stage, tool === SEARCH ? "search_response" : "get_schemas_response");
    assert.equal(diagnostic?.field, entry.field); assert.equal(diagnostic?.reason, entry.reason);
    assert.deepEqual(diagnostic?.calls, { searchStarted: true, searchReturned: true, schemasStarted: tool === SCHEMAS, schemasReturned: tool === SCHEMAS });
    assert.deepEqual(diagnostic?.inventory, { initialComplete: true, refreshedComplete: tool === SCHEMAS });
    assert.equal(result.privateProof?.accountDeclarations.executor, true); assert.deepEqual(result.privateProof?.candidates, []);
    const retained = JSON.stringify(result); assert.ok(!retained.includes(marker)); assert.ok(Buffer.byteLength(retained) < 32 * 1024);
    assert.deepEqual(Object.keys(publicComposioWatchProbeResult(result)).sort(), ["available", "checkedAt", "code", "message", "status"]);
    if (entry.name === "non-JSON MCP text") assert.equal(diagnostic?.envelope?.firstContent?.textJson, "invalid");
    if (entry.name === "primitive MCP JSON") { assert.equal(diagnostic?.envelope?.firstContent?.textJson, "valid"); assert.equal(diagnostic?.value?.type, "string"); }
    if (entry.name === "missing action success") { assert.equal(diagnostic?.action?.successful.type, "missing"); assert.deepEqual(diagnostic?.action?.success, { type: "boolean", boolean: true }); }
  });
});

test("Search rejection diagnostics identify strict field, completeness and connection gates with closed type/count facts", async (t) => {
  type Data = Record<string, unknown>;
  const result = (data: Data) => (data.results as Data[])[0]!;
  const connection = (data: Data) => (data.toolkit_connection_statuses as Data[])[0]!;
  const cases: { name: string; change(data: Data): void; field: string; stage?: string; reason?: string; code?: string }[] = [
    { name: "missing results", change: (data) => { delete data.results; }, field: "results", reason: "expected_array" },
    { name: "results count", change: (data) => { data.results = []; }, field: "results", reason: "unexpected_count" },
    { name: "schema map shape", change: (data) => { data.tool_schemas = []; }, field: "tool_schemas", reason: "expected_object" },
    { name: "schema map limit", change: (data) => { data.tool_schemas = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`private-${index}`, {}])); }, field: "tool_schemas", reason: "limit", code: "limit_exceeded" },
    { name: "connection list shape", change: (data) => { data.toolkit_connection_statuses = {}; }, field: "toolkit_connection_statuses", reason: "expected_array" },
    { name: "connection list limit", change: (data) => { data.toolkit_connection_statuses = Array(17).fill({}); }, field: "toolkit_connection_statuses", reason: "unexpected_count" },
    { name: "missing time", change: (data) => { delete data.time_info; }, field: "time_info", reason: "expected_object" },
    { name: "guidance shape", change: (data) => { data.next_steps_guidance = {}; }, field: "next_steps_guidance", reason: "expected_array" },
    { name: "guidance element", change: (data) => { data.next_steps_guidance = [null]; }, field: "next_steps_guidance", reason: "expected_string" },
    { name: "session shape", change: (data) => { data.session = []; }, field: "session", reason: "expected_object" },
    { name: "session ID", change: (data) => { (data.session as Data).id = ""; }, field: "session.id", reason: "invalid_text" },
    { name: "session generation", change: (data) => { (data.session as Data).generate_id = "private-value"; }, field: "session.generate_id", reason: "expected_boolean" },
    { name: "session instructions", change: (data) => { delete (data.session as Data).instructions; }, field: "session.instructions", reason: "expected_string" },
    { name: "time text", change: (data) => { (data.time_info as Data).current_time_utc = null; }, field: "time_info.current_time_utc", reason: "expected_string" },
    { name: "time integer", change: (data) => { (data.time_info as Data).current_time_utc_epoch_seconds = 1.5; }, field: "time_info.current_time_utc_epoch_seconds", reason: "expected_integer" },
    { name: "time message", change: (data) => { (data.time_info as Data).message = null; }, field: "time_info.message", reason: "expected_string" },
    { name: "result shape", change: (data) => { data.results = [null]; }, field: "result", stage: "results", reason: "expected_object" },
    { name: "result index", change: (data) => { result(data).index = 0; }, field: "result.index", stage: "results", reason: "unexpected_value" },
    { name: "result use case", change: (data) => { delete result(data).use_case; }, field: "result.use_case", stage: "results", reason: "expected_string" },
    { name: "result toolkit list", change: (data) => { result(data).toolkits = {}; }, field: "result.toolkits", stage: "results", reason: "expected_array" },
    { name: "result reasoning", change: (data) => { result(data).reasoning = null; }, field: "result.reasoning", stage: "results", reason: "expected_string" },
    { name: "result difficulty", change: (data) => { result(data).task_difficulty = null; }, field: "result.task_difficulty", stage: "results", reason: "expected_string" },
    { name: "result error", change: (data) => { result(data).error = "private-value"; }, field: "result.error", stage: "results", reason: "reported_error" },
    { name: "primary slug list", change: (data) => { result(data).primary_tool_slugs = {}; }, field: "result.primary_tool_slugs", stage: "results", reason: "expected_array" },
    { name: "related slug list", change: (data) => { result(data).related_tool_slugs = [""]; }, field: "result.related_tool_slugs", stage: "results", reason: "invalid_text" },
    { name: "missing candidate definition", change: (data) => { data.tool_schemas = {}; }, field: "tool_schemas", stage: "results", reason: "missing_definition" },
    { name: "connection shape", change: (data) => { data.toolkit_connection_statuses = [null]; }, field: "connection", stage: "connections", reason: "expected_object" },
    { name: "connection toolkit", change: (data) => { connection(data).toolkit = 1; }, field: "connection.toolkit", stage: "connections", reason: "expected_string" },
    { name: "duplicate connection", change: (data) => { data.toolkit_connection_statuses = [connection(data), connection(data)]; }, field: "connection.toolkit", stage: "connections", reason: "duplicate" },
    { name: "connection active state", change: (data) => { connection(data).has_active_connection = "private-value"; }, field: "connection.has_active_connection", stage: "connections", reason: "expected_boolean" },
    { name: "connection detail shape", change: (data) => { connection(data).connection_details = []; }, field: "connection.connection_details", stage: "connections", reason: "expected_object" },
    { name: "connection description", change: (data) => { delete connection(data).description; }, field: "connection.description", stage: "connections", reason: "expected_string" },
    { name: "connection status message", change: (data) => { connection(data).status_message = null; }, field: "connection.status_message", stage: "connections", reason: "expected_string" },
    { name: "partial response", change: (data) => { data.next_page_token = "private-value"; }, field: "next_page_token", reason: "incomplete" },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const h = harness(), call = h.port.call;
    h.port.call = async (tool, args, signal) => {
      const value = await call(tool, args, signal) as { data: Data };
      if (tool === SEARCH) entry.change(value.data);
      return value;
    };
    const inspected = await inspectComposioWatchSchemas(h.port, { kind: "email" }), diagnostic = inspected.privateProof?.responseRejection;
    assert.equal(inspected.code, entry.code ?? "invalid_response"); assert.equal(inspected.available, false);
    assert.equal(diagnostic?.stage, entry.stage ?? "search_response"); assert.equal(diagnostic?.field, entry.field); assert.equal(diagnostic?.reason, entry.reason);
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH]); assert.equal(diagnostic?.calls.schemasStarted, false);
    assert.ok(!JSON.stringify(inspected).includes("private-value")); assert.ok(!JSON.stringify(inspected).includes("private-0"));
    if (entry.name === "missing results") { assert.equal(diagnostic?.data?.results.type, "missing"); assert.equal(diagnostic?.data?.session.type, "object"); assert.deepEqual(diagnostic?.data?.toolkit_connection_statuses, { type: "array", count: 2 }); }
    if (entry.name === "time integer") assert.deepEqual(diagnostic?.value, { type: "number", safeInteger: false });
    if (entry.name === "session generation") assert.equal(diagnostic?.entry?.instructions?.type, "string");
  });
});

test("GetSchemas diagnostics distinguish incomplete definitions and schema shapes after both metadata reads", async (t) => {
  type Data = Record<string, unknown>;
  const definitions = (data: Data) => data.tool_schemas as Data;
  const definition = (data: Data) => definitions(data).GMAIL_FETCH_EMAILS as Data;
  const cases: { name: string; change(data: Data): void; field: string; reason: string; code?: string }[] = [
    { name: "action data success", change: (data) => { data.success = false; }, field: "success", reason: "unexpected_value" },
    { name: "missing schemas", change: (data) => { data.not_found = ["private-value"]; }, field: "not_found", reason: "missing_definition" },
    { name: "missing list shape", change: (data) => { data.not_found = {}; }, field: "not_found", reason: "expected_array", code: "invalid_response" },
    { name: "definitions shape", change: (data) => { data.tool_schemas = []; }, field: "tool_schemas", reason: "expected_object", code: "invalid_response" },
    { name: "definitions count", change: (data) => { data.tool_schemas = {}; }, field: "tool_schemas", reason: "unexpected_count" },
    { name: "different definition", change: (data) => { data.tool_schemas = { "private-value": definition(data) }; }, field: "tool_schemas", reason: "unexpected_definition" },
    { name: "definition shape", change: (data) => { definitions(data).GMAIL_FETCH_EMAILS = null; }, field: "definition", reason: "expected_object", code: "invalid_response" },
    { name: "different slug", change: (data) => { definition(data).tool_slug = "private-value"; }, field: "definition.tool_slug", reason: "unexpected_value" },
    { name: "different toolkit", change: (data) => { definition(data).toolkit = "private-value"; }, field: "definition.toolkit", reason: "unexpected_value" },
    { name: "partial definition", change: (data) => { definition(data).hasFullSchema = false; }, field: "definition.hasFullSchema", reason: "incomplete" },
    { name: "reference definition", change: (data) => { definition(data).schemaRef = { "private-value": "private-value" }; }, field: "definition.schemaRef", reason: "incomplete" },
    { name: "input shape", change: (data) => { definition(data).input_schema = []; }, field: "input_schema", reason: "expected_object", code: "invalid_response" },
    { name: "input type", change: (data) => { (definition(data).input_schema as Data).type = "private-value"; }, field: "input_schema.type", reason: "unexpected_value", code: "invalid_response" },
    { name: "missing properties", change: (data) => { delete (definition(data).input_schema as Data).properties; }, field: "input_schema.properties", reason: "expected_object", code: "invalid_response" },
    { name: "properties shape", change: (data) => { (definition(data).input_schema as Data).properties = []; }, field: "input_schema.properties", reason: "expected_object", code: "invalid_response" },
    { name: "output shape", change: (data) => { definition(data).output_schema = []; }, field: "output_schema", reason: "expected_object", code: "invalid_response" },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const h = harness(), call = h.port.call;
    h.port.call = async (tool, args, signal) => { const value = await call(tool, args, signal) as { data: Data }; if (tool === SCHEMAS) entry.change(value.data); return value; };
    const inspected = await inspectComposioWatchSchemas(h.port, { kind: "email" }), diagnostic = inspected.privateProof?.responseRejection;
    assert.equal(inspected.code, entry.code ?? "schemas_incomplete"); assert.equal(inspected.available, false);
    assert.equal(diagnostic?.stage, "schemas"); assert.equal(diagnostic?.field, entry.field); assert.equal(diagnostic?.reason, entry.reason);
    assert.deepEqual(diagnostic?.calls, { searchStarted: true, searchReturned: true, schemasStarted: true, schemasReturned: true });
    assert.deepEqual(diagnostic?.inventory, { initialComplete: true, refreshedComplete: true });
    assert.deepEqual(h.calls.map((call) => call.tool), [SEARCH, SCHEMAS]); assert.deepEqual(inspected.privateProof?.candidates, []);
    assert.ok(!JSON.stringify(inspected).includes("private-value")); assert.ok(!JSON.stringify(inspected).includes("private-session-fixture"));
  });
});

test("response diagnostics publish only declarations from a completed inventory and do not infer account semantics", async () => {
  const h = harness(); (h.tools[2] as { inputSchema: unknown }).inputSchema = { type: "object", properties: { tools: { type: "array", items: { type: "object", properties: { connected_account_id: { type: "string" } } } } } };
  const call = h.port.call;
  h.port.call = async (tool, args, signal) => { await call(tool, args, signal); return { successful: true, data: {} }; };
  const inspected = await inspectComposioWatchSchemas(h.port, { kind: "email" });
  assert.equal(inspected.code, "invalid_response"); assert.equal(inspected.available, false);
  assert.deepEqual(inspected.privateProof?.accountDeclarations, { executor: false, executorItem: true, upstream: false });
  assert.deepEqual(inspected.privateProof?.responseRejection?.inventory, { initialComplete: true, refreshedComplete: false });
  assert.deepEqual(inspected.privateProof?.activeConnectionReported, { email: false, calendar: false });
});
