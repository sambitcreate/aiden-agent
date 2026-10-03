import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type {
  PeerHostFeedChange,
  PeerHostFeedMessage,
  PeerHostFeedSnapshot,
  PeerHostStatus,
} from "../../shared/peer-host";
import {
  applyPeerHostFeedMessage,
  FEED_RESYNC,
  mergePeerHostStatuses,
  readPeerHostStatuses,
  replayPeerHostFeedMessages,
} from "./peer-host-feed-state";
import { hostQueryKeys } from "./host-query-keys";

const base: PeerHostFeedSnapshot = {
  hostId: "studio",
  epoch: "e1",
  sequence: 4,
  stale: false,
  summaries: [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ],
  workspaces: [{ id: "w", name: "W" }],
  bots: [],
  runs: [{ chatId: "a", runId: "r1", state: "working", unread: false }],
};

function message(sequence: number, change: PeerHostFeedChange, epoch: string | null = "e1"): PeerHostFeedMessage {
  return { hostId: "studio", epoch, sequence, change };
}

function snapshotOrFail(value: PeerHostFeedSnapshot | typeof FEED_RESYNC): PeerHostFeedSnapshot {
  assert.notEqual(value, FEED_RESYNC);
  return value as PeerHostFeedSnapshot;
}

test("row changes upsert in place, append new rows, and remove by id", () => {
  const updated = snapshotOrFail(
    replayPeerHostFeedMessages(base, [
      message(5, { type: "chat.upsert", row: { id: "a", title: "A renamed" } }),
      message(6, { type: "chat.upsert", row: { id: "c", title: "C" } }),
      message(7, { type: "chat.remove", id: "b" }),
      message(8, { type: "workspace.upsert", row: { id: "w2", name: "W2" } }),
      message(9, { type: "bot.upsert", row: { id: "bot", name: "Bot" } }),
    ]),
  );
  assert.deepEqual(updated.summaries, [
    { id: "a", title: "A renamed" },
    { id: "c", title: "C" },
  ]);
  assert.deepEqual(updated.workspaces.map((row) => row.id), ["w", "w2"]);
  assert.deepEqual(updated.bots.map((row) => row.id), ["bot"]);
  assert.equal(updated.sequence, 9);
  // The input snapshot is never mutated.
  assert.equal(base.summaries.length, 2);
  assert.equal(base.sequence, 4);
});

test("a run update moves that run to the newest position, as main keeps it", () => {
  const withRuns = snapshotOrFail(
    replayPeerHostFeedMessages(base, [
      message(5, { type: "run.state", run: { chatId: "b", runId: "r2", state: "working", unread: false } }),
      message(6, { type: "run.state", run: { chatId: "a", runId: "r1", state: "done", unread: true } }),
    ]),
  );
  assert.deepEqual(
    withRuns.runs.map((run) => [run.runId, run.state]),
    [
      ["r2", "working"],
      ["r1", "done"],
    ],
  );
});

test("a removed chat takes its run states with it, so a chat re-added later starts idle", () => {
  const withRuns = snapshotOrFail(
    replayPeerHostFeedMessages(base, [
      message(5, { type: "run.state", run: { chatId: "b", runId: "r2", state: "needs_approval", unread: false } }),
      message(6, { type: "chat.remove", id: "a" }),
    ]),
  );
  assert.deepEqual(withRuns.runs.map((run) => run.runId), ["r2"]);

  const readded = snapshotOrFail(
    applyPeerHostFeedMessage(withRuns, message(7, { type: "chat.upsert", row: { id: "a", title: "A" } })),
  );
  assert.deepEqual(readded.runs.filter((run) => run.chatId === "a"), []);
});

test("a paired upsert and remove sharing a sequence both apply, and older messages are skipped", () => {
  const moved = snapshotOrFail(
    replayPeerHostFeedMessages(base, [
      message(5, { type: "chat.upsert", row: { id: "a2", title: "A" } }),
      message(5, { type: "chat.remove", id: "a" }),
    ]),
  );
  assert.deepEqual(moved.summaries.map((row) => row.id), ["b", "a2"]);
  // Sent before the snapshot was read, so already reflected in it.
  assert.equal(applyPeerHostFeedMessage(base, message(3, { type: "chat.remove", id: "a" })), base);
});

