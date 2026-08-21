import type { AssistantMessage } from "@earendil-works/pi-ai";

export type StoredPiAssistantMessage = Omit<
  AssistantMessage,
  "diagnostics" | "errorMessage"
>;

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validJsonValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): boolean {
  state.nodes += 1;
  if (state.nodes > 100_000 || depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => validJsonValue(item, state, depth + 1));
  }
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) =>
    validJsonValue(item, state, depth + 1),
  );
}

function validContentBlock(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  if (block.type === "text") {
    return typeof block.text === "string" && optionalString(block.textSignature);
  }
  if (block.type === "thinking") {
    return typeof block.thinking === "string" &&
      optionalString(block.thinkingSignature) &&
      (block.redacted === undefined || typeof block.redacted === "boolean");
  }
  if (block.type === "toolCall") {
    return nonemptyString(block.id) &&
      nonemptyString(block.name) &&
      block.arguments !== null &&
      typeof block.arguments === "object" &&
      !Array.isArray(block.arguments) &&
      validJsonValue(block.arguments, { nodes: 0 }) &&
      optionalString(block.thoughtSignature);
  }
  return false;
}

function validUsage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (
    !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
      (key) => finiteNonnegative(usage[key]),
    ) ||
    (usage.cacheWrite1h !== undefined && !finiteNonnegative(usage.cacheWrite1h)) ||
    (usage.reasoning !== undefined && !finiteNonnegative(usage.reasoning)) ||
    !usage.cost ||
    typeof usage.cost !== "object" ||
    Array.isArray(usage.cost)
  ) return false;
  const cost = usage.cost as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every(
    (key) => finiteNonnegative(cost[key]),
  );
}

/** Persist provider protocol without raw diagnostics or provider-authored errors. */
export function storedPiAssistantMessage(
  message: AssistantMessage,
): StoredPiAssistantMessage {
  const {
    diagnostics: _diagnostics,
    errorMessage: _errorMessage,
    ...stored
  } = message;
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
    !candidate.content.every(validContentBlock) ||
    !nonemptyString(candidate.api) ||
    !nonemptyString(candidate.provider) ||
    !nonemptyString(candidate.model) ||
    !validUsage(candidate.usage) ||
    !STOP_REASONS.has(String(candidate.stopReason)) ||
    !Number.isSafeInteger(candidate.timestamp) ||
    (candidate.timestamp as number) < 0 ||
    !optionalString(candidate.responseModel) ||
    !optionalString(candidate.responseId) ||
    !optionalString(candidate.errorMessage)
  ) {
    return undefined;
  }
  const {
    diagnostics: _diagnostics,
    errorMessage: _errorMessage,
    ...stored
  } = candidate as AssistantMessage;
  try {
    return structuredClone(stored);
  } catch {
    return undefined;
  }
}
