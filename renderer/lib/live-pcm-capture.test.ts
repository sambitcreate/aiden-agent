import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { voiceApi } from "./ipc.js";
import { GeminiLiveCapture, OrderedPcmSendQueue, Pcm16ChunkEncoder } from "./live-pcm-capture.js";

function decode(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 2 }, (_, index) => view.getInt16(index * 2, true));
}

test("PCM encoder resamples 48 kHz continuously into 100 ms 16 kHz chunks", () => {
  const encoder = new Pcm16ChunkEncoder(48_000);
  const input = Float32Array.from({ length: 9_600 }, (_, index) => index / 9_600);
  const first = encoder.push(input.subarray(0, 4_137));
  const second = encoder.push(input.subarray(4_137));
  const tail = encoder.flush();
  const chunks = [...first, ...second, ...tail];
  assert.equal(chunks[0].byteLength, 3_200);
  assert.ok(chunks.length >= 2);
  const all = chunks.flatMap(decode);
  assert.ok(all.length >= 3_199 && all.length <= 3_201);
  assert.ok(all[all.length - 1] > all[0]);
});

test("PCM encoder clamps samples and writes little-endian signed 16-bit values", () => {
  const encoder = new Pcm16ChunkEncoder(16_000);
  encoder.push(Float32Array.from([-2, -1, 0, 1, 2]));
  const values = encoder.flush().flatMap(decode);
  assert.deepEqual(values.slice(0, 5), [-32768, -32768, 0, 32767, 32767]);
});

test("audio sends remain FIFO and drain before the caller finalizes", async () => {
  const events: string[] = [];
  const releases: Array<() => void> = [];
  const queue = new OrderedPcmSendQueue(async (value) => {
    events.push(value);
    await new Promise<void>((resolve) => releases.push(resolve));
  }, 4);
  queue.enqueue(Uint8Array.from([1, 0]));
  queue.enqueue(Uint8Array.from([2, 0]));
  const finalized = queue.drain().then(() => events.push("audio_stream_end"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["AQA="]);
  releases.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["AQA=", "AgA="]);
  releases.shift()?.();
  await finalized;
  assert.deepEqual(events, ["AQA=", "AgA=", "audio_stream_end"]);
});

test("audio queue fails closed when renderer-to-main backpressure is exceeded", async () => {
  const queue = new OrderedPcmSendQueue(() => new Promise<void>(() => {}), 1);
  queue.enqueue(Uint8Array.from([1, 0]));
  queue.enqueue(Uint8Array.from([2, 0]));
  await assert.rejects(queue.drain(), /could not keep up/u);
});

test("cancel still reaches main after live finalization has started", async () => {
  const originalWindow = globalThis.window;
  const originalOnStreamText = voiceApi.onStreamText;
  const originalStreamPush = voiceApi.streamPush;
  const originalStreamFinish = voiceApi.streamFinish;
  const originalStreamCancel = voiceApi.streamCancel;
  let cancelCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  voiceApi.onStreamText = () => () => {};
  voiceApi.streamPush = async () => {};
  voiceApi.streamFinish = () => new Promise<string>(() => {});
  voiceApi.streamCancel = async () => {
    cancelCalls += 1;
  };
  try {
    const Capture = GeminiLiveCapture as unknown as new (
      sessionId: string,
      context: AudioContext,
      source: MediaStreamAudioSourceNode,
      worklet: AudioWorkletNode,
      silentGain: GainNode,
      onTranscript: () => void,
    ) => GeminiLiveCapture;
    const capture = new Capture(
      "session-1",
      { sampleRate: 16_000, close: async () => {} } as unknown as AudioContext,
      { disconnect: () => {} } as unknown as MediaStreamAudioSourceNode,
      {
        port: { onmessage: null, onmessageerror: null, postMessage: () => {} },
        disconnect: () => {},
      } as unknown as AudioWorkletNode,
      { disconnect: () => {} } as unknown as GainNode,
      () => {},
    );
    const finishing = capture.finish();
    await Promise.resolve();
    await capture.cancel();
    await assert.rejects(finishing, /cancelled/u);
    assert.equal(cancelCalls, 1);
  } finally {
    voiceApi.onStreamText = originalOnStreamText;
    voiceApi.streamPush = originalStreamPush;
    voiceApi.streamFinish = originalStreamFinish;
    voiceApi.streamCancel = originalStreamCancel;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("audio worklet flushes trailing frames before acknowledging the drain", async () => {
  const source = await readFile(
    new URL("../worklets/gemini-live-pcm-worklet.js", import.meta.url),
    "utf8",
  );
  const tailIndex = source.indexOf("this.pending.splice(0)");
  const tailPostIndex = source.indexOf("this.port.postMessage(chunk", tailIndex);
  const acknowledgementIndex = source.indexOf('this.port.postMessage({ type: "flushed" })');
  assert.ok(tailIndex >= 0, "worklet should consume its trailing frames");
  assert.ok(tailPostIndex > tailIndex, "worklet should post its trailing frames");
  assert.ok(
    acknowledgementIndex > tailPostIndex,
    "worklet should acknowledge only after posting trailing frames",
  );
});
