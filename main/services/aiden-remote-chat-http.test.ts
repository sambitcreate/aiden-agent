import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { Chat, ChatMessage } from "./types.js";
import { AidenRemoteChatService } from "./aiden-remote-chats.js";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import { BotMutationGate } from "./bot-mutation-gate.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

async function projectionReadServer(initial: Chat | Chat[]) {
  let current = structuredClone(Array.isArray(initial) ? initial : [initial]);
  const streams = new AidenRemoteStreamService({
    now: Date.now,
    cancel: () => false,
    approve: () => false,
  });
  const chats = new AidenRemoteChatService({
    application: {
      list: async () => structuredClone(current),
      listRegular: async () => structuredClone(current.filter((chat) => chat.botId === undefined)),
      get: async (chatId) => ({
        chat: structuredClone(current.find((chat) => chat.id === chatId) ?? null),
        reconciliation: null,
      }),
      create: async () => structuredClone(current[0]!),
      rename: async () => structuredClone(current[0]!),
      moveEmptyToWorkspace: async () => structuredClone(current[0]!),
      remove: async () => undefined,
    },
    chatStore: {
      get: async (chatId) => structuredClone(current.find((chat) => chat.id === chatId) ?? null),
      appendMessage: async () => structuredClone(current[0]!),
    },
    generation: {
      beginChatTurn: () => null,
      start: async () => false,
    },
    streams,
    models: {
      resolve: async () => ({
        providerId: "provider-1",
        modelId: "model-1",
        thinkingLevels: [],
      }),
    },
    bots: { get: async () => null },
    botMutations: new BotMutationGate(),
  });
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Studio Mac",
    appVersion: "0.30.0",
    devices: {
      acquireDeviceAuthorization: () => () => undefined,
      authenticate: async (credential) => credential === "a".repeat(43)
        ? {
            id: "device-1",
            revoked: false,
            capabilities: new Set(["chat:read"] as const),
          }
        : null,
    },
    pairing: { exchange: async () => { throw new Error("unused"); } },
    chats,
    streams,
    connectionMode: () => "lan",
    now: Date.now,
    log: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    base: `http://127.0.0.1:${address.port}/api/aiden/v1`,
    setChat(chat: Chat) {
      current = [structuredClone(chat)];
    },
    setChats(chats: Chat[]) {
      current = structuredClone(chats);
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test("HTTP Chat projections reject invalid stored fields before success headers", async () => {
  const baseChat: Chat = {
    id: "chat-1",
    title: "Remote chat",
    workspaceId: "workspace-1",
    providerId: "provider-1",
    model: "model-1",
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
  };
  const app = await projectionReadServer(baseChat);
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const invalidChats: Array<{ chat: Chat; forbidden: string }> = [
      { chat: { ...baseChat, providerId: "p".repeat(257) }, forbidden: "p".repeat(257) },
      { chat: { ...baseChat, createdAt: 2_000, updatedAt: 1_999 }, forbidden: "Remote chat" },
      {
        chat: {
          ...baseChat,
          messages: [{
            id: "i".repeat(129),
            role: "user",
            content: "Hello",
            createdAt: 1_500,
          }],
        },
        forbidden: "i".repeat(129),
      },
      {
        chat: { ...baseChat, title: "private-title-\ud800-tail" },
        forbidden: "private-title",
      },
      {
        chat: {
          ...baseChat,
          messages: [{
            id: "message-invalid-text",
            role: "assistant",
            content: "private-text-\udc00-tail",
            createdAt: 1_500,
          }],
        },
        forbidden: "private-text",
      },
    ];
    for (const { chat: invalid, forbidden } of invalidChats) {
      app.setChat(invalid);
      const response = await fetch(`${app.base}/chats`, { headers });
      const serialized = await response.text();
      assert.equal(response.status, 500);
      assert.equal(JSON.parse(serialized).error.code, "internal_error");
      assert.equal(serialized.includes(forbidden), false);
      assert.equal(
        response.headers.get("content-length"),
        String(Buffer.byteLength(serialized, "utf8")),
      );
    }

    app.setChat(baseChat);
    const valid = await fetch(`${app.base}/chats`, { headers });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).chats[0].id, "chat-1");

    app.setChat({
      ...baseChat,
      messages: [{
        id: "message-emoji-timeline",
        role: "assistant",
        content: "😀",
        createdAt: 1_500,
        timeline: {
          version: 3,
          generationId: "generation-emoji-timeline",
          status: "completed",
          startedAt: 1_000,
          finishedAt: 1_500,
          steps: [{
            id: "think-1",
            order: 0,
            kind: "thinking",
            startedAt: 1_000,
            updatedAt: 1_500,
            finishedAt: 1_500,
            contentOffset: 2,
          }],
        },
      }],
    });
    const emojiTimeline = await fetch(`${app.base}/chats`, { headers });
    assert.equal(emojiTimeline.status, 200);
    const emojiBody = await emojiTimeline.json() as {
      chats: Array<{ messages: Array<{ timeline?: { steps: Array<{ contentOffset?: number }> } }> }>;
    };
    assert.equal(
      emojiBody.chats[0]?.messages[0]?.timeline?.steps[0]?.contentOffset,
      2,
    );

    const projectedPrefix = "x".repeat(200_000);
    app.setChats([
      baseChat,
      {
        ...baseChat,
        id: "chat-over-limit-timeline",
        title: "Over-limit timeline",
        messages: [{
          id: "message-over-limit-timeline",
          role: "assistant",
          content: `${projectedPrefix}private-tail`,
          createdAt: 1_500,
          timeline: {
            version: 3,
            generationId: "generation-over-limit-timeline",
            status: "completed",
            startedAt: 1_000,
            finishedAt: 1_500,
            steps: [{
              id: "think-1",
              order: 0,
              kind: "thinking",
              startedAt: 1_000,
              updatedAt: 1_500,
              finishedAt: 1_500,
              contentOffset: projectedPrefix.length + 1,
            }],
          },
        }],
      },
    ]);
    const overLimitTimeline = await fetch(`${app.base}/chats`, { headers });
    assert.equal(overLimitTimeline.status, 200);
    const overLimitSerialized = await overLimitTimeline.text();
    const overLimitBody = JSON.parse(overLimitSerialized) as {
      chats: Array<{ id: string; messages: Array<{ text: string; timeline?: unknown }> }>;
    };
    assert.deepEqual(overLimitBody.chats.map(({ id }) => id), [
      "chat-1",
      "chat-over-limit-timeline",
    ]);
    const truncated = overLimitBody.chats[1]?.messages[0];
    assert.equal(truncated?.text, projectedPrefix);
    assert.equal(truncated?.timeline, undefined);
    assert.equal(overLimitSerialized.includes("private-tail"), false);
  } finally {
    await app.close();
  }
});

