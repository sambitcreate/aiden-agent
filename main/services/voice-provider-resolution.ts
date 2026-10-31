// Gathers the inputs for local-first voice provider resolution in main, so
// key presence is all that is known outside the credential store. The live
// dependencies load lazily, which keeps this module importable in tests.

import { isGeminiUsageScope } from "../../renderer/shared/gemini-usage-scope.js";
import {
  effectiveLocalModelId,
  resolveVoiceProvider,
  type VoiceProviderResolution,
} from "../../renderer/shared/voice-provider.js";
import type { AppSettings } from "./types.js";

export interface VoiceProviderResolverDeps {
  settings(): Promise<Pick<AppSettings, "voiceProvider" | "localVoiceModel" | "geminiUsageScope">>;
  /** Installed on-device model ids in catalog order. */
  installedModels(): Promise<readonly string[]>;
  /**
   * Whether the engine that runs `modelId` can load. Probing forks the speech
   * worker on first use, so it runs only when needed.
   */
  engineStatus(modelId: string): Promise<{ ready: boolean }>;
  hasOpenAIKey(): Promise<boolean>;
  hasGoogleKey(): Promise<boolean>;
}

async function orFalse(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

/**
 * The installed models dictation can use. A chosen model stands or falls with
 * its own engine. Without a usable choice, models whose engine cannot load are
 * skipped, so Parakeet on Metal failing to load falls back to an installed
 * sherpa-onnx model.
 */
async function usableLocalModels(
  installed: readonly string[],
  chosen: string | undefined,
  engineStatus: VoiceProviderResolverDeps["engineStatus"],
): Promise<{ installed: readonly string[]; engineReady: boolean }> {
  const ready = (modelId: string) => orFalse(async () => (await engineStatus(modelId)).ready);
  const effective = effectiveLocalModelId(chosen, installed);
  if (!effective) return { installed, engineReady: false };
  if (await ready(effective)) return { installed, engineReady: true };
  if (effective === chosen) return { installed, engineReady: false };
  const usable: string[] = [];
  for (const modelId of installed) {
    if (modelId !== effective && (await ready(modelId))) usable.push(modelId);
  }
  return usable.length > 0 ? { installed: usable, engineReady: true } : { installed, engineReady: false };
}

export function createVoiceProviderResolver(
  deps: VoiceProviderResolverDeps,
): () => Promise<VoiceProviderResolution> {
  return async () => {
    const settings = await deps.settings();
    let installed: readonly string[];
    try {
      installed = await deps.installedModels();
    } catch {
      installed = [];
    }
    const explicitCloud = settings.voiceProvider === "openai" || settings.voiceProvider === "gemini";
    const chosen = settings.localVoiceModel || undefined;
    const [local, hasOpenAIKey, hasGoogleKey] = await Promise.all([
      explicitCloud
        ? Promise.resolve({ installed, engineReady: false })
        : usableLocalModels(installed, chosen, deps.engineStatus),
      orFalse(deps.hasOpenAIKey),
      orFalse(deps.hasGoogleKey),
    ]);
    return resolveVoiceProvider({
      explicit: settings.voiceProvider,
      localModelId: chosen,
      installedLocalModels: local.installed,
      engineReady: local.engineReady,
      hasOpenAIKey,
      // Voice goes to Google only after the user chose a Gemini usage scope
      // (the Gemini voice setup); a chat-only Google key is not consent.
      hasGeminiVoice: hasGoogleKey && isGeminiUsageScope(settings.geminiUsageScope),
    });
  };
}

async function hasBuiltinApiKey(providerId: string): Promise<boolean> {
  const [{ listProvidersWithLegacyPiCredentialMigration }, { providerRegistry }] = await Promise.all([
    import("./legacy-pi-credential-migration.js"),
    import("./provider-registry.js"),
  ]);
  await listProvidersWithLegacyPiCredentialMigration().catch(() => undefined);
  const auth = await providerRegistry.getBuiltinRequestAuth(providerId);
  return Boolean(auth?.auth.apiKey);
}

export const resolveVoiceProviderNow = createVoiceProviderResolver({
  settings: async () => (await import("./config-store.js")).configStore.getSettings(),
  installedModels: async () =>
    (await import("./local-speech-models.js"))
      .listModels()
      .filter((model) => model.installed)
      .map((model) => model.id),
  engineStatus: async (modelId) => (await import("./local-speech.js")).engineStatus(modelId),
  hasOpenAIKey: () => hasBuiltinApiKey("openai"),
  hasGoogleKey: async () => hasBuiltinApiKey((await import("./google-provider.js")).GOOGLE_PROVIDER_ID),
});
