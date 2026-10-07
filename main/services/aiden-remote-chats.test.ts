import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Chat, ChatMessage } from "./types.js";
import {
  AidenRemoteChatService,
  projectAidenRemoteChat,
  projectAidenRemoteChatMessagesWindow,
  type AidenRemoteBotTurnAuthorityPreflight,
  type AidenRemoteRetainedBotChatAuthorizer,
} from "./aiden-remote-chats.js";
import {
  AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES,
  parseAidenRemoteChatForkResult,
  parseAidenRemoteChatProjection,
} from "./aiden-remote-protocol.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import {
  AIDEN_REMOTE_ATTACHMENT_TTL_MS,
  AidenRemoteAttachmentStore,
} from "./aiden-remote-attachments.js";
import { BotMutationGate } from "./bot-mutation-gate.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { SkillInvocationError, type SkillCatalogEntry } from "../../renderer/shared/slash-commands.js";
import type { PreparedSkillInvocation } from "./skill-invocation-turn.js";
import { ChatForkError, ForkSummaryStateError } from "./chat-fork-error.js";
import { createChatForkService, type ChatForkRequest } from "./chat-fork-service.js";
import { createChatStore } from "./chat-store-core.js";
import type { RegisteredSkill } from "./skill-registry.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
const ONE_PIXEL_GIF = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    title: "New chat",
    workspaceId: "workspace-1",
    providerId: "provider-1",
    model: "model-1",
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
    ...overrides,
  };
}

function fixture(
  initial = chat(),
  fixtureOptions: {
    startThrows?: boolean;
    attachments?: AidenRemoteAttachmentStore;
    isTitlePending?: (chatId: string) => boolean;
    onListRegular?: (workspaceId?: string) => void;
    onPayloadGet?: () => void | Promise<void>;
    botArchived?: boolean;
    botAvailable?: boolean;
    retainedBotChatAuthorizer?: AidenRemoteRetainedBotChatAuthorizer;
    botTurnAuthorityPreflight?: AidenRemoteBotTurnAuthorityPreflight;
    modelSupportsImages?: () => boolean;
    imageArtifactRecoveryPending?: boolean;
    imageArtifactRecoveryUnavailable?: boolean;
    deviceSupportsQuestionPrompts?: (deviceId: string) => Promise<boolean>;
    deviceSupportsSkillInvocation?: (deviceId: string) => Promise<boolean>;
    skillCatalog?: (workspaceId: string) => Promise<readonly SkillCatalogEntry[]>;
    botSkillCatalog?: (
      deviceId: string,
      botId: string,
      chatId: string,
      workspaceId: string,
    ) => Promise<readonly SkillCatalogEntry[]>;
    resolveSkillInvocation?: (workspaceId: string, invocationId: string) => Promise<RegisteredSkill>;
    forks?: ConstructorParameters<typeof AidenRemoteChatService>[0]["forks"];
  } = {},
) {
  let current: Chat | null = structuredClone(initial);
  let creates = 0;
  let appends = 0;
  let notifications = 0;
  let begins = 0;
  let starts = 0;
  let lastGenerationOptions: Record<string, unknown> | null = null;
  const preparedInvocations: PreparedSkillInvocation[] = [];
  let botArchived = fixtureOptions.botArchived === true;
  const streams = new AidenRemoteStreamService({
    now: () => 10_000,
    cancel: () => true,
    approve: () => true,
  });
  const service = new AidenRemoteChatService({
    application: {
      list: async () => current ? [structuredClone(current)] : [],
      listRegular: async (workspaceId) => {
        fixtureOptions.onListRegular?.(workspaceId);
        if (
          !current ||
          current.botId !== undefined ||
          (workspaceId !== undefined && current.workspaceId !== workspaceId)
        ) {
          return [];
        }
        return [structuredClone(current)];
      },
      listSummaryMetadata: async () =>
        current && current.botId === undefined ? [structuredClone(current)] : [],
      get: async () => {
        await fixtureOptions.onPayloadGet?.();
        return {
          chat: current ? structuredClone(current) : null,
          imageArtifactRecoveryPending: fixtureOptions.imageArtifactRecoveryPending === true,
          imageArtifactRecoveryUnavailable: fixtureOptions.imageArtifactRecoveryUnavailable === true,
          reconciliation: null,
        };
      },
      create: async (input) => {
        creates += 1;
        current = chat({
          id: `chat-${creates + 1}`,
          workspaceId: input.workspaceId,
          providerId: input.providerId,
          model: input.model,
        });
        return structuredClone(current);
      },
      rename: async (_id, title, options) => {
        if (!current) throw new Error("missing");
        await options?.assertCurrent?.(current);
        current.title = title;
        current.updatedAt += 1;
        return structuredClone(current);
      },
      moveEmptyToWorkspace: async (_id, workspaceId, options) => {
        if (!current) throw new Error("missing");
        await options?.assertCurrent?.(current);
        if (current.messages.length) throw new Error("not empty");
        current.workspaceId = workspaceId;
        current.updatedAt += 1;
        return structuredClone(current);
      },
      remove: async (_id, options) => {
        if (!current) throw new Error("missing");
        await options?.assertCurrent?.(current);
        current = null;
      },
    },
    chatStore: {
      get: async () => current ? structuredClone(current) : null,
      appendMessage: async (_id, message, meta) => {
        if (!current || !meta?.isCurrent?.()) throw new Error("stale");
        appends += 1;
        const stored: ChatMessage = {
          id: message.id!,
          role: message.role,
          content: message.content,
          createdAt: 3_000,
          ...(message.attachments ? { attachments: structuredClone(message.attachments) } : {}),
          ...(message.skill ? { skill: structuredClone(message.skill) } : {}),
        };
        current.messages.push(stored);
        current.providerId = meta.providerId;
        current.model = meta.model;
        current.updatedAt += 1;
        return structuredClone(current);
      },
    },
    generation: {
      beginChatTurn: (_chatId, _turnId, _ownerId) => {
        begins += 1;
        let active = true;
        const releaseCleanups = new Set<() => void>();
        return {
          isActive: () => active,
          reserveAppendPayload: () => {
            if (!active) throw new Error("This message turn is no longer available.");
          },
          reserveSkillPreparation: () => {
            if (!active) {
              throw new SkillInvocationError(
                "turn_unavailable",
                "This skill turn is no longer available.",
              );
            }
          },
          prepareSkillInvocation: (invocation: PreparedSkillInvocation) => {
            if (!active) {
              throw new SkillInvocationError(
                "turn_unavailable",
                "This skill turn is no longer available.",
              );
            }
            preparedInvocations.push(invocation);
          },
          settleAsyncWork: () => undefined,
          onReleased: (cleanup: () => void) => {
            if (!active) cleanup();
            else releaseCleanups.add(cleanup);
          },
          release: () => {
            active = false;
            for (const cleanup of releaseCleanups) cleanup();
            releaseCleanups.clear();
          },
        };
      },
      start: async (streamId, _params, owner, generationOptions) => {
        starts += 1;
        lastGenerationOptions = generationOptions as Record<string, unknown>;
        if (fixtureOptions.startThrows) throw new Error("provider setup failed");
        generationOptions.onTurnAccepted();
        owner.send("chat:delta", { streamId, delta: "Answer" });
        const assistant: ChatMessage = {
          id: "assistant-1",
          role: "assistant",
          content: "Answer",
          createdAt: 4_000,
          reasoning: "private-safe-reasoning",
          pi: { role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "model-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4_000 },
        };
        current?.messages.push(assistant);
        owner.send("chat:done", { streamId, chat: current });
        return true;
      },
    },
    streams,
    models: {
      resolve: async (providerId, modelId) => ({
        providerId: providerId ?? "provider-1",
        modelId: modelId ?? "model-1",
        thinkingLevels: ["low", "high"],
        supportsImages: fixtureOptions.modelSupportsImages?.() ?? true,
      }),
    },
    bots: {
      get: async (id) =>
        fixtureOptions.botAvailable === false || current?.botId !== id
          ? null
          : {
              id,
              revision: `botrev:${id}`,
              name: "Fixture bot",
              instructions: "Be helpful.",
              avatar: { version: 1 as const, shape: "wisp" as const, color: "lilac" as const },
              createdAt: 1_000,
              updatedAt: 2_000,
              ...(botArchived ? { archivedAt: 3_000 } : {}),
            },
    },
    botMutations: new BotMutationGate(),
    ...(fixtureOptions.retainedBotChatAuthorizer
      ? { retainedBotChatAuthorizer: fixtureOptions.retainedBotChatAuthorizer }
      : {}),
    botTurnAuthorityPreflight:
      fixtureOptions.botTurnAuthorityPreflight ?? (async () => undefined),
    ...(fixtureOptions.attachments ? { attachments: fixtureOptions.attachments } : {}),
    ...(fixtureOptions.isTitlePending ? { isTitlePending: fixtureOptions.isTitlePending } : {}),
    notifyChanged: () => { notifications += 1; },
    ...(fixtureOptions.deviceSupportsQuestionPrompts
      ? { deviceSupportsQuestionPrompts: fixtureOptions.deviceSupportsQuestionPrompts }
      : {}),
    ...(fixtureOptions.deviceSupportsSkillInvocation
      ? { deviceSupportsSkillInvocation: fixtureOptions.deviceSupportsSkillInvocation }
      : {}),
    ...(fixtureOptions.skillCatalog ? { skillCatalog: fixtureOptions.skillCatalog } : {}),
    ...(fixtureOptions.botSkillCatalog ? { botSkillCatalog: fixtureOptions.botSkillCatalog } : {}),
    ...(fixtureOptions.resolveSkillInvocation
      ? { resolveSkillInvocation: fixtureOptions.resolveSkillInvocation }
      : {}),
    ...(fixtureOptions.forks ? { forks: fixtureOptions.forks } : {}),
  });
  return {
    service,
    streams,
    creates: () => creates,
    appends: () => appends,
    notifications: () => notifications,
    begins: () => begins,
    starts: () => starts,
    lastGenerationOptions: () => lastGenerationOptions,
    preparedInvocations: () => [...preparedInvocations],
    current: () => current ? structuredClone(current) : null,
    setBotArchived: (value: boolean) => { botArchived = value; },
  };
}

test("chat projection is path-free and excludes private Pi protocol and reasoning", () => {
  const projection = projectAidenRemoteChat(chat({
    messages: [{
      id: "user-1",
      role: "user",
      content: "Hello",
      reasoning: "hidden",
      createdAt: 2_000,
      attachments: [{
        id: "/Users/private/attachment-id",
        name: "/Users/private/notes.txt",
        mimeType: "text/plain",
        kind: "text",
        size: 5,
        text: "hello",
      }],
    }],
  }));
  assert.deepEqual(projection.messages[0], {
    id: "user-1",
    role: "user",
    text: "Hello",
    createdAt: new Date(2_000).toISOString(),
    attachments: [{
      id: `legacy_${createHash("sha256").update("/Users/private/attachment-id").digest("base64url")}`,
      name: "notes.txt",
      mimeType: "text/plain",
      kind: "text",
      size: 5,
    }],
  });
  assert.equal(JSON.stringify(projection).includes("reasoning"), false);
  assert.equal(JSON.stringify(projection).includes("/Users/private"), false);
  assert.match(projection.revision, /^rev_[A-Za-z0-9_-]{43}$/u);
});

test("chat history carries bounded displayable parent reasoning with valid spans", () => {
  const source = chat({ messages: [{
    id: "assistant-1", role: "assistant", content: "Done.", createdAt: 2_000,
    reasoning: "First\n\nSecond",
    timeline: {
      version: 3, generationId: "stream-1", status: "completed", startedAt: 1_000,
      finishedAt: 2_000, steps: [
        { id: "think-1", order: 0, kind: "thinking", startedAt: 1_000, updatedAt: 1_100,
          finishedAt: 1_100, contentOffset: 0, reasoningStartOffset: 0, reasoningEndOffset: 5 },
        { id: "tool-1", order: 1, kind: "tool", toolCallId: "call-1", toolName: "read_file",
          label: "Read file", status: "completed", startedAt: 1_100, updatedAt: 1_200,
          finishedAt: 1_200, contentOffset: 0 },
        { id: "think-2", order: 2, kind: "thinking", startedAt: 1_200, updatedAt: 1_300,
          finishedAt: 1_300, contentOffset: 0, reasoningStartOffset: 7, reasoningEndOffset: 13 },
      ],
    },
  }] });
  const projection = projectAidenRemoteChat(source);
  assert.equal(projection.messages[0]?.reasoning, "First\n\nSecond");
  assert.equal(projection.messages[0]?.timeline?.steps[2]?.kind === "thinking" &&
    projection.messages[0]?.timeline?.steps[2]?.reasoningEndOffset, 13);
});

test("optional history reasoning yields to the whole response budget", () => {
  const source = chat({ messages: Array.from({ length: 12 }, (_, index) => ({
    id: `assistant-${index}`, role: "assistant" as const, content: "Done.",
    reasoning: "r".repeat(90_000), createdAt: 2_000 + index,
  })) });
  const projection = projectAidenRemoteChat(source);
  assert.ok(projection.messages.some((message) => message.reasoning));
  assert.ok(projection.messages.some((message) => !message.reasoning));
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= 1_048_576);
  assert.equal(projection.messages.length, source.messages.length);
});

