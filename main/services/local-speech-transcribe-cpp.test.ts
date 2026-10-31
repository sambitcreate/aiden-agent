import assert from "node:assert/strict";
import test from "node:test";
import { speechModel } from "./local-speech-catalog.js";
import { ModelMissingError, type EngineTranscribeRequest } from "./local-speech-engine.js";
import {
  createTranscribeCppEngine,
  EngineUnavailableError,
  unpackedTranscribeLibrary,
  type TranscribeCppModule,
} from "./local-speech-transcribe-cpp.js";

const metal = speechModel("parakeet-v3-metal")!;
const otherGguf = { ...metal, id: "other-gguf", files: { model: "other.gguf" } };

function fakeTranscribeCpp(options: { text?: (run: number) => string; language?: string } = {}) {
  const loads: Array<{ file: string; backend: string | undefined }> = [];
  const runs: number[] = [];
  const disposed: string[] = [];
  let initialized = 0;
  const module: TranscribeCppModule = {
    async initialize() {
      initialized += 1;
    },
    TranscribeModel: {
      async load(file, loadOptions) {
        loads.push({ file, backend: loadOptions?.backend });
        return {
          createSession: () => ({
            async run(pcm) {
              runs.push(pcm.length);
              return { text: options.text?.(runs.length) ?? `part${runs.length}`, language: options.language };
            },
            dispose: () => disposed.push(`session:${file}`),
          }),
          dispose: () => disposed.push(`model:${file}`),
        };
      },
    },
  };
  return { module, loads, runs, disposed, initialized: () => initialized };
}

function request(extra: Partial<EngineTranscribeRequest> = {}): EngineTranscribeRequest {
  return {
    spec: metal,
    modelDirectory: "/models/metal",
    samples: new Float32Array(16_000 * 3),
    language: null,
    task: "transcribe",
    trimSilence: false,
    vadModelPath: "/res/silero_vad.onnx",
    ...extra,
  };
}

test("loading pays the GPU warm-up once and later dictations reuse the session", async () => {
  const fake = fakeTranscribeCpp({ language: "en" });
  const engine = createTranscribeCppEngine({ load: async () => fake.module, detectRegions: () => null, exists: () => true });

  await engine.load(metal, "/models/metal");
  assert.deepEqual(fake.loads, [{ file: "/models/metal/parakeet-tdt-0.6b-v3-Q8_0.gguf", backend: "auto" }]);
  assert.deepEqual(fake.runs, [16_000], "one second of silence compiles the GPU pipelines");
  assert.equal(engine.loadedModelId(), metal.id);

  const first = await engine.transcribe(request());
  const second = await engine.transcribe(request({ samples: new Float32Array(16_000 * 2) }));
  assert.equal(fake.loads.length, 1);
  assert.equal(fake.initialized(), 1);
  assert.deepEqual(fake.runs, [16_000, 48_000, 32_000]);
  assert.equal(first.text, "part2");
  assert.equal(second.text, "part3");
  assert.equal(first.language, "en");
});

test("trimming silence drops the quiet lead-in and tail before decoding", async () => {
  const fake = fakeTranscribeCpp({ text: (run) => (run === 2 ? "hello world" : "") });
  const engine = createTranscribeCppEngine({
    load: async () => fake.module,
    detectRegions: () => [
      { start: 32_000, end: 56_000 },
      { start: 96_000, end: 120_000 },
    ],
    exists: () => true,
  });
  const result = await engine.transcribe(request({ samples: new Float32Array(16_000 * 10), trimSilence: true }));
  assert.equal(result.text, "hello world");
  // Warm-up, then one decode spanning the speech (plus padding), not all ten seconds.
  assert.equal(fake.runs.length, 2);
  const decoded = fake.runs[1]!;
  assert.ok(decoded >= 120_000 - 32_000 && decoded < 16_000 * 7, String(decoded));
});

test("a missing GGUF file is model-missing and nothing is loaded", async () => {
  const fake = fakeTranscribeCpp();
  const engine = createTranscribeCppEngine({ load: async () => fake.module, detectRegions: () => null, exists: () => false });
  await assert.rejects(engine.transcribe(request()), (error: unknown) => error instanceof ModelMissingError);
  assert.equal(fake.loads.length, 0);
});

test("a native library that will not load makes the engine unavailable, with the reason", async () => {
  const engine = createTranscribeCppEngine({
    load: async () => {
      throw new Error("dlopen(libtranscribe.dylib): image not found");
    },
    detectRegions: () => null,
    exists: () => true,
  });
  await assert.rejects(engine.load(metal, "/models/metal"), (error: unknown) => {
    assert.ok(error instanceof EngineUnavailableError);
    assert.match(error.message, /image not found/);
    return true;
  });
  const status = await engine.status();
  assert.equal(status.ready, false);
  assert.match(status.error ?? "", /Metal voice engine failed to load/);
});

test("switching GGUF models or releasing frees the GPU session and model", async () => {
  const fake = fakeTranscribeCpp();
  const engine = createTranscribeCppEngine({ load: async () => fake.module, detectRegions: () => null, exists: () => true });
  await engine.load(metal, "/models/metal");
  await engine.load(otherGguf, "/models/other");
  assert.deepEqual(fake.disposed, [
    "session:/models/metal/parakeet-tdt-0.6b-v3-Q8_0.gguf",
    "model:/models/metal/parakeet-tdt-0.6b-v3-Q8_0.gguf",
  ]);
  engine.release();
  assert.equal(engine.loadedModelId(), null);
  assert.equal(fake.disposed.length, 4);
});

test("empty audio returns no text without loading the model", async () => {
  const fake = fakeTranscribeCpp();
  const engine = createTranscribeCppEngine({ load: async () => fake.module, detectRegions: () => null, exists: () => true });
  assert.deepEqual(await engine.transcribe(request({ samples: new Float32Array(0) })), { text: "", language: null, decodeMs: 0 });
  assert.equal(fake.loads.length, 0);
});

test("a packaged Apple silicon app loads the native library from app.asar.unpacked", () => {
  const packaged = "/Applications/Aiden Agent.app/Contents/Resources/app.asar/node_modules/@transcribe-cpp/darwin-arm64-metal/package.json";
  assert.equal(
    unpackedTranscribeLibrary(() => packaged, "darwin", "arm64", "/"),
    "/Applications/Aiden Agent.app/Contents/Resources/app.asar.unpacked/node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib",
  );
  // A development checkout resolves real files, so the binding finds them itself.
  assert.equal(unpackedTranscribeLibrary(() => "/src/aiden/node_modules/@transcribe-cpp/darwin-arm64-metal/package.json", "darwin", "arm64", "/"), null);
  assert.equal(unpackedTranscribeLibrary(() => packaged, "darwin", "x64", "/"), null);
  assert.equal(unpackedTranscribeLibrary(() => packaged, "linux", "arm64", "/"), null);
  assert.equal(
    unpackedTranscribeLibrary(() => {
      throw new Error("Cannot find module");
    }, "darwin", "arm64", "/"),
    null,
  );
});
