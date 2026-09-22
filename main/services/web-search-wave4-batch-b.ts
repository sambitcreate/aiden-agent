/**
 * Integration surface for the reviewed Phase 4 hosted batch B.
 *
 * AnySearch, XCrawl, and Valyu remain explicit-only provider choices. This
 * module exposes their main-owned factories; the central registry owns
 * release-state and route membership decisions.
 */

import type { WebSearchAdapterFactory } from "./web-search-provider-registry.js";
import { anySearchWebSearchAdapterFactory } from "./web-search-anysearch-adapter.js";
import { xcrawlWebSearchAdapterFactory } from "./web-search-xcrawl-adapter.js";
import { valyuWebSearchAdapterFactory } from "./web-search-valyu-adapter.js";

export * from "./web-search-anysearch-adapter.js";
export * from "./web-search-xcrawl-adapter.js";
export * from "./web-search-valyu-adapter.js";

export type WebSearchWave4BatchBProviderId = "xcrawl" | "valyu";

export const WEB_SEARCH_WAVE4_BATCH_B_ADAPTER_FACTORIES: Readonly<
  Record<WebSearchWave4BatchBProviderId, WebSearchAdapterFactory>
> = Object.freeze({
  xcrawl: xcrawlWebSearchAdapterFactory,
  valyu: valyuWebSearchAdapterFactory,
});

/**
 * AnySearch's transport is fixture-tested, but its exact success envelope is
 * not yet confirmed by immutable primary response evidence. Keep it out of
 * the release map until that final contract gate closes.
 */
export const WEB_SEARCH_WAVE4_BATCH_B_HELD_ADAPTER_FACTORIES: Readonly<
  Record<"anysearch", WebSearchAdapterFactory>
> = Object.freeze({
  anysearch: anySearchWebSearchAdapterFactory,
});

/** Alias for integrations that name the map by its wave rather than batch. */
export const WEB_SEARCH_WAVE4_ADAPTER_FACTORIES_BATCH_B =
  WEB_SEARCH_WAVE4_BATCH_B_ADAPTER_FACTORIES;
