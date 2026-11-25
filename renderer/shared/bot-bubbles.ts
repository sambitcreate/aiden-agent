// Bot bubbles (Edge heads): the contract shared by main, the main window and
// the bubble overlay window. Dependency-free so main, React and node:test can
// all import it. See docs/bot-bubbles.md.
//
// A bubble is a desktop-only view of a Bot chat that already exists. Its list
// lives only on this computer (`<userData>/bot-bubbles.json`) and is never sent
// to phones, paired Macs or analytics.

/** At most this many heads are out at once; a sixth pushes the oldest to recents. */
export const BOT_BUBBLE_LIMIT = 5;
/** Recently closed or pushed-out bubbles kept for "Bubble again". */
export const BOT_BUBBLE_RECENT_LIMIT = 8;
/** A head's diameter in CSS pixels. */
export const BOT_BUBBLE_HEAD_SIZE = 52;

export const BOT_BUBBLE_CHANNELS = {
  /** invoke → BotBubbleState. Any trusted Aiden window. */
  state: "bots:bubbles:state",
  /** invoke(BotBubbleRequest) → BotBubbleState. Main window only. */
  bubble: "bots:bubbles:bubble",
  /** invoke({ botId }) → BotBubbleState. Main window or bubble window. */
  close: "bots:bubbles:close",
  /** invoke(BotBubbleOpenRequest) → BotBubbleState: which head's mini chat is open. */
  open: "bots:bubbles:open",
  /** invoke({ botId, placement }) → BotBubbleState. */
  move: "bots:bubbles:move",
  /**
   * invoke({ botId, sourceRect? }) → BotBubbleState: "Open in Aiden" / "Bring back
   * here". Closes the bubble, then shows the Bot's chat in the main window.
   */
  bringBack: "bots:bubbles:bringBack",
  /** invoke({ botId }) → BotBubbleState: drop a Bot from the recent list. */
  forgetRecent: "bots:bubbles:forgetRecent",
  /** Overlay only. invoke({ interactive: boolean }): stop or start passing clicks through. */
  setInteractive: "bots:bubbles:setInteractive",
  /** Overlay only. invoke({ dragging: boolean }): a head is being dragged (X11 growth, focus). */
  setDragging: "bots:bubbles:setDragging",
  /** Overlay only. invoke() → BotBubbleOverlayInfo for the overlay that asks. */
  overlayInfo: "bots:bubbles:overlayInfo",
  /** notification: BotBubbleState, to every window that shows heads or bubble controls. */
  changed: "bots:bubbles:changed",
  /** notification to an overlay: BotBubbleTransition (the shrink or grow animation). */
  transition: "bots:bubbles:transition",
  /** notification to an overlay: BotBubbleOverlayInfo, after its display's work area or zoom changed. */
  overlayInfoChanged: "bots:bubbles:overlayInfoChanged",
  /** notification to the main window: { botId } — show this Bot's chat (Open in Aiden). */
  showChat: "bots:bubbles:showChat",
} as const;

export type BotBubbleSide = "left" | "right";

export interface BotBubblePlacement {
  side: BotBubbleSide;
  /**
   * The head's top edge as a share (0..1) of the free height of its area
   * (area height minus one head). A share survives display and window resizes.
   */
  y: number;
  /** The Electron display id the head sits on; null means the primary display. */
  displayId: number | null;
}

export interface BotBubble {
  botId: string;
  placement: BotBubblePlacement;
}

/**
 * Where heads draw now:
 * - "overlay": a see-through window over every app (macOS, switch on).
 * - "window": inside the Aiden main window (switch off, Linux, Wayland).
 * - "off": bubbles are turned off in Settings; no heads and no bubble button.
 */
export type BotBubbleHost = "overlay" | "window" | "off";

export interface BotBubbleSettings {
  /** Settings → Bots → Bubbles → Allow bubbles. */
  enabled: boolean;
  /** Settings → Bots → Bubbles → Float over other apps. */
  floatOverApps: boolean;
}

export interface BotBubbleState {
  /** Oldest first. At most BOT_BUBBLE_LIMIT. */
  bubbles: readonly BotBubble[];
  /** The head whose mini chat is open, if any. Always one of `bubbles`. */
  openBotId: string | null;
  /** Most recent first; never a Bot that is bubbled now. */
  recents: readonly string[];
  settings: BotBubbleSettings;
  host: BotBubbleHost;
  /** Whether this desktop can float heads over other apps at all (macOS only). */
  floatOverAppsAvailable: boolean;
}

