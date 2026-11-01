// Where the Bots surfaces live in the route tree, what the panel shortcut acts
// on there, where ‹ in the Bots sidebar goes back to (spec §8, §9), and
// whether the person asked for the Bot list while the Inbox is the sidebar view.

import type { RouterHistory } from "@tanstack/react-router";

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

declare module "@tanstack/history" {
  interface HistoryState {
    /** Set on the history entry when the person asked for the Bot list (see `botListLocation`). */
    aidenBotList?: boolean;
  }
}

/**
 * The Bot list, asked for: the Bots nav entry, `bots.open` and the All Bots
 * links navigate here. The ask lives on the history entry, so Back and Forward
 * bring it back with the page, and a plain `/bots` (after deleting a Bot, or
 * from an error) doesn't count as one.
 */
export function botListLocation(): { to: "/bots"; state: { aidenBotList: true } } {
  return { to: "/bots", state: { aidenBotList: true } };
}

type HistoryStateLike = { aidenBotList?: unknown } | null | undefined;

function pathnameOf(href: string): string {
  return href.split(/[?#]/u, 1)[0] ?? href;
}

/**
 * The state a new history entry keeps. An ask for the Bot list lasts through
 * the Bots pages that follow it (the `/bots` redirect to the last Bot, opening
 * other Bots) and ends when the person leaves Bots; an entry that says either
 * way itself keeps what it says.
 */
export function nextBotListState<T extends object>(current: HistoryStateLike, href: string, state: T | undefined): T | undefined {
  if (!isBotsPath(pathnameOf(href))) {
    if (!state || !("aidenBotList" in state)) return state;
    const { aidenBotList: _dropped, ...rest } = state as T & { aidenBotList?: unknown };
    return rest as T;
  }
  if (state && "aidenBotList" in state) return state;
  return current?.aidenBotList === true ? ({ ...state, aidenBotList: true } as T) : state;
}

/** Carry an ask for the Bot list from entry to entry within Bots (see `nextBotListState`). */
export function carryBotListRequest<T extends RouterHistory>(history: T): T {
  const push = history.push;
  const replace = history.replace;
  history.push = (path, state, options) => push(path, nextBotListState(history.location.state, path, state), options);
  history.replace = (path, state, options) => replace(path, nextBotListState(history.location.state, path, state), options);
  return history;
}

/**
 * Whether the sidebar shows the Bot list rather than the workspace sidebar. On
 * any Bots page it does, except with the Inbox as the view: a Bot opened from
 * the Inbox, a notification or a redirect keeps the Inbox (it owns ⌘1–9
 * there), and the list shows only on an entry where the person asked for it.
 */
export function sidebarShowsBotList(location: { pathname: string; state?: HistoryStateLike }, inboxView: boolean): boolean {
  if (!isBotsPath(location.pathname)) return false;
  return !inboxView || location.state?.aidenBotList === true;
}

let lastNonBotHref = "/";

/** Called on every resolved chat-shell navigation. Bots pages are never a back target. */
export function rememberRoute(href: string): void {
  if (!isBotsPath(pathnameOf(href))) lastNonBotHref = href;
}

/** Where ‹ in the Bots sidebar goes: the last page outside Bots this session, else the latest chat (`/`). */
export function lastNonBotRoute(): string {
  return lastNonBotHref;
}
