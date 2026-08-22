import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

async function fixture(options: {
  authenticate?: "valid" | "revoked" | "denied" | "invalid";
  capabilities?: AidenRemoteCapability[];
  authorizationBlocked?: () => boolean;
} = {}) {
  const logs: unknown[] = [];
  const calls: string[] = [];
  const workspace = {
    id: "workspace-1",
    name: "Project",
    permission: "ask" as const,
    hasFolder: false,
    isManagedWorktree: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    revision: `rev_${"r".repeat(43)}`,
  };
  const chat = {
    id: "chat-1",
    workspaceId: "workspace-1",
    title: "Chat",
    providerId: "provider-1",
    modelId: "model-1",
    messages: [],
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    revision: `rev_${"c".repeat(43)}`,
  };
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Studio Mac",
    appVersion: "0.30.0",
    devices: {
      acquireDeviceAuthorization: () => {
        if (options.authorizationBlocked?.()) {
          throw new AidenRemoteServiceError(
            "credential_revoked",
            "This device was revoked in Aiden Settings.",
            403,
          );
        }
        return () => undefined;
      },
      authenticate: async (credential) => {
        if (credential !== "a".repeat(43) || options.authenticate === "invalid") {
          return null;
        }
        return {
          id: "device-authorized-12345678",
          revoked: options.authenticate === "revoked",
          capabilities: new Set(
            options.authenticate === "denied"
              ? []
              : (options.capabilities ?? ["server:read" as const]),
          ),
        };
      },
    },
    workspaces: {
      list: async () => ({ workspaces: [workspace] }),
      get: async (id) => ({ ...workspace, id }),
      create: async (deviceId, key) => {
        calls.push(`create:${deviceId}:${key}`);
        return workspace;
      },
      update: async (id, revision) => {
        calls.push(`update:${id}:${revision}`);
        return { ...workspace, id };
      },
      remove: async (id, revision) => {
        calls.push(`remove:${id}:${revision}`);
      },
    },
    workspaceBrowser: {
      listRoots: async (deviceId) => ({
        roots: [{
          id: "root-1",
          label: "Projects",
          location: `loc_${"l".repeat(43)}`,
          policyRevision: "policy-1",
        }],
        deviceId,
      }) as never,
      listChildren: async (deviceId, location, cursor) => {
        calls.push(`children:${deviceId}:${location}:${cursor ?? ""}`);
        return { rootId: "root-1", label: "Projects", breadcrumbs: [], entries: [] };
      },
      createSelection: async (deviceId, location) => {
        calls.push(`selection:${deviceId}:${location}`);
        return {
          selection: `sel_${"s".repeat(43)}`,
          displayName: "Projects",
          expiresAt: new Date(60_000).toISOString(),
        };
      },
    },
    chats: {
      list: async (workspaceId) => {
        calls.push(`chat-list:${workspaceId ?? ""}`);
        return { chats: [chat] };
      },
      get: async (id) => ({ ...chat, id }),
      create: async (deviceId, key) => {
        calls.push(`chat-create:${deviceId}:${key}`);
        return chat;
      },
      rename: async (id, revision) => {
        calls.push(`chat-rename:${id}:${revision}`);
        return { ...chat, id, title: "Renamed" };
      },
      move: async (deviceId, id, revision, key) => {
        calls.push(`chat-move:${deviceId}:${id}:${revision}:${key}`);
        return { ...chat, id, workspaceId: "workspace-2" };
      },
      remove: async (id, revision) => {
        calls.push(`chat-remove:${id}:${revision}`);
      },
      startTurn: async (deviceId, id, key) => {
        calls.push(`turn:${deviceId}:${id}:${key}`);
        return {
          turnId: "turn-1",
          streamId: "stream-1",
          status: "accepted" as const,
          message: {
            id: "message-1",
            role: "user" as const,
            text: "Hello",
            createdAt: new Date(3_000).toISOString(),
          },
        };
      },
    },
    models: {
      list: async () => ({
        providers: [{ id: "provider-1", label: "Provider", models: [{ id: "model-1", label: "Model" }] }],
        defaults: { providerId: "provider-1", modelId: "model-1" },
      }),
    },
    usage: {
      summary: async (range) => ({
        range,
        startDate: "2026-07-21",
        endDate: "2026-08-19",
        totals: {
          requests: 12, completedRequests: 11, failedRequests: 1, cancelledRequests: 0,
          reportedTokenRequests: 10, unmeteredRequests: 2, localRequests: 3,
          costedRequests: 8, unpricedHostedRequests: 1, hostedCostUsd: 1.25,
          activeDays: 4, currentStreak: 2, longestStreak: 3,
          tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 2, reasoning: 8, total: 170 },
        },
        days: [],
        models: [],
      }),
    },
    streams: {
      status: (_deviceId, streamId) => ({
        streamId,
        chatId: "chat-1",
        turnId: "turn-1",
        state: "running" as const,
        lastSequence: 2,
        updatedAt: new Date(4_000).toISOString(),
      }),
      pendingApproval: (_deviceId, streamId) => ({
        approvalId: "approval-1",
        streamId,
        chatId: "chat-1",
        summary: "Run a reviewed command",
        toolCallId: "tool-1",
        toolName: "bash",
        expiresAt: new Date(60_000).toISOString(),
        canAllow: false,
      }),
      cancel: async (deviceId, streamId, _key) => {
        calls.push(`cancel:${deviceId}:${streamId}`);
        return {
          streamId,
          chatId: "chat-1",
          turnId: "turn-1",
          state: "running" as const,
          lastSequence: 2,
          updatedAt: new Date(4_000).toISOString(),
        };
      },
      respondApproval: async (deviceId, approvalId, decision, _key) => {
        calls.push(`approval:${deviceId}:${approvalId}:${decision}`);
        return { approvalId, decision, resolvedAt: new Date(5_000).toISOString() };
      },
      openEvents: (_deviceId, streamId, after, response) => {
        calls.push(`events:${streamId}:${after}`);
        const data = JSON.stringify({ streamId, sequence: after + 1 });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`id: ${after + 1}\ndata: ${data}\n\n`);
      },
    },
    files: {
      list: async (deviceId, workspaceId) => {
        calls.push(`files:${deviceId}:${workspaceId}`);
        return {
          snapshotId: "files-snapshot-1",
          entries: [{
            id: `file_${"f".repeat(43)}`,
            displayPath: "Sources/App.swift",
            name: "App.swift",
            kind: "file" as const,
            size: 12,
            language: "Swift",
          }],
          truncated: false,
          maxEntries: 4_000 as const,
          maxDepth: 20 as const,
        };
      },
      read: async (deviceId, workspaceId, fileId) => {
        calls.push(`file-read:${deviceId}:${workspaceId}:${fileId}`);
        return {
          id: fileId,
          displayPath: "Sources/App.swift",
          content: "let value = 1\n",
          version: "a".repeat(64),
          truncated: false as const,
        };
      },
      write: async (deviceId, workspaceId, fileId) => {
        calls.push(`file-write:${deviceId}:${workspaceId}:${fileId}`);
        return {
          id: fileId,
          displayPath: "Sources/App.swift",
          content: "let value = 2\n",
          version: "b".repeat(64),
          truncated: false as const,
        };
      },
    },
    git: {
      review: async (deviceId, workspaceId) => {
        calls.push(`git-review:${deviceId}:${workspaceId}`);
        return {
          operationId: "op-review",
          status: "snapshot",
          snapshotId: `snap_${"s".repeat(43)}`,
          result: { kind: "review", branch: "main", uncommitted: 0, files: [] },
        } as never;
      },
      diff: async () => ({}) as never,
      branches: async () => ({}) as never,
      checkout: async () => ({}) as never,
      createBranch: async () => ({}) as never,
      commit: async () => ({}) as never,
      pushCapability: async () => ({}) as never,
      push: async () => ({}) as never,
      compare: async () => ({}) as never,
      comparisonDiff: async () => ({}) as never,
      worktrees: async (deviceId, workspaceId) => {
        calls.push(`git-worktrees:${deviceId}:${workspaceId}`);
        return {
          operationId: "op-worktrees",
          status: "snapshot",
          result: { kind: "worktrees", worktrees: [] },
        } as never;
      },
      createWorktree: async (deviceId, workspaceId, key) => {
        calls.push(`git-worktree-create:${deviceId}:${workspaceId}:${key}`);
        return {
          operationId: "op-worktree-create",
          status: "succeeded",
          result: { kind: "mutation", message: "Created managed worktree.", workspaceId: "workspace-2" },
        } as never;
      },
      deleteManagedWorktree: async (deviceId, workspaceId, revision, key) => {
        calls.push(`git-worktree-delete:${deviceId}:${workspaceId}:${revision}:${key}`);
        return {
          operationId: "op-worktree-delete",
          status: "succeeded",
          result: { kind: "mutation", message: "Removed managed worktree.", workspaceId },
        } as never;
      },
    },
    schedules: {
      list: async (deviceId) => {
        calls.push(`schedule-list:${deviceId}`);
        return { tasks: [] };
      },
      get: async () => ({}) as never,
      create: async (deviceId, key) => {
        calls.push(`schedule-create:${deviceId}:${key}`);
        return { id: "task-1", revision: "rev-task-1" } as never;
      },
      update: async () => ({}) as never,
      remove: async (taskId, revision) => {
        calls.push(`schedule-remove:${taskId}:${revision}`);
      },
      pause: async (deviceId, taskId, revision, key) => {
        calls.push(`schedule-pause:${deviceId}:${taskId}:${revision}:${key}`);
        return { id: taskId, revision: "rev-task-2" } as never;
      },
      resume: async () => ({}) as never,
      run: async (deviceId, taskId, key) => {
        calls.push(`schedule-run:${deviceId}:${taskId}:${key}`);
        return { taskId, runId: "run-1", status: "accepted" as const, acceptedAt: new Date(1_000).toISOString() };
      },
      runs: async (taskId) => {
        calls.push(`schedule-runs:${taskId}`);
        return { runs: [] };
      },
      preview: () => ({ dates: [new Date(2_000).toISOString()] }),
      scripts: async (deviceId, workspaceId) => {
        calls.push(`schedule-scripts:${deviceId}:${workspaceId ?? ""}`);
        return { scripts: [{ id: `script_${"s".repeat(43)}`, name: "daily.sh" }] };
      },
      mcpServers: async () => ({ servers: [{ id: "mcp-1", name: "GitHub" }] }),
      settings: async () => ({
        revision: "rev-settings", enabled: true, defaultMode: "llm" as const,
        defaultPermission: "read-only" as const, defaultMcpEnabled: false,
        defaultNotify: true, defaultTimezone: "UTC",
      }),
      updateSettings: async () => ({}) as never,
    },
    pairing: {
      manualBootstrap: () => ({
        kind: "aiden-manual-pairing-v1",
        protocolVersion: 1,
        sessionId: `pairing_${"s".repeat(32)}`,
        expiresAt: new Date(301_000).toISOString(),
        salt: Buffer.alloc(16, 1).toString("base64url"),
        nonce: Buffer.alloc(12, 2).toString("base64url"),
        ciphertext: Buffer.from("sealed").toString("base64url"),
        tag: Buffer.alloc(16, 3).toString("base64url"),
      }),
      exchange: async () => ({
          protocolVersion: 1,
          instanceId: "instance-1",
          deviceId: "device-1",
          credential: "b".repeat(43),
          capabilities: ["server:read" as const],
          endpoint: "https://aiden.example.test/api/aiden/v1",
          serverSpkiSha256: `sha256/${Buffer.alloc(32).toString("base64")}`,
        }),
    },
    connectionMode: () => "lan",
    now: () => 1_000,
    log: (entry) => logs.push(entry),
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    base: `http://127.0.0.1:${address.port}/api/aiden/v1`,
    logs,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("health is the only unauthenticated read and server projection requires both headers", async () => {
  const app = await fixture();
  try {
    const health = await fetch(`${app.base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, protocolVersion: 1 });

    const unauthenticated = await fetch(`${app.base}/server`);
    assert.equal(unauthenticated.status, 400);
    assert.equal((await unauthenticated.json()).error.code, "invalid_request");

    const authenticated = await fetch(`${app.base}/server`, {
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(authenticated.status, 200);
    const server = await authenticated.json();
    assert.equal(server.instanceId, "instance-1");
    assert.equal(server.name, "Studio Mac");
    assert.equal(server.connectionMode, "lan");
    assert.equal(JSON.stringify(server).includes("credential"), false);
  } finally {
    await app.close();
  }
});

test("authenticated workspace CRUD and browser routes preserve the frozen HTTP contract", async () => {
  const app = await fixture({
    capabilities: ["workspace:read", "workspace:manage", "workspace:browse"],
  });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const listed = await fetch(`${app.base}/workspaces`, { headers });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).workspaces[0].id, "workspace-1");

    const created = await fetch(`${app.base}/workspaces`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "workspace-create-key-0001",
      },
      body: JSON.stringify({ mode: "folderless", name: "Project" }),
    });
    assert.equal(created.status, 201);

    const revision = `rev_${"r".repeat(43)}`;
    const updated = await fetch(`${app.base}/workspaces/workspace-1`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "if-match": revision },
      body: JSON.stringify({ confirmedForeground: true, name: "Renamed" }),
    });
    assert.equal(updated.status, 200);

    const location = `loc_${"l".repeat(43)}`;
    const cursor = `cur_${"c".repeat(43)}`;
    const children = await fetch(
      `${app.base}/workspace-browser/children?location=${location}&cursor=${cursor}`,
      { headers },
    );
    assert.equal(children.status, 200);
    const selection = await fetch(`${app.base}/workspace-browser/selections`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ location }),
    });
    assert.equal(selection.status, 201);

    const removed = await fetch(`${app.base}/workspaces/workspace-1`, {
      method: "DELETE",
      headers: { ...headers, "if-match": revision },
    });
    assert.equal(removed.status, 204);
    assert.deepEqual(app.calls, [
      "create:device-authorized-12345678:workspace-create-key-0001",
      `update:workspace-1:${revision}`,
      `children:device-authorized-12345678:${location}:${cursor}`,
      `selection:device-authorized-12345678:${location}`,
      `remove:workspace-1:${revision}`,
    ]);
  } finally {
    await app.close();
  }
});

test("authenticated chat, model, turn, stream, cancel, and approval routes preserve the contract", async () => {
  const app = await fixture({
    capabilities: ["chat:read", "chat:write", "approval:respond"],
  });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const revision = `rev_${"c".repeat(43)}`;
  try {
    const models = await fetch(`${app.base}/models`, { headers });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).defaults.modelId, "model-1");

    const chats = await fetch(`${app.base}/chats?workspaceId=workspace-1`, { headers });
    assert.equal(chats.status, 200);
    assert.equal((await chats.json()).chats[0].id, "chat-1");

    const created = await fetch(`${app.base}/chats`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "chat-create-key-00001" },
      body: JSON.stringify({ workspaceId: "workspace-1" }),
    });
    assert.equal(created.status, 201);

    const renamed = await fetch(`${app.base}/chats/chat-1`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "if-match": revision },
      body: JSON.stringify({ title: "Renamed" }),
    });
    assert.equal(renamed.status, 200);

    const turn = await fetch(`${app.base}/chats/chat-1/turns`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "turn-start-key-000001" },
      body: JSON.stringify({ text: "Hello" }),
    });
    assert.equal(turn.status, 202);
    assert.equal((await turn.json()).streamId, "stream-1");

    const status = await fetch(`${app.base}/streams/stream-1`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).state, "running");

    const approvalSnapshot = await fetch(`${app.base}/streams/stream-1/approval`, { headers });
    assert.equal(approvalSnapshot.status, 200);
    assert.deepEqual(await approvalSnapshot.json(), {
      approval: {
        approvalId: "approval-1",
        streamId: "stream-1",
        chatId: "chat-1",
        summary: "Run a reviewed command",
        toolCallId: "tool-1",
        toolName: "bash",
        expiresAt: new Date(60_000).toISOString(),
        canAllow: false,
      },
    });

    const events = await fetch(`${app.base}/streams/stream-1/events?after=1`, { headers });
    assert.equal(events.status, 200);
    assert.match(await events.text(), /id: 2/u);

    const cancelled = await fetch(`${app.base}/streams/stream-1/cancel`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "cancel-stream-key-0001" },
    });
    assert.equal(cancelled.status, 202);

    const approval = await fetch(`${app.base}/approvals/approval-1/respond`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "approval-key-0000001" },
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(approval.status, 200);
    assert.equal((await approval.json()).decision, "deny");
  } finally {
    await app.close();
  }
});

test("authenticated usage returns privacy-safe Mac aggregates with a bounded range", async () => {
  const app = await fixture({ capabilities: ["server:read"] });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const response = await fetch(`${app.base}/usage?range=30d`, { headers });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.range, "30d");
    assert.equal(summary.totals.requests, 12);
    assert.equal(JSON.stringify(summary).includes("chatId"), false);

    const invalid = await fetch(`${app.base}/usage?range=forever`, { headers });
    assert.equal(invalid.status, 400);
  } finally {
    await app.close();
  }
});

test("authenticated file index, read, and versioned write routes preserve opaque identifiers", async () => {
  const app = await fixture({ capabilities: ["files:read", "files:write"] });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const fileId = `file_${"f".repeat(43)}`;
  try {
    const index = await fetch(`${app.base}/workspaces/workspace-1/files`, { headers });
    assert.equal(index.status, 200);
    assert.equal((await index.json()).entries[0].id, fileId);

    const document = await fetch(`${app.base}/workspaces/workspace-1/files/${fileId}`, { headers });
    assert.equal(document.status, 200);
    assert.equal((await document.json()).displayPath, "Sources/App.swift");

    const saved = await fetch(`${app.base}/workspaces/workspace-1/files/${fileId}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ content: "let value = 2\n", expectedVersion: "a".repeat(64) }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).version, "b".repeat(64));
    assert.deepEqual(app.calls, [
      "files:device-authorized-12345678:workspace-1",
      `file-read:device-authorized-12345678:workspace-1:${fileId}`,
      `file-write:device-authorized-12345678:workspace-1:${fileId}`,
    ]);
  } finally {
    await app.close();
  }
});

