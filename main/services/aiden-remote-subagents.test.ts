import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  SubagentRunSnapshot,
  SubagentRunSnapshotV1,
} from "../../renderer/shared/subagent-runs.js";
import {
  AidenRemoteSubagentService,
  RemoteSubagentGrants,
  parseRemoteSubagentPage,
} from "./aiden-remote-subagents.js";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";

function run(
  overrides: Partial<SubagentRunSnapshotV1> = {},
): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId: "private-run",
    groupId: "private-group",
    generationId: "private-generation",
    childId: "private-child",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    role: "reviewer",
    label: "Review",
    state: "completed",
    revision: 2,
    taskPreview: "PRIVATE TASK",
    terminalMarkdown: "PRIVATE RESULT",
    latestText: "PRIVATE THOUGHT",
    error: "PRIVATE ERROR",
    activity: "PRIVATE ACTIVITY",
    startedAt: 1000,
    updatedAt: 2000,
    modelId: "private-model",
    turns: 2,
    tools: 1,
    tokens: 200,
    warnings: [],
    ...overrides,
  };
}
function fixture() {
  const grants = new RemoteSubagentGrants();
  let owns = true;
  let enabled = true;
  let reads = 0;
  let rows: SubagentRunSnapshot[] = [run()];
  const service = new AidenRemoteSubagentService({
    grants,
    enabled: () => enabled,
    ownsChat: async (workspaceId, chatId) =>
      owns && workspaceId === "workspace-1" && chatId === "chat-1",
    listRuns: async () => {
      reads++;
      return rows;
    },
  });
  return {
    grants,
    service,
    setOwns: (value: boolean) => {
      owns = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setRows: (value: SubagentRunSnapshot[]) => {
      rows = value;
    },
    reads: () => reads,
  };
}

test("summary reads default deny before touching private storage and require exact public chat ownership", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.list("device-1", "workspace-1", "chat-1"),
    /Enable subagent summaries/u,
  );
  assert.equal(f.reads(), 0);
  f.grants.set("device-1", true);
  await assert.rejects(
    f.service.list("device-1", "workspace-other", "chat-1"),
    /unavailable/u,
  );
  assert.equal(f.reads(), 0);
  f.setEnabled(false);
  await assert.rejects(
    f.service.list("device-1", "workspace-1", "chat-1"),
    /Enable/u,
  );
});

test("summary DTO allows only display metadata; opaque IDs are stable per grant and isolated per device", async () => {
  const f = fixture();
  f.grants.set("device-1", true);
  f.grants.set("device-2", true);
  const first = await f.service.list("device-1", "workspace-1", "chat-1");
  assert.deepEqual(Object.keys(first.runs[0]!).sort(), [
    "id",
    "label",
    "revision",
    "role",
    "startedAt",
    "state",
    "updatedAt",
  ]);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|private-/u);
  assert.match(first.runs[0]!.id, /^run_[A-Za-z0-9_-]{43}$/u);
  assert.equal(
    (await f.service.list("device-1", "workspace-1", "chat-1")).runs[0]!.id,
    first.runs[0]!.id,
  );
  assert.notEqual(
    (await f.service.list("device-2", "workspace-1", "chat-1")).runs[0]!.id,
    first.runs[0]!.id,
  );
  f.grants.set("device-1", false);
  f.grants.set("device-1", true);
  assert.notEqual(
    (await f.service.list("device-1", "workspace-1", "chat-1")).runs[0]!.id,
    first.runs[0]!.id,
  );
});

