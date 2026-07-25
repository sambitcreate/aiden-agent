// Probe whether a local LLM is already resident in memory (Ollama / LM Studio).

import { isLocalProviderDeployment } from "../../renderer/shared/provider-deployment.js";
import { isLmStudioProviderId, isOllamaProviderId } from "./custom-provider-id.js";
import type { StoredProvider } from "./types.js";

export type LocalModelLoadState = "loaded" | "unloaded" | "unknown";

export const LOCAL_RUNTIME_PROBE_TIMEOUT_MS = 2_000;
export const LOCAL_RUNTIME_POLL_INTERVAL_MS = 500;

function providerEndpoint(provider: Pick<StoredProvider, "baseUrl">, pathname: string): string {
  const url = new URL(provider.baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Normalize Ollama/LM Studio model ids for equality (`foo` ≡ `foo:latest`). */
export function normalizeLocalModelId(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  return trimmed.endsWith(":latest") ? trimmed.slice(0, -":latest".length) : trimmed;
}

export function localModelIdsMatch(left: string, right: string): boolean {
  const a = normalizeLocalModelId(left);
  const b = normalizeLocalModelId(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_RUNTIME_PROBE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Probe failed: ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function parseOllamaPsLoaded(value: unknown, modelId: string): LocalModelLoadState {
  const body = object(value);
  if (!body || !Array.isArray(body.models)) return "unknown";
  for (const entry of body.models) {
    const row = object(entry);
    if (!row) continue;
    const name =
      (typeof row.model === "string" && row.model) ||
      (typeof row.name === "string" && row.name) ||
      "";
    if (name && localModelIdsMatch(name, modelId)) return "loaded";
  }
  return "unloaded";
}

export function parseLmStudioModelsLoaded(value: unknown, modelId: string): LocalModelLoadState {
  const body = object(value);
  if (!body) return "unknown";

  // REST API v0: `{ data: [{ id, state: "loaded" | "not-loaded" }] }`
  if (Array.isArray(body.data)) {
    let sawMatch = false;
    for (const entry of body.data) {
      const row = object(entry);
      if (!row) continue;
      const id = typeof row.id === "string" ? row.id : "";
      if (!id || !localModelIdsMatch(id, modelId)) continue;
      sawMatch = true;
      if (row.state === "loaded") return "loaded";
      if (row.state === "not-loaded") return "unloaded";
    }
    // When JIT is off, /api/v0/models may only list loaded models.
    if (!sawMatch) return "unloaded";
    return "unknown";
  }

  // REST API v1 list: `{ models: [{ key, loaded_instances: [...] }] }`
  if (Array.isArray(body.models)) {
    let sawMatch = false;
    for (const entry of body.models) {
      const row = object(entry);
      if (!row) continue;
      const key =
        (typeof row.key === "string" && row.key) || (typeof row.id === "string" && row.id) || "";
      if (!key || !localModelIdsMatch(key, modelId)) continue;
      sawMatch = true;
      const instances = row.loaded_instances;
      if (Array.isArray(instances)) {
        return instances.length > 0 ? "loaded" : "unloaded";
      }
      if (row.state === "loaded") return "loaded";
      if (row.state === "not-loaded") return "unloaded";
    }
    if (!sawMatch) return "unloaded";
    return "unknown";
  }

  return "unknown";
}

async function probeOllama(
  provider: Pick<StoredProvider, "baseUrl">,
  modelId: string,
  signal?: AbortSignal,
): Promise<LocalModelLoadState> {
  try {
    const value = await fetchJson(providerEndpoint(provider, "/api/ps"), signal);
    return parseOllamaPsLoaded(value, modelId);
  } catch {
    return "unknown";
  }
}

async function probeLmStudio(
  provider: Pick<StoredProvider, "baseUrl">,
  modelId: string,
  signal?: AbortSignal,
): Promise<LocalModelLoadState> {
  try {
    const value = await fetchJson(providerEndpoint(provider, "/api/v0/models"), signal);
    const state = parseLmStudioModelsLoaded(value, modelId);
    if (state !== "unknown") return state;
  } catch {
    // Fall through to v1.
  }
  try {
    const value = await fetchJson(providerEndpoint(provider, "/api/v1/models"), signal);
    return parseLmStudioModelsLoaded(value, modelId);
  } catch {
    return "unknown";
  }
}

/**
 * Ask the local server whether `modelId` is resident in memory.
 * Returns `unknown` when the backend is not probeable or the probe fails.
 */
export async function probeLocalModelLoaded(
  provider: Pick<StoredProvider, "id" | "baseUrl" | "deployment">,
  modelId: string,
  signal?: AbortSignal,
): Promise<LocalModelLoadState> {
  if (!modelId.trim() || !isLocalProviderDeployment(provider)) return "unknown";
  if (signal?.aborted) return "unknown";

  if (isOllamaProviderId(provider.id)) return probeOllama(provider, modelId, signal);
  if (isLmStudioProviderId(provider.id)) return probeLmStudio(provider, modelId, signal);

  // Custom local: try Ollama then LM Studio shapes without inventing a status.
  const ollama = await probeOllama(provider, modelId, signal);
  if (ollama !== "unknown") return ollama;
  return probeLmStudio(provider, modelId, signal);
}

export interface LocalModelLoadMonitor {
  /** Stop polling without emitting ready (caller may emit if needed). */
  stop: () => void;
  /** True after `onLoading` has been called for this monitor. */
  readonly announcedLoading: boolean;
}

/**
 * Emit loading/ready while a JIT chat request may be warming the model.
 * Stops on abort or when the probe reports loaded. Callers should `stop()` on
 * first stream activity and emit ready themselves if `announcedLoading`.
 */
export function startLocalModelLoadMonitor(options: {
  provider: Pick<StoredProvider, "id" | "baseUrl" | "deployment">;
  modelId: string;
  signal: AbortSignal;
  onLoading: () => void;
  onReady: () => void;
  intervalMs?: number;
}): LocalModelLoadMonitor {
  const intervalMs = options.intervalMs ?? LOCAL_RUNTIME_POLL_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let announcedLoading = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const tick = async () => {
    if (stopped || options.signal.aborted) {
      stop();
      return;
    }
    const state = await probeLocalModelLoaded(options.provider, options.modelId, options.signal);
    if (stopped || options.signal.aborted) {
      stop();
      return;
    }
    if (state === "loaded") {
      if (announcedLoading) {
        stop();
        options.onReady();
      } else {
        stop();
      }
      return;
    }
    if (state === "unloaded") {
      if (!announcedLoading) {
        announcedLoading = true;
        options.onLoading();
      }
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
      return;
    }
    // unknown — do not fake a loading label
    stop();
  };

  void tick();

  return {
    get announcedLoading() {
      return announcedLoading;
    },
    stop,
  };
}
