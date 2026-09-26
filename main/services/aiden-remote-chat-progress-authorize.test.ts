import assert from "node:assert/strict";
import test from "node:test";
import { createChatProgressAuthorizer } from "./aiden-remote-chat-progress-authorize.js";
import { ChatProgressEvents } from "./chat-progress-events.js";
import type { Chat, ChatMeta } from "./types.js";

const meta: ChatMeta = {
  id: "chat-1",
  title: "Chat",
  workspaceId: "workspace-1",
  createdAt: 1,
  updatedAt: 2,
};

const chat: Chat = {
  ...meta,
  messages: [
    {
      id: "m1",
      role: "assistant",
      content: "Done",
      createdAt: 2,
      timeline: {
        version: 3,
        generationId: "stream_latest",
        status: "completed",
        startedAt: 1,
        finishedAt: 2,
        steps: [],
      },
    },
  ],
};

function fixture(overrides: {
  device?: Partial<{
    id: string;
    revokedAt?: number;
    capabilities: readonly string[];
    acceptsProgressCapabilities?: boolean;
  }>;
  metadata?: readonly ChatMeta[];
  readChat?: (chatId: string) => Promise<Chat | undefined>;
  authorizeBot?: () => Promise<boolean>;
  events?: ChatProgressEvents;
} = {}) {
  const events = overrides.events ?? new ChatProgressEvents();
  let held = 0;
  const authorize = createChatProgressAuthorizer({
    acquireDeviceAuthorization: () => {
      held += 1;
      return () => {
        held -= 1;
      };
    },
    device: async () =>
      overrides.device === undefined
        ? {
            id: "device-1",
            capabilities: ["chat:read", "tasks:read", "agents:read"],
            acceptsProgressCapabilities: true,
          }
        : (overrides.device as never),
    chatMetadata: async () => overrides.metadata ?? [meta],
    readChat: overrides.readChat ?? (async () => chat),
    authorizeRetainedBotChat: overrides.authorizeBot ?? (async () => true),
    events,
  });
  return { authorize, events, held: () => held };
}

test("unknown and revoked devices are refused before any chat read", async () => {
  let chatsRead = 0;
  const missing = createChatProgressAuthorizer({
    acquireDeviceAuthorization: () => () => {},
    device: async () => undefined,
    chatMetadata: async () => [meta],
    readChat: async () => { chatsRead += 1; return chat; },
    authorizeRetainedBotChat: async () => true,
    events: new ChatProgressEvents(),
  });
  await assert.rejects(missing("ghost", "chat-1", "tasks:read"), /no longer paired/);

  const revoked = fixture({ device: { id: "device-1", revokedAt: 5, capabilities: ["chat:read", "tasks:read"], acceptsProgressCapabilities: true } });
  await assert.rejects(revoked.authorize("device-1", "chat-1", "tasks:read"), /no longer paired/);
  assert.equal(chatsRead, 0);
});

test("progress reads require negotiated chat plus the requested grant", async () => {
  const notNegotiated = fixture({
    device: { id: "d", capabilities: ["chat:read", "tasks:read"], acceptsProgressCapabilities: false },
  });
  await assert.rejects(notNegotiated.authorize("d", "chat-1", "tasks:read"), /capability_denied|unavailable/i);

  const noChatRead = fixture({
    device: { id: "d", capabilities: ["tasks:read"], acceptsProgressCapabilities: true },
  });
  await assert.rejects(noChatRead.authorize("d", "chat-1", "tasks:read"), /unavailable/);

  const wrongGrant = fixture({
    device: { id: "d", capabilities: ["chat:read", "tasks:read"], acceptsProgressCapabilities: true },
  });
  await assert.rejects(wrongGrant.authorize("d", "chat-1", "agents:read"), /unavailable/);
});

test("missing chats and the Assistant workspace report not found", async () => {
  const missing = fixture({ metadata: [] });
  await assert.rejects(missing.authorize("device-1", "chat-9", "tasks:read"), /unavailable/);

  const assistant = fixture({
    metadata: [{ ...meta, workspaceId: "assistant" }],
  });
  await assert.rejects(assistant.authorize("device-1", "chat-1", "tasks:read"), /unavailable/);
});

test("bot chats require bot read access plus retained authorization", async () => {
  const botMeta: ChatMeta = { ...meta, botId: "bot-1" };
  const noGrant = fixture({
    device: { id: "d", capabilities: ["chat:read", "tasks:read"], acceptsProgressCapabilities: true },
    metadata: [botMeta],
  });
  await assert.rejects(noGrant.authorize("d", "chat-1", "tasks:read"), /unavailable/);

  const denied = fixture({
    device: { id: "d", capabilities: ["chat:read", "tasks:read", "bot:read"], acceptsProgressCapabilities: true },
    metadata: [botMeta],
    authorizeBot: async () => false,
  });
  await assert.rejects(denied.authorize("d", "chat-1", "tasks:read"), /unavailable/);

  const allowed = fixture({
    device: { id: "d", capabilities: ["chat:read", "tasks:read", "bot:read"], acceptsProgressCapabilities: true },
    metadata: [botMeta],
  });
  const result = await allowed.authorize("d", "chat-1", "tasks:read");
  assert.equal(result.id, "chat-1");
});

test("the latest durable generation is cached per metadata revision and fenced", async () => {
  const { authorize } = fixture();
  const first = await authorize("device-1", "chat-1", "tasks:read");
  assert.equal(first.latestGenerationId, "stream_latest");

  // A mid-read generation begin discards the stale result instead of caching it.
  const events = new ChatProgressEvents();
  let begun = false;
  const racing = fixture({
    events,
    readChat: async () => {
      events.begin("chat-1", "stream_live");
      begun = true;
      return chat;
    },
  });
  const raced = await racing.authorize("device-1", "chat-1", "tasks:read");
  assert.equal(begun, true);
  // The begun generation wins over the idle-read result.
  assert.equal(raced.latestGenerationId, undefined);

  const active = new ChatProgressEvents();
  active.begin("chat-1", "stream_live");
  let heavyReads = 0;
  const activeRead = fixture({
    events: active,
    readChat: async () => {
      heavyReads += 1;
      return chat;
    },
  });
  await activeRead.authorize("device-1", "chat-1", "tasks:read");
  assert.equal(heavyReads, 0, "an active generation skips the transcript read");
});

test("the authorization fence releases on success and failure", async () => {
  const ok = fixture();
  await ok.authorize("device-1", "chat-1", "tasks:read");
  assert.equal(ok.held(), 0);

  const denied = fixture({
    device: { id: "d", capabilities: [], acceptsProgressCapabilities: true },
  });
  await assert.rejects(denied.authorize("d", "chat-1", "tasks:read"));
  assert.equal(denied.held(), 0);
});
