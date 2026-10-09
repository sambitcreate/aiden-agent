import assert from "node:assert/strict";
import test from "node:test";
import { createTranscribeRouter, type TranscribeRouterDeps } from "./transcription-core.js";
import type { VoiceProviderResolution } from "../../renderer/shared/voice-provider.js";

function harness(resolution: VoiceProviderResolution) {
  const calls: string[] = [];
  const decoded: Array<{ bytes: number[]; modelId: string }> = [];
  const deps: TranscribeRouterDeps = {
    resolve: async () => resolution,
    local: {
      oggOpus: async (bytes, modelId) => {
        calls.push("local");
        decoded.push({ bytes: [...bytes], modelId });
        return "on-device words";
      },
    },
    openai: async () => {
      calls.push("openai");
      return "openai words";
    },
    gemini: async () => {
      calls.push("gemini");
      return "gemini words";
    },
  };
  return { transcribe: createTranscribeRouter(deps), calls, decoded };
}

const voiceNote = { audioBase64: Buffer.from([79, 103, 103, 83]).toString("base64"), mimeType: "audio/ogg" };

test("a local resolution sends Ogg/Opus bytes on-device and never calls the cloud", async () => {
  const h = harness({ kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true });
  assert.equal(await h.transcribe(voiceNote), "on-device words");
  assert.equal(await h.transcribe({ ...voiceNote, mimeType: "audio/opus" }), "on-device words");
  assert.deepEqual(h.calls, ["local", "local"]);
  assert.deepEqual(h.decoded[0], { bytes: [79, 103, 103, 83], modelId: "parakeet-v3" });
});

test("a local resolution refuses audio it cannot decode", async () => {
  const h = harness({ kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: false });
  await assert.rejects(h.transcribe({ audioBase64: "AA==", mimeType: "audio/mpeg" }), {
    message: "This audio format needs a cloud voice provider.",
  });
  assert.deepEqual(h.calls, []);
});

test("needs-setup surfaces the setup message", async () => {
  const h = harness({ kind: "needs-setup", reason: "no-provider" });
  await assert.rejects(h.transcribe(voiceNote), { message: "Set up a voice provider in Settings → Voice." });
  assert.deepEqual(h.calls, []);
});

test("cloud resolutions keep their providers for every audio type", async () => {
  const openai = harness({ kind: "ready", provider: "openai", automatic: true });
  assert.equal(await openai.transcribe({ audioBase64: "AA==", mimeType: "audio/mpeg" }), "openai words");
  const gemini = harness({ kind: "ready", provider: "gemini", automatic: false });
  assert.equal(await gemini.transcribe(voiceNote), "gemini words");
  assert.deepEqual([...openai.calls, ...gemini.calls], ["openai", "gemini"]);
});
