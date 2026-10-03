import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import {
  AidenRemoteHostFeedService,
  type AidenRemoteHostFeedState,
} from "./aiden-remote-host-feed.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { PeerEventFrames } from "./peer-transport.js";
import type { AidenRemoteChatSummaryProjection } from "./aiden-remote-chats.js";
import type { HostRunSummary } from "./host-run-registry.js";

/** In-memory SSE response: records frames and honours close/destroy. */
class RecordingResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  destroyed = false;
  writableEnded = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  /** Every event frame; `id` is undefined for a frame that carries no SSE id. */
  frames(): Array<{ id: string | undefined; event: string; data: Record<string, unknown> }> {
    return this.body
      .split("\n\n")
      .filter((block) => block.length > 0 && !block.startsWith(":"))
      .map((block) => {
        const field = (name: string) =>
          block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        return {
          id: field("id"),
          event: field("event")!,
          data: JSON.parse(field("data")!) as Record<string, unknown>,
        };
      });
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

function summary(id: string, overrides: Partial<AidenRemoteChatSummaryProjection> = {}) {
  return {
    id,
    workspaceId: "workspace-1",
    title: `Chat ${id}`,
    titlePending: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    revision: `rev_${id}`,
    activity: "idle",
    ...overrides,
  } as AidenRemoteChatSummaryProjection;
}

function workspace(id: string, name = "Project") {
  return {
    id,
    name,
    permission: "ask" as const,
    memoryEnabled: true,
    hasFolder: true,
    isManagedWorktree: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    revision: `rev_${id}`,
    repository: { canonicalKey: "github.com/example/aiden", relativePath: "" },
  };
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

const desktop = (id: string, extra: AidenRemoteCapability[] = []) => ({
  id,
  capabilities: new Set<AidenRemoteCapability>(["host:events", ...extra]),
});

function harness(options: {
  maxEvents?: number;
  maxBytes?: number;
  heartbeatMs?: number;
  debounceMs?: number;
  snapshotChunkBytes?: number;
} = {}) {
  const state: { current: AidenRemoteHostFeedState; reads: number } = {
    current: {
      summaries: [summary("chat-1")],
      botChatIds: new Set(["bot-chat-1"]),
      workspaces: [workspace("workspace-1")],
      bots: [{ id: "bot-1", name: "Planner" }],
    },
    reads: 0,
  };
  /** When set, the next read captures the state, then waits for `release()`. */
  const gate: { hold: boolean; started?: () => void; release?: () => void } = { hold: false };
  const feed = new AidenRemoteHostFeedService({
    source: {
      read: async () => {
        state.reads += 1;
        const captured = state.current;
        if (gate.hold) {
          gate.hold = false;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
            gate.started?.();
          });
        }
        return captured;
      },
    },
    now: () => 5_000,
    epoch: "epoch_feed_01",
    // Refreshes are driven explicitly; the debounce never fires inside a test.
    debounceMs: 60_000,
    ...options,
  });
  /** Hold the next source read; resolves once that read has captured its state. */
  const holdNextRead = () =>
    new Promise<void>((resolve) => {
      gate.hold = true;
      gate.started = resolve;
    });
  return { feed, state, holdNextRead, releaseRead: () => gate.release?.() };
}

async function open(feed: AidenRemoteHostFeedService, device: ReturnType<typeof desktop>, cursor?: string) {
  const response = new RecordingResponse();
  await feed.open(device, cursor, response.asServerResponse());
  return response;
}

