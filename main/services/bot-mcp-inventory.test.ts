import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { botMcpCredentialSignatureCore } from "./bot-capability-credential-signatures-core.js";
import { createBotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";
import { resolveBotMcpInventory } from "./bot-mcp-inventory.js";
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
