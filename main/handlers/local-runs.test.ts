import assert from "node:assert/strict";
import test from "node:test";
import type { LocalRunFrameMessage } from "../../renderer/shared/local-run-frames.js";
import type { PeerRunSubscription } from "../../renderer/shared/peer-host.js";
import { HostRunRegistry } from "../services/host-run-registry.js";
import { LOCAL_RUN_BATCH_MS, LocalRunObservers } from "../services/local-run-observers.js";
import { registerLocalRunHandlers, type LocalRunOwner } from "./local-runs.js";
import { LocalHostAdapter } from "../../renderer/lib/hosts/local-host-adapter.js";
import { observeLocalRun } from "../../renderer/lib/hosts/observed-local-run.js";
import {
  detachedLifecycleChatProjection,
  isDetachedLifecycleChatDraining,
} from "../../renderer/lib/chat-terminal-sync.js";

class FakeTimers {
  private now = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  };
  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  get size(): number {
    return this.pending.size;
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.now || !this.pending.has(id)) continue;
      this.pending.delete(id);
      timer.callback();
    }
  }
}

/** One renderer main-frame document; `navigate` invalidates it like a reload. */
class FakeDocument implements LocalRunOwner {
  readonly messages: LocalRunFrameMessage[] = [];
  /** The document's preload notification listener, when a test wires one. */
  deliver: ((payload: LocalRunFrameMessage) => void) | null = null;
  private destroyed = false;
  private readonly listeners = new Set<() => void>();
  constructor(readonly key: string) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, payload: LocalRunFrameMessage): void {
    assert.equal(channel, "runs:local-frame");
    if (this.destroyed) throw new Error("Render frame was disposed.");
    this.messages.push(structuredClone(payload));
    this.deliver?.(structuredClone(payload));
  }
  onInvalidated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  navigate(): void {
    this.destroyed = true;
    for (const listener of [...this.listeners]) {
      this.listeners.delete(listener);
      listener();
    }
  }
  /** Every frame received so far, flattened to `type@sequence` or `state:<state>`. */
  frames(): string[] {
    return this.messages.flatMap((message) =>
      message.frames.map((frame) =>
        frame.kind === "event" ? `${frame.event.type}@${frame.event.sequence}` : `state:${frame.state}`,
      ),
    );
  }
}

type FakeEvent = { document: FakeDocument | null };

function setup() {
  const clock = { now: 1_000 };
  const registry = new HostRunRegistry({ now: () => clock.now, epoch: "epoch-local", deltaCoalesceMs: 0 });
  const timers = new FakeTimers();
  let ids = 0;
  const observers = new LocalRunObservers({
    registry,
    setTimer: timers.set,
    clearTimer: timers.clear,
    newId: () => `local-run-${++ids}`,
  });
  const stops: string[] = [];
  const live = new Set<string>();
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  registerLocalRunHandlers<FakeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => {
      if (!event.document) throw new Error("Run actions require an active application document.");
      return event.document;
    },
    observers: () => observers,
    stopRun: (runId) => {
      const summary = registry.summary(runId);
      if (!summary || summary.state === "done" || summary.state === "failed" || summary.state === "cancelled") {
        return false;
      }
      stops.push(runId);
      registry.publish(runId, "chat:done", { cancelled: true });
      return true;
    },
    isRunSettled: (runId) => {
      const state = registry.summary(runId)?.state;
      return (state === "done" || state === "failed" || state === "cancelled") && !live.has(runId);
    },
  });
  const invoke = async (channel: string, from: FakeDocument | null, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, channel);
    return handler({ document: from }, ...args);
  };
  const observe = (from: FakeDocument, chatId: string, cursor?: unknown) =>
    invoke("runs:observeLocal", from, chatId, cursor) as Promise<PeerRunSubscription>;
  const frame = () => timers.advance(LOCAL_RUN_BATCH_MS);
  return { clock, registry, timers, observers, stops, live, invoke, observe, frame };
}

const eventKeys = (subscription: PeerRunSubscription) =>
  subscription.events.map((event) => `${event.type}@${event.sequence}`);

