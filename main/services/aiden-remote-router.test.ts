import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import type { AidenRemoteRetainedBotChatAuthorizationRequest } from "./aiden-remote-chats.js";
import {
  AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES,
  type AidenRemoteCapability,
} from "./aiden-remote-protocol.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../renderer/shared/bot-capabilities.js";

async function fixture(options: {
  authenticate?: "valid" | "revoked" | "denied" | "invalid";
  capabilities?: AidenRemoteCapability[];
  acceptsBotCapabilities?: boolean;
  authorizationBlocked?: () => boolean;
  botChat?: boolean;
  botArchived?: boolean;
  botChatAuthorization?: (
    request: Readonly<AidenRemoteRetainedBotChatAuthorizationRequest>,
  ) => boolean | Promise<boolean>;
  chatClassification?: "present" | "missing" | "error";
  chatPayloadError?: "reconciling";
  oversizedChatResponse?: boolean;
} = {}) {
  const logs: unknown[] = [];
  const calls: string[] = [];
  let notice: import("../../renderer/shared/bot-capabilities.js").BotNoticeStatus = {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    requiresAcknowledgement: true,
  };
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
    ...(options.botChat ? { botId: "bot-1" } : {}),
    title: "Chat",
    providerId: "provider-1",
    modelId: "model-1",
    messages: options.oversizedChatResponse
      ? Array.from({ length: 6 }, (_, index) => ({
          id: `message-${index}`,
          role: index % 2 === 0 ? "user" as const : "assistant" as const,
          text: "x".repeat(190_000),
          createdAt: new Date(1_100 + index).toISOString(),
        }))
      : [],
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    revision: `rev_${"c".repeat(43)}`,
  };
  const botAccess = {
    botId: "bot-1",
    accessMode: "full" as const,
    revision: "bot_policy_revision_1",
    policyEpoch: "bot_policy_epoch_1",
    summary: "Can use your Mac, shell, enabled connections, and skills.",
  };
  const botDetail = {
    id: "bot-1",
    name: "Planner",
    purpose: "Keeps projects moving",
    instructions: "Help plan projects.",
    avatar: { semantic: "spark" as const },
    health: "ready" as const,
    access: botAccess,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    revision: "bot_revision_1",
  };
  const favorites = { botIds: ["bot-1"], revision: "bot_favorites_revision_1" };
  const authorizeRetainedBotChat = async (
    input: Readonly<AidenRemoteRetainedBotChatAuthorizationRequest>,
  ): Promise<boolean> => {
    calls.push(`bot-authorize:${input.access}:${input.deviceId}:${input.chatId}:${input.botId}`);
    try {
      return (await options.botChatAuthorization?.(input)) === true;
    } catch {
      return false;
    }
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
          name: "iPhone",
          revoked: options.authenticate === "revoked",
          acceptsBotCapabilities: options.acceptsBotCapabilities === true,
          capabilities: new Set(
            options.authenticate === "denied"
              ? []
              : (options.capabilities ?? ["server:read" as const]),
          ),
        };
      },
      updateDeviceName: async (deviceId, name) => {
        calls.push(`device-identity:${deviceId}:${name}`);
        return {
          id: deviceId,
          name,
          type: "iphone" as const,
          clientVersion: "1.0",
          capabilities: options.capabilities ?? ["server:read" as const],
          createdAt: 500,
          lastSeenAt: 1_000,
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
      classify: async (id) => {
        calls.push(`chat-classify:${id}`);
        if (options.chatClassification === "missing") {
          throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
        }
        if (options.chatClassification === "error") throw new Error("metadata unavailable");
        return options.botChat
          ? {
              botId: "bot-1",
              ...(options.botArchived ? { botArchived: true as const } : {}),
            }
          : {};
      },
      authorizeRetainedBotChat,
      runMutation: async <T>(
        deviceId: string,
        id: string,
        classification: { botId?: string; botArchived?: true },
        action: () => Promise<T>,
      ): Promise<T> => {
        calls.push(`chat-mutation:${id}`);
        if (
          classification.botId &&
          !(await authorizeRetainedBotChat({
            deviceId,
            chatId: id,
            botId: classification.botId,
            access: "write",
          }))
        ) {
          throw new AidenRemoteServiceError(
            "not_found",
            "This Aiden chat no longer exists.",
            404,
          );
        }
        if (options.botArchived) {
          throw new AidenRemoteServiceError(
            "bot_archived",
            "Restore this bot before making changes.",
            409,
          );
        }
        return action();
      },
      get: async (id) => {
        calls.push(`chat-get:${id}`);
        if (options.chatPayloadError === "reconciling") {
          throw new AidenRemoteServiceError(
            "operation_in_progress",
            "This chat is still reconciling.",
            409,
            true,
          );
        }
        return { ...chat, id };
      },
      create: async (deviceId, key) => {
        calls.push(`chat-create:${deviceId}:${key}`);
        return chat;
      },
      rename: async (id, revision) => {
        calls.push(`chat-rename:${id}:${revision}`);
        return { ...chat, id, title: "Renamed" };
      },
      move: async (deviceId, id, revision, key) => {
        if (options.botChat) {
          throw new AidenRemoteServiceError(
            "not_found",
            "This Aiden chat no longer exists.",
            404,
          );
        }
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
      uploadAttachment: async (deviceId, id) => {
        calls.push(`attachment-upload:${deviceId}:${id}`);
        return {
          id: `att_${"a".repeat(43)}`,
          name: "fixture.png",
          mimeType: "image/png",
          kind: "image" as const,
          size: 12,
          expiresAt: new Date(60_000).toISOString(),
        };
      },
      removeAttachment: async (deviceId, id, attachmentId) => {
        calls.push(`attachment-remove:${deviceId}:${id}:${attachmentId}`);
      },
      attachmentContent: async (id, attachmentId) => {
        calls.push(`attachment-content:${id}:${attachmentId}`);
        return { bytes: Buffer.from("fixture"), mimeType: "image/png" };
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
    botNotice: {
      status: async (deviceId) => {
        calls.push(`bot-notice:status:${deviceId}`);
        return notice;
      },
      acknowledge: async (deviceId, acknowledgement) => {
        calls.push(
          `bot-notice:ack:${deviceId}:${acknowledgement.decision}`,
        );
        notice = {
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          requiresAcknowledgement: false,
          acceptedAt: new Date(1_000).toISOString(),
          acceptedDecision: acknowledgement.decision,
        };
        return notice;
      },
    },
    bots: {
      list: async (includeArchived) => {
        calls.push(`bots:list:${includeArchived}`);
        return { bots: [botDetail], maxBots: 256, favorites };
      },
      get: async (botId) => {
        calls.push(`bots:get:${botId}`);
        return { ...botDetail, id: botId, access: { ...botAccess, botId } };
      },
      create: async (deviceId, key) => {
        calls.push(`bots:create:${deviceId}:${key}`);
        return botDetail;
      },
      updateIdentity: async (botId, revision) => {
        calls.push(`bots:update:${botId}:${revision}`);
        return { ...botDetail, id: botId, revision: "bot_revision_2" };
      },
      archive: async (botId, revision) => {
        calls.push(`bots:archive:${botId}:${revision}`);
        return {
          ...botDetail,
          id: botId,
          health: "archived" as const,
          archivedAt: new Date(3_000).toISOString(),
          revision: "bot_revision_2",
        };
      },
      restore: async (deviceId, botId, revision, key) => {
        calls.push(`bots:restore:${deviceId}:${botId}:${revision}:${key}`);
        return { ...botDetail, id: botId, revision: "bot_revision_3" };
      },
      capabilityCatalog: async (deviceId) => {
        calls.push(`bots:catalog:${deviceId}`);
        return {
          revision: "bot_catalog_revision_1",
          providers: [],
          fileScopes: [],
          shellAvailable: true,
          connections: [],
          skills: [],
          otherCapabilities: [],
          notice,
        };
      },
      updateAccess: async (deviceId, botId, revision) => {
        calls.push(`bots:access:${deviceId}:${botId}:${revision}`);
        return { ...botAccess, botId, revision: "bot_policy_revision_2" };
      },
      createChat: async (deviceId, botId, key) => {
        calls.push(`bots:chat:${deviceId}:${botId}:${key}`);
        return { ...chat, botId };
      },
      getChatAccess: async (chatId) => {
        calls.push(`bots:chat-access-get:${chatId}`);
        return {
          chatId,
          botId: "bot-1",
          mode: "inherit" as const,
          revision: "bot_chat_policy_revision_1",
          botPolicyRevision: botAccess.revision,
          summary: "Full",
        };
      },
      updateChatAccess: async (deviceId, chatId, revision) => {
        calls.push(`bots:chat-access:${deviceId}:${chatId}:${revision}`);
        return {
          chatId,
          botId: "bot-1",
          mode: "inherit" as const,
          revision: "bot_chat_policy_revision_2",
          botPolicyRevision: botAccess.revision,
          summary: "Full",
        };
      },
      favorites: async () => {
        calls.push("bots:favorites:get");
        return favorites;
      },
      updateFavorites: async (revision) => {
        calls.push(`bots:favorites:update:${revision}`);
        return { ...favorites, revision: "bot_favorites_revision_2" };
      },
      listConversations: async (deviceId, input) => {
        calls.push(`bots:conversations:${deviceId}:${input.query ?? ""}`);
        return {
          conversations: [{
            chatId: "chat-1",
            botId: "bot-1",
            title: "Plan",
            activityState: "waiting_for_approval" as const,
            canRespondToApproval: true,
            createdAt: new Date(1_000).toISOString(),
            updatedAt: new Date(2_000).toISOString(),
            revision: "chat_revision_1",
          }],
        };
      },
      putAvatar: async (deviceId, botId, revision, key) => {
        calls.push(`bots:avatar:put:${deviceId}:${botId}:${revision}:${key}`);
        return {
          assetRevision: `avatar_revision_${"a".repeat(32)}`,
          mimeType: "image/png" as const,
          width: 512 as const,
          height: 512 as const,
          byteSize: 7,
        };
      },
      deleteAvatar: async (botId, revision) => {
        calls.push(`bots:avatar:delete:${botId}:${revision}`);
        return { ...botDetail, id: botId };
      },
      avatarContent: async (botId, assetRevision) => {
        calls.push(`bots:avatar:content:${botId}:${assetRevision}`);
        return {
          metadata: {
            assetRevision,
            mimeType: "image/png" as const,
            width: 512 as const,
            height: 512 as const,
            byteSize: 7,
          },
          bytes: Buffer.from("pngdata"),
        };
      },
    },
    streams: {
      streamChatId: () => "chat-1",
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
      approvalChatId: () => "chat-1",
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
    assert.deepEqual(server.capabilities, ["server:read"]);
    assert.equal(server.deviceName, "iPhone");
    assert.equal("serverCapabilities" in server, false);
    assert.equal(JSON.stringify(server).includes("credential"), false);
  } finally {
    await app.close();
  }
});

test("Bot-aware server projection separates supported capabilities from device grants", async () => {
  const app = await fixture({
    capabilities: ["server:read"],
    acceptsBotCapabilities: true,
  });
  try {
    const response = await fetch(`${app.base}/server`, {
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(response.status, 200);
    const server = await response.json();
    assert.deepEqual(server.capabilities, ["server:read"]);
    assert.equal(server.serverCapabilities.includes("bot:read"), true);
    assert.equal(server.serverCapabilities.includes("bot:write"), true);
    assert.notDeepEqual(server.serverCapabilities, server.capabilities);
  } finally {
    await app.close();
  }
});

test("an authenticated client can refresh only its own display identity", async () => {
  const app = await fixture();
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
    "content-type": "application/json",
  };
  try {
    const response = await fetch(`${app.base}/device/identity`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "  Sambit’s   iPhone  " }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: "Sambit’s iPhone" });
    assert.deepEqual(app.calls, [
      "device-identity:device-authorized-12345678:Sambit’s iPhone",
    ]);

    const unexpectedField = await fetch(`${app.base}/device/identity`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Phone", cloudId: "not-accepted" }),
    });
    assert.equal(unexpectedField.status, 400);

    const controlCharacter = await fetch(`${app.base}/device/identity`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Bad\u0000Name" }),
    });
    assert.equal(controlCharacter.status, 400);
  } finally {
    await app.close();
  }
});