test("HTTP client resumes, approves, denies, and cancels device-owned mocked turns without duplicate messages", async () => {
  let chat: Chat = {
    id: "chat-1",
    title: "Remote chat",
    workspaceId: "workspace-1",
    providerId: "provider-1",
    model: "model-1",
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
  };
  let turnNumber = 0;
  let appendCount = 0;
  const ownerByStream = new Map<string, { send(channel: "chat:delta" | "chat:approval" | "chat:done", payload: unknown): void }>();
  const approvalToStream = new Map<string, string>();

  const streams = new AidenRemoteStreamService({
    now: Date.now,
    cancel: (streamId) => {
      ownerByStream.get(streamId)?.send("chat:done", { streamId, content: "" });
      return true;
    },
    approve: (approvalId, decision) => {
      const streamId = approvalToStream.get(approvalId);
      const owner = streamId ? ownerByStream.get(streamId) : undefined;
      if (!streamId || !owner) return false;
      const assistant: ChatMessage = {
        id: `assistant-${turnNumber}`,
        role: "assistant",
        content: decision === "allow" ? "Allowed" : "Denied",
        createdAt: Date.now(),
      };
      chat.messages.push(assistant);
      chat.updatedAt += 1;
      owner.send("chat:delta", { streamId, delta: assistant.content });
      owner.send("chat:done", { streamId, chat: structuredClone(chat) });
      return true;
    },
  });
  const chats = new AidenRemoteChatService({
    application: {
      list: async () => [structuredClone(chat)],
      listRegular: async () => chat.botId === undefined ? [structuredClone(chat)] : [],
      get: async () => ({ chat: structuredClone(chat), reconciliation: null }),
      create: async () => structuredClone(chat),
      rename: async (_id, title, options) => {
        await options?.assertCurrent?.(chat);
        chat.title = title;
        chat.updatedAt += 1;
        return structuredClone(chat);
      },
      moveEmptyToWorkspace: async () => structuredClone(chat),
      remove: async () => undefined,
    },
    chatStore: {
      get: async () => structuredClone(chat),
      appendMessage: async (_id, message, meta) => {
        if (!meta?.isCurrent?.()) throw new Error("turn expired");
        appendCount += 1;
        chat.messages.push({
          id: message.id!,
          role: message.role,
          content: message.content,
          createdAt: Date.now(),
          ...(message.attachments ? { attachments: structuredClone(message.attachments) } : {}),
        });
        chat.updatedAt += 1;
        return structuredClone(chat);
      },
    },
    generation: {
      beginChatTurn: () => ({
        isActive: () => true,
        reserveAppendPayload: () => undefined,
        settleAsyncWork: () => undefined,
        onReleased: () => undefined,
        release: () => undefined,
      }),
      start: async (streamId, params, owner, options) => {
        turnNumber += 1;
        ownerByStream.set(streamId, owner);
        options.onTurnAccepted();
        owner.send("chat:delta", { streamId, delta: "Working" });
        if (
          !params.messages.length &&
          !chat.messages[chat.messages.length - 1]?.content.includes("Cancel")
        ) {
          const approvalId = `approval-${turnNumber}`;
          approvalToStream.set(approvalId, streamId);
          owner.send("chat:approval", {
            streamId,
            approvalId,
            summary: "Change the workspace",
          });
        }
        return true;
      },
    },
    streams,
    models: {
      resolve: async () => ({ providerId: "provider-1", modelId: "model-1", thinkingLevels: [] }),
    },
    bots: { get: async () => null },
    botMutations: new BotMutationGate(),
  });

  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Studio Mac",
    appVersion: "0.30.0",
    devices: {
      acquireDeviceAuthorization: () => () => undefined,
      authenticate: async (credential) => credential === "a".repeat(43)
        ? {
            id: "device-1",
            revoked: false,
            capabilities: new Set(["chat:read", "chat:write", "approval:respond"] as const),
          }
        : null,
    },
    pairing: { exchange: async () => { throw new Error("unused"); } },
    chats,
    streams,
    models: { list: async () => ({ providers: [], defaults: {} }) },
    connectionMode: () => "lan",
    now: Date.now,
    log: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const base = `http://127.0.0.1:${address.port}/api/aiden/v1`;
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  const start = async (text: string, key: string, attachmentIds?: string[]) => {
    const response = await fetch(`${base}/chats/chat-1/turns`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ text, ...(attachmentIds ? { attachmentIds } : {}) }),
    });
    assert.equal(response.status, 202);
    return response.json() as Promise<{
      streamId: string;
      message: { id: string; attachments?: { id: string; name: string }[] };
    }>;
  };

  try {
    const uploadedResponse = await fetch(`${base}/chats/chat-1/attachments`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "proof.png",
        mimeType: "image/png",
        kind: "image",
        data: ONE_PIXEL_PNG,
      }),
    });
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json() as { id: string; name: string };
    assert.match(uploaded.id, /^att_[A-Za-z0-9_-]{43}$/u);
    assert.equal(uploaded.name, "proof.png");
    assert.equal(JSON.stringify(uploaded).includes("contents"), false);

    const discardedResponse = await fetch(`${base}/chats/chat-1/attachments`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "discard.txt",
        mimeType: "text/plain",
        kind: "text",
        text: "discard me",
      }),
    });
    assert.equal(discardedResponse.status, 201);
    const discarded = await discardedResponse.json() as { id: string };
    const removed = await fetch(`${base}/chats/chat-1/attachments/${discarded.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(removed.status, 204);

    const first = await start("Approve this", "turn-http-key-000001", [uploaded.id]);
    const replay = await start("Approve this", "turn-http-key-000001", [uploaded.id]);
    assert.deepEqual(replay, first);
    assert.deepEqual(first.message.attachments?.map(({ id, name }) => ({ id, name })), [
      { id: uploaded.id, name: "proof.png" },
    ]);
    const attachmentContent = await fetch(
      `${base}/chats/chat-1/attachments/${uploaded.id}/content`,
      { headers },
    );
    assert.equal(attachmentContent.status, 200);
    assert.equal(attachmentContent.headers.get("content-type"), "image/png");
    assert.equal(attachmentContent.headers.get("cache-control"), "no-store");
    assert.equal(
      Buffer.from(await attachmentContent.arrayBuffer()).toString("base64"),
      ONE_PIXEL_PNG,
    );
    const unauthenticatedContent = await fetch(
      `${base}/chats/chat-1/attachments/${uploaded.id}/content`,
      { headers: { "aiden-protocol-version": "1" } },
    );
    assert.equal(unauthenticatedContent.status, 401);
    assert.equal(appendCount, 1);
    const waiting = await fetch(`${base}/streams/${first.streamId}`, { headers });
    assert.equal((await waiting.json()).state, "waiting_for_approval");

    const allowed = await fetch(`${base}/approvals/approval-1/respond`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "allow-http-key-000001" },
      body: JSON.stringify({ decision: "allow" }),
    });
    assert.equal(allowed.status, 200);
    const firstEvents = await fetch(`${base}/streams/${first.streamId}/events?after=1`, { headers });
    const firstReplay = await firstEvents.text();
    assert.match(firstReplay, /event: approval_required/u);
    assert.match(firstReplay, /event: done/u);
    const eventIds = [...firstReplay.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));
    const lastEventId = eventIds[eventIds.length - 1]!;
    const terminalReplay = await fetch(`${base}/streams/${first.streamId}/events`, {
      headers: { ...headers, "last-event-id": String(lastEventId - 1) },
    });
    assert.match(await terminalReplay.text(), /event: done/u);

    const second = await start("Deny this", "turn-http-key-000002");
    const denied = await fetch(`${base}/approvals/approval-2/respond`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "deny-http-key-000001" },
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(denied.status, 200);
    assert.equal(streams.status("device-1", second.streamId).state, "done");

    const third = await start("Cancel this", "turn-http-key-000003");
    const cancelled = await fetch(`${base}/streams/${third.streamId}/cancel`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "cancel-http-key-0001" },
    });
    assert.equal(cancelled.status, 202);
    assert.equal(streams.status("device-1", third.streamId).state, "cancelled");
    assert.equal(appendCount, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
