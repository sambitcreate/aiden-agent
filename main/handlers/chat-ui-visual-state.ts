import { AIDEN_UI_LIMITS } from "../../renderer/shared/aiden-ui/types.js";
import { isWireSafeKey } from "../../renderer/shared/aiden-ui/visual.js";

export interface UiVisualStateUpdate {
  chatId: string;
  messageId: string;
  visualId: string;
  state: Record<string, unknown>;
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`Invalid ${name}.`);
  return value;
}

function keysAreWireSafe(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.every((item) => keysAreWireSafe(item, depth + 1));
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, inner]) => isWireSafeKey(key) && keysAreWireSafe(inner, depth + 1));
}

/** Validates a renderer request to remember a visual's local state (at most 4 KiB). */
export function parseUiVisualStateUpdate(input: unknown): UiVisualStateUpdate {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid visual state update.");
  const record = input as Record<string, unknown>;
  const state = record.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Visual state must be an object.");
  if (!keysAreWireSafe(state)) throw new Error("Visual state uses a reserved key name.");
  if (new TextEncoder().encode(JSON.stringify(state)).length > AIDEN_UI_LIMITS.stateBytes) {
    throw new Error("Visual state is too large.");
  }
  return {
    chatId: id(record.chatId, "chatId"),
    messageId: id(record.messageId, "messageId"),
    visualId: id(record.visualId, "visualId"),
    state: state as Record<string, unknown>,
  };
}
