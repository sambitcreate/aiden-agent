// Bot bubbles: the pure list logic behind the bubble service. No Electron and
// no file system, so every rule (limit, recents, placement, pruning, host
// choice, the saved file's shape) is checked by plain fixtures.

import {
  BOT_BUBBLE_LIMIT,
  BOT_BUBBLE_RECENT_LIMIT,
  isBotBubbleBotId,
  parseBotBubblePlacement,
  type BotBubble,
  type BotBubbleHost,
  type BotBubblePlacement,
  type BotBubbleSettings,
  type BotBubbleSide,
  type BotBubbleState,
} from "../../../renderer/shared/bot-bubbles.js";

/** What the service owns; settings and host are derived from app settings. */
export interface BotBubbleList {
  /** Oldest first. */
  readonly bubbles: readonly BotBubble[];
  readonly openBotId: string | null;
  /** Most recent first; never a bubbled Bot. */
  readonly recents: readonly string[];
}

export const EMPTY_BOT_BUBBLE_LIST: BotBubbleList = { bubbles: [], openBotId: null, recents: [] };

/** Where the first head on an empty side sits (a share of the free height). */
export const BOT_BUBBLE_FIRST_SHARE = 0.2;
/**
 * The share between a new head and the one above it. Shares are display
 * independent, so this is a coarse spacing; the renderer's stacking keeps
 * heads from overlapping on short displays.
 */
export const BOT_BUBBLE_SHARE_STEP = 0.12;

export interface BubbleOptions {
  side?: BotBubbleSide;
  displayId?: number | null;
}

function isBubbled(list: BotBubbleList, botId: string): boolean {
  return list.bubbles.some((bubble) => bubble.botId === botId);
}

function withRecent(recents: readonly string[], botId: string): string[] {
  return [botId, ...recents.filter((id) => id !== botId)].slice(0, BOT_BUBBLE_RECENT_LIMIT);
}

function sameDisplay(left: number | null, right: number | null): boolean {
  return left === right;
}

/** A y share on `side` that does not sit on a head already there. */
export function freeBubbleShare(
  bubbles: readonly BotBubble[],
  side: BotBubbleSide,
  displayId: number | null,
): number {
  const taken = bubbles
    .filter(
      (bubble) =>
        bubble.placement.side === side && sameDisplay(bubble.placement.displayId, displayId),
    )
    .map((bubble) => bubble.placement.y);
  if (taken.length === 0) return BOT_BUBBLE_FIRST_SHARE;
  const below = Math.max(...taken) + BOT_BUBBLE_SHARE_STEP;
  if (below <= 1) return round(below);
  // The side is full to the bottom: wrap to the first gap from the top.
  for (let share = 0; share <= 1; share += BOT_BUBBLE_SHARE_STEP) {
    if (taken.every((y) => Math.abs(y - share) >= BOT_BUBBLE_SHARE_STEP / 2)) return round(share);
  }
  return 0;
}

function round(share: number): number {
  return Math.round(share * 1000) / 1000;
}

/**
 * Add a head at the end. A Bot already out keeps its place. Past the limit the
 * oldest head goes back to recents.
 */
export function bubbleBot(
  list: BotBubbleList,
  botId: string,
  options: BubbleOptions = {},
): BotBubbleList {
  if (isBubbled(list, botId)) return list;
  const side = options.side ?? "right";
  const displayId = options.displayId ?? null;
  const placement: BotBubblePlacement = {
    side,
    y: freeBubbleShare(list.bubbles, side, displayId),
    displayId,
  };
  let bubbles = [...list.bubbles, { botId, placement }];
  let recents = list.recents.filter((id) => id !== botId);
  let openBotId = list.openBotId;
  while (bubbles.length > BOT_BUBBLE_LIMIT) {
    const [oldest, ...rest] = bubbles;
    bubbles = rest;
    recents = withRecent(recents, oldest!.botId);
    if (openBotId === oldest!.botId) openBotId = null;
  }
  return { bubbles, openBotId, recents };
}

/** Put a head away; it becomes the most recent entry. */
export function closeBubble(list: BotBubbleList, botId: string): BotBubbleList {
  if (!isBubbled(list, botId)) return list;
  return {
    bubbles: list.bubbles.filter((bubble) => bubble.botId !== botId),
    openBotId: list.openBotId === botId ? null : list.openBotId,
    recents: withRecent(list.recents, botId),
  };
}

/**
 * Which head's mini chat is open. Only a bubbled Bot can open; null tucks it
 * away. With `ifOpen`, nothing changes unless that head's chat is the open one.
 */
export function openBubble(
  list: BotBubbleList,
  botId: string | null,
  ifOpen?: string,
): BotBubbleList {
  if (ifOpen !== undefined && list.openBotId !== ifOpen) return list;
  if (botId !== null && !isBubbled(list, botId)) return list;
  if (list.openBotId === botId) return list;
  return { ...list, openBotId: botId };
}

export function moveBubble(
  list: BotBubbleList,
  botId: string,
  placement: BotBubblePlacement,
): BotBubbleList {
  if (!isBubbled(list, botId)) return list;
  return {
    ...list,
    bubbles: list.bubbles.map((bubble) => (bubble.botId === botId ? { botId, placement } : bubble)),
  };
}

export function forgetRecentBubble(list: BotBubbleList, botId: string): BotBubbleList {
  if (!list.recents.includes(botId)) return list;
  return { ...list, recents: list.recents.filter((id) => id !== botId) };
}

