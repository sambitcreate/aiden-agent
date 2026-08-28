import assert from "node:assert/strict";
import test from "node:test";
import {
  detachedLifecycleChatProjection,
  detachedTextStreamingRemaining,
  fallbackDetachedLifecycleStream,
  isDetachedLifecycleChatDraining,
  parseChatReadResponse,
  parseChatSettlementNotification,
  preferLatestTerminalChat,
  reconcileChatReadUntilAuthoritative,
  rememberChatReadReconciliation,
  rememberDetachedLifecycleStream,
  subscribeChatReadReconciliations,
  subscribeChatSettlements,
  subscribeDetachedTerminalChats,
  waitForDetachedLifecycleSettlement,
} from "./chat-terminal-sync.js";
import type { Chat } from "./types.js";
import type { SubagentRunSnapshotV1 } from "../shared/subagent-runs.js";

function chat(id: string, content: string): Chat {
  return {
    id,
    title: id,
    workspaceId: "workspace-1",
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: `message-${content}`,
        role: "assistant",
        content,
        createdAt: 2,
      },
    ],
  };
}

function detached(streamId: string, chatId = "chat-a", workspaceId = "workspace-1") {
  return { streamId, chatId, workspaceId };
}

function subagent(
  streamId: string,
  revision = 1,
  state: SubagentRunSnapshotV1["state"] = "running",
): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId: "run-1",
    groupId: `${streamId}:group-1`,
    generationId: streamId,
    childId: "child-1",
    chatId: "chat-a",
    workspaceId: "workspace-1",
    revision,
    role: "scout",
    label: "Inspect renderer lifecycle",
    taskPreview: "Check chat switching.",
    state,
    startedAt: 1_000,
    updatedAt: 1_000 + revision,
    ...(state === "running" ? {} : { finishedAt: 1_000 + revision }),
    modelId: "model-1",
    turns: revision,
    tools: 0,
    tokens: 0,
    warnings: [],
  };
}

test("a revisited chat retains and advances its detached answer and subagent projection", async () => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let settleCache!: () => void;
  const cacheSettlement = new Promise<void>((resolve) => {
    settleCache = resolve;
  });
  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    () => cacheSettlement,
  );
  const owner = detached("stream-projection");
  rememberDetachedLifecycleStream(owner, {
    content: "Partial answer",
    reasoning: "Initial reasoning",
    timeline: null,
    artifacts: [],
    subagents: [subagent(owner.streamId)],
  });

  assert.equal(detachedLifecycleChatProjection("chat-a", "workspace-1")?.content, "Partial answer");
  assert.equal(detachedLifecycleChatProjection("chat-a", "workspace-1")?.subagents[0]?.revision, 1);
  const beforeDelta = Date.now();
  for (const handler of listeners.get("chat:delta") ?? []) {
    handler({ streamId: owner.streamId, delta: " continues" });
  }
  for (const handler of listeners.get("chat:subagents") ?? []) {
    handler({ streamId: owner.streamId, snapshot: subagent(owner.streamId, 2, "completed") });
  }
  assert.equal(
    detachedLifecycleChatProjection("chat-a", "workspace-1")?.content,
    "Partial answer continues",
  );
  assert.ok(
    (detachedLifecycleChatProjection("chat-a", "workspace-1")?.lastTextDeltaAt ?? 0) >= beforeDelta,
  );
  assert.equal(
    detachedLifecycleChatProjection("chat-a", "workspace-1")?.subagents[0]?.state,
    "completed",
  );

  for (const handler of listeners.get("chat:done") ?? []) {
    handler({ streamId: owner.streamId, chat: chat("chat-a", "durable") });
  }
  assert.notEqual(detachedLifecycleChatProjection("chat-a", "workspace-1"), null);
  settleCache();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(detachedLifecycleChatProjection("chat-a", "workspace-1"), null);
  assert.equal(isDetachedLifecycleChatDraining("chat-a", "workspace-1"), false);
  unsubscribe();
});

test("detached text streaming expires relative to the last prose delta", () => {
  assert.equal(detachedTextStreamingRemaining(null, 5_000, 2_000), 0);
  assert.equal(detachedTextStreamingRemaining(4_250, 5_000, 2_000), 1_250);
  assert.equal(detachedTextStreamingRemaining(2_000, 5_000, 2_000), 0);
  assert.equal(detachedTextStreamingRemaining(6_000, 5_000, 2_000), 2_000);
});

