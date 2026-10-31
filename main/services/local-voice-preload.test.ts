import assert from "node:assert/strict";
import test from "node:test";
import type { VoiceProviderResolution } from "../../renderer/shared/voice-provider.js";
import { createLocalVoicePreloader, localVoicePreloadRelevant } from "./local-voice-preload.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function subject(options: {
  enabled?: boolean;
  hasLocalModel?: boolean;
  resolutions: VoiceProviderResolution[];
  warm?: (modelId: string) => Promise<void>;
}) {
  const warmed: string[] = [];
  const logged: string[] = [];
  let resolves = 0;
  const preload = createLocalVoicePreloader({
    enabled: async () => options.enabled ?? true,
    hasLocalModel: async () => options.hasLocalModel ?? true,
    resolve: async () => {
      resolves += 1;
      const next = options.resolutions.shift();
      if (!next) throw new Error("no answer");
      return next;
    },
    warm: async (modelId) => {
      warmed.push(modelId);
      await options.warm?.(modelId);
    },
    log: (message) => logged.push(message),
  });
  return { preload, warmed, logged, resolves: () => resolves };
}

const local = (modelId: string): VoiceProviderResolution => ({ kind: "ready", provider: "local", modelId, automatic: true });

test("the model voice would use is loaded ahead of the first dictation", async () => {
  const { preload, warmed } = subject({ resolutions: [local("parakeet-v3")] });
  await preload();
  assert.deepEqual(warmed, ["parakeet-v3"]);
});

test("nothing loads when Load in advance is off, without even resolving the provider", async () => {
  const { preload, warmed, resolves } = subject({ enabled: false, resolutions: [local("parakeet-v3")] });
  await preload();
  assert.deepEqual(warmed, []);
  assert.equal(resolves(), 0);
});

test("a Mac with no on-device model never resolves a provider", async () => {
  const { preload, warmed, resolves } = subject({ hasLocalModel: false, resolutions: [local("parakeet-v3")] });
  await preload();
  assert.deepEqual(warmed, []);
  assert.equal(resolves(), 0);
});

test("a cloud provider or an unfinished setup loads nothing", async () => {
  const { preload, warmed } = subject({
    resolutions: [
      { kind: "ready", provider: "openai", automatic: false },
      { kind: "needs-setup", reason: "no-local-model" },
    ],
  });
  await preload();
  await preload();
  assert.deepEqual(warmed, []);
});

test("changes during a load coalesce into one more pass that loads the latest choice", async () => {
  const firstLoad = deferred();
  const { preload, warmed } = subject({
    resolutions: [local("parakeet-v3"), local("whisper-small")],
    warm: (modelId) => (modelId === "parakeet-v3" ? firstLoad.promise : Promise.resolve()),
  });
  const first = preload();
  const second = preload();
  const third = preload();
  firstLoad.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(warmed, ["parakeet-v3", "whisper-small"]);
});

test("a failed load is logged and does not stop the next request", async () => {
  const { preload, warmed, logged } = subject({
    resolutions: [local("broken"), local("parakeet-v3")],
    warm: async (modelId) => {
      if (modelId === "broken") throw new Error("model files corrupt");
    },
  });
  await preload();
  await preload();
  assert.deepEqual(warmed, ["broken", "parakeet-v3"]);
  assert.equal(logged.length, 1);
});

test("only changes that can move the chosen model ask for a preload", () => {
  assert.equal(localVoicePreloadRelevant({ localVoiceModel: "parakeet-v3" }), true);
  assert.equal(localVoicePreloadRelevant({ voiceProvider: "local" }), true);
  assert.equal(localVoicePreloadRelevant({ localVoicePreload: true }), true);
  assert.equal(localVoicePreloadRelevant({ localVoicePreload: false }), false);
  assert.equal(localVoicePreloadRelevant({ voiceTrimSilence: false }), false);
});
