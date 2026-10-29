import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  captureDetachedLifecycleChat,
  clearInactiveDetachedLifecycleChat,
  clearObservedRunProjection,
  detachedLifecycleChatProjection,
  detachedTextStreamingRemaining,
  fallbackDetachedLifecycleStream,
  MAX_RECONCILIATION_ATTEMPTS,
  isDetachedLifecycleChatDraining,
  parseChatReadResponse,
  parseChatSettlementNotification,
  pendingDetachedLifecycleChats,
  preferLatestTerminalChat,
  reconcileChatReadUntilAuthoritative,
  rememberChatReadReconciliation,
  publishObservedRunProjection,
  releaseSettledDetachedLifecycleStreams,
  rememberDetachedLifecycleStream,
  rememberOwnGenerationStream,
  subscribeChatReadReconciliations,
  subscribeDetachedLifecycleStreams,
  subscribeChatSettlements,
  subscribeDetachedTerminalChats,
  visibleDetachedLifecycleProjection,
  waitForDetachedLifecycleSettlement,
} from "./chat-terminal-sync.js";
import type { DetachedLifecycleProjection } from "./chat-terminal-sync.js";
import type { Chat, ChatMessage } from "./types.js";
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
  let cachedTerminalChat: Chat | undefined;
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
    (updated) => {
      cachedTerminalChat = updated;
      return cacheSettlement;
    },
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
  for (const handler of listeners.get("chat:reasoning-delta") ?? []) {
    handler({ streamId: owner.streamId, delta: " more" });
  }
  assert.equal(detachedLifecycleChatProjection("chat-a", "workspace-1")?.reasoning, "Initial reasoning more");
  for (const handler of listeners.get("chat:delta") ?? []) {
    handler({ streamId: owner.streamId, delta: "", reset: true });
  }
  assert.equal(detachedLifecycleChatProjection("chat-a", "workspace-1")?.reasoning, "");

  for (const handler of listeners.get("chat:done") ?? []) {
    handler({ streamId: owner.streamId, chat: chat("chat-a", "durable") });
  }
  assert.equal(cachedTerminalChat?.messages[cachedTerminalChat.messages.length - 1]?.role, "assistant");
  // The pane must mask Stop/steer using the durable cache while this raw
  // projection remains retained until terminal reconciliation finishes.
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

test("an inactive snapshot repairs a missed terminal without clearing active work", () => {
  const staleOwner = detached("missed-terminal", "chat-missed-terminal", "workspace-1");
  const activeOwner = detached("still-running", "chat-still-running", "workspace-1");
  rememberDetachedLifecycleStream(staleOwner, {
    content: "Durable response that outlived the route",
    reasoning: "",
    timeline: null,
    artifacts: [],
    subagents: [],
  });
  rememberDetachedLifecycleStream(activeOwner);

  assert.deepEqual(pendingDetachedLifecycleChats(), [
    { chatId: staleOwner.chatId, workspaceId: staleOwner.workspaceId, streamIds: [staleOwner.streamId] },
    { chatId: activeOwner.chatId, workspaceId: activeOwner.workspaceId, streamIds: [activeOwner.streamId] },
  ]);
  const staleTarget = captureDetachedLifecycleChat(staleOwner);
  const activeTarget = captureDetachedLifecycleChat(activeOwner);
  assert.ok(staleTarget);
  assert.ok(activeTarget);
  const activeChatIds = new Set([activeOwner.chatId]);
  assert.equal(clearInactiveDetachedLifecycleChat(activeTarget, activeChatIds), false);
  assert.equal(isDetachedLifecycleChatDraining(activeOwner.chatId, activeOwner.workspaceId), true);
  assert.equal(clearInactiveDetachedLifecycleChat(staleTarget, activeChatIds), true);
  assert.equal(detachedLifecycleChatProjection(staleOwner.chatId, staleOwner.workspaceId), null);
  assert.equal(isDetachedLifecycleChatDraining(staleOwner.chatId, staleOwner.workspaceId), false);
  assert.equal(clearInactiveDetachedLifecycleChat(activeTarget, new Set()), true);
});

