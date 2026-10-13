// How the production image port is assembled from the app's singletons. Electron-free
// so the wiring (offline registry hydration, usage source) can be tested without the app.
import type { ImageGenerationPort } from "../../../renderer/shared/images/port.js";
import { modelOperationUsageRecord } from "../usage-accounting.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { createPiImageGenerationPort, type PiImagePortOptions } from "./image-port.js";

export interface ImagePortWiring {
  /** The image-generation registry (Settings → Image Generation), never the chat registry. */
  models: PiImagePortOptions["models"];
  providerLabel(providerId: string): string;
  /** Loads the image registry from local settings. It must never contact a provider. */
  ready(): Promise<void>;
  /** The Settings → Image Generation default model (cached, offline). */
  defaultModel?(): Promise<{ provider: string; id: string } | undefined>;
  /** Maker slug for a model's logo. */
  maker?(providerId: string, modelId: string): string | undefined;
  recordUsage(record: UsageRequestRecord): Promise<void>;
}

/** The image port the app uses: offline model lookups, and every request accounted as "create-images". */
export function createWiredImagePort(wiring: ImagePortWiring): ImageGenerationPort {
  return createPiImageGenerationPort({
    models: wiring.models,
    providerLabel: wiring.providerLabel,
    prepare: () => wiring.ready(),
    ...(wiring.defaultModel ? { defaultModel: wiring.defaultModel } : {}),
    ...(wiring.maker ? { maker: wiring.maker } : {}),
    onUsage: async (record) => {
      // Image providers are always hosted; chat provider deployments never apply.
      await wiring.recordUsage(modelOperationUsageRecord(record, [], "create-images"));
    },
  });
}
