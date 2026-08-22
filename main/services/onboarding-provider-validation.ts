import { testConnection } from "./models.js";
import type { StoredProvider } from "./types.js";

interface OnboardingProviderValidationInput {
  provider: StoredProvider;
  apiKey: string;
  installedModelIds: readonly string[];
  isCurrent: () => boolean;
  commit: (apiKey: string) => Promise<void>;
}

/** Pi currently reports Anthropic's API origin without its versioned REST path. */
export function normalizeOnboardingValidationProvider(
  provider: StoredProvider,
): StoredProvider {
  if (
    provider.id === "anthropic" &&
    /^https:\/\/api\.anthropic\.com\/?$/u.test(provider.baseUrl)
  ) {
    return { ...provider, baseUrl: "https://api.anthropic.com/v1" };
  }
  return provider;
}

/** Validate a non-generation catalog before replacing the stored credential. */
export async function validateOnboardingProviderCredential({
  provider,
  apiKey,
  installedModelIds,
  isCurrent,
  commit,
}: OnboardingProviderValidationInput): Promise<string[]> {
  const result = await testConnection(normalizeOnboardingValidationProvider(provider), apiKey);
  const accessible = new Set(result.models);
  if (!installedModelIds.some((modelId) => accessible.has(modelId))) {
    throw new Error("Credentials were accepted, but no supported chat models are available.");
  }
  if (!isCurrent()) throw new Error("The onboarding window is no longer active.");
  await commit(apiKey);
  // Return the authenticated service's complete bounded list. The caller
  // refreshes Pi after commit and intersects against that new executable
  // catalog, allowing models released after Aiden was packaged to appear.
  return [...accessible];
}
