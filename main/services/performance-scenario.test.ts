import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  parsePerformanceVoiceWav,
  resolveFixedVoiceBenchmarkModel,
  runFixedVoicePerformanceScenario,
} from "./performance-scenario.js";

function wav(): Buffer {
  const samples = 60 * 16_000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

test("the fixed voice input accepts only exact 60-second mono PCM", () => {
  assert.equal(parsePerformanceVoiceWav(wav()).length, 60 * 16_000);
  assert.throws(() => parsePerformanceVoiceWav(Buffer.alloc(44)), /voice input is invalid/u);
});

test("the voice scenario fails closed until its explicit local model exists", async () => {
  assert.equal(
    await runFixedVoicePerformanceScenario({
      diagnosticsEnabled: true,
      scenario: "voice-long",
      fixtureRoot: "/unused",
      modelId: undefined,
      transcribe: () => "",
    }),
    "model_required",
  );
});

test("voice bootstrap stays unbound until the installed model is receipt-bound", () => {
  assert.equal(
    resolveFixedVoiceBenchmarkModel({
      diagnosticsEnabled: true,
      scenario: "voice-long",
      boundModelId: undefined,
      selectedModelId: undefined,
    }),
    undefined,
  );
  assert.equal(
    resolveFixedVoiceBenchmarkModel({
      diagnosticsEnabled: true,
      scenario: "voice-long",
      boundModelId: "parakeet-v3",
      selectedModelId: "parakeet-v3",
    }),
    "parakeet-v3",
  );
  assert.throws(
    () =>
      resolveFixedVoiceBenchmarkModel({
        diagnosticsEnabled: true,
        scenario: "voice-long",
        boundModelId: "parakeet-v3",
        selectedModelId: "parakeet-v2",
      }),
    /does not match/u,
  );
});
