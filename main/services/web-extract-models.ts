/**
 * Extraction models for `web_fetch` extract mode.
 *
 * Each adapter turns the shared `WebExtractModel` request into one provider
 * call. Adding a model means a definition in `renderer/shared/web-fetch-settings.ts`
 * and a factory here; the tool and the page checks do not change.
 */

import {
  WEB_EXTRACT_MODELS,
  type WebExtractModelId,
} from "../../renderer/shared/web-fetch-settings.js";
import { WebSearchError, webSearchError } from "./web-search-core.js";
import {
  runWithWebSearchKeyPool,
  type WebSearchKeyPool,
  type WebSearchKeyPoolTracker,
} from "./web-search-key-pool-core.js";
import type { WebSearchFetch } from "./web-search-provider-registry.js";
import { cancelWebSearchResponse, readBoundedWebSearchResponse } from "./web-search-response.js";
import { WebExtractError, type WebExtractModel, type WebExtractModelResponse } from "./web-extract-core.js";

export interface WebExtractModelContext {
  readonly accountId: string;
  readonly pool: WebSearchKeyPool;
  readonly tracker: WebSearchKeyPoolTracker;
  /** Injectable only for deterministic transport tests. */
  readonly fetch?: WebSearchFetch;
}

export type WebExtractModelFactory = (context: WebExtractModelContext) => WebExtractModel;

/** Clairic accepts 64k tokens; pi-web-access found 200,000 characters reliable. */
const CLAIRIC_MAX_PAGE_CHARS = 200_000;
const CLAIRIC_MAX_RESPONSE_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Pool failures use Web Search's error kinds; the tool reports extraction kinds. */
function extractErrorFrom(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason ?? error;
  if (error instanceof WebExtractError) return error;
  if (error instanceof WebSearchError) {
    if (error.kind === "auth") return new WebExtractError("auth");
    if (error.kind === "quota") return new WebExtractError("quota");
    if (error.kind === "invalid-response") return new WebExtractError("invalid-response");
  }
  return new WebExtractError("unavailable");
}

/**
 * Cloudflare's Clairic (`@cf/cloudflare/clairic`) on the person's own
 * account. Keys rotate through the pool: a rejected key (401/403) or a rate
 * limit (429) cools that key down and tries the next one.
 */
export function createClairicExtractModel(context: WebExtractModelContext): WebExtractModel {
  const send = context.fetch ?? ((input, init) => fetch(input, init));
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(context.accountId)}/ai/run/@cf/cloudflare/clairic`;
  return {
    id: "cloudflare-clairic",
    maxPageChars: CLAIRIC_MAX_PAGE_CHARS,
    async run(request): Promise<WebExtractModelResponse> {
      const body = JSON.stringify({
        model: "clairic",
        state: request.page,
        fields: request.fields,
        reference_date: request.referenceDate,
      });
      try {
        return await runWithWebSearchKeyPool({
          providerId: "cloudflare-workers-ai",
          pool: context.pool,
          tracker: context.tracker,
          signal: request.signal,
          run: async (key) => {
            const response = await send(endpoint, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body,
              redirect: "error",
              signal: request.signal,
            });
            if (response.status === 401 || response.status === 403) {
              cancelWebSearchResponse(response.body);
              throw webSearchError("auth");
            }
            if (response.status === 429) {
              cancelWebSearchResponse(response.body);
              throw webSearchError("quota");
            }
            if (!response.ok) {
              cancelWebSearchResponse(response.body);
              throw new WebExtractError("unavailable");
            }
            const bytes = await readBoundedWebSearchResponse(response, request.signal, CLAIRIC_MAX_RESPONSE_BYTES);
            let parsed: unknown;
            try {
              parsed = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              throw new WebExtractError("invalid-response");
            }
            if (!isRecord(parsed) || parsed.success !== true || !isRecord(parsed.result) || !isRecord(parsed.result.answers)) {
              throw new WebExtractError("invalid-response");
            }
            return { answers: parsed.result.answers, truncated: parsed.result.truncated === true };
          },
        });
      } catch (error) {
        throw extractErrorFrom(error, request.signal);
      }
    },
  };
}

export const WEB_EXTRACT_MODEL_FACTORIES: Readonly<Record<WebExtractModelId, WebExtractModelFactory>> =
  Object.freeze({
    "cloudflare-clairic": createClairicExtractModel,
  });

export function webExtractCredentialId(modelId: WebExtractModelId) {
  return WEB_EXTRACT_MODELS[modelId].credentialId;
}
