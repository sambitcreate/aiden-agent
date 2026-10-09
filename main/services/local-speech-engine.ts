// Engine-neutral on-device speech-to-text via sherpa-onnx. One model slot is
// loaded at a time; each catalog family maps its file roles onto sherpa's
// offline recognizer config. Electron-free so it can run in an isolated
// utility process or the CLI worker.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import { fixedChunks, planSegments, type SampleRange } from "./local-speech-vad.js";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16_000;
const MIN_SAMPLES = SAMPLE_RATE;
const PADDED_SAMPLES = 20_000;
const VAD_WINDOW = 512;

/** Thrown when an installed model is missing files; workers can map it by `name`. */
export class ModelMissingError extends Error {
  override name = "ModelMissingError";
  constructor() {
    super("The selected voice model isn't downloaded. Download it in Settings → Voice.");
  }
}

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}
interface SherpaRecognizer {
  createStream(): SherpaStream;
  setConfig(config: unknown): void;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { text: string; lang?: string };
}
interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  flush(): void;
  isEmpty(): boolean;
  front(): { start: number; samples: Float32Array };
  pop(): void;
}
export interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad;
}

export interface EngineTranscribeRequest {
  spec: SpeechModelSpec;
  modelDirectory: string;
  samples: Float32Array;
  language: string | null;
  task: "transcribe" | "translate";
  trimSilence: boolean;
  vadModelPath: string;
}
export interface EngineTranscribeResult { text: string; language: string | null; decodeMs: number }

type ConfigOptions = { language: string | null; task: "transcribe" | "translate" };

export function buildRecognizerConfig(spec: SpeechModelSpec, dir: string, opts: ConfigOptions): Record<string, unknown> {
  const file = (role: string): string => {
    const relative = spec.files[role];
    if (!relative) throw new Error(`${spec.id} has no ${role} file.`);
    return path.join(dir, relative);
  };
  const { language, task } = opts;
  let family: Record<string, unknown>;
  switch (spec.family) {
    case "nemo-transducer":
      family = { transducer: { encoder: file("encoder"), decoder: file("decoder"), joiner: file("joiner") }, modelType: "nemo_transducer" };
      break;
    case "nemo-canary":
      family = {
        canary: {
          encoder: file("encoder"),
          decoder: file("decoder"),
          srcLang: language ?? "en",
          tgtLang: task === "translate" ? "en" : (language ?? "en"),
          usePnc: 1,
        },
      };
      break;
    case "whisper":
      family = { whisper: { encoder: file("encoder"), decoder: file("decoder"), language: language ?? "", task: "transcribe" } };
      break;
    case "sense-voice":
      family = { senseVoice: { model: file("model"), language: language ?? "auto", useInverseTextNormalization: 1 } };
      break;
    case "moonshine-v2":
      family = { moonshine: { encoder: file("encoder"), mergedDecoder: file("mergedDecoder") } };
      break;
  }
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { tokens: file("tokens"), numThreads: 2, provider: "cpu", debug: 0, ...family },
  };
}

// Scripts written without spaces between words: CJK punctuation, kana,
// Han ideographs and full-width forms. Hangul is spaced like Latin text.
const NO_SPACE_SCRIPT = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/;

export function joinSegmentTexts(texts: readonly string[]): string {
  let joined = "";
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (!joined) joined = text;
    else if (NO_SPACE_SCRIPT.test(joined[joined.length - 1]!) && NO_SPACE_SCRIPT.test(text[0]!)) joined += text;
    else joined += ` ${text}`;
  }
  return joined;
}

const LANGUAGE_TAG = /<\|([a-z]{2,3})\|>|^([a-z]{2,3})$/;

function detectedLanguage(lang: unknown): string | null {
  if (typeof lang !== "string") return null;
  const match = LANGUAGE_TAG.exec(lang.trim());
  return match ? (match[1] ?? match[2] ?? null) : null;
}

// How a language/task change reaches a loaded recognizer. sherpa-onnx 1.13.8
// implements SetConfig only for Canary and Whisper; every other recognizer's
// SetConfig is a silent no-op, so SenseVoice must be rebuilt.
type LanguageUpdate = "setConfig" | "rebuild" | "none";

function languageUpdate(spec: SpeechModelSpec): LanguageUpdate {
  if (spec.family === "nemo-canary" || spec.family === "whisper") return "setConfig";
  if (spec.family === "sense-voice") return "rebuild";
  return "none";
}

function configOptions(spec: SpeechModelSpec, language: string | null, task: ConfigOptions["task"]): ConfigOptions {
  if (spec.family === "nemo-canary") return { language, task };
  if (spec.family === "whisper" || spec.family === "sense-voice") return { language, task: "transcribe" };
  return { language: null, task: "transcribe" };
}

function configKey(spec: SpeechModelSpec, options: ConfigOptions): string {
  return languageUpdate(spec) === "none" ? "" : JSON.stringify(options);
}

/** Recognizers misbehave on sub-second input, so short audio is zero-padded to 1.25 s. */
function atLeastOneSecond(samples: Float32Array): Float32Array {
  if (samples.length >= MIN_SAMPLES) return samples;
  const padded = new Float32Array(PADDED_SAMPLES);
  padded.set(samples);
  return padded;
}

