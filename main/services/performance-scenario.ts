import { constants as fsConstants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { recordDiagnosticCounter } from "./performance-diagnostics.js";

const PERFORMANCE_VOICE_BYTES = 44 + 60 * 16_000 * 2;

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function parsePerformanceVoiceWav(bytes: Buffer): Float32Array {
  if (
    bytes.byteLength !== PERFORMANCE_VOICE_BYTES ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 16) !== "WAVEfmt " ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 16_000 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString("ascii", 36, 40) !== "data" ||
    bytes.readUInt32LE(40) !== bytes.byteLength - 44
  ) {
    throw new Error("The fixed performance voice input is invalid.");
  }
  const samples = new Float32Array((bytes.byteLength - 44) / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(44 + index * 2) / 32_768;
  }
  return samples;
}

export async function readFixedPerformanceVoice(fixtureRoot: string): Promise<Float32Array> {
  const root = path.resolve(fixtureRoot);
  if ((await fs.realpath(root)) !== root) {
    throw new Error("The performance fixture root must be canonical.");
  }
  const file = path.join(root, "voice-60s.wav");
  if ((await fs.realpath(file)) !== file) {
    throw new Error("The performance voice input must not use symlinks.");
  }
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(PERFORMANCE_VOICE_BYTES)) {
      throw new Error("The fixed performance voice input has the wrong size.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || bytes.byteLength !== PERFORMANCE_VOICE_BYTES) {
      throw new Error("The performance voice input changed while it was read.");
    }
    recordDiagnosticCounter("filesystem:read:performance-voice", {
      bytesOut: bytes.byteLength,
    });
    return parsePerformanceVoiceWav(bytes);
  } finally {
    await handle.close();
  }
}

export async function runFixedVoicePerformanceScenario(input: {
  diagnosticsEnabled: boolean;
  scenario: string | undefined;
  fixtureRoot: string | undefined;
  modelId: string | undefined;
  transcribe: (samples: Float32Array, modelId: string) => string;
}): Promise<"skipped" | "model_required" | "complete"> {
  if (!input.diagnosticsEnabled || input.scenario !== "voice-long") return "skipped";
  if (!input.fixtureRoot || !input.modelId) return "model_required";
  const samples = await readFixedPerformanceVoice(input.fixtureRoot);
  input.transcribe(samples, input.modelId);
  input.transcribe(samples, input.modelId);
  return "complete";
}

export function resolveFixedVoiceBenchmarkModel(input: {
  diagnosticsEnabled: boolean;
  scenario: string | undefined;
  boundModelId: string | undefined;
  selectedModelId: string | undefined;
}): string | undefined {
  if (!input.diagnosticsEnabled || input.scenario !== "voice-long") {
    return input.selectedModelId;
  }
  if (!input.boundModelId) return undefined;
  if (input.boundModelId !== input.selectedModelId) {
    throw new Error("The selected voice model does not match the benchmark receipt.");
  }
  return input.boundModelId;
}
