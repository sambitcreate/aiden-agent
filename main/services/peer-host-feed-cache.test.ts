import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import {
  AidenRemoteHostFeedService,
  type AidenRemoteHostFeedState,
} from "./aiden-remote-host-feed.js";
import type { AidenRemoteChatSummaryProjection } from "./aiden-remote-chats.js";
import type { HostRunSummary } from "./host-run-registry.js";
import { sseFrame } from "./aiden-remote-sse.js";
import { PeerEventFrames, PeerTransportError } from "./peer-transport.js";
import { parsePeerSseFrame, parsePeerStreamEnvelope } from "./peer-sse.js";
import { PEER_FEED_MAX_CHATS, PeerHostFeedCache } from "./peer-host-feed-cache.js";
import type { PeerHostFeedChange } from "../../renderer/shared/peer-host.js";

/** Minimal in-memory SSE response the real host feed writes into. */
class Wire extends EventEmitter {
  body = "";
  read = 0;
  destroyed = false;
  writableEnded = false;
  writeHead(): this {
    return this;
  }
  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
  /** Frames written since the last call, through the real peer SSE reader. */
  drain(): string[] {
    const frames: string[] = [];
    new PeerEventFrames().push(
      Buffer.from(this.body.slice(this.read)),
      (frame) => frames.push(frame),
      () => {},
    );
    this.read = this.body.length;
    return frames;
  }
}

function summary(id: string, updatedAt = 2_000, title = `Chat ${id}`) {
  return {
    id,
    workspaceId: "workspace-1",
    title,
    titlePending: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    revision: `rev_${id}_${title.length}`,
    activity: "idle",
  } as AidenRemoteChatSummaryProjection;
}

function run(runId: string, chatId: string, state: HostRunSummary["state"] = "working"): HostRunSummary {
  return {
    runId,
    chatId,
    origin: "renderer",
    state,
    startedAt: new Date(1_000).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
    lastSequence: 1,
    pendingApprovalIds: [],
    pendingQuestionIds: [],
  };
}

function host(epoch: string, current: AidenRemoteHostFeedState, options: { maxEvents?: number; snapshotChunkBytes?: number } = {}) {
  const state = { current };
  const feed = new AidenRemoteHostFeedService({
    source: { read: async () => state.current },
    now: () => 5_000,
    epoch,
    debounceMs: 60_000,
    ...options,
  });
  return { feed, state };
}

async function subscribe(feed: AidenRemoteHostFeedService, cursor?: string) {
  const wire = new Wire();
  await feed.open(
    { id: "desktop", capabilities: new Set(["host:events"]) },
    cursor,
    wire as unknown as ServerResponse,
  );
  return wire;
}

function feedInto(cache: PeerHostFeedCache, frames: string[]): PeerHostFeedChange[] {
  return frames.flatMap((frame) =>
    cache.apply(parsePeerStreamEnvelope(parsePeerSseFrame(frame), "host feed")),
  );
}

const initial = (): AidenRemoteHostFeedState => ({
  summaries: Array.from({ length: 30 }, (_, index) => summary(`chat-${index}`, 2_000 + index)),
  botChatIds: new Set(),
  workspaces: [
    {
      id: "workspace-1",
      name: "Project",
      permission: "ask",
      memoryEnabled: true,
      hasFolder: true,
      isManagedWorktree: false,
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(2_000).toISOString(),
      revision: "rev_ws",
    },
  ] as unknown as AidenRemoteHostFeedState["workspaces"],
  bots: [],
});

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

test("a chunked snapshot applies only when complete and then mirrors the host's live changes", async () => {
  const { feed, state } = host("epoch_a", initial(), { snapshotChunkBytes: 1_024 });
  const wire = await subscribe(feed);
  try {
    const cache = new PeerHostFeedCache("host-1");
    const frames = wire.drain();
    assert.ok(frames.length > 2, "the snapshot spans several frames");
    // Partial chunks hold rows back and never move the resume cursor.
    assert.deepEqual(feedInto(cache, frames.slice(0, -1)), []);
    assert.equal(cache.cursor(), undefined);
    assert.equal(cache.snapshot().summaries.length, 0);
    const [reset] = feedInto(cache, frames.slice(-1));
    assert.equal(reset?.type, "reset");
    assert.equal(cache.cursor(), "epoch_a:0");
    assert.deepEqual(ids(cache.snapshot().summaries), ids(state.current.summaries));

    state.current = {
      ...state.current,
      summaries: [
        ...state.current.summaries.filter((item) => item.id !== "chat-3"),
        summary("chat-new", 9_000),
      ].map((item) => (item.id === "chat-1" ? summary("chat-1", 9_500, "Renamed") : item)),
      workspaces: [],
    };
    feed.noteRun(run("run-1", "chat-1"), false);
    feed.invalidate();
    await feed.refresh();
    const live = wire.drain();
    const changes = feedInto(cache, live);
    assert.deepEqual(
      changes.map((change) => change.type).sort(),
      ["chat.remove", "chat.upsert", "chat.upsert", "run.state", "workspace.remove"],
    );
    const view = cache.snapshot();
    assert.deepEqual(ids(view.summaries), ids(state.current.summaries));
    assert.equal(view.summaries.find((item) => item.id === "chat-1")?.title, "Renamed");
    assert.deepEqual(view.workspaces, []);
    assert.deepEqual(view.runs, [{ chatId: "chat-1", runId: "run-1", state: "working", unread: false }]);
    assert.equal(cache.runForChat("chat-1")?.runId, "run-1");
    assert.equal(cache.cursor(), `epoch_a:${feed.sequence}`);

    // A replay of already-applied entries (a resumed connection) changes nothing.
    assert.deepEqual(feedInto(cache, live), []);
  } finally {
    feed.close();
  }
});

