import { artificialAnalysisRuntime } from "./artificial-analysis-runtime.js";
import { configStore } from "./config-store.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import { openRouterBenchmarkRuntime } from "./openrouter-benchmark-runtime.js";
import { deleteEveryCredential, performOnboardingReset } from "./onboarding-reset-core.js";
import { piCredentialStore } from "./pi-credential-store.js";
import { secrets } from "./secrets.js";

async function clearPiCredentials(): Promise<void> {
  const credentials = await piCredentialStore.list();
  await deleteEveryCredential(
    credentials.map((credential) => credential.providerId),
    (providerId) => piCredentialStore.delete(providerId),
  );
}

/** Clear setup and preferences while preserving user-created work. */
export function resetOnboardingData(): Promise<void> {
  return performOnboardingReset({
    disconnectArtificialAnalysis: () => artificialAnalysisRuntime.disconnect(),
    clearModelInsights: () => openRouterBenchmarkRuntime.disconnect(),
    resetConfiguration: () => configStore.resetUserSetup(),
    clearLegacySecrets: () => secrets.clearAll(),
    clearPiCredentials,
    clearMcpOAuth: () => mcpOAuthStore.clearAll(),
  });
}