test("paired devices explicitly acknowledge the one-time Bot notice under their stable device id", async () => {
  const app = await fixture({ capabilities: ["bot:read", "bot:write"] });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const pending = await fetch(`${app.base}/bot-access-notice`, { headers });
    assert.equal(pending.status, 200);
    assert.deepEqual(await pending.json(), {
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: true,
    });

    const accepted = await fetch(
      `${app.base}/bot-access-notice/acknowledgement`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          decision: "customize_first",
          confirmedForeground: true,
        }),
      },
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: false,
      acceptedAt: new Date(1_000).toISOString(),
      acceptedDecision: "customize_first",
    });

    const reread = await fetch(`${app.base}/bot-access-notice`, { headers });
    assert.equal(reread.status, 200);
    assert.equal((await reread.json()).acceptedDecision, "customize_first");
    assert.deepEqual(app.calls.filter((call) => call.startsWith("bot-notice:")), [
      "bot-notice:status:device-authorized-12345678",
      "bot-notice:ack:device-authorized-12345678:customize_first",
      "bot-notice:status:device-authorized-12345678",
    ]);
  } finally {
    await app.close();
  }
});

test("Bot notice acknowledgement requires both Bot grants and exact foreground disclosure", async () => {
  const app = await fixture({ capabilities: ["bot:write"] });
  try {
    const response = await fetch(
      `${app.base}/bot-access-notice/acknowledgement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          "aiden-protocol-version": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          decision: "continue_full",
          confirmedForeground: false,
        }),
      },
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_request");
    assert.equal(app.calls.some((call) => call.startsWith("bot-notice:ack:")), false);

    const disclosed = await fetch(
      `${app.base}/bot-access-notice/acknowledgement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          "aiden-protocol-version": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          decision: "continue_full",
          confirmedForeground: true,
        }),
      },
    );
    assert.equal(disclosed.status, 403);
    assert.equal((await disclosed.json()).error.code, "capability_denied");
    assert.equal(app.calls.some((call) => call.startsWith("bot-notice:ack:")), false);
  } finally {
    await app.close();
  }
});

