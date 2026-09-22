/**
 * Integration surface for the reviewed Phase 4 hosted batch A.
 *
 * The central registry remains the owner of the complete provider map and
 * release state. This module exports the reviewed candidate factories and
 * their fixed-contract helpers; only the evidence-cleared candidate appears
 * in the release map below.
 */

import type { WebSearchAdapterFactory } from "./web-search-provider-registry.js";
import { serpDiveWebSearchAdapterFactory } from "./web-search-serpdive-adapter.js";

export * from "./web-search-serpdive-adapter.js";

export type WebSearchWave4BatchAProviderId = "serpdive";

/** Factories are intentionally separate from the central registry definition. */
export const WEB_SEARCH_WAVE4_BATCH_A_ADAPTER_FACTORIES: Readonly<
  Record<WebSearchWave4BatchAProviderId, WebSearchAdapterFactory>
> = Object.freeze({
  serpdive: serpDiveWebSearchAdapterFactory,
});

/** Alias for integrations that name the map by its wave rather than batch. */
export const WEB_SEARCH_WAVE4_ADAPTER_FACTORIES_BATCH_A =
  WEB_SEARCH_WAVE4_BATCH_A_ADAPTER_FACTORIES;
