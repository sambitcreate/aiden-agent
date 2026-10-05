import assert from "node:assert/strict";
import test from "node:test";
import {
  PEER_LIVE_RUNS_PER_HOST,
  PEER_LIVE_STREAMS_TOTAL,
  PEER_RUN_BUFFER_EVENTS,
  PEER_RUN_EVICT_MS,
  PeerRunLimitError,
  PeerRunStream,
  PeerRunSubscriptions,
  peerRunTarget,
} from "./peer-run-subscriptions.js";
import type { PeerRunEvent } from "../../renderer/shared/peer-host.js";
import { applyRemoteRunSubscription, initialRemoteRunView } from "../../renderer/lib/hosts/remote-stream-translator.js";

class FakeTimers {
  now = 0;
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
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.now || !this.pending.has(id)) continue;
      this.pending.delete(id);
      timer.callback();
    }
  }
  get size(): number {
    return this.pending.size;
  }
}

function setup(feeds = 0) {
  const timers = new FakeTimers();
  const dropped: string[] = [];
  const subscriptions = new PeerRunSubscriptions({
    timers,
    onDrop: (stream) => dropped.push(`${stream.hostId}/${stream.key}`),
    feeds: () => feeds,
  });
  return { timers, dropped, subscriptions };
}

function event(runId: string, sequence: number, type = "message.delta", payload: Record<string, unknown> = {}): PeerRunEvent {
  return {
    protocolVersion: 1,
    streamId: runId,
    sequence,
    timestamp: new Date(sequence).toISOString(),
    type,
    terminal: type === "run.ended",
    payload: { chatId: "chat-1", ...payload },
  };
}

test("windows share one stream that closes five minutes after its last viewer leaves", () => {
  const { timers, dropped, subscriptions } = setup();
  const first = subscriptions.acquire("host-a", { runId: "run-1" }, "window-1", 0);
  const second = subscriptions.acquire("host-a", { runId: "run-1" }, "window-2", 0);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.stream, second.stream);
  assert.notEqual(first.subscriptionId, second.subscriptionId);

  assert.equal(subscriptions.release(first.subscriptionId, "window-1"), true);
  assert.equal(timers.size, 0, "a remaining viewer keeps the stream open");
  assert.equal(subscriptions.release(second.subscriptionId, "window-2"), true);
  timers.advance(PEER_RUN_EVICT_MS - 1);
  assert.equal(subscriptions.size, 1, "the stream lingers for a returning viewer");

  // A viewer returning inside the grace period cancels the eviction.
  const returning = subscriptions.acquire("host-a", { runId: "run-1" }, "window-1", 0);
  assert.equal(returning.created, false);
  timers.advance(PEER_RUN_EVICT_MS * 2);
  assert.deepEqual(dropped, []);

  subscriptions.release(returning.subscriptionId, "window-1");
  timers.advance(PEER_RUN_EVICT_MS);
  assert.deepEqual(dropped, ["host-a/run:run-1"]);
  assert.equal(subscriptions.size, 0);
  // The same run id on a different host is an unrelated stream.
  const other = subscriptions.acquire("host-b", { runId: "run-1" }, "window-1", 0);
  assert.equal(other.created, true);
});

test("only the owning document releases a subscription and a closed document releases all of its own", () => {
  const { timers, dropped, subscriptions } = setup();
  const mine = subscriptions.acquire("host-a", { chatId: "chat-1" }, "window-1", 0);
  const also = subscriptions.acquire("host-a", { runId: "run-9" }, "window-1", 0);
  const theirs = subscriptions.acquire("host-a", { chatId: "chat-1" }, "window-2", 0);
  assert.equal(subscriptions.release(mine.subscriptionId, "window-2"), false);
  assert.equal(subscriptions.release("not-a-subscription", "window-1"), false);

  subscriptions.releaseOwner("window-1");
  timers.advance(PEER_RUN_EVICT_MS);
  assert.deepEqual(dropped, ["host-a/run:run-9"], "the chat stream still has window-2");
  assert.equal(subscriptions.release(also.subscriptionId, "window-1"), false, "already released");
  assert.equal(subscriptions.release(theirs.subscriptionId, "window-2"), true);
});