test("authenticated Git review and confirmed managed-worktree routes preserve mutation preconditions", async () => {
  const app = await fixture({ capabilities: ["git:read", "git:write"] });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const createKey = "git-worktree-create-key-0001";
  const deleteKey = "git-worktree-delete-key-0001";
  const revision = `rev_${"r".repeat(43)}`;
  try {
    const review = await fetch(`${app.base}/workspaces/workspace-1/git/review`, { headers });
    assert.equal(review.status, 200);
    assert.equal((await review.json()).result.kind, "review");

    const created = await fetch(`${app.base}/workspaces/workspace-1/git/worktrees`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": createKey },
      body: JSON.stringify({ branch: "feature/mobile", name: "Mobile", confirmedForeground: true }),
    });
    assert.equal(created.status, 202);

    const missingRevision = await fetch(`${app.base}/workspaces/workspace-2/git/managed-worktree`, {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": deleteKey },
      body: JSON.stringify({ confirmedForeground: true }),
    });
    assert.equal(missingRevision.status, 400);

    const removed = await fetch(`${app.base}/workspaces/workspace-2/git/managed-worktree`, {
      method: "DELETE",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": deleteKey,
        "if-match": revision,
      },
      body: JSON.stringify({ confirmedForeground: true }),
    });
    assert.equal(removed.status, 202);
    assert.deepEqual(app.calls, [
      "git-review:device-authorized-12345678:workspace-1",
      `git-worktree-create:device-authorized-12345678:workspace-1:${createKey}`,
      `git-worktree-delete:device-authorized-12345678:workspace-2:${revision}:${deleteKey}`,
    ]);
  } finally {
    await app.close();
  }
});

