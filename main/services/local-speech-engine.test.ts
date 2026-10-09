import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEECH_MODELS, speechModel } from "./local-speech-catalog.js";
import { VAD_PAD_SAMPLES, type SampleRange } from "./local-speech-vad.js";
import { buildRecognizerConfig, createSpeechEngine, joinSegmentTexts, ModelMissingError, type SherpaModule } from "./local-speech-engine.js";

type FakeConfig = { modelConfig: Record<string, Record<string, unknown>> };

function fakeSherpa(options: { regions?: Array<[number, number]>; setConfigThrows?: boolean; text?: (n: number) => string } = {}) {
  const created: FakeConfig[] = [];
  const setConfigs: FakeConfig[] = [];
  const decodedLengths: number[] = [];
  let decodes = 0;
  class OfflineRecognizer {
    constructor(public config: FakeConfig) { created.push(config); }
    createStream() { return { samples: 0, acceptWaveform: function (this: { samples: number }, i: { samples: Float32Array }) { this.samples = i.samples.length; } }; }
    // Mirrors sherpa-onnx 1.13.8: only Canary and Whisper implement SetConfig;
    // every other recognizer silently ignores it.
    setConfig(config: FakeConfig) {
      if (options.setConfigThrows) throw new Error("unsupported");
      if (!("canary" in this.config.modelConfig) && !("whisper" in this.config.modelConfig)) return;
      setConfigs.push(config);
      this.config = config;
    }
    decode(stream: { samples: number }) { decodes += 1; decodedLengths.push(stream.samples); }
    getResult() { return { text: options.text?.(decodes) ?? ` part${decodes} `, lang: "<|de|>" }; }
  }
  class Vad {
    queue: Array<{ start: number; samples: Float32Array }> = [];
    constructor(public config: unknown) {}
    acceptWaveform() {}
    flush() { this.queue = (options.regions ?? []).map(([s, e]) => ({ start: s, samples: new Float32Array(e - s) })); }
    isEmpty() { return this.queue.length === 0; }
    front() { return this.queue[0]!; }
    pop() { this.queue.shift(); }
  }
  return { module: { OfflineRecognizer, Vad } as unknown as SherpaModule, created, setConfigs, decodedLengths, decodes: () => decodes };
}

/** An engine over a fake module whose model files all "exist". */
const newEngine = (module: SherpaModule) => createSpeechEngine(() => module, { exists: () => true });

const v3 = speechModel("parakeet-v3")!;
const canary = speechModel("canary-180m-flash")!;
const whisper = speechModel("whisper-turbo")!;
const sense = speechModel("sense-voice")!;
const moon = speechModel("moonshine-base-en")!;
const req = (spec = v3, extra: Partial<Parameters<ReturnType<typeof createSpeechEngine>["transcribe"]>[0]> = {}) => ({
  spec, modelDirectory: "/m", samples: new Float32Array(16_000 * 3), language: null, task: "transcribe" as const,
  trimSilence: false, vadModelPath: "/vad.onnx", ...extra,
});

test("every catalog family maps each file role into the recognizer config", () => {
  for (const spec of SPEECH_MODELS) {
    const json = JSON.stringify(buildRecognizerConfig(spec, "/dir", { language: null, task: "transcribe" }));
    for (const file of Object.values(spec.files)) assert.ok(json.includes(`/dir/${file}`), `${spec.id} missing ${file}`);
    assert.ok(json.includes('"numThreads":2') && json.includes('"provider":"cpu"'), spec.id);
  }
});

test("canary translate targets English; transcribe keeps the source language", () => {
  const t = buildRecognizerConfig(canary, "/d", { language: "de", task: "translate" }) as { modelConfig: { canary: { srcLang: string; tgtLang: string } } };
  assert.deepEqual([t.modelConfig.canary.srcLang, t.modelConfig.canary.tgtLang], ["de", "en"]);
  const s = buildRecognizerConfig(canary, "/d", { language: "fr", task: "transcribe" }) as typeof t;
  assert.deepEqual([s.modelConfig.canary.srcLang, s.modelConfig.canary.tgtLang], ["fr", "fr"]);
});

test("whisper auto passes an empty language and sense-voice uses auto", () => {
  const w = buildRecognizerConfig(whisper, "/d", { language: null, task: "transcribe" }) as { modelConfig: { whisper: { language: string } } };
  assert.equal(w.modelConfig.whisper.language, "");
  const sv = buildRecognizerConfig(sense, "/d", { language: null, task: "transcribe" }) as { modelConfig: { senseVoice: { language: string } } };
  assert.equal(sv.modelConfig.senseVoice.language, "auto");
  const m = buildRecognizerConfig(moon, "/d", { language: null, task: "transcribe" }) as { modelConfig: { moonshine: Record<string, string> } };
  assert.deepEqual(Object.keys(m.modelConfig.moonshine).sort(), ["encoder", "mergedDecoder"]);
});