test("chat projection preserves visible parent message text exactly regardless of appearance", () => {
  const exactTexts = [
    "Unicode stays exact: Zażółć gęślą jaźń — 你好 — 👩🏽‍💻",
    "/Users/example/workspace/src/index.ts",
    "https://example.test/api/aiden/v1/chats?cursor=next#message",
    "550e8400-e29b-41d4-a716-446655440000",
    "U29tZSB2aXNpYmxlIHBhcmVudCBtZXNzYWdlIHRleHQu",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "Authorization: Bearer sk-test-visible-parent-message-0123456789",
    "Visible words stay opaque: children childRunIds subagentRunSnapshot childcareSummary",
    "Schema-looking prose stays opaque: subagentItems childTotal subagentProjectionNotices childTimedOut",
  ];
  const projection = projectAidenRemoteChat(chat({
    messages: exactTexts.map((content, index): ChatMessage => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content,
      createdAt: 2_000 + index,
    })),
  }));

  assert.deepEqual(
    projection.messages.map(({ text }) => text),
    exactTexts,
  );
  assert.deepEqual(
    parseAidenRemoteChatProjection(projection).messages.map(({ text }) => text),
    exactTexts,
  );
});

test("chat projection emits only parent state and rejects private child metadata", () => {
  const projection = projectAidenRemoteChat(chat({
    messages: [{
      id: "assistant-parent",
      role: "assistant",
      content: "Visible parent answer.",
      createdAt: 2_000,
      providerFailure: {
        version: 1,
        category: "interrupted",
        attempts: 1,
        retryExhausted: false,
      },
      timeline: {
        version: 3,
        generationId: "parent-generation",
        status: "failed",
        startedAt: 1_000,
        finishedAt: 2_000,
        steps: [],
      },
      subagents: {
        version: 1,
        generationId: "parent-generation",
        runIds: ["private-child-run"],
        items: [{
          runId: "private-child-run",
          label: "Private child",
          role: "scout",
          state: "completed",
        }],
        total: 1,
        completed: 1,
        failed: 0,
        timedOut: 0,
        interrupted: 0,
      },
    }],
  }));
  const parentMessage = projection.messages[0];

  assert.deepEqual(Object.keys(parentMessage ?? {}), [
    "id",
    "role",
    "text",
    "createdAt",
    "outcome",
    "timeline",
  ]);
  assert.equal(parentMessage?.text, "Visible parent answer.");
  assert.equal(parentMessage?.outcome?.status, "failed");
  assert.equal(parentMessage?.timeline?.generationId, "parent-generation");
  assert.equal(JSON.stringify(projection).includes("private-child-run"), false);
  assert.equal(JSON.stringify(projection).includes("Private child"), false);
  assert.deepEqual(parseAidenRemoteChatProjection(projection), projection);

  const privateSuffixes = [
    "Id",
    "Ids",
    "Count",
    "Counts",
    "History",
    "Histories",
    "Lifecycle",
    "Lifecycles",
    "State",
    "States",
    "Control",
    "Controls",
    "Snapshot",
    "Snapshots",
    "Message",
    "Messages",
    "Task",
    "Tasks",
    "Result",
    "Results",
    "Report",
    "Reports",
    "Run",
    "Runs",
  ] as const;
  const liveSubagentSchemaKeys = [
    "version",
    "runId",
    "runIds",
    "groupId",
    "generationId",
    "childId",
    "chatId",
    "workspaceId",
    "revision",
    "role",
    "label",
    "taskPreview",
    "state",
    "activity",
    "startedAt",
    "updatedAt",
    "finishedAt",
    "modelId",
    "turns",
    "tools",
    "tokens",
    "milestones",
    "projectionNotices",
    "latestText",
    "terminalMarkdown",
    "error",
    "warnings",
    "items",
    "total",
    "completed",
    "failed",
    "timedOut",
    "interrupted",
    "parentRunId",
    "retryOfRunId",
    "depth",
    "execution",
    "context",
    "authorityRevision",
  ] as const;
  const schemaCompoundForms = liveSubagentSchemaKeys.flatMap((key) => {
    const capitalized = `${key[0]?.toUpperCase()}${key.slice(1)}`;
    const separated = key.replace(/([a-z])([A-Z])/gu, "$1 $2");
    return [
      `child${capitalized}`,
      `subagent${capitalized}`,
      `CHILD.${separated.toUpperCase().replace(/ /gu, "-")}`,
      `SUB AGENT_${separated.toUpperCase().replace(/ /gu, ".")}`,
    ];
  });
  const privateFields = new Set([
    "child",
    "children",
    "subagent",
    "subagents",
    ...["child", "children", "subagent", "subagents"].flatMap((base) =>
      privateSuffixes.map((suffix) => `${base}${suffix}`)
    ),
    ...["childRun", "childRuns", "subagentRun", "subagentRuns"].flatMap((base) =>
      privateSuffixes.map((suffix) => `${base}${suffix}`)
    ),
    ...schemaCompoundForms,
    "subagentRunOpaqueExtension",
    " Child_Run IDs ",
    "SUB.AGENT run Snapshot",
    "children life-cycle",
  ]);
  const atLocations = (field: string): Record<string, unknown>[] => [
    { ...projection, [field]: {} },
    { ...projection, messages: [{ ...parentMessage, [field]: {} }] },
    {
      ...projection,
      futureDisplay: { nested: { [field]: {} } },
    },
  ];

  for (const privateField of privateFields) {
    for (const [location, candidate] of atLocations(privateField).entries()) {
      assert.throws(
        () => parseAidenRemoteChatProjection(candidate),
        /private child field/u,
        `${privateField} at location ${location}`,
      );
    }
  }

  for (const benignField of [
    "childcareSummary",
    "agentiveDisplay",
    "subagenticTheme",
  ]) {
    for (const candidate of atLocations(benignField)) {
      assert.deepEqual(
        parseAidenRemoteChatProjection(candidate),
        projection,
        benignField,
      );
    }
  }
});

test("chat projection exposes bot classification without changing regular chat keys", () => {
  const regular = projectAidenRemoteChat(chat());
  const bot = projectAidenRemoteChat(chat({ botId: "bot-1" }));
  const providerOnly = projectAidenRemoteChat(chat({ model: undefined }));
  const modelOnly = projectAidenRemoteChat(chat({ providerId: undefined }));

  assert.deepEqual(Object.keys(regular), [
    "id",
    "workspaceId",
    "title",
    "providerId",
    "modelId",
    "messages",
    "createdAt",
    "updatedAt",
    "revision",
  ]);
  assert.equal(bot.botId, "bot-1");
  assert.notEqual(bot.revision, regular.revision);
  assert.equal(providerOnly.providerId, undefined);
  assert.equal(providerOnly.modelId, undefined);
  assert.equal(modelOnly.providerId, undefined);
  assert.equal(modelOnly.modelId, undefined);
});

test("chat projection rejects more than 10,000 visible messages before emission", () => {
  const messages: ChatMessage[] = Array.from({ length: 10_001 }, (_, index) => ({
    id: `message-${index}`,
    role: "user",
    content: "",
    createdAt: 2_000 + index,
  }));
  assert.throws(
    () => projectAidenRemoteChat(chat({ messages })),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "payload_too_large" &&
      (error as { status?: number }).status === 413,
  );
});

