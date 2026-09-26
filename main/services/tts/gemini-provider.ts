// Gemini provider adapter: the only module that touches the Google SDK for
// read aloud. Synthesis and voice listing run over the SDK's Interactions and
// Voices surfaces with strict response validation from gemini-wire.js.
//
// Hidden automatic retries are disabled for billable POSTs; AbortSignal
// propagates through the flattened RequestInit options.

import { GoogleGenAI, type HttpOptions } from "@google/genai";
import { TTS_LIMITS } from "../../../renderer/shared/tts.js";
import {
  classifyTtsProviderError,
  parseUnarySynthesisResponse,
  parseVoicesListResponse,
  type TtsInteractionBody,
  type TtsUnarySynthesisResult,
  type TtsVoicesPage,
} from "./gemini-wire.js";
import type { TtsProviderPort } from "./service.js";

/** Minimal structural surface the service needs from the SDK client. */
interface GeminiTtsClient {
  interactions: {
    create(
      params: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  voices: {
    list(
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
}

export interface GeminiTtsClientFactory {
  createClient(input: { apiKey: string; httpOptions?: HttpOptions }): GeminiTtsClient;
}

const defaultFactory: GeminiTtsClientFactory = {
  createClient(input) {
    const client = new GoogleGenAI({
      apiKey: input.apiKey,
      ...(input.httpOptions ? { httpOptions: input.httpOptions } : {}),
    });
    return client as unknown as GeminiTtsClient;
  },
};

export function createGeminiTtsProvider(
  deps: { httpOptions?: HttpOptions; clientFactory?: GeminiTtsClientFactory } = {},
): TtsProviderPort {
  const factory = deps.clientFactory ?? defaultFactory;
  const baseHttpOptions: HttpOptions = {
    apiVersion: "v1beta",
    ...(deps.httpOptions ?? {}),
  };
  return {
    async synthesize(input: {
      apiKey: string;
      body: TtsInteractionBody;
      signal?: AbortSignal;
    }): Promise<TtsUnarySynthesisResult> {
      const client = factory.createClient({
        apiKey: input.apiKey,
        httpOptions: baseHttpOptions,
      });
      try {
        const response = await client.interactions.create(
          { ...(input.body as unknown as Record<string, unknown>) },
          {
            retries: 0,
            timeout_ms: TTS_LIMITS.requestTimeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        return parseUnarySynthesisResponse(response);
      } catch (error) {
        throw classifyTtsProviderError(error);
      }
    },

    async listVoices(input: {
      apiKey: string;
      pageToken?: string;
    }): Promise<TtsVoicesPage> {
      const client = factory.createClient({
        apiKey: input.apiKey,
        httpOptions: baseHttpOptions,
      });
      try {
        const response = await client.voices.list(
          input.pageToken ? { page_token: input.pageToken } : undefined,
          { retries: 2, timeout_ms: TTS_LIMITS.requestTimeoutMs },
        );
        return parseVoicesListResponse(response);
      } catch (error) {
        throw classifyTtsProviderError(error);
      }
    },
  };
}