test("authoritative recovery is stream-exact when newer work starts in the same chat", () => {
  const owner = detached("fallback-missed", "chat-fallback-missed", "workspace-1");
  rememberDetachedLifecycleStream(owner);
  assert.equal(fallbackDetachedLifecycleStream(owner.streamId), true);
  const captured = captureDetachedLifecycleChat(owner);
  assert.ok(captured);

  const newerOwner = detached("newer-detached-work", owner.chatId, owner.workspaceId);
  rememberDetachedLifecycleStream(newerOwner);
  rememberDetachedLifecycleStream(detached("other-workspace", owner.chatId, "workspace-2"));
  assert.equal(clearInactiveDetachedLifecycleChat(captured, new Set()), true);
  assert.equal(isDetachedLifecycleChatDraining(owner.chatId, owner.workspaceId), true);
  assert.equal(isDetachedLifecycleChatDraining(owner.chatId, "workspace-2"), true);

  const newerTarget = captureDetachedLifecycleChat(newerOwner);
  const otherTarget = captureDetachedLifecycleChat({ chatId: owner.chatId, workspaceId: "workspace-2" });
  assert.ok(newerTarget);
  assert.ok(otherTarget);
  assert.equal(clearInactiveDetachedLifecycleChat(newerTarget, new Set()), true);
  assert.equal(clearInactiveDetachedLifecycleChat(otherTarget, new Set()), true);
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

test("a settled detached stream stops draining while the phone's newer turn keeps the chat busy", async () => {
  const finished = detached("mac-finished", "chat-phone-follow-up", "workspace-1");
  const stillRunning = detached("mac-still-running", "chat-phone-follow-up", "workspace-1");
  rememberDetachedLifecycleStream(finished);
  rememberDetachedLifecycleStream(stillRunning);
  // The finished stream's terminal never reached this document.
  assert.equal(fallbackDetachedLifecycleStream(finished.streamId), true);
  const captured = captureDetachedLifecycleChat(finished);
  assert.ok(captured);

  // The phone's turn keeps the chat active, so the chat-level path cannot help:
  // this is the stuck "Response continues in the background…" marker.
  assert.equal(clearInactiveDetachedLifecycleChat(captured, new Set([finished.chatId])), false);
  assert.equal(isDetachedLifecycleChatDraining(finished.chatId, finished.workspaceId), true);

  const order: string[] = [];
  const released = await releaseSettledDetachedLifecycleStreams(
    { chatId: finished.chatId, workspaceId: finished.workspaceId },
    {
      settled: async (streamIds) => {
        order.push(`settled:${[...streamIds].sort().join(",")}`);
        return streamIds.filter((streamId) => streamId === finished.streamId);
      },
      refreshChat: async (chatId) => {
        // The transcript is re-read before the marker goes, so nothing flashes away.
        order.push(`refresh:${chatId}:draining=${isDetachedLifecycleChatDraining(chatId, "workspace-1")}`);
      },
    },
  );
  assert.equal(released, true);
  assert.deepEqual(order, [
    "settled:mac-finished,mac-still-running",
    "refresh:chat-phone-follow-up:draining=true",
  ]);
  // Only the confirmed stream is released; the unsettled one still drains.
  assert.deepEqual(captureDetachedLifecycleChat(finished)?.streamIds, [stillRunning.streamId]);

  assert.equal(
    await releaseSettledDetachedLifecycleStreams(finished, {
      settled: async () => [],
      refreshChat: async () => assert.fail("nothing settled, so nothing is re-read"),
    }),
    false,
  );
  assert.equal(isDetachedLifecycleChatDraining(finished.chatId, finished.workspaceId), true);
  assert.equal(clearInactiveDetachedLifecycleChat(captureDetachedLifecycleChat(stillRunning)!, new Set()), true);
  assert.equal(
    await releaseSettledDetachedLifecycleStreams(finished, {
      settled: async () => assert.fail("a chat with no marker asks main nothing"),
      refreshChat: async () => assert.fail("a chat with no marker is not re-read"),
    }),
    false,
  );
});

test("a settled stream's release survives a competing read cancelling its refresh", async () => {
  const finished = detached("mac-cancelled-read", "chat-cancelled-read", "workspace-1");
  rememberDetachedLifecycleStream(finished);
  assert.equal(fallbackDetachedLifecycleStream(finished.streamId), true);

  let reads = 0;
  const released = await releaseSettledDetachedLifecycleStreams(finished, {
    settled: async (streamIds) => streamIds,
    refreshChat: async () => {
      reads += 1;
      // The observer's own read of the chat cancels the first one.
      if (reads === 1) throw new Error("CancelledError");
    },
  });
  assert.equal(released, true);
  assert.equal(reads, 2);
  assert.equal(isDetachedLifecycleChatDraining(finished.chatId, finished.workspaceId), false);

  // A chat whose reads keep failing is not released on faith.
  const unreadable = detached("mac-unreadable", "chat-unreadable", "workspace-1");
  rememberDetachedLifecycleStream(unreadable);
  assert.equal(fallbackDetachedLifecycleStream(unreadable.streamId), true);
  await assert.rejects(
    releaseSettledDetachedLifecycleStreams(unreadable, {
      settled: async (streamIds) => streamIds,
      refreshChat: async () => {
        throw new Error("offline");
      },
    }),
  );
  assert.equal(isDetachedLifecycleChatDraining(unreadable.chatId, unreadable.workspaceId), true);
  assert.equal(clearInactiveDetachedLifecycleChat(captureDetachedLifecycleChat(unreadable)!, new Set()), true);
});

test("an observed run shows as the chat's live projection until it is cleared", () => {
  const owner = detached("phone-run", "chat-observed", "workspace-1");
  let notifications = 0;
  const unsubscribe = subscribeDetachedLifecycleStreams(() => notifications++);
  try {
    assert.equal(
      publishObservedRunProjection(owner, { text: "Hel", reasoning: "Thinking", timeline: null, textStreaming: true }, 1_000),
      true,
    );
    assert.equal(isDetachedLifecycleChatDraining(owner.chatId, owner.workspaceId), true);
    const projection = detachedLifecycleChatProjection(owner.chatId, owner.workspaceId);
    assert.equal(projection?.content, "Hel");
    assert.equal(projection?.reasoning, "Thinking");
    assert.equal(projection?.lastTextDeltaAt, 1_000);
    assert.equal(projection?.observed, true);

    // Reasoning after text keeps the last prose time; an identical snapshot is not re-published.
    publishObservedRunProjection(owner, { text: "Hel", reasoning: "Thinking more", timeline: null, textStreaming: false }, 2_000);
    assert.equal(detachedLifecycleChatProjection(owner.chatId, owner.workspaceId)?.lastTextDeltaAt, 1_000);
    const before = notifications;
    assert.equal(
      publishObservedRunProjection(owner, { text: "Hel", reasoning: "Thinking more", timeline: null, textStreaming: false }, 3_000),
      false,
    );
    assert.equal(notifications, before);

    // Another workspace's chat with the same id is a different chat.
    assert.equal(detachedLifecycleChatProjection(owner.chatId, "workspace-2"), null);
    // Clearing a different run leaves this one; clearing this one ends the drain.
    assert.equal(clearObservedRunProjection(owner.chatId, owner.workspaceId, "another-run"), false);
    assert.equal(clearObservedRunProjection(owner.chatId, owner.workspaceId, owner.streamId), true);
    assert.equal(detachedLifecycleChatProjection(owner.chatId, owner.workspaceId), null);
    assert.equal(isDetachedLifecycleChatDraining(owner.chatId, owner.workspaceId), false);
  } finally {
    unsubscribe();
  }
});

test("a run this document started is never mirrored over its own detached projection", () => {
  const own = detached("own-detached-run", "chat-own-run", "workspace-1");
  rememberDetachedLifecycleStream(own, { content: "Mine", reasoning: "", timeline: null, artifacts: [], subagents: [] });
  assert.equal(
    publishObservedRunProjection(own, { text: "Mine plus mirror", reasoning: "", timeline: null, textStreaming: true }),
    false,
  );
  const projection = detachedLifecycleChatProjection(own.chatId, own.workspaceId);
  assert.equal(projection?.content, "Mine");
  assert.equal(projection?.observed, undefined);
  assert.equal(clearInactiveDetachedLifecycleChat(captureDetachedLifecycleChat(own)!, new Set()), true);
});

test("a run this document started is not mirrored back after its own terminal settles", async () => {
  // Revisit a running chat, then Stop: the watcher started on revisit still
  // follows the journal and reports the run's end after the terminal cleared
  // its detached marker. The run is still this window's own.
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    () => undefined,
  );
  const own = detached("own-stopped-run", "chat-own-stopped", "workspace-1");
  try {
    rememberDetachedLifecycleStream(own, { content: "Partial", reasoning: "", timeline: null, artifacts: [], subagents: [] });
    for (const handler of listeners.get("chat:done") ?? []) {
      handler({ streamId: own.streamId, chat: chat(own.chatId, "Partial") });
    }
    assert.equal(isDetachedLifecycleChatDraining(own.chatId, own.workspaceId), false);

    assert.equal(
      publishObservedRunProjection(own, {
        text: "Partial",
        reasoning: "",
        timeline: null,
        textStreaming: false,
        finished: true,
      }),
      false,
    );
    assert.equal(detachedLifecycleChatProjection(own.chatId, own.workspaceId), null);
    assert.equal(isDetachedLifecycleChatDraining(own.chatId, own.workspaceId), false);

    // A run another device started in the same chat is still mirrored.
    const phone = detached("phone-run-after-stop", own.chatId, own.workspaceId);
    assert.equal(
      publishObservedRunProjection(phone, { text: "Hi", reasoning: "", timeline: null, textStreaming: true }),
      true,
    );
    assert.equal(detachedLifecycleChatProjection(own.chatId, own.workspaceId)?.streamId, phone.streamId);
    assert.equal(clearObservedRunProjection(own.chatId, own.workspaceId, phone.streamId), true);
  } finally {
    unsubscribe();
  }
});

test("a run this document started without detaching is never mirrored", () => {
  const own = detached("own-attached-run", "chat-own-attached", "workspace-1");
  rememberOwnGenerationStream(own.streamId);
  assert.equal(
    publishObservedRunProjection(own, { text: "Done", reasoning: "", timeline: null, textStreaming: false, finished: true }),
    false,
  );
  assert.equal(isDetachedLifecycleChatDraining(own.chatId, own.workspaceId), false);
});

test("a saved reply hides an own run, but a mirrored run only by its own reply", () => {
  const projection = (streamId: string, observed: boolean): DetachedLifecycleProjection => ({
    ...detached(streamId),
    content: "Streaming",
    lastTextDeltaAt: null,
    reasoning: "",
    timeline: null,
    artifacts: [],
    subagents: [],
    ...(observed ? { observed: true as const } : {}),
  });
  const reply = (generationId?: string): ChatMessage => ({
    id: `reply-${generationId ?? "untimed"}`,
    role: "assistant",
    content: "Done",
    createdAt: 2,
    ...(generationId
      ? { timeline: { version: 3, generationId, status: "completed", startedAt: 1, steps: [] } }
      : {}),
  });
  const prompt: ChatMessage = { id: "prompt", role: "user", content: "Next", createdAt: 3 };

  const own = projection("run-new", false);
  assert.equal(visibleDetachedLifecycleProjection(own, undefined), own);
  assert.equal(visibleDetachedLifecycleProjection(own, [reply("run-old"), prompt]), own);
  // An own run's text is already in the cached reply at handoff, whatever its timeline.
  assert.equal(visibleDetachedLifecycleProjection(own, [reply()]), null);

  const mirrored = projection("run-new", true);
  // A phone's turn starts while the cache still ends with the previous reply.
  assert.equal(visibleDetachedLifecycleProjection(mirrored, [reply("run-old")]), mirrored);
  assert.equal(visibleDetachedLifecycleProjection(mirrored, [reply()]), mirrored);
  assert.equal(visibleDetachedLifecycleProjection(mirrored, [reply("run-old"), reply("run-new")]), null);

  assert.equal(visibleDetachedLifecycleProjection(null, [reply("run-new")]), null);
});

function fakeStreamChannels() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    subscribe: (channel: string, handler: (payload: unknown) => void) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    emit: (channel: string, payload: unknown) => {
      for (const handler of listeners.get(channel) ?? []) handler(payload);
    },
  };
}

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

