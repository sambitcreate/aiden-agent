// Bot bubbles IPC. Who may call what:
// - state, close, open, move, bringBack, forgetRecent: the main window or a bubble overlay;
// - bubble: the main window only (a Bot is bubbled from its chat there);
// - setInteractive, setDragging, overlayInfo, transitionShown: a current bubble overlay only.
// Every Bot id goes through `parseBotId`; any other shape is refused.

import {
  BOT_BUBBLE_CHANNELS,
  parseBotBubblePlacement,
  parseBotBubbleRect,
  type BotBubbleOverlayInfo,
  type BotBubblePlacement,
  type BotBubbleRect,
  type BotBubbleSide,
  type BotBubbleState,
} from "../../renderer/shared/bot-bubbles.js";
import type { BotBubbleService } from "../services/bot-bubbles/bot-bubbles-service.js";
import { requireAllowedKeys } from "../shared/guards.js";

/** What the handlers need from the overlay windows and the main window. */
export interface BotBubbleWindowPort<Event> {
  /** A PNG data URL of `rect` (the sender's CSS pixels), or null when it can't be captured. */
  capture(event: Event, rect: BotBubbleRect): Promise<string | null>;
  /**
   * Before a bubble from the main window: lay the captured chat over the chat
   * area on that display's overlay and wait (briefly) until it is on screen, so
   * the window swaps its chat for the card underneath. The overlay then plays
   * the shrink by itself when the head arrives. False when no overlay could
   * take it (none on that display yet); `playShrink` is used after the bubble then.
   */
  coverChat(event: Event, botId: string, rect: BotBubbleRect, image: string): Promise<boolean>;
  /** An overlay says the still picture of the shrink that named `cover` is on screen. */
  transitionShown(event: Event, cover: number): void;
  /** After a bubble from the main window that nothing covered: play the shrink into the new head. */
  playShrink(event: Event, botId: string, rect: BotBubbleRect, image: string | null): void;
  /**
   * Open in Aiden: plays the grow (overlay host), runs `close`, then shows the
   * main window and sends it `bots:bubbles:showChat`.
   */
  bringBack(botId: string, close: () => Promise<BotBubbleState>): Promise<BotBubbleState>;
  /** The display a new head should go on: the one under the sender's window. */
  displayIdFor(event: Event): number | null;
  setInteractive(event: Event, interactive: boolean): void;
  setDragging(event: Event, dragging: boolean): void;
  overlayInfo(event: Event): BotBubbleOverlayInfo;
}

export interface BotBubbleHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  isMainWindow(event: Event): boolean;
  isBubbleOverlayEvent(event: Event): boolean;
  service: Pick<BotBubbleService, "state" | "bubble" | "close" | "open" | "move" | "forgetRecent">;
  windows: BotBubbleWindowPort<Event>;
  parseBotId(value: unknown): string;
}

const INVALID = "Invalid Bot bubble request.";

const fields = (raw: unknown, allowed: readonly string[]): Record<string, unknown> =>
  requireAllowedKeys(raw, allowed, INVALID);

function optionalRect(value: unknown): BotBubbleRect | undefined {
  if (value === undefined) return undefined;
  const rect = parseBotBubbleRect(value);
  if (!rect) throw new Error(INVALID);
  return rect;
}

function optionalSide(value: unknown): BotBubbleSide | undefined {
  if (value === undefined) return undefined;
  if (value !== "left" && value !== "right") throw new Error(INVALID);
  return value;
}

function placement(value: unknown): BotBubblePlacement {
  const parsed = parseBotBubblePlacement(value);
  if (!parsed) throw new Error(INVALID);
  return parsed;
}

function flag(raw: unknown, key: string): boolean {
  const value = fields(raw, [key])[key];
  if (typeof value !== "boolean") throw new Error(INVALID);
  return value;
}

