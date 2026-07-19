// On-device speech-to-text via sherpa-onnx (NVIDIA Parakeet TDT). The native
// engine ships bundled with the app — no external install needed. Models are
// downloaded/managed by local-models.ts; transcription runs fully offline.

import { createRequire } from "node:module";
import { logger } from "../platform.js";
import { modelDir, isModelInstalled } from "./local-models.js";

// sherpa-onnx-node is a CommonJS native addon, externalized from the bundle.
const require = createRequire(import.meta.url);

interface OfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}
interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text: string };
}
interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => OfflineRecognizer;
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
    logger.error("parakeet", sherpaError);
    throw new Error(sherpaError);
  }
}

export function engineStatus(): { ready: boolean; error: string | null } {
  try {
    loadSherpa();
    return { ready: true, error: null };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Recognizer construction is expensive (loads ~600 MB of ONNX), so cache one per model.
const recognizers = new Map<string, OfflineRecognizer>();

function getRecognizer(modelId: string): OfflineRecognizer {
  const cached = recognizers.get(modelId);
  if (cached) return cached;

  const s = loadSherpa();
  const dir = modelDir(modelId);
  if (!dir || !isModelInstalled(modelId)) {
    throw new Error("The selected voice model isn't downloaded. Download it in Settings → Voice.");
  }
  const recognizer = new s.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${dir}/encoder.int8.onnx`,
        decoder: `${dir}/decoder.int8.onnx`,
        joiner: `${dir}/joiner.int8.onnx`,
      },
      tokens: `${dir}/tokens.txt`,
      modelType: "nemo_transducer",
      numThreads: 2,
      provider: "cpu",
      debug: false,
    },
  });
  recognizers.set(modelId, recognizer);
  logger.info("parakeet", `Loaded recognizer for "${modelId}"`);
  return recognizer;
}

/** Forget a cached recognizer (e.g. after deleting/replacing a model). */
export function releaseRecognizer(modelId: string): void {
  recognizers.delete(modelId);
}

/** Transcribe 16 kHz mono Float32 PCM using the given Parakeet model. */
export function transcribePcm(samples: Float32Array, modelId: string): string {
  if (samples.length === 0) return "";
  const recognizer = getRecognizer(modelId);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream).text.trim();
}