test("chat projection validates every frozen Chat identity and chronology bound", () => {
  const maximum = projectAidenRemoteChat(chat({
    id: "c".repeat(128),
    workspaceId: "w".repeat(128),
    botId: "b".repeat(160),
    title: "t".repeat(1_025),
    providerId: "p".repeat(256),
    model: "m".repeat(512),
    createdAt: 1_000,
    updatedAt: 1_000,
    messages: [{
      id: "i".repeat(128),
      role: "user",
      content: "Hello",
      createdAt: 1_000,
    }],
  }));
  assert.equal(maximum.id.length, 128);
  assert.equal(maximum.workspaceId.length, 128);
  assert.equal(maximum.botId?.length, 160);
  assert.equal(maximum.title.length, 1_024);
  assert.equal(maximum.providerId?.length, 256);
  assert.equal(maximum.modelId?.length, 512);
  assert.equal(maximum.messages[0]?.id.length, 128);
  assert.match(maximum.revision, /^rev_[A-Za-z0-9_-]{43}$/u);

  const invalid: Array<readonly [string, Chat]> = [
    ["chat id", chat({ id: "c".repeat(129) })],
    ["empty workspace id", chat({ workspaceId: "" })],
    ["workspace id", chat({ workspaceId: "w".repeat(129) })],
    ["Bot id", chat({ botId: "../private" })],
    ["provider id", chat({ providerId: "p".repeat(257) })],
    ["model id", chat({ model: "m".repeat(513) })],
    ["empty message id", chat({
      messages: [{ id: "", role: "user", content: "Hello", createdAt: 1_000 }],
    })],
    ["message id", chat({
      messages: [{
        id: "i".repeat(129),
        role: "user",
        content: "Hello",
        createdAt: 1_000,
      }],
    })],
    ["non-finite chat creation time", chat({ createdAt: Number.NaN })],
    ["non-finite chat update time", chat({ updatedAt: Number.POSITIVE_INFINITY })],
    ["out-of-range chat time", chat({ createdAt: Number.MAX_VALUE })],
    ["non-finite message time", chat({
      messages: [{
        id: "message-1",
        role: "user",
        content: "Hello",
        createdAt: Number.NEGATIVE_INFINITY,
      }],
    })],
    ["backward chat chronology", chat({ createdAt: 2_000, updatedAt: 1_999 })],
  ];
  for (const [label, candidate] of invalid) {
    assert.throws(
      () => projectAidenRemoteChat(candidate),
      (error: unknown) =>
        (error as { code?: string; status?: number }).code === "internal_error" &&
        (error as { status?: number }).status === 500,
      label,
    );
  }
});

test("chat projection truncates title and text by Unicode scalar without splitting emoji", () => {
  const exactTitle = `${"t".repeat(1_023)}😀`;
  const exactText = `${"x".repeat(199_999)}😀`;
  const exact = projectAidenRemoteChat(chat({
    title: exactTitle,
    messages: [{
      id: "message-scalar-boundary",
      role: "assistant",
      content: exactText,
      createdAt: 2_000,
    }],
  }));
  assert.equal(exact.title, exactTitle);
  assert.equal(exact.messages[0]?.text, exactText);
  assert.equal(Array.from(exact.title).length, 1_024);
  assert.equal(Array.from(exact.messages[0]?.text ?? "").length, 200_000);

  const oversized = projectAidenRemoteChat(chat({
    title: `${exactTitle}discarded`,
    messages: [{
      id: "message-scalar-oversize",
      role: "assistant",
      content: `${exactText}discarded`,
      createdAt: 2_000,
    }],
  }));
  assert.equal(oversized.title, exactTitle);
  assert.equal(oversized.messages[0]?.text, exactText);
  assert.equal(oversized.title.endsWith("😀"), true);
  assert.equal(oversized.messages[0]?.text.endsWith("😀"), true);
});

test("workspace chat lists use the regular-only application classification", async () => {
  const requestedWorkspaces: Array<string | undefined> = [];
  const regular = fixture(chat(), {
    onListRegular: (workspaceId) => requestedWorkspaces.push(workspaceId),
  });
  const bot = fixture(chat({ id: "bot-chat-1", botId: "bot-1" }));

  assert.deepEqual((await regular.service.list("workspace-1")).chats.map(({ id }) => id), ["chat-1"]);
  assert.deepEqual(await bot.service.list("workspace-1"), { chats: [] });
  assert.deepEqual(requestedWorkspaces, ["workspace-1"]);
});

test("chat classification reads only main-owned metadata before payload access", async () => {
  let payloadReads = 0;
  const { service } = fixture(
    chat({ botId: "bot-1" }),
    { onPayloadGet: () => { payloadReads += 1; } },
  );

  assert.deepEqual(await service.classify("chat-1"), { botId: "bot-1" });
  assert.equal(payloadReads, 0);
  await service.get("chat-1");
  assert.equal(payloadReads, 1);
});

test("Bot chat mutation rechecks authoritative archive state inside the lifecycle gate", async () => {
  const app = fixture(chat({ botId: "bot-1" }), {
    retainedBotChatAuthorizer: () => true,
  });
  const classification = await app.service.classify("chat-1");
  let mutated = false;

  app.setBotArchived(true);
  await assert.rejects(
    app.service.runMutation("device-1", "chat-1", classification, async () => {
      mutated = true;
    }),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "bot_archived" &&
      (error as { status?: number }).status === 409,
  );
  assert.equal(mutated, false);
  assert.deepEqual(await app.service.classify("chat-1"), {
    botId: "bot-1",
    botArchived: true,
  });
});

test("retained Bot chat authorization is absent-by-default and fails closed", async () => {
  const denied = fixture(chat({ botId: "bot-1" }));
  assert.equal(await denied.service.authorizeRetainedBotChat({
    deviceId: "device-1",
    chatId: "chat-1",
    botId: "bot-1",
    access: "read",
  }), false);

  const seen: unknown[] = [];
  const allowed = fixture(chat({ botId: "bot-1" }), {
    retainedBotChatAuthorizer: (request) => {
      seen.push(request);
      return request.access === "read";
    },
  });
  assert.equal(await allowed.service.authorizeRetainedBotChat({
    deviceId: "device-1",
    chatId: "chat-1",
    botId: "bot-1",
    access: "read",
  }), true);
  assert.equal(await allowed.service.authorizeRetainedBotChat({
    deviceId: "device-1",
    chatId: "chat-1",
    botId: "bot-1",
    access: "write",
  }), false);
  assert.deepEqual(seen, [
    {
      deviceId: "device-1",
      chatId: "chat-1",
      botId: "bot-1",
      access: "read",
    },
    {
      deviceId: "device-1",
      chatId: "chat-1",
      botId: "bot-1",
      access: "write",
    },
  ]);

  const throwing = fixture(chat({ botId: "bot-1" }), {
    retainedBotChatAuthorizer: () => { throw new Error("policy unavailable"); },
  });
  assert.equal(await throwing.service.authorizeRetainedBotChat({
    deviceId: "device-1",
    chatId: "chat-1",
    botId: "bot-1",
    access: "read",
  }), false);
});

test("Bot policy narrowing between preflight and the lifecycle gate prevents the effect", async () => {
  let authorized = true;
  const app = fixture(chat({ botId: "bot-1" }), {
    retainedBotChatAuthorizer: () => authorized,
  });
  const classification = await app.service.classify("chat-1");
  assert.equal(await app.service.authorizeRetainedBotChat({
    deviceId: "device-1",
    chatId: "chat-1",
    botId: "bot-1",
    access: "write",
  }), true);

  authorized = false;
  let mutated = false;
  await assert.rejects(
    app.service.runMutation("device-1", "chat-1", classification, async () => {
      mutated = true;
    }),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "not_found" &&
      (error as { status?: number }).status === 404,
  );
  assert.equal(mutated, false);
});

test("ordinary workspace moves always reject Bot chats and preserve managed-home binding", async () => {
  const app = fixture(chat({ botId: "bot-1", workspaceId: "bot-home-1" }), {
    retainedBotChatAuthorizer: () => true,
  });

  await assert.rejects(
    app.service.move(
      "device-1",
      "chat-1",
      projectAidenRemoteChat(app.current()!).revision,
      "bot-move-denied-0001",
      { workspaceId: "workspace-2", confirmedForeground: true },
    ),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "not_found" &&
      (error as { status?: number }).status === 404,
  );
  assert.equal(app.current()?.workspaceId, "bot-home-1");
  assert.equal(app.notifications(), 0);
});

test("ordinary chat deletion cannot remove a Bot's persistent chat", async () => {
  const app = fixture(chat({ botId: "bot-1", workspaceId: "bot-home-1" }), {
    retainedBotChatAuthorizer: () => true,
  });

  await assert.rejects(
    app.service.remove(
      "chat-1",
      projectAidenRemoteChat(app.current()!).revision,
    ),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "not_found" &&
      (error as { status?: number }).status === 404,
  );
  assert.equal(app.current()?.id, "chat-1");
  assert.equal(app.notifications(), 0);
});