test("a phone-started run reaches the watching window live, one batch per frame, and ends with run.ended", async () => {
  const { registry, observe, frame, timers } = setup();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "remote" });
  registry.publish("run-1", "chat:delta", { delta: "Hel" });

  const page = new FakeDocument("1:doc-a");
  const subscription = await observe(page, "chat-1");
  assert.equal(subscription.runId, "run-1");
  assert.equal(subscription.state, "streaming");
  assert.deepEqual(eventKeys(subscription), ["run.started@1", "text_delta@2"]);
  assert.deepEqual(subscription.events[0]!.payload, { runId: "run-1", chatId: "chat-1", origin: "remote" });

  registry.publish("run-1", "chat:delta", { delta: "lo" });
  registry.publish("run-1", "chat:delta", { delta: " there" });
  assert.equal(page.messages.length, 0, "nothing is sent before the frame boundary");
  frame();
  assert.equal(page.messages.length, 1, "deltas within one frame share one message");
  assert.equal(page.messages[0]!.subscriptionId, subscription.subscriptionId);
  assert.deepEqual(page.frames(), ["text_delta@3", "text_delta@4"]);
  assert.deepEqual(
    page.messages[0]!.frames.map((entry) => (entry.kind === "event" ? entry.event.payload : null)),
    [{ text: "lo" }, { text: " there" }],
  );

  registry.publish("run-1", "chat:done", { chat: { messages: [{ id: "assistant-1", role: "assistant" }] } });
  frame();
  assert.deepEqual(page.frames().slice(2), ["done@5", "run.ended@5", "state:ended"]);
  const ended = page.messages[1]!.frames[1]!;
  assert.ok(ended.kind === "event");
  assert.deepEqual(ended.event.payload, { runId: "run-1", chatId: "chat-1", state: "done" });
  assert.equal(timers.size, 0, "an ended run leaves no timer behind");
});

test("a window watching one chat never receives another chat's frames", async () => {
  const { registry, observe, frame } = setup();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "remote" });
  registry.begin({ runId: "run-2", chatId: "chat-2", origin: "remote" });
  const page = new FakeDocument("1:doc-a");
  const other = new FakeDocument("2:doc-b");
  await observe(page, "chat-1");
  await observe(other, "chat-2");

  registry.publish("run-2", "chat:delta", { delta: "for chat two" });
  registry.publish("run-1", "chat:delta", { delta: "for chat one" });
  frame();

  assert.deepEqual(page.messages.map((message) => message.chatId), ["chat-1"]);
  assert.deepEqual(page.frames(), ["text_delta@2"]);
  assert.deepEqual(other.messages.map((message) => message.chatId), ["chat-2"]);
  assert.deepEqual(other.frames(), ["text_delta@2"]);
});

test("a cursor resumes after the last delivered event and is ignored once the chat moved on", async () => {
  const { clock, registry, observe } = setup();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "remote" });
  for (const delta of ["a", "b", "c"]) registry.publish("run-1", "chat:delta", { delta });
  const page = new FakeDocument("1:doc-a");

  const resumed = await observe(page, "chat-1", { runId: "run-1", sequence: 2 });
  assert.deepEqual(eventKeys(resumed), ["text_delta@3", "text_delta@4"]);

  // A cursor at the end of a finished run still yields the closing run.ended.
  registry.publish("run-1", "chat:done", {});
  const caughtUp = await observe(page, "chat-1", { runId: "run-1", sequence: 5 });
  assert.deepEqual(eventKeys(caughtUp), ["run.ended@5"]);
  assert.equal(caughtUp.state, "ended");

  // Without a cursor, a finished run is already in the persisted transcript.
  const late = await observe(page, "chat-1");
  assert.deepEqual(late.events, []);
  assert.equal(late.state, "ended");

  clock.now += 1_000;
  registry.begin({ runId: "run-2", chatId: "chat-1", origin: "remote" });
  const moved = await observe(page, "chat-1", { runId: "run-1", sequence: 5 });
  assert.equal(moved.runId, "run-2");
  assert.deepEqual(eventKeys(moved), ["run.started@1"], "another run's cursor replays the new run whole");

  const idle = await observe(page, "chat-idle");
  assert.equal(idle.runId, null);
  assert.equal(idle.state, "idle");
});

