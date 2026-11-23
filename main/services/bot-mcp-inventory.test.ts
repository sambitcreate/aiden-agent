import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  botMcpCredentialSignatureCore,
  createBotMcpCredentialSignatureCore,
} from "./bot-capability-credential-signatures-core.js";
import { createBotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";
import {
  createBotMcpScopeCache,
  resolveBotMcpConnectionIdentities,
  resolveBotMcpInventory,
  type BotMcpInspectionFailureReport,
} from "./bot-mcp-inventory.js";
import {
  McpOAuthCredentialStorageError,
  createMcpOAuthSessionCache,
} from "./mcp-oauth-session-cache.js";
import {
  mcpAuthorizationBinding,
  sessionForMcpAuthorizationAttempt,
  sessionWithSavedMcpTokens,
  type McpOAuthSession,
} from "./mcp-oauth-session.js";
import type { McpServer } from "./types.js";
import { admitWithBotConnectorInventoryScope, botConnectorInventoryServer, withBotConnectorInventoryScope } from "./bot-connector-inventory-scope.js";
import type { BotRuntimeEffectiveAuthority } from "./bot-runtime-authority.js";
import { getMcpPreset, serverFromPreset } from "./mcp-presets.js";
import type { SubagentMcpRemoteTool } from "./subagents/subagent-mcp-read.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("Composio catalogs one stable service across vendor inventory edits while credential changes revoke it", async () => {
  const server = serverFromPreset(getMcpPreset("composio")!);
  let signature = hash("credential-one");
  let remote: SubagentMcpRemoteTool[] = [{ name: "COMPOSIO_SEARCH_TOOLS", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
  const snapshot = () => resolveBotMcpInventory(new AbortController().signal, {
    listServers: async () => [server], credentialSignature: async () => signature, inspectTools: async () => remote,
    incarnations: { reconcileNamespace: async (_namespace, resources) => resources.map(({ sourceId, credentialSignature }) => ({ sourceId, resourceIncarnation: "a".repeat(43), credentialIncarnation: credentialSignature.slice(0, 43) })) },
  });
  const before = (await snapshot())[0];
  assert.equal(before.tools.length, 1); assert.equal(before.tools[0].toolName, "composio");
  remote = [{ name: "COMPOSIO_SEARCH_TOOLS", inputSchema: { type: "object", properties: { newArgument: { type: "string" } } }, annotations: { readOnlyHint: true } }, { name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }];
  const changedVendor = (await snapshot())[0];
  assert.equal(changedVendor.connectionFingerprint, before.connectionFingerprint);
  assert.deepEqual(changedVendor.tools, before.tools);
  signature = hash("credential-two");
  assert.notEqual((await snapshot())[0].connectionFingerprint, before.connectionFingerprint);
  server.hiddenTools = ["COMPOSIO_MULTI_EXECUTE_TOOL"];
  assert.equal((await snapshot()).length, 0, "legacy partial exclusions need the person's single service allowance");
});

function connectorScopeFixture() {
  const servers: McpServer[] = ["selected-imcp", "other-connector"].map((id) => ({ id, name: id, transport: "stdio", command: "synthetic-only", enabled: true }));
  const inspectCalls: { id: string; selected: string | undefined }[] = [];
  let now = 0;
  const dependencies = { listServers: async () => servers, credentialSignature: async () => hash("synthetic-credential"),
    scopeCache: createBotMcpScopeCache({ now: () => now }), incarnations: {
      reconcileNamespace: async (_namespace: string, resources: readonly { sourceId: string }[]) => resources.map(({ sourceId }) => ({ sourceId, resourceIncarnation: "a".repeat(43), credentialIncarnation: "b".repeat(43) })),
    }, inspectTools: async (server: McpServer) => {
      inspectCalls.push({ id: server.id, selected: botConnectorInventoryServer() });
      return [{ name: "read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }];
    } };
  return { dependencies, inspectCalls, advance: () => { now += 60_001; }, snapshot: () => resolveBotMcpInventory(new AbortController().signal, dependencies) };
}

test("returned watch authority revalidation keeps the selected scope on real inventory cache misses", async () => {
  const f = connectorScopeFixture(); let released = 0;
  const admission = await admitWithBotConnectorInventoryScope("selected-imcp", async () => {
    assert.deepEqual((await f.snapshot()).map((scope) => scope.serverId), ["selected-imcp"]);
    return { authority: {} as BotRuntimeEffectiveAuthority, signal: new AbortController().signal,
      revalidateBeforeEffect: async () => { assert.deepEqual((await f.snapshot()).map((scope) => scope.serverId), ["selected-imcp"]); }, release: () => { released++; } };
  });
  assert.equal(botConnectorInventoryServer(), undefined, "the caller has left the initial admission scope");
  f.advance(); const revalidate = admission.revalidateBeforeEffect;
  await revalidate();
  assert.deepEqual(f.inspectCalls.map((call) => call.id), ["selected-imcp", "selected-imcp"], "neither admission nor later cache-miss revalidation inspects the second connector");
  assert.ok(f.inspectCalls.every((call) => call.selected === "selected-imcp"));
  admission.release(); assert.equal(released, 1);
  const foreground = await f.snapshot();
  assert.deepEqual(foreground.map((scope) => scope.serverId), ["other-connector", "selected-imcp"], "ordinary foreground inventory remains available outside watch work");
});

test("watch inventory does not join an unscoped in-flight inspection or start another connector", async (t) => {
  const f = connectorScopeFixture();
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; }); t.after(() => release());
  let bothStarted!: () => void; const started = new Promise<void>((resolve) => { bothStarted = resolve; }); let foregroundCalls = 0;
  f.dependencies.inspectTools = async (server) => {
    const selected = botConnectorInventoryServer(); f.inspectCalls.push({ id: server.id, selected });
    if (!selected) { foregroundCalls++; if (foregroundCalls === 2) bothStarted(); await blocked; }
    return [{ name: selected ? "existing_live_read" : "foreground_read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }];
  };
  const foreground = f.snapshot();
  await started;
  const watch = await withBotConnectorInventoryScope("selected-imcp", f.snapshot);
  assert.deepEqual(watch.map((scope) => ({ id: scope.serverId, tools: scope.tools.map((tool) => tool.toolName) })), [{ id: "selected-imcp", tools: ["existing_live_read"] }], "the watch uses its own existing-session inspection while foreground work is blocked");
  assert.deepEqual(f.inspectCalls.filter((call) => call.selected).map((call) => call.id), ["selected-imcp"]);
  release(); await foreground;
  await assert.rejects(withBotConnectorInventoryScope("selected-imcp", () => withBotConnectorInventoryScope("other-connector", f.snapshot)), /cannot switch/u);
});

test("Bot MCP inventory includes stdio and exceeds subagent 16x32 bounds within Bot limits", async () => {
  const servers: McpServer[] = Array.from({ length: 17 }, (_unused, index) => ({
    id: `server-${String(index).padStart(2, "0")}`,
    name: `Server ${index}`,
    transport: index === 0 ? "stdio" : "http",
    ...(index === 0 ? { command: "mcp-safe" } : { url: `https://mcp-${index}.invalid` }),
    enabled: true,
  }));
  const scopes = await resolveBotMcpInventory(new AbortController().signal, {
    listServers: async () => servers,
    credentialSignature: async (server) => hash(`credential:${server.id}`),
    inspectTools: async (_server) =>
      Array.from({ length: 33 }, (_tool, index) => ({
        name: `tool_${index}`,
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
        annotations: { readOnlyHint: true },
      })),
    incarnations: {
      reconcileNamespace: async (_namespace, resources) =>
        resources.map(({ sourceId }) => ({
          sourceId,
          resourceIncarnation: "a".repeat(43),
          credentialIncarnation: "b".repeat(43),
        })),
    },
  });
  assert.equal(scopes.length, 17);
  assert.equal(scopes[0]?.serverId, "server-00");
  assert.equal(scopes[0]?.tools.length, 33);
});

test("Bot MCP connection identity is stable across inspection and changes with incarnation", async () => {
  const server: McpServer = {
    id: "stable",
    name: "Stable",
    transport: "stdio",
    command: "mcp-safe",
    enabled: true,
  };
  let credentialIncarnation = "b".repeat(43);
  const dependencies = {
    listServers: async () => [server],
    credentialSignature: async () => hash("credential"),
    inspectTools: async () => [
      { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ],
    incarnations: {
      reconcileNamespace: async () => [{
        sourceId: server.id,
        resourceIncarnation: "a".repeat(43),
        credentialIncarnation,
      }],
    },
  };
  const first = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  const second = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.equal(second[0]?.connectionFingerprint, first[0]?.connectionFingerprint);
  credentialIncarnation = "c".repeat(43);
  const rotated = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.notEqual(rotated[0]?.connectionFingerprint, first[0]?.connectionFingerprint);
});

test("Bot MCP discovery returns at its deadline even if an inspector ignores cancellation", async () => {
  const started = Date.now();
  const scopes = await resolveBotMcpInventory(new AbortController().signal, {
    listServers: async () => [{
      id: "hung",
      name: "Hung",
      transport: "stdio",
      command: "mcp-hung",
      enabled: true,
    }],
    credentialSignature: async () => hash("credential"),
    inspectTools: async () => new Promise<never>(() => undefined),
    incarnations: {
      reconcileNamespace: async (_namespace, resources) => resources.map(({ sourceId }) => ({
        sourceId,
        resourceIncarnation: "a".repeat(43),
        credentialIncarnation: "b".repeat(43),
      })),
    },
    deadlineMs: 20,
  });
  assert.deepEqual(scopes, []);
  assert(Date.now() - started < 500);
});

test("an OAuth token refresh during discovery keeps a Bot's MCP connection; re-authorization changes it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-mcp-oauth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let minted = 0;
  const protectedStore = createBotCapabilityStore({
    root: () => root,
    mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
    mintIncarnation: () => Buffer.alloc(32, ++minted).toString("base64url"),
  });
  await protectedStore.initialize();
  const server: McpServer = {
    id: "notion",
    name: "Notion",
    transport: "http",
    url: "https://mcp.notion.invalid/mcp",
    oauth: true,
    enabled: true,
  };
  const binding = mcpAuthorizationBinding(server.url!);
  let session: McpOAuthSession = sessionWithSavedMcpTokens(
    sessionForMcpAuthorizationAttempt({}, binding),
    binding,
    { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 },
  );
  const key = Buffer.alloc(32, 3);
  let refreshOnInspect = false;
  const dependencies = {
    listServers: async () => [server],
    credentialSignature: async (current: McpServer) =>
      botMcpCredentialSignatureCore(key, { server: current, presetKey: null, oauthSession: session }),
    // Opening a fresh client with an expired access token makes the SDK
    // refresh and save rotated tokens in the middle of the Bot snapshot.
    inspectTools: async () => {
      if (refreshOnInspect) {
        session = sessionWithSavedMcpTokens(session, binding, {
          access_token: `access-${minted}`,
          token_type: "Bearer",
          refresh_token: `refresh-${minted}`,
          expires_in: 3600,
        });
      }
      return [{ name: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
    },
    incarnations: createBotCapabilityIncarnationStore(protectedStore),
  };

  const first = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  refreshOnInspect = true;
  await resolveBotMcpInventory(new AbortController().signal, dependencies);
  const afterRefresh = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.equal(afterRefresh[0]?.connectionFingerprint, first[0]?.connectionFingerprint);

  refreshOnInspect = false;
  session = sessionWithSavedMcpTokens(
    sessionForMcpAuthorizationAttempt(session, binding),
    binding,
    { access_token: "other-account", token_type: "Bearer", refresh_token: "other-refresh" },
  );
  const reauthorized = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.notEqual(reauthorized[0]?.connectionFingerprint, first[0]?.connectionFingerprint);

  session = {};
  const signedOut = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.notEqual(signedOut[0]?.connectionFingerprint, reauthorized[0]?.connectionFingerprint);
});

const fixedIncarnations = {
  reconcileNamespace: async (
    _namespace: string,
    resources: readonly { sourceId: string; credentialSignature: string }[],
  ) =>
    resources.map(({ sourceId, credentialSignature }) => ({
      sourceId,
      resourceIncarnation: "a".repeat(43),
      // A credential change is a new incarnation, as in the durable store.
      credentialIncarnation: hash(credentialSignature).slice(0, 43),
    })),
};

const readTool = (name: string) => ({
  name,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
});

function stdioServer(id: string, overrides: Partial<McpServer> = {}): McpServer {
  return { id, name: id, transport: "stdio", command: `mcp-${id}`, enabled: true, ...overrides };
}

test("repeated Bot snapshots inspect each MCP server once within the TTL and again after a change", async () => {
  let clock = 1_000;
  let generation = 1;
  const cache = createBotMcpScopeCache({ now: () => clock, generation: () => generation });
  let servers = [stdioServer("alpha"), stdioServer("beta")];
  const inspections = new Map<string, number>();
  const dependencies = {
    listServers: async () => servers,
    credentialSignature: async (server: McpServer) => hash(`credential:${server.id}:${server.env?.TOKEN ?? ""}`),
    inspectTools: async (server: McpServer) => {
      inspections.set(server.id, (inspections.get(server.id) ?? 0) + 1);
      return [readTool(`${server.id}_read`)];
    },
    incarnations: fixedIncarnations,
    scopeCache: cache,
  };
  const snapshot = () => resolveBotMcpInventory(new AbortController().signal, dependencies);

  // Admission plus several revalidations, some concurrent, share one inspection.
  const first = await snapshot();
  await Promise.all([snapshot(), snapshot(), snapshot()]);
  const later = await snapshot();
  assert.deepEqual(Object.fromEntries(inspections), { alpha: 1, beta: 1 });
  assert.deepEqual(later, first);

  // Renaming is not an authority change: the grant fingerprint and cache survive.
  servers = [stdioServer("alpha", { name: "Alpha (work)", description: "Renamed" }), stdioServer("beta")];
  assert.deepEqual(await snapshot(), first);
  assert.deepEqual(Object.fromEntries(inspections), { alpha: 1, beta: 1 });

  // A credential change misses the cache for that server only, and the
  // revalidation sees a different connection fingerprint.
  servers = [stdioServer("alpha", { env: { TOKEN: "rotated" } }), stdioServer("beta")];
  const rotated = await snapshot();
  assert.deepEqual(Object.fromEntries(inspections), { alpha: 2, beta: 1 });
  assert.notEqual(rotated[0]?.connectionFingerprint, first[0]?.connectionFingerprint);
  assert.equal(rotated[1]?.connectionFingerprint, first[1]?.connectionFingerprint);

  // A configuration fence forces fresh inspections even for unchanged servers.
  generation += 1;
  await snapshot();
  assert.deepEqual(Object.fromEntries(inspections), { alpha: 3, beta: 2 });

  // The TTL bounds reuse.
  clock += 60_000;
  await snapshot();
  assert.deepEqual(Object.fromEntries(inspections), { alpha: 4, beta: 3 });
});

/** Lets background inspections (each bounded by a 20 ms deadline) finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

const reportRows = (reports: readonly BotMcpInspectionFailureReport[]) =>
  reports.map(({ server, kind, keptLastGood }) => [server.id, kind, keptLastGood]).sort();

test("a slow or failing MCP server drops only its own Bot scope and keeps its last good scope briefly", async () => {
  let clock = 1_000;
  const backgroundReports: BotMcpInspectionFailureReport[] = [];
  const cache = createBotMcpScopeCache({
    now: () => clock,
    ttlMs: 1,
    graceMs: 120_000,
    // A hung inspection is shared by later callers only until its own deadline.
    inspectionDeadlineMs: 20,
    reportFailure: (report) => backgroundReports.push(report),
  });
  let servers = [stdioServer("fast"), stdioServer("slow"), stdioServer("broken")];
  let hangSlow = false;
  let breakBroken = false;
  const reports: BotMcpInspectionFailureReport[] = [];
  const dependencies = {
    listServers: async () => servers,
    credentialSignature: async (server: McpServer) => hash(`credential:${server.id}:${server.url ?? ""}`),
    inspectTools: async (server: McpServer) => {
      if (server.id === "slow" && hangSlow) return new Promise<never>(() => undefined);
      if (server.id === "broken" && breakBroken) throw new Error("connect ECONNREFUSED");
      return [readTool(`${server.id}_read`)];
    },
    incarnations: fixedIncarnations,
    scopeCache: cache,
    reportFailure: (report: BotMcpInspectionFailureReport) => reports.push(report),
    deadlineMs: 30,
  };
  const snapshot = () => resolveBotMcpInventory(new AbortController().signal, dependencies);
  const ids = (scopes: Awaited<ReturnType<typeof snapshot>>) => scopes.map(({ serverId }) => serverId);

  const healthy = await snapshot();
  assert.deepEqual(ids(healthy), ["broken", "fast", "slow"]);

  // Transient trouble past the TTL: every server keeps its last verified scope
  // while it is refreshed behind the turn, so the catalog revision does not flap
  // and the turn never waits on the hung server.
  clock += 10;
  hangSlow = true;
  breakBroken = true;
  assert.deepEqual(await snapshot(), healthy);
  assert.deepEqual(reports, [], "no turn waited on a failing refresh");
  await settle();
  assert.deepEqual(reportRows(backgroundReports), [["broken", "failed", true], ["slow", "timed_out", true]]);

  // Past the grace window only the server that answered remains.
  clock += 120_000;
  assert.deepEqual(ids(await snapshot()), ["fast"]);
  await settle();

  // A configuration change never inherits the old connection's scope.
  hangSlow = false;
  breakBroken = false;
  cache.clear();
  await snapshot();
  clock += 10;
  servers = [stdioServer("fast"), stdioServer("slow", { command: "mcp-other" }), stdioServer("broken")];
  hangSlow = true;
  reports.length = 0;
  assert.deepEqual(ids(await snapshot()), ["broken", "fast"]);
  assert.deepEqual(reportRows(reports), [["slow", "timed_out", false]], "a new connection is inspected while the turn waits");
  // Nor does a disabled one.
  hangSlow = false;
  servers = [stdioServer("fast"), stdioServer("slow"), stdioServer("broken", { enabled: false })];
  assert.deepEqual(ids(await snapshot()), ["fast", "slow"]);
});

test("an unreachable MCP server delays one Bot snapshot, then is skipped and retried in the background", async () => {
  let clock = 1_000;
  let generation = 1;
  const backgroundReports: BotMcpInspectionFailureReport[] = [];
  const cache = createBotMcpScopeCache({
    now: () => clock,
    generation: () => generation,
    inspectionDeadlineMs: 20,
    failureBackoffMs: 1_000,
    failureBackoffMaxMs: 4_000,
    reportFailure: (report) => backgroundReports.push(report),
  });
  let servers = [stdioServer("up"), stdioServer("down")];
  let unreachable = true;
  let downInspections = 0;
  const reports: BotMcpInspectionFailureReport[] = [];
  const snapshot = () => resolveBotMcpInventory(new AbortController().signal, {
    listServers: async () => servers,
    credentialSignature: async (server: McpServer) => hash(`credential:${server.id}`),
    inspectTools: async (server: McpServer) => {
      if (server.id !== "down") return [readTool("up_read")];
      downInspections++;
      // Like a stdio server whose host app is not running: it never answers.
      if (unreachable) return new Promise<never>(() => undefined);
      return [readTool("down_read")];
    },
    incarnations: fixedIncarnations,
    scopeCache: cache,
    reportFailure: (report: BotMcpInspectionFailureReport) => reports.push(report),
    deadlineMs: 30,
  });
  const ids = (scopes: Awaited<ReturnType<typeof snapshot>>) => scopes.map(({ serverId }) => serverId);

  // The first snapshot waits for the server and reports it once.
  assert.deepEqual(ids(await snapshot()), ["up"]);
  assert.deepEqual(reportRows(reports), [["down", "timed_out", false]]);
  assert.equal(downInspections, 1);

  // Within the backoff, Bot turns neither wait for it nor report it again.
  for (let index = 0; index < 5; index++) assert.deepEqual(ids(await snapshot()), ["up"]);
  await settle();
  assert.equal(downInspections, 1);
  assert.equal(reports.length, 1);
  assert.deepEqual(backgroundReports, []);

  // When the backoff ends, a retry starts behind the turn and its failure is
  // reported once; the next wait is twice as long.
  clock += 1_000;
  assert.deepEqual(ids(await snapshot()), ["up"]);
  await settle();
  assert.equal(downInspections, 2);
  assert.deepEqual(reportRows(backgroundReports), [["down", "timed_out", false]]);
  clock += 1_000;
  await snapshot();
  await settle();
  assert.equal(downInspections, 2, "the second backoff is 2 s");
  clock += 1_000;
  await snapshot();
  await settle();
  assert.equal(downInspections, 3);
  assert.equal(reports.length, 1, "no Bot snapshot reported or waited on the retries");

  // A configuration fence makes a retry due at once, still behind the turn.
  generation += 1;
  assert.deepEqual(ids(await snapshot()), ["up"]);
  await settle();
  assert.equal(downInspections, 4);
  assert.equal(reports.length, 1);

  // Once the server answers a retry, the next snapshot offers its tools.
  unreachable = false;
  clock += 4_000;
  await snapshot();
  await settle();
  assert.deepEqual(ids(await snapshot()), ["down", "up"]);

  // A changed connection is never held back by the old connection's failures.
  unreachable = true;
  cache.clear();
  await snapshot();
  reports.length = 0;
  servers = [stdioServer("up"), stdioServer("down", { command: "mcp-down-v2" })];
  unreachable = false;
  assert.deepEqual(ids(await snapshot()), ["down", "up"]);
  assert.deepEqual(reports, []);
});

test("a stale Bot MCP scope answers at once and is refreshed behind the turn", async () => {
  let clock = 1_000;
  const cache = createBotMcpScopeCache({ now: () => clock, ttlMs: 100, graceMs: 10_000, inspectionDeadlineMs: 1_000 });
  let toolName = "v1_read";
  let release: (() => void) | undefined;
  let inspections = 0;
  const snapshot = () => resolveBotMcpInventory(new AbortController().signal, {
    listServers: async () => [stdioServer("notes")],
    credentialSignature: async () => hash("credential"),
    inspectTools: async () => {
      inspections++;
      if (inspections > 1) await new Promise<void>((resolve) => { release = resolve; });
      return [readTool(toolName)];
    },
    incarnations: fixedIncarnations,
    scopeCache: cache,
  });
  const names = (scopes: Awaited<ReturnType<typeof snapshot>>) => scopes.flatMap((scope) => scope.tools.map((tool) => tool.toolName));

  assert.deepEqual(names(await snapshot()), ["v1_read"]);
  clock += 200;
  toolName = "v2_read";
  // The refresh is blocked until released, so this snapshot cannot have waited on it.
  assert.deepEqual(names(await snapshot()), ["v1_read"]);
  assert.deepEqual(names(await snapshot()), ["v1_read"], "callers join the one refresh in flight");
  assert.equal(inspections, 2);
  release?.();
  await settle();
  assert.deepEqual(names(await snapshot()), ["v2_read"]);
  assert.equal(inspections, 2);
});

test("Bot MCP grant identity ignores display fields but not connection settings", async () => {
  const identity = async (server: McpServer) =>
    (await resolveBotMcpConnectionIdentities(new AbortController().signal, {
      listServers: async () => [server],
      credentialSignature: async (current) =>
        botMcpCredentialSignatureCore(Buffer.alloc(32, 7), { server: current, presetKey: null, oauthSession: null }),
      incarnations: fixedIncarnations,
    }))[0]?.connectionFingerprint;
  const base = stdioServer("tools", { env: { TOKEN: "one" } });
  const original = await identity(base);
  assert.equal(await identity({ ...base, name: "Renamed", description: "Now described" }), original);
  assert.notEqual(await identity({ ...base, args: ["--write"] }), original);
  assert.notEqual(await identity({ ...base, env: { TOKEN: "two" } }), original);
});

test("servers switched off for the model and hidden tools never reach Bot scopes", async () => {
  const base = { transport: "stdio" as const, command: "mcp-safe", enabled: true };
  let servers: McpServer[] = [
    { ...base, id: "off", name: "Off", exposure: "hidden" },
    { ...base, id: "partly", name: "Partly", hiddenTools: ["delete"] },
    { ...base, id: "all-hidden", name: "All hidden", hiddenTools: ["read", "delete"] },
  ];
  const inspected: string[] = [];
  const cache = createBotMcpScopeCache({ ttlMs: 60_000 });
  const dependencies = {
    listServers: async () => servers,
    credentialSignature: async (server: McpServer) => hash(`credential:${server.id}`),
    inspectTools: async (server: McpServer) => {
      inspected.push(server.id);
      return [
        { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "delete", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
      ];
    },
    incarnations: {
      reconcileNamespace: async (_namespace: string, resources: readonly { sourceId: string }[]) =>
        resources.map(({ sourceId }) => ({ sourceId, resourceIncarnation: "a".repeat(43), credentialIncarnation: "b".repeat(43) })),
    },
    scopeCache: cache,
  };
  const scopes = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.deepEqual(scopes.map(({ serverId, tools }) => [serverId, tools.map(({ toolName }) => toolName)]), [["partly", ["read"]]]);
  // A server switched off for the model is never even inspected.
  assert.ok(!inspected.includes("off"));
  // Showing a tool again needs no reconnect: the cached inspection still has it.
  servers = servers.map((server) => server.id === "partly" ? { ...server, hiddenTools: undefined } : server);
  const shown = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.deepEqual(shown.find(({ serverId }) => serverId === "partly")?.tools.map(({ toolName }) => toolName).sort(), ["delete", "read"]);
});

test("one unreadable saved MCP sign-in stays on its own connection instead of failing the Bot catalog", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-mcp-unreadable-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let minted = 0;
  const protectedStore = createBotCapabilityStore({
    root: () => root,
    mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
    mintIncarnation: () => Buffer.alloc(32, ++minted).toString("base64url"),
  });
  await protectedStore.initialize();
  const corruptDisabled: McpServer = {
    id: "a-corrupt-disabled",
    name: "Corrupt (disabled)",
    transport: "http",
    url: "https://mcp.corrupt.invalid/mcp",
    oauth: true,
    enabled: false,
  };
  const corruptEnabled: McpServer = {
    ...corruptDisabled,
    id: "b-corrupt-enabled",
    name: "Corrupt (enabled)",
    enabled: true,
  };
  const healthy: McpServer = {
    id: "c-healthy",
    name: "Healthy",
    transport: "stdio",
    command: "mcp-safe",
    enabled: true,
  };
  const binding = mcpAuthorizationBinding(corruptEnabled.url!);
  const savedSession = sessionWithSavedMcpTokens(
    sessionForMcpAuthorizationAttempt({}, binding),
    binding,
    { access_token: "access", token_type: "Bearer", refresh_token: "refresh" },
  );
  let corrupt = false;
  // The real session cache; once OS credential storage cannot decrypt the
  // saved entries, reads raise the distinct storage error.
  const sessions = createMcpOAuthSessionCache({
    readMap: async () => ({
      [corruptDisabled.id]: "ciphertext-a",
      [corruptEnabled.id]: "ciphertext-b",
    }),
    decrypt: () => {
      if (corrupt) throw new Error("errSecDecode");
      return structuredClone(savedSession);
    },
  });
  const key = Buffer.alloc(32, 7);
  const credentialSignature = createBotMcpCredentialSignatureCore({
    readPresetKey: async () => null,
    readOAuthSession: (serverId) => sessions.get(serverId),
  });
  const inspected: string[] = [];
  const dependencies = {
    listServers: async () => [corruptDisabled, corruptEnabled, healthy],
    credentialSignature: (server: McpServer) => credentialSignature(server, key),
    inspectTools: async (server: McpServer) => {
      inspected.push(server.id);
      // A server's own connection reads its sign-in and reports why it failed.
      if (server.oauth) await sessions.get(server.id);
      return [{ name: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
    },
    incarnations: createBotCapabilityIncarnationStore(protectedStore),
  };

  const signedIn = await resolveBotMcpConnectionIdentities(new AbortController().signal, dependencies);
  corrupt = true;
  sessions.invalidate();

  await assert.rejects(sessions.get(corruptEnabled.id), McpOAuthCredentialStorageError);
  const scopes = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.deepEqual(scopes.map(({ serverId }) => serverId), [healthy.id]);
  assert.deepEqual(inspected.sort(), [corruptEnabled.id, healthy.id]);

  const unreadable = await resolveBotMcpConnectionIdentities(new AbortController().signal, dependencies);
  const fingerprint = (values: typeof signedIn, id: string) =>
    values.find(({ serverId }) => serverId === id)?.connectionFingerprint;
  // Unrelated connections keep their identity, so their Bot grants survive.
  assert.equal(fingerprint(unreadable, healthy.id), fingerprint(signedIn, healthy.id));
  // Unreadable connections never keep the signed-in grant's identity.
  assert.notEqual(fingerprint(unreadable, corruptEnabled.id), undefined);
  assert.notEqual(fingerprint(unreadable, corruptEnabled.id), fingerprint(signedIn, corruptEnabled.id));
  assert.notEqual(fingerprint(unreadable, corruptDisabled.id), fingerprint(signedIn, corruptDisabled.id));
});
