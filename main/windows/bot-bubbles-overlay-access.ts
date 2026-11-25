// A bubble overlay may act only on Bots that are bubbled now. Main wraps the
// `handle` that registers the Bot and bubble IPC so every request from an
// overlay document names one of its heads; requests from other windows pass
// through untouched. Electron-free so the rule is checked by register-and-invoke.

export interface BotBubbleOverlayAccess<Event> {
  /** Whether the request came from a bubble overlay window (any frame: fail closed). */
  isOverlayEvent(event: Event): boolean;
  /** Bots that have a head out now. */
  bubbledBotIds(): ReadonlySet<string>;
  /** The Bot a waiting approval belongs to, or null when nothing waits under that id. */
  approvalBotId(waitId: string): string | null;
}

type BotIdOf = (args: readonly unknown[], access: BotBubbleOverlayAccess<never>) => unknown;

const firstArgument = (args: readonly unknown[]): unknown => args[0];
const botIdField = (args: readonly unknown[]): unknown =>
  typeof args[0] === "object" && args[0] !== null ? (args[0] as { botId?: unknown }).botId : undefined;

const OPEN_NONE = Symbol("no Bot");

/**
 * Overlay channels that name no Bot, or are always safe: the bubble list and
 * overlay controls, and letting go of a live feed (a head that just closed
 * still unsubscribes after it left the list).
 */
const OVERLAY_UNSCOPED_CHANNELS: ReadonlySet<string> = new Set([
  "bots:bubbles:state",
  "bots:bubbles:setInteractive",
  "bots:bubbles:setDragging",
  "bots:bubbles:overlayInfo",
  "bots:live:unsubscribe",
]);

/** Overlay-reachable channels and where each names its Bot. */
export const BOT_BUBBLE_OVERLAY_BOT_ARGUMENT: Readonly<Record<string, BotIdOf>> = {
  "bots:get": firstArgument,
  "bots:getCanonicalPhoto": firstArgument,
  "bots:sessionState": firstArgument,
  "bots:pendingApprovals": firstArgument,
  "bots:stop": firstArgument,
  "bots:live:subscribe": firstArgument,
  "bots:live:summary": firstArgument,
  "bots:send": botIdField,
  "bots:resume": botIdField,
  "bots:dismiss": botIdField,
  "bots:withdraw": botIdField,
  "bots:answerQuestion": botIdField,
  "bots:approve": (args, access) => {
    const waitId = typeof args[0] === "object" && args[0] !== null ? (args[0] as { waitId?: unknown }).waitId : undefined;
    return typeof waitId === "string" ? access.approvalBotId(waitId) : undefined;
  },
  "bots:bubbles:close": botIdField,
  "bots:bubbles:move": botIdField,
  "bots:bubbles:bringBack": botIdField,
  "bots:bubbles:open": (args) => {
    const botId = botIdField(args);
    // Tucking the chat away names no Bot.
    return botId === null ? OPEN_NONE : botId;
  },
};

export function assertBotBubbleOverlayBotAccess<Event>(
  access: BotBubbleOverlayAccess<Event>,
  event: Event,
  channel: string,
  args: readonly unknown[],
): void {
  const botIdOf = BOT_BUBBLE_OVERLAY_BOT_ARGUMENT[channel];
  if (!botIdOf || !access.isOverlayEvent(event)) return;
  const botId = botIdOf(args, access as BotBubbleOverlayAccess<never>);
  if (botId === OPEN_NONE) return;
  if (typeof botId !== "string" || !access.bubbledBotIds().has(botId)) {
    throw new Error("A bubble can act only on its own Bots.");
  }
}

type Handler<Event> = (event: Event, ...args: unknown[]) => unknown;

/**
 * Wrap a `handle` so overlay requests on the channels above must name a
 * bubbled Bot, and an overlay's `bots:list` sees only bubbled Bots.
 */
export function guardBotBubbleOverlayHandlers<Event>(
  handle: (channel: string, handler: Handler<Event>) => void,
  access: BotBubbleOverlayAccess<Event>,
): (channel: string, handler: Handler<Event>) => void {
  return (channel, handler) => {
    if (channel === "bots:list") {
      handle(channel, (event, ...args) => {
        const result = handler(event, ...args);
        if (!access.isOverlayEvent(event)) return result;
        return Promise.resolve(result).then((bots) =>
          Array.isArray(bots)
            ? bots.filter((bot: { id?: unknown }) => typeof bot?.id === "string" && access.bubbledBotIds().has(bot.id))
            : bots,
        );
      });
      return;
    }
    if (OVERLAY_UNSCOPED_CHANNELS.has(channel)) {
      handle(channel, handler);
      return;
    }
    if (!(channel in BOT_BUBBLE_OVERLAY_BOT_ARGUMENT)) {
      // Everything else on this handle (deleting or editing a Bot, bubbling, recents) is not for an overlay.
      handle(channel, (event, ...args) => {
        if (access.isOverlayEvent(event)) throw new Error("A bubble can't do that.");
        return handler(event, ...args);
      });
      return;
    }
    handle(channel, (event, ...args) => {
      assertBotBubbleOverlayBotAccess(access, event, channel, args);
      return handler(event, ...args);
    });
  };
}
