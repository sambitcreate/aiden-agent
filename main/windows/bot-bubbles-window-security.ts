// Which IPC senders count as a Bot bubble overlay, and which notifications an
// overlay hears.

export interface BotBubbleSenderIdentity {
  webContentsId: number;
  frameUrl: string;
  isMainFrame: boolean;
}

/** A URL without its `#fragment`: an in-page link in the mini chat changes only that. */
export function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * The main frame of one of the overlay windows main created, showing the
 * overlay page (any in-page fragment).
 */
export function isTrustedBotBubbleSender(
  overlayWebContentsIds: ReadonlySet<number>,
  expectedUrl: string,
  actual: BotBubbleSenderIdentity,
): boolean {
  return (
    expectedUrl.length > 0 &&
    overlayWebContentsIds.has(actual.webContentsId) &&
    actual.isMainFrame &&
    withoutFragment(actual.frameUrl) === withoutFragment(expectedUrl)
  );
}

/** Bot notifications that name one Bot; an overlay hears them only for its heads. */
const BOT_SCOPED_NOTIFICATIONS = new Set([
  "bots:changed",
  "bots:approval",
  "bots:approval-settled",
  "bots:attention",
]);

/**
 * Whether an overlay may receive this broadcast. Appearance, settings and
 * bubble notifications always pass; a Bot-scoped one passes only for a
 * bubbled Bot (or when it names no Bot, which means "re-read everything").
 */
export function botBubbleOverlayHears(
  channel: string,
  payload: unknown,
  bubbledBotIds: ReadonlySet<string>,
): boolean {
  if (!BOT_SCOPED_NOTIFICATIONS.has(channel)) return true;
  const botId =
    typeof payload === "object" && payload !== null
      ? (payload as { botId?: unknown }).botId
      : undefined;
  if (botId === undefined) return channel === "bots:changed";
  return typeof botId === "string" && bubbledBotIds.has(botId);
}
