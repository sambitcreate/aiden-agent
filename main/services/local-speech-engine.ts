// Engine-neutral on-device speech-to-text via sherpa-onnx. One model slot is
// loaded at a time; each catalog family maps its file roles onto sherpa's
// offline recognizer config. Electron-free so it can run in an isolated
// utility process or the CLI worker.

import { createRequire } from "node:module";
import * as path from "node:path";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import { fixedChunks, planSegments, type SampleRange } from "./local-speech-vad.js";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16_000;
const MIN_SAMPLES = SAMPLE_RATE;
const PADDED_SAMPLES = 20_000;
const VAD_WINDOW = 512;

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  setOption(key: string, value: string): void;
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

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

export function joinSegmentTexts(texts: readonly string[]): string {
  let joined = "";
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (!joined) joined = text;
    else if (CJK.test(joined[joined.length - 1]!) && CJK.test(text[0]!)) joined += text;
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

/** Families whose language/task is baked into the recognizer config rather than set per stream. */
function bakesLanguage(spec: SpeechModelSpec): boolean {
  return spec.family === "nemo-canary" || spec.family === "sense-voice";
}

function configOptions(spec: SpeechModelSpec, language: string | null, task: ConfigOptions["task"]): ConfigOptions {
  // Whisper's language is applied per stream so the recognizer stays on auto-detect.
  return bakesLanguage(spec) ? { language, task } : { language: null, task: "transcribe" };
}

function configKey(spec: SpeechModelSpec, options: ConfigOptions): string {
  return bakesLanguage(spec) ? JSON.stringify(options) : "";
}

interface Slot { id: string; configKey: string; recognizer: SherpaRecognizer }

export function createSpeechEngine(load: () => SherpaModule) {
  let slot: Slot | null = null;

  function build(spec: SpeechModelSpec, dir: string, options: ConfigOptions): Slot {
    const recognizer = new (load().OfflineRecognizer)(buildRecognizerConfig(spec, dir, options));
    slot = { id: spec.id, configKey: configKey(spec, options), recognizer };
    return slot;
  }

  function ensure(spec: SpeechModelSpec, dir: string, options: ConfigOptions): SherpaRecognizer {
    if (!slot || slot.id !== spec.id) {
      slot = null;
      return build(spec, dir, options).recognizer;
    }
    const key = configKey(spec, options);
    if (slot.configKey !== key) {
      try {
        slot.recognizer.setConfig(buildRecognizerConfig(spec, dir, options));
        slot.configKey = key;
      } catch {
        slot = null;
        return build(spec, dir, options).recognizer;
      }
    }
    return slot.recognizer;
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
      if (!slot || slot.id !== spec.id) {
        slot = null;
        build(spec, dir, configOptions(spec, null, "transcribe"));
      }
      return { loadMs: performance.now() - started };
    },

    transcribe(request: EngineTranscribeRequest): EngineTranscribeResult {
      const { spec, language, task } = request;
      if (request.samples.length === 0) return { text: "", language: null, decodeMs: 0 };
      const recognizer = ensure(spec, request.modelDirectory, configOptions(spec, language, task));
      const started = performance.now();
      let samples = request.samples;
      if (samples.length < MIN_SAMPLES) {
        const padded = new Float32Array(PADDED_SAMPLES);
        padded.set(samples);
        samples = padded;
      }
      const maxWindow = spec.capabilities.maxWindowSeconds;
      const regions = request.trimSilence ? vadRegions(samples, request.vadModelPath) : null;
      const ranges = regions ? planSegments(regions, samples.length, maxWindow) : fixedChunks(samples.length, maxWindow);
      const texts: string[] = [];
      let detected: string | null = null;
      for (const range of ranges) {
        const stream = recognizer.createStream();
        if (spec.family === "whisper" && language !== null) stream.setOption("language", language);
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: samples.subarray(range.start, range.end) });
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