test("Bot grants do not imply support-vocabulary negotiation for a legacy device", async () => {
  const app = await fixture({ capabilities: ["server:read", "bot:read"] });
  try {
    const response = await fetch(`${app.base}/server`, {
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(response.status, 200);
    const server = await response.json();
    assert.deepEqual(server.capabilities, ["server:read", "bot:read"]);
    assert.equal("serverCapabilities" in server, false);
  } finally {
    await app.close();
  }
});

test("authenticated Bot routes enforce the frozen CRUD, access, chat, and favorites contract", async () => {
  const app = await fixture({
    capabilities: ["bot:read", "bot:write", "chat:read", "chat:write"],
  });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${app.base}/bots?includeArchived=true`, { headers })).status, 200);
    assert.equal((await fetch(`${app.base}/bot-capabilities`, { headers })).status, 200);
    assert.equal((await fetch(`${app.base}/bot-favorites`, { headers })).status, 200);

    const created = await fetch(`${app.base}/bots`, {
      method: "POST",
      headers: { ...jsonHeaders, "idempotency-key": "bot-create-key-0001" },
      body: JSON.stringify({
        name: "Planner",
        purpose: "Plans",
        instructions: "Plan carefully.",
        avatar: "spark",
        access: {
          accessMode: "full",
          catalogRevision: "bot_catalog_revision_1",
          confirmedForeground: true,
        },
      }),
    });
    assert.equal(created.status, 201);

    assert.equal((await fetch(`${app.base}/bots/bot-1`, { headers })).status, 200);
    assert.equal((await fetch(`${app.base}/bots/bot-1`, {
      method: "PATCH",
      headers: { ...jsonHeaders, "if-match": "bot_revision_1" },
      body: JSON.stringify({ name: "Updated" }),
    })).status, 200);
    assert.equal((await fetch(`${app.base}/bots/bot-1/capabilities`, {
      method: "PATCH",
      headers: { ...jsonHeaders, "if-match": "bot_policy_revision_1" },
      body: JSON.stringify({
        accessMode: "full",
        catalogRevision: "bot_catalog_revision_1",
        confirmedForeground: true,
      }),
    })).status, 200);
    assert.equal((await fetch(`${app.base}/bots/bot-1/chats`, {
      method: "POST",
      headers: { ...jsonHeaders, "idempotency-key": "bot-chat-key-00001" },
      body: JSON.stringify({}),
    })).status, 201);
    assert.equal((await fetch(`${app.base}/chats/chat-1/capabilities`, { headers })).status, 200);
    assert.equal((await fetch(`${app.base}/chats/chat-1/capabilities`, {
      method: "PATCH",
      headers: { ...jsonHeaders, "if-match": "bot_chat_policy_revision_1" },
      body: JSON.stringify({
        mode: "inherit",
        catalogRevision: "bot_catalog_revision_1",
        expectedBotPolicyRevision: "bot_policy_revision_1",
      }),
    })).status, 200);
    assert.equal((await fetch(`${app.base}/bot-favorites`, {
      method: "PATCH",
      headers: { ...jsonHeaders, "if-match": "bot_favorites_revision_1" },
      body: JSON.stringify({ botIds: ["bot-1"] }),
    })).status, 200);
    assert.equal((await fetch(`${app.base}/bots/bot-1`, {
      method: "DELETE",
      headers: { ...headers, "if-match": "bot_revision_2" },
    })).status, 200);
    assert.equal((await fetch(`${app.base}/bots/bot-1/restore`, {
      method: "POST",
      headers: {
        ...headers,
        "if-match": "bot_revision_2",
        "idempotency-key": "bot-restore-key-001",
      },
    })).status, 200);

    assert.deepEqual(app.calls.filter((call) => call.startsWith("bots:")), [
      "bots:list:true",
      "bots:catalog:device-authorized-12345678",
      "bots:favorites:get",
      "bots:create:device-authorized-12345678:bot-create-key-0001",
      "bots:get:bot-1",
      "bots:update:bot-1:bot_revision_1",
      "bots:access:device-authorized-12345678:bot-1:bot_policy_revision_1",
      "bots:chat:device-authorized-12345678:bot-1:bot-chat-key-00001",
      "bots:chat-access-get:chat-1",
      "bots:chat-access:device-authorized-12345678:chat-1:bot_chat_policy_revision_1",
      "bots:favorites:update:bot_favorites_revision_1",
      "bots:archive:bot-1:bot_revision_2",
      "bots:restore:device-authorized-12345678:bot-1:bot_revision_2:bot-restore-key-001",
    ]);
  } finally {
    await app.close();
  }
});

test("Bot inbox and avatar routes preserve device grants, approval ownership, and binary headers", async () => {
  const app = await fixture({
    capabilities: ["bot:read", "bot:write", "chat:read"],
  });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const inbox = await fetch(
      `${app.base}/bot-conversations?query=plan+week&limit=10`,
      { headers },
    );
    assert.equal(inbox.status, 200);
    assert.equal((await inbox.json()).conversations[0].canRespondToApproval, true);

    const uploaded = await fetch(`${app.base}/bots/bot-1/avatar`, {
      method: "PUT",
      headers: {
        ...headers,
        "content-type": "application/json",
        "if-match": "bot_revision_1",
        "idempotency-key": "bot-avatar-put-key-0001",
      },
      body: JSON.stringify({ mimeType: "image/png", data: "aVZCTw==" }),
    });
    assert.equal(uploaded.status, 200);
    const metadata = await uploaded.json();
    assert.equal(metadata.mimeType, "image/png");

    const content = await fetch(
      `${app.base}/bots/bot-1/avatar/${metadata.assetRevision}`,
      { headers },
    );
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "image/png");
    assert.equal(content.headers.get("cache-control"), "no-store");
    assert.equal(content.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await content.text(), "pngdata");

    const deleted = await fetch(`${app.base}/bots/bot-1/avatar`, {
      method: "DELETE",
      headers: { ...headers, "if-match": metadata.assetRevision },
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(
      app.calls.filter(
        (call) =>
          call.startsWith("bots:conversations:") ||
          call.startsWith("bots:avatar:"),
      ),
      [
        "bots:conversations:device-authorized-12345678:plan week",
        "bots:avatar:put:device-authorized-12345678:bot-1:bot_revision_1:bot-avatar-put-key-0001",
        `bots:avatar:content:bot-1:${metadata.assetRevision}`,
        `bots:avatar:delete:bot-1:${metadata.assetRevision}`,
      ],
    );
  } finally {
    await app.close();
  }

  const denied = await fixture({ capabilities: ["bot:read"] });
  try {
    const response = await fetch(`${denied.base}/bot-conversations`, {
      headers,
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "capability_denied");
    assert.equal(
      denied.calls.some((call) => call.startsWith("bots:conversations:")),
      false,
    );
  } finally {
    await denied.close();
  }
});

test("Bot mutations require every declared device grant before body effects", async () => {
  const app = await fixture({ capabilities: ["bot:write", "chat:write"] });
  try {
    const response = await fetch(`${app.base}/bots`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "aiden-protocol-version": "1",
        "content-type": "application/json",
        "idempotency-key": "bot-create-key-0002",
      },
      body: JSON.stringify({ unexpected: true }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "capability_denied");
    assert.equal(app.calls.some((call) => call.startsWith("bots:create:")), false);
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

test("Bot chat routes require both device grants and main-owned policy authority", async () => {
  const revision = `rev_${"c".repeat(43)}`;
  const attachmentId = `att_${"a".repeat(43)}`;
  const baseCapabilities: AidenRemoteCapability[] = [
    "chat:read",
    "chat:write",
    "approval:respond",
  ];
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };

  const denied = await fixture({
    botChat: true,
    capabilities: baseCapabilities,
    botChatAuthorization: () => true,
    chatPayloadError: "reconciling",
  });
  try {
    const chat = await fetch(`${denied.base}/chats/chat-1`, { headers });
    assert.equal(chat.status, 404);
    assert.equal((await chat.json()).error.code, "not_found");

    const turn = await fetch(`${denied.base}/chats/chat-1/turns`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "bot-turn-denied-0001",
      },
      body: JSON.stringify({ text: "Hello" }),
    });
    assert.equal(turn.status, 404);

    const stream = await fetch(`${denied.base}/streams/stream-1`, { headers });
    assert.equal(stream.status, 404);

    const cancel = await fetch(`${denied.base}/streams/stream-1/cancel`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "bot-cancel-denied-01" },
    });
    assert.equal(cancel.status, 404);

    const approval = await fetch(`${denied.base}/approvals/approval-1/respond`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "bot-approval-denied-01",
      },
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(approval.status, 409);
    assert.equal((await approval.json()).error.code, "approval_expired");
    assert.deepEqual(denied.calls.filter((call) => /^(?:turn|cancel|approval):/u.test(call)), []);
    assert.equal(
      denied.calls.some((call) => call.startsWith("chat-get:")),
      false,
      "Bot denial must happen from metadata before an effectful/reconciling payload read.",
    );
    assert.equal(
      denied.calls.some((call) => call.startsWith("bot-authorize:")),
      false,
      "The policy seam cannot substitute for missing device grants.",
    );
  } finally {
    await denied.close();
  }

  const noAuthority = await fixture({
    botChat: true,
    capabilities: [...baseCapabilities, "bot:read", "bot:write"],
  });
  try {
    const chat = await fetch(`${noAuthority.base}/chats/chat-1`, { headers });
    assert.equal(chat.status, 404);
    assert.equal((await chat.json()).error.code, "not_found");

    const turn = await fetch(`${noAuthority.base}/chats/chat-1/turns`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "bot-no-authority-0001",
      },
      body: JSON.stringify({ text: "Must not run" }),
    });
    assert.equal(turn.status, 404);
    assert.deepEqual(
      noAuthority.calls.filter((call) => /^(?:chat-get|chat-mutation|turn):/u.test(call)),
      [],
      "Bot device grants must remain insufficient without main-owned policy authority.",
    );
  } finally {
    await noAuthority.close();
  }

  const writeOnly = await fixture({
    botChat: true,
    capabilities: [...baseCapabilities, "bot:write"],
    botChatAuthorization: () => true,
  });
  try {
    const rename = await fetch(`${writeOnly.base}/chats/chat-1`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "if-match": revision },
      body: JSON.stringify({ title: "Must stay hidden" }),
    });
    assert.equal(rename.status, 404);
    assert.equal(writeOnly.calls.some((call) => call.startsWith("chat-rename:")), false);
  } finally {
    await writeOnly.close();
  }

  const readOnly = await fixture({
    botChat: true,
    capabilities: [...baseCapabilities, "bot:read"],
    botChatAuthorization: () => true,
  });
  try {
    const chat = await fetch(`${readOnly.base}/chats/chat-1`, { headers });
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).botId, "bot-1");

    const content = await fetch(
      `${readOnly.base}/chats/chat-1/attachments/${attachmentId}/content`,
      { headers },
    );
    assert.equal(content.status, 200);

    const rename = await fetch(`${readOnly.base}/chats/chat-1`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "if-match": revision },
      body: JSON.stringify({ title: "Denied" }),
    });
    assert.equal(rename.status, 404);

    const upload = await fetch(`${readOnly.base}/chats/chat-1/attachments`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(upload.status, 404);
    assert.equal(readOnly.calls.some((call) => call.startsWith("chat-rename:")), false);
    assert.equal(readOnly.calls.some((call) => call.startsWith("attachment-upload:")), false);
  } finally {
    await readOnly.close();
  }

  const allowed = await fixture({
    botChat: true,
    capabilities: [...baseCapabilities, "bot:read", "bot:write"],
    botChatAuthorization: () => true,
  });
  try {
    const rename = await fetch(`${allowed.base}/chats/chat-1`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "if-match": revision },
      body: JSON.stringify({ title: "Allowed" }),
    });
    assert.equal(rename.status, 200);

    const turn = await fetch(`${allowed.base}/chats/chat-1/turns`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "bot-turn-allowed-0001",
      },
      body: JSON.stringify({ text: "Hello" }),
    });
    assert.equal(turn.status, 202);

    const cancel = await fetch(`${allowed.base}/streams/stream-1/cancel`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "bot-cancel-allowed-01" },
    });
    assert.equal(cancel.status, 202);

    const approval = await fetch(`${allowed.base}/approvals/approval-1/respond`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "bot-approval-allowed-01",
      },
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(approval.status, 200);
    assert.equal(allowed.calls.some((call) => call.startsWith("chat-rename:")), true);
    assert.equal(allowed.calls.some((call) => call.startsWith("turn:")), true);
    assert.equal(allowed.calls.some((call) => call.startsWith("cancel:")), true);
    assert.equal(allowed.calls.some((call) => call.startsWith("approval:")), true);
  } finally {
    await allowed.close();
  }
});

test("Bot write authority is rechecked inside the mutation gate before effects", async () => {
  let writeChecks = 0;
  const app = await fixture({
    botChat: true,
    capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"],
    botChatAuthorization: (request) => {
      if (request.access !== "write") return true;
      writeChecks += 1;
      return writeChecks === 1;
    },
  });
  try {
    const response = await fetch(`${app.base}/chats/chat-1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "aiden-protocol-version": "1",
        "content-type": "application/json",
        "idempotency-key": "bot-policy-race-0001",
      },
      body: JSON.stringify({ text: "Must not run after narrowing" }),
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
    assert.equal(writeChecks, 2);
    assert.equal(app.calls.includes("chat-mutation:chat-1"), true);
    assert.equal(app.calls.some((call) => call.startsWith("turn:")), false);
  } finally {
    await app.close();
  }
});