export function registerBotBubbleHandlers<Event>(deps: BotBubbleHandlerDependencies<Event>): void {
  const { handle, service, windows } = deps;
  const untrusted = () => new Error("Untrusted Bot bubble sender.");
  const fromAidenWindow = (event: Event) => {
    if (!deps.isMainWindow(event) && !deps.isBubbleOverlayEvent(event)) throw untrusted();
  };
  const fromMainWindow = (event: Event) => {
    if (!deps.isMainWindow(event)) throw untrusted();
  };
  const fromOverlay = (event: Event) => {
    if (!deps.isBubbleOverlayEvent(event)) throw untrusted();
  };
  const botIdOf = (raw: unknown, extra: readonly string[] = []) => {
    const value = fields(raw, ["botId", ...extra]);
    return { value, botId: deps.parseBotId(value.botId) };
  };

  handle(BOT_BUBBLE_CHANNELS.state, (event, ...args) => {
    fromAidenWindow(event);
    if (args.length > 0) throw new Error(INVALID);
    return service.state();
  });

  handle(BOT_BUBBLE_CHANNELS.bubble, async (event, raw) => {
    fromMainWindow(event);
    const { value, botId } = botIdOf(raw, ["sourceRect", "side"]);
    const sourceRect = optionalRect(value.sourceRect);
    const side = optionalSide(value.side);
    // Capture before the bubble exists: the chat swaps to its "in a bubble" card on the change.
    const before = await service.state();
    const image = sourceRect && before.host === "overlay" ? await windows.capture(event, sourceRect).catch(() => null) : null;
    // Then the picture goes over the chat first, so the swap to the card is never seen.
    const covered = sourceRect && image ? await windows.coverChat(event, botId, sourceRect, image).catch(() => false) : false;
    const state = await service.bubble(botId, { ...(side ? { side } : {}), displayId: windows.displayIdFor(event) });
    if (sourceRect && state.host === "overlay" && !covered) windows.playShrink(event, botId, sourceRect, image);
    return state;
  });

  handle(BOT_BUBBLE_CHANNELS.close, (event, raw) => {
    fromAidenWindow(event);
    return service.close(botIdOf(raw).botId);
  });

  handle(BOT_BUBBLE_CHANNELS.open, (event, raw) => {
    fromAidenWindow(event);
    const value = fields(raw, ["botId", "ifOpen"]);
    const botId = value.botId === null ? null : deps.parseBotId(value.botId);
    if (value.ifOpen === undefined) return service.open(botId);
    return service.open(botId, { ifOpen: deps.parseBotId(value.ifOpen) });
  });

  handle(BOT_BUBBLE_CHANNELS.move, (event, raw) => {
    fromAidenWindow(event);
    const { value, botId } = botIdOf(raw, ["placement"]);
    return service.move(botId, placement(value.placement));
  });

  handle(BOT_BUBBLE_CHANNELS.bringBack, (event, raw) => {
    fromAidenWindow(event);
    const { value, botId } = botIdOf(raw, ["sourceRect"]);
    optionalRect(value.sourceRect);
    return windows.bringBack(botId, () => service.close(botId));
  });

  handle(BOT_BUBBLE_CHANNELS.forgetRecent, (event, raw) => {
    fromAidenWindow(event);
    return service.forgetRecent(botIdOf(raw).botId);
  });

  handle(BOT_BUBBLE_CHANNELS.setInteractive, (event, raw) => {
    fromOverlay(event);
    windows.setInteractive(event, flag(raw, "interactive"));
  });

  handle(BOT_BUBBLE_CHANNELS.setDragging, (event, raw) => {
    fromOverlay(event);
    windows.setDragging(event, flag(raw, "dragging"));
  });

  handle(BOT_BUBBLE_CHANNELS.transitionShown, (event, raw) => {
    fromOverlay(event);
    const cover = fields(raw, ["cover"]).cover;
    if (typeof cover !== "number" || !Number.isSafeInteger(cover)) throw new Error(INVALID);
    windows.transitionShown(event, cover);
  });

  handle(BOT_BUBBLE_CHANNELS.overlayInfo, (event, ...args) => {
    fromOverlay(event);
    if (args.length > 0) throw new Error(INVALID);
    return windows.overlayInfo(event);
  });
}
