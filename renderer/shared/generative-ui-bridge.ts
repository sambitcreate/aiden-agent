/** Closed guest↔host message contract for inline Generative UI frames. */
import { GENERATIVE_UI_ESCAPE_MESSAGE } from "./generative-ui.js";

export const GENERATIVE_UI_RESIZE_MESSAGE = "aiden:generative-ui:resize" as const;
export const GENERATIVE_UI_PROMPT_MESSAGE = "aiden:generative-ui:prompt" as const;
export const GENERATIVE_UI_THEME_MESSAGE = "aiden:generative-ui:theme" as const;

export const MIN_INLINE_VISUAL_HEIGHT = 64;
export const MAX_INLINE_VISUAL_HEIGHT = 1600;
export const MAX_GUEST_PROMPT_CHARS = 2000;
export const GUEST_PROMPT_COOLDOWN_MS = 3000;

/** The guest bridge is running; the host answers with the current theme. */
export const GENERATIVE_UI_READY_MESSAGE = "aiden:generative-ui:ready" as const;

export type GuestBridgeMessage =
  | { type: "escape" }
  | { type: "ready" }
  | { type: "resize"; height: number }
  | { type: "prompt"; text: string };

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

export function parseGuestBridgeMessage(data: unknown): GuestBridgeMessage | undefined {
  if (data === GENERATIVE_UI_ESCAPE_MESSAGE) return { type: "escape" };
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.type === GENERATIVE_UI_READY_MESSAGE && exactKeys(record, ["type"])) {
    return { type: "ready" };
  }
  if (record.type === GENERATIVE_UI_RESIZE_MESSAGE && exactKeys(record, ["type", "height"])) {
    return typeof record.height === "number" ? { type: "resize", height: record.height } : undefined;
  }
  if (record.type === GENERATIVE_UI_PROMPT_MESSAGE && exactKeys(record, ["type", "text"])) {
    return typeof record.text === "string" ? { type: "prompt", text: record.text } : undefined;
  }
  return undefined;
}

export function clampInlineVisualHeight(height: number): number {
  if (Number.isNaN(height)) return MIN_INLINE_VISUAL_HEIGHT;
  return Math.min(MAX_INLINE_VISUAL_HEIGHT, Math.max(MIN_INLINE_VISUAL_HEIGHT, Math.ceil(height)));
}

export interface GuestPromptInput {
  text: string;
  /** `document.activeElement` is this frame. Necessary, not sufficient: a guest can focus itself. */
  frameFocused: boolean;
  /** The user's own input reached this frame (`createFrameGestureTracker`). */
  userActivated: boolean;
  /** This visual already staged an ungestured suggestion since the user last sent. */
  alreadyStaged: boolean;
  chatBusy: boolean;
  /** Monotonic milliseconds (performance.now), so wall-clock jumps can't lock prompts out. */
  now: number;
  lastAcceptedAt?: number;
}

export type GuestPromptDecision =
  | { action: "send" | "stage"; text: string }
  | { action: "reject"; reason: "unfocused" | "empty" | "too_long" | "cooldown" | "repeat" };

export function decideGuestPrompt(input: GuestPromptInput): GuestPromptDecision {
  if (!input.frameFocused) return { action: "reject", reason: "unfocused" };
  if (input.text.length > MAX_GUEST_PROMPT_CHARS) return { action: "reject", reason: "too_long" };
  const text = input.text.trim();
  if (!text) return { action: "reject", reason: "empty" };
  if (input.lastAcceptedAt !== undefined && input.now - input.lastAcceptedAt < GUEST_PROMPT_COOLDOWN_MS) {
    return { action: "reject", reason: "cooldown" };
  }
  if (input.userActivated) return { action: input.chatBusy ? "stage" : "send", text };
  // Without a gesture the guest may suggest one follow-up, into the composer
  // for the user to review, until the user next sends; it can never send or
  // flood (focus cycling cannot reset this).
  return input.alreadyStaged ? { action: "reject", reason: "repeat" } : { action: "stage", text };
}

/** Chromium's transient user activation lifetime. */
export const USER_ACTIVATION_WINDOW_MS = 5000;