test("ordinary move-to-workspace rejects authorized Bot chats", async () => {
  const app = await fixture({
    botChat: true,
    capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"],
    botChatAuthorization: () => true,
  });
  try {
    const response = await fetch(`${app.base}/chats/chat-1/move`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "aiden-protocol-version": "1",
        "content-type": "application/json",
        "if-match": `rev_${"c".repeat(43)}`,
        "idempotency-key": "bot-move-blocked-0001",
      },
      body: JSON.stringify({ workspaceId: "workspace-2", confirmedForeground: true }),
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
    assert.equal(app.calls.some((call) => call.startsWith("chat-move:")), false);
  } finally {
    await app.close();
  }
});

test("authorized archived Bot chats preserve reads and reject every retained mutation", async () => {
  const revision = `rev_${"c".repeat(43)}`;
  const attachmentId = `att_${"a".repeat(43)}`;
  const app = await fixture({
    botChat: true,
    botArchived: true,
    capabilities: [
      "chat:read",
      "chat:write",
      "approval:respond",
      "bot:read",
      "bot:write",
    ],
    botChatAuthorization: () => true,
  });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };

  try {
    for (const path of [
      "/chats/chat-1",
      `/chats/chat-1/attachments/${attachmentId}/content`,
      "/streams/stream-1",
      "/streams/stream-1/approval",
      "/streams/stream-1/events",
    ]) {
      const response = await fetch(`${app.base}${path}`, { headers });
      assert.equal(response.status, 200, `${path} remains readable while archived`);
      await response.arrayBuffer();
    }

    const mutations: Array<{
      path: string;
      method: "PATCH" | "POST" | "DELETE";
      headers?: Record<string, string>;
      body?: string;
    }> = [
      {
        path: "/chats/chat-1",
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": revision },
        body: JSON.stringify({ title: "Archived" }),
      },
      {
        path: "/chats/chat-1",
        method: "DELETE",
        headers: { "if-match": revision },
      },
      {
        path: "/chats/chat-1/move",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": revision,
          "idempotency-key": "archived-move-0001",
        },
        body: JSON.stringify({ workspaceId: "workspace-2", confirmedForeground: true }),
      },
      {
        path: "/chats/chat-1/turns",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "archived-turn-0001",
        },
        body: JSON.stringify({ text: "Do not run" }),
      },
      {
        path: "/chats/chat-1/attachments",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      {
        path: `/chats/chat-1/attachments/${attachmentId}`,
        method: "DELETE",
      },
      {
        path: "/streams/stream-1/cancel",
        method: "POST",
        headers: { "idempotency-key": "archived-cancel-01" },
      },
      {
        path: "/approvals/approval-1/respond",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "archived-approval-1",
        },
        body: JSON.stringify({ decision: "deny" }),
      },
    ];

    for (const mutation of mutations) {
      const response = await fetch(`${app.base}${mutation.path}`, {
        method: mutation.method,
        headers: { ...headers, ...mutation.headers },
        ...(mutation.body !== undefined ? { body: mutation.body } : {}),
      });
      assert.equal(response.status, 409, mutation.path);
      assert.equal((await response.json()).error.code, "bot_archived", mutation.path);
    }

    assert.deepEqual(
      app.calls.filter((call) =>
        /^(?:chat-rename|chat-remove|chat-move|turn|attachment-upload|attachment-remove|cancel|approval):/u.test(call)),
      [],
    );
  } finally {
    await app.close();
  }
});

