import assert from "node:assert/strict";
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

type WorkletMessage = Float32Array | { type: string };

/** Runs the real worklet module against a fake audio thread at `rate`. */
async function loadWorklet(rate: number) {
  const globals = globalThis as Record<string, unknown>;
  const posted: WorkletMessage[] = [];
  let Processor: (new () => unknown) | undefined;
  globals.sampleRate = rate;
  globals.AudioWorkletProcessor = class {
    readonly port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: WorkletMessage) => posted.push(message),
    };
  };
  globals.registerProcessor = (_name: string, processor: typeof Processor) => {
    Processor = processor;
  };
  type WorkletProcessor = {
    process(inputs: Float32Array[][]): boolean;
    port: { onmessage: ((event: { data: unknown }) => void) | null };
  };
  try {
    await import(`../worklets/gemini-live-pcm-worklet.js?rate=${rate}`);
    // The audio thread's `sampleRate` global is read when the processor is built.
    const processor = new Processor!() as WorkletProcessor;
    return { processor, posted };
  } finally {
    delete globals.sampleRate;
    delete globals.AudioWorkletProcessor;
    delete globals.registerProcessor;
  }
}

test("audio worklet posts mono 100 ms chunks and flushes trailing frames before acknowledging the drain", async () => {
  const { processor, posted } = await loadWorklet(1_000);
  const ramp = (from: number) => Float32Array.from({ length: 128 }, (_, index) => from + index);
  // Stereo input averages to the left channel's ramp; 300 frames is three 100-frame chunks.
  for (const from of [0, 128]) {
    assert.equal(processor.process([[ramp(from), ramp(from)]]), true);
  }
  processor.process([[ramp(256).subarray(0, 44), ramp(256).subarray(0, 44)]]);
  processor.process([[Float32Array.of(300, 301, 302), Float32Array.of(300, 301, 302)]]);
  processor.port.onmessage?.({ data: { type: "flush" } });

  const chunks = posted.filter((message): message is Float32Array => message instanceof Float32Array);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [100, 100, 100, 3],
  );
  assert.deepEqual(
    chunks.flatMap((chunk) => Array.from(chunk)),
    Array.from({ length: 303 }, (_, index) => index),
  );
  assert.deepEqual(posted[posted.length - 1], { type: "flushed" });
  // A drained worklet stops processing, so no audio follows the acknowledgement.
  assert.equal(processor.process([[ramp(0)]]), false);
});

test("PCM encoder output does not depend on how the input was split", () => {
  // At 48 kHz every third input sample lands exactly on a 16 kHz output sample.
  const input = Float32Array.from({ length: 48_000 }, (_, index) => Math.sin(index / 50) * 0.9);
  const whole = new Pcm16ChunkEncoder(48_000);
  const reference = [...whole.push(input), ...whole.flush()].flatMap(decode);
  const split = new Pcm16ChunkEncoder(48_000);
  const pieces: Uint8Array[] = [];
  let offset = 0;
  for (const size of [1, 2, 128, 5, 4_801, 127, 3, 999]) {
    pieces.push(...split.push(input.subarray(offset, offset + size)));
    offset += size;
  }
  pieces.push(...split.push(input.subarray(offset)), ...split.flush());
  const values = pieces.flatMap(decode);

  assert.equal(values.length, 16_000);
  assert.deepEqual(values, reference);
  const expected = Array.from({ length: 16_000 }, (_, index) => {
    const sample = input[index * 3];
    return sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  });
  assert.deepEqual(values, expected);
  // Every chunk before the last is exactly 100 ms.
  assert.ok(pieces.slice(0, -1).every((chunk) => chunk.byteLength === 3_200));
});
