import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_QUEUE_FENCE_STALL_MS,
  observeRemoteQueueFenceActivity,
  remoteQueueFence,
  remoteQueueFenceHolds,
  setRemoteQueueFence,
  type RemoteQueueFenceView,
} from "./remote-queue-fence";

const fence = { runId: "run-a", since: 1_000 };
const view = (patch: Partial<RemoteQueueFenceView> = {}): RemoteQueueFenceView => ({
  run: null,
  hostActivity: undefined,
  now: 2_000,
  ...patch,
});

test("an accepted turn whose run this Mac hasn't seen yet still holds the queue", () => {
  // A freshly opened pane: no run observed, nothing heard from the host's chat list.
  assert.equal(remoteQueueFenceHolds(fence, view()), true);
  // An idle run view from before the turn is not evidence either.
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: null, ended: false } })), true);
  // Nor is an idle row the host listed before the turn started working.
  assert.equal(remoteQueueFenceHolds(fence, view({ hostActivity: "idle" })), true);
});

test("the fence lifts only on the host's word that the turn settled", () => {
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: "run-a", ended: false } })), true);
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: "run-a", ended: true } })), false);
  // Reopened while the host still holds the turn after saving its reply.
  const working = { ...fence, sawActive: true };
  assert.equal(remoteQueueFenceHolds(working, view({ hostActivity: "active" })), true);
  // The host's list turns idle only after it releases the turn.
  assert.equal(remoteQueueFenceHolds(working, view({ hostActivity: "idle" })), false);
  // A different run still going (started elsewhere) keeps it closed.
  assert.equal(remoteQueueFenceHolds(working, view({ hostActivity: "idle", run: { runId: "run-b", ended: false } })), true);
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

test("a working row left over from the previous run never stands for the accepted turn", () => {
  // B is accepted while the list still shows A working; A's late idle must not release B.
  let fenceB = { runId: "run-b", since: 1_000, lastActivity: "active" as const } as Parameters<typeof observeRemoteQueueFenceActivity>[0];
  fenceB = observeRemoteQueueFenceActivity(fenceB, "active");
  assert.equal(fenceB.sawActive, undefined);
  fenceB = observeRemoteQueueFenceActivity(fenceB, "idle");
  assert.equal(remoteQueueFenceHolds(fenceB, view({ hostActivity: "idle" })), true, "A settling is not B settling");
  // Then B shows up working and settles.
  fenceB = observeRemoteQueueFenceActivity(fenceB, "active");
  assert.equal(remoteQueueFenceHolds(fenceB, view({ hostActivity: "active" })), true);
  fenceB = observeRemoteQueueFenceActivity(fenceB, "idle");
  assert.equal(remoteQueueFenceHolds(fenceB, view({ hostActivity: "idle" })), false);
});

test("without a list reading at acceptance, activity alone never releases the fence", () => {
  let fence = { runId: "run-a", since: 1_000 } as Parameters<typeof observeRemoteQueueFenceActivity>[0];
  fence = observeRemoteQueueFenceActivity(fence, "active");
  fence = observeRemoteQueueFenceActivity(fence, "idle");
  assert.equal(remoteQueueFenceHolds(fence, view({ hostActivity: "idle" })), true, "only the run ending or the stall lifts it");
});
