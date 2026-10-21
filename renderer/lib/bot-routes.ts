// Where the Bots surfaces live in the route tree, what the panel shortcut acts
// on there, and where ‹ in the Bots sidebar goes back to (spec §8, §9).

const BOT_CHAT_ROUTE = /^\/bots\/([^/]+)\/chat\/?$/u;
const BOT_ROUTE = /^\/bots\/([^/]+)(?:\/chat)?\/?$/u;

const HOST_BOT_ROUTE = /^\/host\/[^/]+\/bots\/[^/]+(?:\/|$)/u;
const HOST_BOT_CHAT_ROUTE = /^\/host\/([^/]+)\/bots\/([^/]+)\/chat\/?$/u;

/** The Bots surface: `/bots`, everything under it, and a paired Mac's Bot chat. */
export function isBotsPath(pathname: string): boolean {
  return pathname === "/bots" || pathname.startsWith("/bots/") || HOST_BOT_ROUTE.test(pathname);
}

function decodedSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The Bot whose chat is open, or null. */
export function botChatRouteBotId(pathname: string): string | null {
  return decodedSegment(BOT_CHAT_ROUTE.exec(pathname)?.[1]);
}

/** The Bot a `/bots/$botId` or `/bots/$botId/chat` page belongs to, or null. */
export function botRouteBotId(pathname: string): string | null {
  return decodedSegment(BOT_ROUTE.exec(pathname)?.[1]);
}

/** The paired host's Bot whose chat is open, as `hostId/botId`, or null. */
export function hostBotChatRouteKey(pathname: string): string | null {
  const match = HOST_BOT_CHAT_ROUTE.exec(pathname);
  const hostId = decodedSegment(match?.[1]);
  const botId = decodedSegment(match?.[2]);
  return hostId && botId ? `${hostId}/${botId}` : null;
}

type EnvironmentToggleTarget = "bot-panel" | "workspace" | "none";

/** What `environment.toggle` acts on: the Bot panel in a Bot chat, nothing on other Bots pages, else the workspace panel. */
export function environmentToggleTarget(pathname: string): EnvironmentToggleTarget {
  if (botChatRouteBotId(pathname) !== null) return "bot-panel";
  return isBotsPath(pathname) ? "none" : "workspace";
}

/** The Bot's one conversation, addressed by Bot id only. */
export function botChatPath(botId: string): { to: "/bots/$botId/chat"; params: { botId: string } } {
  return { to: "/bots/$botId/chat", params: { botId } };
}

let lastNonBotHref = "/";

/** Called on every chat-shell navigation. Bots pages are never a back target. */
export function rememberRoute(href: string): void {
  const pathname = href.split(/[?#]/u, 1)[0] ?? href;
  if (!isBotsPath(pathname)) lastNonBotHref = href;
}

/** Where ‹ in the Bots sidebar goes: the last page outside Bots this session, else the latest chat (`/`). */
export function lastNonBotRoute(): string {
  return lastNonBotHref;
}
