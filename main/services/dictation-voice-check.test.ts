import assert from "node:assert/strict";
import test from "node:test";
import type { VoiceProviderResolution } from "../../renderer/shared/voice-provider.js";
import { createPressVoiceCheck } from "./dictation-voice-check.js";

function subject(answers: Array<VoiceProviderResolution | Error>) {
  const warmed: string[] = [];
  const check = createPressVoiceCheck({
    resolve: async () => {
      const next = answers.shift();
      if (!next || next instanceof Error) throw next ?? new Error("no answer");
      return next;
    },
    warmLocal: async (modelId) => {
      warmed.push(modelId);
    },
  });
  return { check, warmed };
}

test("an on-device press warms the model it resolved", async () => {
  const { check, warmed } = subject([{ kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true }]);
  assert.deepEqual(await check.resolveVoice(), { ok: true });
  await check.warmUp();
  assert.deepEqual(warmed, ["parakeet-v3"]);
});

test("a cloud press warms nothing", async () => {
  const { check, warmed } = subject([{ kind: "ready", provider: "openai", automatic: false }]);
  await check.resolveVoice();
  await check.warmUp();
  assert.deepEqual(warmed, []);
});

test("needs-setup maps to the setup message", async () => {
  const { check } = subject([{ kind: "needs-setup", reason: "no-local-model" }]);
  assert.deepEqual(await check.resolveVoice(), {
    ok: false,
    message: "Download a voice model in Settings → Voice.",
  });
});

test("a press whose resolution throws never reuses the previous press's model", async () => {
  const { check, warmed } = subject([
    { kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true },
    new Error("keychain unavailable"),
  ]);
  await check.resolveVoice();
  await check.warmUp();
  await assert.rejects(check.resolveVoice(), /keychain/u);
  await check.warmUp();
  assert.deepEqual(warmed, ["parakeet-v3"]);
});
