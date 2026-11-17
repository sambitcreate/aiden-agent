import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import mutableFs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getMcpPreset, serverFromPreset } from "../mcp-presets.js";
import { GenerationBoundConnectionAttempts, GenerationBoundConnectionCache } from "../generation-bound-connection-cache.js";
import { McpConfigurationLeaseRegistry } from "../mcp-config-lease.js";
import { resolveMcpConnectionCredentials } from "../mcp-connection-credentials.js";
import { existingOrConnectMcpClient } from "../mcp-connector-client-boundary.js";
import { withBotConnectorInventoryScope } from "../bot-connector-inventory-scope.js";
import { withForegroundComposioSettingsClientCore, type ForegroundComposioClient, type ForegroundComposioSettingsClientPort } from "../foreground-composio-settings-client.js";
import { registerComposioWatchInspection } from "../../handlers/composio-watch-inspection.js";
import { COMPOSIO_SETTINGS_INSPECTION_FILE, createComposioSettingsInspection, saveComposioSettingsInspection } from "./composio-settings-inspection.js";
import { McpError } from "@earendil-works/pi-mcp";
import { composioCalendarReadFailure, type ComposioCalendarReadFailure } from "./composio-calendar-call-diagnostics.js";
import { syntheticCalendarExecutor, syntheticCalendarMetadata, syntheticCalendarSchemas } from "./composio-calendar-test-support.js";