test("an epoch the snapshot never saw asks for a fresh read; a reset replaces everything", () => {
  assert.equal(
    applyPeerHostFeedMessage(base, message(5, { type: "chat.remove", id: "a" }, "e2")),
    FEED_RESYNC,
  );
  assert.equal(
    replayPeerHostFeedMessages(base, [
      message(5, { type: "chat.remove", id: "a" }),
      message(1, { type: "chat.remove", id: "b" }, "e2"),
    ]),
    FEED_RESYNC,
  );
  const stale = { ...base, stale: true };
  const reset = snapshotOrFail(
    applyPeerHostFeedMessage(
      stale,
      message(1, { type: "reset", summaries: [{ id: "z" }], workspaces: [], bots: [], runs: [] }, "e2"),
    ),
  );
  assert.equal(reset.epoch, "e2");
  assert.equal(reset.sequence, 1);
  assert.deepEqual(reset.summaries, [{ id: "z" }]);
  assert.deepEqual(reset.workspaces, []);
  // Staleness is reported separately and survives a reset.
  assert.equal(reset.stale, true);
  // After the reset, the new epoch's changes apply.
  const after = snapshotOrFail(
    applyPeerHostFeedMessage(reset, message(2, { type: "chat.upsert", row: { id: "y" } }, "e2")),
  );
  assert.deepEqual(after.summaries.map((row) => row.id), ["z", "y"]);
});

test("stale flips keep rows and sequence, and another host's message changes nothing", () => {
  const stale = snapshotOrFail(applyPeerHostFeedMessage(base, message(4, { type: "stale", stale: true })));
  assert.equal(stale.stale, true);
  assert.equal(stale.summaries, base.summaries);
  assert.equal(stale.sequence, 4);
  assert.equal(applyPeerHostFeedMessage(base, message(4, { type: "stale", stale: false })), base);
  assert.equal(
    applyPeerHostFeedMessage(base, { ...message(9, { type: "chat.remove", id: "a" }), hostId: "laptop" }),
    base,
  );
});

function status(hostId: string, generation: number, kind: "connected" | "connecting"): PeerHostStatus {
  return {
    hostId,
    generation,
    state: kind === "connected" ? { kind, since: 1 } : { kind, attempt: 1 },
    feed: "live",
    stale: false,
  };
}

test("host statuses only move forward by generation", () => {
  const current = [status("studio", 5, "connected"), status("laptop", 2, "connecting")];
  const merged = mergePeerHostStatuses(current, [status("studio", 4, "connecting"), status("laptop", 3, "connected")]);
  assert.deepEqual(
    merged.map((entry) => [entry.hostId, entry.generation, entry.state.kind]),
    [
      ["studio", 5, "connected"],
      ["laptop", 3, "connected"],
    ],
  );
  // A partial broadcast keeps hosts it does not mention.
  assert.equal(mergePeerHostStatuses(current, [status("new", 1, "connecting")]).length, 3);
  // A full list drops hosts that were unpaired, but still never moves a host backwards.
  const complete = mergePeerHostStatuses(current, [status("studio", 1, "connecting")], true);
  assert.deepEqual(
    complete.map((entry) => [entry.hostId, entry.generation]),
    [["studio", 5]],
  );
  assert.deepEqual(mergePeerHostStatuses(undefined, [status("studio", 1, "connecting")]).length, 1);
});

test("a status reply that lands after a newer broadcast keeps the broadcast", async () => {
  const queryClient = new QueryClient();
  const key = hostQueryKeys.statuses();
  queryClient.setQueryData<PeerHostStatus[]>(key, [status("studio", 1, "connecting")]);
  let reply: (statuses: PeerHostStatus[]) => void = () => {};
  const pendingReply = new Promise<PeerHostStatus[]>((resolve) => (reply = resolve));
  const read = queryClient.fetchQuery({
    queryKey: key,
    queryFn: () =>
      readPeerHostStatuses(
        () => pendingReply,
        () => queryClient.getQueryData<PeerHostStatus[]>(key),
      ),
  });
  await Promise.resolve();
  // The supervisor connects and broadcasts while the read is still waiting.
  queryClient.setQueryData<PeerHostStatus[]>(key, (current) =>
    mergePeerHostStatuses(current, [status("studio", 2, "connected")]),
  );
  reply([status("studio", 1, "connecting"), status("laptop", 1, "connecting")]);
  await read;

  const cached = queryClient.getQueryData<PeerHostStatus[]>(key) ?? [];
  assert.deepEqual(
    cached.map((entry) => [entry.hostId, entry.generation, entry.state.kind]),
    [
      ["studio", 2, "connected"],
      ["laptop", 1, "connecting"],
    ],
  );
  queryClient.clear();
});
