import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Chat, ChatMessage } from "./types.js";
import { AidenRemoteChatService, projectAidenRemoteChat } from "./aiden-remote-chats.js";
import { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import {
  AIDEN_REMOTE_ATTACHMENT_TTL_MS,
  AidenRemoteAttachmentStore,
} from "./aiden-remote-attachments.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

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
  } = {},
) {
  let current: Chat | null = structuredClone(initial);
  let creates = 0;
  let appends = 0;
  let notifications = 0;
  const streams = new AidenRemoteStreamService({
    now: () => 10_000,
    cancel: () => true,
    approve: () => true,
  });
  const service = new AidenRemoteChatService({
    application: {
      list: async () => current ? [structuredClone(current)] : [],
      get: async () => ({ chat: current ? structuredClone(current) : null, reconciliation: null }),
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
      resolve: async () => ({ providerId: "provider-1", modelId: "model-1", thinkingLevels: ["low", "high"] }),
    },
    ...(fixtureOptions.attachments ? { attachments: fixtureOptions.attachments } : {}),
    ...(fixtureOptions.isTitlePending ? { isTitlePending: fixtureOptions.isTitlePending } : {}),
    notifyChanged: () => { notifications += 1; },
  });
  return {
    service,
    streams,
    creates: () => creates,
    appends: () => appends,
    notifications: () => notifications,
    current: () => current ? structuredClone(current) : null,
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
  await assert.rejects(
    app.service.startTurn("device-1", "chat-1", "turn-attachments-0002", {
      text: "Do not reuse",
      attachmentIds: [image.id],
    }),
    (error: unknown) => (error as { code?: string }).code === "handle_invalid",
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
