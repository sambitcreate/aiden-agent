import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { WebSearchError } from "./web-search-core.js";
import type { WebSearchAdapterRequest } from "./web-search-provider-registry.js";

export interface WebSearchAdapterTestSupport {
  assertSecureRequest(init: RequestInit | undefined, keyExpected?: boolean): void;
  assertNoSecretInError(error: unknown): asserts error is WebSearchError;
  createAdapterRequest(options: {
    query: string;
    credentialMode?: "api-key" | "anonymous";
    credential?: string;
    signal?: AbortSignal;
  }): WebSearchAdapterRequest;
}

export async function fixture(provider: string, name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${provider}/${name}`, import.meta.url), "utf8");
}

export function adapterTestSupport({
  key,
  body,
}: {
  key: string;
  body: string;
}): WebSearchAdapterTestSupport {
  return {
    assertSecureRequest(init: RequestInit | undefined, keyExpected = true): void {
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.referrerPolicy, "no-referrer");
      assert.equal(JSON.stringify(init).includes(body), false);
      assert.equal(JSON.stringify(init).includes(key), keyExpected);
    },
    assertNoSecretInError(error: unknown): asserts error is WebSearchError {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.message.includes(body), false);
      assert.equal(error.message.includes(key), false);
    },
    createAdapterRequest({
      query,
      credentialMode = "api-key",
      credential = credentialMode === "api-key" ? key : undefined,
      signal = new AbortController().signal,
    }): WebSearchAdapterRequest {
      return {
        query,
        numResults: 2,
        credentialMode,
        credential,
        signal,
      };
    },
  };
}

export function oversizedStreamResponse(maxBytes: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(maxBytes));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
