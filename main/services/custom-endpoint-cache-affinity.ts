/**
 * Prompt-cache routing for custom OpenAI-compatible endpoints whose service
 * documents it. Pi already sends `prompt_cache_key` (from the request's
 * `sessionId`, the chat id) to api.openai.com and session-affinity headers
 * when a model's compat asks for them; a custom endpoint gets neither unless
 * it is listed here. The key is always the chat id: never a device or account
 * identifier.
 */
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";

type CacheAffinityCompat = Pick<
  OpenAICompletionsCompat,
  "promptCacheKeyMode" | "sendSessionAffinityHeaders" | "sessionAffinityFormat"
>;

interface CacheAffinityEntry {
  /** Exact host, or a suffix starting with "." for a service's per-resource hosts. */
  host: string;
  compat: CacheAffinityCompat;
}

const CACHE_AFFINITY_ENDPOINTS: readonly CacheAffinityEntry[] = [
  // Azure OpenAI routes Chat Completions by prompt_cache_key, as OpenAI does.
  { host: ".openai.azure.com", compat: { promptCacheKeyMode: "enabled" } },
  // Fireworks keeps a session on one replica with the session-affinity header.
  { host: "api.fireworks.ai", compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai-nosession" } },
];

function hostOf(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** The cache-routing compat for a custom endpoint, or undefined when it is not listed. */
export function customEndpointCacheAffinity(baseUrl: string): CacheAffinityCompat | undefined {
  const host = hostOf(baseUrl);
  if (!host) return undefined;
  const entry = CACHE_AFFINITY_ENDPOINTS.find((candidate) =>
    candidate.host.startsWith(".")
      ? host.endsWith(candidate.host) && host.length > candidate.host.length
      : host === candidate.host);
  return entry ? { ...entry.compat } : undefined;
}
