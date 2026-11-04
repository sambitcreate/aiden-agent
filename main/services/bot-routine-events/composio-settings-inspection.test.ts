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
  let hasBoundKey = true;
  let beforeCredentials = async () => {}, beforeConnect = async () => {}, beforeCall = async (_tool: string) => {};
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
            if (method === "tools/list") { pages++; return { tools: paged ? [] : metadata, ...(paged ? { nextCursor: String(pages) } : {}), ...(oversized ? { vendorProse: "x".repeat(256 * 1024) } : {}) } as Result; }
            if (method !== "tools/call") throw new Error("Unexpected synthetic MCP request.");
            const tool = String(params?.name); sent.push(tool); await beforeCall(tool);
            return { content: [], structuredContent: tool === SEARCH ? searchReply() : schemaReply(params?.arguments as Record<string, unknown>) } as Result;
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
    unboundKey: () => { hasBoundKey = false; }, revoke: () => leases.invalidate(server.id), disconnect: () => attempts.disconnect(server.id), credentialsBarrier: (action: () => Promise<void>) => { beforeCredentials = action; }, connectBarrier: (action: () => Promise<void>) => { beforeConnect = action; }, callBarrier: (action: (tool: string) => Promise<void>) => { beforeCall = action; }, oversize: () => { oversized = true; }, paginate: () => { paged = true; }, configBarrier: (action: () => Promise<void>) => { beforeConfig = action; } };
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
  });
  assert.equal((await f.inspect(owner())).code, "account_routing_unverified"); assert.deepEqual(f.sent, [SEARCH, SCHEMAS]); assert.equal(f.closed, 1);
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