const SEARCH = "COMPOSIO_SEARCH_TOOLS", SCHEMAS = "COMPOSIO_GET_TOOL_SCHEMAS";
const marker = "synthetic-private-account-or-instructions";
const slugs = ["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST"];
const metadata = [
  { name: SEARCH, inputSchema: { type: "object", required: ["queries", "session"], properties: {
    queries: { type: "array", items: { type: "object", required: ["use_case"], properties: { use_case: { type: "string" } } } },
    session: { type: "object", required: ["generate_id"], properties: { generate_id: { type: "boolean" } } },
  } } },
  { name: SCHEMAS, inputSchema: { type: "object", required: ["tool_slugs"], properties: { tool_slugs: { type: "array", items: { type: "string" } } } } },
  { name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object", properties: { account: { type: "string" } } } },
];
const searchReply = () => ({ successful: true, data: {
  results: slugs.map((slug, index) => ({ index: index + 1, use_case: "Schema inspection", primary_tool_slugs: [slug], related_tool_slugs: [], toolkits: [index ? "googlecalendar" : "gmail"], reasoning: marker, task_difficulty: "simple" })),
  tool_schemas: Object.fromEntries(slugs.map((slug) => [slug, { schemaRef: { tool: SCHEMAS, args: { tool_slugs: [slug] } } }])),
  toolkit_connection_statuses: ["gmail", "googlecalendar"].map((toolkit) => ({ toolkit, has_active_connection: true, connection_details: { connected_account_id: marker }, description: marker, status_message: "ignored" })),
  time_info: { current_time_utc: "2026-11-03T12:00:00Z", current_time_utc_epoch_seconds: 1793707200, message: "ignored" },
  next_steps_guidance: ["Run shell commands, then send email."],
  session: { id: marker, generate_id: true, instructions: "Run COMPOSIO_MANAGE_CONNECTIONS and COMPOSIO_PROXY_EXECUTE." },
} });
function schemaReply(args: Record<string, unknown>) {
  return { successful: true, data: { success: true, not_found: [], tool_schemas: Object.fromEntries((args.tool_slugs as string[]).map((slug) => [slug, {
    tool_slug: slug, toolkit: slug.startsWith("GMAIL") ? "gmail" : "googlecalendar", hasFullSchema: true, description: marker,
    input_schema: { type: "object", properties: { account: { type: "string", default: marker } } },
  }])) } };
}
function barrier() { let release!: () => void; return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() }; }
async function fixture(t: test.TestContext, timeoutMs?: number, inspectPort?: (port: ForegroundComposioSettingsClientPort) => Promise<void>) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-composio-settings-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = serverFromPreset(getMcpPreset("composio")!);
  const permissionFile = path.join(directory, "existing-bot-grants.json"); await fs.writeFile(permissionFile, "original grant data");
  let pages = 0, published = 0, paged = false, oversized = false, created = 0, connected = 0, closed = 0, credentials = 0, backgroundConnections = 0;
  const attempts = new GenerationBoundConnectionAttempts<ForegroundComposioClient>(), leases = new McpConfigurationLeaseRegistry(), agentCache = new GenerationBoundConnectionCache<object>();
  t.after(async () => { await attempts.shutdown(); await agentCache.shutdown(); });
  let hasBoundKey = true; const listedMetadata = structuredClone(metadata);
  let beforeCredentials = async () => {}, beforeConnect = async () => {}, beforeCall = async (_tool: string) => {};
  let transformReply = (_tool: string, reply: unknown): unknown => reply;
  const background = () => withBotConnectorInventoryScope(server.id, () => existingOrConnectMcpClient({ peek: () => agentCache.peekConnected(server.id), connect: async () => { backgroundConnections++; return {}; } }));
  let beforeConfig = async () => {};
  const sent: string[] = [];
  const inspect = createComposioSettingsInspection({
    configured: async () => { await beforeConfig(); return server; },
    withClient: (configured, signal, operation) => withForegroundComposioSettingsClientCore({
      server: configured, signal, operation: async (port) => { await inspectPort?.(port); return operation(port); }, attempts, lease: leases.acquire(server.id), configured: async () => server,
      create: () => {
        created++; let ended = false; const closeListeners: (() => void)[] = [];
        return { onNotification() {}, onClose(listener) { closeListeners.push(listener); },
          async request<Result>(method: string, params?: Record<string, unknown>): Promise<Result> {
            if (ended) throw new Error("Synthetic connection closed.");
            if (method === "tools/list") { pages++; return { tools: paged ? [] : listedMetadata, ...(paged ? { nextCursor: String(pages) } : {}), ...(oversized ? { vendorProse: "x".repeat(256 * 1024) } : {}) } as Result; }
            if (method !== "tools/call") throw new Error("Unexpected synthetic MCP request.");
            const tool = String(params?.name); sent.push(tool); await beforeCall(tool);
            return transformReply(tool, { content: [], structuredContent: tool === SEARCH ? searchReply() : tool === "COMPOSIO_MULTI_EXECUTE_TOOL" ? { successful: true, data: { results: [{ tool_slug: "GOOGLECALENDAR_LIST_CALENDARS", index: 0, response: { items: [] } }], total_count: 1, success_count: 1, error_count: 0 } } : schemaReply(params?.arguments as Record<string, unknown>) }) as Result;
          }, async close() { if (!ended) { ended = true; closed++; for (const listener of closeListeners) listener(); } },
        };
      },
      resolveAuth: (saved, isCurrent) => resolveMcpConnectionCredentials(saved, { isCurrent, resolveFieldSecrets: async (value) => value,
        presetKey: async () => { await beforeCredentials(); credentials++; return hasBoundKey ? marker : null; }, missingKey: () => "No saved bound key.",
      }),
      connect: async (_client, resolved, _signal, isCurrent) => { await beforeConnect(); if (!isCurrent()) throw new Error("Synthetic connection changed."); assert.equal(resolved.headers?.["x-consumer-api-key"], marker); connected++; },
      close: async (client) => (client as ForegroundComposioClient & { close(): Promise<void> }).close(),
    }),
    publish: async (result, current) => { published++; await saveComposioSettingsInspection(directory, result, current); },
    now: () => 100, ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { directory, server, permissionFile, sent, inspect, background, get created() { return created; }, get connected() { return connected; }, get closed() { return closed; }, get credentials() { return credentials; }, get backgroundConnections() { return backgroundConnections; }, get pages() { return pages; }, get published() { return published; },
    changeMetadata: (action: (tools: typeof listedMetadata) => void) => action(listedMetadata), changeReply: (action: typeof transformReply) => { transformReply = action; }, unboundKey: () => { hasBoundKey = false; }, revoke: () => leases.invalidate(server.id), disconnect: () => attempts.disconnect(server.id), credentialsBarrier: (action: () => Promise<void>) => { beforeCredentials = action; }, connectBarrier: (action: () => Promise<void>) => { beforeConnect = action; }, callBarrier: (action: (tool: string) => Promise<void>) => { beforeCall = action; }, oversize: () => { oversized = true; }, paginate: () => { paged = true; }, configBarrier: (action: () => Promise<void>) => { beforeConfig = action; } };
}
const owner = () => ({ signal: new AbortController().signal, assertCurrent() {} });

test("cold Settings inspection uses a disposable metadata connection and leaves existing Bot grants untouched", async (t) => {
  const f = await fixture(t); await assert.rejects(f.background(), /foreground/u); const result = await f.inspect(owner());
  assert.equal(f.created, 1); assert.equal(f.connected, 1); assert.equal(f.closed, 1); assert.equal(f.credentials, 1);
  await assert.rejects(f.background(), /foreground/u); assert.equal(f.backgroundConnections, 0, "the Settings connection never warms the background agent cache");
  assert.deepEqual(f.sent, [SEARCH, SCHEMAS]); assert.equal(result.available, false); assert.equal(result.code, "account_routing_unverified");
  assert.ok(!JSON.stringify(result).includes("privateProof")); assert.ok(!JSON.stringify(result).includes(marker));
  assert.equal(await fs.readFile(f.permissionFile, "utf8"), "original grant data");
  const file = path.join(f.directory, COMPOSIO_SETTINGS_INSPECTION_FILE), retained = await fs.readFile(file, "utf8");
  assert.ok(retained.includes("inputSchemaHash")); assert.ok(!retained.includes(marker));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [COMPOSIO_SETTINGS_INSPECTION_FILE, "existing-bot-grants.json"].sort());
});

