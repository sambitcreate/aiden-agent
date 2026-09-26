import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { connect } from "node:net";
import {
  AIDEN_REMOTE_ROUTE_TEMPLATES,
  createAidenRemoteRequestHandler,
  createAidenRemoteUpgradeHandler,
  remoteRouteTemplate,
} from "./aiden-remote-router.js";
import {
  AidenRemoteSimulatorRelay,
  type AidenRemoteSimulatorHost,
} from "./aiden-remote-simulators.js";
import type { AidenRemoteRouteLabel } from "./aiden-remote-router.js";
import type { AidenRemoteRetainedBotChatAuthorizationRequest } from "./aiden-remote-chats.js";
import {
  AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES,
  type AidenRemoteCapability,
  type AidenRemoteStreamInputResult,
} from "./aiden-remote-protocol.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES } from "./aiden-remote-speech-codec.js";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../renderer/shared/bot-capabilities.js";

async function fixture(options: {
  readAloud?: import("./aiden-remote-router.js").AidenRemoteRouterDependencies["readAloud"];
  authenticate?: "valid" | "revoked" | "denied" | "invalid";
  capabilities?: AidenRemoteCapability[];
  acceptsBotCapabilities?: boolean;
  acceptsProgressCapabilities?: boolean;
  progressAvailable?: boolean;
  authorizationBlocked?: () => boolean;
  botChat?: boolean;
  botArchived?: boolean;
  botChatAuthorization?: (
    request: Readonly<AidenRemoteRetainedBotChatAuthorizationRequest>,
  ) => boolean | Promise<boolean>;
  chatClassification?: "present" | "missing" | "error";
  chatPayloadError?: "reconciling";
  oversizedChatResponse?: boolean;
  approvalCanAllow?: boolean;
  approvalRequiredCapability?: AidenRemoteCapability;
  runInputAvailable?: boolean;
  questionsAvailable?: boolean;
  skillsAvailable?: boolean;
  deviceType?: "iphone" | "mac" | "linux";
  simulators?: AidenRemoteSimulatorRelay;
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
    memoryEnabled: true,
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
  const speechStatus = {
    engine: { ready: true, error: null },
    selectedModelId: "parakeet-v3",
    models: [{
      id: "parakeet-v3", name: "Parakeet", description: "Local speech",
      sizeLabel: "620 MB", quant: "int8", languagesLabel: "25 languages",
      accuracy: 0.8, speed: 0.85, recommended: true, installed: true,
    }],
    input: { encoding: "pcm_s16le" as const, sampleRate: 16_000 as const, channels: 1 as const, maximumSeconds: 60 as const, partialResults: false as const },
  };
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
  const dependencies: Parameters<typeof createAidenRemoteRequestHandler>[0] = {
    readAloud: options.readAloud,
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
          acceptsProgressCapabilities:
            options.acceptsProgressCapabilities === true,
          ...(options.deviceType ? { type: options.deviceType } : {}),
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
      upgradeDeviceCapabilities: async (deviceId, accepts) => {
        calls.push(`device-capabilities:${deviceId}:${accepts.join(",")}`);
        if (options.authenticate === "revoked") return null;
        if (
          accepts.some(
            (capability) =>
              capability !== "tasks:read" &&
              capability !== "agents:read" &&
              capability !== "questions:respond" &&
              capability !== "simulators:control",
          )
        ) {
          return null;
        }
        return {
          id: deviceId,
          name: "iPhone",
          type: "iphone" as const,
          clientVersion: "1.0",
          capabilities: [
            ...(options.capabilities ?? ["server:read" as const]),
            ...accepts,
          ] as AidenRemoteCapability[],
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
      ...(options.skillsAvailable === false
        ? {}
        : {
            chatSkillCatalog: async (deviceId, id) => {
              calls.push(`skill-catalog:${deviceId}:${id}`);
              return {
                skills: [
                  {
                    invocationId: `sk1_${"a".repeat(43)}`,
                    name: "review-code",
                    description: "Review changes.",
                    source: "workspace" as const,
                    available: true,
                  },
                ],
              };
            },
          }),
    },
    chatProgress: options.progressAvailable === false
      ? undefined
      : {
          taskSnapshot: async (_deviceId, chatId) => {
            calls.push(`task-snapshot:${chatId}`);
            return {
              version: 1,
              chatId,
              availability: "ready" as const,
              epoch: "epoch_fixture_01",
              revision: 3,
              updatedAt: new Date(4_000).toISOString(),
              tasks: [],
            };
          },
          agentRoster: async (_deviceId, chatId, turnId) => {
            calls.push(`agent-roster:${chatId}:${turnId ?? ""}`);
            return {
              version: 1,
              chatId,
              ...(turnId === undefined ? {} : { turnId }),
              availability: "ready" as const,
              epoch: "epoch_fixture_01",
              revision: 2,
              updatedAt: new Date(4_000).toISOString(),
              agents: [],
            };
          },
          openEvents: async (_deviceId, chatId, grants, after, response) => {
            calls.push(`progress-events:${chatId}:${after}:${[...grants].join(",")}`);
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end();
          },
        },
    models: {
      list: async () => ({
        providers: [{
          id: "provider-1",
          label: "Provider",
          models: [{ id: "model-1", label: "Model", supportsImages: true }],
        }],
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
      capabilityCatalog: async (deviceId, botId) => {
        calls.push(`bots:catalog:${deviceId}:${botId ?? "generic"}`);
        if (botId === "bot-missing") {
          throw new AidenRemoteServiceError("not_found", "This Bot no longer exists.", 404);
        }
        return {
          revision: "bot_catalog_revision_1",
          providers: [],
          fileScopes: [],
          shellAvailable: true,
          connections: [],
          skills: botId === undefined
            ? []
            : [{ id: `skill_saved_${botId}`, label: "Saved skill", available: false }],
          skillsEnabled: false,
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
        canAllow: options.approvalCanAllow ?? false,
      }),
      approvalRequiredCapability: () =>
        options.approvalRequiredCapability,
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
      ...(options.runInputAvailable === false
        ? {}
        : {
            supportsRunInput: () => true,
            submitInput: async (
              deviceId: string,
              streamId: string,
              input: { mode: "steer" | "queue"; text: string },
              _key: string,
              runAccess?: (
                chatId: string,
                action: () => Promise<AidenRemoteStreamInputResult>,
              ) => Promise<AidenRemoteStreamInputResult>,
            ) => {
              calls.push(`input:${deviceId}:${streamId}:${input.mode}`);
              const result = {
                streamId,
                chatId: "chat-1",
                turnId: "turn-1",
                mode: input.mode,
                status: "admitted" as const,
                queue: input.mode === "steer" ? ("steer" as const) : ("follow-up" as const),
                committed: true,
                messageId: "message-remote-input-1",
              };
              if (runAccess) {
                return runAccess("chat-1", async () => result);
              }
              return result;
            },
          }),
      ...(options.questionsAvailable === false || options.progressAvailable === false
        ? {}
        : {
            supportsQuestionPrompts: () => true,
            pendingQuestion: (_deviceId: string, streamId: string) => ({
              promptId: "q-prompt-1",
              streamId,
              chatId: "chat-1",
              toolCallId: "tool-2",
              questions: [
                {
                  question: "Which chamfer?",
                  header: "Chamfer",
                  multiSelect: false,
                  options: [
                    { label: "0.5 mm", description: "Standard." },
                    { label: "1.0 mm", description: "Heavy." },
                  ],
                },
              ],
              expiresAt: new Date(60_000).toISOString(),
            }),
            respondQuestion: async (
              deviceId: string,
              promptId: string,
              input: { cancelled: boolean },
              _key: string,
              runAccess?: (
                chatId: string,
                action: () => Promise<{ promptId: string; resolvedAt: string }>,
              ) => Promise<{ promptId: string; resolvedAt: string }>,
            ) => {
              calls.push(`question:${deviceId}:${promptId}:${input.cancelled}`);
              const result = { promptId, resolvedAt: new Date(6_000).toISOString() };
              if (runAccess) {
                return runAccess("chat-1", async () => result);
              }
              return result;
            },
          }),
      respondApproval: async (
        deviceId,
        approvalId,
        decision,
        _key,
        runAccess?: (
          chatId: string,
          action: () => Promise<{
            approvalId: string;
            decision: "allow" | "deny";
            resolvedAt: string;
          }>,
        ) => Promise<{
          approvalId: string;
          decision: "allow" | "deny";
          resolvedAt: string;
        }>,
      ) => {
        const result = { approvalId, decision, resolvedAt: new Date(5_000).toISOString() };
        const action = async () => {
          calls.push(`approval:${deviceId}:${approvalId}:${decision}`);
          return result;
        };
        if (runAccess) {
          return runAccess("chat-1", action);
        }
        return action();
      },
      openEvents: (_deviceId, streamId, after, response) => {
        calls.push(`events:${streamId}:${after}`);
        const data = JSON.stringify({ streamId, sequence: after + 1 });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`id: ${after + 1}\ndata: ${data}\n\n`);
      },
    },
    files: {
      children: async (deviceId, workspaceId, directoryId, cursor) => {
        calls.push(`file-page:${deviceId}:${workspaceId}:${directoryId ?? "root"}:${cursor ?? "first"}`);
        return { snapshotId: "files-page", entries: [], truncated: false, maxEntries: 4_000 as const, maxDepth: 20 as const, directoryPath: "" };
      },
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
      run: async (deviceId, taskId, revision, key) => {
        calls.push(`schedule-run:${deviceId}:${taskId}:${revision}:${key}`);
        return { taskId, runId: "run-1", status: "accepted" as const, acceptedAt: new Date(1_000).toISOString() };
      },
      runs: async (taskId) => {
        calls.push(`schedule-runs:${taskId}`);
        return { runs: [] };
      },
      notifications: async (since) => {
        calls.push(`schedule-notifications:${since ?? ""}`);
        return { notifications: [], now: 2_000 };
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
    speech: {
      status: async () => {
        calls.push("speech:status");
        return speechStatus;
      },
      select: async (body) => {
        calls.push(`speech:select:${JSON.stringify(body)}`);
        return speechStatus;
      },
      startDownload: async (modelId) => {
        calls.push(`speech:download:${modelId}`);
        return speechStatus;
      },
      cancelDownload: async (modelId) => {
        calls.push(`speech:cancel:${modelId}`);
        return speechStatus;
      },
      deleteModel: async (modelId) => {
        calls.push(`speech:delete:${modelId}`);
        return speechStatus;
      },
      transcribe: async (body) => {
        calls.push(`speech:transcribe:${typeof body}`);
        return { text: "Hello from the Mac", modelId: "parakeet-v3" };
      },
    },
    connectionMode: () => "lan",
    now: () => 1_000,
    log: (entry) => logs.push(entry),
    ...(options.simulators ? { simulators: options.simulators } : {}),
  };
  const handler = createAidenRemoteRequestHandler(dependencies);
  const server = createServer(handler);
  server.on("upgrade", createAidenRemoteUpgradeHandler(dependencies));
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
    assert.equal(server.serverCapabilities.includes("tasks:read"), false);
    assert.equal(server.serverCapabilities.includes("agents:read"), false);
    assert.notDeepEqual(server.serverCapabilities, server.capabilities);
  } finally {
    await app.close();
  }
});

test("stream inputs advertise the run-input feature and gate on chat:write", async () => {
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const app = await fixture({
    capabilities: ["server:read", "chat:read", "chat:write"],
  });
  try {
    const server = await (await fetch(`${app.base}/server`, { headers })).json();
    assert.equal(server.features.includes("chat-run-input-v1"), true);

    const missingKey = await fetch(`${app.base}/streams/stream-1/inputs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ mode: "steer", text: "Now." }),
    });
    assert.equal(missingKey.status, 400);
    assert.equal(
      app.calls.some((call) => call.startsWith("input:")),
      false,
    );

    const admitted = await fetch(`${app.base}/streams/stream-1/inputs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "input-steer-key-0001" },
      body: JSON.stringify({ mode: "steer", text: "Prefer the cached path." }),
    });
    assert.equal(admitted.status, 200);
    const receipt = await admitted.json();
    assert.equal(receipt.status, "admitted");
    assert.equal(receipt.queue, "steer");
    assert.equal(receipt.committed, true);
    assert.equal(
      app.calls.some((call) => call === "input:device-authorized-12345678:stream-1:steer"),
      true,
    );
  } finally {
    await app.close();
  }

  const readOnly = await fixture({ capabilities: ["server:read", "chat:read"] });
  try {
    const denied = await fetch(`${readOnly.base}/streams/stream-1/inputs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "input-readonly-key-01" },
      body: JSON.stringify({ mode: "steer", text: "Denied." }),
    });
    assert.equal(denied.status, 403);
    assert.equal(
      readOnly.calls.some((call) => call.startsWith("input:")),
      false,
    );
  } finally {
    await readOnly.close();
  }

  const unavailable = await fixture({
    capabilities: ["server:read", "chat:read", "chat:write"],
    runInputAvailable: false,
  });
  try {
    const server = await (await fetch(`${unavailable.base}/server`, { headers })).json();
    assert.equal(server.features.includes("chat-run-input-v1"), false);
    const missing = await fetch(`${unavailable.base}/streams/stream-1/inputs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "input-absent-key-0001" },
      body: JSON.stringify({ mode: "queue", text: "Not wired." }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await unavailable.close();
  }
});

test("chat progress reads and its dedicated stream require negotiated grants", async () => {
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const legacy = await fixture({
    capabilities: ["server:read", "chat:read", "tasks:read"],
  });
  try {
    const serverResponse = await fetch(`${legacy.base}/server`, { headers });
    assert.equal(serverResponse.status, 200);
    const server = await serverResponse.json();
    assert.deepEqual(server.capabilities, ["server:read", "chat:read"]);
    assert.equal("serverCapabilities" in server, false);
    assert.equal(server.features.includes("chat-tasks-v1"), true);
    assert.equal(server.features.includes("chat-agents-v1"), true);

    const taskResponse = await fetch(`${legacy.base}/chats/chat-1/tasks`, { headers });
    assert.equal(taskResponse.status, 403);
    const eventsResponse = await fetch(
      `${legacy.base}/chats/chat-1/progress/events?after=0`,
      { headers },
    );
    assert.equal(eventsResponse.status, 403);
    assert.equal(legacy.calls.some((call) => call.startsWith("task-snapshot:")), false);
    assert.equal(legacy.calls.some((call) => call.startsWith("progress-events:")), false);
  } finally {
    await legacy.close();
  }

  const negotiated = await fixture({
    capabilities: ["server:read", "chat:read", "tasks:read", "agents:read"],
    acceptsProgressCapabilities: true,
  });
  try {
    const serverResponse = await fetch(`${negotiated.base}/server`, { headers });
    assert.equal(serverResponse.status, 200);
    const server = await serverResponse.json();
    assert.equal(server.serverCapabilities.includes("tasks:read"), true);
    assert.equal(server.serverCapabilities.includes("agents:read"), true);
    assert.equal(server.features.includes("chat-tasks-v1"), true);
    assert.equal(server.features.includes("chat-agents-v1"), true);

    const tasks = await fetch(`${negotiated.base}/chats/chat-1/tasks`, { headers });
    assert.equal(tasks.status, 200);
    assert.deepEqual(await tasks.json(), {
      version: 1,
      chatId: "chat-1",
      availability: "ready",
      epoch: "epoch_fixture_01",
      revision: 3,
      updatedAt: new Date(4_000).toISOString(),
      tasks: [],
    });

    const agents = await fetch(`${negotiated.base}/chats/chat-1/agents`, { headers });
    assert.equal(agents.status, 200);
    assert.deepEqual(await agents.json(), {
      version: 1,
      chatId: "chat-1",
      availability: "ready",
      epoch: "epoch_fixture_01",
      revision: 2,
      updatedAt: new Date(4_000).toISOString(),
      agents: [],
    });

    const historical = await fetch(
      `${negotiated.base}/chats/chat-1/agents?turnId=turn-archive`,
      { headers },
    );
    assert.equal(historical.status, 200);
    assert.equal((await historical.json()).turnId, "turn-archive");
    assert.equal(
      negotiated.calls.includes("agent-roster:chat-1:turn-archive"),
      true,
    );

    const duplicateQuery = await fetch(
      `${negotiated.base}/chats/chat-1/agents?turnId=turn-1&turnId=turn-2`,
      { headers },
    );
    assert.equal(duplicateQuery.status, 400);

    const progressEvents = await fetch(
      `${negotiated.base}/chats/chat-1/progress/events?after=7`,
      { headers },
    );
    assert.equal(progressEvents.status, 200);
    await progressEvents.text();
    assert.equal(
      negotiated.calls.includes(
        "progress-events:chat-1:7:tasks:read,agents:read",
      ),
      true,
    );
  } finally {
    await negotiated.close();
  }
});

test("bot chats still require bot authority on progress reads and events", async () => {
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  // A device with negotiated progress grants but no bot:read can never reach
  // a retained bot chat's progress projections.
  const withoutBotRead = await fixture({
    botChat: true,
    capabilities: ["server:read", "chat:read", "tasks:read", "agents:read"],
    acceptsProgressCapabilities: true,
  });
  try {
    for (const path of [
      "/chats/chat-1/tasks",
      "/chats/chat-1/agents",
      "/chats/chat-1/progress/events?after=0",
    ]) {
      const denied = await fetch(`${withoutBotRead.base}${path}`, { headers });
      assert.equal(denied.status, 404, path);
      await denied.text();
    }
    assert.equal(
      withoutBotRead.calls.some((call) =>
        call.startsWith("task-snapshot:") ||
        call.startsWith("agent-roster:") ||
        call.startsWith("progress-events:")
      ),
      false,
    );
  } finally {
    await withoutBotRead.close();
  }

  // bot:read alone is not enough: the retained bot chat authorization must
  // also pass before any progress projection or stream opens.
  const unauthorized = await fixture({
    botChat: true,
    acceptsBotCapabilities: true,
    acceptsProgressCapabilities: true,
    capabilities: [
      "server:read",
      "chat:read",
      "bot:read",
      "tasks:read",
      "agents:read",
    ],
    botChatAuthorization: () => false,
  });
  try {
    for (const path of [
      "/chats/chat-1/tasks",
      "/chats/chat-1/agents",
      "/chats/chat-1/progress/events?after=0",
    ]) {
      const denied = await fetch(`${unauthorized.base}${path}`, { headers });
      assert.equal(denied.status, 404, path);
      await denied.text();
    }
    assert.equal(
      unauthorized.calls.some((call) =>
        call.startsWith("task-snapshot:") ||
        call.startsWith("agent-roster:") ||
        call.startsWith("progress-events:")
      ),
      false,
    );
  } finally {
    await unauthorized.close();
  }

  // A fully authorized bot chat serves progress projections through the same
  // negotiated-grant path as a workspace chat.
  const authorized = await fixture({
    botChat: true,
    acceptsBotCapabilities: true,
    acceptsProgressCapabilities: true,
    capabilities: [
      "server:read",
      "chat:read",
      "bot:read",
      "tasks:read",
      "agents:read",
    ],
    botChatAuthorization: (request) =>
      request.botId === "bot-1" && request.access === "read",
  });
  try {
    const tasks = await fetch(`${authorized.base}/chats/chat-1/tasks`, { headers });
    assert.equal(tasks.status, 200);
    await tasks.json();
    const agents = await fetch(`${authorized.base}/chats/chat-1/agents`, { headers });
    assert.equal(agents.status, 200);
    await agents.json();
    const events = await fetch(
      `${authorized.base}/chats/chat-1/progress/events?after=0`,
      { headers },
    );
    assert.equal(events.status, 200);
    await events.text();
    assert.equal(
      authorized.calls.includes("task-snapshot:chat-1") &&
        authorized.calls.includes("agent-roster:chat-1:") &&
        authorized.calls.includes(
          "progress-events:chat-1:0:tasks:read,agents:read",
        ),
      true,
    );
  } finally {
    await authorized.close();
  }
});

test("progress stream forwards only the granted progress projections", async () => {
  const app = await fixture({
    capabilities: ["server:read", "chat:read", "tasks:read"],
    acceptsProgressCapabilities: true,
  });
  try {
    const response = await fetch(`${app.base}/chats/chat-1/progress/events`, {
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(
      app.calls.includes("progress-events:chat-1:0:tasks:read"),
      true,
    );
  } finally {
    await app.close();
  }
});

test("progress support is advertised and upgraded only when the Mac can serve it", async () => {
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
    "content-type": "application/json",
  };
  const unsupported = await fixture({
    capabilities: ["server:read", "chat:read", "tasks:read", "agents:read"],
    acceptsProgressCapabilities: true,
    progressAvailable: false,
  });
  try {
    const serverResponse = await fetch(`${unsupported.base}/server`, { headers });
    assert.equal(serverResponse.status, 200);
    const server = await serverResponse.json();
    assert.deepEqual(server.serverCapabilities, [
      "server:read",
      "chat:read",
      "chat:write",
      "approval:respond",
      "workspace:read",
      "workspace:browse",
      "workspace:manage",
      "files:read",
      "files:write",
      "git:read",
      "git:write",
      "schedule:read",
      "schedule:write",
      "skills:invoke",
    ]);
    assert.equal(server.features.includes("chat-tasks-v1"), false);
    assert.equal(server.features.includes("chat-agents-v1"), false);
    assert.equal(server.features.includes("chat-skills-v1"), true);

    const read = await fetch(`${unsupported.base}/chats/chat-1/tasks`, { headers });
    assert.equal(read.status, 404);
    const upgrade = await fetch(`${unsupported.base}/device/capabilities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accepts: ["tasks:read"] }),
    });
    assert.equal(upgrade.status, 404);
    assert.equal(unsupported.calls.some((call) => call.startsWith("device-capabilities:")), false);
  } finally {
    await unsupported.close();
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

test("post-pairing capability upgrade accepts only the progress vocabulary", async () => {
  const app = await fixture();
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
    "content-type": "application/json",
  };
  try {
    const response = await fetch(`${app.base}/device/capabilities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accepts: ["tasks:read", "agents:read"] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      capabilities: ["server:read", "tasks:read", "agents:read"],
    });
    assert.deepEqual(app.calls, [
      "device-capabilities:device-authorized-12345678:tasks:read,agents:read",
    ]);

    for (const accepts of [
      ["bot:read"],
      ["chat:write"],
      ["server:read"],
      ["tasks:read", "tasks:read"],
      ["unknown:read"],
      [],
    ]) {
      const rejected = await fetch(`${app.base}/device/capabilities`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accepts }),
      });
      assert.equal(rejected.status, 400, JSON.stringify(accepts));
    }

    const unexpectedField = await fetch(`${app.base}/device/capabilities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accepts: ["tasks:read"], deviceId: "other" }),
    });
    assert.equal(unexpectedField.status, 400);
    assert.deepEqual(app.calls, [
      "device-capabilities:device-authorized-12345678:tasks:read,agents:read",
    ]);
  } finally {
    await app.close();
  }
});

test("capability upgrade requires server:read and a live device", async () => {
  const denied = await fixture({ authenticate: "denied" });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
    "content-type": "application/json",
  };
  try {
    const response = await fetch(`${denied.base}/device/capabilities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accepts: ["tasks:read"] }),
    });
    assert.equal(response.status, 403);
  } finally {
    await denied.close();
  }

  const revoked = await fixture({ authenticate: "revoked" });
  try {
    const response = await fetch(`${revoked.base}/device/capabilities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accepts: ["tasks:read"] }),
    });
    assert.equal(response.status, 403);
  } finally {
    await revoked.close();
  }
});

test("paired devices explicitly acknowledge the one-time Bot notice under their stable device id", async () => {
  const app = await fixture({
    capabilities: ["bot:read", "bot:write"],
    acceptsBotCapabilities: true,
  });
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
  const app = await fixture({
    capabilities: ["bot:write"],
    acceptsBotCapabilities: true,
  });
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
    assert.deepEqual(server.capabilities, ["server:read"]);
    assert.equal("serverCapabilities" in server, false);
  } finally {
    await app.close();
  }
});

test("authenticated Bot routes enforce the frozen CRUD, access, chat, and favorites contract", async () => {
  const app = await fixture({
    capabilities: ["bot:read", "bot:write", "chat:read", "chat:write"],
    acceptsBotCapabilities: true,
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
      "bots:catalog:device-authorized-12345678:generic",
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

test("Bot capability catalogs strictly route optional authenticated Bot targets", async () => {
  const app = await fixture({
    capabilities: ["bot:read"],
    acceptsBotCapabilities: true,
  });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const generic = await fetch(`${app.base}/bot-capabilities`, { headers });
    assert.equal(generic.status, 200);
    const genericBody = await generic.json();
    assert.equal(genericBody.skillsEnabled, false);
    assert.deepEqual(genericBody.skills, []);

    const target = await fetch(`${app.base}/bot-capabilities?botId=bot-1`, { headers });
    assert.equal(target.status, 200);
    assert.deepEqual((await target.json()).skills, [
      { id: "skill_saved_bot-1", label: "Saved skill", available: false },
    ]);
    assert.ok(app.calls.includes("bots:catalog:device-authorized-12345678:bot-1"));

    const otherTarget = await fetch(`${app.base}/bot-capabilities?botId=bot-2`, { headers });
    assert.equal(otherTarget.status, 200);
    assert.deepEqual((await otherTarget.json()).skills, [
      { id: "skill_saved_bot-2", label: "Saved skill", available: false },
    ]);

    for (const query of [
      "botId=bot-1&botId=bot-2",
      "target=bot-1",
      "botId=",
      `botId=${"b".repeat(161)}`,
      "botId=bot/id",
      "botId=bot-1&",
    ]) {
      const response = await fetch(`${app.base}/bot-capabilities?${query}`, { headers });
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, "invalid_request", query);
    }

    const missing = await fetch(`${app.base}/bot-capabilities?botId=bot-missing`, { headers });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "not_found");
  } finally {
    await app.close();
  }
});

test("Bot inbox and avatar routes preserve device grants, approval ownership, and binary headers", async () => {
  const app = await fixture({
    capabilities: ["bot:read", "bot:write", "chat:read"],
    acceptsBotCapabilities: true,
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

  const denied = await fixture({
    capabilities: ["bot:read"],
    acceptsBotCapabilities: true,
  });
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
  const app = await fixture({
    capabilities: ["bot:write", "chat:write"],
    acceptsBotCapabilities: true,
  });
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

    const input = await fetch(`${app.base}/streams/stream-1/inputs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "input-stream-key-0001" },
      body: JSON.stringify({ mode: "queue", text: "Follow up with tests." }),
    });
    assert.equal(input.status, 200);
    assert.deepEqual(await input.json(), {
      streamId: "stream-1",
      chatId: "chat-1",
      turnId: "turn-1",
      mode: "queue",
      status: "admitted",
      queue: "follow-up",
      committed: true,
      messageId: "message-remote-input-1",
    });

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

