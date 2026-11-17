// How a user message reached the chat. Absent means it was typed (or sent
// from a phone or Telegram as before). "voice" marks a message Aiden Live sent
// for the person after they asked out loud, so every client can show a small
// "By voice" label under the bubble. It is display-only: it never changes how
// the message runs, and only Live's chat tools set it.

export const CHAT_INPUT_SOURCES = ["voice"] as const;
export type ChatInputSourceV1 = (typeof CHAT_INPUT_SOURCES)[number];

/** The label clients draw for a voice message. */
export const CHAT_VOICE_INPUT_LABEL = "By voice";

/** A stored or wire value, or undefined for anything else (old data, unknown values). */
export function parseChatInputSource(value: unknown): ChatInputSourceV1 | undefined {
  return value === "voice" ? "voice" : undefined;
}

/** Strict form for IPC envelopes: absent is fine, anything but "voice" is refused. */
export function parseChatInputSourceStrict(value: unknown, label = "input source"): ChatInputSourceV1 | undefined {
  if (value === undefined) return undefined;
  const parsed = parseChatInputSource(value);
  if (!parsed) throw new Error(`Invalid ${label}.`);
  return parsed;
}