test("revocation, disable, regrant and chat deletion during asynchronous authorization reject stale reads", async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.grants.set("device-1", false),
    (f: ReturnType<typeof fixture>) => {
      f.grants.set("device-1", false);
      f.grants.set("device-1", true);
    },
    (f: ReturnType<typeof fixture>) => f.grants.setEnabled(false),
    (f: ReturnType<typeof fixture>) => f.setOwns(false),
  ]) {
    const f = fixture();
    f.grants.set("device-1", true);
    await assert.rejects(
      f.service.list("device-1", "workspace-1", "chat-1", async () =>
        invalidate(f),
      ),
    );
  }
  const grants = new RemoteSubagentGrants();
  grants.set("device-1", true);
  grants.setEnabled(false);
  assert.throws(() => grants.set("device-1", true), /disabled/u);
  grants.setEnabled(true);
  assert.deepEqual(grants.devices(), []);
});

test("summary list is bounded, newest first, and rejects foreign owner records", async () => {
  const f = fixture();
  f.grants.set("device-1", true);
  f.setRows([
    ...Array.from({ length: 101 }, (_, index) =>
      run({ runId: `private-${index}`, startedAt: index + 1 }),
    ),
    run({ chatId: "other", startedAt: 9000 }),
  ]);
  const result = await f.service.list("device-1", "workspace-1", "chat-1");
  assert.equal(result.runs.length, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.runs[0]!.startedAt, 101);
});

test("HTTP summary route enforces auth, scope, grant and query bounds with no-store", async (t) => {
  const f = fixture();
  let hasWorkspace = true;
  let revoked = false;
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Mac",
    appVersion: "1",
    connectionMode: () => "lan",
    now: () => 1000,
    log: () => {},
    pairing: {
      exchange: async () => {
        throw new Error("unused");
      },
    },
    subagents: f.service,
    devices: {
      acquireDeviceAuthorization: () => () => {},
      authenticate: async (token) =>
        token === "a".repeat(43)
          ? {
              id: "device-1",
              revoked,
              capabilities: new Set(
                hasWorkspace
                  ? (["server:read", "chat:read", "workspace:read"] as const)
                  : (["server:read", "chat:read"] as const),
              ),
            }
          : null,
    },
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/aiden/v1`;
  const url = `${base}/workspaces/workspace-1/chats/chat-1/subagents`;
  const headers = {
    "aiden-protocol-version": "1",
    authorization: `Bearer ${"a".repeat(43)}`,
  };
  assert.equal(
    (await fetch(url, { headers: { "aiden-protocol-version": "1" } })).status,
    401,
  );
  assert.equal((await fetch(url, { headers })).status, 403);
  f.grants.set("device-1", true);
  hasWorkspace = false;
  assert.equal((await fetch(url, { headers })).status, 403);
  hasWorkspace = true;
  const result = await fetch(url, { headers });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal((await result.json()).runs.length, 1);
  assert.equal((await fetch(`${url}?extra=1`, { headers })).status, 400);
  const serverInfo = await (await fetch(`${base}/server`, { headers })).json();
  assert.ok(serverInfo.features.includes("workspace-subagents-v1"));
  revoked = true;
  assert.equal((await fetch(url, { headers })).status, 403);
});

test("shared summary fixture stays a separate resource with exact public keys", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../protocol/aiden-remote/v1/fixtures/contract.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(fixture.workspaceSubagents.version, 1);
  assert.deepEqual(Object.keys(fixture.workspaceSubagents.runs[0]).sort(), [
    "id",
    "label",
    "revision",
    "role",
    "startedAt",
    "state",
    "updatedAt",
  ]);
});

test("summary parser rejects private fields, duplicate IDs and invalid revisions/timestamps", async () => {
  const f = fixture();
  f.grants.set("device-1", true);
  const page = await f.service.list("device-1", "workspace-1", "chat-1");
  for (const extra of [
    { taskPreview: "private" },
    { revision: 0 },
    { updatedAt: 0 },
    { state: "invented" },
    { id: "private-run" },
  ]) {
    assert.throws(() =>
      parseRemoteSubagentPage({
        ...page,
        runs: [{ ...page.runs[0], ...extra }],
      }),
    );
  }
  assert.throws(() =>
    parseRemoteSubagentPage({ ...page, runs: [page.runs[0], page.runs[0]] }),
  );
});
