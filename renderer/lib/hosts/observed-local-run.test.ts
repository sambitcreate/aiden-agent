import assert from "node:assert/strict";
import test from "node:test";
import type { PeerRunEvent, PeerRunSubscription } from "../../shared/peer-host";
import type { LocalRunFrame, LocalRunFrameMessage } from "../../shared/local-run-frames";
import {
  captureDetachedLifecycleChat,
  clearInactiveDetachedLifecycleChat,
  detachedLifecycleChatProjection,
  detachedProjectionStreamComplete,
  isDetachedLifecycleChatDraining,
  rememberDetachedLifecycleStream,
  visibleDetachedLifecycleProjection,
} from "../chat-terminal-sync";
import type { ChatMessage } from "../types";
import { LocalHostAdapter, type LocalChatApis } from "./local-host-adapter";
import {
  createObservedRunLifecycle,
  observeLocalRun,
  OBSERVED_READ_RETRY_MS,
  type ObservedChatRead,
  type ObservedTranscriptMessage,
} from "./observed-local-run";

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

/**
 * The persisted chat and the pane's cached copy of it. Each read is held until
 * the test settles it, as a slow or cancelled IPC read would be.
 */
function chatReads() {
  const saved: ObservedTranscriptMessage[] = [{ role: "user" }];
  let cache: readonly ObservedTranscriptMessage[] = [];
  const pending: Array<(outcome: ObservedChatRead) => void> = [];
  let requested = 0;
  return {
    saved,
    cache: () => cache,
    requested: () => requested,
    count: () => pending.length,
    refetch: () => {
      requested++;
      return new Promise<ObservedChatRead>((resolve) => pending.push(resolve));
    },
    /** Lets every outstanding read finish with what is saved now. */
    finishAll: async () => {
      while (pending.length > 0) {
        cache = [...saved];
        pending.shift()!({ kind: "read", messages: cache });
        await tick();
      }
    },
    /** Lets the oldest outstanding read finish with what is saved now. */
    finishNext: async () => {
      cache = [...saved];
      pending.shift()!({ kind: "read", messages: cache });
      await tick();
    },
    /** A competing read cancelled the oldest outstanding one. */
    failNext: async () => {
      pending.shift()!({ kind: "failed" });
      await tick();
    },
  };
}

const reply = (runId: string): ObservedTranscriptMessage => ({ role: "assistant", timeline: { generationId: runId } });

const tick = () => new Promise((settle) => setImmediate(settle));