test("authenticated scheduled-task routes enforce capability and mutation preconditions", async () => {
  const app = await fixture({ capabilities: ["schedule:read", "schedule:write"] });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const key = "schedule-action-key-0001";
  try {
    const listed = await fetch(`${app.base}/scheduled-tasks`, { headers });
    assert.equal(listed.status, 200);

    const scripts = await fetch(`${app.base}/scheduled-tasks/scripts?workspaceId=workspace-1`, { headers });
    assert.equal(scripts.status, 200);
    assert.match((await scripts.json()).scripts[0].id, /^script_/u);

    const mcpServers = await fetch(`${app.base}/scheduled-tasks/mcp-servers`, { headers });
    assert.equal(mcpServers.status, 200);
    assert.deepEqual(await mcpServers.json(), { servers: [{ id: "mcp-1", name: "GitHub" }] });

    const created = await fetch(`${app.base}/scheduled-tasks`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        name: "Daily", schedule: "0 8 * * *", timezone: "UTC", mode: "llm",
        permission: "read-only", prompt: "Summarize", confirmedForeground: true,
      }),
    });
    assert.equal(created.status, 201);

    const missingRevision = await fetch(`${app.base}/scheduled-tasks/task-1/pause`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
    });
    assert.equal(missingRevision.status, 400);

    const paused = await fetch(`${app.base}/scheduled-tasks/task-1/pause`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": key, "if-match": "rev-task-1" },
    });
    assert.equal(paused.status, 202);

    const run = await fetch(`${app.base}/scheduled-tasks/task-1/run`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
    });
    assert.equal(run.status, 202);
    assert.equal((await run.json()).runId, "run-1");

    const history = await fetch(`${app.base}/scheduled-tasks/task-1/runs`, { headers });
    assert.equal(history.status, 200);
    assert.deepEqual(app.calls, [
      "schedule-list:device-authorized-12345678",
      "schedule-scripts:device-authorized-12345678:workspace-1",
      `schedule-create:device-authorized-12345678:${key}`,
      `schedule-pause:device-authorized-12345678:task-1:rev-task-1:${key}`,
      `schedule-run:device-authorized-12345678:task-1:${key}`,
      "schedule-runs:task-1",
    ]);
  } finally {
    await app.close();
  }
});

