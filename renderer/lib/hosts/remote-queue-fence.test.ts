import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_QUEUE_FENCE_STALL_MS,
  remoteQueueFence,
  remoteQueueFenceHolds,
  setRemoteQueueFence,
  type RemoteQueueFenceView,
} from "./remote-queue-fence";

const fence = { runId: "run-a", revision: "r1", since: 1_000 };
const view = (patch: Partial<RemoteQueueFenceView> = {}): RemoteQueueFenceView => ({
  run: null,
  transcript: { revision: "r2", lastRole: "user" },
  now: 2_000,
  ...patch,
});

test("an accepted turn whose run this Mac hasn't seen yet still holds the queue", () => {
  // A freshly opened pane: no run observed, the transcript only shows the sent prompt.
  assert.equal(remoteQueueFenceHolds(fence, view()), true);
  // An idle run view from before the turn is not evidence either.
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: null, ended: false } })), true);
  assert.equal(remoteQueueFenceHolds(fence, view({ transcript: { revision: "r1", lastRole: "assistant" } })), true, "the old reply");
});

test("the fence lifts once that run ends or the host has saved its reply", () => {
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: "run-a", ended: false } })), true);
  assert.equal(remoteQueueFenceHolds(fence, view({ run: { runId: "run-a", ended: true } })), false);
  // Reopened after the run ended: no run to watch, but the reply is in the transcript.
  assert.equal(remoteQueueFenceHolds(fence, view({ transcript: { revision: "r3", lastRole: "assistant" } })), false);
  // A different run still going (started elsewhere) keeps it closed.
  assert.equal(
    remoteQueueFenceHolds(fence, view({ run: { runId: "run-b", ended: false }, transcript: { revision: "r3", lastRole: "assistant" } })),
    true,
  );
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