test("a phone's turn on this Mac streams into the open chat live and gives way to the saved reply", async () => {
  const chatId = "chat-phone-turn";
  const main = fakeMain({
    runId: "run-phone",
    chatId,
    state: "streaming",
    events: [runEvent("run-phone", 1, "run.started", { chatId, origin: "remote" }), runEvent("run-phone", 2, "text_delta", { text: "Hel" })],
  });
  const reads = chatReads();
  const observation = observeLocalRun({
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
  assert.equal(detachedProjectionStreamComplete(live), false, "a running reply is revealed as it streams");

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
  assert.equal(
    detachedProjectionStreamComplete(detachedLifecycleChatProjection(chatId, WORKSPACE)),
    true,
    "the ended run's text is final",
  );
  reads.saved.push(reply("run-phone"));
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

  observation.close();
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
  const reads = chatReads();
  const observation = observeLocalRun({ adapter: main.adapter, chatId, workspaceId: WORKSPACE, refetch: reads.refetch, schedule: (publish) => publish() });
  await tick();
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null);
  assert.equal(isDetachedLifecycleChatDraining(chatId, WORKSPACE), false);
  observation.close();
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
  const reads = chatReads();
  const observation = observeLocalRun({ adapter: main.adapter, chatId, workspaceId: WORKSPACE, refetch: reads.refetch, schedule: (publish) => publish() });
  await tick();
  await reads.finishAll();
  const projection = detachedLifecycleChatProjection(chatId, WORKSPACE);
  assert.equal(projection?.streamId, "run-gap", "Stop stays available");
  assert.equal(projection?.content, "");
  observation.close();
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
  const reads = chatReads();
  const observation = observeLocalRun({ adapter: main.adapter, chatId, workspaceId: WORKSPACE, refetch: reads.refetch, schedule: (publish) => publish() });
  await tick();
  await reads.finishAll();
  const projection = detachedLifecycleChatProjection(chatId, WORKSPACE);
  assert.equal(projection?.content, "Mine so far");
  assert.equal(projection?.observed, undefined);
  assert.equal(detachedProjectionStreamComplete(projection), true, "a returning route shows its run's text as written");
  observation.close();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Mine so far", "closing leaves the owner's projection");
  assert.equal(clearInactiveDetachedLifecycleChat(captureDetachedLifecycleChat(own)!, new Set()), true);
});

test("a phone's reply stays on screen when the chat goes idle before the run's end arrives", async () => {
  const chatId = "chat-idle-first";
  const target = { chatId, workspaceId: WORKSPACE };
  const main = fakeMain({
    runId: "run-idle",
    chatId,
    state: "streaming",
    events: [runEvent("run-idle", 1, "run.started", { chatId, origin: "remote" }), runEvent("run-idle", 2, "text_delta", { text: "All done" })],
  });
  const reads = chatReads();
  const lifecycle = createObservedRunLifecycle((observed) =>
    observeLocalRun({ adapter: main.adapter, ...observed, refetch: reads.refetch, schedule: (publish) => publish() }),
  );
  lifecycle.update({ target, active: true });
  await tick();
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "All done");

  // Main saves the reply, then reports the chat idle before the next frame batch carries the run's end.
  reads.saved.push(reply("run-idle"));
  lifecycle.update({ target, active: false });
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "All done", "no flash on idle");
  assert.equal(main.calls.some(([route]) => route === "unobserveRun"), false);

  main.send(
    { kind: "event", event: runEvent("run-idle", 3, "done") },
    { kind: "event", event: runEvent("run-idle", 4, "run.ended", { chatId, state: "done" }) },
    { kind: "state", runId: "run-idle", state: "ended" },
  );
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "All done", "kept until the reply is read");
  await reads.finishAll();
  assert.ok(reads.cache().some((message) => message.role === "assistant"), "the saved reply is in the cache");
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null);
  assert.deepEqual(main.calls[main.calls.length - 1], ["unobserveRun", "sub-1"], "then the observation ends");
  lifecycle.dispose();
});

test("leaving the chat or starting a turn in the pane stops the mirror at once", async () => {
  const chatId = "chat-leave";
  const main = fakeMain({
    runId: "run-leave",
    chatId,
    state: "streaming",
    events: [runEvent("run-leave", 1, "run.started", { chatId }), runEvent("run-leave", 2, "text_delta", { text: "Partial" })],
  });
  const reads = chatReads();
  let starts = 0;
  const lifecycle = createObservedRunLifecycle((observed) => {
    starts++;
    return observeLocalRun({ adapter: main.adapter, ...observed, refetch: reads.refetch, schedule: (publish) => publish() });
  });
  lifecycle.update({ target: { chatId, workspaceId: WORKSPACE }, active: true });
  await tick();
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Partial");

  // The pane starts its own turn: its own stream takes over the chat.
  lifecycle.update({ target: null, active: true });
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null);
  assert.deepEqual(main.calls[main.calls.length - 1], ["unobserveRun", "sub-1"]);

  // Another busy chat starts a fresh observation; an idle one starts nothing.
  lifecycle.update({ target: { chatId: "chat-other", workspaceId: WORKSPACE }, active: false });
  assert.equal(starts, 1);
  lifecycle.update({ target: { chatId: "chat-other", workspaceId: WORKSPACE }, active: true });
  assert.equal(starts, 2);
  lifecycle.dispose();
  await tick();
});

