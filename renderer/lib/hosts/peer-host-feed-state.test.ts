import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type {
  PeerHostFeedChange,
  PeerHostFeedMessage,
  PeerHostFeedSnapshot,
  PeerHostStatus,
  PeerHostView,
} from "../../shared/peer-host";
import {
  applyPeerHostFeedMessage,
  FEED_RESYNC,
  createPeerHostFeedBatcher,
  createPeerHostStatusSync,
  mergePeerHostStatuses,
  PEER_FEED_BATCH_MAX_MESSAGES,
  replayPeerHostFeedMessages,
  type PeerHostStatusSync,
} from "./peer-host-feed-state";
import { hostQueryKeys } from "./host-query-keys";
import { sidebarHosts } from "../sidebar-remote-groups";

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

function blocked(hostId: string, generation: number): PeerHostStatus {
  return { hostId, generation, state: { kind: "blocked", reason: "auth" }, feed: "live", stale: false };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The sidebar's status query: gated until the broadcast listener is installed, never stale. */
function watchStatuses(queryClient: QueryClient, sync: PeerHostStatusSync) {
  const options = {
    queryKey: hostQueryKeys.statuses(),
    queryFn: sync.read,
    staleTime: Infinity,
  };
  const observer = new QueryObserver(queryClient, { ...options, enabled: false });
  const unsubscribe = observer.subscribe(() => {});
  return {
    enable: () => observer.setOptions({ ...options, enabled: true }),
    availability: (views: PeerHostView[]) =>
      sidebarHosts(views, queryClient.getQueryData<PeerHostStatus[]>(hostQueryKeys.statuses()) ?? []).map(
        (host) => [host.id, host.availability],
      ),
    stop: () => {
      unsubscribe();
      queryClient.clear();
    },
  };
}

const views: PeerHostView[] = [
  { id: "studio", name: "Studio", enabled: true, state: "connected", features: [], capabilities: [] },
  { id: "laptop", name: "Laptop", enabled: true, state: "connected", features: [], capabilities: [] },
];

test("a host's broadcast before the first status read does not stand in for every host's status", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  const sync = createPeerHostStatusSync(queryClient, async () => {
    reads += 1;
    return [status("studio", 1, "connecting"), blocked("laptop", 4)];
  });
  const statuses = watchStatuses(queryClient, sync);
  // Studio connects after the listener is installed but before the read starts.
  sync.receive(status("studio", 2, "connected"));
  statuses.enable();
  await settle();

  assert.equal(reads, 1);
  assert.deepEqual(statuses.availability(views), [
    ["studio", "online"],
    ["laptop", "blocked"],
  ]);
  statuses.stop();
});

test("a status reply that lands after a newer broadcast keeps the broadcast", async () => {
  const queryClient = new QueryClient();
  let reply: (statuses: PeerHostStatus[]) => void = () => {};
  const sync = createPeerHostStatusSync(
    queryClient,
    () => new Promise<PeerHostStatus[]>((resolve) => (reply = resolve)),
  );
  const statuses = watchStatuses(queryClient, sync);
  statuses.enable();
  await settle();
  // The supervisor connects and broadcasts while the first read is still waiting.
  sync.receive(status("studio", 2, "connected"));
  reply([status("studio", 1, "connecting"), blocked("laptop", 1)]);
  await settle();
  assert.deepEqual(statuses.availability(views), [
    ["studio", "online"],
    ["laptop", "blocked"],
  ]);

  // A later full read (after the host list changes) keeps a broadcast that beat its reply.
  void queryClient.invalidateQueries({ queryKey: hostQueryKeys.statuses() });
  await settle();
  sync.receive(status("laptop", 2, "connected"));
  reply([status("studio", 2, "connected"), blocked("laptop", 1)]);
  await settle();
  assert.deepEqual(statuses.availability(views), [
    ["studio", "online"],
    ["laptop", "online"],
  ]);
  statuses.stop();
});