test("live streams are capped per host and overall, closing idle streams before refusing", () => {
  const { subscriptions, dropped } = setup(3);
  const held = Array.from({ length: PEER_LIVE_RUNS_PER_HOST }, (_, index) =>
    subscriptions.acquire("host-a", { runId: `run-${index}` }, "window-1", 0),
  );
  assert.throws(
    () => subscriptions.acquire("host-a", { runId: "run-extra" }, "window-1", 0),
    PeerRunLimitError,
  );
  // Another host has its own allowance.
  subscriptions.acquire("host-b", { runId: "run-0" }, "window-1", 0);

  // An idle stream awaiting eviction yields its slot.
  subscriptions.release(held[4]!.subscriptionId, "window-1");
  subscriptions.acquire("host-a", { runId: "run-extra" }, "window-1", 0);
  assert.deepEqual(dropped, ["host-a/run:run-4"]);
  assert.equal(subscriptions.forHost("host-a").length, PEER_LIVE_RUNS_PER_HOST);

  // Three feeds plus live runs share the global budget.
  const hosts = ["host-c", "host-d", "host-e"];
  let opened = subscriptions.size;
  for (const hostId of hosts)
    for (let index = 0; index < PEER_LIVE_RUNS_PER_HOST && opened + 3 < PEER_LIVE_STREAMS_TOTAL; index += 1) {
      subscriptions.acquire(hostId, { runId: `run-${index}` }, "window-1", 0);
      opened += 1;
    }
  assert.equal(subscriptions.size + 3, PEER_LIVE_STREAMS_TOTAL);
  assert.throws(
    () => subscriptions.acquire("host-f", { runId: "run-0" }, "window-1", 0),
    PeerRunLimitError,
  );
});

test("reconnect replays are deduplicated while run.ended is delivered once at its repeated sequence", () => {
  const stream = new PeerRunStream("host-a", "run:run-1", { runId: "run-1" }, 0);
  const accepted = [1, 2, 3, 2, 3, 4].map((sequence) => stream.accept(event("run-1", sequence)));
  assert.deepEqual(accepted, [true, true, true, false, false, true]);
  assert.equal(stream.accept(event("run-1", 5, "run.completed")), true);
  assert.equal(stream.accept(event("run-1", 5, "run.ended")), true, "terminal repeat is not a duplicate");
  assert.equal(stream.accept(event("run-1", 5, "run.ended")), false);
  assert.equal(stream.accept(event("other-run", 6)), false, "a foreign stream id is ignored");
  assert.equal(stream.ended, true);

  // A viewer that already saw the terminal event at 5 still receives run.ended.
  const late = stream.view("sub", 5);
  assert.deepEqual(late.events.map((item) => item.type), ["run.ended"]);
  assert.deepEqual(stream.view("sub", 2).events.map((item) => item.sequence), [3, 4, 5, 5]);
  assert.equal(stream.view("sub", 0).truncated, false);
});

test("a chat target adopts its run without discarding the caller's cursor and restarts on a newer run", () => {
  const stream = new PeerRunStream("host-a", "chat:chat-1", peerRunTarget({ chatId: "chat-1" }), 7);
  assert.equal(stream.runId, null);
  assert.equal(stream.accept(event("run-1", 7)), false, "already seen by the caller");
  assert.equal(stream.runId, "run-1");
  assert.equal(stream.accept(event("run-1", 8)), true);
  assert.deepEqual(stream.view("sub", 7).events.map((item) => item.sequence), [8]);

  stream.switchRun("run-2");
  assert.equal(stream.cursor, 0);
  assert.equal(stream.accept(event("run-1", 9)), false, "the previous run's tail is ignored");
  assert.equal(stream.accept(event("run-2", 1)), true);
  assert.deepEqual(stream.view("sub", 0).events.map((item) => [item.streamId, item.sequence]), [["run-2", 1]]);
});

test("a gap snapshot or a full buffer tells viewers behind it that history was truncated", () => {
  const stream = new PeerRunStream("host-a", "run:run-1", { runId: "run-1" }, 0);
  stream.accept(event("run-1", 1));
  stream.accept(event("run-1", 2));
  assert.equal(stream.accept(event("run-1", 40, "snapshot", { reason: "gap", nextSequence: 41 })), true);
  const behind = stream.view("sub", 2);
  assert.equal(behind.truncated, true);
  assert.deepEqual(behind.events.map((item) => item.type), ["snapshot"]);
  assert.equal(stream.view("sub", 39).truncated, false);

  for (let sequence = 41; sequence <= 41 + PEER_RUN_BUFFER_EVENTS; sequence += 1)
    stream.accept(event("run-1", sequence));
  const recent = stream.view("sub", 39);
  assert.equal(recent.truncated, true);
  // The buffer stays bounded; a summary of what was dropped leads it.
  assert.equal(recent.events.length, PEER_RUN_BUFFER_EVENTS + 1);
  assert.equal(recent.events[0]!.type, "snapshot");
  assert.equal(stream.view("sub", recent.events[1]!.sequence - 1).truncated, false);
});

