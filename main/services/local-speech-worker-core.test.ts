import assert from "node:assert/strict";
import test from "node:test";
import { speechModel, type SpeechModelSpec } from "./local-speech-catalog.js";
import { ModelMissingError, type EngineTranscribeRequest } from "./local-speech-engine.js";
import { LOCAL_SPEECH_PROTOCOL_VERSION, type LocalSpeechParentMessage } from "./local-speech-protocol.js";
import { readFile } from "node:fs/promises";
import { decodeOggOpusToPcm16k } from "./local-speech-opus.js";
import {
  createLocalSpeechMessageHandler,
  replyToWorkerFrame,
  type LocalSpeechWorkerEngine,
} from "./local-speech-worker-core.js";

const parakeet = speechModel("parakeet-v3")!;
const canary = speechModel("canary-180m-flash")!;

function fakeEngine(overrides: Partial<LocalSpeechWorkerEngine> = {}) {
  const requests: EngineTranscribeRequest[] = [];
  const loads: Array<{ spec: SpeechModelSpec; dir: string }> = [];
  let releases = 0;
  const engine: LocalSpeechWorkerEngine = {
    status: () => ({ ready: true, error: null }),
    load: (spec, dir) => {
      loads.push({ spec, dir });
      return { loadMs: 42 };
    },
    transcribe: (request) => {
      requests.push(request);
      return { text: "hallo welt", language: "de", decodeMs: 7 };
    },
    release: () => {
      releases += 1;
    },
    ...overrides,
  };
  return { engine, requests, loads, releases: () => releases };
}

function transcribe(spec: SpeechModelSpec, extra: Partial<Extract<LocalSpeechParentMessage, { kind: "transcribe" }>> = {}) {
  return {
    version: LOCAL_SPEECH_PROTOCOL_VERSION,
    kind: "transcribe",
    requestId: "t1",
    modelId: spec.id,
    modelDirectory: "/models/x",
    spec,
    audio: { kind: "pcm16", pcm: new Int16Array([0, 16_384, -32_768, 32_767]) },
    language: null,
    translate: false,
    trimSilence: true,
    vadModelPath: "/res/silero_vad.onnx",
    ...extra,
  } satisfies LocalSpeechParentMessage;
}

test("pcm16 audio reaches the engine as normalized float samples with request options", async () => {
  const fake = fakeEngine();
  const reply = await createLocalSpeechMessageHandler(fake.engine)(transcribe(parakeet));
  assert.deepEqual(reply, {
    version: 2,
    kind: "result",
    requestId: "t1",
    text: "hallo welt",
    language: "de",
    decodeMs: 7,
  });
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0]!;
  assert.deepEqual(Array.from(request.samples), [0, 0.5, -1, 32_767 / 32_768]);
  assert.equal(request.modelDirectory, "/models/x");
  assert.equal(request.trimSilence, true);
  assert.equal(request.vadModelPath, "/res/silero_vad.onnx");
  assert.equal(request.language, null);
  assert.equal(request.task, "transcribe");
});

test("translate turns into a translate task only for a capable model and a non-English source", async () => {
  const fake = fakeEngine();
  const handle = createLocalSpeechMessageHandler(fake.engine);
  await handle(transcribe(canary, { language: "de", translate: true }));
  await handle(transcribe(canary, { language: "en", translate: true }));
  await handle(transcribe(parakeet, { language: "de", translate: true }));
  await handle(transcribe(canary, { language: "de", translate: false }));
  assert.deepEqual(
    fake.requests.map((request) => request.task),
    ["translate", "transcribe", "transcribe", "transcribe"],
  );
});