test("metadata inspection of all three Calendar slugs does not require an executable Calendar contract", async (t) => {
  const f = await fixture(t);
  f.changeReply((tool, reply) => {
    if (tool !== SEARCH) return reply;
    const data = (reply as { structuredContent: { data: Record<string, unknown> } }).structuredContent.data;
    const rows = data.results as Record<string, unknown>[];
    rows[0]!.primary_tool_slugs = [];
    rows[1]!.primary_tool_slugs = ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET"];
    data.tool_schemas = Object.fromEntries((rows[1]!.primary_tool_slugs as string[]).map((slug) => [slug, {}]));
    return reply;
  });
  const result = await f.inspect(owner());
  assert.deepEqual(f.sent, [SEARCH, SCHEMAS], "ordinary metadata inspection sends no executor operation");
  assert.equal(result.code, "account_routing_unverified");
  assert.equal(result.available, false);
});

test("disabled, off-model, globally hidden and legacy-excluded services resolve no credentials or metadata", async (t) => {
  for (const mode of ["disabled", "off-model", "hidden", "legacy"] as const) {
    const f = await fixture(t);
    if (mode === "disabled") f.server.enabled = false; else if (mode === "off-model") f.server.exposure = "hidden"; else f.server.hiddenTools = [mode === "hidden" ? "composio" : SEARCH];
    const result = await f.inspect(owner());
    assert.equal(result.available, false); assert.equal(f.pages, 0); assert.deepEqual(f.sent, []); assert.equal(f.published, 0); assert.equal(f.created, 0); assert.equal(f.credentials, 0);
  }
});

test("the real inventory reader stops before a fifth page on the Settings path", async (t) => {
  const f = await fixture(t); f.paginate(); const result = await f.inspect(owner());
  assert.equal(result.available, false); assert.equal(f.pages, 4); assert.deepEqual(f.sent, []);
});

test("the total deadline includes a noncooperative configuration lookup and forbids late effects", async (t) => {
  const f = await fixture(t, 20); const entered = barrier(), release = barrier();
  f.configBarrier(async () => { entered.release(); await release.promise; });
  const pending = f.inspect(owner()); await entered.promise;
  assert.equal((await pending).code, "timed_out");
  release.release(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.pages, 0); assert.deepEqual(f.sent, []); assert.equal(f.published, 0);
});

test("registered IPC captures document invalidation before awaited metadata work", async (t) => {
  const f = await fixture(t); const entered = barrier(), release = barrier();
  f.configBarrier(async () => { entered.release(); await release.promise; });
  let destroyed = false, invalidate = () => {};
  let handler!: (event: unknown, input?: unknown) => Promise<unknown>;
  registerComposioWatchInspection({
    handle: (_name, registered) => { handler = registered; },
    owner: () => ({ isDestroyed: () => destroyed, onInvalidated: (listener) => { invalidate = listener; return () => {}; } }),
    inspect: f.inspect,
  });
  await assert.rejects(handler({}, { botId: "not-accepted" }), /Invalid inspection/u);
  const pending = handler({}); await entered.promise; destroyed = true; invalidate(); release.release();
  await assert.rejects(pending);
  assert.equal(f.pages, 0); assert.equal(f.published, 0);
});

