import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_QUEUE_FENCE_STALL_MS,
  remoteQueueFence,
  remoteQueueFenceHolds,
  sendFencedTurn,
  setRemoteQueueFence,
  type RemoteQueueFenceView,
} from "./remote-queue-fence";

const fence = { runId: "run-b", since: 1_000 };
const view = (patch: Partial<RemoteQueueFenceView> = {}): RemoteQueueFenceView => ({
  run: null,
  hostRunState: undefined,
  now: 2_000,
  ...patch,
});

test("an accepted turn whose run this Mac hasn't seen settle still holds the queue", () => {
  // A freshly opened pane: no run observed, nothing in the feed about this run yet.
  assert.equal(remoteQueueFenceHolds(fence, view()), true);
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: null, ended: false } })), true);
  // The previous run ending, however late its news arrives, says nothing about this one.
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: "run-a", ended: true } })), true);
  // Saved its reply but still working on the host.
  assert.equal(remoteQueueFenceHolds(fence, view({ hostRunState: "working" })), true);
  assert.equal(remoteQueueFenceHolds(fence, view({ hostRunState: "needs_approval" })), true);
});

test("the fence lifts on news about that very run settling", () => {
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: "run-b", ended: false } })), true);
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: "run-b", ended: true } })), false);
  // Reopened after it ended: the feed's run state names it.
  for (const state of ["done", "failed", "cancelled"]) {
    assert.equal(remoteQueueFenceHolds(fence, view({ hostRunState: state })), false, state);
  }
});

test("a run never heard from stops holding the queue after the stall window", () => {
  assert.equal(remoteQueueFenceHolds(fence, view({ now: fence.since + REMOTE_QUEUE_FENCE_STALL_MS - 1 })), true);
  assert.equal(remoteQueueFenceHolds(fence, view({ now: fence.since + REMOTE_QUEUE_FENCE_STALL_MS })), false);
  assert.equal(remoteQueueFenceHolds(null, view()), false);
});

test("the fence belongs to the host and chat, not to a pane", () => {
  setRemoteQueueFence("host-b:chat-1", fence);
  try {
    // What a pane mounted later reads for the same chat, and nothing for another.
    assert.deepEqual(remoteQueueFence("host-b:chat-1"), fence);
    assert.equal(remoteQueueFence("host-b:chat-2"), null);
  } finally {
    setRemoteQueueFence("host-b:chat-1", null);
  }
  assert.equal(remoteQueueFence("host-b:chat-1"), null);
});

test("any turn the host accepts fences its chat's queue, and one it didn't confirm leaves it open", async () => {
  try {
    // Held while the send is in flight, before any receipt exists.
    let answer!: (receipt: { streamId: string }) => void;
    const inFlight = sendFencedTurn("host-b:chat-9", () => new Promise((resolve) => { answer = resolve; }), () => 4_000);
    assert.equal(remoteQueueFenceHolds(remoteQueueFence("host-b:chat-9"), view({ now: 4_001 })), true, "no gap before the receipt");
    answer({ streamId: "run-first" });
    await inFlight;
    assert.equal(remoteQueueFence("host-b:chat-9")?.runId, "run-first");
    await sendFencedTurn("host-b:chat-9", async () => ({ streamId: "run-typed" }), () => 5_000);
    assert.deepEqual(remoteQueueFence("host-b:chat-9"), { runId: "run-typed", since: 5_000 });
    // A Try again after it fences on the new run.
    await sendFencedTurn("host-b:chat-9", async () => ({ streamId: "run-retry" }), () => 6_000);
    assert.equal(remoteQueueFence("host-b:chat-9")?.runId, "run-retry");
    setRemoteQueueFence("host-b:chat-9", null);
    // An unresolved send is held by the reconciliation banner, which also blocks the queue.
    await sendFencedTurn("host-b:chat-9", async () => null);
    assert.equal(remoteQueueFence("host-b:chat-9"), null);
    await assert.rejects(sendFencedTurn("host-b:chat-9", async () => { throw new Error("refused"); }));
    assert.equal(remoteQueueFence("host-b:chat-9"), null);
  } finally {
    setRemoteQueueFence("host-b:chat-9", null);
  }
});
