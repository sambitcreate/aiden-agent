import assert from "node:assert/strict";
import test from "node:test";
import { LivePreviewManager, LivePreviewSession, type LivePreviewOwner, type LiveTranscriptSnapshot } from "./local-speech-live-core.js";

const RATE = 16_000;

/** A manual clock and timer queue, so decode pacing is deterministic. */
function fakeTime() {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    schedule(callback: () => void, ms: number) {
      const timer = { at: now + ms, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue;
        if (timer.at <= now) timer.callback();
        else timers.push(timer);
      }
    },
  };
}

/** Decodes that the test resolves one at a time, recording each request's length. */
function fakeDecoder() {
  const pending: Array<{ samples: number; resolve: (text: string) => void; reject: (error: Error) => void }> = [];
  const lengths: number[] = [];
  return {
    decode: (pcm: Int16Array) =>
      new Promise<string>((resolve, reject) => {
        lengths.push(pcm.length);
        pending.push({ samples: pcm.length, resolve, reject });
      }),
    lengths,
    inFlight: () => pending.length,
    async answer(text: string) {
      const next = pending.shift();
      assert.ok(next, "a decode is in flight");
      next.resolve(text);
      await settle();
    },
    async fail(error: Error) {
      pending.shift()?.reject(error);
      await settle();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Syllable-like bursts: 160 ms of tone, then a 40 ms gap, as speech has between sounds. */
const speech = (ms: number) => {
  const pcm = new Int16Array((RATE * ms) / 1_000);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = index % 3_200 < 2_560 ? Math.round(6_000 * Math.sin(index / 7)) : 0;
  }
  return pcm;
};
const silence = (ms: number) => new Int16Array((RATE * ms) / 1_000);

/** Feeds audio in 100 ms chunks, the recorder's chunk size, advancing the clock as it goes. */
function feed(session: LivePreviewSession, time: ReturnType<typeof fakeTime>, pcm: Int16Array): void {
  for (let offset = 0; offset < pcm.length; offset += 1_600) {
    session.push(pcm.subarray(offset, offset + 1_600));
    time.advance(100);
  }
}

function newSession(decoder = fakeDecoder(), time = fakeTime()) {
  const snapshots: LiveTranscriptSnapshot[] = [];
  const failures: unknown[] = [];
  const session = new LivePreviewSession({
    decode: decoder.decode,
    publish: (snapshot) => snapshots.push(snapshot),
    onFailure: (error) => failures.push(error),
    now: time.now,
    schedule: time.schedule,
  });
  return { session, decoder, time, snapshots, failures };
}

test("words appear while speaking, and words two decodes agree on are committed", async () => {
  const { session, decoder, time, snapshots } = newSession();
  feed(session, time, speech(400));
  assert.equal(decoder.inFlight(), 1, "the first decode starts once there is speech to decode");
  await decoder.answer("hello");
  feed(session, time, speech(500));
  await decoder.answer("Hello world.");
  feed(session, time, speech(500));
  await decoder.answer("hello world how are");

  assert.deepEqual(snapshots, [
    { committed: "", tentative: "hello" },
    { committed: "Hello", tentative: "world." },
    { committed: "hello world", tentative: "how are" },
  ]);
});

test("only one decode runs at a time, and a slow decode spaces out the next", async () => {
  const { session, decoder, time } = newSession();
  feed(session, time, speech(400)); // the first decode starts at 200 ms
  feed(session, time, speech(1_000));
  assert.equal(decoder.inFlight(), 1, "audio arriving during a decode never queues a second");
  time.advance(600);
  await decoder.answer("one"); // took 1.8 s, so the next may start 2.7 s after the first did
  assert.equal(decoder.inFlight(), 0);
  time.advance(800);
  assert.equal(decoder.inFlight(), 0);
  time.advance(100);
  assert.equal(decoder.inFlight(), 1);
  assert.ok(decoder.lengths[1]! > decoder.lengths[0]!, "the next decode covers the audio that arrived meanwhile");
});

test("silence alone is never decoded", async () => {
  const { session, decoder, time, snapshots } = newSession();
  feed(session, time, silence(3_000));
  time.advance(1_000);
  assert.equal(decoder.lengths.length, 0);
  assert.deepEqual(snapshots, []);
});

test("a pause ends a phrase: its words stay, and later decodes cover only the new phrase", async () => {
  const { session, decoder, time, snapshots } = newSession();
  feed(session, time, speech(1_000));
  await decoder.answer("first");
  feed(session, time, silence(400));
  await decoder.answer("first phrase");
  feed(session, time, silence(700));
  // The pause ends the phrase with one decode of the phrase itself.
  const phraseLength = decoder.lengths[decoder.lengths.length - 1]!;
  assert.ok(phraseLength < RATE * 2.1, String(phraseLength));
  await decoder.answer("First phrase.");
  feed(session, time, speech(800));
  await decoder.answer("second");

  const newPhraseDecode = decoder.lengths[decoder.lengths.length - 1]!;
  assert.ok(newPhraseDecode < RATE * 1.5, `the new phrase alone is decoded, not ${newPhraseDecode} samples`);
  assert.deepEqual(snapshots[snapshots.length - 1], { committed: "First phrase.", tentative: "second" });
});

test("a long phrase without pauses is split, so no decode grows past 20 seconds", async () => {
  const { session, decoder, time } = newSession();
  for (let second = 0; second < 45; second += 1) {
    feed(session, time, speech(1_000));
    while (decoder.inFlight() > 0) await decoder.answer(`word${second}`);
  }
  assert.ok(Math.max(...decoder.lengths) <= RATE * 20, String(Math.max(...decoder.lengths)));
});

test("stopping discards a decode in flight and starts no more", async () => {
  const { session, decoder, time, snapshots } = newSession();
  feed(session, time, speech(400));
  session.stop();
  await decoder.answer("too late");
  feed(session, time, speech(2_000));
  time.advance(2_000);
  assert.deepEqual(snapshots, []);
  assert.equal(decoder.lengths.length, 1);
  assert.equal(session.active, false);
});

test("a failed decode ends the preview and reports why", async () => {
  const { session, decoder, time, failures } = newSession();
  feed(session, time, speech(400));
  await decoder.fail(new Error("model missing"));
  feed(session, time, speech(2_000));
  assert.equal(decoder.lengths.length, 1);
  assert.equal((failures[0] as Error).message, "model missing");
  assert.equal(session.active, false);
});

function owner(id: number, documentId = "doc") {
  const sent: Array<{ sessionId: string } & LiveTranscriptSnapshot> = [];
  const listeners = new Set<() => void>();
  const value: LivePreviewOwner = {
    id,
    documentId,
    send: (_channel, payload) => sent.push(payload),
    onInvalidated: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { value, sent, invalidate: () => [...listeners].forEach((listener) => listener()), listeners };
}

function newManager(supported = new Set(["parakeet-v3-metal"])) {
  const decodes: Array<{ samples: number; modelId: string }> = [];
  let ids = 0;
  const manager = new LivePreviewManager({
    supportsLivePreview: (modelId) => supported.has(modelId),
    decode: async (pcm, modelId) => {
      decodes.push({ samples: pcm.length, modelId });
      return "hello";
    },
    newId: () => `live-${(ids += 1)}`,
    schedule: () => () => {},
  });
  return { manager, decodes };
}

test("a model too slow to preview gets no session, so dictation simply waits for the final text", () => {
  const { manager } = newManager();
  assert.equal(manager.start(owner(1).value, "whisper-turbo"), null);
  assert.equal(manager.size, 0);
});

test("a preview publishes its words to the document that started it, tagged with its session", async () => {
  const { manager, decodes } = newManager();
  const mine = owner(1);
  const session = manager.start(mine.value, "parakeet-v3-metal");
  assert.ok(session);
  manager.push(mine.value, session.sessionId, speech(400));
  await settle();
  assert.deepEqual(decodes, [{ samples: 6_400, modelId: "parakeet-v3-metal" }]);
  assert.deepEqual(mine.sent, [{ sessionId: session.sessionId, committed: "", tentative: "hello" }]);
});

test("another document cannot feed or stop someone else's preview", async () => {
  const { manager, decodes } = newManager();
  const mine = owner(1);
  const other = owner(2);
  const session = manager.start(mine.value, "parakeet-v3-metal")!;
  manager.push(other.value, session.sessionId, speech(400));
  manager.stop(other.value, session.sessionId);
  await settle();
  assert.equal(decodes.length, 0);
  assert.equal(manager.size, 1);
});

test("one preview per document: a new start, a final transcription, or a reload ends the last one", () => {
  const { manager } = newManager();
  const mine = owner(1);
  const first = manager.start(mine.value, "parakeet-v3-metal")!;
  const second = manager.start(mine.value, "parakeet-v3-metal")!;
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(manager.size, 1);

  manager.stopOwner(mine.value);
  assert.equal(manager.size, 0);

  manager.start(mine.value, "parakeet-v3-metal");
  mine.invalidate();
  assert.equal(manager.size, 0);
  assert.equal(mine.listeners.size, 0, "ended sessions stop listening for invalidation");
});