test("a late terminal handoff repairs a refetched chat after A to B to A navigation", () => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const cache = new Map<string, Chat>();
  const oldA = chat("chat-a", "old");
  const persistedA = chat("chat-a", "persisted with subagent chips");
  cache.set(oldA.id, oldA);

  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    (updated) => cache.set(updated.id, updated),
  );

  rememberDetachedLifecycleStream(detached("stream-a"));
  assert.equal(isDetachedLifecycleChatDraining("chat-a", "workspace-1"), true);
  // A rapid revisit can complete its read before main finishes persisting.
  cache.set(oldA.id, oldA);
  for (const handler of listeners.get("chat:done") ?? []) {
    handler({ streamId: "stream-a", chat: persistedA });
  }

  assert.equal(cache.get("chat-a")?.messages[0]?.content, "persisted with subagent chips");
  assert.equal(isDetachedLifecycleChatDraining("chat-a", "workspace-1"), false);
  assert.equal(listeners.get("chat:done")?.size, 1);
  assert.equal(listeners.get("chat:error")?.size, 1);
  unsubscribe();
  assert.equal(listeners.get("chat:done")?.size, 0);
  assert.equal(listeners.get("chat:error")?.size, 0);
});

test("terminal cache sync ignores attached, malformed, and replayed payloads", () => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const updates: Chat[] = [];
  const fallbacks: string[] = [];
  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    (updated) => updates.push(updated),
    (owner) => {
      fallbacks.push(owner.streamId);
    },
  );

  const emitError = (payload: unknown) => {
    for (const handler of listeners.get("chat:error") ?? []) handler(payload);
  };
  emitError({
    streamId: "still-visible",
    chat: chat("chat-visible", "visible"),
  });
  rememberDetachedLifecycleStream(detached("detached"));
  emitError({ streamId: "detached", chat: { id: "incomplete" } });
  emitError({ streamId: "detached", chat: chat("chat-a", "late") });
  assert.equal(updates.length, 0);
  assert.deepEqual(fallbacks, ["detached"]);

  rememberDetachedLifecycleStream(detached("detached-valid"));
  emitError({ streamId: "detached-valid", chat: chat("chat-a", "valid") });
  emitError({ streamId: "detached-valid", chat: chat("chat-a", "replayed") });
  assert.deepEqual(
    updates.map((updated) => updated.messages[0]?.content),
    ["valid"],
  );
  unsubscribe();
});

test("terminal-free start rejection routes a detached stream through fallback", () => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const fallbacks: string[] = [];
  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    () => undefined,
    (owner) => {
      fallbacks.push(owner.streamId);
    },
  );

  rememberDetachedLifecycleStream(detached("start-rejected"));
  assert.equal(fallbackDetachedLifecycleStream("start-rejected"), true);
  assert.equal(fallbackDetachedLifecycleStream("start-rejected"), false);
  assert.deepEqual(fallbacks, ["start-rejected"]);
  assert.equal(isDetachedLifecycleChatDraining("chat-a", "workspace-1"), false);
  unsubscribe();
});

test("detached terminal reconciliation validates chat and workspace ownership", () => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const updates: Chat[] = [];
  const fallbacks: string[] = [];
  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    (updated) => updates.push(updated),
    (owner) => {
      fallbacks.push(owner.streamId);
    },
  );

  rememberDetachedLifecycleStream(detached("wrong-chat"));
  for (const handler of listeners.get("chat:done") ?? []) {
    handler({ streamId: "wrong-chat", chat: chat("chat-b", "mismatch") });
  }

  rememberDetachedLifecycleStream(detached("wrong-workspace"));
  for (const handler of listeners.get("chat:done") ?? []) {
    handler({
      streamId: "wrong-workspace",
      chat: { ...chat("chat-a", "mismatch"), workspaceId: "workspace-2" },
    });
  }

  assert.deepEqual(updates, []);
  assert.deepEqual(fallbacks, ["wrong-chat", "wrong-workspace"]);
  assert.equal(isDetachedLifecycleChatDraining("chat-a", "workspace-1"), false);
  unsubscribe();
});