test("an interrupted snapshot restarts whole and a same-epoch resync keeps known runs", async () => {
  const { feed, state } = host("epoch_a", initial(), { maxEvents: 1, snapshotChunkBytes: 1_024 });
  try {
    const cache = new PeerHostFeedCache("host-1");
    const first = await subscribe(feed);
    feedInto(cache, first.drain());
    feed.noteRun(run("run-1", "chat-1", "needs_approval"), false);
    await feed.refresh();
    feedInto(cache, first.drain());
    assert.equal(cache.run("run-1")?.state, "needs_approval");

    // The cursor falls behind retention while disconnected: the host resends a snapshot.
    for (const index of [40, 41, 42]) {
      state.current = { ...state.current, summaries: [...state.current.summaries, summary(`chat-${index}`, 3_000 + index)] };
      feed.invalidate();
      await feed.refresh();
    }
    const resumed = await subscribe(feed, cache.cursor());
    const frames = resumed.drain();
    assert.equal(frames.length > 1, true);
    // The connection drops mid-snapshot: the partial rows are discarded.
    feedInto(cache, frames.slice(0, 1));
    cache.abandonPartial();
    const retry = await subscribe(feed, cache.cursor());
    const [reset] = feedInto(cache, retry.drain());
    assert.equal(reset?.type, "reset");
    assert.deepEqual(ids(cache.snapshot().summaries), ids(state.current.summaries));
    assert.equal(cache.run("run-1")?.state, "needs_approval", "runs survive a same-epoch resync");
  } finally {
    feed.close();
  }
});

test("a restarted host (new epoch) replaces every row and forgets runs", async () => {
  const before = host("epoch_a", initial());
  const cache = new PeerHostFeedCache("host-1");
  try {
    feedInto(cache, (await subscribe(before.feed)).drain());
    const wire = await subscribe(before.feed);
    before.feed.noteRun(run("run-1", "chat-1"), false);
    await before.feed.refresh();
    feedInto(cache, wire.drain());
    assert.equal(cache.snapshot().runs.length, 1);
  } finally {
    before.feed.close();
  }
  const after = host("epoch_b", { ...initial(), summaries: [summary("chat-only")] });
  try {
    const [reset] = feedInto(cache, (await subscribe(after.feed, cache.cursor())).drain());
    assert.equal(reset?.type, "reset");
    assert.equal(cache.epoch, "epoch_b");
    assert.deepEqual(ids(cache.snapshot().summaries), ["chat-only"]);
    assert.deepEqual(cache.snapshot().runs, []);
  } finally {
    after.feed.close();
  }
});

test("the cache keeps the newest 2,000 chats and evicts the least recently updated", async () => {
  const many = Array.from({ length: PEER_FEED_MAX_CHATS + 50 }, (_, index) =>
    summary(`chat-${index}`, 10_000 + index),
  );
  const { feed, state } = host("epoch_a", { ...initial(), summaries: many });
  const wire = await subscribe(feed);
  try {
    const cache = new PeerHostFeedCache("host-1");
    feedInto(cache, wire.drain());
    const kept = cache.snapshot().summaries;
    assert.equal(kept.length, PEER_FEED_MAX_CHATS);
    assert.ok(!kept.some((item) => item.id === "chat-49"), "the oldest chats are not retained");
    assert.ok(kept.some((item) => item.id === "chat-50"));

    state.current = { ...state.current, summaries: [...many, summary("fresh", 99_999)] };
    feed.invalidate();
    await feed.refresh();
    const changes = feedInto(cache, wire.drain());
    assert.deepEqual(changes, [
      { type: "chat.upsert", row: cache.snapshot().summaries.find((item) => item.id === "fresh") },
      { type: "chat.remove", id: "chat-50" },
    ]);
    assert.equal(cache.snapshot().summaries.length, PEER_FEED_MAX_CHATS);
  } finally {
    feed.close();
  }
});

test("future vocabulary is skipped in place and a different protocol version blocks", () => {
  const cache = new PeerHostFeedCache("host-1");
  const envelope = (sequence: number, type: string, payload: unknown, protocolVersion = 1) =>
    parsePeerStreamEnvelope(
      parsePeerSseFrame(
        sseFrame(`epoch_a:${sequence}`, type, {
          protocolVersion,
          streamId: "host",
          sequence,
          timestamp: new Date(0).toISOString(),
          type,
          terminal: false,
          payload,
        }),
      ),
      "host feed",
    );
  cache.apply(envelope(0, "snapshot", { epoch: "epoch_a", sequence: 0, summaries: [], workspaces: [], bots: [] }));
  assert.deepEqual(cache.apply(envelope(4, "chat.pinned", { id: "chat-1" })), []);
  assert.equal(cache.cursor(), "epoch_a:4");
  assert.throws(
    () => envelope(5, "chat.upsert", { id: "x" }, 2),
    (error: unknown) => error instanceof PeerTransportError && error.code === "unsupported_protocol",
  );
  assert.throws(
    () => cache.apply(envelope(6, "chat.upsert", { id: "../escape" })),
    (error: unknown) => error instanceof PeerTransportError && error.code === "invalid_response",
  );
  assert.throws(() =>
    parsePeerStreamEnvelope(parsePeerSseFrame('data: {"protocolVersion":1,"authorization":"x"}'), "host feed"),
  );
});