test("chat-created schedule approvals require both approval and schedule-write grants", async () => {
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const withoutScheduleWrite = await fixture({
    capabilities: ["chat:read", "chat:write", "approval:respond"],
    approvalCanAllow: true,
    approvalRequiredCapability: "schedule:write",
  });
  try {
    const snapshot = await fetch(
      `${withoutScheduleWrite.base}/streams/stream-1/approval`,
      { headers },
    );
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).approval.canAllow, false);

    const blocked = await fetch(
      `${withoutScheduleWrite.base}/approvals/approval-1/respond`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "schedule-allow-blocked-01",
        },
        body: JSON.stringify({ decision: "allow" }),
      },
    );
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, "capability_denied");
    assert.equal(
      withoutScheduleWrite.calls.some((call) => call.startsWith("approval:")),
      false,
    );

    const denied = await fetch(
      `${withoutScheduleWrite.base}/approvals/approval-1/respond`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "schedule-deny-allowed-01",
        },
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    assert.equal(denied.status, 200);
    assert.equal((await denied.json()).decision, "deny");
  } finally {
    await withoutScheduleWrite.close();
  }

  const withScheduleWrite = await fixture({
    capabilities: [
      "chat:read",
      "chat:write",
      "approval:respond",
      "schedule:write",
    ],
    approvalCanAllow: true,
    approvalRequiredCapability: "schedule:write",
  });
  try {
    const snapshot = await fetch(
      `${withScheduleWrite.base}/streams/stream-1/approval`,
      { headers },
    );
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).approval.canAllow, true);

    const allowed = await fetch(
      `${withScheduleWrite.base}/approvals/approval-1/respond`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "schedule-allow-granted-01",
        },
        body: JSON.stringify({ decision: "allow" }),
      },
    );
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).decision, "allow");
  } finally {
    await withScheduleWrite.close();
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
    acceptsBotCapabilities: true,
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
    acceptsBotCapabilities: true,
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
    acceptsBotCapabilities: true,
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
    acceptsBotCapabilities: true,
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
    acceptsBotCapabilities: true,
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
    acceptsBotCapabilities: true,
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
    acceptsBotCapabilities: true,
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

test("paired clients can inspect and use bounded Mac transcription without exposing it to read-only devices", async () => {
  const app = await fixture({ capabilities: ["server:read", "chat:write"] });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const status = await fetch(`${app.base}/speech`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).input.partialResults, false);

    const transcription = await fetch(`${app.base}/speech/transcriptions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        encoding: "pcm_s16le",
        sampleRate: 16_000,
        channels: 1,
        pcmBase64: Buffer.from([0, 0]).toString("base64"),
        modelId: "parakeet-v3",
      }),
    });
    assert.equal(transcription.status, 200);
    assert.deepEqual(await transcription.json(), { text: "Hello from the Mac", modelId: "parakeet-v3" });
    assert.equal(app.calls.includes("speech:status"), true);
    assert.equal(app.calls.includes("speech:transcribe:object"), true);

    const maximumPcm = Buffer.alloc(16_000 * 2 * 60).toString("base64");
    const maximumBody = JSON.stringify({
      encoding: "pcm_s16le",
      sampleRate: 16_000,
      channels: 1,
      pcmBase64: maximumPcm,
      modelId: "parakeet-v3",
    });
    assert.ok(Buffer.byteLength(maximumBody) <= AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES);
    const maximum = await fetch(`${app.base}/speech/transcriptions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: maximumBody,
    });
    assert.equal(maximum.status, 200);

    const oversized = await fetch(`${app.base}/speech/transcriptions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "x".repeat(AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES + 1),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await app.close();
  }

  const readOnly = await fixture({ capabilities: ["server:read"] });
  try {
    const denied = await fetch(`${readOnly.base}/speech/transcriptions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, "capability_denied");
  } finally {
    await readOnly.close();
  }
});

