import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TtsPlayer } from "./tts-player.js";

function setup(t: TestContext) {
  const contexts: FakeContext[] = [];
  class FakeSource {
    buffer: unknown;
    onended: (() => void) | null = null;
    startAt = 0;
    stopped = false;
    disconnected = false;
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
    start(at: number) {
      this.startAt = at;
    }
    stop() {
      this.stopped = true;
    }
  }
  class FakeContext {
    state: AudioContextState = "suspended";
    currentTime = 0;
    destination = {};
    resumes = 0;
    sources: FakeSource[] = [];
    decode: Promise<{ duration: number }> = Promise.resolve({ duration: 1 });
    constructor() {
      contexts.push(this);
    }
    async resume() {
      this.state = "running";
      this.resumes += 1;
    }
    async suspend() {
      this.state = "suspended";
    }
    async close() {
      this.state = "closed";
    }
    decodeAudioData() {
      return this.decode;
    }
    createBufferSource() {
      const source = new FakeSource();
      this.sources.push(source);
      return source;
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { AudioContext: FakeContext },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return contexts;
}

test("late decoded segments stay suspended and completion reflects audible state", async (t) => {
  const contexts = setup(t);
  const ended: boolean[] = [];
  const player = new TtsPlayer({ onSegmentEnded: () => ended.push(player.isPlaying) });
  await player.prime();
  await player.playSegment(0, new Uint8Array([1]));
  await player.pause();
  await player.playSegment(1, new Uint8Array([2]));
  const context = contexts[0]!;
  assert.equal(context.resumes, 1, "enqueue must not resume a paused context");
  assert.equal(player.isPlaying, false);
  assert.equal(context.sources[1]!.startAt, context.sources[0]!.startAt + 1);
  await player.resume();
  assert.equal(player.isPlaying, true);
  context.sources[0]!.onended!();
  context.sources[1]!.onended!();
  assert.deepEqual(ended, [true, false]);
  assert.equal(player.segmentsPlayed, 2);
  assert.ok(context.sources.every((source) => source.disconnected));
  player.stop();
});

test("stop fences decode continuations and late source callbacks", async (t) => {
  const contexts = setup(t);
  let completions = 0;
  const player = new TtsPlayer({
    onSegmentEnded: () => {
      completions += 1;
    },
  });
  await player.prime();
  await player.playSegment(0, new Uint8Array([1]));
  const context = contexts[0]!;
  const lateEnded = context.sources[0]!.onended!;
  let decode!: (buffer: { duration: number }) => void;
  context.decode = new Promise((resolve) => {
    decode = resolve;
  });
  const pending = player.playSegment(1, new Uint8Array([2]));
  player.stop();
  decode({ duration: 1 });
  await pending;
  lateEnded();
  assert.equal(context.sources.length, 1);
  assert.equal(context.state, "closed");
  assert.equal(completions, 0);
  assert.equal(player.isPlaying, false);
});