test("one model slot: loading another model replaces the recognizer", () => {
  const fake = fakeSherpa();
  const engine = newEngine(fake.module);
  engine.load(v3, "/a");
  engine.load(v3, "/a");
  assert.equal(fake.created.length, 1);
  engine.load(canary, "/b");
  assert.equal(fake.created.length, 2);
  assert.equal(engine.loadedModelId(), "canary-180m-flash");
});

test("canary applies a language or task change through setConfig", () => {
  const fake = fakeSherpa();
  const engine = newEngine(fake.module);
  engine.transcribe(req(canary, { language: "de" }));
  engine.transcribe(req(canary, { language: "fr", task: "translate" }));
  assert.equal(fake.created.length, 1);
  assert.equal(fake.setConfigs.length, 1);
  assert.deepEqual(fake.setConfigs[0]!.modelConfig.canary!.srcLang, "fr");
  assert.deepEqual(fake.setConfigs[0]!.modelConfig.canary!.tgtLang, "en");
});

test("a setConfig that throws falls back to rebuilding the recognizer", () => {
  const broken = fakeSherpa({ setConfigThrows: true });
  const engine = newEngine(broken.module);
  engine.transcribe(req(canary, { language: "de" }));
  engine.transcribe(req(canary, { language: "fr" }));
  assert.equal(broken.created.length, 2);
  assert.equal(broken.created[1]!.modelConfig.canary!.srcLang, "fr");
});

test("sense-voice rebuilds on a language change because its setConfig is a no-op", () => {
  const fake = fakeSherpa();
  const engine = newEngine(fake.module);
  engine.transcribe(req(sense, { language: "ja" }));
  engine.transcribe(req(sense, { language: "ja" }));
  assert.equal(fake.created.length, 1);
  engine.transcribe(req(sense, { language: "ko" }));
  assert.equal(fake.created.length, 2);
  assert.equal(fake.created[1]!.modelConfig.senseVoice!.language, "ko");
});

test("whisper returns to auto-detect after a language hint", () => {
  const fake = fakeSherpa();
  const engine = newEngine(fake.module);
  engine.transcribe(req(whisper, { language: "de" }));
  assert.equal(fake.created[0]!.modelConfig.whisper!.language, "de");
  engine.transcribe(req(whisper, { language: null }));
  assert.equal(fake.created.length, 1);
  assert.equal(fake.setConfigs[fake.setConfigs.length - 1]!.modelConfig.whisper!.language, "");
});

test("the slot is keyed on model and directory", () => {
  const fake = fakeSherpa();
  const engine = newEngine(fake.module);
  engine.load(v3, "/a");
  engine.load(v3, "/b");
  assert.equal(fake.created.length, 2);
  assert.ok(JSON.stringify(fake.created[1]).includes("/b/"));
});

test("missing model files fail with a friendly, mappable error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-model-"));
  try {
    const fake = fakeSherpa();
    const engine = createSpeechEngine(() => fake.module);
    const roles = Object.values(v3.files);
    for (const file of roles.slice(1)) writeFileSync(path.join(dir, file), "");
    const missing = { name: "ModelMissingError", message: "The selected voice model isn't downloaded. Download it in Settings → Voice." };
    assert.throws(() => engine.load(v3, dir), missing);
    assert.throws(() => engine.transcribe(req(v3, { modelDirectory: dir })), (error) => error instanceof ModelMissingError);
    assert.equal(fake.created.length, 0);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, roles[0]!), "");
    engine.load(v3, dir);
    assert.equal(engine.loadedModelId(), "parakeet-v3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sub-second tail window is padded to 1.25 s before decode", () => {
  const fake = fakeSherpa();
  newEngine(fake.module).transcribe(req(whisper, { samples: new Float32Array(16_000 * 28 + 1_600) }));
  assert.deepEqual(fake.decodedLengths, [16_000 * 28, 20_000]);
});

test("trimmed silence decodes nothing and returns empty text", () => {
  const fake = fakeSherpa({ regions: [] });
  const result = newEngine(fake.module).transcribe(req(whisper, { trimSilence: true }));
  assert.equal(result.text, "");
  assert.equal(fake.decodes(), 0);
});

test("long whisper audio is decoded in ≤28 s windows and joined", () => {
  const fake = fakeSherpa({ regions: [[0, 16_000 * 25], [16_000 * 30, 16_000 * 55], [16_000 * 60, 16_000 * 85]] });
  const result = newEngine(fake.module).transcribe(req(whisper, { trimSilence: true, samples: new Float32Array(16_000 * 90) }));
  assert.equal(fake.decodes(), 3);
  assert.equal(result.text, "part1 part2 part3");
  assert.equal(result.language, "de");
});