test("a parked observation picks up the chat's next run", async () => {
  const { clock, registry, observe, frame } = setup();
  const page = new FakeDocument("1:doc-a");
  const subscription = await observe(page, "chat-1");
  assert.equal(subscription.state, "idle");

  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "remote" });
  registry.publish("run-1", "chat:delta", { delta: "hi" });
  frame();
  assert.deepEqual(page.frames(), ["state:streaming", "run.started@1", "text_delta@2"]);
  const adopted = page.messages[0]!.frames[0]!;
  assert.ok(adopted.kind === "state");
  assert.equal(adopted.runId, "run-1");

  registry.publish("run-1", "chat:done", {});
  frame();
  clock.now += 1_000;
  registry.begin({ runId: "run-2", chatId: "chat-1", origin: "remote" });
  frame();
  assert.deepEqual(page.frames().slice(3), [
    "done@3",
    "run.ended@3",
    "state:ended",
    "state:streaming",
    "run.started@1",
  ]);
});

test("a document that goes away releases its observations and receives nothing more", async () => {
  const { registry, observers, observe, invoke, frame, timers } = setup();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "remote" });
  const page = new FakeDocument("1:doc-a");
  const second = new FakeDocument("2:doc-b");
  const mine = await observe(page, "chat-1");
  await observe(page, "chat-1");
  const theirs = await observe(second, "chat-1");
  assert.equal(observers.size, 3);

  assert.equal(
    await invoke("runs:unobserveLocal", second, mine.subscriptionId),
    false,
    "a window cannot release another window's observation",
  );

  registry.publish("run-1", "chat:delta", { delta: "pending" });
  page.navigate();
  assert.equal(observers.size, 1, "navigation releases every observation of that document");
  frame();
  assert.equal(page.messages.length, 0, "a released observation's queued batch is dropped");
  assert.equal(second.messages.length, 1);

  // The reloaded document (same frame) cannot release the old observation again.
  assert.equal(await invoke("runs:unobserveLocal", new FakeDocument("1:doc-a"), mine.subscriptionId), false);

  assert.equal(await invoke("runs:unobserveLocal", second, theirs.subscriptionId), true);
  assert.equal(observers.size, 0);
  registry.publish("run-1", "chat:delta", { delta: "nobody watching" });
  assert.equal(timers.size, 0, "with nobody watching, a delta schedules nothing");
});

test("a document destroyed without navigation is released at its next flush", async () => {
  const { registry, observers, observe, frame } = setup();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "remote" });
  const page = new FakeDocument("1:doc-a");
  await observe(page, "chat-1");
  // Destroyed without its invalidation firing first (a crashed renderer).
  (page as unknown as { destroyed: boolean }).destroyed = true;
  registry.publish("run-1", "chat:delta", { delta: "x" });
  frame();
  assert.equal(page.messages.length, 0);
  assert.equal(observers.size, 0);
});

test("only an active document with well-formed input can observe or stop a run", async () => {
  const { registry, invoke, stops } = setup();
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "remote" });
  const page = new FakeDocument("1:doc-a");

  await assert.rejects(invoke("runs:observeLocal", null, "chat-1"), /active application document/u);
  await assert.rejects(invoke("runs:observeLocal", page, "../chat"), /Invalid chat identifier/u);
  await assert.rejects(invoke("runs:observeLocal", page, "chat-1", { runId: "run-1", sequence: -1 }), /Invalid run cursor/u);
  await assert.rejects(invoke("runs:observeLocal", page, "chat-1", "run-1"), /Invalid run cursor/u);
  await assert.rejects(invoke("runs:stopLocal", page, 42), /Invalid run identifier/u);

  assert.equal(await invoke("runs:stopLocal", page, "run-1"), true);
  assert.deepEqual(stops, ["run-1"]);
  assert.equal(registry.summary("run-1")?.state, "cancelled");
  assert.equal(await invoke("runs:stopLocal", page, "run-1"), false, "a finished run cannot be stopped again");
  assert.equal(await invoke("runs:stopLocal", page, "run-unknown"), false);

  page.navigate();
  await assert.rejects(invoke("runs:stopLocal", page, "run-1"), /application document changed/u);
  await assert.rejects(invoke("runs:observeLocal", page, "chat-1"), /application document changed/u);
});