test("speech transcription authenticates before buffering its larger request body", async () => {
  const app = await fixture({ capabilities: ["chat:write"] });
  try {
    const target = new URL(`${app.base}/speech/transcriptions`);
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "aiden-protocol-version": "1",
          "content-type": "application/json",
          "content-length": String(AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES + 1),
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
      // Do not send the declared body. The unauthenticated request must settle
      // without waiting for or allocating the large upload.
      request.end();
    });
    const result = await response;
    assert.equal(result.status, 401);
    assert.equal(JSON.parse(result.body).error.code, "authentication_required");
    assert.equal(app.calls.some((entry) => entry.startsWith("speech:transcribe")), false);
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

    const missingRunRevision = await fetch(`${app.base}/scheduled-tasks/task-1/run`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
    });
    assert.equal(missingRunRevision.status, 400);

    const run = await fetch(`${app.base}/scheduled-tasks/task-1/run`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": key, "if-match": "rev-task-1" },
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
      `schedule-run:device-authorized-12345678:task-1:rev-task-1:${key}`,
      "schedule-runs:task-1",
    ]);
  } finally {
    await app.close();
  }
});

test("the scheduled-notifications feed enforces schedule:read and a strict since cursor", async () => {
  const app = await fixture({ capabilities: ["schedule:read"] });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const feed = await fetch(`${app.base}/scheduled-tasks/notifications`, { headers });
    assert.equal(feed.status, 200);
    assert.deepEqual(await feed.json(), { notifications: [], now: 2_000 });
    assert.deepEqual(app.calls, ["schedule-notifications:"]);

    const cursor = await fetch(`${app.base}/scheduled-tasks/notifications?since=1700000000000`, { headers });
    assert.equal(cursor.status, 200);
    assert.deepEqual(app.calls[app.calls.length - 1], "schedule-notifications:1700000000000");

    // 9999999999999999 (16 digits) passes the regex but exceeds Number.MAX_SAFE_INTEGER;
    // 99999999999999999 (17 digits) is rejected by the regex itself — both must 400.
    for (const query of ["since=-1", "since=1.5", "since=1e5", "since=01", "since=", "since=1&since=2", "since=9999999999999999", "since=99999999999999999", "other=1"]) {
      const rejected = await fetch(`${app.base}/scheduled-tasks/notifications?${query}`, { headers });
      assert.equal(rejected.status, 400, query);
    }
  } finally {
    await app.close();
  }

  const unscoped = await fixture({ capabilities: ["schedule:write"] });
  try {
    const denied = await fetch(`${unscoped.base}/scheduled-tasks/notifications`, { headers });
    assert.equal(denied.status, 403);
  } finally {
    await unscoped.close();
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
    acceptsBotCapabilities: true,
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

test("request logs carry the HTTP method and a query-free canonical route template", async () => {
  const app = await fixture({ capabilities: ["chat:read"] });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    // A matched route failing after resolution still reports the concrete
    // method and canonical route template (never the literal chat id).
    const denied = await fetch(`${app.base}/chats/chat-1`, {
      headers: { "aiden-protocol-version": "1" },
    });
    assert.equal(denied.status, 401);
    let entry = app.logs[app.logs.length - 1] as Record<string, unknown>;
    assert.equal(entry.method, "GET");
    assert.equal(entry.route, "chat");
    assert.equal(entry.routePath, "/chats/:id");
    assert.equal(JSON.stringify(app.logs).includes("chat-1"), false);

    // Query strings are never reflected into the recorded route.
    const listed = await fetch(`${app.base}/chats?workspaceId=workspace-1`, { headers });
    assert.equal(listed.status, 200);
    entry = app.logs[app.logs.length - 1] as Record<string, unknown>;
    assert.equal(entry.method, "GET");
    assert.equal(entry.routePath, "/chats");
    assert.equal(JSON.stringify(app.logs).includes("workspaceId"), false);
    assert.equal(JSON.stringify(app.logs).includes("?"), false);

    // Unknown routes omit the canonical route and never echo the raw path.
    const missing = await fetch(`${app.base}/missing`);
    assert.equal(missing.status, 404);
    entry = app.logs[app.logs.length - 1] as Record<string, unknown>;
    assert.equal(entry.method, "GET");
    assert.equal(entry.route, "unknown");
    assert.equal("routePath" in entry, false);
    assert.equal(JSON.stringify(app.logs).includes("/missing"), false);
  } finally {
    await app.close();
  }
});

const ROUTE_METHOD_CANDIDATES = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Instantiate a declared route template with one concrete request path. `:param`
 * segments receive tokens that satisfy the matching capture grammars in the
 * router (plain ids accept `x1`; `:fileId`, `:attachmentId`, and
 * `:avatarRevision` carry required prefixes; the git/scheduled `:action`
 * families require one of their fixed action literals).
 */
function concreteRequestPath(template: string): string {
  let parameterIndex = 0;
  return template
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      parameterIndex += 1;
      switch (segment) {
        case ":fileId":
          return `file_${"f".repeat(43)}`;
        case ":attachmentId":
          return `att_${"a".repeat(43)}`;
        case ":avatarRevision":
          return `avatar_revision_${"a".repeat(32)}`;
        case ":segment":
        case ":offset":
          return "0";
        case ":attachmentName":
          return `x${parameterIndex}.png`;
        case ":action":
          return template.includes("/git/") ? "review" : "run";
        default:
          return `x${parameterIndex}`;
      }
    })
    .join("/");
}