/** Drop heads and recents for Bots that no longer exist. */
export function pruneBubbles(
  list: BotBubbleList,
  existingBotIds: ReadonlySet<string>,
): BotBubbleList {
  const bubbles = list.bubbles.filter((bubble) => existingBotIds.has(bubble.botId));
  const recents = list.recents.filter((id) => existingBotIds.has(id));
  if (bubbles.length === list.bubbles.length && recents.length === list.recents.length) return list;
  const openBotId =
    list.openBotId !== null && existingBotIds.has(list.openBotId) ? list.openBotId : null;
  return { bubbles, openBotId, recents };
}

/**
 * Heads on a display that went away (or with no display yet) move to the
 * primary display, keeping their side and height share. Main always names a
 * real display, so an overlay only draws heads whose display id is its own.
 */
export function moveBubblesOffMissingDisplays(
  list: BotBubbleList,
  liveDisplayIds: ReadonlySet<number>,
  primaryDisplayId: number,
): BotBubbleList {
  let changed = false;
  const bubbles = list.bubbles.map((bubble) => {
    const { displayId } = bubble.placement;
    if (displayId !== null && liveDisplayIds.has(displayId)) return bubble;
    changed = true;
    return { botId: bubble.botId, placement: { ...bubble.placement, displayId: primaryDisplayId } };
  });
  return changed ? { ...list, bubbles } : list;
}

export interface BotBubbleAppSettings {
  botBubblesEnabled?: boolean;
  botBubblesFloatOverApps?: boolean;
}

/** Undefined means on for both switches. */
export function botBubbleSettingsFrom(settings: BotBubbleAppSettings): BotBubbleSettings {
  return {
    enabled: settings.botBubblesEnabled !== false,
    floatOverApps: settings.botBubblesFloatOverApps !== false,
  };
}

/** Electron passes clicks through a see-through window only on macOS (and Windows, which Aiden doesn't ship). */
export function canFloatBotBubblesOverApps(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

export function resolveBotBubbleHost(
  settings: BotBubbleSettings,
  platform: NodeJS.Platform,
): BotBubbleHost {
  if (!settings.enabled) return "off";
  return settings.floatOverApps && canFloatBotBubblesOverApps(platform) ? "overlay" : "window";
}

export function botBubbleStateFrom(
  list: BotBubbleList,
  settings: BotBubbleSettings,
  platform: NodeJS.Platform,
): BotBubbleState {
  return {
    bubbles: list.bubbles,
    openBotId: list.openBotId,
    recents: list.recents,
    settings,
    host: resolveBotBubbleHost(settings, platform),
    floatOverAppsAvailable: canFloatBotBubblesOverApps(platform),
  };
}

// ---- The saved file: `<userData>/bot-bubbles.json` ----

export const BOT_BUBBLE_FILE_VERSION = 1;

export interface BotBubbleFile {
  version: typeof BOT_BUBBLE_FILE_VERSION;
  bubbles: Array<{ botId: string; side: BotBubbleSide; y: number; displayId: number | null }>;
  recents: string[];
}

/**
 * Read a saved list. Anything malformed, or another version, starts empty:
 * bubbles are a convenience, and pre-1.0 Aiden never migrates old shapes.
 * The open mini chat is never saved.
 */
export function parseBotBubbleFile(raw: unknown): BotBubbleList {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY_BOT_BUBBLE_LIST;
  const value = raw as Record<string, unknown>;
  if (value.version !== BOT_BUBBLE_FILE_VERSION) return EMPTY_BOT_BUBBLE_LIST;
  if (!Array.isArray(value.bubbles) || !Array.isArray(value.recents)) return EMPTY_BOT_BUBBLE_LIST;
  if (value.bubbles.length > BOT_BUBBLE_LIMIT || value.recents.length > BOT_BUBBLE_RECENT_LIMIT)
    return EMPTY_BOT_BUBBLE_LIST;
  const bubbles: BotBubble[] = [];
  const seen = new Set<string>();
  for (const item of value.bubbles) {
    if (typeof item !== "object" || item === null) return EMPTY_BOT_BUBBLE_LIST;
    const entry = item as Record<string, unknown>;
    if (!isBotBubbleBotId(entry.botId) || seen.has(entry.botId)) return EMPTY_BOT_BUBBLE_LIST;
    if (typeof entry.y !== "number" || entry.y < 0 || entry.y > 1) return EMPTY_BOT_BUBBLE_LIST;
    if (!("displayId" in entry)) return EMPTY_BOT_BUBBLE_LIST;
    const placement = parseBotBubblePlacement(entry);
    if (!placement) return EMPTY_BOT_BUBBLE_LIST;
    seen.add(entry.botId);
    bubbles.push({ botId: entry.botId, placement });
  }
  const recents: string[] = [];
  for (const id of value.recents) {
    if (!isBotBubbleBotId(id) || seen.has(id) || recents.includes(id)) return EMPTY_BOT_BUBBLE_LIST;
    recents.push(id);
  }
  return { bubbles, openBotId: null, recents };
}

export function serializeBotBubbleFile(list: BotBubbleList): BotBubbleFile {
  return {
    version: BOT_BUBBLE_FILE_VERSION,
    bubbles: list.bubbles.map(({ botId, placement }) => ({
      botId,
      side: placement.side,
      y: placement.y,
      displayId: placement.displayId,
    })),
    recents: [...list.recents],
  };
}
