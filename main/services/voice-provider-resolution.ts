// Gathers the inputs for local-first voice provider resolution in main, so
// key presence is all that is known outside the credential store. The live
// dependencies load lazily, which keeps this module importable in tests.

import { isGeminiUsageScope } from "../../renderer/shared/gemini-usage-scope.js";
import {
  resolveVoiceProvider,
  type VoiceProviderResolution,
} from "../../renderer/shared/voice-provider.js";
import type { AppSettings } from "./types.js";

export interface VoiceProviderResolverDeps {
  settings(): Promise<Pick<AppSettings, "voiceProvider" | "localVoiceModel" | "geminiUsageScope">>;
  /** Installed on-device model ids in catalog order. */
  installedModels(): Promise<readonly string[]>;
  /** Probing forks the speech worker on first use, so it runs only when needed. */
  engineStatus(): Promise<{ ready: boolean }>;
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
    const [engineReady, hasOpenAIKey, hasGoogleKey] = await Promise.all([
      installed.length > 0 && !explicitCloud
        ? orFalse(async () => (await deps.engineStatus()).ready)
        : Promise.resolve(false),
      orFalse(deps.hasOpenAIKey),
      orFalse(deps.hasGoogleKey),
    ]);
    return resolveVoiceProvider({
      explicit: settings.voiceProvider,
      localModelId: settings.localVoiceModel || undefined,
      installedLocalModels: installed,
      engineReady,
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
  engineStatus: async () => (await import("./local-speech.js")).engineStatus(),
  hasOpenAIKey: () => hasBuiltinApiKey("openai"),
  hasGoogleKey: async () => hasBuiltinApiKey((await import("./google-provider.js")).GOOGLE_PROVIDER_ID),
});