test("a new subscriber receives a snapshot, then upserts, removals and run states in order", async () => {
  const { feed, state } = harness();
  const response = await open(feed, desktop("device-a"));
  try {
    assert.equal(response.status, 200);
    const [snapshot] = response.frames();
    assert.equal(snapshot!.event, "snapshot");
    assert.equal(snapshot!.id, "epoch_feed_01:0");
    assert.deepEqual(
      { ...snapshot!.data, timestamp: undefined },
      {
        protocolVersion: 1,
        streamId: "host",
        sequence: 0,
        timestamp: undefined,
        type: "snapshot",
        terminal: false,
        payload: {
          epoch: "epoch_feed_01",
          sequence: 0,
          summaries: [summary("chat-1")],
          workspaces: [workspace("workspace-1")],
          bots: [],
        },
      },
    );

    state.current = {
      ...state.current,
      summaries: [summary("chat-1", { title: "Renamed", unread: true }), summary("chat-2")],
      workspaces: [],
    };
    feed.noteRun(run("run-1", "chat-1"), false);
    await feed.refresh();

    const live = response.frames().slice(1);
    assert.deepEqual(
      live.map((frame) => [frame.id, frame.event]),
      [
        ["epoch_feed_01:1", "chat.upsert"],
        ["epoch_feed_01:2", "chat.upsert"],
        ["epoch_feed_01:3", "workspace.remove"],
        ["epoch_feed_01:4", "run.state"],
      ],
    );
    assert.equal((live[0]!.data.payload as { title: string }).title, "Renamed");
    assert.deepEqual(live[2]!.data.payload, { id: "workspace-1" });
    assert.deepEqual(live[3]!.data.payload, {
      chatId: "chat-1",
      runId: "run-1",
      state: "working",
      unread: true,
    });
    assert.deepEqual(live.map((frame) => frame.data.sequence), [1, 2, 3, 4]);
  } finally {
    feed.close();
  }
});

test("Last-Event-ID resumes after the last delivered event without a snapshot", async () => {
  const { feed, state } = harness();
  try {
    await feed.refresh();
    for (const id of ["chat-2", "chat-3", "chat-4"]) {
      state.current = { ...state.current, summaries: [...state.current.summaries, summary(id)] };
      feed.invalidate();
      await feed.refresh();
    }
    assert.equal(feed.sequence, 3);

    const resumed = await open(feed, desktop("device-a"), "epoch_feed_01:1");
    assert.deepEqual(
      resumed.frames().map((frame) => [frame.id, frame.event, (frame.data.payload as { id: string }).id]),
      [
        ["epoch_feed_01:2", "chat.upsert", "chat-3"],
        ["epoch_feed_01:3", "chat.upsert", "chat-4"],
      ],
    );

    const current = await open(feed, desktop("device-b"), "epoch_feed_01:3");
    assert.deepEqual(current.frames(), []);
  } finally {
    feed.close();
  }
});

test("a cursor behind retention, from another epoch, malformed or ahead gets a fresh snapshot", async () => {
  const { feed, state } = harness({ maxEvents: 2 });
  try {
    await feed.refresh();
    for (const id of ["chat-2", "chat-3", "chat-4", "chat-5"]) {
      state.current = { ...state.current, summaries: [...state.current.summaries, summary(id)] };
      feed.invalidate();
      await feed.refresh();
    }
    assert.equal(feed.sequence, 4);

    for (const cursor of ["epoch_feed_01:1", "other_epoch:3", "not-a-cursor", "epoch_feed_01:99"]) {
      const response = await open(feed, desktop(`device-${cursor}`), cursor);
      const frames = response.frames();
      assert.equal(frames.length, 1, cursor);
      assert.equal(frames[0]!.event, "snapshot", cursor);
      assert.equal(frames[0]!.id, "epoch_feed_01:4", cursor);
      assert.equal((frames[0]!.data.payload as { summaries: unknown[] }).summaries.length, 5);
    }

    // The oldest retained cursor still replays.
    const replay = await open(feed, desktop("device-replay"), "epoch_feed_01:2");
    assert.deepEqual(replay.frames().map((frame) => frame.event), ["chat.upsert", "chat.upsert"]);
  } finally {
    feed.close();
  }
});

test("a byte budget overflow also forces a snapshot instead of a partial replay", async () => {
  const { feed, state } = harness({ maxBytes: 2_000 });
  try {
    await feed.refresh();
    for (let index = 0; index < 6; index += 1) {
      state.current = {
        ...state.current,
        summaries: [summary("chat-1", { title: `${"x".repeat(400)}${index}` })],
      };
      feed.invalidate();
      await feed.refresh();
    }
    const response = await open(feed, desktop("device-a"), "epoch_feed_01:1");
    assert.deepEqual(response.frames().map((frame) => frame.event), ["snapshot"]);
  } finally {
    feed.close();
  }
});

