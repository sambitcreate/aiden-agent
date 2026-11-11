import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
} from "../services/aiden-remote-state.js";
import type { AidenMcpServerStatusView } from "../../renderer/shared/aiden-mcp.js";
import { registerAidenMcpHandlers } from "./aiden-mcp.js";

/**
 * The Settings channels over a real Remote registry, so issuing, listing,
 * revoking and authenticating an app all go through the stored records.
 */
async function harness(options: { ownerActive?: () => boolean; destroyedAfterIssue?: boolean } = {}) {
  let stored: unknown = createDefaultAidenRemoteState(() => Buffer.alloc(24, 7));
  let random = 0;
  let clock = 1_000_000;
  const registry = new AidenRemoteStateRegistry(
    {
      load: async () => structuredClone(stored),
      save: async (document) => {
        stored = structuredClone(document);
      },
    },
    {
      now: () => clock,
      randomBytes: (size) => Buffer.alloc(size, ++random),
      deriveCredentialDigest: async (credential, salt) =>
        createHash("sha256").update(credential).update(salt).digest(),
    },
  );
  await registry.initialize();

  let status: AidenMcpServerStatusView = { supported: true, enabled: false, running: false };
  let issued = false;
  const provenance = new Map([["chat-1", { kind: "app" as const, name: "Claude Code", startedAt: 42 }]]);
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerAidenMcpHandlers<unknown>({
    handle: (channel, handler) => void handlers.set(channel, handler),
    owner: () => {
      if (options.ownerActive && !options.ownerActive()) throw new Error("Apps using Aiden can be changed only from the active Aiden window.");
      return { isDestroyed: () => options.destroyedAfterIssue === true && issued };
    },
    service: {
      status: async () => status,
      setEnabled: async (enabled) => (status = { ...status, enabled, running: enabled, ...(enabled ? { port: 49400, url: "http://127.0.0.1:49400/mcp" } : {}) }),
      issueApp: async (input) => {
        const result = await registry.issueAgentApp(input);
        issued = true;
        return result;
      },
      listApps: () => registry.listAgentApps(),
      revokeApp: (appId) => registry.revokeDevice(appId),
      chatProvenance: async (chatId) => provenance.get(chatId),
    },
  });
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, channel);
    return handler({}, ...args);
  };
  return {
    invoke,
    registry,
    channels: () => [...handlers.keys()].sort(),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

test("adding an app returns its token once, and nothing else ever carries it", async () => {
  const { invoke, registry } = await harness();
  const added = (await invoke("remote:mcpIssueApp", { name: "  Claude Code  ", access: "supervised" })) as {
    credential: string;
    app: { id: string; name: string; access: string; createdAt: number; lastSeenAt: number };
  };
  assert.match(added.credential, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(added.app.name, "Claude Code");
  assert.equal(added.app.access, "supervised");
  assert.equal(added.app.lastSeenAt, 0, "a new app has not connected yet");
  assert.deepEqual(await invoke("remote:mcpListApps"), [added.app]);

  const authenticated = await registry.authenticate(added.credential);
  assert.equal(authenticated?.revoked, false, "the issued token works");
  const [listed] = (await invoke("remote:mcpListApps")) as Array<{ lastSeenAt: number }>;
  assert.ok(listed && listed.lastSeenAt > 0, "using the token marks the app as used");
  for (const [channel, args] of [
    ["remote:mcpStatus", []],
    ["remote:mcpListApps", []],
    ["remote:mcpSetEnabled", [true]],
    ["remote:mcpChatProvenance", ["chat-1"]],
  ] as const) {
    assert.ok(!JSON.stringify(await invoke(channel, ...args)).includes(added.credential), channel);
  }
});

test("an app needs a name of up to 80 characters and one of the two access levels", async () => {
  const { invoke } = await harness();
  for (const bad of [
    undefined,
    "Claude Code",
    { name: "", access: "read" },
    { name: "   ", access: "read" },
    { name: "x".repeat(81), access: "read" },
    { name: "Codex", access: "full" },
    { name: "Codex" },
  ]) {
    await assert.rejects(invoke("remote:mcpIssueApp", bad), JSON.stringify(bad));
  }
  assert.deepEqual(await invoke("remote:mcpListApps"), []);
  const added = (await invoke("remote:mcpIssueApp", { name: "x".repeat(80), access: "read" })) as { app: { access: string } };
  assert.equal(added.app.access, "read");
});

test("the list shows live apps newest first, and a revoked app's token stops working", async () => {
  const { invoke, registry, tick } = await harness();
  const first = (await invoke("remote:mcpIssueApp", { name: "Codex", access: "read" })) as { credential: string; app: { id: string } };
  tick(1_000);
  const second = (await invoke("remote:mcpIssueApp", { name: "Claude Code", access: "supervised" })) as { app: { id: string } };
  assert.deepEqual(
    ((await invoke("remote:mcpListApps")) as Array<{ name: string }>).map((app) => app.name),
    ["Claude Code", "Codex"],
  );

  assert.deepEqual(await invoke("remote:mcpRevokeApp", first.app.id), { revoked: true });
  assert.equal((await registry.authenticate(first.credential))?.revoked, true);
  assert.deepEqual(
    ((await invoke("remote:mcpListApps")) as Array<{ id: string }>).map((app) => app.id),
    [second.app.id],
  );
  assert.deepEqual(await invoke("remote:mcpRevokeApp", first.app.id), { revoked: false });
  for (const bad of [undefined, 7, "", "chat_1", "device_with spaces", `device_${"a".repeat(130)}`]) {
    await assert.rejects(invoke("remote:mcpRevokeApp", bad), /Invalid app identifier/u, String(bad));
  }
});

test("when the asking window closes while an app is added, the app is taken back", async () => {
  const { invoke, registry } = await harness({ destroyedAfterIssue: true });
  await assert.rejects(invoke("remote:mcpIssueApp", { name: "Codex", access: "read" }), /window that added this app closed/u);
  assert.deepEqual(await invoke("remote:mcpListApps"), []);
  assert.deepEqual(await registry.listAgentApps().then((apps) => apps.filter((app) => app.revokedAt === undefined)), []);
});

test("only the active Aiden window can use these channels", async () => {
  let active = false;
  const { invoke, channels } = await harness({ ownerActive: () => active });
  assert.deepEqual(channels(), [
    "remote:mcpChatProvenance",
    "remote:mcpIssueApp",
    "remote:mcpListApps",
    "remote:mcpRevokeApp",
    "remote:mcpSetEnabled",
    "remote:mcpStatus",
  ]);
  await assert.rejects(invoke("remote:mcpStatus"), /active Aiden window/u);
  await assert.rejects(invoke("remote:mcpSetEnabled", true), /active Aiden window/u);
  await assert.rejects(invoke("remote:mcpIssueApp", { name: "Codex", access: "read" }), /active Aiden window/u);
  await assert.rejects(invoke("remote:mcpChatProvenance", "chat-1"), /active Aiden window/u);
  active = true;
  assert.deepEqual(await invoke("remote:mcpListApps"), [], "the refused add left no app behind");
});

test("the switch takes only a boolean and answers with the server's status", async () => {
  const { invoke } = await harness();
  for (const bad of ["true", 1, null, undefined]) {
    await assert.rejects(invoke("remote:mcpSetEnabled", bad), /Invalid MCP server setting/u, String(bad));
  }
  assert.deepEqual(await invoke("remote:mcpStatus"), { supported: true, enabled: false, running: false });
  const on = (await invoke("remote:mcpSetEnabled", true)) as AidenMcpServerStatusView;
  assert.equal(on.url, "http://127.0.0.1:49400/mcp");
});

test("a chat an app started names the app; other chats name none", async () => {
  const { invoke } = await harness();
  assert.deepEqual(await invoke("remote:mcpChatProvenance", "chat-1"), { name: "Claude Code", startedAt: 42 });
  assert.equal(await invoke("remote:mcpChatProvenance", "chat-2"), null);
  await assert.rejects(invoke("remote:mcpChatProvenance", ""), /Invalid chat identifier/u);
});
