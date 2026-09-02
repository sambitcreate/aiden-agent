import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Chat, ChatMessage } from "./types.js";
import {
  AidenRemoteChatService,
  projectAidenRemoteChat,
  type AidenRemoteBotTurnAuthorityPreflight,
  type AidenRemoteRetainedBotChatAuthorizer,
} from "./aiden-remote-chats.js";
import { parseAidenRemoteChatProjection } from "./aiden-remote-protocol.js";
import { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import {
  AIDEN_REMOTE_ATTACHMENT_TTL_MS,
  AidenRemoteAttachmentStore,
} from "./aiden-remote-attachments.js";
import { BotMutationGate } from "./bot-mutation-gate.js";
import { DESIGN_PROJECT_CHAT_WORKSPACE_ID } from "../../renderer/shared/design-projects.js";

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
    onPayloadGet?: () => void;
    botArchived?: boolean;
    botAvailable?: boolean;
    retainedBotChatAuthorizer?: AidenRemoteRetainedBotChatAuthorizer;
    botTurnAuthorityPreflight?: AidenRemoteBotTurnAuthorityPreflight;
    modelSupportsImages?: () => boolean;
    imageArtifactRecoveryPending?: boolean;
    imageArtifactRecoveryUnavailable?: boolean;
    isDesignProjectChat?: (chatId: string) => boolean | Promise<boolean>;
  } = {},
) {
  let current: Chat | null = structuredClone(initial);
  let creates = 0;
  let appends = 0;
  let notifications = 0;
  let begins = 0;
  let starts = 0;
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
        fixtureOptions.onPayloadGet?.();
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
        return {
          isActive: () => active,
          reserveAppendPayload: () => undefined,
          settleAsyncWork: () => undefined,
          onReleased: () => undefined,
          release: () => { active = false; },
        };
      },
      start: async (streamId, _params, owner, generationOptions) => {
        starts += 1;
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
              avatar: "spark" as const,
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
    ...(fixtureOptions.isDesignProjectChat
      ? { isDesignProjectChat: fixtureOptions.isDesignProjectChat }
      : {}),
    notifyChanged: () => { notifications += 1; },
  });
  return {
    service,
    streams,
    creates: () => creates,
    appends: () => appends,
    notifications: () => notifications,
    begins: () => begins,
    starts: () => starts,
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

test("Design backing conversations are absent from every generic Remote chat path", async () => {
  const app = fixture(chat({ workspaceId: DESIGN_PROJECT_CHAT_WORKSPACE_ID }));
  const revision = projectAidenRemoteChat(app.current()!).revision;
  const isNotFound = (error: unknown) =>
    (error as { code?: string; status?: number }).code === "not_found" &&
    (error as { status?: number }).status === 404;

  assert.deepEqual(await app.service.list(), { chats: [] });
  assert.deepEqual(await app.service.list(DESIGN_PROJECT_CHAT_WORKSPACE_ID), { chats: [] });
  assert.deepEqual((await app.service.listSummaries()).summaries, []);

  await assert.rejects(app.service.get("chat-1"), isNotFound);
  await assert.rejects(app.service.classify("chat-1"), isNotFound);
  await assert.rejects(app.service.rename("chat-1", revision, { title: "Hidden" }), isNotFound);
  await assert.rejects(
    app.service.move("device-1", "chat-1", revision, "design-move-0001", {
      workspaceId: "workspace-2",
    }),
    isNotFound,
  );
  await assert.rejects(app.service.remove("chat-1", revision), isNotFound);
  await assert.rejects(
    app.service.startTurn("device-1", "chat-1", "design-turn-0001", { text: "Hello" }),
    isNotFound,
  );

  assert.equal(app.current()?.workspaceId, DESIGN_PROJECT_CHAT_WORKSPACE_ID);
  assert.equal(app.current()?.title, "New chat");
  assert.equal(app.appends(), 0);
  assert.equal(app.begins(), 0);
  assert.equal(app.starts(), 0);
  assert.equal(app.notifications(), 0);
});

test("migrated Design conversations stay private even in a legacy workspace namespace", async () => {
  const app = fixture(chat({ workspaceId: "workspace-1" }), {
    isDesignProjectChat: (chatId) => chatId === "chat-1",
  });
  const revision = projectAidenRemoteChat(app.current()!).revision;
  const isNotFound = (error: unknown) =>
    (error as { code?: string; status?: number }).code === "not_found" &&
    (error as { status?: number }).status === 404;

  assert.deepEqual(await app.service.list(), { chats: [] });
  assert.deepEqual(await app.service.list("workspace-1"), { chats: [] });
  assert.deepEqual((await app.service.listSummaries()).summaries, []);
  await assert.rejects(app.service.get("chat-1"), isNotFound);
  await assert.rejects(app.service.classify("chat-1"), isNotFound);
  await assert.rejects(app.service.rename("chat-1", revision, { title: "Hidden" }), isNotFound);
  await assert.rejects(
    app.service.startTurn("device-1", "chat-1", "migrated-design-turn-0001", {
      text: "Hello",
    }),
    isNotFound,
  );
  assert.equal(app.appends(), 0);
  assert.equal(app.begins(), 0);
  assert.equal(app.starts(), 0);
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