test("a run-state backlog nobody drained moves every reader onto a snapshot", async () => {
  const { feed } = harness({ maxEvents: 3 });
  try {
    await feed.refresh();
    const before = feed.sequence;
    for (let index = 0; index < 5; index += 1) feed.noteRun(run(`run-${index}`, "chat-1"), false);
    const response = await open(feed, desktop("device-a"), `epoch_feed_01:${before}`);
    assert.equal(response.frames()[0]!.event, "snapshot");
  } finally {
    feed.close();
  }
});

test("Bots and Bot-chat run states reach only devices that also hold bot:read", async () => {
  const { feed, state } = harness();
  const plain = await open(feed, desktop("device-plain"));
  const botAware = await open(feed, desktop("device-bots", ["bot:read"]));
  try {
    assert.deepEqual((plain.frames()[0]!.data.payload as { bots: unknown[] }).bots, []);
    assert.deepEqual(
      (botAware.frames()[0]!.data.payload as { bots: unknown[] }).bots,
      [{ id: "bot-1", name: "Planner" }],
    );

    state.current = { ...state.current, bots: [{ id: "bot-1", name: "Renamed" }] };
    feed.noteRun(run("run-bot", "bot-chat-1", "needs_approval"), false);
    feed.noteRun(run("run-plain", "chat-1", "done"), false);
    // A chat outside every projection (assistant workspace, deleted) is never announced.
    feed.noteRun(run("run-hidden", "chat-unknown"), false);
    await feed.refresh();

    assert.deepEqual(
      plain.frames().slice(1).map((frame) => [frame.event, (frame.data.payload as { runId?: string }).runId]),
      [["run.state", "run-plain"]],
    );
    assert.deepEqual(
      botAware.frames().slice(1).map((frame) => [frame.event, (frame.data.payload as { runId?: string }).runId]),
      [["bot.upsert", undefined], ["run.state", "run-bot"], ["run.state", "run-plain"]],
    );
  } finally {
    feed.close();
  }
});

test("revocation closes only the revoked device's feeds", async () => {
  const { feed, state } = harness();
  const revoked = await open(feed, desktop("device-revoked"));
  const second = await open(feed, desktop("device-revoked"));
  const kept = await open(feed, desktop("device-kept"));
  try {
    feed.revokeDevice("device-revoked");
    assert.equal(revoked.destroyed, true);
    assert.equal(second.destroyed, true);
    assert.equal(kept.destroyed, false);

    state.current = { ...state.current, summaries: [summary("chat-1"), summary("chat-2")] };
    feed.invalidate();
    await feed.refresh();
    assert.deepEqual(kept.frames().slice(1).map((frame) => frame.event), ["chat.upsert"]);
    assert.equal(revoked.frames().length, 1);
  } finally {
    feed.close();
  }
});

test("an unchanged host costs one transcript-free read per refresh and emits nothing", async () => {
  const { feed, state } = harness();
  const response = await open(feed, desktop("device-a"));
  try {
    const reads = state.reads;
    feed.invalidate();
    await feed.refresh();
    assert.equal(state.reads, reads + 1);
    assert.equal(response.frames().length, 1);
    // Without an invalidation there is nothing to re-read.
    await feed.refresh();
    assert.equal(state.reads, reads + 1);
  } finally {
    feed.close();
  }
});

test("an idle feed sends heartbeat comments", async () => {
  const { feed } = harness({ heartbeatMs: 5 });
  const response = await open(feed, desktop("device-a"));
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(response.body, /\n\n: heartbeat\n\n/u);
  } finally {
    feed.close();
  }
});

