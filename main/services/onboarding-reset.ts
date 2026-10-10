import { artificialAnalysisRuntime } from "./artificial-analysis-runtime.js";
import { configStore } from "./config-store.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import { modelPaceRecorder } from "./model-pace-runtime.js";
import { openRouterBenchmarkRuntime } from "./openrouter-benchmark-runtime.js";
import { clearEveryCredential, performOnboardingReset } from "./onboarding-reset-core.js";
import { piCredentialStore } from "./pi-credential-store.js";
import { secrets } from "./secrets.js";

async function clearPiCredentials(): Promise<void> {
  const credentials = await piCredentialStore.list();
  // The Model Pad benchmark key lives in this store too; its runtime remembers
  // the catalog it served, so it must forget it once the key is gone.
  await clearEveryCredential(
    credentials.map((credential) => credential.providerId),
    (providerId) => piCredentialStore.delete(providerId),
    () => openRouterBenchmarkRuntime.invalidate(),
  );
}

/** Clear setup and preferences while preserving user-created work. */
export function resetOnboardingData(): Promise<void> {
  return performOnboardingReset({
    disconnectArtificialAnalysis: () => artificialAnalysisRuntime.disconnect(),
    clearModelInsights: () => openRouterBenchmarkRuntime.disconnect(),
    clearModelPace: () => modelPaceRecorder.clear(),
    resetConfiguration: () => configStore.resetUserSetup(),
    clearLegacySecrets: () => secrets.clearAll(),
    clearPiCredentials,
    clearMcpOAuth: () => mcpOAuthStore.clearAll(),
  });
}
