// Pure parsing helpers for the chat generation IPC handlers, extracted so they
// can be unit-tested without importing Electron. See handlers/chat.ts.

import type { ChatStartParams } from "../services/types.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import {
  MAX_CHAT_ID_BYTES,
  MAX_CHAT_ID_CHARS,
  MAX_MODEL_ID_BYTES,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_BYTES,
  MAX_PROVIDER_ID_CHARS,
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";

const ALLOWED_CHAT_START_KEYS = new Set([
  "chatId",
  "model",
  "mode",
  "providerId",
  "thinkingLevel",
  "workspaceId",
]);

function boundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes)
    throw new Error(`Invalid ${label}.`);
  return value;
}

export function parseParams(value: unknown): ChatStartParams {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid generation params.");
  const p = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(p, "messages")) {
    throw new Error(
      "Generation history is main-owned and cannot be supplied by the renderer.",
    );
  }
  let keyCount = 0;
  for (const key in p) {
    if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
    keyCount += 1;
    if (
      keyCount > ALLOWED_CHAT_START_KEYS.size ||
      !ALLOWED_CHAT_START_KEYS.has(key)
    ) {
      throw new Error("Invalid generation fields.");
    }
  }
  const chatId = boundedString(
    p.chatId,
    "chat id",
    MAX_CHAT_ID_CHARS,
    MAX_CHAT_ID_BYTES,
  )!;
  const workspaceId = boundedString(
    p.workspaceId,
    "workspace id",
    MAX_WORKSPACE_ID_CHARS,
    MAX_WORKSPACE_ID_BYTES,
    true,
  );
  const providerId = boundedString(
    p.providerId,
    "provider id",
    MAX_PROVIDER_ID_CHARS,
    MAX_PROVIDER_ID_BYTES,
  )!;
  const model = boundedString(
    p.model,
    "model id",
    MAX_MODEL_ID_CHARS,
    MAX_MODEL_ID_BYTES,
  )!;
  if (
    p.thinkingLevel !== undefined &&
    !isGenerationThinkingLevel(p.thinkingLevel)
  ) {
    throw new Error("Invalid thinking level.");
  }
  // Background Assistant modes are deliberately not accepted here: only main
  // may grant an unattended prompt or project-scoped automation capabilities.
  if (p.mode !== undefined && p.mode !== "assistant")
    throw new Error("Invalid chat mode.");
  const thinkingLevel = isGenerationThinkingLevel(p.thinkingLevel)
    ? p.thinkingLevel
    : undefined;

  return {
    chatId,
    workspaceId,
    providerId,
    model,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(p.mode === "assistant" ? { mode: "assistant" as const } : {}),
    messages: [],
  };
}
