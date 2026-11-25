// A bubble overlay may act only on the Bots whose heads it draws. Main wraps
// the `handle` that registers the Bot and bubble IPC so every request from an
// overlay must come from its trusted main document and name one of that
// overlay's heads; requests from other windows pass through untouched. Electron-free so the rule is checked by register-and-invoke.

export interface BotBubbleOverlayAccess<Event> {
  /** Whether the request came from a bubble overlay window (any frame: fail closed). */
  isOverlayEvent(event: Event): boolean;
  /** Whether it came from that overlay's own main document (the bubble page, not a subframe or another page). */
  isTrustedOverlayEvent(event: Event): boolean;
  /** Bots whose heads the sending overlay draws (its display's heads). */
  bubbledBotIds(event: Event): ReadonlySet<string>;
  /** The Bot a waiting approval belongs to, or null when nothing waits under that id. */
  approvalBotId(waitId: string): string | null;
}

type BotIdOf = (args: readonly unknown[], access: BotBubbleOverlayAccess<never>) => unknown;

const firstArgument = (args: readonly unknown[]): unknown => args[0];
const botIdField = (args: readonly unknown[]): unknown =>
  typeof args[0] === "object" && args[0] !== null ? (args[0] as { botId?: unknown }).botId : undefined;

/** The request names no Bot, so there is nothing to scope (tucking the chat away, an approval nobody waits on). */
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
  "bots:bubbles:transitionShown",
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
    if (typeof waitId !== "string") return undefined;
    // Nothing waits under that id (answered elsewhere a moment ago): the handler
    // decides nothing and says so, which beats a misleading refusal here.
    return access.approvalBotId(waitId) ?? OPEN_NONE;
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

function assertTrustedOverlay<Event>(access: BotBubbleOverlayAccess<Event>, event: Event): void {
  if (!access.isTrustedOverlayEvent(event)) throw new Error("Invalid Bot bubble sender.");
}

export function assertBotBubbleOverlayBotAccess<Event>(
  access: BotBubbleOverlayAccess<Event>,
  event: Event,
  channel: string,
  args: readonly unknown[],
): void {
  const botIdOf = BOT_BUBBLE_OVERLAY_BOT_ARGUMENT[channel];
  if (!botIdOf || !access.isOverlayEvent(event)) return;
  assertTrustedOverlay(access, event);
  const botId = botIdOf(args, access as BotBubbleOverlayAccess<never>);
  if (botId === OPEN_NONE) return;
  if (typeof botId !== "string" || !access.bubbledBotIds(event).has(botId)) {
    throw new Error("A bubble can act only on its own Bots.");
  }
}

type Handler<Event> = (event: Event, ...args: unknown[]) => unknown;

/**
 * Wrap a `handle` so overlay requests must come from the overlay's own page
 * and, on the channels above, name one of its heads; an overlay's `bots:list`
 * sees only its heads' Bots.
 */
export function guardBotBubbleOverlayHandlers<Event>(
  handle: (channel: string, handler: Handler<Event>) => void,
  access: BotBubbleOverlayAccess<Event>,
): (channel: string, handler: Handler<Event>) => void {
  return (channel, handler) => {
    if (channel === "bots:list") {
      handle(channel, (event, ...args) => {
        if (!access.isOverlayEvent(event)) return handler(event, ...args);
        assertTrustedOverlay(access, event);
        const heads = access.bubbledBotIds(event);
        return Promise.resolve(handler(event, ...args)).then((bots) =>
          Array.isArray(bots)
            ? bots.filter((bot: { id?: unknown }) => typeof bot?.id === "string" && heads.has(bot.id))
            : bots,
        );
      });
      return;
    }
    if (OVERLAY_UNSCOPED_CHANNELS.has(channel)) {
      handle(channel, (event, ...args) => {
        // Letting go of a feed is always safe; the rest still needs the overlay's own page.
        if (channel !== "bots:live:unsubscribe" && access.isOverlayEvent(event)) assertTrustedOverlay(access, event);
        return handler(event, ...args);
      });
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