test("a finished run is replaced only by a read that holds its saved reply", async () => {
  const chatId = "chat-competing-read";
  const main = fakeMain({
    runId: "run-race",
    chatId,
    state: "streaming",
    events: [runEvent("run-race", 1, "run.started", { chatId }), runEvent("run-race", 2, "text_delta", { text: "Answer" })],
  });
  const reads = chatReads();
  const observation = observeLocalRun({
    adapter: main.adapter,
    chatId,
    workspaceId: WORKSPACE,
    refetch: reads.refetch,
    schedule: (publish) => publish(),
    delay: async () => {},
  });
  await tick();
  await reads.finishAll();
  main.send(
    { kind: "event", event: runEvent("run-race", 3, "done") },
    { kind: "state", runId: "run-race", state: "ended" },
  );
  // Another refresh of the same chat cancels this read.
  await reads.failNext();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Answer");
  // The retry lands before the reply was saved.
  await reads.finishNext();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Answer", "an older transcript is not the reply");
  reads.saved.push(reply("run-race"));
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null);
  assert.equal(reads.count(), 0, "no further reads once the reply is in");
  observation.close();
});

test("a failed read of a phone's new turn is retried until its message lands", async () => {
  const chatId = "chat-started-read";
  const main = fakeMain({
    runId: "run-start",
    chatId,
    state: "streaming",
    events: [runEvent("run-start", 1, "run.started", { chatId, origin: "remote" })],
  });
  const reads = chatReads();
  const observation = observeLocalRun({
    adapter: main.adapter,
    chatId,
    workspaceId: WORKSPACE,
    refetch: reads.refetch,
    schedule: (publish) => publish(),
    delay: async () => {},
  });
  await tick();
  // Every scheduled attempt fails: the first read and each retry.
  for (let attempt = 0; attempt <= OBSERVED_READ_RETRY_MS.length; attempt++) await reads.failNext();
  assert.equal(reads.count(), 0, "retries are bounded");
  assert.deepEqual(reads.cache(), []);

  // The next frame from the run asks again, and that read brings in the phone's message.
  main.send({ kind: "event", event: runEvent("run-start", 2, "text_delta", { text: "Hi" }) });
  assert.equal(reads.count(), 1);
  await reads.finishAll();
  assert.deepEqual(reads.cache(), [{ role: "user" }]);
  main.send({ kind: "event", event: runEvent("run-start", 3, "text_delta", { text: " there" }) });
  assert.equal(reads.count(), 0, "a completed read is not repeated");
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Hi there");
  observation.close();
});

test("a text-only reply without timeline is recognized as the run's saved reply", async () => {
  const chatId = "chat-text-only";
  const main = fakeMain({
    runId: "run-text-only",
    chatId,
    state: "streaming",
    events: [
      runEvent("run-text-only", 1, "run.started", { chatId, origin: "remote" }),
      runEvent("run-text-only", 2, "text_delta", { text: "Answer" }),
    ],
  });
  const reads = chatReads();
  const observation = observeLocalRun({
    adapter: main.adapter,
    chatId,
    workspaceId: WORKSPACE,
    refetch: reads.refetch,
    schedule: (publish) => publish(),
  });
  await tick();
  await reads.finishAll();
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "Answer");

  // Send the done event with messageId, which triggers a refetch.
  main.send({ kind: "event", event: runEvent("run-text-only", 3, "done", { messageId: "msg-text-only" }) });
  await tick();
  // A refetch is requested, but the reply is not in the cache yet, so it will retry.
  assert.equal(reads.count() > 0, true, "refetch is requested after done event");

  // Add the text-only reply without timeline but with matching messageId to the saved transcript.
  reads.saved.push({ role: "assistant", id: "msg-text-only" });
  await reads.finishAll();
  // The projection should be cleared because the text-only saved reply should be recognized as the run's reply via doneMessageId match.
  assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE), null, "text-only reply is recognized as the run's saved reply");
  assert.equal(isDetachedLifecycleChatDraining(chatId, WORKSPACE), false);

  main.send(
    { kind: "event", event: runEvent("run-text-only", 4, "run.ended", { chatId, state: "done" }) },
    { kind: "state", runId: "run-text-only", state: "ended" },
  );
  observation.close();
});