test("every declared remote route template resolves to its own label and exact routePath", async () => {
  const app = await fixture({
    capabilities: ["chat:read", "chat:write", "schedule:read", "schedule:write"],
  });
  const failures: string[] = [];
  try {
    for (const [label, templates] of Object.entries(AIDEN_REMOTE_ROUTE_TEMPLATES) as Array<
      [AidenRemoteRouteLabel, readonly string[]]
    >) {
      if (label === "unknown") continue;
      for (const template of templates) {
        const path = concreteRequestPath(template);
        let resolved = false;
        for (const method of ROUTE_METHOD_CANDIDATES) {
          const response = await fetch(`${app.base}${path}`, { method });
          await response.arrayBuffer();
          const entry = app.logs[app.logs.length - 1] as
            | Record<string, unknown>
            | undefined;
          if (entry?.route === label && entry?.routePath === template) {
            assert.equal(
              remoteRouteTemplate(label, path),
              template,
              `${label} ${template} must derive its own canonical route`,
            );
            resolved = true;
            break;
          }
        }
        if (!resolved) {
          failures.push(`${label}: ${template} (instantiated as ${path})`);
        }
      }
    }
    assert.deepEqual(
      failures,
      [],
      "a declared template with no matching router route is a mistranscription",
    );
  } finally {
    await app.close();
  }
});

