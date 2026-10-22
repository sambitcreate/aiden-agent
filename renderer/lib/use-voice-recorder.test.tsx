import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { useVoiceRecorder } from "./use-voice-recorder";

afterEach(() => cleanup());

let decodes = 0;
let mediaRecorders = 0;

class FakeAudioWorkletNode {
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
