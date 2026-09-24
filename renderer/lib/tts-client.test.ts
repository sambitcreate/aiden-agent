import assert from "node:assert/strict";
import test from "node:test";
import { ReadAloudController } from "./tts-client.js";
import { defaultTtsSettings, type TtsJobSnapshot, type TtsSourceRef } from "../shared/tts.js";
import type { ttsApi } from "./ipc.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const source: TtsSourceRef = {
  chatId: "chat",
  messageId: "message",
  sourceRevision: "body-revision",
};
function job(patch: Partial<TtsJobSnapshot> = {}): TtsJobSnapshot {
  return {
    jobId: "job",
    chatId: "chat",
    kind: "read-aloud",
    phase: "buffering",
    totalSegments: 3,
    readySegments: 1,
    omissions: [],
    error: null,
    ...patch,
  };
}
function audio() {
  return {
    bytes: new Uint8Array([1, 2]),
    mimeType: "audio/wav" as const,
    sampleRate: 24000,
    channels: 1,
    segmentBytes: 2,
    nextOffset: 2,
    complete: true,
  };
}

class FakePlayer {
  isPlaying = false;
  segmentsPlayed = 0;
  scheduled: number[] = [];
  stopped = false;
  paused = false;
  decode: Promise<void> | null = null;
  constructor(private ended: (index: number) => void) {}
  async prime() {
    assert.equal(this.stopped, false, "stopped players are not reusable");
  }
  async playSegment(index: number) {
    if (this.decode) await this.decode;
    if (this.stopped) return;
    this.scheduled.push(index);
    this.isPlaying = !this.paused;
  }
  async pause() {
    this.paused = true;
    this.isPlaying = false;
  }
  async resume() {
    this.paused = false;
    this.isPlaying = this.scheduled.length > this.segmentsPlayed;
  }
  stop() {
    this.stopped = true;
    this.isPlaying = false;
  }
  end(index: number) {
    this.segmentsPlayed = index + 1;
    this.isPlaying = !this.paused && this.scheduled.length > this.segmentsPlayed;
    this.ended(index);
  }
}

function harness() {
  const players: FakePlayer[] = [];
  const reads: number[] = [];
  let stops = 0;
  const api: Pick<
    typeof ttsApi,
    "status" | "start" | "preview" | "readAudio" | "pause" | "resume" | "stop"
  > = {
    status: async () => ({
      settings: { ...defaultTtsSettings(), enabled: true },
      settingsRevision: "rev",
      credentialReady: true,
      credentialSourceLabel: "Saved key",
      synthesisReady: true,
      latestSource: { source, reason: "ok" },
      job: null,
    }),
    start: async () => ({ ok: true, snapshot: job() }),
    preview: async () => ({
      ok: true,
      snapshot: job({
        kind: "preview",
        chatId: null,
        totalSegments: 1,
        readySegments: 1,
        phase: "completed",
      }),
    }),
    readAudio: async (_id, segment) => {
      reads.push(segment);
      return audio();
    },
    pause: async () => null,
    resume: async () => null,
    stop: async () => {
      stops += 1;
      return { ok: true };
    },
  };
  const controller = new ReadAloudController({
    api,
    createPlayer: (ended) => {
      const player = new FakePlayer(ended);
      players.push(player);
      return player;
    },
  });
  controller.activate("chat");
  return { controller, api, players, reads, stops: () => stops };
}

test("coalesced events drain in order without duplicate reads and bound decoded audio", async () => {
  const h = harness();
  const held = deferred<ReturnType<typeof audio>>();
  h.api.readAudio = async (_id, index) => {
    h.reads.push(index);
    return index === 0 ? held.promise : audio();
  };
  await h.controller.start(source);
  h.controller.handleEvent({ kind: "job", snapshot: job({ readySegments: 2 }) });
  h.controller.handleEvent({
    kind: "job",
    snapshot: job({ readySegments: 3, phase: "completed" }),
  });
  assert.deepEqual(h.reads, [0]);
  held.resolve(audio());
  await flush();
  assert.deepEqual(h.players[0]!.scheduled, [0, 1]);
  assert.deepEqual(h.reads, [0, 1]);
  assert.equal(h.controller.head().playing, true);
  h.players[0]!.end(0);
  await flush();
  assert.deepEqual(h.reads, [0, 1, 2]);
  h.players[0]!.end(1);
  h.players[0]!.end(2);
  assert.equal(h.controller.head().playing, false);
  assert.equal(h.controller.head().busy, false);
});

test("stop fences an outstanding read and restart creates a fresh player", async () => {
  const h = harness();
  const held = deferred<ReturnType<typeof audio>>();
  h.api.readAudio = async () => held.promise;
  await h.controller.start(source);
  h.controller.stop();
  held.resolve(audio());
  await flush();
  assert.deepEqual(h.players[0]!.scheduled, []);
  assert.equal(h.controller.head().job, null);
  h.api.readAudio = async () => audio();
  await h.controller.start(source);
  await flush();
  assert.equal(h.players.length, 2);
  assert.deepEqual(h.players[1]!.scheduled, [0]);
});

