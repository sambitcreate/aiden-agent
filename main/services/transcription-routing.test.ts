import assert from "node:assert/strict";
import test from "node:test";
import { createCloudTranscriber, createTranscribeRouter, type TranscribeRouterDeps } from "./transcription-core.js";
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

function cloudHarness(resolution: VoiceProviderResolution) {
  const calls: string[] = [];
  const transcribeCloud = createCloudTranscriber({
    resolve: async () => {
      calls.push("resolve");
      return resolution;
    },
    openai: async () => {
      calls.push("openai");
      return "openai words";
    },
    gemini: async () => {
      calls.push("gemini");
      return "gemini words";
    },
  });
  return { transcribeCloud, calls };
}

test("recorded cloud audio runs only for the provider main resolves now", async () => {
  const gemini = cloudHarness({ kind: "ready", provider: "gemini", automatic: true });
  assert.equal(await gemini.transcribeCloud(voiceNote, "gemini"), "gemini words");
  assert.deepEqual(gemini.calls, ["resolve", "gemini"]);
});

test("a stale or forged cloud provider is refused before any upload", async () => {
  const cases: Array<[VoiceProviderResolution, "openai" | "gemini"]> = [
    // A chat-only Google key does not resolve to Gemini voice.
    [{ kind: "ready", provider: "openai", automatic: true }, "gemini"],
    [{ kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: false }, "openai"],
    [{ kind: "needs-setup", reason: "no-provider" }, "gemini"],
  ];
  for (const [resolution, requested] of cases) {
    const h = cloudHarness(resolution);
    await assert.rejects(h.transcribeCloud(voiceNote, requested), { message: "Voice settings changed. Try again." });
    assert.deepEqual(h.calls, ["resolve"]);
  }
});
