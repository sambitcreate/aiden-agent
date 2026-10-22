import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import { useVoiceRecorder } from "./use-voice-recorder";

afterEach(() => cleanup());

let decodes = 0;
let mediaRecorders = 0;

class FakeAudioWorkletNode {
  static latest: FakeAudioWorkletNode | null = null;
  constructor() {
    FakeAudioWorkletNode.latest = this;
  }
  /** 100 ms of captured audio, as the capture worklet posts it while recording. */
  speak() {
    this.port.onmessage?.({ data: new Float32Array(1_600).fill(0.25) });
  }
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: { type?: string }) => {
      if (message.type !== "flush") return;
      queueMicrotask(() => {
        this.port.onmessage?.({ data: new Float32Array(1_600).fill(0.25) });
        this.port.onmessage?.({ data: { type: "flushed" } });
      });
    },
  };
  connect<T>(node: T): T {
    return node;
  }
  disconnect() {}
}

class FakeAudioContext {
  sampleRate = 16_000;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createGain() {
    return { gain: { value: 1 }, connect: <T,>(node: T) => node, disconnect() {} };
  }
  createMediaStreamSource() {
    return { connect: <T,>(node: T) => node, disconnect() {} };
  }
  async resume() {}
  async close() {}
  async decodeAudioData() {
    decodes += 1;
    return { duration: 1 };
  }
}

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  constructor() {
    mediaRecorders += 1;
  }
}

function installCapture() {
  decodes = 0;
  mediaRecorders = 0;
  const globals = globalThis as Record<string, unknown>;
  globals.AudioContext = FakeAudioContext;
  globals.AudioWorkletNode = FakeAudioWorkletNode;
  globals.MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  (window as unknown as { aidenAPI: Record<string, unknown> }).aidenAPI.systemPreferences = {
    getMediaAccessStatus: async () => "granted",
    askForMediaAccess: async () => true,
  };
}

test("composer dictation on device sends the raw recording to the model and delivers its transcript", async () => {
  const calls = installBotTestIpc({
    "voice:resolveProvider": () => ({ kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true }),
    "localVoice:warm": () => undefined,
    "voice:transcribeLocal": () => "  hello there  ",
  });
  installCapture();
  const heard: string[] = [];
  const { result } = renderHook(() => useVoiceRecorder((text) => heard.push(text), {}));
  await act(() => result.current.start());
  assert.equal(result.current.recording, true);
  act(() => result.current.stop());
  await waitFor(() => assert.deepEqual(heard, ["hello there"]));

  const sent = calls.find((call) => call.channel === "voice:transcribeLocal");
  assert.equal((sent?.args[0] as ArrayBuffer).byteLength, 3_200);
  assert.equal(sent?.args[1], "parakeet-v3");
  assert.equal(decodes, 0);
  assert.equal(mediaRecorders, 0);
  assert.equal(result.current.recording, false);
});

test("a model that can keep up shows live words while recording, and the final decode replaces them", async () => {
  const calls = installBotTestIpc({
    "voice:resolveProvider": () => ({ kind: "ready", provider: "local", modelId: "parakeet-v3-metal", automatic: true }),
    "localVoice:warm": () => undefined,
    "voice:localLiveStart": () => ({ sessionId: "live-1" }),
    "voice:localLivePush": () => undefined,
    "voice:localLiveStop": () => undefined,
    "voice:transcribeLocal": () => "Hello there, friend.",
  });
  installCapture();
  const heard: string[] = [];
  const { result } = renderHook(() => useVoiceRecorder((text) => heard.push(text), {}));
  await act(() => result.current.start());
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "voice:localLiveStart")));
  // The resampler holds one sample back, so three posts make two whole chunks.
  act(() => {
    for (let post = 0; post < 3; post += 1) FakeAudioWorkletNode.latest!.speak();
  });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "voice:localLivePush")));
  const push = calls.find((call) => call.channel === "voice:localLivePush")!;
  assert.equal(push.args[0], "live-1");
  assert.equal((push.args[1] as ArrayBuffer).byteLength, 6_400, "two 100 ms chunks of 16 kHz PCM16");

  act(() => emitBotTestNotification("voice:stream-text", { sessionId: "other", committed: "not", tentative: "mine" }));
  act(() => emitBotTestNotification("voice:stream-text", { sessionId: "live-1", committed: "hello", tentative: "there" }));
  assert.deepEqual(result.current.liveTranscript, { committed: "hello", tentative: "there" });

  act(() => result.current.stop());
  await waitFor(() => assert.deepEqual(heard, ["Hello there, friend."]));
  const order = calls.map((call) => call.channel);
  assert.ok(order.indexOf("voice:localLiveStop") < order.indexOf("voice:transcribeLocal"), order.join(", "));
  assert.deepEqual(result.current.liveTranscript, { committed: "", tentative: "" });
  // The final decode still gets the whole recording, not just what the preview saw.
  const final = calls.find((call) => call.channel === "voice:transcribeLocal")!;
  assert.ok((final.args[0] as ArrayBuffer).byteLength > 6_400);
});
