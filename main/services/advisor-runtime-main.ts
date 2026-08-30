import { logger } from "../platform.js";
import { AdvisorAttemptStore } from "./advisor-attempt-store.js";
import { AdvisorRuntime } from "./advisor-runtime.js";
import { AdvisorSettingsStore } from "./advisor-settings-store.js";
import { resolveModelRuntime } from "./model-runtime.js";
import {
  assistantUsageRecord,
  isLocalModelProvider,
  unreportedUsageRecord,
} from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";

export const advisorSettingsStore = new AdvisorSettingsStore();
export const advisorAttemptStore = new AdvisorAttemptStore();

export const advisorRuntime = new AdvisorRuntime({
  settings: advisorSettingsStore,
  attempts: advisorAttemptStore,
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