/** Split a template or matcher literal into per-segment route shapes (`:x` for params). */
function routeShapeSegments(literal: string): string[] {
  let body = literal;
  if (body.startsWith("^")) body = body.slice(1);
  if (body.endsWith("$")) body = body.slice(0, -1);
  body = body.replace(/\\/gu, "");
  const segments = body.split("/");
  if (segments[0] === "") segments.shift();
  return segments.map((segment) => (segment.includes("(") || segment.startsWith(":") ? ":x" : segment));
}

/** True when every literal segment of the matcher shape matches the template. */
function matcherCoveredByTemplate(matcher: string[], template: string[]): boolean {
  if (matcher.length !== template.length) return false;
  return matcher.every((segment, index) => {
    const declared = template[index];
    return declared === ":x" || declared === segment;
  });
}

test("every matcher path pattern in the router source is declared as a route template", () => {
  const source = readFileSync(
    new URL("./aiden-remote-router.ts", import.meta.url),
    "utf8",
  );
  // The template table above the handler duplicates these matcher shapes by
  // hand; this scan starts at the handler so table literals never satisfy it.
  const handler = source.slice(
    source.indexOf("export function createAidenRemoteRequestHandler("),
  );
  const matcherShapes = new Set<string>();
  const recordShape = (literal: string) => {
    const segments = routeShapeSegments(literal);
    if (segments.length > 0) matcherShapes.add(segments.join("/"));
  };
  // String-literal matchers (`path === "/scheduled-tasks/scripts"` and friends).
  // The handler body's only leading-slash string literals are route equality
  // checks, so single-segment routes (`/health`, `/chats`) are scanned too.
  for (const match of handler.matchAll(/["']((?:[^"'\\]|\\.)*)["']/gu)) {
    const literal = match[1] ?? "";
    if (literal.startsWith("/")) {
      recordShape(literal);
    }
  }
  // Regex matcher literals bound to `.exec(path)` (the `const XxxMatch` family).
  for (const match of handler.matchAll(
    /\bconst\s+[A-Za-z0-9_]+Match\s*=\s*\/([^\n]*?)\/u\.exec\(path\);/gu,
  )) {
    recordShape(match[1] ?? "");
  }
  const declaredShapes = Object.values(AIDEN_REMOTE_ROUTE_TEMPLATES)
    .flat()
    .map((template) => routeShapeSegments(template));
  // No allowlist is needed: the scan is confined to the handler body, where
  // every leading-slash literal is a route matcher rather than a header name,
  // internal prefix, or `path.includes("//")` guard.
  const uncovered = [...matcherShapes].filter(
    (shape) =>
      !declaredShapes.some((declared) =>
        matcherCoveredByTemplate(shape.split("/"), declared),
      ),
  );
  assert.deepEqual(
    uncovered,
    [],
    "every router matcher path must have a declared route template for routePath evidence",
  );
});

