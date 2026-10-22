import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import { PillApp } from "./pill-app";
import type { VoiceProviderResolution } from "../shared/voice-provider";

afterEach(() => {
  mock.timers.reset();
  cleanup();
});

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  requestData() {
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

/** The fake audio thread's microphone samples, posted when the recorder drains it. */
let capturedSamples = new Float32Array(1_600).fill(0.25);
let decodes = 0;

class FakeAudioWorkletNode {
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: { type?: string }) => {
      if (message.type !== "flush") return;
      queueMicrotask(() => {
        if (capturedSamples.length > 0) this.port.onmessage?.({ data: capturedSamples.slice() });
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
  createAnalyser() {
    return {
      fftSize: 256,
      frequencyBinCount: 8,
      getByteFrequencyData() {},
      getByteTimeDomainData() {},
    };
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

class FakeOfflineAudioContext {
  destination = {};
  createBufferSource() {
    return { buffer: null, connect() {}, start() {} };
  }
  async startRendering() {
    return { getChannelData: () => new Float32Array(16_000) };
  }
}

function installCapture() {
  let getUserMediaCalls = 0;
  const globals = globalThis as Record<string, unknown>;
  globals.MediaRecorder = FakeMediaRecorder;
  globals.AudioContext = FakeAudioContext;
  globals.AudioWorkletNode = FakeAudioWorkletNode;
  globals.OfflineAudioContext = FakeOfflineAudioContext;
  capturedSamples = new Float32Array(1_600).fill(0.25);
  decodes = 0;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        getUserMediaCalls += 1;
        return { getTracks: () => [{ stop() {} }] };
      },
    },
  });
  (window as unknown as { aidenAPI: Record<string, unknown> }).aidenAPI.systemPreferences = {
    getMediaAccessStatus: async () => "granted",
    askForMediaAccess: async () => true,
  };
  return { getUserMediaCalls: () => getUserMediaCalls };
}

function mount(
  resolution: VoiceProviderResolution,
  transcribeLocal: () => Promise<string>,
  extraHandlers: Record<string, (...args: unknown[]) => unknown> = {},
) {
  const calls = installBotTestIpc({
    ...extraHandlers,
    "settings:get": () => ({}),
    "settings:getAppearance": () => {
      throw new Error("unavailable in tests");
    },
    "dictation:ready": () => undefined,
    "dictation:error": () => undefined,
    "dictation:progress": () => undefined,
    "dictation:result": () => undefined,
    "voice:resolveProvider": () => resolution,
    "voice:transcribeLocal": transcribeLocal,
  });
  const capture = installCapture();
  render(<PillApp />);
  return { calls, capture };
}

test("needs-setup never opens the microphone", async () => {
  const { calls, capture } = mount({ kind: "needs-setup", reason: "no-local-model" }, async () => "");
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:ready")));
  act(() => emitBotTestNotification("dictation:state", { state: "recording", operationId: "op-1" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:error")));
  assert.equal(capture.getUserMediaCalls(), 0);
  const error = calls.find((call) => call.channel === "dictation:error");
  assert.equal(error?.args[0], "op-1");
  assert.match(String(error?.args[1]), /Download a voice model/u);
});

test("a slow on-device model load shows Loading model… while transcription waits", async () => {
  let transcribing = false;
  let finish: (text: string) => void = () => {};
  const { calls } = mount({ kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true }, () => {
    transcribing = true;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:ready")));
  act(() => emitBotTestNotification("dictation:state", { state: "recording", operationId: "op-2" }));
  await screen.findByRole("button", { name: "Cancel dictation" });
  act(() => emitBotTestNotification("dictation:state", { state: "stopping", operationId: "op-2" }));
  await waitFor(() => assert.equal(transcribing, true), { timeout: 2_000 });
  assert.equal(screen.queryByText("Loading model…"), null);

  mock.timers.enable({ apis: ["setTimeout"] });
  act(() =>
    emitBotTestNotification("localVoice:state", { modelId: "parakeet-v3", state: "loading" }),
  );
  act(() => mock.timers.tick(1_900));
  assert.equal(screen.queryByText("Loading model…"), null);
  act(() => mock.timers.tick(200));
  mock.timers.reset();
  await screen.findByText("Loading model…");

  // The batch hand-off reports the recording length so main can scale its watchdog.
  const progress = calls.find((call) => call.channel === "dictation:progress");
  assert.equal(progress?.args[1], "finalizing");
  assert.equal(typeof progress?.args[2], "number");

  // The result clears the notice.
  await act(async () => finish("hello"));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:result")));
  assert.equal(screen.queryByText("Loading model…"), null);
});

test("a cloud transcription reports no recording length, so the coordinator keeps its cloud fence", async () => {
  const { calls } = mount(
    { kind: "ready", provider: "openai", automatic: false },
    async () => "",
    { "voice:transcribe": () => "hello" },
  );
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:ready")));
  act(() => emitBotTestNotification("dictation:state", { state: "recording", operationId: "op-3" }));
  await screen.findByRole("button", { name: "Cancel dictation" });
  act(() => emitBotTestNotification("dictation:state", { state: "stopping", operationId: "op-3" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:result")));

  const progress = calls.find((call) => call.channel === "dictation:progress");
  assert.equal(progress?.args[1], "finalizing");
  // Only the on-device budget scales with the recording; a cloud fence stays at its floor.
  assert.equal(progress?.args[2], undefined);
  assert.equal(calls.find((call) => call.channel === "dictation:result")?.args[1], "hello");
});

test("on-device dictation records with the press's provider and sends raw samples, with no decode", async () => {
  const voice = { kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true } as const;
  const { calls } = mount({ kind: "needs-setup", reason: "no-provider" }, async () => "hello");
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:ready")));
  act(() => emitBotTestNotification("dictation:state", { state: "recording", operationId: "op-4", voice }));
  await screen.findByRole("button", { name: "Cancel dictation" });
  act(() => emitBotTestNotification("dictation:state", { state: "stopping", operationId: "op-4" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:result")));

  // Main's answer for this press is used as is; the stale resolver would have refused.
  assert.equal(calls.some((call) => call.channel === "voice:resolveProvider"), false);
  const sent = calls.find((call) => call.channel === "voice:transcribeLocal");
  assert.ok(sent?.args[0] instanceof ArrayBuffer);
  assert.equal((sent.args[0] as ArrayBuffer).byteLength, 3_200);
  assert.equal(sent.args[1], "parakeet-v3");
  assert.equal(decodes, 0);
  assert.equal(calls.find((call) => call.channel === "dictation:result")?.args[1], "hello");
});

test("a recording that captured nothing reports an empty result instead of waiting out the watchdog", async () => {
  const voice = { kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true } as const;
  const { calls } = mount(voice, async () => "never");
  capturedSamples = new Float32Array(0);
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:ready")));
  act(() => emitBotTestNotification("dictation:state", { state: "recording", operationId: "op-5", voice }));
  await screen.findByRole("button", { name: "Cancel dictation" });
  act(() => emitBotTestNotification("dictation:state", { state: "stopping", operationId: "op-5" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "dictation:result")));
  assert.deepEqual(calls.find((call) => call.channel === "dictation:result")?.args, ["op-5", ""]);
  assert.equal(calls.some((call) => call.channel === "voice:transcribeLocal"), false);
});
