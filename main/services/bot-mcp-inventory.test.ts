import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { botMcpCredentialSignatureCore } from "./bot-capability-credential-signatures-core.js";
import { createBotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";
import {
  createBotMcpScopeCache,
  resolveBotMcpConnectionIdentities,
  resolveBotMcpInventory,
  type BotMcpInspectionFailureReport,
} from "./bot-mcp-inventory.js";
import {
  mcpAuthorizationBinding,
  sessionForMcpAuthorizationAttempt,
  sessionWithSavedMcpTokens,
  type McpOAuthSession,
} from "./mcp-oauth-session.js";
import type { McpServer } from "./types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

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

test("a slow or failing MCP server drops only its own Bot scope and keeps its last good scope briefly", async () => {
  let clock = 1_000;
  const cache = createBotMcpScopeCache({
    now: () => clock,
    ttlMs: 1,
    graceMs: 120_000,
    // A hung inspection is shared by later callers only until its own deadline.
    inspectionDeadlineMs: 20,
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

  // Transient trouble: the finished server is kept and the others keep their
  // last verified scope, so the catalog revision does not flap.
  clock += 10;
  hangSlow = true;
  breakBroken = true;
  assert.deepEqual(await snapshot(), healthy);
  assert.deepEqual(
    reports.map(({ server, kind, keptLastGood }) => [server.id, kind, keptLastGood]).sort(),
    [["broken", "failed", true], ["slow", "timed_out", true]],
  );

  // Past the grace window only the server that answered remains.
  clock += 120_000;
  assert.deepEqual(ids(await snapshot()), ["fast"]);

  // A configuration change never inherits the old connection's scope.
  hangSlow = false;
  breakBroken = false;
  await snapshot();
  clock += 10;
  servers = [stdioServer("fast"), stdioServer("slow", { command: "mcp-other" }), stdioServer("broken")];
  hangSlow = true;
  assert.deepEqual(ids(await snapshot()), ["broken", "fast"]);
  // Nor does a disabled one.
  hangSlow = false;
  servers = [stdioServer("fast"), stdioServer("slow"), stdioServer("broken", { enabled: false })];
  assert.deepEqual(ids(await snapshot()), ["fast", "slow"]);
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