test("workspace routes reject query aliases, duplicate query keys, and missing mutation preconditions", async () => {
  const app = await fixture({
    capabilities: ["workspace:read", "workspace:manage", "workspace:browse"],
  });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const aliased = await fetch(`${app.base}/workspaces?workspaceId=secret`, { headers });
    assert.equal(aliased.status, 400);
    assert.equal((await aliased.json()).error.code, "invalid_request");

    const location = `loc_${"l".repeat(43)}`;
    const duplicate = await fetch(
      `${app.base}/workspace-browser/children?location=${location}&location=${location}`,
      { headers },
    );
    assert.equal(duplicate.status, 400);

    const missingRevision = await fetch(`${app.base}/workspaces/workspace-1`, {
      method: "DELETE",
      headers,
    });
    assert.equal(missingRevision.status, 400);

    const encodedAlias = await fetch(
      `${app.base}/workspace-browser/children?location=loc_%61${"a".repeat(42)}`,
      { headers },
    );
    assert.equal(encodedAlias.status, 400);
  } finally {
    await app.close();
  }
});

test("revoked and capability-limited credentials fail with stable classifications", async () => {
  for (const [mode, code] of [
    ["revoked", "credential_revoked"],
    ["denied", "capability_denied"],
    ["invalid", "authentication_required"],
  ] as const) {
    const app = await fixture({ authenticate: mode });
    try {
      const response = await fetch(`${app.base}/server`, {
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          "aiden-protocol-version": "1",
        },
      });
      assert.equal((await response.json()).error.code, code);
    } finally {
      await app.close();
    }
  }
});

