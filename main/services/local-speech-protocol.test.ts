import assert from "node:assert/strict";
import test from "node:test";
import { speechModel } from "./local-speech-catalog.js";
import {
  isLocalSpeechParentMessage,
  isLocalSpeechWorkerMessage,
  LOCAL_SPEECH_PROTOCOL_VERSION,
  MAX_PCM_SAMPLES,
} from "./local-speech-protocol.js";

const spec = speechModel("parakeet-v3")!;

function transcribe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: LOCAL_SPEECH_PROTOCOL_VERSION,
    kind: "transcribe",
    requestId: "r1",
    modelId: spec.id,
    modelDirectory: "/tmp/model",
    spec,
    audio: { kind: "pcm16", pcm: new Int16Array(10) },
    language: null,
    translate: false,
    trimSilence: true,
    vadModelPath: "/tmp/silero_vad.onnx",
    ...overrides,
  };
}

test("a v2 transcribe request carrying PCM16 validates", () => {
  assert.equal(isLocalSpeechParentMessage(transcribe()), true);
});

test("PCM longer than the sample cap is rejected", () => {
  assert.equal(
    isLocalSpeechParentMessage(transcribe({ audio: { kind: "pcm16", pcm: new Int16Array(MAX_PCM_SAMPLES + 1) } })),
    false,
  );
  assert.equal(
    isLocalSpeechParentMessage(transcribe({ audio: { kind: "pcm16", pcm: new Int16Array(MAX_PCM_SAMPLES) } })),
    true,
  );
});

test("PCM that is not a typed array is rejected", () => {
  assert.equal(isLocalSpeechParentMessage(transcribe({ audio: { kind: "pcm16", pcm: [1, 2, 3] } })), false);
  assert.equal(isLocalSpeechParentMessage(transcribe({ audio: { kind: "pcm16", pcm: "AAA=" } })), false);
});

test("PCM delivered as another typed-array view or Buffer is normalized to Int16Array", () => {
  const source = new Int16Array([1, -2, 3, 32767]);
  const asBuffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const message = transcribe({ audio: { kind: "pcm16", pcm: asBuffer } });
  assert.equal(isLocalSpeechParentMessage(message), true);
  const pcm = (message.audio as { pcm: unknown }).pcm;
  assert.ok(pcm instanceof Int16Array);
  assert.deepEqual(Array.from(pcm), [1, -2, 3, 32767]);

  const odd = transcribe({ audio: { kind: "pcm16", pcm: new Uint8Array(3) } });
  assert.equal(isLocalSpeechParentMessage(odd), false);
});

test("ogg-opus audio needs non-empty bytes", () => {
  assert.equal(isLocalSpeechParentMessage(transcribe({ audio: { kind: "ogg-opus", bytes: new Uint8Array(8) } })), true);
  assert.equal(isLocalSpeechParentMessage(transcribe({ audio: { kind: "ogg-opus", bytes: new Uint8Array(0) } })), false);
  assert.equal(isLocalSpeechParentMessage(transcribe({ audio: { kind: "ogg-opus", bytes: "T2dnUw==" } })), false);
});

test("language must be a short lowercase code or null", () => {
  assert.equal(isLocalSpeechParentMessage(transcribe({ language: "Deutsch" })), false);
  assert.equal(isLocalSpeechParentMessage(transcribe({ language: "de" })), true);
  assert.equal(isLocalSpeechParentMessage(transcribe({ language: null })), true);
  assert.equal(isLocalSpeechParentMessage(transcribe({ language: undefined })), false);
});

test("translate and trimSilence must be booleans", () => {
  assert.equal(isLocalSpeechParentMessage(transcribe({ translate: "yes" })), false);
  assert.equal(isLocalSpeechParentMessage(transcribe({ trimSilence: 1 })), false);
});

test("the spec must describe the requested model", () => {
  assert.equal(isLocalSpeechParentMessage(transcribe({ modelId: "whisper-turbo" })), false);
  assert.equal(isLocalSpeechParentMessage(transcribe({ spec: { ...spec, family: "kaldi" } })), false);
  assert.equal(isLocalSpeechParentMessage(transcribe({ spec: { ...spec, files: { encoder: 3 } } })), false);
  const load = {
    version: 2,
    kind: "load",
    requestId: "l1",
    modelId: spec.id,
    modelDirectory: "/tmp/model",
    spec,
  };
  assert.equal(isLocalSpeechParentMessage(load), true);
  assert.equal(isLocalSpeechParentMessage({ ...load, spec: { ...spec, id: "other" } }), false);
});

test("version 1 frames are rejected", () => {
  assert.equal(isLocalSpeechParentMessage({ version: 1, kind: "status", requestId: "s1" }), false);
  assert.equal(isLocalSpeechParentMessage(transcribe({ version: 1 })), false);
  assert.equal(isLocalSpeechWorkerMessage({ version: 1, kind: "result", requestId: "r1", text: "hi" }), false);
  assert.equal(isLocalSpeechParentMessage({ version: 2, kind: "status", requestId: "s1" }), true);
  assert.equal(isLocalSpeechParentMessage({ version: 2, kind: "release", requestId: "x1" }), true);
});

test("worker results and failures are validated", () => {
  assert.equal(
    isLocalSpeechWorkerMessage({ version: 2, kind: "result", requestId: "r1", text: "hello", language: "en", decodeMs: 12 }),
    true,
  );
  assert.equal(isLocalSpeechWorkerMessage({ version: 2, kind: "result", requestId: "r1", text: 12 }), false);
  assert.equal(isLocalSpeechWorkerMessage({ version: 2, kind: "result", requestId: "r1", decodeMs: "fast" }), false);
  assert.equal(
    isLocalSpeechWorkerMessage({ version: 2, kind: "failure", requestId: "r1", message: "nope", code: "model-missing" }),
    true,
  );
  assert.equal(isLocalSpeechWorkerMessage({ version: 2, kind: "failure", requestId: "r1", message: "nope" }), true);
  assert.equal(
    isLocalSpeechWorkerMessage({ version: 2, kind: "failure", requestId: "r1", message: "nope", code: "exploded" }),
    false,
  );
});