test("short clips are padded to 1.25 s before decode", () => {
  const fake = fakeSherpa({ text: () => "hi" });
  const engine = newEngine(fake.module);
  const result = engine.transcribe(req(v3, { samples: new Float32Array(4000) }));
  assert.equal(result.text, "hi");
  assert.deepEqual(fake.decodedLengths, [20_000]);
});

test("CJK segments join without spaces; others with one space", () => {
  assert.equal(joinSegmentTexts(["你好", "世界"]), "你好世界");
  assert.equal(joinSegmentTexts(["hello", "world"]), "hello world");
  assert.equal(joinSegmentTexts(["hello", "", "  world "]), "hello world");
  assert.equal(joinSegmentTexts(["안녕하세요", "세계"]), "안녕하세요 세계");
  assert.equal(joinSegmentTexts(["你好。", "世界"]), "你好。世界");
  assert.equal(joinSegmentTexts(["こんにちは！", "「世界」"]), "こんにちは！「世界」");
});

test("VAD failure fails open to decoding the clip", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const fake = fakeSherpa();
  (fake.module as unknown as { Vad: unknown }).Vad = class { constructor() { throw new Error("no vad"); } };
  const result = newEngine(fake.module).transcribe(req(v3, { trimSilence: true }));
  assert.equal(fake.decodes(), 1);
  assert.ok(result.text.length > 0);
  assert.equal(warn.mock.callCount(), 1);
});

// ---- Real sherpa-onnx-node Silero VAD against the bundled model ----
// A 220 Hz tone gated at 100 ms does trigger Silero, but its region starts
// ~0.4 s late, so this uses macOS `say` speech and skips elsewhere.

const require = createRequire(import.meta.url);
const VAD_MODEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../resources/speech/silero_vad.onnx");

function realSherpa(): SherpaModule | string {
  try {
    return require("sherpa-onnx-node") as SherpaModule;
  } catch (error) {
    return `sherpa-onnx-node failed to load: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** "hello world" from macOS `say`, as 16 kHz mono float PCM. */
function spokenHelloWorld(): Float32Array | string {
  if (process.platform !== "darwin") return "needs macOS `say` to synthesize speech";
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-vad-"));
  try {
    const aiff = path.join(dir, "x.aiff");
    const wav = path.join(dir, "x.wav");
    execFileSync("say", ["-o", aiff, "hello world"]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    const bytes = readFileSync(wav);
    const dataAt = bytes.indexOf("data");
    if (dataAt < 0) return "afconvert produced no data chunk";
    const pcm = new Float32Array(bytes.readUInt32LE(dataAt + 4) / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(dataAt + 8 + i * 2) / 32768;
    return pcm;
  } catch (error) {
    return `say/afconvert unavailable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Real Silero VAD plus a recorder recognizer that notes which sample range each decode received. */
function withRealVad(real: SherpaModule, decoded: SampleRange[]): SherpaModule {
  class OfflineRecognizer {
    constructor(public config: unknown) {}
    createStream() {
      return {
        range: { start: 0, end: 0 },
        acceptWaveform(this: { range: SampleRange }, i: { samples: Float32Array }) {
          const start = i.samples.byteOffset / Float32Array.BYTES_PER_ELEMENT;
          this.range = { start, end: start + i.samples.length };
        },
        setOption() {},
      };
    }
    setConfig() {}
    decode() {}
    getResult(stream: { range: SampleRange }) { decoded.push(stream.range); return { text: "speech", lang: "" }; }
  }
  return { OfflineRecognizer, Vad: real.Vad } as unknown as SherpaModule;
}

test("real Silero VAD finds speech after a second of silence and ignores pure silence", (t) => {
  const real = realSherpa();
  if (typeof real === "string") return t.skip(real);
  const speech = spokenHelloWorld();
  if (typeof speech === "string") return t.skip(speech);
  const sr = 16_000;
  const samples = new Float32Array(sr + speech.length + sr);
  samples.set(speech, sr);
  const decoded: SampleRange[] = [];
  const result = createSpeechEngine(() => withRealVad(real, decoded), { exists: () => true }).transcribe({ ...req(whisper, { trimSilence: true, samples }), vadModelPath: VAD_MODEL });
  assert.equal(result.text, "speech");
  assert.equal(decoded.length, 1);
  const regionStart = (decoded[0]!.start + VAD_PAD_SAMPLES) / sr;
  assert.ok(regionStart >= 0.8 && regionStart <= 1.3, `speech region starts at ${regionStart}s`);

  const silent: SampleRange[] = [];
  const quiet = createSpeechEngine(() => withRealVad(real, silent), { exists: () => true }).transcribe({ ...req(whisper, { trimSilence: true, samples: new Float32Array(sr * 3) }), vadModelPath: VAD_MODEL });
  assert.equal(quiet.text, "");
  assert.equal(silent.length, 0);
});
