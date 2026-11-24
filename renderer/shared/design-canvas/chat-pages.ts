// Each chat's own page on the shared workspace canvas (`chatPages`), and the
// pages made for a chat (`namedFor`).
//
// Only main claims, and only for the acting chat: on design-mode entry, on a
// design turn's first canvas write, through `canvas_page use` and on attach.
// Every write runs inside the store's update on the latest document, so two
// chats' writes never race. A person's save never adds or moves a claim on
// its own say: the store merges it with `mergeSavedChatPages`.
// Pure, like `pages.ts`; every function returns `doc` itself when it changes
// nothing.

import { commentsWithoutFrames } from "./comments.js";
import { syncConnectors } from "./connectors.js";
import { addPage, canAddPage, deletePage } from "./pages.js";
import { refitGroups } from "./placement.js";
import { DESIGN_CANVAS_LIMITS, isDesignChatId, type DesignCanvas, type DesignPage } from "./schema.js";

/** Whether a chat still exists in this canvas's workspace. Left out, every chat counts as live. */
export type IsChatLive = (chatId: string) => boolean;

export class ChatPagesFullError extends Error {
  constructor() {
    super("This canvas has too many chats with pages of their own.");
    this.name = "ChatPagesFullError";
  }
}

/**
 * What the store remembers of a deleted page that had claims or a
 * `namedFor`: each chat that was on it and the page the delete moved it to.
 */
export type DeletedPage = { namedFor?: string; claims: Map<string, string> };

const FALLBACK_NAME = "Chat";

function claimOf(doc: Pick<DesignCanvas, "chatPages">, chatId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(doc.chatPages, chatId) ? doc.chatPages[chatId] : undefined;
}

/** The chats whose own page `pageId` is, skipping those `isLive` says are gone. */
export function chatsOnPage(doc: Pick<DesignCanvas, "chatPages">, pageId: string, isLive?: IsChatLive): string[] {
  return Object.entries(doc.chatPages)
    .filter(([chatId, claimed]) => claimed === pageId && isLive?.(chatId) !== false)
    .map(([chatId]) => chatId);
}

/**
 * A page name for `base` that no other page has (case-insensitive):
 * whitespace collapsed, cut to the page-name limit, "Chat" when empty, and
 * " 2", " 3"… on a clash, with the base cut so the number fits.
 */
