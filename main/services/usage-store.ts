import { logger } from "../platform.js";
import { DataStore } from "./data-store.js";
import type { UsageDateRange, UsageSummary } from "./types.js";
import {
  createEmptyUsageDatabase,
  createUsageStore,
  type UsageDatabase,
  type UsageRequestRecord,
} from "./usage-store-core.js";

const persistence = new DataStore<UsageDatabase>("usage.json", createEmptyUsageDatabase());
const store = createUsageStore({
  load: () => persistence.load(),
  save: (data) => persistence.save(data),
});

export const usageStore = {
  /** Persist one privacy-safe aggregate mutation without failing the model workflow. */
  record(record: UsageRequestRecord): Promise<void> {
    return store.record(record).catch((error: unknown) => {
      logger.warn("usage", "Could not persist local model usage", {
        providerId: record.providerId,
        modelId: record.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  },

  summary(range: UsageDateRange): Promise<UsageSummary> {
    return store.summary(range);
  },
};