interface Slot { id: string; directory: string; configKey: string; recognizer: SherpaRecognizer }

export interface SpeechEngineDeps {
  /** File probe used before building a recognizer (defaults to `existsSync`). */
  exists?: (filePath: string) => boolean;
}

export function createSpeechEngine(load: () => SherpaModule, deps: SpeechEngineDeps = {}) {
  const exists = deps.exists ?? existsSync;
  let slot: Slot | null = null;

  function holds(spec: SpeechModelSpec, dir: string): boolean {
    return slot !== null && slot.id === spec.id && slot.directory === dir;
  }

  function build(spec: SpeechModelSpec, dir: string, options: ConfigOptions): Slot {
    slot = null;
    for (const relative of Object.values(spec.files)) {
      if (!exists(path.join(dir, relative))) throw new ModelMissingError();
    }
    const recognizer = new (load().OfflineRecognizer)(buildRecognizerConfig(spec, dir, options));
    slot = { id: spec.id, directory: dir, configKey: configKey(spec, options), recognizer };
    return slot;
  }

  function ensure(spec: SpeechModelSpec, dir: string, options: ConfigOptions): SherpaRecognizer {
    if (!slot || !holds(spec, dir)) return build(spec, dir, options).recognizer;
    const key = configKey(spec, options);
    if (slot.configKey === key) return slot.recognizer;
    if (languageUpdate(spec) === "setConfig") {
      try {
        slot.recognizer.setConfig(buildRecognizerConfig(spec, dir, options));
        slot.configKey = key;
        return slot.recognizer;
      } catch {
        // Fall through to a rebuild with the new language.
      }
    }
    return build(spec, dir, options).recognizer;
  }

  function vadRegions(samples: Float32Array, vadModelPath: string): SampleRange[] | null {
    try {
      const vad = new (load().Vad)(
        {
          sileroVad: { model: vadModelPath, threshold: 0.3, minSilenceDuration: 0.45, minSpeechDuration: 0.06, windowSize: VAD_WINDOW, maxSpeechDuration: 28 },
          sampleRate: SAMPLE_RATE,
          numThreads: 1,
          provider: "cpu",
          debug: 0,
        },
        60,
      );
      const regions: SampleRange[] = [];
      const drain = () => {
        while (!vad.isEmpty()) {
          const segment = vad.front();
          regions.push({ start: segment.start, end: segment.start + segment.samples.length });
          vad.pop();
        }
      };
      for (let offset = 0; offset < samples.length; offset += VAD_WINDOW) {
        vad.acceptWaveform(samples.subarray(offset, Math.min(samples.length, offset + VAD_WINDOW)));
        drain();
      }
      vad.flush();
      drain();
      return regions;
    } catch (error) {
      console.warn(`Voice activity detection failed; decoding the whole clip: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return {
    status(): { ready: boolean; error: string | null } {
      try {
        load();
        return { ready: true, error: null };
      } catch (error) {
        return { ready: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    load(spec: SpeechModelSpec, dir: string): { loadMs: number } {
      const started = performance.now();
      if (!holds(spec, dir)) build(spec, dir, configOptions(spec, null, "transcribe"));
      return { loadMs: performance.now() - started };
    },

    transcribe(request: EngineTranscribeRequest): EngineTranscribeResult {
      const { spec, language, task } = request;
      if (request.samples.length === 0) return { text: "", language: null, decodeMs: 0 };
      const recognizer = ensure(spec, request.modelDirectory, configOptions(spec, language, task));
      const started = performance.now();
      const samples = atLeastOneSecond(request.samples);
      const maxWindow = spec.capabilities.maxWindowSeconds;
      const regions = request.trimSilence ? vadRegions(samples, request.vadModelPath) : null;
      const ranges = regions ? planSegments(regions, samples.length, maxWindow) : fixedChunks(samples.length, maxWindow);
      const texts: string[] = [];
      let detected: string | null = null;
      for (const range of ranges) {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: atLeastOneSecond(samples.subarray(range.start, range.end)) });
        recognizer.decode(stream);
        const result = recognizer.getResult(stream);
        texts.push(result.text);
        detected ??= detectedLanguage(result.lang);
      }
      return { text: joinSegmentTexts(texts), language: detected, decodeMs: performance.now() - started };
    },

    release(): void {
      slot = null;
    },

    loadedModelId(): string | null {
      return slot?.id ?? null;
    },
  };
}

let sherpa: SherpaModule | null = null;
let sherpaError: string | null = null;

function loadSherpa(): SherpaModule {
  if (sherpa) return sherpa;
  if (sherpaError) throw new Error(sherpaError);
  try {
    sherpa = require("sherpa-onnx-node") as SherpaModule;
    return sherpa;
  } catch (error) {
    sherpaError = `On-device engine failed to load: ${error instanceof Error ? error.message : String(error)}`;
    throw new Error(sherpaError);
  }
}

export const speechEngine = createSpeechEngine(loadSherpa);