/** A frame clock the test advances by hand. */
function manualFrames() {
  const pending: Array<() => void> = [];
  let requested = 0;
  return {
    schedule(flush: () => void) {
      requested += 1;
      pending.push(flush);
      return () => {
        const index = pending.indexOf(flush);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    frame() {
      for (const flush of pending.splice(0)) flush();
    },
    get requested() {
      return requested;
    },
    get pending() {
      return pending.length;
    },
  };
}

function feedStore(hostIds: readonly string[]) {
  const snapshots = new Map<string, PeerHostFeedSnapshot | null>(
    hostIds.map((hostId) => [hostId, { ...base, hostId, summaries: [], runs: [], sequence: 0 }]),
  );
  const writes: string[] = [];
  const resyncs: string[] = [];
  return {
    snapshots,
    writes,
    resyncs,
    target: {
      read: (hostId: string) => snapshots.get(hostId),
      write: (hostId: string, snapshot: PeerHostFeedSnapshot) => {
        writes.push(hostId);
        snapshots.set(hostId, snapshot);
      },
      resync: (hostId: string) => {
        resyncs.push(hostId);
      },
    },
  };
}

for (const hostCount of [1, 5, 10]) {
  test(`a burst from ${hostCount} host(s) waits for one frame and writes each host's rows once`, () => {
    const hostIds = Array.from({ length: hostCount }, (_, index) => `host-${index}`);
    const frames = manualFrames();
    const store = feedStore(hostIds);
    const batcher = createPeerHostFeedBatcher((flush) => frames.schedule(flush), store.target);
    const perHost = 200;
    for (let sequence = 1; sequence <= perHost; sequence += 1)
      for (const hostId of hostIds)
        batcher.push({
          hostId,
          epoch: "e1",
          sequence,
          change:
            sequence % 4 === 0
              ? { type: "chat.remove", id: `chat-${sequence - 1}` }
              : { type: "chat.upsert", row: { id: `chat-${sequence}`, title: `${hostId} ${sequence}` } },
        });

    // Nothing renders until the frame, and the whole burst asked for one frame.
    assert.deepEqual(store.writes, []);
    assert.equal(frames.requested, 1);
    frames.frame();

    assert.equal(store.writes.length, hostCount);
    assert.deepEqual([...store.writes].sort(), [...hostIds].sort());
    assert.deepEqual(store.resyncs, []);
    for (const hostId of hostIds) {
      const snapshot = store.snapshots.get(hostId);
      assert.ok(snapshot);
      assert.equal(snapshot.sequence, perHost);
      // Every fourth message removed the chat upserted just before it.
      assert.equal(snapshot.summaries.length, perHost / 2);
      assert.ok(snapshot.summaries.every((row) => String(row.title).startsWith(hostId)));
      assert.ok(!snapshot.summaries.some((row) => row.id === "chat-3"));
    }

    // A quiet frame does nothing; the next message asks for a new frame.
    frames.frame();
    assert.equal(store.writes.length, hostCount);
    batcher.push({ hostId: hostIds[0], epoch: "e1", sequence: perHost + 1, change: { type: "stale", stale: true } });
    assert.equal(frames.requested, 2);
    frames.frame();
    assert.equal(store.snapshots.get(hostIds[0])?.stale, true);
  });
}

test("an epoch gap asks once per host for a fresh read, unless a reset later in the frame catches up", () => {
  const frames = manualFrames();
  const store = feedStore(["gap", "recovered", "unloaded"]);
  store.snapshots.set("unloaded", null);
  const batcher = createPeerHostFeedBatcher((flush) => frames.schedule(flush), store.target);
  for (const hostId of ["gap", "recovered", "unloaded"]) {
    batcher.push({ hostId, epoch: "e9", sequence: 1, change: { type: "chat.upsert", row: { id: "x" } } });
    batcher.push({ hostId, epoch: "e9", sequence: 2, change: { type: "chat.upsert", row: { id: "y" } } });
  }
  batcher.push({
    hostId: "recovered",
    epoch: "e9",
    sequence: 3,
    change: { type: "reset", summaries: [{ id: "fresh" }], workspaces: [], bots: [], runs: [] },
  });
  batcher.push({ hostId: "recovered", epoch: "e9", sequence: 4, change: { type: "chat.upsert", row: { id: "late" } } });
  frames.frame();

  assert.deepEqual(store.resyncs, ["gap"]);
  assert.deepEqual(store.writes, ["recovered"]);
  assert.deepEqual(store.snapshots.get("recovered")?.summaries.map((row) => row.id), ["fresh", "late"]);
  // A host whose first read is still in flight is left to that read.
  assert.equal(store.snapshots.get("unloaded"), null);
});

test("a host that floods a window with no frames is held to one fresh read", () => {
  const frames = manualFrames();
  const store = feedStore(["busy", "quiet"]);
  const batcher = createPeerHostFeedBatcher((flush) => frames.schedule(flush), store.target);
  for (let sequence = 1; sequence <= PEER_FEED_BATCH_MAX_MESSAGES * 4; sequence += 1)
    batcher.push({ hostId: "busy", epoch: "e1", sequence, change: { type: "chat.upsert", row: { id: `c${sequence}` } } });
  batcher.push({ hostId: "quiet", epoch: "e1", sequence: 1, change: { type: "chat.upsert", row: { id: "q" } } });
  frames.frame();

  assert.deepEqual(store.resyncs, ["busy"]);
  assert.deepEqual(store.writes, ["quiet"]);
  // The busy host's held rows were never applied piecemeal.
  assert.deepEqual(store.snapshots.get("busy")?.summaries, []);
});

test("a scheduler that flushes at once still applies each message, and dispose drops what is held", () => {
  const store = feedStore(["now"]);
  const immediate = createPeerHostFeedBatcher((flush) => {
    flush();
    return () => assert.fail("a finished flush is never cancelled");
  }, store.target);
  immediate.push({ hostId: "now", epoch: "e1", sequence: 1, change: { type: "chat.upsert", row: { id: "a" } } });
  immediate.push({ hostId: "now", epoch: "e1", sequence: 2, change: { type: "chat.upsert", row: { id: "b" } } });
  immediate.dispose();
  assert.deepEqual(store.snapshots.get("now")?.summaries.map((row) => row.id), ["a", "b"]);

  const frames = manualFrames();
  const later = feedStore(["held"]);
  const disposed = createPeerHostFeedBatcher((flush) => frames.schedule(flush), later.target);
  disposed.push({ hostId: "held", epoch: "e1", sequence: 1, change: { type: "chat.upsert", row: { id: "a" } } });
  disposed.dispose();
  assert.equal(frames.pending, 0);
  frames.frame();
  assert.deepEqual(later.writes, []);
});
