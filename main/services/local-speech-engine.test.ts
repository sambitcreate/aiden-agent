import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEECH_MODELS, speechModel } from "./local-speech-catalog.js";
import { VAD_PAD_SAMPLES, type SampleRange } from "./local-speech-vad.js";
import { buildRecognizerConfig, createSpeechEngine, joinSegmentTexts, type SherpaModule } from "./local-speech-engine.js";

function fakeSherpa(options: { regions?: Array<[number, number]>; setConfigThrows?: boolean; text?: (n: number) => string } = {}) {
  const created: unknown[] = [];
  const released: number[] = [];
  let decodes = 0;
  const streamOptions: Array<[string, string]> = [];
  class OfflineRecognizer {
    id = created.length;
    constructor(public config: unknown) { created.push(config); }
    createStream() { return { samples: 0, acceptWaveform: function (this: { samples: number }, i: { samples: Float32Array }) { this.samples = i.samples.length; }, setOption: (k: string, v: string) => streamOptions.push([k, v]) }; }
    setConfig(config: unknown) { if (options.setConfigThrows) throw new Error("unsupported"); this.config = config; }
    decode() { decodes += 1; }
    getResult(stream: { samples: number }) { return { text: options.text?.(decodes) ?? ` part${decodes} `, lang: "<|de|>", samples: stream.samples }; }
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
  return { module: { OfflineRecognizer, Vad } as unknown as SherpaModule, created, released, streamOptions, decodes: () => decodes };
}

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
  const engine = createSpeechEngine(() => fake.module);
  engine.load(v3, "/a");
  engine.load(v3, "/a");
  assert.equal(fake.created.length, 1);
  engine.load(canary, "/b");
  assert.equal(fake.created.length, 2);
  assert.equal(engine.loadedModelId(), "canary-180m-flash");
});

test("a language change uses setConfig, and rebuilds when setConfig throws", () => {
  const ok = fakeSherpa();
  const engine = createSpeechEngine(() => ok.module);
  engine.transcribe(req(canary, { language: "de" }));
  engine.transcribe(req(canary, { language: "fr" }));
  assert.equal(ok.created.length, 1);
  const broken = fakeSherpa({ setConfigThrows: true });
  const engine2 = createSpeechEngine(() => broken.module);
  engine2.transcribe(req(canary, { language: "de" }));
  engine2.transcribe(req(canary, { language: "fr" }));
  assert.equal(broken.created.length, 2);
});

test("whisper language is applied per stream", () => {
  const fake = fakeSherpa();
  createSpeechEngine(() => fake.module).transcribe(req(whisper, { language: "de" }));
  assert.deepEqual(fake.streamOptions, [["language", "de"]]);
});

test("trimmed silence decodes nothing and returns empty text", () => {
  const fake = fakeSherpa({ regions: [] });
  const result = createSpeechEngine(() => fake.module).transcribe(req(whisper, { trimSilence: true }));
  assert.equal(result.text, "");
  assert.equal(fake.decodes(), 0);
});

test("long whisper audio is decoded in ≤28 s windows and joined", () => {
  const fake = fakeSherpa({ regions: [[0, 16_000 * 25], [16_000 * 30, 16_000 * 55], [16_000 * 60, 16_000 * 85]] });
  const result = createSpeechEngine(() => fake.module).transcribe(req(whisper, { trimSilence: true, samples: new Float32Array(16_000 * 90) }));
  assert.equal(fake.decodes(), 3);
  assert.equal(result.text, "part1 part2 part3");
  assert.equal(result.language, "de");
});

test("short clips are padded to 1.25 s before decode", () => {
  const fake = fakeSherpa({ text: () => "hi" });
  const engine = createSpeechEngine(() => fake.module);
  const result = engine.transcribe(req(v3, { samples: new Float32Array(4000) }));
  assert.equal(result.text, "hi");
});

test("CJK segments join without spaces; others with one space", () => {
  assert.equal(joinSegmentTexts(["你好", "世界"]), "你好世界");
  assert.equal(joinSegmentTexts(["hello", "world"]), "hello world");
  assert.equal(joinSegmentTexts(["hello", "", "  world "]), "hello world");
});

test("VAD failure fails open to decoding the clip", () => {
  const fake = fakeSherpa();
  (fake.module as unknown as { Vad: unknown }).Vad = class { constructor() { throw new Error("no vad"); } };
  const result = createSpeechEngine(() => fake.module).transcribe(req(v3, { trimSilence: true }));
  assert.equal(fake.decodes(), 1);
  assert.ok(result.text.length > 0);
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
  const result = createSpeechEngine(() => withRealVad(real, decoded)).transcribe({ ...req(whisper, { trimSilence: true, samples }), vadModelPath: VAD_MODEL });
  assert.equal(result.text, "speech");
  assert.equal(decoded.length, 1);
  const regionStart = (decoded[0]!.start + VAD_PAD_SAMPLES) / sr;
  assert.ok(regionStart >= 0.8 && regionStart <= 1.3, `speech region starts at ${regionStart}s`);

  const silent: SampleRange[] = [];
  const quiet = createSpeechEngine(() => withRealVad(real, silent)).transcribe({ ...req(whisper, { trimSilence: true, samples: new Float32Array(sr * 3) }), vadModelPath: VAD_MODEL });
  assert.equal(quiet.text, "");
  assert.equal(silent.length, 0);
});
