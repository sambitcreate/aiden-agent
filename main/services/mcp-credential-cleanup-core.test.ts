import assert from "node:assert/strict";
import test from "node:test";
import {
  mcpCredentialCleanupAfterConfig,
  mcpCredentialConnectionSnapshot,
  mcpRuntimeConnectionSnapshot,
  parsePendingMcpCredentialCleanup,
  pendingMcpCredentialCleanupForRemove,
  pendingMcpCredentialCleanupForSave,
  replaceMcpCredentialAfterDisconnect,
  sameMcpCredentialConnection,
  sameMcpRuntimeConnection,
} from "./mcp-credential-cleanup-core.js";

test("preset credential replacement waits for connection invalidation", async () => {
  const events: string[] = [];
  let releaseDisconnect!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    releaseDisconnect = resolve;
  });
  const replacement = replaceMcpCredentialAfterDisconnect(
    async () => {
      events.push("disconnect-start");
      await disconnected;
      events.push("disconnect-end");
    },
    async () => {
      events.push("replace");
      return "done";
    },
  );

  await Promise.resolve();
  assert.deepEqual(events, ["disconnect-start"]);
  releaseDisconnect();
  assert.equal(await replacement, "done");
  assert.deepEqual(events, ["disconnect-start", "disconnect-end", "replace"]);
});

const server = {
  id: "mcp-server",
  name: "MCP",
  transport: "http" as const,
  url: "https://mcp.example",
  enabled: true,
  oauth: true,
};

test("MCP removal clears credentials only after the intended server is absent", () => {
  const pending = {
    version: 1 as const,
    kind: "remove" as const,
    serverId: server.id,
    previous: mcpCredentialConnectionSnapshot(server),
    target: null,
  };
  assert.deepEqual(mcpCredentialCleanupAfterConfig(pending, server), {
    resolved: true,
    clearOAuth: false,
    clearPresetKey: false,
  });
  assert.deepEqual(mcpCredentialCleanupAfterConfig(pending, undefined), {
    resolved: true,
    clearOAuth: true,
    clearPresetKey: true,
  });
});

test("same-id replacement after removal resolves by clearing old credentials", () => {
  const pending = {
    version: 1 as const,
    kind: "remove" as const,
    serverId: server.id,
    previous: mcpCredentialConnectionSnapshot(server),
    target: null,
  };
  assert.deepEqual(
    mcpCredentialCleanupAfterConfig(pending, { ...server, url: "https://other.example" }),
    { resolved: true, clearOAuth: true, clearPresetKey: true },
  );
});

test("OAuth disable clears tokens only after the exact new config is visible", () => {
  const disabled = { ...server, oauth: false };
  const pending = {
    version: 1 as const,
    kind: "disable-oauth" as const,
    serverId: server.id,
    previous: mcpCredentialConnectionSnapshot(server),
    target: mcpCredentialConnectionSnapshot(disabled),
  };
  assert.equal(mcpCredentialCleanupAfterConfig(pending, server).clearOAuth, false);
  assert.equal(mcpCredentialCleanupAfterConfig(pending, disabled).clearOAuth, true);
  assert.equal(
    mcpCredentialCleanupAfterConfig(pending, { ...disabled, url: "https://other.example" })
      .clearPresetKey,
    true,
    "a second endpoint edit clears stale API-key credentials instead of wedging the journal",
  );
});

test("a cleanup journal resolves safely when the portable file skips past its target", () => {
  const target = { ...server, url: "https://target.example" };
  const advanced = { ...server, url: "https://advanced.example" };
  const pending = {
    version: 1 as const,
    kind: "replace" as const,
    serverId: server.id,
    previous: mcpCredentialConnectionSnapshot(server),
    target: mcpCredentialConnectionSnapshot(target),
  };

  assert.deepEqual(mcpCredentialCleanupAfterConfig(pending, advanced), {
    resolved: true,
    clearOAuth: true,
    clearPresetKey: true,
  });
});

test("pending MCP cleanup records are strict, bounded, and carry both snapshots", () => {
  const pending = {
    version: 1,
    kind: "remove",
    serverId: "mcp-server",
    previous: mcpCredentialConnectionSnapshot(server),
    target: null,
  };
  assert.deepEqual(parsePendingMcpCredentialCleanup(pending), pending);
  assert.throws(
    () => parsePendingMcpCredentialCleanup({ ...pending, version: 2 }),
    /Invalid pending MCP credential cleanup/u,
  );
  assert.throws(
    () =>
      parsePendingMcpCredentialCleanup({
        ...pending,
        previous: { ...pending.previous, id: "different" },
      }),
    /Invalid pending MCP credential cleanup/u,
  );
});

test("cleanup intent is derived from the configuration current inside mutation admission", () => {
  const firstTarget = { ...server, url: "https://first.example" };
  const secondTarget = { ...server, url: "https://second.example" };
  const afterFirstCommit = pendingMcpCredentialCleanupForSave(firstTarget, secondTarget);

  assert.deepEqual(afterFirstCommit, {
    version: 1,
    kind: "replace",
    serverId: server.id,
    previous: mcpCredentialConnectionSnapshot(firstTarget),
    target: mcpCredentialConnectionSnapshot(secondTarget),
  });
  assert.deepEqual(pendingMcpCredentialCleanupForSave(secondTarget, secondTarget), null);
  assert.deepEqual(pendingMcpCredentialCleanupForRemove(undefined, server.id), null);
  assert.deepEqual(pendingMcpCredentialCleanupForRemove(firstTarget, server.id), {
    version: 1,
    kind: "remove",
    serverId: server.id,
    previous: mcpCredentialConnectionSnapshot(firstTarget),
    target: null,
  });
});

test("runtime admission includes non-secret name and enabled changes", () => {
  const credentialSnapshot = mcpCredentialConnectionSnapshot(server);
  const renamed = { ...server, name: "Renamed MCP" };
  const disabled = { ...server, enabled: false };

  assert.equal(
    sameMcpCredentialConnection(credentialSnapshot, mcpCredentialConnectionSnapshot(renamed)),
    true,
    "display-only changes do not trigger credential deletion",
  );
  assert.equal(
    sameMcpRuntimeConnection(
      mcpRuntimeConnectionSnapshot(server),
      mcpRuntimeConnectionSnapshot(renamed),
    ),
    false,
  );
  assert.equal(
    sameMcpRuntimeConnection(
      mcpRuntimeConnectionSnapshot(server),
      mcpRuntimeConnectionSnapshot(disabled),
    ),
    false,
    "an in-flight enabled admission cannot survive an external disable",
  );
});