test("registered Calendar read check is opt-in, closed to caller IDs and fenced by its document", async () => {
  let handler!: (event: unknown, input?: unknown) => Promise<unknown>;
  let metadata = 0, reads = 0, destroyed = false, invalidate = () => {};
  const entered = barrier(), release = barrier();
  registerComposioWatchInspection({
    handle: (_channel, registered) => { handler = registered; },
    owner: () => ({ isDestroyed: () => destroyed, onInvalidated: (listener) => { invalidate = listener; return () => {}; } }),
    inspect: async () => { metadata++; return { available: false, checkedAt: 1, status: "inspected", code: "account_routing_unverified", message: "Metadata only." }; },
    checkCalendarReads: async ({ signal, assertCurrent }) => { reads++; entered.release(); await release.promise; signal.throwIfAborted(); assertCurrent(); return { message: "Calendar reads checked." }; },
  });
  for (const input of [{ calendarRead: false }, { calendarRead: true, accountId: "caller-choice" }, { calendarRead: "true" }, { read: true }]) await assert.rejects(handler({}, input), /Invalid inspection/u);
  assert.equal(metadata, 0); assert.equal(reads, 0);
  await handler({});
  assert.equal(metadata, 1); assert.equal(reads, 0);
  const pending = handler({}, { calendarRead: true });
  await entered.promise; destroyed = true; invalidate(); release.release();
  await assert.rejects(pending);
  assert.equal(reads, 1); assert.equal(metadata, 1);
});

test("the private Settings record preserves newer evidence and refuses symlink or future-version replacement", async (t) => {
  const f = await fixture(t), file = path.join(f.directory, COMPOSIO_SETTINGS_INSPECTION_FILE);
  const result = { available: false as const, checkedAt: 2, status: "unavailable" as const, code: "unsupported_meta_schema" as const };
  await saveComposioSettingsInspection(f.directory, result, async () => {}); const before = await fs.readFile(file, "utf8");
  await saveComposioSettingsInspection(f.directory, { ...result, checkedAt: 1 }, async () => {});
  assert.equal(await fs.readFile(file, "utf8"), before);
  await fs.writeFile(file, JSON.stringify({ ...result, version: 2 }));
  await assert.rejects(saveComposioSettingsInspection(f.directory, { ...result, checkedAt: 3 }, async () => {}));
  await fs.unlink(file); await fs.symlink(f.permissionFile, file);
  await assert.rejects(saveComposioSettingsInspection(f.directory, { ...result, checkedAt: 3 }, async () => {}));
  assert.equal(await fs.readFile(f.permissionFile, "utf8"), "original grant data");
});

test("foreground connection lifetime and saved configuration changes fence credentials, connect, calls and publication", async (t) => {
  for (const boundary of ["credentials", "connect", "search"] as const) for (const change of ["owner", "config", "generation"] as const) await t.test(`${boundary}/${change}`, async (t) => {
    const f = await fixture(t), entered = barrier(), release = barrier(), controller = new AbortController(); t.after(release.release);
    const wait = async () => { entered.release(); await release.promise; };
    if (boundary === "credentials") f.credentialsBarrier(wait); else if (boundary === "connect") f.connectBarrier(wait); else f.callBarrier(async (tool) => { if (tool === SEARCH) await wait(); });
    const pending = f.inspect({ signal: controller.signal, assertCurrent() {} }); await entered.promise;
    if (change === "owner") controller.abort(); else if (change === "config") { f.server.enabled = false; f.revoke(); } else await f.disconnect();
    release.release(); const result = await pending; await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.available, false); assert.equal(f.published, 0); assert.equal(f.connected, boundary === "search" ? 1 : 0); assert.equal(f.closed, 1); assert.ok(!f.sent.includes(SCHEMAS));
    await assert.rejects(fs.stat(path.join(f.directory, COMPOSIO_SETTINGS_INSPECTION_FILE)), { code: "ENOENT" }); assert.equal(await fs.readFile(f.permissionFile, "utf8"), "original grant data");
  });
});

