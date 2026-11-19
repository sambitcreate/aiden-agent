import { isLmStudioProviderId, isOllamaProviderId } from "./custom-provider-id.js";
import { isLocalModelProvider } from "./usage-accounting.js";
import type { StoredProvider } from "./types.js";
import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import { oneOffCallOptions } from "./side-call-prefix.js";

export const DICTATION_CLEANUP_SYSTEM_PROMPT =
  "You clean dictated text. Fix punctuation and casing, remove filler such as um and uh, and keep the speaker's meaning and language. Return only the cleaned transcript.";

export const DICTATION_CLEANUP_TIMEOUT_MS = 12_000;
export const DICTATION_CLEANUP_MAX_CHARS = 100_000;

export function buildDictationCleanupUserPrompt(transcript: string): string {
  return `Clean this dictation:\n\n${transcript}`;
}

/** Keep the original transcript when the model returns empty or runaway text. */
export function sanitizeDictationCleanupOutput(
  raw: unknown,
  original: string,
): string {
  if (typeof raw !== "string") return original;
  let text = raw.trim();
  if (!text) return original;
  const fence = text.match(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/);
  if (fence) text = (fence[1] ?? "").trim();
  if (!text) return original;
  if (text.length > Math.max(original.length * 4, 8_000)) return original;
  return text.slice(0, DICTATION_CLEANUP_MAX_CHARS);
}

export function dictationCleanupUsageIsLocal(
  provider: Pick<StoredProvider, "id" | "label" | "baseUrl" | "needsKey" | "deployment"> | undefined,
  providerId: string,
): boolean {
  if (provider) return isLocalModelProvider(provider);
  return isLmStudioProviderId(providerId) || isOllamaProviderId(providerId);
}

/** Sends the one cleanup request for a transcript; it is never cached. */
export function requestDictationCleanup(
  runtime: Pick<ResolvedModelRuntime, "model" | "apiKey" | "headers" | "streams">,
  original: string,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  return runtime.streams
    .streamSimple(
      runtime.model,
      normalizeContext({
        systemPrompt: DICTATION_CLEANUP_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildDictationCleanupUserPrompt(original) }],
            timestamp: Date.now(),
          },
        ],
      }),
      oneOffCallOptions({
        apiKey: runtime.apiKey,
        headers: runtime.headers,
        signal,
        temperature: 0.1,
        maxTokens: 1_024,
        timeoutMs: DICTATION_CLEANUP_TIMEOUT_MS,
        maxRetries: 0,
      }),
    )
    .result();
}
