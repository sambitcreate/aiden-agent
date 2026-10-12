// Shared by the image-generation tests. Not a test file.
import type { Credential, CredentialStore, ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { pngBytes } from "../studio-assets/test-fixture.js";

export function png(seed = 1, width = 8, height = 8): Uint8Array {
  return pngBytes(width, height, seed);
}

export function pngBase64(seed = 1, width = 8, height = 8): string {
  return Buffer.from(png(seed, width, height)).toString("base64");
}

export class MemoryCredentialStore implements CredentialStore {
  readonly entries = new Map<string, Credential>();
  readonly touched: string[] = [];

  constructor(initial: Record<string, Credential> = {}) {
    for (const [id, credential] of Object.entries(initial)) this.entries.set(id, credential);
  }

  async read(providerId: string) {
    this.touched.push(providerId);
    return this.entries.get(providerId);
  }

  async list() {
    return [...this.entries].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    this.touched.push(providerId);
    const next = await fn(this.entries.get(providerId));
    if (next) this.entries.set(providerId, next);
    return this.entries.get(providerId);
  }

  async delete(providerId: string) {
    this.touched.push(providerId);
    this.entries.delete(providerId);
  }
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (request: RecordedRequest, init: RequestInit) => Response | Promise<Response>;

/** A fetch double that records each request and answers from `route`. */
export function fakeFetch(route: Route): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown = init.body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const request = { method: (init.method ?? "GET").toUpperCase(), url, headers, body };
    requests.push(request);
    init.signal?.throwIfAborted();
    return route(request, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export function bytes(value: Uint8Array, status = 200): Response {
  return new Response(Buffer.from(value), { status, headers: { "content-type": "image/png" } });
}

export function imageModel(provider: string, id: string, api: ImageApi, input: ("text" | "image")[] = ["text"]): ImageModel<ImageApi> {
  return {
    type: "image",
    id,
    name: id,
    api,
    provider,
    baseUrl: "https://example.invalid",
    input,
    output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