test("a settled query names only runs that finished and that nothing still runs", async () => {
  const { clock, registry, invoke, live } = setup();
  const page = new FakeDocument("1:doc-a");
  registry.begin({ runId: "run-old", chatId: "chat-1", origin: "renderer" });
  registry.publish("run-old", "chat:done", {});
  clock.now += 1_000;
  registry.begin({ runId: "run-phone", chatId: "chat-1", origin: "remote" });
  registry.begin({ runId: "run-saving", chatId: "chat-2", origin: "renderer" });
  registry.publish("run-saving", "chat:done", {});
  live.add("run-saving");

  assert.deepEqual(
    await invoke("runs:settledLocal", page, ["run-old", "run-phone", "run-saving", "run-unknown", "run-old"]),
    ["run-old"],
    "the busy chat's newer run does not hold back the finished one; a run still persisting or unknown is not settled",
  );
  await assert.rejects(invoke("runs:settledLocal", page, "run-old"), /Invalid run identifiers/u);
  await assert.rejects(invoke("runs:settledLocal", page, ["../x"]), /Invalid run identifier/u);
  await assert.rejects(invoke("runs:settledLocal", page, Array.from({ length: 65 }, (_, i) => `run-${i}`)), /Invalid run identifiers/u);
  page.navigate();
  await assert.rejects(invoke("runs:settledLocal", page, ["run-old"]), /application document changed/u);
});

test("the watching window shows a phone's reply as it streams, stops it, and lets the saved reply replace it", async () => {
  const { registry, invoke, frame, timers, observers } = setup();
  const page = new FakeDocument("1:doc-a");
  const listeners = new Set<(message: LocalRunFrameMessage) => void>();
  page.deliver = (message) => {
    for (const listener of listeners) listener(message);
  };
  // The renderer side exactly as the pane uses it, over this process's IPC handlers.
  const adapter = new LocalHostAdapter({
    rename: async () => {},
    remove: async () => {},
    markRead: async () => true,
    approve: async () => {},
    answerQuestionnaire: async () => ({ status: "expired" }),
    respondRemoteApproval: async () => ({ resolved: true }),
    respondRemoteQuestion: async () => ({ status: "answered" }),
    admitRunInput: async () => ({ admitted: false, committed: false, reason: "run_not_active" }),
    // This window did not start the phone's run, so its own Stop declines it.
    stop: async () => false,
    observeRun: (chatId) => invoke("runs:observeLocal", page, chatId, null) as Promise<PeerRunSubscription>,
    unobserveRun: (id) => invoke("runs:unobserveLocal", page, id) as Promise<boolean>,
    onRunFrame: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    stopHostRun: (runId) => invoke("runs:stopLocal", page, runId) as Promise<boolean>,
  });
  let reads = 0;
  let settledReads = 0;
  const chatId = "chat-phone";
  const observation = observeLocalRun({
    adapter,
    chatId,
    workspaceId: "workspace-1",
    refetch: async () => {
      reads++;
      const state = registry.summary("run-phone")?.state;
      if (state !== "cancelled" && state !== "done") return { kind: "read", messages: [{ role: "user" }] };
      settledReads++;
      // The stopped reply was saved before the run settled.
      return { kind: "read", messages: [{ role: "user" }, { role: "assistant", timeline: { generationId: "run-phone" } }] };
    },
    schedule: (publish) => publish(),
  });
  await new Promise((settle) => setImmediate(settle));
  assert.equal(detachedLifecycleChatProjection(chatId, "workspace-1"), null, "nothing runs yet");

  registry.begin({ runId: "run-phone", chatId, origin: "remote" });
  registry.publish("run-phone", "chat:delta", { delta: "Drafting " });
  frame();
  registry.publish("run-phone", "chat:reasoning-delta", { delta: "Weighing options" });
  registry.publish("run-phone", "chat:delta", { delta: "the summary" });
  frame();
  await new Promise((settle) => setImmediate(settle));
  const live = detachedLifecycleChatProjection(chatId, "workspace-1");
  assert.equal(live?.content, "Drafting the summary", "the reply is on screen before the run settles");
  assert.equal(live?.reasoning, "Weighing options");
  assert.equal(registry.summary("run-phone")?.state, "working", "the run is still going");
  assert.equal(reads, 1, "the phone's saved message is read once when its run starts");

  assert.equal(await adapter.cancel(chatId, { runId: "run-phone" }), true);
  frame();
  await new Promise((settle) => setImmediate(settle));
  assert.equal(registry.summary("run-phone")?.state, "cancelled");
  assert.equal(settledReads, 1, "the finished turn is re-read once");
  assert.equal(detachedLifecycleChatProjection(chatId, "workspace-1"), null);
  assert.equal(isDetachedLifecycleChatDraining(chatId, "workspace-1"), false);

  observation.close();
  await new Promise((settle) => setImmediate(settle));
  assert.equal(observers.size, 0, "closing the pane releases its observation in main");
  assert.equal(timers.size, 0);
});
