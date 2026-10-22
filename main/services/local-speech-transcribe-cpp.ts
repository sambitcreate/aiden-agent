// On-device speech-to-text via transcribe.cpp (ggml) for GGUF models. On
// Apple silicon it runs Parakeet on the GPU through Metal. Electron-free and
// free of any static import of `transcribe-cpp`: the desktop speech worker
// injects the loader, so the CLI bundle never reaches the native package.

import { existsSync } from "node:fs";
import * as path from "node:path";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import {
  atLeastOneSecond,
  decodeRanges,
  joinSegmentTexts,
  ModelMissingError,
  type EngineTranscribeRequest,
  type EngineTranscribeResult,
  type SpeechRegionDetector,
} from "./local-speech-engine.js";

const SAMPLE_RATE = 16_000;
/** One second of silence: the first decode after a load compiles the GPU pipelines. */
const WARM_UP_SAMPLES = SAMPLE_RATE;

// The slice of the transcribe-cpp 0.4.0 API this engine uses.
export interface TranscribeCppSession {
  run(pcm: Float32Array, options: { timestamps: "none" }): Promise<{ text: string; language?: string }>;
  dispose(): void;
}
export interface TranscribeCppModel {
  createSession(options?: { nThreads?: number }): TranscribeCppSession;
  dispose(): void;
}
export interface TranscribeCppModule {
  initialize(): Promise<void>;
  TranscribeModel: { load(file: string, options?: { backend?: "auto" | "metal" | "cpu" }): Promise<TranscribeCppModel> };
}

/** The model needs transcribe.cpp, which this host or build cannot load. */
export class EngineUnavailableError extends Error {
  override name = "EngineUnavailableError";
}

export interface TranscribeCppEngineDeps {
  /** Loads the native module once; a rejection means the engine is unavailable here. */
  load: () => Promise<TranscribeCppModule>;
  /** Shared Silero VAD (sherpa-onnx), so trimming silence works the same on every engine. */
  detectRegions: SpeechRegionDetector;
  exists?: (filePath: string) => boolean;
}

interface Slot { id: string; directory: string; model: TranscribeCppModel; session: TranscribeCppSession }

const LANGUAGE = /^[a-z]{2,3}$/;

/**
 * transcribe-cpp finds its native library through `require.resolve`, which in
 * a packaged app answers with a path inside app.asar that dlopen cannot read.
 * The library is unpacked next to it (package.json `asarUnpack`); this is that
 * path, or null outside a packaged Apple silicon build.
 */
export function unpackedTranscribeLibrary(
  resolvePackageJson: () => string,
  platform: NodeJS.Platform,
  arch: string,
  separator: string = path.sep,
): string | null {
  if (platform !== "darwin" || arch !== "arm64") return null;
  let file: string;
  try {
    file = resolvePackageJson();
  } catch {
    return null;
  }
  const marker = `${separator}app.asar${separator}`;
  const at = file.indexOf(marker);
  if (at === -1) return null;
  const unpacked = `${file.slice(0, at)}${separator}app.asar.unpacked${separator}${file.slice(at + marker.length)}`;
  return `${unpacked.slice(0, unpacked.lastIndexOf(separator))}${separator}libtranscribe.dylib`;
}

export function createTranscribeCppEngine(deps: TranscribeCppEngineDeps) {
  const exists = deps.exists ?? existsSync;
  let module: Promise<TranscribeCppModule> | null = null;
  let slot: Slot | null = null;

  function engineModule(): Promise<TranscribeCppModule> {
    module ??= (async () => {
      try {
        const loaded = await deps.load();
        await loaded.initialize();
        return loaded;
      } catch (error) {
        throw new EngineUnavailableError(
          `The Metal voice engine failed to load: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return module;
  }

  function dropSlot(): void {
    const held = slot;
    slot = null;
    if (!held) return;
    // Production frees GPU memory by retiring the worker process; disposing
    // here covers the in-process path and a switch between GGUF models.
    try {
      held.session.dispose();
      held.model.dispose();
    } catch {
      // Already gone.
    }
  }

  async function ensure(spec: SpeechModelSpec, dir: string): Promise<Slot> {
    if (slot && slot.id === spec.id && slot.directory === dir) return slot;
    dropSlot();
    const file = spec.files.model;
    if (!file) throw new Error(`${spec.id} has no model file.`);
    const modelPath = path.join(dir, file);
    if (!exists(modelPath)) throw new ModelMissingError();
    const engine = await engineModule();
    const model = await engine.TranscribeModel.load(modelPath, { backend: "auto" });
    const session = model.createSession({});
    // A cold Metal shader cache makes the first decode slow (about 0.5 s on an
    // M1 Max), so loading pays it instead of the first dictation.
    await session.run(new Float32Array(WARM_UP_SAMPLES), { timestamps: "none" });
    slot = { id: spec.id, directory: dir, model, session };
    return slot;
  }

  return {
    async status(): Promise<{ ready: boolean; error: string | null }> {
      try {
        await engineModule();
        return { ready: true, error: null };
      } catch (error) {
        return { ready: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async load(spec: SpeechModelSpec, dir: string): Promise<{ loadMs: number }> {
      const started = performance.now();
      await ensure(spec, dir);
      return { loadMs: performance.now() - started };
    },

    async transcribe(request: EngineTranscribeRequest): Promise<EngineTranscribeResult> {
      if (request.samples.length === 0) return { text: "", language: null, decodeMs: 0 };
      const { session } = await ensure(request.spec, request.modelDirectory);
      const started = performance.now();
      const samples = atLeastOneSecond(request.samples);
      const texts: string[] = [];
      let detected: string | null = null;
      for (const range of decodeRanges(samples, request.spec, request, deps.detectRegions)) {
        const result = await session.run(atLeastOneSecond(samples.subarray(range.start, range.end)), { timestamps: "none" });
        texts.push(result.text);
        if (!detected && result.language && LANGUAGE.test(result.language)) detected = result.language;
      }
      return { text: joinSegmentTexts(texts), language: detected, decodeMs: performance.now() - started };
    },

    release(): void {
      dropSlot();
    },

    loadedModelId(): string | null {
      return slot?.id ?? null;
    },
  };
}

export type TranscribeCppEngine = ReturnType<typeof createTranscribeCppEngine>;