export function uniquePageName(doc: Pick<DesignCanvas, "pages">, base: string, exceptPageId?: string): string {
  const limit = DESIGN_CANVAS_LIMITS.pageNameChars;
  const clean = base.replace(/\s+/gu, " ").trim().slice(0, limit).trim() || FALLBACK_NAME;
  const taken = new Set(
    doc.pages.filter((page) => page.id !== exceptPageId).map((page) => page.name.toLocaleLowerCase()),
  );
  if (!taken.has(clean.toLocaleLowerCase())) return clean;
  for (let number = 2; ; number += 1) {
    const suffix = ` ${number}`;
    const name = `${clean.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(name.toLocaleLowerCase())) return name;
  }
}

/**
 * Makes `pageId` the chat's own page. The caller checks the page exists. At
 * the cap a new chat first evicts the entries of chats that are gone, and
 * throws `ChatPagesFullError` when none is.
 */
export function claimPage(doc: DesignCanvas, chatId: string, pageId: string, isLive?: IsChatLive): DesignCanvas {
  if (!isDesignChatId(chatId) || claimOf(doc, chatId) === pageId) return doc;
  let chatPages = doc.chatPages;
  if (claimOf(doc, chatId) === undefined && Object.keys(chatPages).length >= DESIGN_CANVAS_LIMITS.chatPages) {
    const live = Object.entries(chatPages).filter(([other]) => isLive?.(other) !== false);
    if (live.length >= DESIGN_CANVAS_LIMITS.chatPages) throw new ChatPagesFullError();
    chatPages = Object.fromEntries(live);
  }
  return { ...doc, chatPages: { ...chatPages, [chatId]: pageId } };
}

/**
 * Adds a page made for the chat right after `after`, named after its title
 * (`uniquePageName`), marked `namedFor` and claimed. At the page limit, or
 * when `id` is taken, returns `doc`.
 */
export function addChatPage(
  doc: DesignCanvas,
  chatId: string,
  title: string,
  id: string,
  after?: string,
  isLive?: IsChatLive,
): DesignCanvas {
  if (!canAddPage(doc) || doc.pages.some((page) => page.id === id)) return doc;
  const added = addPage(doc, id, uniquePageName(doc, title), after);
  const marked = { ...added, pages: added.pages.map((page) => (page.id === id ? { ...page, namedFor: chatId } : page)) };
  return claimPage(marked, chatId, id, isLive);
}

/** Renames the pages made for the chat to its title. Their own names are not counted as taken. */
export function followChatTitle(doc: DesignCanvas, chatId: string, title: string): DesignCanvas {
  let next = doc;
  for (const page of doc.pages) {
    if (page.namedFor !== chatId) continue;
    const name = uniquePageName(next, title, page.id);
    if (name === page.name) continue;
    next = { ...next, pages: next.pages.map((entry) => (entry.id === page.id ? { ...entry, name } : entry)) };
  }
  return next;
}

/**
 * A deleted chat leaves the canvas: its claim and `namedFor` marks go, and so
 * do its artifact frames with every comment on them, letting go of arrows and
 * refitting groups. Its pages, notes and other frames stay as the workspace's
 * work, and its own comments are left to the comment pass.
 */
export function forgetChatOnCanvas(doc: DesignCanvas, chatId: string): DesignCanvas {
  const hasClaim = claimOf(doc, chatId) !== undefined;
  const marked = doc.pages.some((page) => page.namedFor === chatId);
  const removed = doc.frames.filter((frame) => frame.kind === "artifact" && frame.chatId === chatId);
  if (!hasClaim && !marked && removed.length === 0) return doc;
  let next: DesignCanvas = doc;
  if (hasClaim) {
    next = { ...next, chatPages: Object.fromEntries(Object.entries(next.chatPages).filter(([other]) => other !== chatId)) };
  }
  if (marked) next = { ...next, pages: next.pages.map((page) => (page.namedFor === chatId ? withoutNamedFor(page) : page)) };
  if (removed.length > 0) {
    const ids = new Set(removed.map((frame) => frame.id));
    const frames = next.frames.filter((frame) => !ids.has(frame.id));
    const comments = commentsWithoutFrames(next.comments, ids);
    next = refitGroups(
      syncConnectors({ ...next, frames, comments }),
      removed.map((frame) => frame.groupId),
    );
  }
  return next;
}

/**
 * A chat moving to another workspace leaves this canvas: `forgetChatOnCanvas`,
 * and a page made for it is deleted when it holds no frames or comments, no
 * other chat uses it and it is not the only page. Otherwise it only stops
 * following the chat.
 */
export function forgetChatMove(doc: DesignCanvas, chatId: string): DesignCanvas {
  const made = doc.pages.filter((page) => page.namedFor === chatId).map((page) => page.id);
  let next = forgetChatOnCanvas(doc, chatId);
  for (const pageId of made) {
    const empty =
      !next.frames.some((frame) => frame.pageId === pageId) &&
      !next.comments.some((comment) => comment.pageId === pageId) &&
      chatsOnPage(next, pageId).length === 0;
    if (empty && next.pages.length > 1) next = deletePage(next, pageId);
  }
  return next;
}

/**
 * The pages `after` removed that had claims or a `namedFor` in `before`, with
 * each chat that was on one and the page it is on in `after`.
 */
export function deletedClaims(before: DesignCanvas, after: DesignCanvas): Map<string, DeletedPage> {
  const kept = new Set(after.pages.map((page) => page.id));
  const record = new Map<string, DeletedPage>();
  for (const page of before.pages) {
    if (kept.has(page.id)) continue;
    const claims = new Map<string, string>();
    for (const chatId of chatsOnPage(before, page.id)) {
      const movedTo = claimOf(after, chatId);
      if (movedTo !== undefined) claims.set(chatId, movedTo);
    }
    if (claims.size === 0 && page.namedFor === undefined) continue;
    record.set(page.id, { ...(page.namedFor !== undefined ? { namedFor: page.namedFor } : {}), claims });
  }
  return record;
}

/**
 * A person's save (`saved`, the whole document from the renderer) merged with
 * the stored claims (`current`) and the store's record of deleted pages:
 * - claims start from `current`;
 * - a page the save brings back gets back a saved claim only when `deleted`
 *   records that chat on it and the chat is still exactly where that delete
 *   moved it, so a save never adds an entry and never moves a chat on its own
 *   say;
 * - a claim on a page the save removed moves to the save's first page, and is
 *   recorded in `deletedNow`;
 * - a saved page keeps `namedFor` only when `current`'s page has the same, or
 *   when it is brought back with that `namedFor` in its record for a chat
 *   still live here. A save may always drop it.
 * `restored` is what the store takes out of its record once the write lands.
 */
export function mergeSavedChatPages(
  current: DesignCanvas,
  saved: DesignCanvas,
  deleted: ReadonlyMap<string, DeletedPage>,
  isLive?: IsChatLive,
): { doc: DesignCanvas; changed: boolean; deletedNow: Map<string, DeletedPage>; restored: Map<string, DeletedPage> } {
  const currentPages = new Map(current.pages.map((page) => [page.id, page]));
  const savedIds = new Set(saved.pages.map((page) => page.id));
  const chatPages: Record<string, string> = { ...current.chatPages };
  const restored = new Map<string, DeletedPage>();
  const restoredOf = (pageId: string): DeletedPage => {
    let entry = restored.get(pageId);
    if (!entry) restored.set(pageId, (entry = { claims: new Map() }));
    return entry;
  };

  const pages = saved.pages.map((page): DesignPage => {
    const stored = currentPages.get(page.id);
    if (stored) {
      return page.namedFor !== undefined && page.namedFor === stored.namedFor ? page : withoutNamedFor(page);
    }
    const record = deleted.get(page.id);
    if (record) {
      for (const [chatId, movedTo] of record.claims) {
        if (claimOf(saved, chatId) !== page.id || claimOf(current, chatId) !== movedTo || isLive?.(chatId) === false) continue;
        chatPages[chatId] = page.id;
        restoredOf(page.id).claims.set(chatId, movedTo);
      }
    }
    const named = page.namedFor;
    if (named !== undefined && record?.namedFor === named && isLive?.(named) !== false) {
      restoredOf(page.id).namedFor = named;
      return page;
    }
    return withoutNamedFor(page);
  });

  const first = pages[0]!.id;
  for (const [chatId, pageId] of Object.entries(chatPages)) {
    if (!savedIds.has(pageId)) chatPages[chatId] = first;
  }

  const sameClaims =
    Object.keys(chatPages).length === Object.keys(saved.chatPages).length &&
    Object.entries(chatPages).every(([chatId, pageId]) => claimOf(saved, chatId) === pageId);
  const samePages = pages.every((page, index) => page === saved.pages[index]);
  const doc = sameClaims && samePages ? saved : { ...saved, pages, chatPages };
  return { doc, changed: doc !== saved, deletedNow: deletedClaims(current, doc), restored };
}

/**
 * `doc` with the claims and `namedFor` marks a save's answer says were
 * stored (`namedFor` maps page id to chat id). Nothing else changes, so newer
 * edits in `doc` stay. A claim on a page `doc` no longer has goes to its
 * first page, as a delete would move it.
 */
export function applyStoredClaims(
  doc: DesignCanvas,
  chatPages: Readonly<Record<string, string>>,
  namedFor: Readonly<Record<string, string>> = {},
): DesignCanvas {
  const ids = new Set(doc.pages.map((page) => page.id));
  const first = doc.pages[0]!.id;
  const claims = Object.fromEntries(
    Object.entries(chatPages).map(([chatId, pageId]) => [chatId, ids.has(pageId) ? pageId : first]),
  );
  const pages = doc.pages.map((page) => {
    const named = Object.prototype.hasOwnProperty.call(namedFor, page.id) ? namedFor[page.id] : undefined;
    if (named === page.namedFor) return page;
    return named === undefined ? withoutNamedFor(page) : { ...page, namedFor: named };
  });
  return { ...doc, pages, chatPages: claims };
}

function withoutNamedFor(page: DesignPage): DesignPage {
  if (page.namedFor === undefined) return page;
  const { namedFor: _namedFor, ...rest } = page;
  return rest;
}