test("question prompts negotiate, project, and respond under the device grant", async () => {
  const app = await fixture({
    capabilities: ["server:read", "chat:read", "chat:write", "questions:respond"],
    acceptsProgressCapabilities: true,
  });
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const server = await (await fetch(`${app.base}/server`, { headers })).json();
    assert.equal(server.features.includes("chat-question-prompts-v1"), true);
    assert.equal(server.capabilities.includes("questions:respond"), true);

    const snapshot = await fetch(`${app.base}/streams/stream-1/question`, { headers });
    assert.equal(snapshot.status, 200);
    const { question } = await snapshot.json();
    assert.equal(question.promptId, "q-prompt-1");
    assert.equal(question.questions[0].options.length, 2);

    const resolved = await fetch(`${app.base}/questions/q-prompt-1/respond`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "question-answer-key-01" },
      body: JSON.stringify({
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "option", answer: "0.5 mm" }],
      }),
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), {
      promptId: "q-prompt-1",
      resolvedAt: new Date(6_000).toISOString(),
    });
    assert.equal(
      app.calls.some((call) => call.startsWith("question:device-authorized-12345678:q-prompt-1")),
      true,
    );
  } finally {
    app.close();
  }
});

test("question routes fail closed without the grant or the host surface", async () => {
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };

  const noGrant = await fixture({ capabilities: ["server:read", "chat:read", "chat:write"] });
  try {
    const server = await (await fetch(`${noGrant.base}/server`, { headers })).json();
    assert.equal(server.features.includes("chat-question-prompts-v1"), true);
    const denied = await fetch(`${noGrant.base}/questions/q-prompt-1/respond`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "question-answer-key-02" },
      body: JSON.stringify({ cancelled: true, answers: [] }),
    });
    assert.equal(denied.status, 403);
  } finally {
    noGrant.close();
  }

  const noSurface = await fixture({
    capabilities: ["server:read", "chat:read", "chat:write", "questions:respond"],
    acceptsProgressCapabilities: true,
    questionsAvailable: false,
  });
  try {
    const server = await (await fetch(`${noSurface.base}/server`, { headers })).json();
    assert.equal(server.features.includes("chat-question-prompts-v1"), false);
    const missing = await fetch(`${noSurface.base}/streams/stream-1/question`, { headers });
    assert.equal(missing.status, 404);
    const respondMissing = await fetch(`${noSurface.base}/questions/q-prompt-1/respond`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "question-answer-key-03" },
      body: JSON.stringify({ cancelled: true, answers: [] }),
    });
    assert.equal(respondMissing.status, 404);
  } finally {
    noSurface.close();
  }
});