async function eventually(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a revocation that lands while a feed is opening refuses the subscription", async () => {
  const { feed, state, holdNextRead, releaseRead } = harness();
  let revoked = false;
  const admit = () => {
    if (revoked) throw new AidenRemoteServiceError("credential_revoked", "This device was revoked.", 403);
  };
  const response = new RecordingResponse();
  const reading = holdNextRead();
  const opening = feed.open(desktop("device-a"), undefined, response.asServerResponse(), admit);
  await reading;
  // Revocation completes, cleanup included, before the opening read returns.
  revoked = true;
  feed.revokeDevice("device-a");
  releaseRead();
  await assert.rejects(opening, (error: unknown) =>
    error instanceof AidenRemoteServiceError && error.code === "credential_revoked");
  assert.equal(response.status, 0);
  assert.equal(response.body, "");

  state.current = { ...state.current, summaries: [summary("chat-1"), summary("chat-2")] };
  feed.invalidate();
  await feed.refresh();
  assert.equal(response.body, "");
});

test("a change signalled during the opening read reaches the new subscriber", async () => {
  const { feed, state, holdNextRead, releaseRead } = harness({ debounceMs: 1 });
  const response = new RecordingResponse();
  const reading = holdNextRead();
  const opening = feed.open(desktop("device-a"), undefined, response.asServerResponse());
  await reading;
  // The read already captured the old state; this change arrives while it is suspended.
  state.current = { ...state.current, summaries: [summary("chat-1", { title: "Renamed" })] };
  feed.invalidate();
  releaseRead();
  await opening;
  try {
    await eventually(() => response.frames().some((frame) => frame.event === "chat.upsert"), "chat.upsert");
    const [snapshot, upsert] = response.frames();
    assert.equal(snapshot!.event, "snapshot");
    assert.equal(
      ((snapshot!.data.payload as { summaries: Array<{ title: string }> }).summaries[0]!).title,
      "Chat chat-1",
    );
    assert.equal((upsert!.data.payload as { title: string }).title, "Renamed");
  } finally {
    feed.close();
  }
});

test("a large host snapshot arrives as bounded frames that reassemble every row", async () => {
  const { feed, state } = harness();
  const ids = Array.from({ length: 4_000 }, (_, index) => `chat-${String(index).padStart(4, "0")}`);
  state.current = {
    ...state.current,
    summaries: ids.map((id) => summary(id, { title: `${id} `.padEnd(50, "t"), revision: "a".repeat(40) })),
  };
  const response = await open(feed, desktop("device-a", ["bot:read"]));
  try {
    assert.ok(Buffer.byteLength(response.body) > 1_048_576, "the host is larger than one SSE frame");

    // The real peer reader enforces the 1 MiB frame limit and accepts every frame.
    const reader = new PeerEventFrames();
    const raw: string[] = [];
    reader.push(Buffer.from(response.body), (frame) => raw.push(frame), () => {});
    const frames = response.frames();
    assert.equal(raw.length, frames.length);
    assert.ok(frames.length > 1);
    assert.ok(frames.every((frame) => frame.event === "snapshot"));

    const partial = frames.slice(0, -1);
    const final = frames[frames.length - 1]!;
    // Only the final frame moves Last-Event-ID, so an interrupted snapshot is retried whole.
    assert.ok(partial.every((frame) => frame.id === undefined && (frame.data.payload as { partial?: boolean }).partial === true));
    assert.equal(final.id, "epoch_feed_01:0");
    assert.equal((final.data.payload as { partial?: boolean }).partial, undefined);

    const merged = { summaries: [] as Array<{ id: string }>, workspaces: [] as Array<{ id: string }>, bots: [] as Array<{ id: string }> };
    for (const frame of frames) {
      const payload = frame.data.payload as typeof merged & { epoch: string; sequence: number };
      assert.equal(payload.epoch, "epoch_feed_01");
      assert.equal(payload.sequence, 0);
      merged.summaries.push(...payload.summaries);
      merged.workspaces.push(...payload.workspaces);
      merged.bots.push(...payload.bots);
    }
    assert.deepEqual(merged.summaries.map((item) => item.id), ids);
    assert.deepEqual(merged.workspaces.map((item) => item.id), ["workspace-1"]);
    assert.deepEqual(merged.bots.map((item) => item.id), ["bot-1"]);
  } finally {
    feed.close();
  }
});
