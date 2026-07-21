// Main-process dependency wiring for the Electron-free runtime resolver.

import { configStore } from "./config-store.js";
import { resolveModelRuntimeWith, type ResolvedModelRuntime } from "./model-runtime-core.js";
import { providerRegistry } from "./provider-registry.js";
import { secrets } from "./secrets.js";

export type { ResolvedModelRuntime };

export function resolveModelRuntime(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ResolvedModelRuntime> {
  return resolveModelRuntimeWith(
    {
      getProvider: (id) => configStore.getProvider(id),
      getApiKey: (id) => secrets.getKey(id),
      codex: providerRegistry.codex,
    },
    providerId,
    modelId,
    signal,
  );
}
