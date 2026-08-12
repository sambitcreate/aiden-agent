import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GEMINI_LIVE_PCM_WORKLET_NAME,
  GeminiLivePcmChunker,
  GeminiLivePcmPlaybackQueue,
  bindDisplayCaptureLifecycle,
  resolveGeminiLivePcmWorkletUrl,
  type DisplayMediaTrack,
} from "./gemini-live-media-core.js";
import { GEMINI_LIVE_MAX_RENDERER_AUDIO_CHUNK_BYTES } from "../../main/services/gemini-live/protocol.js";

class FakeTrack implements DisplayMediaTrack {
  readonly listeners = new Set<() => void>();
  readyState = "live";
  stops = 0;

  addEventListener(_type: "ended", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "ended", listener: () => void): void {
    this.listeners.delete(listener);
  }

  stop(): void {
    this.stops += 1;
    this.readyState = "ended";
  }

  end(): void {
    this.readyState = "ended";
    for (const listener of [...this.listeners]) listener();
  }
}

test("a canceled or ended display source synchronously stops every track once", () => {
  const video = new FakeTrack();
  const audio = new FakeTrack();
  const stopped: string[] = [];
  const controller = new AbortController();
  const stop = bindDisplayCaptureLifecycle(
    { getTracks: () => [video, audio] },
    { signal: controller.signal, onStopped: (reason) => stopped.push(reason) },
  );

  video.end();
  controller.abort();
  stop();
  assert.deepEqual(stopped, ["ended"]);
  assert.equal(video.stops, 1);
  assert.equal(audio.stops, 1);
  assert.equal(video.listeners.size, 0);
  assert.equal(audio.listeners.size, 0);
});

test("an already canceled display request tears down immediately", () => {
  const track = new FakeTrack();
  const controller = new AbortController();
  controller.abort();
  const stopped: string[] = [];
  bindDisplayCaptureLifecycle(
    { getTracks: () => [track] },
    { signal: controller.signal, onStopped: (reason) => stopped.push(reason) },
  );
  assert.deepEqual(stopped, ["aborted"]);
  assert.equal(track.stops, 1);
});

test("the pure AudioWorklet counterpart resamples to mono 16 kHz signed PCM in 20 ms chunks", () => {
  const negative = new GeminiLivePcmChunker(48_000);
  assert.deepEqual(negative.push(new Float32Array(480).fill(-1)), []);
  const negativeChunks = negative.push(new Float32Array(480).fill(-1));
  assert.equal(negativeChunks.length, 1);
  assert.equal(negativeChunks[0]?.byteLength, 640);
  assert.deepEqual([...negativeChunks[0]!.slice(0, 4)], [0, 128, 0, 128]);

  const positive = new GeminiLivePcmChunker(44_100);
  const positiveChunks = positive.push(new Float32Array(882).fill(1));
  assert.equal(positiveChunks.length, 1);
  assert.deepEqual([...positiveChunks[0]!.slice(0, 4)], [255, 127, 255, 127]);
  assert.throws(() => new GeminiLivePcmChunker(8_000), /unsupported/u);
});

test("the worklet URL resolves in both packaged file and development renderer documents", () => {
  assert.equal(
    resolveGeminiLivePcmWorkletUrl("file:///Applications/Aiden/build/renderer/main-window.html"),
    "file:///Applications/Aiden/build/renderer/gemini-live-pcm-worklet.js",
  );
  assert.equal(
    resolveGeminiLivePcmWorkletUrl("http://127.0.0.1:4143/main-window.html"),
    "http://127.0.0.1:4143/gemini-live-pcm-worklet.js",
  );
});

test("the 24 kHz playback queue is bounded and interruption flushes every buffered chunk", () => {
  assert.equal(GEMINI_LIVE_MAX_RENDERER_AUDIO_CHUNK_BYTES, 96_000);
  const queue = new GeminiLivePcmPlaybackQueue(8);
  const first = Uint8Array.from([1, 0, 2, 0]);
  queue.enqueue(first);
  first[0] = 99;
  assert.equal(queue.enqueue(Uint8Array.from([3, 0, 4, 0])), 0);
  assert.equal(queue.enqueue(Uint8Array.from([5, 0, 6, 0])), 1);
  assert.equal(queue.queuedBytes, 8);
  assert.deepEqual(queue.dequeue(), Uint8Array.from([3, 0, 4, 0]));
  assert.equal(queue.flush(), 1);
  assert.equal(queue.queuedBytes, 0);
  assert.equal(queue.queuedChunks, 0);
  assert.throws(() => queue.enqueue(new Uint8Array(3)), /signed 16-bit/u);
});

test("the standalone packaged AudioWorklet keeps the reviewed chunk and transfer contract", async () => {
  const source = await readFile(
    new URL("../../public/gemini-live-pcm-worklet.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /const TARGET_SAMPLE_RATE = 16000;/u);
  assert.match(source, /const CHUNK_MS = 20;/u);
  assert.match(source, /view\.setInt16\(index \* 2, integer, true\)/u);
  assert.match(source, /channels: 1/u);
  assert.match(source, /this\.port\.postMessage\(/u);
  assert.match(source, /\[data\]/u);
  assert.match(source, new RegExp(`registerProcessor\\("${GEMINI_LIVE_PCM_WORKLET_NAME}"`, "u"));
});
