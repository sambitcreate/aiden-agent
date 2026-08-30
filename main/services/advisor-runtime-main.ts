import { logger } from "../platform.js";
import { AdvisorAttemptStore } from "./advisor-attempt-store.js";
import {
  AdvisorRuntime,
  advisorCandidatesFromProviders,
  type AdvisorCandidate,
} from "./advisor-runtime.js";
import { resolveModelRuntime } from "./model-runtime.js";
import { listConfiguredProviders } from "./provider-list-main.js";
import {
  assistantUsageRecord,
  isLocalModelProvider,
  unreportedUsageRecord,
} from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";

export const advisorAttemptStore = new AdvisorAttemptStore();

export async function listAdvisorCandidates(): Promise<AdvisorCandidate[]> {
  return advisorCandidatesFromProviders(await listConfiguredProviders());
}

export const advisorRuntime = new AdvisorRuntime({
  attempts: advisorAttemptStore,
  listCandidates: listAdvisorCandidates,
  resolveRuntime: resolveModelRuntime,
  recordUsage: async (message, runtime) => {
    await usageStore.record(
      assistantUsageRecord({
        message,
        provider: runtime.provider,
        model: runtime.model,
        source: "advisor",
      }),
    );
  },
  recordUnreportedUsage: async (runtime, status) => {
    await usageStore.record(
      unreportedUsageRecord({
        source: "advisor",
        providerId: runtime.provider.id,
        providerLabel: runtime.provider.label,
        modelId: runtime.model.id,
        modelLabel: runtime.model.name,
        local: isLocalModelProvider(runtime.provider),
        status,
      }),
    );
  },
  reportFailure: (area, error) => {
    logger.warn("advisor", `Advisor ${area} failed.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  },
});

export function initializeAdvisorRuntime(): void {
  void advisorRuntime.initialize().catch((error) => {
    logger.warn("advisor", "Advisor attempt recovery failed during startup.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