test("the 65th detached stream stays draining until its fallback refetch settles", async () => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const fallbacks: string[] = [];
  let settleFallback: (() => void) | undefined;
  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    () => undefined,
    (owner) => {
      fallbacks.push(owner.streamId);
      return new Promise<void>((resolve) => {
        settleFallback = resolve;
      });
    },
  );

  for (let index = 0; index < 65; index += 1) {
    rememberDetachedLifecycleStream(
      detached(`overflow-${index}`, `chat-overflow-${index}`, "workspace-1"),
    );
  }

  assert.deepEqual(fallbacks, ["overflow-0"]);
  assert.equal(isDetachedLifecycleChatDraining("chat-overflow-0", "workspace-1"), true);
  assert.equal(detachedLifecycleChatProjection("chat-overflow-0", "workspace-1"), null);
  assert.equal(isDetachedLifecycleChatDraining("chat-overflow-1", "workspace-1"), true);
  settleFallback?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isDetachedLifecycleChatDraining("chat-overflow-0", "workspace-1"), false);

  // Settle retained records so this module-level bounded registry cannot leak
  // state into later tests.
  for (let index = 1; index < 65; index += 1) {
    for (const handler of listeners.get("chat:done") ?? []) {
      handler({
        streamId: `overflow-${index}`,
        chat: chat(`chat-overflow-${index}`, `settled-${index}`),
      });
    }
  }
  assert.equal(isDetachedLifecycleChatDraining("chat-overflow-64", "workspace-1"), false);
  unsubscribe();
});

test("out-of-order detached completions cannot roll chat history backward", () => {
  const newer = { ...chat("chat-a", "newer"), updatedAt: 5 };
  const older = { ...chat("chat-a", "older"), updatedAt: 4 };
  assert.equal(preferLatestTerminalChat(newer, older), newer);

  const longer = {
    ...chat("chat-a", "longer"),
    updatedAt: 5,
    messages: [...newer.messages, ...chat("chat-a", "second").messages],
  };
  assert.equal(preferLatestTerminalChat(longer, newer), longer);
  assert.equal(preferLatestTerminalChat(older, newer), newer);
});

test("fallback settlement retries timeout and rejection until main reports idle", async () => {
  const outcomes: Array<boolean | Error> = [false, new Error("IPC unavailable"), true];
  let waits = 0;
  let pauses = 0;
  await waitForDetachedLifecycleSettlement(
    async () => {
      waits += 1;
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome ?? true;
    },
    async () => {
      pauses += 1;
    },
  );
  assert.equal(waits, 3);
  assert.equal(pauses, 2);
});

test("a rejected fallback listener keeps the chat draining until retry succeeds", async () => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let attempts = 0;
  let resolveRetry!: () => void;
  const retried = new Promise<void>((resolve) => {
    resolveRetry = resolve;
  });
  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    () => undefined,
    () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("cache unavailable"));
      resolveRetry();
      return Promise.resolve();
    },
  );

  rememberDetachedLifecycleStream(detached("fallback-retry"));
  assert.equal(fallbackDetachedLifecycleStream("fallback-retry"), true);
  assert.equal(isDetachedLifecycleChatDraining("chat-a", "workspace-1"), true);
  await retried;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(isDetachedLifecycleChatDraining("chat-a", "workspace-1"), false);
  unsubscribe();
});

test("settlement notifications expose only validated bounded ownership", () => {
  assert.deepEqual(
    parseChatSettlementNotification({
      chatId: "chat-a",
      workspaceId: "workspace-1",
    }),
    { chatId: "chat-a", workspaceId: "workspace-1" },
  );
  for (const payload of [
    null,
    {},
    { chatId: "", workspaceId: "workspace-1" },
    { chatId: "chat-a", workspaceId: "" },
    { chatId: "/private/path", workspaceId: "workspace-1" },
    { chatId: "chat-a", workspaceId: "x".repeat(500) },
  ]) {
    assert.equal(parseChatSettlementNotification(payload), null);
  }
});

test("detached lifecycle ownership rejects unsafe renderer identifiers", () => {
  for (const owner of [
    detached("/private/stream"),
    detached("unsafe-chat", "/private/chat"),
    detached("unsafe-workspace", "chat-a", "/private/workspace"),
  ]) {
    rememberDetachedLifecycleStream(owner);
    assert.equal(fallbackDetachedLifecycleStream(owner.streamId), false);
  }
});