test("a detached stream's tokens notify subscribers once a frame, structural changes at once", async () => {
  const channels = fakeStreamChannels();
  const unsubscribeChannels = subscribeDetachedTerminalChats(channels.subscribe, () => undefined);
  const owner = detached("frame-batched", "chat-frame", "workspace-1");
  rememberDetachedLifecycleStream(owner);
  let notifications = 0;
  const unsubscribe = subscribeDetachedLifecycleStreams(() => notifications++);
  try {
    for (const delta of ["Hel", "lo", " world"]) {
      channels.emit("chat:delta", { streamId: owner.streamId, delta });
    }
    channels.emit("chat:reasoning-delta", { streamId: owner.streamId, delta: "Thinking" });
    // The projection is current for any render, but nobody was told per token.
    assert.equal(detachedLifecycleChatProjection(owner.chatId, owner.workspaceId)?.content, "Hello world");
    assert.equal(detachedLifecycleChatProjection(owner.chatId, owner.workspaceId)?.reasoning, "Thinking");
    assert.equal(notifications, 0);
    await nextFrame();
    assert.equal(notifications, 1);

    // A structural change (a new timeline) notifies at once and carries the pending text with it.
    channels.emit("chat:delta", { streamId: owner.streamId, delta: "!" });
    channels.emit("chat:timeline", {
      streamId: owner.streamId,
      timeline: { version: 3, generationId: owner.streamId, status: "running", startedAt: 1, steps: [] },
    });
    assert.equal(notifications, 2);
    await nextFrame();
    assert.equal(notifications, 2);
    assert.equal(detachedLifecycleChatProjection(owner.chatId, owner.workspaceId)?.content, "Hello world!");

    // A reset clears the reply now rather than a frame later.
    channels.emit("chat:delta", { streamId: owner.streamId, reset: true });
    assert.equal(notifications, 3);
    assert.equal(detachedLifecycleChatProjection(owner.chatId, owner.workspaceId)?.content, "");
  } finally {
    unsubscribe();
    unsubscribeChannels();
    channels.emit("chat:done", { streamId: owner.streamId, chat: chat(owner.chatId, "done") });
  }
});

