import assert from "node:assert/strict";
import test from "node:test";
import type { PeerRunEvent, PeerRunSubscription } from "../../shared/peer-host";
import type { LocalRunFrame, LocalRunFrameMessage } from "../../shared/local-run-frames";
import {
  captureDetachedLifecycleChat,
  clearInactiveDetachedLifecycleChat,
  detachedLifecycleChatProjection,
  isDetachedLifecycleChatDraining,
  rememberDetachedLifecycleStream,
} from "../chat-terminal-sync";
import { LocalHostAdapter, type LocalChatApis } from "./local-host-adapter";
import { observeLocalRun } from "./observed-local-run";

const WORKSPACE = "workspace-1";

function runEvent(runId: string, sequence: number, type: string, payload: Record<string, unknown> = {}): PeerRunEvent {
  return {
    protocolVersion: 1,
    streamId: runId,
    sequence,
    timestamp: new Date(sequence).toISOString(),
    type,
    terminal: type === "done" || type === "error" || type === "cancelled",
    payload,
  };
}

/** This Mac's main process as the renderer sees it: one observation and its frame channel. */
function fakeMain(subscription: Omit<PeerRunSubscription, "subscriptionId" | "key" | "truncated">) {
  const handlers = new Set<(message: LocalRunFrameMessage) => void>();
  const calls: unknown[][] = [];
  const unused = async (): Promise<never> => {
    throw new Error("not part of this flow");
  };
  const apis: LocalChatApis = {
    rename: unused,
    remove: unused,
    markRead: unused,
    approve: unused,
    answerQuestionnaire: unused,
    respondRemoteApproval: unused,
    respondRemoteQuestion: unused,
    admitRunInput: unused,
    // The phone's run is not this window's, so the owner-checked Stop declines it.
    stop: async (runId) => {
      calls.push(["stop", runId]);
      return false;
    },
    stopHostRun: async (runId) => {
      calls.push(["stopHostRun", runId]);
      return true;
    },
    observeRun: async (chatId) => {
      calls.push(["observeRun", chatId]);
      return { ...subscription, subscriptionId: "sub-1", key: "sub-1", truncated: false };
    },
    unobserveRun: async (id) => {
      calls.push(["unobserveRun", id]);
      return true;
    },
    onRunFrame: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return {
    calls,
    adapter: new LocalHostAdapter(apis),
    send: (...frames: LocalRunFrame[]) => {
      for (const handler of handlers) handler({ subscriptionId: "sub-1", chatId: subscription.chatId ?? "", frames });
    },
  };
}

function deferredRefetches() {
  const pending: Array<() => void> = [];
  return {
    count: () => pending.length,
    refetch: () => new Promise<void>((resolve) => pending.push(resolve)),
    /** Lets every outstanding chat read finish, as the cache update would. */
    finishAll: async () => {
      while (pending.length > 0) pending.shift()!();
      await new Promise((settle) => setImmediate(settle));
    },
  };
}

const tick = () => new Promise((settle) => setImmediate(settle));

test("a phone's turn on this Mac streams into the open chat live and gives way to the saved reply", async () => {
  const chatId = "chat-phone-turn";
  const main = fakeMain({
    runId: "run-phone",
    chatId,
    state: "streaming",
    events: [runEvent("run-phone", 1, "run.started", { chatId, origin: "remote" }), runEvent("run-phone", 2, "text_delta", { text: "Hel" })],
  });
  const reads = deferredRefetches();
  const close = observeLocalRun({
    adapter: main.adapter,
    chatId,
    workspaceId: WORKSPACE,
    refetch: reads.refetch,
    now: () => 1_000,
    schedule: (publish) => publish(),
  });
  await tick();

  // The phone's message was saved before the run began, so the chat is re-read once.
  assert.equal(reads.count(), 1);
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Hel");
  assert.equal(isDetachedLifecycleChatDraining(chatId, WORKSPACE), true);

  main.send(
    { kind: "event", event: runEvent("run-phone", 3, "reasoning_delta", { text: "Checking the plan" }) },
    { kind: "event", event: runEvent("run-phone", 4, "text_delta", { text: "lo there" }) },
  );
  const live = detachedLifecycleChatProjection(chatId, WORKSPACE);
  assert.equal(live?.content, "Hello there", "text arrives before the run settles");
  assert.equal(live?.reasoning, "Checking the plan");
  assert.equal(live?.observed, true);

  // Stop from this window reaches the phone's run with host authority.
  assert.equal(await main.adapter.cancel(chatId, { runId: live!.streamId }), true);
  assert.deepEqual(main.calls.filter(([route]) => route !== "observeRun"), [
    ["stop", "run-phone"],
    ["stopHostRun", "run-phone"],
  ]);

  main.send(
    { kind: "event", event: runEvent("run-phone", 5, "cancelled") },
    { kind: "event", event: runEvent("run-phone", 6, "run.ended", { chatId, state: "cancelled" }) },
    { kind: "state", runId: "run-phone", state: "ended" },
  );
  // Until the saved reply is read, the streamed one stays rather than flashing away.
  assert.equal(reads.count(), 1);
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Hello there");
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null);
  assert.equal(isDetachedLifecycleChatDraining(chatId, WORKSPACE), false);

  // The same observation picks up the chat's next run.
  main.send(
    { kind: "state", runId: "run-next", state: "streaming" },
    { kind: "event", event: runEvent("run-next", 1, "run.started", { chatId, origin: "remote" }) },
    { kind: "event", event: runEvent("run-next", 2, "text_delta", { text: "Again" }) },
  );
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.streamId, "run-next");

  close();
  await tick();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null, "closing drops the mirror");
  assert.equal(isDetachedLifecycleChatDraining(chatId, WORKSPACE), false);
  assert.deepEqual(main.calls[main.calls.length - 1], ["unobserveRun", "sub-1"]);
  main.send({ kind: "event", event: runEvent("run-next", 3, "text_delta", { text: " more" }) });
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null);
});