test("missing model files reply with a model-missing failure", async () => {
  const fake = fakeEngine({
    transcribe: () => {
      throw new ModelMissingError();
    },
  });
  const reply = await createLocalSpeechMessageHandler(fake.engine)(transcribe(parakeet));
  assert.equal(reply.kind, "failure");
  assert.equal(reply.kind === "failure" && reply.code, "model-missing");
  assert.match(reply.kind === "failure" ? reply.message : "", /isn't downloaded/);
});

test("an engine that cannot load replies engine-unavailable", async () => {
  const fake = fakeEngine({
    status: () => ({ ready: false, error: "On-device engine failed to load: dlopen" }),
    load: () => {
      throw new Error("On-device engine failed to load: dlopen");
    },
  });
  const reply = await createLocalSpeechMessageHandler(fake.engine)({
    version: 2,
    kind: "load",
    requestId: "l1",
    modelId: parakeet.id,
    modelDirectory: "/models/x",
    spec: parakeet,
  });
  assert.equal(reply.kind === "failure" && reply.code, "engine-unavailable");
});

test("without a decoder, ogg-opus audio is reported as unsupported", async () => {
  const fake = fakeEngine();
  const reply = await createLocalSpeechMessageHandler(fake.engine)(
    transcribe(parakeet, { audio: { kind: "ogg-opus", bytes: new Uint8Array([79, 103, 103, 83]) } }),
  );
  assert.equal(reply.kind === "failure" && reply.code, "unsupported-audio");
  assert.equal(fake.requests.length, 0);
});

test("ogg-opus audio is decoded when a decoder is provided", async () => {
  const fake = fakeEngine();
  const decoded = new Float32Array([0.25, -0.25]);
  const reply = await createLocalSpeechMessageHandler(fake.engine, { decodeOggOpus: async () => decoded })(
    transcribe(parakeet, { audio: { kind: "ogg-opus", bytes: new Uint8Array([1]) } }),
  );
  assert.equal(reply.kind, "result");
  assert.equal(fake.requests[0]!.samples, decoded);
});

test("status, load and release answer with engine results", async () => {
  const fake = fakeEngine();
  const handle = createLocalSpeechMessageHandler(fake.engine);
  assert.deepEqual(await handle({ version: 2, kind: "status", requestId: "s1" }), {
    version: 2,
    kind: "result",
    requestId: "s1",
    ready: true,
    error: null,
  });
  assert.deepEqual(
    await handle({ version: 2, kind: "load", requestId: "l1", modelId: parakeet.id, modelDirectory: "/m", spec: parakeet }),
    { version: 2, kind: "result", requestId: "l1", loadMs: 42 },
  );
  assert.equal(fake.loads[0]!.dir, "/m");
  assert.deepEqual(await handle({ version: 2, kind: "release", requestId: "r1" }), {
    version: 2,
    kind: "result",
    requestId: "r1",
  });
  assert.equal(fake.releases(), 1);
});

test("a Telegram-style Ogg/Opus note reaches the engine as 16 kHz samples", async () => {
  const fake = fakeEngine();
  const bytes = new Uint8Array(await readFile(new URL("./fixtures/voice-note-440hz-left.ogg", import.meta.url)));
  const reply = await createLocalSpeechMessageHandler(fake.engine, { decodeOggOpus: decodeOggOpusToPcm16k })(
    transcribe(parakeet, { audio: { kind: "ogg-opus", bytes } }),
  );
  assert.equal(reply.kind, "result");
  assert.equal(fake.requests[0]!.samples.length, 16_000);
});

test("corrupt Ogg/Opus fails the request as decode-failed", async () => {
  const fake = fakeEngine();
  const reply = await createLocalSpeechMessageHandler(fake.engine, { decodeOggOpus: decodeOggOpusToPcm16k })(
    transcribe(parakeet, { audio: { kind: "ogg-opus", bytes: new Uint8Array(512).fill(3) } }),
  );
  assert.equal(reply.kind === "failure" && reply.code, "decode-failed");
  assert.equal(fake.requests.length, 0);
});

test("an invalid frame that names a request fails at once instead of timing out", async () => {
  const fake = fakeEngine();
  const handle = createLocalSpeechMessageHandler(fake.engine);
  const invalid = { ...transcribe(parakeet), requestId: "bad-1", language: "not a language" };
  assert.deepEqual(await replyToWorkerFrame(invalid, handle), {
    version: 2,
    kind: "failure",
    requestId: "bad-1",
    message: "Invalid on-device transcription request.",
    code: "decode-failed",
  });
  assert.equal(fake.requests.length, 0);
  assert.equal(await replyToWorkerFrame({ kind: "transcribe" }, handle), null);
  assert.equal(await replyToWorkerFrame({ requestId: "" }, handle), null);
  assert.equal(await replyToWorkerFrame("noise", handle), null);
  const valid = await replyToWorkerFrame({ version: 2, kind: "status", requestId: "s9" }, handle);
  assert.equal(valid?.kind, "result");
});
