import type { AssistantMessage } from "@earendil-works/pi-ai";

export type StoredPiAssistantMessage = Omit<AssistantMessage, "diagnostics">;

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

/** Persist the provider-authored Pi message without raw diagnostics. */
export function storedPiAssistantMessage(
  message: AssistantMessage,
): StoredPiAssistantMessage {
  const { diagnostics: _diagnostics, ...stored } = message;
  return structuredClone(stored);
}

/** Fail closed when a device-local chat payload contains malformed Pi provenance. */
export function parseStoredPiAssistantMessage(
  value: unknown,
): StoredPiAssistantMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as Partial<AssistantMessage>;
  if (
    candidate.role !== "assistant" ||
    !Array.isArray(candidate.content) ||
    typeof candidate.api !== "string" ||
    typeof candidate.provider !== "string" ||
    typeof candidate.model !== "string" ||
    !candidate.usage ||
    typeof candidate.usage !== "object" ||
    !STOP_REASONS.has(String(candidate.stopReason)) ||
    !Number.isSafeInteger(candidate.timestamp)
  ) {
    return undefined;
  }
  const { diagnostics: _diagnostics, ...stored } =
    candidate as AssistantMessage;
  return structuredClone(stored);
}
