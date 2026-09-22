/**
 * Integration surface for the bounded Phase 3 Wave 2 batch.
 *
 * The central registry remains the owner of the complete provider map. This
 * module exports only these adapter factories so the main-only registry can
 * opt the reviewed batch in without exposing transport details to the
 * renderer or changing unrelated providers.
 */

import type { WebSearchAdapterFactory } from "./web-search-provider-registry.js";
import { jinaWebSearchAdapterFactory } from "./web-search-jina-adapter.js";
import { parallelWebSearchAdapterFactory } from "./web-search-parallel-adapter.js";
import { search1APIWebSearchAdapterFactory } from "./web-search-search1api-adapter.js";
import { tinyFishWebSearchAdapterFactory } from "./web-search-tinyfish-adapter.js";

export {
  PARALLEL_WEB_SEARCH_ENDPOINT,
  PARALLEL_WEB_SEARCH_ORIGIN,
  buildParallelWebSearchRequest,
  createParallelWebSearchAdapter,
  parallelWebSearchAdapterFactory,
  parseParallelWebSearchResponse,
  requireParallelWebSearchApiKey,
  type ParallelWebSearchApiKeyCredential,
  type ParallelWebSearchCredential,
} from "./web-search-parallel-adapter.js";
export {
  TINYFISH_WEB_SEARCH_ENDPOINT,
  TINYFISH_WEB_SEARCH_ORIGIN,
  buildTinyFishWebSearchRequest,
  createTinyFishWebSearchAdapter,
  parseTinyFishWebSearchResponse,
  requireTinyFishWebSearchApiKey,
  tinyFishWebSearchAdapterFactory,
  type TinyFishWebSearchApiKeyCredential,
  type TinyFishWebSearchCredential,
} from "./web-search-tinyfish-adapter.js";
export {
  SEARCH1API_WEB_SEARCH_ENDPOINT,
  SEARCH1API_WEB_SEARCH_ORIGIN,
  buildSearch1APIWebSearchRequest,
  createSearch1APIWebSearchAdapter,
  parseSearch1APIWebSearchResponse,
  requireSearch1APIWebSearchApiKey,
  search1APIWebSearchAdapterFactory,
  type Search1APIWebSearchApiKeyCredential,
  type Search1APIWebSearchCredential,
} from "./web-search-search1api-adapter.js";
export {
  JINA_WEB_SEARCH_ENDPOINT,
  JINA_WEB_SEARCH_ORIGIN,
  buildJinaWebSearchRequest,
  createJinaWebSearchAdapter,
  jinaWebSearchAdapterFactory,
  parseJinaWebSearchResponse,
  requireJinaWebSearchApiKey,
  type JinaWebSearchApiKeyCredential,
  type JinaWebSearchCredential,
} from "./web-search-jina-adapter.js";

export type WebSearchWave2BatchAProviderId = "parallel" | "tinyfish" | "search1api" | "jina";

/** Factories are intentionally separate from the central registry definition. */
export const WEB_SEARCH_WAVE2_BATCH_A_ADAPTER_FACTORIES: Readonly<
  Record<WebSearchWave2BatchAProviderId, WebSearchAdapterFactory>
> = Object.freeze({
  parallel: parallelWebSearchAdapterFactory,
  tinyfish: tinyFishWebSearchAdapterFactory,
  search1api: search1APIWebSearchAdapterFactory,
  jina: jinaWebSearchAdapterFactory,
});

/** Alias for integrations that name the map by its wave rather than batch. */
export const WEB_SEARCH_WAVE2_ADAPTER_FACTORIES_BATCH_A =
  WEB_SEARCH_WAVE2_BATCH_A_ADAPTER_FACTORIES;
