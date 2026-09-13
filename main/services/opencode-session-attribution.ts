import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

/**
 * OpenCode's managed-inference gateway (OpenCode Go / Zen) rejects requests
 * that omit a stable per-conversation routing header:
 *
 *   400 {"type":"MissingSessionID","message":"Error from provider (Console Go):
 *   Request is missing x-opencode-session and cannot be routed efficiently."}
 *
 * OpenCode documents the contract at
 * https://opencode.ai/docs/go/#where-can-i-use-it: a client should send a
 * stable session ID in `x-opencode-session` for each conversation so routing
 * and prompt caching can be optimized. The value is opaque; any stable
 * per-conversation identifier is accepted, and the header is required on
 * every inference request, auxiliary calls included.
 *
 * `@earendil-works/pi-ai` cannot emit this header: its transports only send
 * session-affinity headers for providers that opt in via
 * `compat.sendSessionAffinityHeaders`, and even then they emit different
 * header names. Aiden therefore owns OpenCode attribution here.
 *
 * Attach the header to the resolved runtime model rather than to individual
 * call sites. Every pi-ai transport merges `model.headers` into the outgoing
 * request, so the header reaches chat turns, compaction, chat titles, and
 * subagent runs (children and isolated inference inherit the runtime model)
 * through one seam.
 */

export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** Provider ids that terminate on OpenCode's managed-inference gateway. */
const OPENCODE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "opencode",
  "opencode-go",
  // Forward-compat: not published by the pinned Pi, but a known upstream id.
  "opencode-zen",
]);

const OPENCODE_HOSTNAME = "opencode.ai";

/** Bounded, injection-safe token grammar for an attribution id. */
const OPENCODE_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

/** Structural model shape needed to decide attribution; nothing else is read. */
export interface OpenCodeAttributionTarget {
  provider?: string;
  baseUrl?: string;
}

function isOpenCodeInferenceTarget(target: OpenCodeAttributionTarget): boolean {
  if (target.provider && OPENCODE_PROVIDER_IDS.has(target.provider)) return true;
  // Custom connections pointed exactly at opencode.ai also terminate on the
  // gateway. A proxy in front of OpenCode is intentionally not matched: its
  // hostname is the proxy's, and attribution there is the proxy owner's call.
  if (typeof target.baseUrl !== "string" || target.baseUrl === "") return false;
  try {
    return new URL(target.baseUrl).hostname === OPENCODE_HOSTNAME;
  } catch {
    return false;
  }
}

/**
 * OpenCode session attribution headers for one request, or `undefined` when
 * the target is not OpenCode-hosted or no conversation id exists. Never send
 * an empty value: the gateway treats a blank header as missing.
 */
export function openCodeSessionHeaders(
  target: OpenCodeAttributionTarget,
  conversationId: string | undefined,
): ProviderHeaders | undefined {
  const id = conversationId?.trim();
  if (!id || !OPENCODE_SESSION_ID_PATTERN.test(id)) return undefined;
  if (!isOpenCodeInferenceTarget(target)) return undefined;
  return { [OPENCODE_SESSION_HEADER]: id };
}

/**
 * Overwrite `additions` into `headers`, removing any existing case-variant of
 * the same header name so exactly one authoritative value reaches the gateway.
 */
function mergeHeadersCaseInsensitive(
  headers: ProviderHeaders,
  additions: ProviderHeaders,
): ProviderHeaders {
  const merged: ProviderHeaders = { ...headers };
  for (const name of Object.keys(additions)) {
    const normalized = name.toLowerCase();
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === normalized) delete merged[existing];
    }
    merged[name] = additions[name];
  }
  return merged;
}

/**
 * Return a request-ready copy of `model` carrying OpenCode session
 * attribution. The shared catalog model is never mutated; unrelated providers
 * and missing conversation ids return the input unchanged.
 */
export function withOpenCodeSessionAttribution<RuntimeModel extends Model<Api>>(
  model: RuntimeModel,
  conversationId: string | undefined,
): RuntimeModel {
  const headers = openCodeSessionHeaders(model, conversationId);
  if (!headers) return model;
  return {
    ...model,
    headers: mergeHeadersCaseInsensitive(model.headers ?? {}, headers),
  };
}
