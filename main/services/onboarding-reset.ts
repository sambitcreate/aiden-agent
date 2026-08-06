import { artificialAnalysisRuntime } from "./artificial-analysis-runtime.js";
import { configStore } from "./config-store.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import { performOnboardingReset } from "./onboarding-reset-core.js";
import { piCredentialStore } from "./pi-credential-store.js";
import { secrets } from "./secrets.js";

async function clearPiCredentials(): Promise<void> {
  const credentials = await piCredentialStore.list();
  for (const credential of credentials) {
    await piCredentialStore.delete(credential.providerId);
  }
}

/** Clear setup and preferences while preserving user-created work. */
export function resetOnboardingData(): Promise<void> {
  return performOnboardingReset({
    disconnectArtificialAnalysis: () => artificialAnalysisRuntime.disconnect(),
    resetConfiguration: () => configStore.resetUserSetup(),
    clearLegacySecrets: () => secrets.clearAll(),
    clearPiCredentials,
    clearMcpOAuth: () => mcpOAuthStore.clearAll(),
  });
}
