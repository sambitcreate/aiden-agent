// Pure policy shared by the Pi runtime. Keep this Electron-free so the
// keyless-provider and terminal-error contracts have fast, deterministic tests.

import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type {
  Api,
  Model,
  ProviderHeaders,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  googleThinkingLevelsForModel,
  isGoogleThinkingLevel,
} from "../../renderer/shared/google-thinking.js";
import {
  codexThinkingLevelsForModel,
  isCodexThinkingLevel,
  normalizeCodexThinkingLevel,
} from "../../renderer/shared/codex-thinking.js";
import type { GenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import {
  anthropicThinkingLevelsForModel,
  isAnthropicThinkingLevel,
  normalizeAnthropicThinkingLevel,
} from "../../renderer/shared/anthropic-thinking.js";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic-provider.js";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import {
  isLocalProviderDeployment,
  type ProviderDeploymentFields,
} from "../../renderer/shared/provider-deployment.js";

/**
 * Pi's current compatibility transports require a non-empty constructor value
 * even when an endpoint does not authenticate. This fixed value is process-only
 * and non-secret; resolveRuntimeHeaders removes the generated auth headers
 * before a request leaves Aiden.
 */
export const PI_AUTH_COMPATIBILITY_TOKEN = "aiden-local-no-auth";

/**
 * Match Pi's provider-neutral display contract for readable thinking blocks.
 * Local visibility is a presentation preference only; the canonical Pi message
 * remains private and complete regardless of this decision.
 */
export function shouldExposeReasoning(
  provider: ProviderDeploymentFields,
  showLocalModelReasoning: boolean | undefined,
): boolean {
  return !isLocalProviderDeployment(provider) || showLocalModelReasoning !== false;
}

/** Preserve provider-specific normalization while honoring every Pi reasoning model. */
export function resolveGenerationThinkingLevel(
  providerId: string,
  model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
  requested: GenerationThinkingLevel | undefined,
): GenerationThinkingLevel {
  if (providerId === GOOGLE_PROVIDER_ID) {
    return isGoogleThinkingLevel(requested) &&
      googleThinkingLevelsForModel(model).includes(requested)
      ? requested
      : "off";
  }
  if (providerId === OPENAI_CODEX_PROVIDER_ID) {
    const levels = codexThinkingLevelsForModel(model);
    if (levels.length === 0) return "off";
    return isCodexThinkingLevel(requested) && levels.includes(requested)
      ? requested
      : normalizeCodexThinkingLevel(levels, undefined);
  }
  if (providerId === ANTHROPIC_PROVIDER_ID) {
    const levels = anthropicThinkingLevelsForModel(model);
    if (levels.length === 0) return "off";
    return isAnthropicThinkingLevel(requested) && levels.includes(requested)
      ? requested
      : normalizeAnthropicThinkingLevel(levels, undefined);
  }
  if (!model.reasoning || !requested || requested === "off") return "off";
  if (
    model.thinkingLevelMap &&
    (!(requested in model.thinkingLevelMap) ||
      model.thinkingLevelMap[requested] === null)
  ) {
    return "off";
  }
  return requested;
}

/** The connection-bound runtime model is the sole request-time image authority. */
export function runtimeSupportsImages(
  model: Pick<Model<Api>, "input">,
): boolean {
  return model.input.includes("image");
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
  return provider.kind === "anthropic"
    ? baseUrl.replace(/\/v1$/iu, "")
    : baseUrl;
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

/**
 * An aborted generation can still be in setup when shutdown starts, or hand
 * off to active state during that abort. Wait for both maps to clear under the
 * caller's existing deadline rather than treating the active snapshot as the
 * whole parent lifecycle.
 */
export async function waitForGenerationStateClear(
  isBusy: () => boolean,
  completions: () => readonly (Promise<unknown> | null | undefined)[],
  deadline: number,
): Promise<boolean> {
  while (isBusy()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const pending = completions().filter(
      (completion): completion is Promise<unknown> =>
        completion !== null && completion !== undefined,
    );
    const pause = new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
    await Promise.race(
      pending.length > 0
        ? [pause, Promise.allSettled(pending).then(() => undefined)]
        : [pause],
    );
  }
  return true;
}

/** Wait without making Stop advisory during a bounded retry backoff. */
export async function waitForAbortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted)
    throw signal.reason ?? new Error("Generation was cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Generation was cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer.unref?.();
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
        headers: runtime.headers
          ? { ...options?.headers, ...runtime.headers }
          : options?.headers,
      }),
  };
}

type TerminalAssistantMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
};

/** Extract a Pi protocol-level terminal error from an Agent message. */
export function terminalGenerationError(
  message: TerminalAssistantMessage,
): string | null {
  if (message.role !== "assistant" || message.stopReason !== "error")
    return null;
  return (
    message.errorMessage?.trim() || "The model couldn't complete this response."
  );
}

/** A length stop is a usable partial response, but never a successful completion. */
export function terminalGenerationLengthError(
  message: TerminalAssistantMessage,
): string | null {
  return message.role === "assistant" && message.stopReason === "length"
    ? "The model reached its output limit. The partial response was saved; ask it to continue."
    : null;
}

/** Pi reports user-initiated stops as a terminal assistant message as well. */
export function terminalGenerationWasAborted(
  message: TerminalAssistantMessage,
): boolean {
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
export function terminalAssistantText(message: {
  role?: string;
  content?: unknown;
}): string {
  if (message.role !== "assistant" || !Array.isArray(message.content))
    return "";
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

/**
 * Separate visible prose emitted by distinct Pi assistant turns. Providers do
 * not guarantee boundary whitespace around tool calls, but Aiden presents the
 * turns as one Markdown response, so preserve at least one paragraph break.
 */
export function assistantTurnTextSeparator(
  previous: string,
  next: string,
): string {
  if (!previous.trim() || !next.trim()) return "";
  const trailingNewlines = previous.match(/\n*$/u)?.[0].length ?? 0;
  const leadingNewlines = next.match(/^\n*/u)?.[0].length ?? 0;
  return "\n".repeat(
    Math.max(0, 2 - trailingNewlines - leadingNewlines),
  );
}

/** Return visible, non-redacted thinking blocks from a terminal Pi assistant message. */
export function terminalAssistantReasoning(message: {
  role?: string;
  content?: unknown;
}): string {
  if (message.role !== "assistant" || !Array.isArray(message.content))
    return "";
  return message.content
    .filter(
      (
        part,
      ): part is { type: "thinking"; thinking: string; redacted?: boolean } =>
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

export interface TerminalAssistantProjection {
  full: string;
  reasoning: string;
  changed: boolean;
}

/**
 * Provider delta events can arrive in block/event order that differs from the
 * canonical Pi message content order. Replace only the current assistant turn
 * with Pi's terminal projection so persistence and the renderer stay exact.
 */
export function reconcileTerminalAssistantProjection(
  accumulated: { full: string; reasoning: string },
  turnStart: { full: number; reasoning: number },
  message: { role?: string; content?: unknown },
  exposeReasoning: boolean,
): TerminalAssistantProjection {
  if (message.role !== "assistant") {
    return { ...accumulated, changed: false };
  }
  const fullPrefix = accumulated.full.slice(0, turnStart.full);
  const terminalText = terminalAssistantText(message);
  const full = `${fullPrefix}${assistantTurnTextSeparator(fullPrefix, terminalText)}${terminalText}`;
  const terminalReasoning = exposeReasoning
    ? terminalAssistantReasoning(message)
    : "";
  const reasoningPrefix = accumulated.reasoning.slice(0, turnStart.reasoning);
  const reasoning = terminalReasoning
    ? `${reasoningPrefix}${reasoningPrefix.trim() ? "\n\n" : ""}${terminalReasoning}`
    : reasoningPrefix;
  return {
    full,
    reasoning,
    changed: full !== accumulated.full || reasoning !== accumulated.reasoning,
  };
}