test("a mirrored run's growing text notifies once a frame; its end notifies at once", async () => {
  const owner = detached("mirrored-frame", "chat-mirrored-frame", "workspace-1");
  let notifications = 0;
  const unsubscribe = subscribeDetachedLifecycleStreams(() => notifications++);
  try {
    publishObservedRunProjection(owner, { text: "A", reasoning: "", timeline: null, textStreaming: true }, 1);
    // A new run is structural.
    assert.equal(notifications, 1);
    publishObservedRunProjection(owner, { text: "AB", reasoning: "", timeline: null, textStreaming: true }, 2);
    publishObservedRunProjection(owner, { text: "ABC", reasoning: "", timeline: null, textStreaming: true }, 3);
    assert.equal(notifications, 1);
    assert.equal(detachedLifecycleChatProjection(owner.chatId, owner.workspaceId)?.content, "ABC");
    await nextFrame();
    assert.equal(notifications, 2);
    publishObservedRunProjection(
      owner,
      { text: "ABC", reasoning: "", timeline: null, textStreaming: false, finished: true },
      4,
    );
    assert.equal(notifications, 3);
  } finally {
    clearObservedRunProjection(owner.chatId, owner.workspaceId);
    unsubscribe();
  }
});

test("a chat read that keeps failing backs off and gives up instead of polling every 100 ms", async () => {
  const pauses: number[] = [];
  let reads = 0;
  const result = await reconcileChatReadUntilAuthoritative({
    isDeleted: () => false,
    waitUntilIdle: async () => true,
    refreshChat: async () => {
      reads += 1;
      throw new Error("chat file unreadable");
    },
    refreshChatList: async () => undefined,
    pause: async (delayMs) => {
      pauses.push(delayMs);
    },
  });
  assert.equal(result, "failed");
  assert.equal(reads, MAX_RECONCILIATION_ATTEMPTS);
  assert.equal(pauses.length, MAX_RECONCILIATION_ATTEMPTS - 1);
  assert.equal(pauses[0], 100);
  for (let index = 1; index < pauses.length; index += 1) {
    assert.ok(pauses[index]! >= pauses[index - 1]!, "pauses never shrink");
  }
  assert.equal(Math.max(...pauses), 5_000);
});

