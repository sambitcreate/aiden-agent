import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceProviderResolver, type VoiceProviderResolverDeps } from "./voice-provider-resolution.js";

function harness(overrides: {
  settings?: Awaited<ReturnType<VoiceProviderResolverDeps["settings"]>>;
  installed?: string[];
  engineReady?: boolean | ((modelId: string) => boolean);
  openai?: boolean;
  google?: boolean;
}) {
  let engineProbes = 0;
  const resolve = createVoiceProviderResolver({
    settings: async () => overrides.settings ?? {},
    installedModels: async () => overrides.installed ?? [],
    engineStatus: async (modelId) => {
      engineProbes += 1;
      const ready = overrides.engineReady ?? true;
      return { ready: typeof ready === "function" ? ready(modelId) : ready };
    },
    hasOpenAIKey: async () => overrides.openai ?? false,
    hasGoogleKey: async () => overrides.google ?? false,
  });
  return { resolve, probes: () => engineProbes };
}

test("a Google key without a Gemini usage scope is not voice consent", async () => {
  const chatOnly = harness({ google: true });
  assert.deepEqual(await chatOnly.resolve(), { kind: "needs-setup", reason: "no-provider" });
  const consented = harness({ google: true, settings: { geminiUsageScope: "transcription_only" } });
  assert.deepEqual(await consented.resolve(), { kind: "ready", provider: "gemini", automatic: true });
});

test("the engine is probed only when an installed model could be used", async () => {
  const none = harness({ openai: true });
  assert.equal((await none.resolve()).kind, "ready");
  assert.equal(none.probes(), 0);

  const explicitCloud = harness({ installed: ["parakeet-v3"], settings: { voiceProvider: "openai" } });
  assert.deepEqual(await explicitCloud.resolve(), { kind: "ready", provider: "openai", automatic: false });
  assert.equal(explicitCloud.probes(), 0);

  const automatic = harness({ installed: ["parakeet-v3"] });
  assert.deepEqual(await automatic.resolve(), { kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true });
  assert.equal(automatic.probes(), 1);
});

test("failing lookups resolve as absent instead of throwing", async () => {
  const resolve = createVoiceProviderResolver({
    settings: async () => ({ localVoiceModel: "" }),
    installedModels: async () => {
      throw new Error("disk");
    },
    engineStatus: async () => {
      throw new Error("fork");
    },
    hasOpenAIKey: async () => {
      throw new Error("keychain");
    },
    hasGoogleKey: async () => false,
  });
  assert.deepEqual(await resolve(), { kind: "needs-setup", reason: "no-provider" });
});

test("Parakeet on Metal failing to load falls back to an installed sherpa model, unless it was chosen", async () => {
  const metalBroken = (modelId: string) => modelId !== "parakeet-v3-metal";
  const installed = ["parakeet-v3-metal", "parakeet-v3"];

  const automatic = harness({ installed, engineReady: metalBroken, openai: true });
  assert.deepEqual(await automatic.resolve(), { kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true });

  // A chosen model stands or falls with its own engine: Automatic moves to cloud, explicit on-device says why.
  const chosen = harness({ installed, engineReady: metalBroken, openai: true, settings: { localVoiceModel: "parakeet-v3-metal" } });
  assert.deepEqual(await chosen.resolve(), { kind: "ready", provider: "openai", automatic: true });
  const explicitLocal = harness({
    installed,
    engineReady: metalBroken,
    settings: { voiceProvider: "local", localVoiceModel: "parakeet-v3-metal" },
  });
  assert.deepEqual(await explicitLocal.resolve(), { kind: "needs-setup", reason: "local-engine-unavailable" });

  const onlyMetal = harness({ installed: ["parakeet-v3-metal"], engineReady: metalBroken, openai: true });
  assert.deepEqual(await onlyMetal.resolve(), { kind: "ready", provider: "openai", automatic: true });
});