test("oversized JSON projections fail safely before success headers are committed", async () => {
  const app = await fixture({
    capabilities: ["chat:read"],
    oversizedChatResponse: true,
  });
  try {
    const response = await fetch(`${app.base}/chats/chat-1`, {
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "aiden-protocol-version": "1",
      },
    });
    const body = await response.text();
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(body).error.code, "payload_too_large");
    assert.ok(Buffer.byteLength(body, "utf8") < AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES);
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body, "utf8")));
    assert.equal(app.calls.includes("chat-get:chat-1"), true);
  } finally {
    await app.close();
  }
});

test("chat classification failures normalize retained chat, stream, SSE, and approval identifiers", async () => {
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const capabilities: AidenRemoteCapability[] = [
    "chat:read",
    "chat:write",
    "approval:respond",
  ];

  for (const chatClassification of ["missing", "error"] as const) {
    const app = await fixture({ capabilities, chatClassification });
    try {
      const chat = await fetch(`${app.base}/chats/chat-1`, { headers });
      assert.equal(chat.status, 404);
      assert.equal((await chat.json()).error.code, "not_found");

      const stream = await fetch(`${app.base}/streams/stream-1`, { headers });
      assert.equal(stream.status, 404);
      assert.equal((await stream.json()).error.code, "not_found");

      const events = await fetch(`${app.base}/streams/stream-1/events`, { headers });
      assert.equal(events.status, 404);
      assert.equal((await events.json()).error.code, "not_found");

      const approvalSnapshot = await fetch(
        `${app.base}/streams/stream-1/approval`,
        { headers },
      );
      assert.equal(approvalSnapshot.status, 404);
      assert.equal((await approvalSnapshot.json()).error.code, "not_found");

      const cancel = await fetch(`${app.base}/streams/stream-1/cancel`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": `classification-${chatClassification}-cancel` },
      });
      assert.equal(cancel.status, 404);
      assert.equal((await cancel.json()).error.code, "not_found");

      const approval = await fetch(`${app.base}/approvals/approval-1/respond`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": `classification-${chatClassification}-approval`,
        },
        body: JSON.stringify({ decision: "deny" }),
      });
      assert.equal(approval.status, 409);
      assert.equal((await approval.json()).error.code, "approval_expired");

      assert.equal(app.calls.some((call) => call.startsWith("chat-get:")), false);
      assert.equal(app.calls.some((call) => call.startsWith("events:")), false);
      assert.equal(app.calls.some((call) => call.startsWith("cancel:")), false);
      assert.equal(app.calls.some((call) => call.startsWith("approval:")), false);
    } finally {
      await app.close();
    }
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

test("a stalled Bot mutation body is parsed before revocation admission", async () => {
  let blocked = false;
  const app = await fixture({
    capabilities: ["bot:read", "bot:write"],
    authorizationBlocked: () => blocked,
  });
  try {
    const target = new URL(`${app.base}/bots`);
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
          "idempotency-key": "bot-stalled-revocation-001",
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
    assert.equal(app.calls.some((entry) => entry.startsWith("bots:create:")), false);
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