test("a body stalled across revocation cannot admit a turn after authorization is blocked", async () => {
  let blocked = false;
  const app = await fixture({
    capabilities: ["chat:write"],
    authorizationBlocked: () => blocked,
  });
  try {
    const target = new URL(`${app.base}/chats/chat-1/turns`);
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          "aiden-protocol-version": "1",
          "content-type": "application/json",
          "idempotency-key": "turn-stalled-revocation-0001",
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({
          status: incoming.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.once("error", reject);
      request.write("{");
      blocked = true;
      request.end("}");
    });
    const result = await response;
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.body).error.code, "credential_revoked");
    assert.equal(app.calls.some((entry) => entry.startsWith("turn:")), false);
  } finally {
    await app.close();
  }
});

test("pairing rejects duplicate JSON fields, browser origins, and oversized bodies", async () => {
  const app = await fixture();
  try {
    const duplicate = await fetch(`${app.base}/pairing/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"secret":"${"x".repeat(43)}","secret":"${"y".repeat(43)}"}`,
    });
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).error.code, "invalid_request");

    const browser = await fetch(`${app.base}/health`, {
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(browser.status, 403);

    const oversized = await fetch(`${app.base}/pairing/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(1_048_576) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "payload_too_large");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.logs.length, 3);
  } finally {
    await app.close();
  }
});

test("manual pairing bootstrap is bounded, origin-rejecting, and does not accept input", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/pairing/manual-bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.kind, "aiden-manual-pairing-v1");
    assert.equal("secret" in body, false);
    assert.equal("manualCode" in body, false);

    const withInput = await fetch(`${app.base}/pairing/manual-bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"code":"do-not-send-codes"}',
    });
    assert.equal(withInput.status, 400);
    assert.equal((await withInput.json()).error.code, "invalid_request");

    const browser = await fetch(`${app.base}/pairing/manual-bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(browser.status, 403);
  } finally {
    await app.close();
  }
});

test("unknown routes and query aliases fail without reflecting untrusted input", async () => {
  const app = await fixture();
  try {
    const canary = "do-not-reflect-this-secret";
    const response = await fetch(`${app.base}/health?value=${canary}`);
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.equal(body.includes(canary), false);
    const missing = await fetch(`${app.base}/missing`);
    assert.equal((await missing.json()).error.code, "not_found");
  } finally {
    await app.close();
  }
});