test("chat skills route gates on negotiated skills:invoke and advertises its feature", async () => {
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };

  const legacy = await fixture({ capabilities: ["server:read", "chat:read"] });
  try {
    const server = await (await fetch(`${legacy.base}/server`, { headers })).json();
    assert.equal(server.features.includes("chat-skills-v1"), true,
      "the feature advertises the host wiring even before a device negotiates the grant");
    const denied = await fetch(`${legacy.base}/chats/chat-1/skills`, { headers });
    assert.equal(denied.status, 403);
    assert.equal(legacy.calls.some((call) => call.startsWith("skill-catalog:")), false);
  } finally {
    legacy.close();
  }

  const negotiated = await fixture({
    capabilities: ["server:read", "chat:read", "chat:write", "skills:invoke"],
    acceptsProgressCapabilities: true,
  });
  try {
    const server = await (await fetch(`${negotiated.base}/server`, { headers })).json();
    assert.equal(server.features.includes("chat-skills-v1"), true);
    const skills = await fetch(`${negotiated.base}/chats/chat-1/skills`, { headers });
    assert.equal(skills.status, 200);
    assert.deepEqual(await skills.json(), {
      skills: [{
        invocationId: `sk1_${"a".repeat(43)}`,
        name: "review-code",
        description: "Review changes.",
        source: "workspace",
        available: true,
      }],
    });
    assert.equal(negotiated.calls.includes("skill-catalog:device-authorized-12345678:chat-1"), true);
  } finally {
    negotiated.close();
  }

  const noSurface = await fixture({
    capabilities: ["server:read", "chat:read", "skills:invoke"],
    acceptsProgressCapabilities: true,
    skillsAvailable: false,
  });
  try {
    const server = await (await fetch(`${noSurface.base}/server`, { headers })).json();
    assert.equal(server.features.includes("chat-skills-v1"), false);
    const missing = await fetch(`${noSurface.base}/chats/chat-1/skills`, { headers });
    assert.equal(missing.status, 404);
  } finally {
    noSurface.close();
  }
});