test("settlement waits keep waiting while main reports busy but give up when the wait keeps failing", async () => {
  // Busy is main's bounded grace running out on a long run: keep waiting.
  const outcomes = [false, false, false, false, false, false, false, false, false, false, false, true];
  assert.equal(
    await waitForDetachedLifecycleSettlement(
      async () => outcomes.shift() ?? true,
      async () => undefined,
    ),
    true,
  );

  let waits = 0;
  const unavailable = await reconcileChatReadUntilAuthoritative({
    isDeleted: () => false,
    waitUntilIdle: async () => {
      waits += 1;
      throw new Error("IPC unavailable");
    },
    refreshChat: async () => assert.fail("never read before main settles"),
    refreshChatList: async () => undefined,
    pause: async () => undefined,
  });
  assert.equal(unavailable, "failed");
  assert.equal(waits, MAX_RECONCILIATION_ATTEMPTS);

  // Deletion still stops a wait at once.
  let deleted = false;
  assert.equal(
    await reconcileChatReadUntilAuthoritative({
      isDeleted: () => deleted,
      waitUntilIdle: async () => {
        deleted = true;
        throw new Error("gone");
      },
      refreshChat: async () => undefined,
      refreshChatList: async () => undefined,
      pause: async () => undefined,
    }),
    "deleted",
  );
});