test("a replacement renderer refetches after delayed main-process settlement", () => {
  const listeners = new Set<(payload: unknown) => void>();
  let durable = chat("chat-a", "before persistence");
  let replacementCache = durable;
  const settlements: string[] = [];
  const unsubscribe = subscribeChatSettlements(
    (_channel, handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    (settlement) => {
      settlements.push(settlement.chatId);
      replacementCache = durable;
    },
  );

  // The replacement document's opening read completes before the cancelled
  // old owner finishes durable assistant persistence.
  assert.equal(replacementCache.messages[0]?.content, "before persistence");
  durable = chat("chat-a", "persisted after renderer replacement");
  for (const listener of listeners) {
    listener({ chatId: "chat-a", workspaceId: "workspace-1" });
  }
  assert.deepEqual(settlements, ["chat-a"]);
  assert.equal(replacementCache.messages[0]?.content, "persisted after renderer replacement");
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("a provisional stale read survives a missed settlement event until authoritative refetch", async () => {
  const stale = chat("chat-missed-settlement", "stale before old owner persisted");
  const durable = chat("chat-missed-settlement", "durable with subagent references");
  const response = parseChatReadResponse({
    chat: stale,
    imageArtifactRecoveryPending: false,
    imageArtifactRecoveryUnavailable: false,
    reconciliation: {
      chatId: stale.id,
      workspaceId: stale.workspaceId,
    },
  });
  assert.ok(response?.reconciliation);

  let replacementCache = response.chat;
  // chats:settled has already fired into the old renderer. The IPC read result
  // itself installs a retained marker before the replacement shell subscribes.
  rememberChatReadReconciliation(response.reconciliation);
  assert.equal(isDetachedLifecycleChatDraining(stale.id, stale.workspaceId), true);

  const idleOutcomes = [false, true];
  let exactReads = 0;
  let listReads = 0;
  let reconciled!: () => void;
  const reconciledPromise = new Promise<void>((resolve) => {
    reconciled = resolve;
  });
  const unsubscribe = subscribeChatReadReconciliations(async (owner) => {
    assert.equal(owner.chatId, stale.id);
    const result = await reconcileChatReadUntilAuthoritative({
      isDeleted: () => false,
      waitUntilIdle: async () => idleOutcomes.shift() ?? true,
      refreshChat: async () => {
        exactReads += 1;
        if (exactReads === 1) throw new Error("transient query cache failure");
        replacementCache = durable;
      },
      refreshChatList: async () => {
        listReads += 1;
      },
      pause: async () => undefined,
    });
    assert.equal(result, "reconciled");
    reconciled();
  });

  await reconciledPromise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacementCache?.messages[0]?.content, "durable with subagent references");
  assert.equal(exactReads, 2);
  assert.equal(listReads, 1);
  assert.equal(isDetachedLifecycleChatDraining(stale.id, stale.workspaceId), false);
  unsubscribe();
});

test("chat read reconciliation metadata is bounded, content-free, and owner-bound", () => {
  const stale = chat("chat-a", "stale transcript remains only inside chat");
  assert.deepEqual(
    parseChatReadResponse({
      chat: stale,
      imageArtifactRecoveryPending: true,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: null,
    }),
    {
      chat: stale,
      imageArtifactRecoveryPending: true,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: null,
    },
  );
  assert.deepEqual(
    parseChatReadResponse({
      chat: stale,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: true,
      reconciliation: null,
    }),
    {
      chat: stale,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: true,
      reconciliation: null,
    },
  );
  for (const response of [
    { chat: stale },
    {
      chat: stale,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: { chatId: "chat-b", workspaceId: "workspace-1" },
    },
    {
      chat: stale,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: { chatId: "chat-a", workspaceId: "/private/path" },
    },
    {
      chat: stale,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: {
        chatId: "chat-a",
        workspaceId: "x".repeat(500),
      },
    },
  ]) {
    assert.equal(parseChatReadResponse(response), null);
  }
});

test("authoritative reconciliation stops without refetching after a deletion tombstone", async () => {
  let deleted = false;
  let exactReads = 0;
  const result = await reconcileChatReadUntilAuthoritative({
    isDeleted: () => deleted,
    waitUntilIdle: async () => {
      deleted = true;
      return true;
    },
    refreshChat: async () => {
      exactReads += 1;
    },
    refreshChatList: async () => undefined,
    pause: async () => undefined,
  });
  assert.equal(result, "deleted");
  assert.equal(exactReads, 0);
});