test("Read Aloud authenticates before parsing, checks Bot access and never exposes setup writes", async () => {
  let called = 0;
  const readAloud: NonNullable<import("./aiden-remote-router.js").AidenRemoteRouterDependencies["readAloud"]> = {
    status: async () => { called++; return { enabled: true, ready: true, settingsRevision: "revision", source: null, job: null }; },
    start: async () => { called++; throw new Error("should not reach synthesis"); },
    read: async () => { called++; throw new Error("should not read audio"); },
    stop: () => { called++; return { ok: true }; },
  };
  const app = await fixture({ readAloud, capabilities: ["server:read", "chat:read", "chat:write"] });
  const headers = { authorization: `Bearer ${"a".repeat(43)}`, "aiden-protocol-version": "1", "content-type": "application/json" };
  try {
    const unauthenticated = await fetch(`${app.base}/chats/chat-1/read-aloud`, { method: "POST", body: "bad-json" });
    assert.equal(unauthenticated.status, 400); // Missing protocol header, before JSON parsing or adapter.
    assert.equal(called, 0);
    const status = await fetch(`${app.base}/read-aloud`, { headers });
    assert.equal(status.status, 200);
    const server = await (await fetch(`${app.base}/server`, { headers })).json() as { features: string[] };
    assert.ok(server.features.includes("tts-v1"));
    const before = called;
    const patch = await fetch(`${app.base}/read-aloud`, { method: "PATCH", headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(patch.status, 404);
    const chatPatch = await fetch(`${app.base}/chats/chat-1/read-aloud`, { method: "PATCH", headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(chatPatch.status, 404);
    assert.equal(called, before);
  } finally { await app.close(); }
  const bot = await fixture({ readAloud, botChat: true, capabilities: ["chat:read", "chat:write"] });
  try {
    const before = called;
    for (const path of ["/chats/chat-1/read-aloud", "/chats/chat-1/read-aloud/audio/job-1/0/0"]) {
      assert.equal((await fetch(`${bot.base}${path}`, { headers })).status, 404);
    }
    assert.equal(called, before);
  } finally { await bot.close(); }
});

test("workspace file pages keep authentication and reject path-shaped or ambiguous queries", async () => {
  const app = await fixture({ capabilities: ["files:read"] });
  const headers = { authorization: `Bearer ${"a".repeat(43)}`, "aiden-protocol-version": "1" };
  try {
    assert.equal((await fetch(`${app.base}/workspaces/workspace-1/files?tree=1`, { headers })).status, 200);
    for (const query of ["tree=2", "tree=1&tree=1", "tree=1&directory=../secret", "tree=1&cursor=bad", "tree=1&path=src", "directory=file_x"]) {
      assert.equal((await fetch(`${app.base}/workspaces/workspace-1/files?${query}`, { headers })).status, 400, query);
    }
    assert.equal(app.calls.filter(value => value.startsWith("file-page:")).length, 1);
  } finally { await app.close(); }
});

function simulatorHost(sharing = true): AidenRemoteSimulatorHost {
  return {
    sharing: () => sharing,
    list: async () => ({ sharing, status: "ready", devices: [] }),
    open: async () => {
      throw new Error("unused");
    },
    shutdown: async () => undefined,
    settings: async () => ({}),
    action: async () => ({}),
    hubOrigin: () => null,
    isKnownDevice: () => false,
    onSharingChanged: () => () => undefined,
  };
}

const SIMULATOR_HEADERS = {
  authorization: `Bearer ${"a".repeat(43)}`,
  "aiden-protocol-version": "1",
  "content-type": "application/json",
};

test("only paired desktops negotiate simulator control, and only where it exists", async () => {
  const relay = new AidenRemoteSimulatorRelay(() => simulatorHost());
  const accepts = JSON.stringify({ accepts: ["simulators:control"] });
  const phone = await fixture({ simulators: relay, deviceType: "iphone" });
  try {
    const response = await fetch(`${phone.base}/device/capabilities`, { method: "POST", headers: SIMULATOR_HEADERS, body: accepts });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "capability_denied");
    assert.equal(phone.calls.some((call) => call.startsWith("device-capabilities:")), false);
  } finally {
    await phone.close();
  }
  const mac = await fixture({ simulators: relay, deviceType: "mac" });
  try {
    const response = await fetch(`${mac.base}/device/capabilities`, { method: "POST", headers: SIMULATOR_HEADERS, body: accepts });
    assert.equal(response.status, 200);
    assert.deepEqual(mac.calls, ["device-capabilities:device-authorized-12345678:simulators:control"]);
  } finally {
    await mac.close();
  }
  for (const simulators of [undefined, new AidenRemoteSimulatorRelay(() => null)]) {
    const off = await fixture({ ...(simulators ? { simulators } : {}), deviceType: "mac" });
    try {
      const response = await fetch(`${off.base}/device/capabilities`, { method: "POST", headers: SIMULATOR_HEADERS, body: accepts });
      assert.equal(response.status, 404);
    } finally {
      await off.close();
    }
    // A phone gets the same refusal whether or not this Mac has simulators.
    const phoneOff = await fixture({ ...(simulators ? { simulators } : {}), deviceType: "iphone" });
    try {
      const response = await fetch(`${phoneOff.base}/device/capabilities`, { method: "POST", headers: SIMULATOR_HEADERS, body: accepts });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "capability_denied");
    } finally {
      await phoneOff.close();
    }
  }
});

test("simulator routes require a desktop holding simulator control", async () => {
  const relay = new AidenRemoteSimulatorRelay(() => simulatorHost(false));
  const granted = ["server:read", "simulators:control"] as AidenRemoteCapability[];
  const phone = await fixture({ simulators: relay, deviceType: "iphone", capabilities: granted });
  try {
    const response = await fetch(`${phone.base}/simulators`, { headers: SIMULATOR_HEADERS });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "capability_denied");
  } finally {
    await phone.close();
  }
  const untyped = await fixture({ simulators: relay, capabilities: granted });
  try {
    assert.equal((await fetch(`${untyped.base}/simulators`, { headers: SIMULATOR_HEADERS })).status, 403);
  } finally {
    await untyped.close();
  }
  const ungranted = await fixture({ simulators: relay, deviceType: "mac" });
  try {
    assert.equal((await fetch(`${ungranted.base}/simulators`, { headers: SIMULATOR_HEADERS })).status, 403);
  } finally {
    await ungranted.close();
  }
  const mac = await fixture({ simulators: relay, deviceType: "linux", capabilities: granted });
  try {
    const response = await fetch(`${mac.base}/simulators`, { headers: SIMULATOR_HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sharing: false, status: "ready", devices: [] });
    const opened = await fetch(`${mac.base}/simulators/open`, {
      method: "POST",
      headers: SIMULATOR_HEADERS,
      body: JSON.stringify({ deviceId: "UDID-1" }),
    });
    assert.equal(opened.status, 404);
    assert.ok(mac.logs.some((entry) => (entry as { route?: string }).route === "simulators"));
  } finally {
    await mac.close();
  }
});

test("hub WebSocket upgrades authenticate before reaching the relay", async () => {
  const relay = new AidenRemoteSimulatorRelay(() => simulatorHost());
  const granted = ["server:read", "simulators:control"] as AidenRemoteCapability[];
  const statusLine = (base: string, path: string, headers: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const url = new URL(`${base}${path}`);
      const socket = connect({ host: url.hostname, port: Number(url.port) });
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      socket.on("close", () => resolve(text.split("\r\n")[0] ?? ""));
      socket.on("error", () => undefined);
      const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`,
      );
    });
  const auth = { authorization: `Bearer ${"a".repeat(43)}`, "aiden-protocol-version": "1" };
  const path = "/simulators/hub/vendor/serve-sim/helper/ws?device=UDID-1";

  const phone = await fixture({ simulators: relay, deviceType: "iphone", capabilities: granted });
  try {
    assert.equal(await statusLine(phone.base, path, auth), "HTTP/1.1 403 Refused");
  } finally {
    await phone.close();
  }
  const mac = await fixture({ simulators: relay, deviceType: "mac", capabilities: granted });
  try {
    assert.equal(await statusLine(mac.base, path, {}), "HTTP/1.1 400 Refused");
    assert.equal(await statusLine(mac.base, path, { ...auth, origin: "https://evil.example" }), "HTTP/1.1 403 Refused");
    assert.equal(await statusLine(mac.base, "/chats", auth), "HTTP/1.1 404 Not Found");
    // Authenticated, but the device is not in this Mac's listing.
    assert.equal(await statusLine(mac.base, path, auth), "HTTP/1.1 404 Not Found");
    const logged = mac.logs.filter((entry) => (entry as { route?: string }).route === "simulatorHub");
    assert.equal(logged.length, 4);
    // A relay refusal is logged with its real status, never as a switch.
    assert.deepEqual(
      logged.map((entry) => (entry as { status?: number }).status),
      [400, 403, 404, 404],
    );
    assert.ok(logged.every((entry) => !("routePath" in (entry as object))));
  } finally {
    await mac.close();
  }
  const blocked = await fixture({
    simulators: relay,
    deviceType: "mac",
    capabilities: granted,
    authorizationBlocked: () => true,
  });
  try {
    assert.equal(await statusLine(blocked.base, path, auth), "HTTP/1.1 403 Refused");
  } finally {
    await blocked.close();
  }
});

test("the simulator vocabulary is advertised only to paired desktops", async () => {
  const relay = new AidenRemoteSimulatorRelay(() => simulatorHost());
  for (const [deviceType, simulators, expected] of [
    ["mac", relay, true],
    ["linux", relay, true],
    ["iphone", relay, false],
    ["mac", new AidenRemoteSimulatorRelay(() => null), false],
  ] as const) {
    const server = await fixture({ simulators, deviceType, acceptsProgressCapabilities: true });
    try {
      const response = await fetch(`${server.base}/server`, { headers: SIMULATOR_HEADERS });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { serverCapabilities?: string[] };
      assert.equal(body.serverCapabilities?.includes("simulators:control"), expected, deviceType);
    } finally {
      await server.close();
    }
  }
});