const approval = { approvalId: "ap-1", summary: "Run the release script", toolCallId: "call-1", toolName: "run_shell" };
const question = {
  promptId: "q-1",
  toolCallId: "call-2",
  questions: [
    {
      question: "Which branch should I tag?",
      header: "Branch",
      multiSelect: false,
      options: [
        { label: "main", description: "The default branch" },
        { label: "release", description: "The release branch" },
      ],
    },
  ],
};

/** A stream whose buffer has dropped the given events behind a full run of deltas. */
function overflowed(head: PeerRunEvent[], tail: PeerRunEvent[] = []) {
  const stream = new PeerRunStream("host-a", "run:run-1", { runId: "run-1" }, 0);
  let sequence = 0;
  const next = () => (sequence += 1);
  stream.accept(event("run-1", next(), "run.started", { runId: "run-1" }));
  for (const item of head) stream.accept({ ...item, sequence: next() });
  for (let count = 0; count < PEER_RUN_BUFFER_EVENTS + 50; count += 1)
    stream.accept(event("run-1", next(), "message.delta", { text: "x" }));
  for (const item of tail) stream.accept({ ...item, sequence: next() });
  return stream;
}

/** What a viewer joining the stream from its start ends up showing. */
function joined(stream: PeerRunStream) {
  const subscription = stream.view("late", 0);
  return { subscription, view: applyRemoteRunSubscription(initialRemoteRunView(null, "chat-1"), subscription) };
}

test("a viewer joining after the buffer dropped an approval or question still sees it pending", () => {
  const { subscription, view } = joined(
    overflowed([event("run-1", 0, "approval_required", approval), event("run-1", 0, "question_required", question)]),
  );
  assert.equal(subscription.truncated, true);
  assert.ok(subscription.events.length <= PEER_RUN_BUFFER_EVENTS + 1, "retention stays bounded");
  assert.deepEqual(view.view.approvals.map((entry) => entry.approvalId), ["ap-1"]);
  assert.deepEqual(view.view.questions.map((entry) => entry.promptId), ["q-1"]);
  assert.equal(view.view.status, "running");
  // The lost text is read back from the host.
  assert.equal(view.refetch, true);
});

test("a dropped prompt that was later resolved, or a run that settled, leaves nothing pending", () => {
  const resolvedInDropped = joined(
    overflowed([
      event("run-1", 0, "approval_required", approval),
      event("run-1", 0, "question_required", question),
      event("run-1", 0, "approval_resolved", { approvalId: "ap-1" }),
    ]),
  );
  assert.deepEqual(resolvedInDropped.view.view.approvals, []);
  assert.deepEqual(resolvedInDropped.view.view.questions.map((entry) => entry.promptId), ["q-1"]);

  const resolvedAfter = joined(
    overflowed([event("run-1", 0, "question_required", question)], [event("run-1", 0, "question_resolved", { promptId: "q-1" })]),
  );
  assert.deepEqual(resolvedAfter.view.view.questions, []);

  const settled = joined(
    overflowed(
      [event("run-1", 0, "approval_required", approval)],
      [{ ...event("run-1", 0, "done", { messageId: "m-1" }), terminal: true }, event("run-1", 0, "run.ended", { state: "done" })],
    ),
  );
  assert.deepEqual(settled.view.view.approvals, []);
  assert.equal(settled.view.view.ended, true);
});

test("a viewer that saw a prompt before resubscribing drops it once the resolution was evicted", () => {
  const stream = new PeerRunStream("host-a", "run:run-1", { runId: "run-1" }, 0);
  stream.accept(event("run-1", 1, "run.started", { runId: "run-1" }));
  stream.accept(event("run-1", 2, "approval_required", approval));
  const before = applyRemoteRunSubscription(initialRemoteRunView(null, "chat-1"), stream.view("sub", 0)).view;
  assert.deepEqual(before.approvals.map((entry) => entry.approvalId), ["ap-1"]);

  stream.accept(event("run-1", 3, "approval_resolved", { approvalId: "ap-1" }));
  for (let sequence = 4; sequence < 4 + PEER_RUN_BUFFER_EVENTS + 10; sequence += 1)
    stream.accept(event("run-1", sequence, "message.delta", { text: "x" }));
  const after = applyRemoteRunSubscription(before, stream.view("sub", 2)).view;
  assert.deepEqual(after.approvals, []);
  assert.equal(after.status, "running");
});

test("renderer run targets name exactly one valid chat or run id", () => {
  assert.deepEqual(peerRunTarget({ runId: "run-1" }), { runId: "run-1" });
  for (const value of [null, [], {}, { runId: "run-1", chatId: "chat-1" }, { runId: "../x" }, { chatId: 4 }, { hostId: "h" }])
    assert.throws(() => peerRunTarget(value), /Invalid run target/);
});