export interface BotBubbleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BotBubbleOpenRequest {
  /** The head whose mini chat opens; null tucks the open one away. */
  botId: string | null;
  /**
   * Only if this head's chat is the open one; otherwise nothing changes. An
   * overlay tucking its chat away on blur sends it, so a late tuck can't close
   * a chat another display opened meanwhile.
   */
  ifOpen?: string;
}

export interface BotBubbleRequest {
  botId: string;
  /** The chat area in the sender window's CSS pixels, for the shrink animation. */
  sourceRect?: BotBubbleRect;
  /** Prefer this side for a new head (defaults to "right"). */
  side?: BotBubbleSide;
}

/** Sent to an overlay so it can play the shrink into a head or the grow out of one. */
export interface BotBubbleTransition {
  botId: string;
  kind: "shrink" | "grow";
  /** Overlay-local CSS pixels of the big end of the animation (the main window's chat area). */
  rect: BotBubbleRect;
  /** A PNG data URL of the chat area, when main could capture one. */
  image: string | null;
}

export interface BotBubbleOverlayInfo {
  displayId: number;
  /** The overlay's area in its own CSS pixels (the display's work area, from 0,0). */
  width: number;
  height: number;
  /**
   * Whether this overlay is on the primary display, where heads with a null
   * `displayId` sit. Left out, the overlay treats itself as primary.
   */
  primary?: boolean;
}

export const DEFAULT_BOT_BUBBLE_SETTINGS: BotBubbleSettings = { enabled: true, floatOverApps: true };

export const EMPTY_BOT_BUBBLE_STATE: BotBubbleState = {
  bubbles: [],
  openBotId: null,
  recents: [],
  settings: DEFAULT_BOT_BUBBLE_SETTINGS,
  host: "off",
  floatOverAppsAvailable: false,
};

/** The same shape main's `parseBotId` accepts (path-safe, at most 160 characters). */
const BOT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

export function isBotBubbleBotId(value: unknown): value is string {
  return typeof value === "string" && BOT_ID_PATTERN.test(value) && value !== "." && value !== "..";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function clampBubbleShare(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function parseBotBubblePlacement(raw: unknown): BotBubblePlacement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.side !== "left" && value.side !== "right") return null;
  if (!finite(value.y)) return null;
  const displayId = value.displayId === null || value.displayId === undefined ? null : value.displayId;
  if (displayId !== null && (!finite(displayId) || !Number.isInteger(displayId))) return null;
  return { side: value.side, y: clampBubbleShare(value.y), displayId };
}

export function parseBotBubbleRect(raw: unknown): BotBubbleRect | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height)) return null;
  if (value.width <= 0 || value.height <= 0 || value.width > 20_000 || value.height > 20_000) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

/** A renderer-side guard for the state main sends; anything malformed is the empty state. */
export function parseBotBubbleState(raw: unknown): BotBubbleState {
  if (typeof raw !== "object" || raw === null) return EMPTY_BOT_BUBBLE_STATE;
  const value = raw as Record<string, unknown>;
  const bubbles: BotBubble[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.bubbles)) {
    for (const item of value.bubbles) {
      if (typeof item !== "object" || item === null) continue;
      const botId = (item as Record<string, unknown>).botId;
      const placement = parseBotBubblePlacement((item as Record<string, unknown>).placement);
      if (!isBotBubbleBotId(botId) || !placement || seen.has(botId)) continue;
      seen.add(botId);
      bubbles.push({ botId, placement });
      if (bubbles.length === BOT_BUBBLE_LIMIT) break;
    }
  }
  const recents = Array.isArray(value.recents)
    ? value.recents.filter((id): id is string => isBotBubbleBotId(id) && !seen.has(id)).slice(0, BOT_BUBBLE_RECENT_LIMIT)
    : [];
  const openBotId = isBotBubbleBotId(value.openBotId) && seen.has(value.openBotId) ? value.openBotId : null;
  const rawSettings = (typeof value.settings === "object" && value.settings !== null ? value.settings : {}) as Record<string, unknown>;
  const settings: BotBubbleSettings = {
    enabled: rawSettings.enabled !== false,
    floatOverApps: rawSettings.floatOverApps !== false,
  };
  const host: BotBubbleHost = value.host === "overlay" || value.host === "window" ? value.host : "off";
  return { bubbles, openBotId, recents, settings, host, floatOverAppsAvailable: value.floatOverAppsAvailable === true };
}

export function isBotBubbled(state: BotBubbleState, botId: string): boolean {
  return state.bubbles.some((bubble) => bubble.botId === botId);
}