test("a run that had already finished before the chat was opened shows nothing", async () => {
  const chatId = "chat-finished-before";
  const main = fakeMain({ runId: "run-old", chatId, state: "ended", events: [] });
  const reads = deferredRefetches();
  const close = observeLocalRun({ adapter: main.adapter, chatId, workspaceId: WORKSPACE, refetch: reads.refetch, schedule: (publish) => publish() });
  await tick();
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null);
  assert.equal(isDetachedLifecycleChatDraining(chatId, WORKSPACE), false);
  close();
});

test("a run with undelivered text shows its activity without a partial reply", async () => {
  const chatId = "chat-gap";
  const main = fakeMain({
    runId: "run-gap",
    chatId,
    state: "streaming",
    events: [
      runEvent("run-gap", 1, "run.started", { chatId }),
      runEvent("run-gap", 40, "snapshot", { reason: "gap", state: "running" }),
      runEvent("run-gap", 41, "text_delta", { text: "tail only" }),
    ],
  });
  const reads = deferredRefetches();
  const close = observeLocalRun({ adapter: main.adapter, chatId, workspaceId: WORKSPACE, refetch: reads.refetch, schedule: (publish) => publish() });
  await tick();
  await reads.finishAll();
  const projection = detachedLifecycleChatProjection(chatId, WORKSPACE);
  assert.equal(projection?.streamId, "run-gap", "Stop stays available");
  assert.equal(projection?.content, "");
  close();
});

test("this window's own route-detached run keeps its own projection", async () => {
  const chatId = "chat-own-run";
  const own = { streamId: "run-own", chatId, workspaceId: WORKSPACE };
  rememberDetachedLifecycleStream(own, { content: "Mine so far", reasoning: "", timeline: null, artifacts: [], subagents: [] });
  const main = fakeMain({
    runId: "run-own",
    chatId,
    state: "streaming",
    events: [runEvent("run-own", 1, "run.started", { chatId }), runEvent("run-own", 2, "text_delta", { text: "Mine so far and more" })],
  });
  const reads = deferredRefetches();
  const close = observeLocalRun({ adapter: main.adapter, chatId, workspaceId: WORKSPACE, refetch: reads.refetch, schedule: (publish) => publish() });
  await tick();
  await reads.finishAll();
  const projection = detachedLifecycleChatProjection(chatId, WORKSPACE);
  assert.equal(projection?.content, "Mine so far");
  assert.equal(projection?.observed, undefined);
  close();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Mine so far", "closing leaves the owner's projection");
  assert.equal(clearInactiveDetachedLifecycleChat(captureDetachedLifecycleChat(own)!, new Set()), true);
});