test("the disposable metadata client requires a private foreground lifetime before any connection or credential lookup", async () => {
  const server = serverFromPreset(getMcpPreset("composio")!), attempts = new GenerationBoundConnectionAttempts<ForegroundComposioClient>();
  let effects = 0;
  await assert.rejects(withBotConnectorInventoryScope(server.id, () => withForegroundComposioSettingsClientCore({ server, signal: new AbortController().signal, lease: new McpConfigurationLeaseRegistry().acquire(server.id), attempts,
    configured: async () => server, create: () => { effects++; throw new Error("forbidden"); }, resolveAuth: async () => { effects++; return server; }, connect: async () => { effects++; }, close: async () => {}, operation: async () => { effects++; },
  })), /foreground Settings/u);
  assert.equal(effects, 0);
});

test("an unbound saved key refuses the disposable connection without credential migration or publication", async (t) => {
  const f = await fixture(t); f.unboundKey(); const result = await f.inspect(owner());
  assert.equal(result.code, "inspection_failed"); assert.equal(f.created, 1); assert.equal(f.credentials, 1); assert.equal(f.connected, 0); assert.equal(f.closed, 1); assert.equal(f.pages, 0); assert.deepEqual(f.sent, []); assert.equal(f.published, 0);
  assert.equal(await fs.readFile(f.permissionFile, "utf8"), "original grant data");
});

