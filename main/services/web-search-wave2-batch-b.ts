/**
 * Integration surface for the reviewed Phase 3 Wave 2 hosted batch B.
 *
 * Kagi, Ollama Cloud, and Serper remain explicit-only provider choices. This
 * module exposes only their main-owned factories; the central registry owns
 * release-state and route membership decisions.
 */

import type { WebSearchAdapterFactory } from "./web-search-provider-registry.js";
import { kagiWebSearchAdapterFactory } from "./web-search-kagi-adapter.js";
import { ollamaCloudWebSearchAdapterFactory } from "./web-search-ollama-adapter.js";
import { serperWebSearchAdapterFactory } from "./web-search-serper-adapter.js";

export * from "./web-search-kagi-adapter.js";
export * from "./web-search-ollama-adapter.js";
export * from "./web-search-serper-adapter.js";

export type WebSearchWave2BatchBProviderId = "kagi" | "ollama" | "serper";

export const WEB_SEARCH_WAVE2_BATCH_B_ADAPTER_FACTORIES: Readonly<
  Record<WebSearchWave2BatchBProviderId, WebSearchAdapterFactory>
> = Object.freeze({
  kagi: kagiWebSearchAdapterFactory,
  ollama: ollamaCloudWebSearchAdapterFactory,
  serper: serperWebSearchAdapterFactory,
});

/** Alias for integrations that name the map by its wave rather than batch. */
export const WEB_SEARCH_WAVE2_ADAPTER_FACTORIES_BATCH_B =
  WEB_SEARCH_WAVE2_BATCH_B_ADAPTER_FACTORIES;