test("Bot chat classification fails closed when its authoritative Bot is unavailable", async () => {
  const app = fixture(chat({ botId: "bot-1" }), { botAvailable: false });
  await assert.rejects(
    app.service.classify("chat-1"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("chat projection preserves only renderer-safe exceptional outcomes", () => {
  const projection = projectAidenRemoteChat(chat({
    messages: [
      {
        id: "assistant-failed",
        role: "assistant",
        content: "Partial answer",
        createdAt: 2_000,
        providerFailure: {
          version: 1,
          category: "service_unavailable",
          attempts: 2,
          retryExhausted: true,
        },
      },
      {
        id: "assistant-cancelled",
        role: "assistant",
        content: "Stopped answer",
        createdAt: 3_000,
        timeline: {
          version: 3,
          generationId: "stream-safe",
          status: "cancelled",
          startedAt: 1_000,
          finishedAt: 2_000,
          cancellationOrigin: "user_stop",
          steps: [],
        },
      },
      {
        id: "assistant-complete",
        role: "assistant",
        content: "Complete answer",
        createdAt: 4_000,
        timeline: {
          version: 3,
          generationId: "stream-complete",
          status: "completed",
          startedAt: 1_000,
          finishedAt: 2_000,
          steps: [],
        },
      },
    ],
  }));

  assert.deepEqual(projection.messages.map((message) => message.outcome), [
    {
      status: "failed",
      category: "service_unavailable",
      attempts: 2,
      retryExhausted: true,
    },
    { status: "cancelled" },
    undefined,
  ]);
  assert.notEqual(projection.revision, projectAidenRemoteChat(chat()).revision);
});

test("chat projection retains only the sanitized activity timeline", () => {
  const safeTimeline = {
    version: 3 as const,
    generationId: "stream-safe",
    status: "completed" as const,
    startedAt: 1_000,
    finishedAt: 2_000,
    steps: [{
      id: "tool-1",
      order: 0,
      kind: "tool" as const,
      toolCallId: "call-1",
      toolName: "read_file",
      label: "Read file",
      status: "completed" as const,
      startedAt: 1_000,
      updatedAt: 2_000,
      finishedAt: 2_000,
      contentOffset: 0,
      target: "README.md",
    }],
  };
  const projection = projectAidenRemoteChat(chat({
    messages: [
      { id: "assistant-safe", role: "assistant", content: "Done", createdAt: 2_000, timeline: safeTimeline },
      {
        id: "assistant-unsafe",
        role: "assistant",
        content: "No leak",
        createdAt: 3_000,
        timeline: { ...safeTimeline, steps: [{ ...safeTimeline.steps[0], target: "/Users/private/secret" }] },
      },
    ],
  }));
  assert.deepEqual(projection.messages[0]?.timeline, safeTimeline);
  assert.equal(projection.messages[1]?.timeline, undefined);
  assert.doesNotMatch(JSON.stringify(projection), /Users\/private/u);
});

test("chat projection accepts timeline offsets measured in JavaScript UTF-16 units", () => {
  const timeline = {
    version: 3 as const,
    generationId: "stream-emoji",
    status: "completed" as const,
    startedAt: 1_000,
    finishedAt: 2_000,
    steps: [{
      id: "think-1",
      order: 0,
      kind: "thinking" as const,
      startedAt: 1_000,
      updatedAt: 2_000,
      finishedAt: 2_000,
      contentOffset: 2,
    }],
  };
  const projection = projectAidenRemoteChat(chat({
    messages: [{
      id: "assistant-emoji",
      role: "assistant",
      content: "😀",
      createdAt: 2_000,
      timeline,
    }],
  }));

  assert.deepEqual(projection.messages[0]?.timeline, timeline);
  assert.equal(projection.messages[0]?.timeline?.steps[0]?.contentOffset, 2);
});

test("chat projection omits a timeline that points beyond truncated assistant text", () => {
  const projectedPrefix = "x".repeat(200_000);
  const storedMessage: ChatMessage = {
    id: "assistant-over-limit-timeline",
    role: "assistant",
    content: `${projectedPrefix}private-tail`,
    createdAt: 2_000,
    timeline: {
      version: 3,
      generationId: "stream-over-limit",
      status: "completed",
      startedAt: 1_000,
      finishedAt: 2_000,
      steps: [{
        id: "think-1",
        order: 0,
        kind: "thinking",
        startedAt: 1_000,
        updatedAt: 2_000,
        finishedAt: 2_000,
        contentOffset: projectedPrefix.length + 1,
      }],
    },
  };
  const stored = chat({ messages: [storedMessage] });
  const projection = projectAidenRemoteChat(stored);

  assert.equal(projection.messages[0]?.text, projectedPrefix);
  assert.equal(projection.messages[0]?.timeline, undefined);
  assert.notEqual(
    projection.revision,
    projectAidenRemoteChat(chat({
      messages: [{ ...storedMessage, timeline: undefined }],
    })).revision,
    "the stored timeline remains revision-significant even when it cannot be projected",
  );

  const prefixTimeline = projectAidenRemoteChat(chat({
    messages: [{
      ...storedMessage,
      timeline: {
        ...storedMessage.timeline!,
        steps: [{
          ...storedMessage.timeline!.steps[0]!,
          contentOffset: projectedPrefix.length,
        }],
      },
    }],
  }));
  assert.equal(
    prefixTimeline.messages[0]?.timeline?.steps[0]?.contentOffset,
    projectedPrefix.length,
  );
});

test("chat reads expose an in-flight background title without changing the revision", async () => {
  let pending = true;
  const app = fixture(chat(), { isTitlePending: () => pending });

  const whilePending = await app.service.get("chat-1");
  assert.equal(whilePending.titlePending, true);
  const revision = whilePending.revision;

  pending = false;
  const settled = await app.service.get("chat-1");
  assert.equal("titlePending" in settled, false);
  assert.equal(settled.revision, revision);
});

test("remote chat reads fail closed while image artifacts need recovery or repair", async () => {
  await assert.rejects(
    fixture(chat(), { imageArtifactRecoveryPending: true }).service.get("chat-1"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "operation_in_progress",
  );
  await assert.rejects(
    fixture(chat(), { imageArtifactRecoveryUnavailable: true }).service.get("chat-1"),
    /storage repair/u,
  );
});

test("chat create is device-scoped idempotent and CRUD checks exact revisions", async () => {
  const app = fixture();
  const key = "chat-create-key-00001";
  const created = await app.service.create("device-1", key, { workspaceId: "workspace-1" });
  assert.deepEqual(await app.service.create("device-1", key, { workspaceId: "workspace-1" }), created);
  assert.equal(app.creates(), 1);
  await assert.rejects(
    app.service.rename(created.id, "rev_stale", { title: "Changed" }),
    (error: unknown) => (error as { code?: string }).code === "revision_conflict",
  );
  const renamed = await app.service.rename(created.id, created.revision, { title: "Changed" });
  assert.equal(renamed.title, "Changed");
  await app.service.remove(created.id, renamed.revision);
  assert.equal(app.notifications(), 3);
});

test("summary revisions are valid optimistic-concurrency tokens for chat mutations", async () => {
  const app = fixture(chat());
  const summary = (await app.service.listSummaries()).summaries[0]!;
  const renamed = await app.service.rename(summary.id, summary.revision, {
    title: "Changed from summary",
  });
  assert.equal(renamed.title, "Changed from summary");
});

test("ordinary chat creation rejects a client-authored bot id", async () => {
  const app = fixture();

  await assert.rejects(
    app.service.create("device-1", "chat-create-key-00002", {
      workspaceId: "workspace-1",
      botId: "bot-forged",
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  assert.equal(app.creates(), 0);
});

test("remote turn atomically appends once, owns its stream, and replays the accepted response", async () => {
  const app = fixture();
  const key = "turn-start-key-000001";
  const first = await app.service.startTurn("device-1", "chat-1", key, { text: "Hello" });
  const replay = await app.service.startTurn("device-1", "chat-1", key, { text: "Hello" });
  assert.deepEqual(replay, first);
  assert.equal(app.appends(), 1);
  assert.equal(first.message.text, "Hello");
  const status = app.streams.status("device-1", first.streamId);
  assert.equal(status.state, "done");
  assert.throws(
    () => app.streams.status("device-2", first.streamId),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("remote Bot turn rejects a provider-model override before durable append", async () => {
  const app = fixture(chat({ botId: "bot-1" }), {
    retainedBotChatAuthorizer: () => true,
  });

  await assert.rejects(
    app.service.startTurn("device-1", "chat-1", "bot-model-override-0001", {
      text: "must not persist",
      providerId: "provider-2",
      modelId: "model-2",
    }),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "invalid_request" &&
      (error as { status?: number }).status === 400,
  );
  assert.equal(app.appends(), 0);
  assert.deepEqual(app.current()?.messages, []);
  assert.equal(app.current()?.providerId, "provider-1");
  assert.equal(app.current()?.model, "model-1");
});

test("remote Bot turn preflights protected runtime authority before reserving or consuming", async () => {
  let protectedPairMatches = false;
  const attachments = new AidenRemoteAttachmentStore({
    now: () => 10_000,
    randomId: () => `att_${"A".repeat(43)}`,
  });
  const app = fixture(chat({ botId: "bot-1" }), {
    attachments,
    retainedBotChatAuthorizer: () => true,
    botTurnAuthorityPreflight: async (request) => {
      assert.deepEqual(request, {
        audienceId: "device-1",
        botId: "bot-1",
        chatId: "chat-1",
        providerId: "provider-1",
        model: "model-1",
      });
      if (!protectedPairMatches) {
        throw new Error("protected Bot policy uses another model");
      }
    },
  });
  const image = await app.service.uploadAttachment("device-1", "chat-1", {
    name: "still-available.png",
    mimeType: "image/png",
    kind: "image",
    data: ONE_PIXEL_PNG,
  });

  await assert.rejects(
    app.service.startTurn("device-1", "chat-1", "bot-policy-mismatch-0001", {
      text: "must not persist",
      attachmentIds: [image.id],
    }),
    /protected Bot policy uses another model/u,
  );
  assert.equal(app.appends(), 0);
  assert.equal(app.begins(), 0);
  assert.equal(app.starts(), 0);
  assert.deepEqual(app.current()?.messages, []);

  // The same one-shot attachment can be used after authority is restored,
  // proving the denied preflight did not consume it.
  protectedPairMatches = true;
  const accepted = await app.service.startTurn(
    "device-1",
    "chat-1",
    "bot-policy-restored-0001",
    { text: "now allowed", attachmentIds: [image.id] },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(app.appends(), 1);
  assert.equal(app.begins(), 1);
  assert.equal(app.starts(), 1);
});

test("remote turns reject images for text-only models without consuming the attachment", async () => {
  let supportsImages = false;
  let supportsCompanionImages = false;
  const attachments = new AidenRemoteAttachmentStore({
    now: () => 10_000,
    randomId: () => `att_${"V".repeat(43)}`,
  });
  const app = fixture(chat({ botId: "bot-1" }), {
    attachments,
    retainedBotChatAuthorizer: () => true,
    modelSupportsImages: () => supportsImages,
    botTurnAuthorityPreflight: async () => ({ supportsCompanionImages }),
  });
  const image = await app.service.uploadAttachment("device-1", "chat-1", {
    name: "visible.png",
    mimeType: "image/png",
    kind: "image",
    data: ONE_PIXEL_PNG,
  });

  await assert.rejects(
    app.service.startTurn("device-1", "chat-1", "text-only-image-0001", {
      text: "Can you see this?",
      attachmentIds: [image.id],
    }),
    (error: unknown) =>
      (error as { code?: string; status?: number; message?: string }).code === "invalid_request" &&
      (error as { status?: number }).status === 400 &&
      /Edit Bot/u.test((error as { message?: string }).message ?? ""),
  );
  assert.equal(app.appends(), 0);
  assert.equal(app.begins(), 0);
  assert.equal(app.starts(), 0);

  supportsCompanionImages = true;
  const accepted = await app.service.startTurn(
    "device-1",
    "chat-1",
    "vision-image-0001",
    { text: "Can you see this?", attachmentIds: [image.id] },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(app.appends(), 1);
  assert.equal(supportsImages, false, "the companion route must not pretend the primary is multimodal");
});

test("a provider setup failure after append returns the one accepted message with a terminal error stream", async () => {
  const app = fixture(chat(), { startThrows: true });
  const accepted = await app.service.startTurn(
    "device-1",
    "chat-1",
    "turn-failure-key-0001",
    { text: "Keep this once" },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.message.text, "Keep this once");
  assert.equal(app.appends(), 1);
  assert.equal(app.streams.status("device-1", accepted.streamId).state, "error");
  assert.deepEqual(
    await app.service.startTurn("device-1", "chat-1", "turn-failure-key-0001", { text: "Keep this once" }),
    accepted,
  );
  assert.equal(app.appends(), 1);
});

test("remote attachments are one-use, bounded, and projected without inline contents", async () => {
  let sequence = 0;
  const attachments = new AidenRemoteAttachmentStore({
    now: () => 10_000,
    randomId: () => `att_${String(sequence++).padStart(43, "A")}`,
  });
  const app = fixture(chat(), { attachments });
  const image = await app.service.uploadAttachment("device-1", "chat-1", {
    name: "diagram.png",
    mimeType: "image/png",
    kind: "image",
    data: ONE_PIXEL_PNG,
  });
  const text = await app.service.uploadAttachment("device-1", "chat-1", {
    name: "notes.md",
    mimeType: "text/markdown",
    kind: "text",
    text: "# Notes",
  });

  const accepted = await app.service.startTurn(
    "device-1",
    "chat-1",
    "turn-attachments-0001",
    { text: "", attachmentIds: [image.id, text.id] },
  );
  assert.deepEqual(accepted.message.attachments, [
    { id: image.id, name: "diagram.png", mimeType: "image/png", kind: "image", size: 70 },
    { id: text.id, name: "notes.md", mimeType: "text/markdown", kind: "text", size: 7 },
  ]);
  const serialized = JSON.stringify(accepted.message);
  assert.equal(serialized.includes(ONE_PIXEL_PNG), false);
  assert.equal(serialized.includes("# Notes"), false);
  assert.deepEqual(app.current()?.messages[0]?.attachments?.map(({ name, kind }) => ({ name, kind })), [
    { name: "diagram.png", kind: "image" },
    { name: "notes.md", kind: "text" },
  ]);
  const imageContent = await app.service.attachmentContent("chat-1", image.id);
  assert.equal(imageContent.mimeType, "image/png");
  assert.equal(imageContent.bytes.toString("base64"), ONE_PIXEL_PNG);
  await assert.rejects(
    app.service.attachmentContent("chat-1", text.id),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
  await assert.rejects(
    app.service.attachmentContent("chat-2", image.id),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
  await assert.rejects(
    app.service.attachmentContent("chat-1", "missing-attachment"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
  await assert.rejects(
    app.service.startTurn("device-1", "chat-1", "turn-attachments-0002", {
      text: "Do not reuse",
      attachmentIds: [image.id],
    }),
    (error: unknown) => (error as { code?: string }).code === "handle_invalid",
  );
});

test("attachment content fails closed when projected identifiers are ambiguous", async () => {
  const duplicate = "attachment-duplicate";
  const attachment = {
    id: duplicate,
    name: "duplicate.png",
    mimeType: "image/png",
    kind: "image" as const,
    size: 70,
    data: ONE_PIXEL_PNG,
  };
  const app = fixture(chat({
    messages: [{
      id: "message-1",
      role: "user",
      content: "Two copies",
      createdAt: 1_500,
      attachments: [attachment, { ...attachment }],
    }],
  }));
  await assert.rejects(
    app.service.attachmentContent("chat-1", duplicate),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("attachment content never exposes images from hidden message roles", async () => {
  const app = fixture(chat({
    messages: [{
      id: "system-image-message",
      role: "system",
      content: "private",
      createdAt: 1_500,
      attachments: [{
        id: "hidden-system-image",
        name: "hidden.png",
        mimeType: "image/png",
        kind: "image",
        size: Buffer.from(ONE_PIXEL_PNG, "base64").byteLength,
        data: ONE_PIXEL_PNG,
      }],
    }],
  }));
  await assert.rejects(
    app.service.attachmentContent("chat-1", "hidden-system-image"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("assistant image attachments project to paired clients and retain authenticated content", async () => {
  const imageBytes = Buffer.from(ONE_PIXEL_PNG, "base64");
  const app = fixture(chat({
    messages: [{
      id: "assistant-image-message",
      role: "assistant",
      content: "Here it is.",
      createdAt: 1_500,
      attachments: [{
        id: "assistant-shared-image",
        name: "Result.png",
        mimeType: "image/png",
        kind: "image",
        size: imageBytes.length,
        data: ONE_PIXEL_PNG,
      }],
    }],
  }));
  const projected = await app.service.get("chat-1");
  assert.deepEqual(projected.messages[0]?.attachments, [{
    id: "assistant-shared-image",
    name: "Result.png",
    mimeType: "image/png",
    kind: "image",
    size: imageBytes.length,
  }]);
  const content = await app.service.attachmentContent("chat-1", "assistant-shared-image");
  assert.equal(content.mimeType, "image/png");
  assert.deepEqual(content.bytes, imageBytes);
});

test("attachment content rejects stored raster bytes that do not match their MIME type", async () => {
  const app = fixture(chat({
    messages: [{
      id: "message-1",
      role: "assistant",
      content: "Generated image",
      createdAt: 1_500,
      attachments: [{
        id: "mismatched-image",
        name: "mismatched.jpg",
        mimeType: "image/jpeg",
        kind: "image",
        size: 70,
        data: ONE_PIXEL_PNG,
      }],
    }],
  }));
  await assert.rejects(
    app.service.attachmentContent("chat-1", "mismatched-image"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("attachment content rejects canonical raster formats outside the public PNG and JPEG contract", async () => {
  const app = fixture(chat({
    messages: [{
      id: "message-1",
      role: "assistant",
      content: "Generated animation",
      createdAt: 1_500,
      attachments: [{
        id: "unsupported-gif",
        name: "animation.gif",
        mimeType: "image/gif",
        kind: "image",
        size: Buffer.from(ONE_PIXEL_GIF, "base64").byteLength,
        data: ONE_PIXEL_GIF,
      }],
    }],
  }));
  await assert.rejects(
    app.service.attachmentContent("chat-1", "unsupported-gif"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("attachment content rejects a truncated image even when its header and metadata remain readable", async () => {
  const complete = Buffer.from(ONE_PIXEL_PNG, "base64");
  const truncated = complete.subarray(0, complete.length - 12);
  const app = fixture(chat({
    messages: [{
      id: "message-1",
      role: "assistant",
      content: "Incomplete image",
      createdAt: 1_500,
      attachments: [{
        id: "truncated-image",
        name: "truncated.png",
        mimeType: "image/png",
        kind: "image",
        size: truncated.byteLength,
        data: truncated.toString("base64"),
      }],
    }],
  }));
  await assert.rejects(
    app.service.attachmentContent("chat-1", "truncated-image"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("attachment references enforce device, chat, expiry, revocation, dimensions, and capacity", () => {
  let now = 20_000;
  let sequence = 0;
  const store = new AidenRemoteAttachmentStore({
    now: () => now,
    randomId: () => `att_${String(sequence++).padStart(43, "B")}`,
    maxEntries: 2,
  });
  const first = store.upload("device-1", "chat-1", {
    name: "one.txt",
    mimeType: "text/plain",
    kind: "text",
    text: "one",
  });
  assert.throws(
    () => store.consume("device-2", "chat-1", [first.id]),
    (error: unknown) => (error as { code?: string }).code === "handle_wrong_device",
  );
  assert.throws(
    () => store.consume("device-1", "chat-2", [first.id]),
    (error: unknown) => (error as { code?: string }).code === "handle_invalid",
  );
  assert.throws(
    () => store.consume("device-1", "chat-1", [first.id, first.id]),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  assert.throws(
    () => store.consume(
      "device-1",
      "chat-1",
      Array.from({ length: 11 }, (_, index) => `att_${String(index).padStart(43, "D")}`),
    ),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  now += AIDEN_REMOTE_ATTACHMENT_TTL_MS;
  assert.throws(
    () => store.consume("device-1", "chat-1", [first.id]),
    (error: unknown) => (error as { code?: string }).code === "handle_expired",
  );

  const revoked = store.upload("device-1", "chat-1", {
    name: "revoked.txt",
    mimeType: "text/plain",
    kind: "text",
    text: "private",
  });
  store.revokeDevice("device-1");
  assert.throws(
    () => store.consume("device-1", "chat-1", [revoked.id]),
    (error: unknown) => (error as { code?: string }).code === "handle_invalid",
  );

  const oversizedDimensions = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(oversizedDimensions, 0);
  Buffer.from("IHDR", "ascii").copy(oversizedDimensions, 12);
  oversizedDimensions.writeUInt32BE(20_000, 16);
  oversizedDimensions.writeUInt32BE(1, 20);
  assert.throws(
    () => store.upload("device-1", "chat-1", {
      name: "huge.png",
      mimeType: "image/png",
      kind: "image",
      data: oversizedDimensions.toString("base64"),
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  assert.throws(
    () => store.upload("device-1", "chat-1", {
      name: "../secret.txt",
      mimeType: "text/plain",
      kind: "text",
      text: "secret",
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );

  const capacity = new AidenRemoteAttachmentStore({
    now: () => now,
    randomId: () => `att_${String(sequence++).padStart(43, "C")}`,
    maxEntries: 1,
  });
  capacity.upload("device-1", "chat-1", {
    name: "first.txt",
    mimeType: "text/plain",
    kind: "text",
    text: "first",
  });
  assert.throws(
    () => capacity.upload("device-1", "chat-1", {
      name: "second.txt",
      mimeType: "text/plain",
      kind: "text",
      text: "second",
    }),
    (error: unknown) => (error as { code?: string }).code === "handle_capacity",
  );
});

test("attachment uploads cannot finish after device revocation or chat deletion during lookup", async () => {
  for (const revoke of ["device", "chat"] as const) {
    const attachments = new AidenRemoteAttachmentStore();
    let resume!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const app = fixture(chat(), { attachments, onPayloadGet: () => held });
    const pending = app.service.uploadAttachment("device-1", "chat-1", {
      kind: "text", name: "private.txt", mimeType: "text/plain", text: "private",
    });
    if (revoke === "device") app.service.revokeDevice("device-1");
    else attachments.beginChatDeletion("chat-1")();
    resume();
    await assert.rejects(pending, (error: unknown) =>
      (error as { code?: string }).code === "handle_invalid");
  }
});

test("chat cleanup releases upload capacity across devices and preserves other chats", () => {
  const store = new AidenRemoteAttachmentStore({ maxEntries: 3 });
  const input = { kind: "text", name: "private.txt", mimeType: "text/plain", text: "private" };
  const first = store.upload("device-1", "chat-1", input);
  const second = store.upload("device-2", "chat-1", input);
  const retained = store.upload("device-1", "chat-2", input);
  const finish = store.beginChatDeletion("chat-1");
  assert.throws(() => store.upload("device-1", "chat-1", input));
  store.revokeChat("chat-1");
  store.revokeChat("chat-1");
  finish();
  for (const [device, id] of [["device-1", first.id], ["device-2", second.id]]) {
    assert.throws(() => store.consume(device!, "chat-1", [id]));
  }
  assert.equal(store.consume("device-1", "chat-2", [retained.id])?.[0]?.text, "private");
  store.upload("device-1", "chat-3", input);
  const nextDeletion = store.beginChatDeletion("chat-1");
  finish();
  assert.throws(() => store.beginUpload("device-1", "chat-1"));
  nextDeletion();
});

test("invalidated uploads remain bounded until their retained request bodies settle", () => {
  const store = new AidenRemoteAttachmentStore();
  const leases = Array.from({ length: 256 }, () => store.beginUpload("device-1", "chat-1"));
  store.revokeDevice("device-1");
  assert.throws(() => store.beginUpload("device-2", "chat-2"),
    (error: unknown) => (error as { code?: string }).code === "handle_capacity");
  for (const lease of leases) {
    assert.throws(() => lease.assertCurrent());
    lease.release();
  }
  store.beginUpload("device-2", "chat-2").release();
});

test("question tool is exposed only to devices granted the question capability", async () => {
  const supported = fixture(chat(), {
    deviceSupportsQuestionPrompts: async (deviceId) => deviceId === "device-1",
  });
  await supported.service.startTurn("device-1", "chat-1", "question-turn-001", {
    text: "help me choose",
  });
  const supportedOptions = supported.lastGenerationOptions();
  assert.equal(
    supportedOptions?.excludeToolNames,
    undefined,
    "capable devices must keep ask_user_question available",
  );

  const unsupported = fixture(chat(), {
    deviceSupportsQuestionPrompts: async () => false,
  });
  await unsupported.service.startTurn("device-1", "chat-1", "question-turn-002", {
    text: "help me choose",
  });
  const excluded = unsupported.lastGenerationOptions()?.excludeToolNames;
  assert.ok(excluded instanceof Set);
  assert.ok((excluded as Set<string>).has("ask_user_question"));

  const missingGate = fixture(chat());
  await missingGate.service.startTurn("device-1", "chat-1", "question-turn-003", {
    text: "help me choose",
  });
  const missingExcluded = missingGate.lastGenerationOptions()?.excludeToolNames;
  assert.ok(missingExcluded instanceof Set);
  assert.ok(
    (missingExcluded as Set<string>).has("ask_user_question"),
    "without a host capability lookup the question tool must stay excluded",
  );
});

test("chat skill catalog revalidates the workspace projection and narrows Bot chats", async () => {
  const entries = [
    {
      invocationId: `sk1_${"a".repeat(43)}`,
      name: "review-code",
      description: "Review changes.",
      source: "workspace" as const,
      available: true,
    },
  ];
  const app = fixture(chat({ workspaceId: "workspace-9" }), {
    skillCatalog: async (workspaceId) => {
      assert.equal(workspaceId, "workspace-9");
      return entries;
    },
  });
  const catalog = await app.service.chatSkillCatalog("device-1", "chat-1");
  assert.deepEqual(catalog, { skills: entries });

  const botEntries = [
    {
      invocationId: `sk1_${"b".repeat(43)}`,
      name: "bot-skill",
      description: "Bot scoped.",
      source: "configured" as const,
      available: true,
    },
  ];
  const botApp = fixture(chat({ botId: "bot-1", workspaceId: "workspace-9" }), {
    retainedBotChatAuthorizer: () => true,
    skillCatalog: async () => {
      throw new Error("bot chats must not read the raw workspace catalog");
    },
    botSkillCatalog: async (deviceId, botId, chatId, workspaceId) => {
      assert.equal(deviceId, "device-1");
      assert.equal(botId, "bot-1");
      assert.equal(chatId, "chat-1");
      assert.equal(workspaceId, "workspace-9");
      return botEntries;
    },
  });
  const botCatalog = await botApp.service.chatSkillCatalog("device-1", "chat-1");
  assert.deepEqual(botCatalog, { skills: botEntries });
});

test("chat skill catalog fails closed without a wired registry", async () => {
  const app = fixture(chat());
  await assert.rejects(
    app.service.chatSkillCatalog("device-1", "chat-1"),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "not_found" &&
      (error as { status?: number }).status === 404,
  );
});

test("chat skill catalog returns empty for chats without a real workspace", async () => {
  const app = fixture(chat({ workspaceId: "assistant" }), {
    skillCatalog: async () => {
      throw new Error("assistant chats must not reach the workspace catalog");
    },
  });
  assert.deepEqual(
    await app.service.chatSkillCatalog("device-1", "chat-1"),
    { skills: [] },
  );
});

test("remote skill turn requires the negotiated grant and rides the desktop lease", async () => {
  const app = fixture(chat({ workspaceId: "workspace-9" }), {
    deviceSupportsSkillInvocation: async () => true,
    resolveSkillInvocation: async (workspaceId, invocationId) => {
      assert.equal(workspaceId, "workspace-9");
      assert.equal(invocationId, `sk1_${"a".repeat(43)}`);
      return {
        stableId: "skill:review",
        name: "review-code",
        description: "Review changes.",
        instructions: "Review the diff carefully.",
        source: "workspace",
        enabled: true,
        available: true,
        invocationId,
        toolKey: "skill_review_code",
      };
    },
  });
  const accepted = await app.service.startTurn("device-1", "chat-1", "skill-turn-00000001", {
    text: "check this diff",
    skill: {
      version: 1,
      invocationId: `sk1_${"a".repeat(43)}`,
      displayName: "review-code",
      source: "workspace",
    },
  });
  assert.equal(accepted.status, "accepted");
  const preparedCalls = app.preparedInvocations();
  assert.equal(preparedCalls.length, 1, "the turn lease must receive the expanded prompt");
  assert.ok(preparedCalls[0]!.formattedPrompt.includes("Review the diff carefully."));
  const userMessage = app.current()?.messages.find(
    (message) => message.content === "check this diff",
  );
  assert.deepEqual(userMessage?.skill, {
    version: 1,
    name: "review-code",
    source: "workspace",
  });

  const denied = fixture(chat(), {
    deviceSupportsSkillInvocation: async () => false,
    resolveSkillInvocation: async () => {
      throw new Error("must not resolve without the grant");
    },
  });
  await assert.rejects(
    denied.service.startTurn("device-1", "chat-1", "skill-denied-00001", {
      text: "hi",
      skill: {
        version: 1,
        invocationId: `sk1_${"a".repeat(43)}`,
        displayName: "review-code",
        source: "workspace",
      },
    }),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "capability_denied" &&
      (error as { status?: number }).status === 403,
  );
  assert.equal(denied.appends(), 0);
});

test("remote skill turn maps lease failures onto the remote vocabulary", async () => {
  const app = fixture(chat(), {
    deviceSupportsSkillInvocation: async () => true,
    resolveSkillInvocation: async () => {
      throw new SkillInvocationError("skill_changed", "The skill changed after it was listed.");
    },
  });
  await assert.rejects(
    app.service.startTurn("device-1", "chat-1", "skill-stale-0000001", {
      text: "hi",
      skill: {
        version: 1,
        invocationId: `sk1_${"a".repeat(43)}`,
        displayName: "review-code",
        source: "workspace",
      },
    }),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "skill_unavailable" &&
      (error as { status?: number }).status === 409,
  );
  assert.equal(app.appends(), 0);
  // A failed preparation must release the turn so the next send is admitted.
  const retry = await app.service.startTurn("device-1", "chat-1", "skill-retry-0000001", { text: "plain" });
  assert.equal(retry.status, "accepted");
});

test("chat skill catalog maps registry failures onto the remote vocabulary", async () => {
  const app = fixture(chat({ workspaceId: "workspace-9" }), {
    skillCatalog: async () => {
      throw new SkillInvocationError("workspace_changed", "The workspace changed.");
    },
  });
  await assert.rejects(
    app.service.chatSkillCatalog("device-1", "chat-1"),
    (error: unknown) =>
      (error as { code?: string; status?: number }).code === "skill_unavailable" &&
      (error as { status?: number }).status === 409,
  );
});

const resolvedSkill = {
  stableId: "skill:review",
  name: "review-code",
  description: "Review changes.",
  instructions: "Review the diff carefully.",
  source: "workspace" as const,
  enabled: true,
  available: true,
  invocationId: `sk1_${"a".repeat(43)}`,
  toolKey: "skill_review_code",
};

const skillInvocation = {
  version: 1 as const,
  invocationId: `sk1_${"a".repeat(43)}`,
  displayName: "review-code",
  source: "workspace" as const,
};

test("remote skill turn rejects while its workspace is changing", async () => {
  const app = fixture(chat({ workspaceId: "workspace-9" }), {
    deviceSupportsSkillInvocation: async () => true,
    resolveSkillInvocation: async () => resolvedSkill,
  });
  const endMutation = workspaceMutationGate.begin("workspace-9");
  try {
    await assert.rejects(
      app.service.startTurn("device-1", "chat-1", "skill-gated-000001", {
        text: "check this diff",
        skill: skillInvocation,
      }),
      (error: unknown) =>
        (error as { code?: string; status?: number }).code === "rate_limited" &&
        (error as { status?: number }).status === 429,
    );
    assert.equal(app.appends(), 0);
  } finally {
    endMutation();
  }
  // Once the workspace settles the same turn is admitted again.
  const retry = await app.service.startTurn("device-1", "chat-1", "skill-gated-retry1", {
    text: "check this diff",
    skill: skillInvocation,
  });
  assert.equal(retry.status, "accepted");
});

test("remote skill turn aborts the append when its workspace changes mid-prepare", async () => {
  let endMutation: (() => void) | undefined;
  const app = fixture(chat({ workspaceId: "workspace-9" }), {
    deviceSupportsSkillInvocation: async () => true,
    resolveSkillInvocation: async () => {
      // The registry still resolves, but the workspace begins changing before
      // the append commits; the admission abort must release the turn.
      endMutation = workspaceMutationGate.begin("workspace-9");
      return resolvedSkill;
    },
  });
  try {
    await assert.rejects(
      app.service.startTurn("device-1", "chat-1", "skill-abort-000001", {
        text: "check this diff",
        skill: skillInvocation,
      }),
      (error: unknown) =>
        (error as { code?: string; status?: number }).code === "rate_limited" &&
        (error as { status?: number }).status === 429,
    );
    assert.equal(app.appends(), 0);
  } finally {
    endMutation?.();
  }
});

function conversation(count: number, content = (index: number) => `Message ${index}`): Chat {
  return chat({
    messages: Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: content(index),
      createdAt: 2_000 + index,
    })),
  });
}

test("the messages window pages backwards from the newest message without gaps", () => {
  const source = conversation(7);
  const pages: string[][] = [];
  let before: string | undefined;
  for (;;) {
    const page = projectAidenRemoteChatMessagesWindow(source, { ...(before ? { before } : {}), limit: 3 });
    assert.equal(page.chatId, "chat-1");
    assert.equal(page.revision, projectAidenRemoteChat(source).revision);
    pages.push(page.messages.map((message) => message.id));
    if (!page.hasOlder) break;
    before = page.messages[0]!.id;
  }
  assert.deepEqual(pages, [
    ["message-4", "message-5", "message-6"],
    ["message-1", "message-2", "message-3"],
    ["message-0"],
  ]);
});

test("the messages window hides system messages and refuses an unknown anchor", () => {
  const source = conversation(3);
  source.messages.splice(1, 0, { id: "system-1", role: "system", content: "instructions", createdAt: 2_000 });
  const page = projectAidenRemoteChatMessagesWindow(source, { limit: 50 });
  assert.deepEqual(page.messages.map((message) => message.id), ["message-0", "message-1", "message-2"]);
  assert.equal(page.hasOlder, false);

  for (const before of ["system-1", "message-missing"]) {
    assert.throws(
      () => projectAidenRemoteChatMessagesWindow(source, { before, limit: 10 }),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "revision_conflict",
    );
  }
});

test("a messages window stays within the JSON budget and reports the trimmed history", () => {
  const source = conversation(8, (index) => `${index}`.padEnd(300_000, "x"));
  const page = projectAidenRemoteChatMessagesWindow(source, { limit: 8 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES);
  assert.ok(page.messages.length > 0 && page.messages.length < 8);
  // The newest messages are kept and the trimmed older ones stay reachable.
  assert.equal(page.messages[page.messages.length - 1]!.id, "message-7");
  assert.equal(page.hasOlder, true);
  const older = projectAidenRemoteChatMessagesWindow(source, { before: page.messages[0]!.id, limit: 8 });
  assert.equal(older.messages[older.messages.length - 1]!.id, `message-${8 - page.messages.length - 1}`);
});

test("a messages window carries the chat metadata a whole-chat read would, so renames and model changes reach windowed readers", async () => {
  const source = conversation(5);
  const before = projectAidenRemoteChatMessagesWindow(source, { limit: 2 });
  const { messages: _messages, id, ...wholeMetadata } = projectAidenRemoteChat(source);
  const { messages: _page, chatId, hasOlder: _hasOlder, ...windowMetadata } = before;
  assert.equal(chatId, id);
  assert.deepEqual(windowMetadata, wholeMetadata);

  // The desktop renames the chat and switches its model without touching history.
  const changed = { ...source, title: "Renamed on the Mac", providerId: "provider-2", model: "model-2", updatedAt: 3_000 };
  const after = projectAidenRemoteChatMessagesWindow(changed, { limit: 2 });
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.title, "Renamed on the Mac");
  assert.equal(after.providerId, "provider-2");
  assert.equal(after.modelId, "model-2");
  assert.equal(after.updatedAt, new Date(3_000).toISOString());
  assert.notEqual(after.revision, before.revision);

  // A chat without a complete model selection omits both fields, as chat reads do.
  const unselected = projectAidenRemoteChatMessagesWindow({ ...source, model: "" }, { limit: 2 });
  assert.equal("providerId" in unselected || "modelId" in unselected, false);

  let pending = true;
  const app = fixture(source, { isTitlePending: () => pending });
  assert.equal((await app.service.messagesWindow("chat-1", { limit: 2 })).titlePending, true);
  pending = false;
  assert.equal("titlePending" in (await app.service.messagesWindow("chat-1", { limit: 2 })), false);
});

/** A source chat with two settled turns; the second prompt carries an image. */
function forkSource(): Chat {
  return chat({
    messages: [
      { id: "u1", role: "user", content: "Why does it fail?", createdAt: 1_100 },
      { id: "a1", role: "assistant", content: "A missing token.", createdAt: 1_200 },
      {
        id: "u2",
        role: "user",
        content: "Fix it.",
        createdAt: 1_300,
        attachments: [
          { id: "stored-image", name: "screen.png", mimeType: "image/png", kind: "image", size: Buffer.from(ONE_PIXEL_PNG, "base64").byteLength, data: ONE_PIXEL_PNG },
        ],
      },
      { id: "a2", role: "assistant", content: "Fixed.", createdAt: 1_400 },
    ],
  });
}

/**
 * The Remote chat service over a fork service that copies the way the real
 * one does: it checks the source with the caller, then keeps the messages
 * through (after) or up to (before) the cut under new ids.
 */
function forkFixture(
  options: {
    fail?: Error;
    summaries?: NonNullable<ConstructorParameters<typeof AidenRemoteChatService>[0]["forks"]>["summaries"];
    supportsSummaries?: boolean;
    attachments?: AidenRemoteAttachmentStore;
    initial?: Chat;
  } = {},
) {
  const requests: ChatForkRequest[] = [];
  const admitted: string[] = [];
  let source!: () => Chat | null;
  const app = fixture(options.initial ?? forkSource(), {
    ...(options.attachments ? { attachments: options.attachments } : {}),
    forks: {
      service: {
        supportsSummaries: options.supportsSummaries ?? true,
        async fork(request, caller) {
          requests.push(structuredClone(request));
          if (options.fail) throw options.fail;
          const chat = source();
          if (!chat) throw new ChatForkError("not_found", "The chat is no longer available.");
          caller.assertSource?.(chat);
          const admission = caller.admitWorkspace(chat.workspaceId!);
          admission.release();
          const { messageId, position } = request.forkAt!;
          const cut = chat.messages.findIndex((message) => message.id === messageId);
          if (cut < 0) throw new ChatForkError("message_not_found", "That message is no longer in this chat.");
          const kept = chat.messages
            .slice(0, position === "after" ? cut + 1 : cut)
            .map((message) => ({ ...message, id: `f-${message.id}` }));
          const forked: Chat = {
            ...chat,
            id: `fork-${requests.length}`,
            messages: kept,
            forkedFrom: {
              chatId: chat.id,
              messageId,
              position,
              at: 5_000,
              ...(request.summary
                ? {
                    summary: {
                      state: "pending" as const,
                      afterMessageId: kept[kept.length - 1]!.id,
                      ...(request.summary.instructions ? { instructions: request.summary.instructions } : {}),
                    },
                  }
                : {}),
            },
          };
          caller.assertInstallable?.(forked);
          return forked;
        },
      },
      admitWorkspace: (workspaceId) => {
        admitted.push(workspaceId);
        return { isAborted: () => false, release: () => undefined };
      },
      summaries: options.summaries ?? {
        retry: async () => { throw new Error("unused"); },
        skip: async () => { throw new Error("unused"); },
        cancel: () => false,
      },
    },
  });
  source = app.current;
  return { ...app, requests, admitted };
}

function hasCode(code: string, status?: number) {
  return (error: unknown) =>
    (error as { code?: string }).code === code &&
    (status === undefined || (error as { status?: number }).status === status);
}

test("a Remote fork after a reply checks the revision, records lineage and replays by key", async () => {
  const app = forkFixture();
  const { revision } = await app.service.get("chat-1");

  await assert.rejects(
    app.service.fork("device-1", "chat-1", "rev_stale", "fork-key-000000000001", { messageId: "a1", position: "after" }),
    hasCode("revision_conflict", 409),
  );

  const key = "fork-key-000000000002";
  const forked = await app.service.fork("device-1", "chat-1", revision, key, {
    messageId: "a1",
    position: "after",
    summary: { focus: "  the parser  " },
  });
  // The response is exactly what a paired client parses.
  assert.deepEqual(parseAidenRemoteChatForkResult(JSON.parse(JSON.stringify(forked))), forked);
  assert.deepEqual(forked.chat.messages.map(({ text }) => text), ["Why does it fail?", "A missing token."]);
  assert.deepEqual(forked.chat.forkedFrom, {
    chatId: "chat-1",
    messageId: "a1",
    position: "after",
    at: new Date(5_000).toISOString(),
    summary: { state: "pending", afterMessageId: "f-a1", focus: "the parser" },
  });
  assert.equal(forked.prefill, undefined);
  assert.deepEqual(app.admitted, ["workspace-1"]);

  // A retry with the same key gets the same fork; nothing is copied twice.
  const notified = app.notifications();
  assert.deepEqual(
    await app.service.fork("device-1", "chat-1", revision, key, {
      messageId: "a1",
      position: "after",
      summary: { focus: "  the parser  " },
    }),
    forked,
  );
  assert.equal(app.requests.length, 2);
  assert.equal(app.notifications(), notified);
});

test("a Remote fork before a prompt returns it to edit with its attachments restaged", async () => {
  let sequence = 0;
  const attachments = new AidenRemoteAttachmentStore({
    now: () => 20_000,
    randomId: () => `att_${String(sequence++).padStart(43, "C")}`,
  });
  const app = forkFixture({ attachments });
  const { revision } = await app.service.get("chat-1");

  const forked = await app.service.fork("device-1", "chat-1", revision, "fork-key-000000000003", {
    messageId: "u2",
    position: "before",
  });
  assert.deepEqual(forked.chat.messages.map(({ text }) => text), ["Why does it fail?", "A missing token."]);
  assert.equal(forked.prefill?.text, "Fix it.");
  const [staged] = forked.prefill?.attachments ?? [];
  assert.equal(staged?.name, "screen.png");
  assert.equal(forked.prefill?.attachments?.length, 1);
  assert.deepEqual(parseAidenRemoteChatForkResult(JSON.parse(JSON.stringify(forked))), forked);

  // The staged attachment sends with the next turn in the fork, for this device only.
  assert.throws(() => attachments.consume("device-2", forked.chat.id, [staged!.id]), hasCode("handle_wrong_device"));
  assert.throws(() => attachments.consume("device-1", "chat-1", [staged!.id]), hasCode("handle_invalid"));
  const [resent] = attachments.consume("device-1", forked.chat.id, [staged!.id]) ?? [];
  assert.equal(resent?.data, ONE_PIXEL_PNG);

  // A fork after a reply keeps the prompt in history, so there is nothing to edit.
  const after = await app.service.fork("device-1", "chat-1", revision, "fork-key-000000000004", {
    messageId: "a2",
    position: "after",
  });
  assert.equal(after.prefill, undefined);
});

test("attachments that cannot be restaged are omitted without failing the rest", () => {
  let sequence = 0;
  const store = new AidenRemoteAttachmentStore({
    now: () => 20_000,
    randomId: () => `att_${String(sequence++).padStart(43, "D")}`,
  });
  const text = (index: number) => ({
    id: `stored-${index}`, name: `note-${index}.txt`, mimeType: "text/plain", kind: "text" as const, size: 1, text: "x",
  });
  const broken = { id: "stored-gif", name: "old.gif", mimeType: "image/gif", kind: "image" as const, size: 35, data: ONE_PIXEL_GIF };

  const { staged, omitted } = store.stage("device-1", "fork-1", [broken, ...Array.from({ length: 11 }, (_, index) => text(index))]);
  // One turn holds ten attachments; the unsupported image and the eleventh-plus are omitted.
  assert.equal(staged.length, 9);
  assert.equal(omitted, 3);
  assert.deepEqual(staged.map(({ name }) => name), Array.from({ length: 9 }, (_, index) => `note-${index}.txt`));

  const deleting = store.beginChatDeletion("fork-2");
  assert.throws(() => store.stage("device-1", "fork-2", [text(0)]), hasCode("not_found", 404));
  deleting();
});

test("Remote fork failures carry the status and code a client acts on", async () => {
  const run = async (fail: Error | undefined, input: unknown, initial?: Chat) => {
    const app = forkFixture({ ...(fail ? { fail } : {}), ...(initial ? { initial } : {}) });
    const { revision } = await app.service.get("chat-1");
    return app.service.fork("device-1", "chat-1", revision, `fork-key-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`, input);
  };
  const cut = { messageId: "a1", position: "after" };

  await assert.rejects(run(new ChatForkError("busy", "Busy."), cut), (error: unknown) =>
    hasCode("operation_in_progress", 409)(error) && (error as { retryable?: boolean }).retryable === true);
  await assert.rejects(run(undefined, { messageId: "missing", position: "after" }), hasCode("not_found", 404));
  await assert.rejects(run(new ChatForkError("ineligible", "Pick a settled reply."), cut), hasCode("invalid_request", 400));
  await assert.rejects(run(new ChatForkError("too_large", "Too large."), cut), hasCode("payload_too_large", 413));
  await assert.rejects(run(new ChatForkError("unavailable", "Recovering."), cut), hasCode("operation_in_progress", 409));

  for (const malformed of [
    { messageId: "a1" },
    { messageId: "a1", position: "middle" },
    { messageId: "a1/../x", position: "after" },
    { messageId: "a1", position: "after", extra: true },
    { messageId: "a1", position: "after", summary: { focus: "   " } },
    { messageId: "a1", position: "after", summary: { focus: "x".repeat(1_001) } },
    // The desktop's internal name for the focus is not part of the wire.
    { messageId: "a1", position: "after", summary: { instructions: "parser" } },
  ]) {
    await assert.rejects(run(undefined, malformed), hasCode("invalid_request", 400), JSON.stringify(malformed));
  }

  // Bot chats are not forked from a paired device.
  await assert.rejects(run(undefined, cut, { ...forkSource(), botId: "bot-1" }), hasCode("not_found", 404));
});

test("a host without summaries refuses Fork with summary but still forks", async () => {
  const app = forkFixture({ supportsSummaries: false });
  assert.equal(app.service.supportsForks, true);
  assert.equal(app.service.supportsForkSummaries, false);
  const { revision } = await app.service.get("chat-1");
  await assert.rejects(
    app.service.fork("device-1", "chat-1", revision, "fork-key-000000000005", {
      messageId: "a1", position: "after", summary: {},
    }),
    hasCode("not_found", 404),
  );
  assert.equal(app.requests.length, 0);
  const plain = await app.service.fork("device-1", "chat-1", revision, "fork-key-000000000006", {
    messageId: "a1", position: "after",
  });
  assert.equal(plain.chat.forkedFrom?.summary, undefined);
  await assert.rejects(app.service.cancelForkSummary(plain.chat.id), hasCode("not_found", 404));
});

test("fork summary actions reach only forks with a summary and report a moved-on summary as a conflict", async () => {
  const pending: Chat = {
    ...forkSource(),
    forkedFrom: {
      chatId: "source-1",
      messageId: "a1",
      position: "after",
      at: 5_000,
      summary: { state: "failed", afterMessageId: "a2", error: "Summary cancelled." },
    },
  };
  const calls: string[] = [];
  const storageFailure = new Error("EACCES: /Users/private/Library/Aiden/chats/chat-1.json");
  const app = forkFixture({
    initial: pending,
    summaries: {
      retry: async (chatId) => {
        calls.push(`retry:${chatId}`);
        throw calls.length === 1
          ? new ForkSummaryStateError("Only a failed summary can be retried.")
          : storageFailure;
      },
      skip: async (chatId) => {
        calls.push(`skip:${chatId}`);
        const { summary: _summary, ...lineage } = pending.forkedFrom!;
        return { ...pending, forkedFrom: lineage };
      },
      cancel: (chatId) => {
        calls.push(`cancel:${chatId}`);
        return false;
      },
    },
  });
  assert.equal(app.service.supportsForkSummaries, true);

  await assert.rejects(app.service.retryForkSummary("chat-1"), (error: unknown) =>
    hasCode("revision_conflict", 409)(error) &&
    (error as Error).message === "Only a failed summary can be retried.");
  // Anything else is not a conflict, and its text is not handed to the device as one.
  await assert.rejects(app.service.retryForkSummary("chat-1"), (error: unknown) => error === storageFailure);
  const skipped = await app.service.skipForkSummary("chat-1");
  assert.equal(skipped.forkedFrom?.summary, undefined);
  assert.equal(skipped.forkedFrom?.chatId, "source-1");
  assert.deepEqual(await app.service.cancelForkSummary("chat-1"), { cancelled: false });
  assert.deepEqual(calls, ["retry:chat-1", "retry:chat-1", "skip:chat-1", "cancel:chat-1"]);

  // A chat that is not a fork with a summary has no summary to act on.
  const plain = forkFixture({ summaries: { retry: async () => pending, skip: async () => pending, cancel: () => true } });
  await assert.rejects(plain.service.cancelForkSummary("chat-1"), hasCode("not_found", 404));
});

test("a fork summary reaches a paired device without host files or provider errors", async () => {
  const lineage = (summary: NonNullable<NonNullable<Chat["forkedFrom"]>["summary"]>): Chat => ({
    ...forkSource(),
    forkedFrom: { chatId: "source-1", messageId: "a1", position: "after", at: 5_000, summary },
  });
  const files = { read: ["/Users/private/project/secret.ts"], modified: ["/Users/private/project/parser.ts"] };
  const read = async (chat: Chat) => {
    const projected = await forkFixture({ initial: chat }).service.get("chat-1");
    // Every summary state parses the way a paired client parses it.
    assert.deepEqual(parseAidenRemoteChatProjection(JSON.parse(JSON.stringify(projected))), projected);
    return projected.forkedFrom?.summary;
  };

  assert.deepEqual(
    await read(lineage({
      state: "failed",
      afterMessageId: "a2",
      instructions: "the parser",
      files,
      error: "401 Unauthorized from https://api.provider.example/v1 (key sk-live-123)",
    })),
    { state: "failed", afterMessageId: "a2", focus: "the parser", error: "The summary could not be generated." },
  );
  // Aiden's own failure text is safe to show as it is.
  assert.deepEqual(
    await read(lineage({ state: "failed", afterMessageId: "a2", error: "Summary cancelled." })),
    { state: "failed", afterMessageId: "a2", error: "Summary cancelled." },
  );
  assert.deepEqual(
    await read(lineage({ state: "ready", afterMessageId: "a2", text: "Settled on revision 21.", files })),
    { state: "ready", afterMessageId: "a2", text: "Settled on revision 21." },
  );
});

test("a fork too large to send from a paired device is refused without creating it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-remote-fork-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  let source = await store.create({ title: "Long", workspaceId: "workspace-1" });
  for (let index = 0; index < 6; index += 1) {
    source = await store.appendMessage(source.id, {
      role: index % 2 === 0 ? "user" : "assistant",
      content: String(index).repeat(190_000),
    });
  }
  const app = fixture(source, {
    forks: {
      service: createChatForkService({
        chatStore: store,
        beginChatCopy: () => () => undefined,
        workspaceExists: async () => true,
      }),
      admitWorkspace: () => ({ isAborted: () => false, release: () => undefined }),
    },
  });
  // The whole chat is too large to read at once, so a client pages it.
  const { revision } = await app.service.messagesWindow(source.id, { limit: 1 });
  const lastReply = source.messages[source.messages.length - 1]!.id;
  const fork = () =>
    app.service.fork("device-1", source.id, revision, "fork-key-000000000099", {
      messageId: lastReply,
      position: "after",
    });

  await assert.rejects(fork(), hasCode("payload_too_large", 413));
  assert.deepEqual((await store.list()).map(({ id }) => id), [source.id]);
  // A retry with the same key is refused like any replayed rejection, and still creates nothing.
  await assert.rejects(fork(), hasCode("internal_error", 409));
  assert.equal((await store.list()).length, 1);
});

test("Remote classification refuses feature-owned chats before any payload read", async () => {
  let payloadReads = 0;
  const { service } = fixture(
    chat({ owner: { kind: "design-project", projectId: "project-1" } }),
    { onPayloadGet: () => { payloadReads += 1; } },
  );

  await assert.rejects(
    service.classify("chat-1"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError &&
      (error as { code?: string; status?: number }).code === "not_found" &&
      (error as { status?: number }).status === 404,
  );
  assert.equal(payloadReads, 0);
});