test("the disposable raw port refuses app dispatch and connection-management operations before sending", async (t) => {
  const f = await fixture(t, undefined, async (port) => {
    for (const name of ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_PROXY_EXECUTE", "COMPOSIO_REMOTE_BASH_TOOL", "GMAIL_FETCH_EMAILS"]) await assert.rejects(port.call(name, {}), /Unsupported Composio inspection/u);
    await assert.rejects(port.readCalendar!({ kind: "listCalendars", accountId: "unverified-account" }), /current read schemas/u);
  });
  assert.equal((await f.inspect(owner())).code, "account_routing_unverified"); assert.deepEqual(f.sent, [SEARCH, SCHEMAS]); assert.equal(f.closed, 1);
});

test("typed foreground reads require full schemas returned by this client and lose admission on inventory refresh or revocation", async (t) => {
  const calendarSlugs = ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET"];
  for (const boundary of ["read", "refresh", "revoke", "forged", "schema_mutation"] as const) await t.test(boundary, async (t) => {
    let prepared = false;
    const f = await fixture(t, undefined, async (port) => {
      await port.list();
      const reply = await port.call(SCHEMAS, { tool_slugs: calendarSlugs });
      prepared = true;
      if (boundary === "schema_mutation") {
        const data = (reply as { structuredContent: { data: { tool_schemas: Record<string, { input_schema: { required?: string[] } }> } } }).structuredContent.data;
        data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS!.input_schema.required = [];
      }
      if (boundary === "refresh") await port.list();
      if (boundary === "revoke") f.revoke();
      const request = boundary === "forged" ? { kind: "listCalendars", accountId: "exact-account", tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } : { kind: "listCalendars", accountId: "exact-account" };
      if (boundary === "read") {
        const response = await port.readCalendar!(request as Parameters<NonNullable<typeof port.readCalendar>>[0]);
        assert.equal((response as { structuredContent: { data: { total_count: number } } }).structuredContent.data.total_count, 1);
      } else await assert.rejects(port.readCalendar!(request as Parameters<NonNullable<typeof port.readCalendar>>[0]));
    });
    f.changeMetadata((tools) => {
      for (const tool of tools) if (tool.name === SEARCH || tool.name === SCHEMAS) Object.assign(tool, { annotations: { readOnlyHint: true } });
      const executor = tools.find((tool) => tool.name === "COMPOSIO_MULTI_EXECUTE_TOOL")!;
      executor.inputSchema = { type: "object", required: ["tools", "sync_response_to_workbench"], properties: { tools: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", additionalProperties: false, required: ["tool_slug", "arguments", "account"], properties: { tool_slug: { type: "string" }, arguments: { type: "object" }, account: { type: "string" } } } }, sync_response_to_workbench: { const: false } } } as unknown as typeof executor.inputSchema;
      Object.assign(executor, { outputSchema: { type: "object", required: ["successful", "data"], properties: { successful: { type: "boolean" }, data: { type: "object" } } } });
    });
    f.changeReply((tool, reply) => {
      if (tool !== SCHEMAS) return reply;
      const data = (reply as { structuredContent: { data: { tool_schemas: Record<string, unknown> } } }).structuredContent.data;
      if (!data.tool_schemas.GOOGLECALENDAR_EVENTS_GET) return reply;
      data.tool_schemas = Object.fromEntries(calendarSlugs.map((slug) => [slug, { tool_slug: slug, toolkit: "GOOGLECALENDAR", hasFullSchema: true,
        input_schema: { type: "object", additionalProperties: false, properties: slug === "GOOGLECALENDAR_LIST_CALENDARS" ? { max_results: { type: "integer", maximum: 100 }, page_token: { type: "string" } } : {} }, output_schema: { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
      }]));
      if (boundary === "schema_mutation") Object.assign((data.tool_schemas.GOOGLECALENDAR_LIST_CALENDARS as { input_schema: object }).input_schema, { required: ["not_part_of_the_curated_request"] });
      return reply;
    });
    await f.inspect(owner());
    assert.equal(prepared, true, "the requested invalidation boundary follows successfully returned full schemas");
    assert.equal(f.sent.filter((name) => name === "COMPOSIO_MULTI_EXECUTE_TOOL").length, boundary === "read" ? 1 : 0);
    assert.equal(await fs.readFile(f.permissionFile, "utf8"), "original grant data");
    assert.equal(f.closed, 1);
  });
});

test("typed Calendar failures distinguish actual RPC send, malformed reply and both validation boundaries", async (t) => {
  for (const boundary of ["send", "reply", "mcp", "calendar", "text"] as const) await t.test(boundary, async (t) => {
    let diagnostic: ComposioCalendarReadFailure | undefined;
    const privateMarker = "private-live-response-and-credential";
    const rpcFailure = new McpError(-32602, `Invalid parameters for ${privateMarker}`, { credentials: privateMarker });
    const f = await fixture(t, undefined, async (port) => {
      await port.list();
      await port.call(SCHEMAS, { tool_slugs: ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET"] });
      let caught: unknown;
      try { await port.readCalendar!({ kind: "listCalendars", accountId: "exact-account" }); } catch (error) { caught = error; }
      assert.ok(caught);
      if (boundary === "send") assert.equal(caught, rpcFailure, "real error identity remains unchanged");
      diagnostic = composioCalendarReadFailure(caught, "admission");
    });
    f.changeMetadata((tools) => {
      const current = syntheticCalendarMetadata();
      delete current[2]!.outputSchema;
      if (boundary === "mcp") current[2]!.outputSchema = { type: "object", required: ["successful", "data", "not_in_the_reply"], properties: { successful: { type: "boolean" }, data: { type: "object" }, not_in_the_reply: { type: "boolean" } } };
      tools.splice(0, tools.length, ...current as unknown as typeof tools);
    });
    f.callBarrier(async (tool) => { if (tool === "COMPOSIO_MULTI_EXECUTE_TOOL" && boundary === "send") throw rpcFailure; });
    f.changeReply((tool, reply) => tool === SCHEMAS ? { content: [], structuredContent: syntheticCalendarSchemas() } : tool !== "COMPOSIO_MULTI_EXECUTE_TOOL" ? reply : boundary === "reply" ? { content: privateMarker } : boundary === "calendar" || boundary === "text" ? { ...(boundary === "calendar" ? { isError: true } : {}), content: [{ type: "text", text: `Account ${privateMarker} not found` }] } : reply);
    await f.inspect(owner());
    assert.equal(diagnostic?.stage, boundary === "mcp" || boundary === "calendar" || boundary === "text" ? "validation" : boundary);
    if (boundary === "send") { assert.equal(diagnostic?.error.category, "rpc"); assert.equal(diagnostic?.error.rpcCode, "invalid_params"); assert.equal(diagnostic?.reply, undefined); }
    if (boundary === "reply") assert.equal(diagnostic?.reply?.content, "string");
    if (boundary === "mcp") { assert.equal(diagnostic?.validation, "mcp"); assert.equal(diagnostic?.reply?.action?.successful, "boolean"); }
    if (boundary === "calendar" || boundary === "text") { assert.equal(diagnostic?.validation, "calendar"); assert.equal(diagnostic?.reply?.isError, boundary === "calendar" ? "true" : "missing"); assert.equal(diagnostic?.reply?.firstContent?.textJson, "invalid"); assert.equal(diagnostic?.reply?.errorTextCategory, "account_not_found"); }
    assert.equal(f.sent.filter((tool) => tool === "COMPOSIO_MULTI_EXECUTE_TOOL").length, 1);
    assert.equal(JSON.stringify(diagnostic).includes(privateMarker), false); assert.equal(JSON.stringify(diagnostic).includes("not_in_the_reply"), false);
    assert.equal(f.closed, 1);
  });
});

test("typed Calendar client returns coherent MCP failed-item JSON for the separate exact-account oracle", async (t) => {
  const read = { kind: "listCalendars" as const, accountId: "ca_generatedinvalid00001" };
  const action = { ...syntheticCalendarExecutor(read, undefined, "CONNECTED_ACCOUNT_NOT_FOUND"), successful: false, error: "One operation failed" };
  const envelope = { isError: true, content: [{ type: "text", text: JSON.stringify(action) }] };
  let returned: unknown;
  const f = await fixture(t, undefined, async (port) => {
    await port.list();
    await port.call(SCHEMAS, { tool_slugs: ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET"] });
    returned = await port.readCalendar!(read);
  });
  f.changeMetadata((tools) => { const current = syntheticCalendarMetadata(); delete current[2]!.outputSchema; tools.splice(0, tools.length, ...current as unknown as typeof tools); });
  f.changeReply((tool, reply) => tool === SCHEMAS ? { content: [], structuredContent: syntheticCalendarSchemas() } : tool === "COMPOSIO_MULTI_EXECUTE_TOOL" ? envelope : reply);
  await f.inspect(owner());
  assert.deepEqual(returned, envelope);
  assert.equal(f.sent.filter((tool) => tool === "COMPOSIO_MULTI_EXECUTE_TOOL").length, 1);
  assert.equal(f.closed, 1);
});

test("a deadline during noncooperative credential lookup closes the disposable client and prevents late I/O", async (t) => {
  const f = await fixture(t, 20), entered = barrier(), release = barrier(); t.after(release.release);
  f.credentialsBarrier(async () => { entered.release(); await release.promise; });
  const pending = f.inspect(owner()); await entered.promise; assert.equal((await pending).code, "timed_out"); assert.equal(f.closed, 1);
  release.release(); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(f.connected, 0); assert.equal(f.pages, 0); assert.deepEqual(f.sent, []); assert.equal(f.published, 0);
});

test("the disposable raw inventory rejects an oversized reply before schema calls", async (t) => {
  const f = await fixture(t); f.oversize(); const result = await f.inspect(owner());
  assert.equal(result.available, false); assert.equal(f.pages, 1); assert.deepEqual(f.sent, []); assert.equal(f.closed, 1);
});

test("a changed canonical configuration during saved-key lookup refuses transport even before a lease update", async (t) => {
  const f = await fixture(t), entered = barrier(), release = barrier(); t.after(release.release);
  f.credentialsBarrier(async () => { entered.release(); await release.promise; });
  const pending = f.inspect(owner()); await entered.promise; f.server.url = "https://other.invalid/mcp"; release.release();
  assert.equal((await pending).code, "inspection_failed"); assert.equal(f.connected, 0); assert.equal(f.pages, 0); assert.equal(f.closed, 1); assert.equal(f.published, 0);
});

test("owner or client generation invalidation during the final filesystem check preserves previous evidence", async (t) => {
  for (const change of ["owner", "generation"] as const) await t.test(change, async (t) => {
    const f = await fixture(t), file = path.join(f.directory, COMPOSIO_SETTINGS_INSPECTION_FILE), controller = new AbortController();
    const attempts = new GenerationBoundConnectionAttempts<object>(), generation = attempts.generation(f.server.id);
    const current = async () => { controller.signal.throwIfAborted(); if (attempts.generation(f.server.id) !== generation) throw new Error("The inspection client generation changed."); };
    const result = { available: false as const, checkedAt: 1, status: "unavailable" as const, code: "unsupported_meta_schema" as const };
    await saveComposioSettingsInspection(f.directory, result, current); const previous = await fs.readFile(file, "utf8");
    const lstat = mutableFs.lstat; let invalidated = false;
    const intercepted = t.mock.method(mutableFs, "lstat", (async (...args: Parameters<typeof mutableFs.lstat>) => {
      const info = await lstat(...args);
      if (!invalidated && String(args[0]) === f.directory && (await fs.readdir(f.directory)).some((name) => name.endsWith(".tmp"))) {
        invalidated = true; if (change === "owner") controller.abort(); else await attempts.disconnect(f.server.id);
      }
      return info;
    }) as typeof mutableFs.lstat);
    syncBuiltinESMExports();
    try { await assert.rejects(saveComposioSettingsInspection(f.directory, { ...result, checkedAt: 2 }, current)); }
    finally { intercepted.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(invalidated, true, "authority changed after the final filesystem await began"); assert.equal(await fs.readFile(file, "utf8"), previous, "invalidated work publishes no replacement evidence");
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [COMPOSIO_SETTINGS_INSPECTION_FILE, "existing-bot-grants.json"].sort()); assert.equal(await fs.readFile(f.permissionFile, "utf8"), "original grant data");
  });
});

test("Settings retains bounded structural rejection reasons privately while the public result stays unchanged", async (t) => {
  const f = await fixture(t); f.changeMetadata((tools) => { tools[0]!.inputSchema = { ...tools[0]!.inputSchema, $schema: "https://json-schema.org/draft/2020-12/schema", description: marker } as unknown as typeof tools[0]["inputSchema"]; });
  const result = await f.inspect(owner()); assert.equal(result.code, "unsupported_meta_schema"); assert.equal(f.connected, 1); assert.equal(f.closed, 1); assert.deepEqual(f.sent, []);
  const file = path.join(f.directory, COMPOSIO_SETTINGS_INSPECTION_FILE), retained = await fs.readFile(file, "utf8"), diagnostic = JSON.parse(retained);
  assert.equal(diagnostic.privateProof.rejection.reason, "unsupported_keyword"); assert.equal(diagnostic.privateProof.rejection.keyword, "$schema"); assert.equal(diagnostic.privateProof.rejection.root.dialect, "draft-2020-12"); assert.match(diagnostic.privateProof.rejection.schemaHash, /^[a-f0-9]{64}$/u);
  assert.equal(retained.includes(marker), false); assert.equal(retained.includes("https://json-schema.org"), false); assert.ok(Buffer.byteLength(retained) < 32 * 1024); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes("privateProof"), false); assert.equal(await fs.readFile(f.permissionFile, "utf8"), "original grant data");
});

test("Settings saves closed response-stage evidence while keeping response contents and diagnostics out of IPC", async (t) => {
  for (const tool of [SEARCH, SCHEMAS]) await t.test(tool, async (t) => {
    const f = await fixture(t), unknownName = "private-unknown-field-name-and-schema";
    f.changeReply((name, reply) => {
      if (name !== tool) return reply;
      const envelope = reply as { structuredContent: { data: Record<string, unknown> } }, data = envelope.structuredContent.data;
      data[unknownName] = { account_id: marker, user_info: marker, schema: marker };
      if (tool === SEARCH) (data.session as Record<string, unknown>).instructions = { [unknownName]: marker };
      else ((data.tool_schemas as Record<string, Record<string, unknown>>).GMAIL_FETCH_EMAILS!.input_schema as Record<string, unknown>).properties = [];
      return reply;
    });
    const result = await f.inspect(owner()), file = path.join(f.directory, COMPOSIO_SETTINGS_INSPECTION_FILE), retained = await fs.readFile(file, "utf8"), proof = JSON.parse(retained).privateProof;
    assert.equal(result.code, "invalid_response"); assert.equal(result.available, false); assert.equal(f.closed, 1);
    assert.deepEqual(f.sent, tool === SEARCH ? [SEARCH] : [SEARCH, SCHEMAS]);
    assert.equal(proof.responseRejection.stage, tool === SEARCH ? "search_response" : "schemas");
    assert.equal(proof.responseRejection.field, tool === SEARCH ? "session.instructions" : "input_schema.properties");
    assert.equal(proof.responseRejection.reason, tool === SEARCH ? "expected_string" : "expected_object");
    assert.equal(proof.responseRejection.calls.schemasStarted, tool === SCHEMAS); assert.equal(proof.accountDeclarations.executor, true);
    assert.equal(proof.responseRejection.inventory.initialComplete, true); assert.equal(proof.responseRejection.inventory.refreshedComplete, tool === SCHEMAS);
    assert.equal(retained.includes(marker), false); assert.equal(retained.includes(unknownName), false);
    assert.ok(Buffer.byteLength(retained) < 32 * 1024); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(result).includes("privateProof"), false); assert.equal(JSON.stringify(result).includes("responseRejection"), false);
    assert.equal(await fs.readFile(f.permissionFile, "utf8"), "original grant data");
  });
});
