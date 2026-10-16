// Lets app-level entry points (⌘⇧O, the New chat in… palette's Clone row)
// reach the workspace menu of the draft that is open, without the app shell
// knowing about the pane's composer. A pane that mounts after the request
// (for example right after navigating to a new draft) takes it once.

export type DraftWorkspaceMenuView = "list" | "clone";

export interface DraftWorkspaceMenuHandle {
  /** Pick a folder with the native dialog and move this draft there. */
  openFolder: () => Promise<void>;
  /** Open the draft's workspace menu, in its list or its Clone view. */
  openMenu: (view: DraftWorkspaceMenuView) => void;
}

/** A request for a pane that has not mounted is kept only this long. */
export const PENDING_DRAFT_WORKSPACE_MENU_MS = 3_000;

const handles = new Map<string, DraftWorkspaceMenuHandle>();
// At most one request waits for a pane: a newer request replaces it, and it
// expires so a pane that never mounts (failed navigation) leaves nothing behind.
let pending: { chatId: string; view: DraftWorkspaceMenuView; at: number } | null = null;

export function registerDraftWorkspaceMenu(
  chatId: string,
  handle: DraftWorkspaceMenuHandle,
  now = Date.now(),
): () => void {
  handles.set(chatId, handle);
  if (pending && now - pending.at > PENDING_DRAFT_WORKSPACE_MENU_MS) pending = null;
  if (pending?.chatId === chatId) {
    const { view } = pending;
    pending = null;
    handle.openMenu(view);
  }
  return () => {
    if (handles.get(chatId) === handle) handles.delete(chatId);
  };
}

/** The menu of the draft shown as `chatId`, when that draft's pane is mounted. */
export function draftWorkspaceMenu(chatId: string | undefined): DraftWorkspaceMenuHandle | undefined {
  return chatId ? handles.get(chatId) : undefined;
}

/** Open the draft's menu now, or when its pane mounts within a few seconds. */
export function requestDraftWorkspaceMenu(
  chatId: string,
  view: DraftWorkspaceMenuView,
  now = Date.now(),
): void {
  const handle = handles.get(chatId);
  if (handle) {
    pending = null;
    handle.openMenu(view);
    return;
  }
  pending = { chatId, view, at: now };
}

/** The chat id in a `/chat/<id>` path (the pane a draft is shown in), if any. */
export function chatIdFromPath(pathname: string): string | undefined {
  const match = /^\/chat\/([^/]+)\/?$/u.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}
