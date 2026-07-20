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

function headersFor(provider: StoredProvider, apiKey: string | null): Record<string, string> {
  if (provider.kind === "anthropic") {
    return {
      "x-api-key": apiKey ?? "",
      "anthropic-version": "2023-06-01",
    };
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Fetch the model list. Returns [] if the endpoint doesn't support it. */
export async function listModels(
  provider: StoredProvider,
  apiKey: string | null,
): Promise<string[]> {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  const response = await fetch(url, { headers: headersFor(provider, apiKey) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to list models: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }
  const json = (await response.json()) as ModelsResponse;
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
