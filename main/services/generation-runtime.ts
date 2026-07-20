// Pure policy shared by the Pi runtime. Keep this Electron-free so the
// keyless-provider and terminal-error contracts have fast, deterministic tests.

import type { ProviderHeaders } from "@earendil-works/pi-ai";

/**
 * Pi's current compatibility transports require a non-empty constructor value
 * even when an endpoint does not authenticate. This fixed value is process-only
 * and non-secret; resolveRuntimeHeaders removes the generated auth headers
 * before a request leaves Aiden.
 */
export const PI_AUTH_COMPATIBILITY_TOKEN = "aiden-local-no-auth";

/**
 * The Anthropic SDK owns its `/v1/messages` route. Aiden stores provider URLs
 * in the same `/v1` form as OpenAI-compatible endpoints, so remove that
 * suffix only at generation time for Anthropic-compatible providers.
 */
export function resolveRuntimeBaseUrl(provider: {
  kind: "openai" | "anthropic";
  baseUrl: string;
}): string {
  const baseUrl = provider.baseUrl.replace(/\/+$/u, "");
  return provider.kind === "anthropic" ? baseUrl.replace(/\/v1$/iu, "") : baseUrl;
}

export function resolveRuntimeApiKey(
  provider: { needsKey: boolean },
  storedApiKey: string | null | undefined,
): string | undefined {
  if (!provider.needsKey) return PI_AUTH_COMPATIBILITY_TOKEN;
  const key = storedApiKey?.trim();
  return key || undefined;
}

/**
 * Suppress SDK-generated authentication headers for an explicitly keyless
 * provider. Pi still receives the compatibility token above, but the endpoint
 * receives neither that value nor an empty authentication header.
 */
export function resolveRuntimeHeaders(provider: {
  kind: "openai" | "anthropic";
  needsKey: boolean;
}): ProviderHeaders | undefined {
  if (provider.needsKey) return undefined;
  return provider.kind === "anthropic"
    ? { Authorization: null, "x-api-key": null }
    : { Authorization: null };
}

type TerminalAssistantMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
};

/** Extract a Pi protocol-level terminal error from an Agent message. */
export function terminalGenerationError(message: TerminalAssistantMessage): string | null {
  if (message.role !== "assistant" || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "The model couldn't complete this response.";
}

/** Pi reports user-initiated stops as a terminal assistant message as well. */
export function terminalGenerationWasAborted(message: TerminalAssistantMessage): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

/** Return final text when a provider completes without emitting text deltas. */
export function terminalAssistantText(message: { role?: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/** Add terminal text only when this assistant turn did not already stream it. */
export function terminalAssistantTextFallback(
  message: { role?: string; content?: unknown },
  receivedTextDelta: boolean,
): string {
  return receivedTextDelta ? "" : terminalAssistantText(message);
}