test("a fallback handoff that keeps failing stops retrying and releases the draining chat", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const channels = fakeStreamChannels();
  let attempts = 0;
  const unsubscribe = subscribeDetachedTerminalChats(
    channels.subscribe,
    () => undefined,
    () => {
      attempts += 1;
      return Promise.reject(new Error("cache unavailable"));
    },
  );
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const owner = detached("fallback-gives-up", "chat-gives-up", "workspace-1");
    rememberDetachedLifecycleStream(owner);
    assert.equal(fallbackDetachedLifecycleStream(owner.streamId), true);
    await settle();
    assert.equal(attempts, 1);
    // The first retry waits the base delay, not less.
    mock.timers.tick(99);
    await settle();
    assert.equal(attempts, 1);
    mock.timers.tick(1);
    await settle();
    assert.equal(attempts, 2);
    for (let tick = 0; tick < 40 && attempts < MAX_RECONCILIATION_ATTEMPTS; tick += 1) {
      mock.timers.tick(5_000);
      await settle();
    }
    assert.equal(attempts, MAX_RECONCILIATION_ATTEMPTS);
    assert.equal(isDetachedLifecycleChatDraining(owner.chatId, owner.workspaceId), false);
    mock.timers.tick(60_000);
    await settle();
    assert.equal(attempts, MAX_RECONCILIATION_ATTEMPTS);
  } finally {
    unsubscribe();
    mock.timers.reset();
  }
});