test("a phone's text-only reply cached by another read replaces the mirror at once", async () => {
  const chatId = "chat-text-only-cached";
  const main = fakeMain({
    runId: "run-text-cached",
    chatId,
    state: "streaming",
    events: [
      runEvent("run-text-cached", 1, "run.started", { chatId, origin: "remote" }),
      runEvent("run-text-cached", 2, "text_delta", { text: "Answer" }),
    ],
  });
  const reads = chatReads();
  const observation = observeLocalRun({
    adapter: main.adapter,
    chatId,
    workspaceId: WORKSPACE,
    refetch: reads.refetch,
    schedule: (publish) => publish(),
  });
  await tick();
  await reads.finishAll();
  const prompt: ChatMessage = { id: "prompt", role: "user", content: "Hi", createdAt: 1 };
  const previous: ChatMessage = { id: "msg-previous", role: "assistant", content: "Earlier", createdAt: 0 };
  const saved: ChatMessage = { id: "msg-text-cached", role: "assistant", content: "Answer", createdAt: 2 };
  const shown = (cache: readonly ChatMessage[]) =>
    visibleDetachedLifecycleProjection(detachedLifecycleChatProjection(chatId, WORKSPACE), cache);
  assert.equal(shown([previous, prompt])?.content, "Answer", "the live reply shows under its prompt");

  main.send({ kind: "event", event: runEvent("run-text-cached", 3, "done", { messageId: saved.id }) });
  await tick();
  // The chat's settle notice re-read the transcript before the observer's own read returned.
  assert.equal(shown([previous, prompt, saved]), null, "the saved reply is not shown twice");
  assert.equal(shown([prompt, previous])?.content, "Answer", "an earlier text-only reply does not hide it");

  await reads.finishAll();
  observation.close();
});

test("a retained observer survives an obsolete idle-release read", async () => {
  const chatId = "chat-release-race";
  const target = { chatId, workspaceId: WORKSPACE };
  const main = fakeMain({
    runId: "run-release-race",
    chatId,
    state: "streaming",
    events: [runEvent("run-release-race", 1, "run.started", { chatId, origin: "remote" }), runEvent("run-release-race", 2, "text_delta", { text: "Initial" })],
  });
  const reads = chatReads();
  const graceTimers: Array<() => void> = [];
  const lifecycle = createObservedRunLifecycle((observed) =>
    observeLocalRun({
      adapter: main.adapter,
      ...observed,
      refetch: reads.refetch,
      schedule: (publish) => publish(),
      delay: async () => {},
    }),
  );

  // Patch setTimeout for grace period detection
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = ((callback: () => void, ms: number) => {
    if (ms === 5000) graceTimers.push(callback);
    return originalSetTimeout(callback, ms);
  }) as typeof setTimeout;

  try {
    lifecycle.update({ target, active: true });
    await tick();
    await reads.finishAll();

    // Report the chat idle. A grace-period read will be scheduled.
    lifecycle.update({ target, active: false });
    await tick();
    assert.equal(graceTimers.length > 0, true, "grace-period timer is scheduled");

    // Before the grace read fires, report the chat active again (retain).
    lifecycle.update({ target, active: true });

    // Start a new turn on the phone.
    main.send(
      { kind: "state", runId: "run-next", state: "streaming" },
      { kind: "event", event: runEvent("run-next", 1, "run.started", { chatId, origin: "remote" }) },
      { kind: "event", event: runEvent("run-next", 2, "text_delta", { text: "New answer" }) },
    );
    await tick();
    await reads.finishAll();
    assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "New answer", "new run is shown");
    assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.streamId, "run-next");

    // Now fire the grace read from the old run. Without the fix, it would close the observer,
    // clearing the newer run's projection and blocking follow-up sends.
    // After the fix, the observer stays open because the release authority was revoked.
    for (const callback of graceTimers) callback();
    await tick();
    assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.content, "New answer", "new run projection survives the obsolete grace read");
    assert.equal(detachedLifecycleChatProjection(chatId, WORKSPACE)?.streamId, "run-next");

    lifecycle.dispose();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
