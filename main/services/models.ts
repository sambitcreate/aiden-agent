// List available model ids from a provider's REST endpoint, plus connection testing.

import type { StoredProvider } from "./types.js";

interface ModelEntry {
  id?: string;
  name?: string;
}
interface ModelsResponse {
  data?: ModelEntry[];
  models?: ModelEntry[];
}

export interface ConnectionTestResult {
  ok: true;
  modelCount: number;
  /** The discovered ids let Settings hydrate its draft without another request. */
  models: string[];
}

/** Keep a settings request responsive when a local or private server is offline. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Validate connection URLs before they are persisted or used for discovery.
 * Credentials belong in the encrypted key store, never in a URL.
 */
export function normalizeProviderBaseUrl(value: string): string {
  const input = value.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid HTTP(S) base URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider URLs must use HTTP or HTTPS.");
  }
  if (!url.hostname) {
    throw new Error("Provider URL must include a host.");
  }
  if (url.username || url.password) {
    throw new Error("Put credentials in the API key field, not the URL.");
  }
  if (url.search || url.hash) {
    throw new Error("Provider URL cannot include a query string or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function headersFor(provider: StoredProvider, apiKey: string | null): Record<string, string> {
  if (provider.kind === "anthropic") {
    return {
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
    };
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function fetchModels(url: string, headers: Record<string, string>): Promise<ModelsResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Failed to list models: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      );
    }
    return (await response.json()) as ModelsResponse;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Connection timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch the model list. Returns [] if the endpoint doesn't support it. */
export async function listModels(
  provider: StoredProvider,
  apiKey: string | null,
): Promise<string[]> {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  const json = await fetchModels(url, headersFor(provider, apiKey));
  const ids = (json.data ?? json.models ?? [])
    .map((m) => m.id ?? m.name)
    .filter((id): id is string => Boolean(id));
  return Array.from(new Set(ids)).sort();
}

/** Lightweight connectivity/auth check. Throws with a specific message on failure. */
export async function testConnection(
  provider: StoredProvider,
  apiKey: string | null,
): Promise<ConnectionTestResult> {
  const models = await listModels(provider, apiKey);
  return { ok: true, modelCount: models.length, models };
}
