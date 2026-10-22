import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { PcmRecorder } from "./pcm-recorder.js";

type PortMessage = Float32Array | { type: string };

class FakeWorkletNode {
  static latest: FakeWorkletNode | null = null;
  /** How the fake audio thread answers a flush: post its tail, then acknowledge. */
  static tail: Float32Array | null = new Float32Array(0);
  readonly port = {
    onmessage: null as ((event: { data: PortMessage }) => void) | null,
    postMessage: (message: { type?: string }) => {
      if (message.type !== "flush" || FakeWorkletNode.tail === null) return;
      const tail = FakeWorkletNode.tail;
      queueMicrotask(() => {
        if (tail.length > 0) this.emit(tail);
        this.emit({ type: "flushed" });
      });
    },
  };
  constructor() {
    FakeWorkletNode.latest = this;
  }
  emit(data: PortMessage) {
    this.port.onmessage?.({ data });
  }
  connect<T>(node: T): T {
    return node;
  }
  disconnect() {}
}

class FakeAudioContext {
  static closed = 0;
  readonly sampleRate: number;
  readonly destination = {};
  readonly audioWorklet = { addModule: async () => {} };
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48_000;
  }
  createMediaStreamSource() {
    return { connect: <T>(node: T) => node, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect: <T>(node: T) => node, disconnect() {} };
  }
  async resume() {}
  async close() {
    FakeAudioContext.closed += 1;
  }
}

const globals = globalThis as Record<string, unknown>;
const original = { AudioContext: globals.AudioContext, AudioWorkletNode: globals.AudioWorkletNode };

beforeEach(() => {
  FakeAudioContext.closed = 0;
  FakeWorkletNode.latest = null;
  FakeWorkletNode.tail = new Float32Array(0);
  globals.AudioContext = FakeAudioContext;
  globals.AudioWorkletNode = FakeWorkletNode;
});

afterEach(() => {
  mock.timers.reset();
  globals.AudioContext = original.AudioContext;
  globals.AudioWorkletNode = original.AudioWorkletNode;
});

async function recording() {
  const recorder = await PcmRecorder.create({} as MediaStream);
  const worklet = FakeWorkletNode.latest!;
  let stops = 0;
  recorder.onstop = () => {
    stops += 1;
  };
  recorder.start();
  return { recorder, worklet, stops: () => stops };
}

function untilStopped(subject: { stops: () => number }) {
  return new Promise<void>((resolve) => {
    const check = () => (subject.stops() > 0 ? resolve() : setImmediate(check));
    check();
  });
}

test("a stopped recording hands over every sample, including the worklet's tail", async () => {
  FakeWorkletNode.tail = new Float32Array(400).fill(-0.25);
  const subject = await recording();
  subject.worklet.emit(new Float32Array(1_600).fill(0.5));
  subject.recorder.stop();
  assert.equal(subject.recorder.state, "inactive");
  await untilStopped(subject);

  const pcm = subject.recorder.takePcm();
  // 0.1 s of speech plus the 25 ms tail, at 16 kHz, with nothing to decode.
  assert.equal(pcm.length, 2_000);
  assert.equal(pcm[0], 16_384);
  assert.equal(pcm[1_999], -8_192);
  assert.equal(pcm.buffer.byteLength, pcm.byteLength);
  assert.equal(subject.stops(), 1);
  assert.equal(FakeAudioContext.closed, 1);
});

test("an audio thread that never drains still delivers what arrived", async () => {
  FakeWorkletNode.tail = null;
  mock.timers.enable({ apis: ["setTimeout"] });
  const subject = await recording();
  subject.worklet.emit(new Float32Array(1_600).fill(0.5));
  subject.recorder.stop();
  assert.equal(subject.stops(), 0);
  mock.timers.tick(500);
  assert.equal(subject.stops(), 1);
  assert.equal(subject.recorder.takePcm().length, 1_600);
});

test("a discarded recording never reports a stop, even if the drain lands late", async () => {
  FakeWorkletNode.tail = null;
  const subject = await recording();
  subject.worklet.emit(new Float32Array(1_600).fill(0.5));
  subject.recorder.stop();
  subject.recorder.dispose();
  subject.worklet.emit({ type: "flushed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.stops(), 0);
  assert.equal(FakeAudioContext.closed, 1);
  subject.recorder.dispose();
  assert.equal(FakeAudioContext.closed, 1);
});
