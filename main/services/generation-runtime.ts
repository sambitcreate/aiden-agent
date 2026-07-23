// Pure policy shared by the Pi runtime. Keep this Electron-free so the
// keyless-provider and terminal-error contracts have fast, deterministic tests.

import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { Api, Model, ProviderHeaders, ProviderStreams } from "@earendil-works/pi-ai";

/**
 * Pi's current compatibility transports require a non-empty constructor value
 * even when an endpoint does not authenticate. This fixed value is process-only
 * and non-secret; resolveRuntimeHeaders removes the generated auth headers
 * before a request leaves Aiden.
 */
export const PI_AUTH_COMPATIBILITY_TOKEN = "aiden-local-no-auth";

const LOCAL_REASONING_PROVIDER_IDS = new Set(["lmstudio", "ollama"]);

/** Only explicit local presets expose provider-authored reasoning in the transcript. */
export function shouldExposeLocalReasoning(providerId: string): boolean {
  return LOCAL_REASONING_PROVIDER_IDS.has(providerId);
}

/**
 * Pi's provider serializers use Model.input as the authoritative image gate.
 * Merge only positive trusted metadata into a cloned generation snapshot so
 * legacy vision models and tool screenshots follow the same decision.
 */
export function effectiveModelForGeneration<TApi extends Api>(
  model: Model<TApi>,
  trustedVision: boolean | undefined,
): Model<TApi> {
  const supportsImages = model.input.includes("image") || trustedVision === true;
  return {
    ...model,
    input: supportsImages ? ["text", "image"] : ["text"],
  };
}

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

interface AgentRuntimeTransport {
  apiKey: string | undefined;
  headers: ProviderHeaders | undefined;
  streams: Pick<ProviderStreams, "streamSimple">;
}

export interface GenerationCleanupEntry {
  reset(): void;
  close?: () => Promise<unknown>;
  completion?: Promise<unknown> | null;
}

/**
 * Clear in-memory agent transcripts synchronously, then bound all slower
 * helper/process and provider-loop teardown behind one deadline.
 */
export async function settleGenerationCleanup(
  entries: readonly GenerationCleanupEntry[],
  graceMs: number,
  onResetError: (error: unknown) => void = () => {},
): Promise<boolean> {
  for (const entry of entries) {
    try {
      entry.reset();
    } catch (error) {
      onResetError(error);
    }
  }
  const operations: Promise<unknown>[] = [];
  for (const entry of entries) {
    if (entry.close) {
      try {
        operations.push(entry.close());
      } catch (error) {
        operations.push(Promise.reject(error));
      }
    }
    if (entry.completion) operations.push(entry.completion);
  }
  if (!operations.length) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, graceMs));
    void Promise.allSettled(operations).then(() => finish(true));
  });
}

/** Keep the chat identity and provider transport attached to every Pi Agent turn. */
export function buildAgentRuntimeOptions(
  chatId: string,
  runtime: AgentRuntimeTransport,
): Pick<AgentOptions, "sessionId" | "getApiKey" | "streamFn"> {
  return {
    sessionId: chatId,
    getApiKey: () => runtime.apiKey,
    streamFn: (model, context, options) =>
      runtime.streams.streamSimple(model, context, {
        ...options,
        apiKey: options?.apiKey ?? runtime.apiKey,
        // Runtime headers are last so a keyless provider cannot inherit an
        // Authorization header from Pi's default client setup.
        headers: runtime.headers ? { ...options?.headers, ...runtime.headers } : options?.headers,
      }),
  };
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

/** Only app-owned cancellation is a successful stop; dependency aborts are interruptions. */
export function terminalGenerationInterruptionError(
  wasAborted: boolean,
  cancelRequested: boolean,
): string | null {
  return wasAborted && !cancelRequested
    ? "The response was interrupted before it finished. Try again."
    : null;
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

/** Return visible, non-redacted thinking blocks from a terminal Pi assistant message. */
export function terminalAssistantReasoning(message: { role?: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { type: "thinking"; thinking: string; redacted?: boolean } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "thinking" &&
        typeof (part as { thinking?: unknown }).thinking === "string" &&
        (part as { redacted?: unknown }).redacted !== true,
    )
    .map((part) => part.thinking)
    .join("\n\n");
}

/** Add terminal reasoning only when this assistant turn did not already stream it. */
export function terminalAssistantReasoningFallback(
  message: { role?: string; content?: unknown },
  receivedReasoningDelta: boolean,
): string {
  return receivedReasoningDelta ? "" : terminalAssistantReasoning(message);
}
