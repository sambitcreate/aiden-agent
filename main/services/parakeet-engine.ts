// On-device speech-to-text via sherpa-onnx (NVIDIA Parakeet TDT).
// Electron-free so it can run in an isolated utility process.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const REQUIRED_FILE = "encoder.int8.onnx";

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
const recognizers = new Map<string, OfflineRecognizer>();

function loadSherpa(): SherpaModule {
  if (sherpa) return sherpa;
  if (sherpaError) throw new Error(sherpaError);
  try {
    sherpa = require("sherpa-onnx-node") as SherpaModule;
    return sherpa;
  } catch (error) {
    sherpaError = `On-device engine failed to load: ${error instanceof Error ? error.message : String(error)}`;
    console.error("[parakeet]", sherpaError);
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

function getRecognizer(modelId: string, modelDirectory: string): OfflineRecognizer {
  const cached = recognizers.get(modelId);
  if (cached) return cached;
  if (!existsSync(path.join(modelDirectory, REQUIRED_FILE))) {
    throw new Error("The selected voice model isn't downloaded. Download it in Settings → Voice.");
  }
  const s = loadSherpa();
  const recognizer = new s.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${modelDirectory}/encoder.int8.onnx`,
        decoder: `${modelDirectory}/decoder.int8.onnx`,
        joiner: `${modelDirectory}/joiner.int8.onnx`,
      },
      tokens: `${modelDirectory}/tokens.txt`,
      modelType: "nemo_transducer",
      numThreads: 2,
      provider: "cpu",
      debug: false,
    },
  });
  recognizers.set(modelId, recognizer);
  return recognizer;
}

export function releaseRecognizer(modelId: string): void {
  recognizers.delete(modelId);
}

export function transcribePcm(
  samples: Float32Array,
  modelId: string,
  modelDirectory: string,
): string {
  if (samples.length === 0) return "";
  const recognizer = getRecognizer(modelId, modelDirectory);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream).text.trim();
}
