// How the production image port is assembled from the app's singletons. Electron-free
// so the wiring (offline catalogs, usage source) can be tested without the app.
import type { ImageGenerationPort } from "../../../renderer/shared/images/port.js";
import type { StoredProvider } from "../types.js";
import { modelOperationUsageRecord } from "../usage-accounting.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { createPiImageGenerationPort, type PiImagePortOptions } from "./image-port.js";

export interface ImagePortWiring {
  models: PiImagePortOptions["models"];
  providerLabel(providerId: string): string;
  /** Restores durable catalogs from disk. It must never contact a provider. */
  restoreOfflineCatalogs(): Promise<void>;
  listStoredProviders(): Promise<readonly StoredProvider[]>;
  recordUsage(record: UsageRequestRecord): Promise<void>;
}

/** The image port the app uses: offline model listing, and every request accounted as "create-images". */
export function createWiredImagePort(wiring: ImagePortWiring): ImageGenerationPort {
  return createPiImageGenerationPort({
    models: wiring.models,
    providerLabel: wiring.providerLabel,
    beforeList: () => wiring.restoreOfflineCatalogs(),
    onUsage: async (record) => {
      await wiring.recordUsage(modelOperationUsageRecord(record, await wiring.listStoredProviders(), "create-images"));
    },
  });
}