test("stop fences delayed start acknowledgements and old decode completions", async () => {
  const h = harness();
  const ack = deferred<Awaited<ReturnType<typeof ttsApi.start>>>();
  h.api.start = () => ack.promise;
  const pending = h.controller.start(source);
  await flush();
  h.controller.stop();
  ack.resolve({ ok: true, snapshot: job() });
  await pending;
  assert.equal(h.controller.head().job, null);
  assert.deepEqual(h.reads, []);

  h.api.start = async () => ({ ok: true, snapshot: job() });
  const next = h.controller.start(source);
  const decode = deferred<void>();
  h.players[1]!.decode = decode.promise;
  await next;
  h.controller.stop();
  decode.resolve();
  await flush();
  assert.deepEqual(h.players[1]!.scheduled, []);
  assert.equal(h.controller.head().playing, false);
});

test("early completion events are buffered until the exact start acknowledgement", async () => {
  const h = harness();
  h.api.start = async () => {
    h.controller.handleEvent({
      kind: "job",
      snapshot: job({ readySegments: 2, totalSegments: 2, phase: "completed" }),
    });
    return { ok: true, snapshot: job({ readySegments: 0, phase: "generating" }) };
  };
  await h.controller.start(source);
  await flush();
  assert.deepEqual(h.players[0]!.scheduled, [0, 1]);
  assert.equal(h.controller.head().job!.phase, "completed");
});

test("another surface's jobs and status never cause unsolicited playback", async () => {
  const h = harness();
  h.controller.handleEvent({ kind: "job", snapshot: job() });
  assert.deepEqual(h.reads, []);
  await h.controller.preview();
  await flush();
  assert.equal(h.controller.head().job!.kind, "preview");
  h.controller.handleEvent({ kind: "job", snapshot: job({ jobId: "other", phase: "cancelled" }) });
  await h.controller.refreshStatus();
  assert.equal(h.controller.head().job!.kind, "preview");
  assert.equal(h.controller.head().playing, true);
});

test("pause works after generation completion and resume never regenerates", async () => {
  const h = harness();
  await h.controller.preview();
  await flush();
  await h.controller.pause();
  assert.equal(h.controller.head().paused, true);
  assert.equal(h.controller.head().playing, false);
  await h.controller.resume();
  assert.equal(h.controller.head().paused, false);
  assert.equal(h.controller.head().playing, true);
  assert.equal(h.players.length, 1);
  assert.deepEqual(h.reads, [0]);
});

test("invalid or non-progressing continuation fails visibly instead of looping", async () => {
  for (const bad of [
    null,
    { ...audio(), bytes: new Uint8Array(0), nextOffset: 0, complete: false },
    { ...audio(), nextOffset: 1 },
    { ...audio(), complete: false },
  ]) {
    const h = harness();
    let calls = 0;
    h.api.readAudio = async () => {
      calls += 1;
      return bad;
    };
    await h.controller.start(source);
    await flush();
    assert.equal(calls, 1);
    assert.equal(h.controller.head().error?.code, "playback_unavailable");
    assert.deepEqual(h.players[0]!.scheduled, []);
  }
});

test("latest status wins and retains its chat on status notifications", async () => {
  const h = harness();
  const initial = await h.api.status();
  const old = deferred<typeof initial>();
  h.api.status = (chatId) =>
    chatId === "old"
      ? old.promise
      : Promise.resolve({
          ...initial,
          latestSource: { source: { ...source, chatId: chatId! }, reason: "ok" },
        });
  const oldRefresh = h.controller.refreshStatus("old");
  await h.controller.refreshStatus("new");
  old.resolve(initial);
  await oldRefresh;
  assert.equal(h.controller.head().latestSource?.source?.chatId, "new");
  h.controller.handleEvent({ kind: "status" });
  await flush();
  assert.equal(h.controller.head().latestSource?.source?.chatId, "new");
});

test("dispose fences reads and an effect reactivation can start again", async () => {
  const h = harness();
  await h.controller.start(source);
  h.controller.dispose();
  h.controller.activate("different-chat");
  await h.controller.preview();
  await flush();
  assert.equal(h.players[0]!.stopped, true);
  assert.equal(h.controller.head().playing, true);
  assert.equal(h.stops(), 1);
});


test("a retained completed soundbite replays from segment zero with a fresh player", async () => {
  const h = harness();
  h.api.start = async () => ({ ok: true, snapshot: job({ phase: "completed", totalSegments: 1, readySegments: 1 }) });
  await h.controller.start(source);
  await flush();
  assert.equal(h.stops(), 0);
  h.players[0]!.end(0);
  assert.equal(h.controller.head().playing, false);
  assert.equal(h.stops(), 1, "audible completion releases the cross-device playback slot");
  h.controller.handleEvent({ kind: "job", snapshot: job({ phase: "completed", totalSegments: 1, readySegments: 1 }) });
  assert.equal(h.stops(), 1, "completion releases exactly once");
  await h.controller.start(source);
  await flush();
  assert.equal(h.players.length, 2);
  assert.deepEqual(h.reads, [0, 0]);
  assert.deepEqual(h.players[1]!.scheduled, [0]);
  assert.equal(h.controller.head().job?.jobId, "job");
  assert.equal(h.controller.head().playing, true);
});


test("a cancelled surface does not adopt another playback of the same retained job", async () => {
  const h = harness();
  await h.controller.start(source);
  await flush();
  h.controller.handleEvent({ kind: "job", snapshot: job({ phase: "cancelled" }) });
  h.controller.handleEvent({ kind: "job", snapshot: job({ phase: "completed", readySegments: 3 }) });
  await flush();
  assert.equal(h.controller.head().busy, false);
  assert.equal(h.controller.head().playing, false);
  assert.equal(h.controller.head().job?.phase, "cancelled");
  assert.equal(h.players.length, 1);
});
