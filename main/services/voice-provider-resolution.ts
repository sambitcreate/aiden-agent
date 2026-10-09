// Gathers the inputs for local-first voice provider resolution in main, so
// key presence is all that is known outside the credential store.

import { isGeminiUsageScope } from "../../renderer/shared/gemini-usage-scope.js";
import {
  resolveVoiceProvider,
  type VoiceProviderResolution,
} from "../../renderer/shared/voice-provider.js";
import { configStore } from "./config-store.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import { listProvidersWithLegacyPiCredentialMigration } from "./legacy-pi-credential-migration.js";
import { engineStatus } from "./local-speech.js";
import { listModels } from "./local-speech-models.js";
import { providerRegistry } from "./provider-registry.js";

async function hasApiKey(providerId: string): Promise<boolean> {
  try {
    const auth = await providerRegistry.getBuiltinRequestAuth(providerId);
    return Boolean(auth?.auth.apiKey);
  } catch {
    return false;
  }
}

function installedLocalModels(): string[] {
  try {
    return listModels()
      .filter((model) => model.installed)
      .map((model) => model.id);
  } catch {
    return [];
  }
}

async function engineReady(): Promise<boolean> {
  try {
    return (await engineStatus()).ready;
  } catch {
    return false;
  }
}

export async function resolveVoiceProviderNow(): Promise<VoiceProviderResolution> {
  const settings = await configStore.getSettings();
  await listProvidersWithLegacyPiCredentialMigration().catch(() => undefined);
  const installed = installedLocalModels();
  const localPossible = installed.length > 0 && settings.voiceProvider !== "openai" && settings.voiceProvider !== "gemini";
  const [ready, hasOpenAIKey, hasGoogleKey] = await Promise.all([
    // Only ask the engine when a local model could be used; the status probe
    // forks the speech worker on first use.
    localPossible ? engineReady() : Promise.resolve(false),
    hasApiKey("openai"),
    hasApiKey(GOOGLE_PROVIDER_ID),
  ]);
  return resolveVoiceProvider({
    explicit: settings.voiceProvider,
    localModelId: settings.localVoiceModel || undefined,
    installedLocalModels: installed,
    engineReady: ready,
    hasOpenAIKey,
    // Voice goes to Google only after the user chose a Gemini usage scope
    // (the Gemini voice setup); a chat-only Google key is not consent.
    hasGeminiVoice: hasGoogleKey && isGeminiUsageScope(settings.geminiUsageScope),
  });
}
