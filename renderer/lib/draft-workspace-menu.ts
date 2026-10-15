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

const handles = new Map<string, DraftWorkspaceMenuHandle>();
const pendingMenus = new Map<string, DraftWorkspaceMenuView>();

export function registerDraftWorkspaceMenu(chatId: string, handle: DraftWorkspaceMenuHandle): () => void {
  handles.set(chatId, handle);
  const pending = pendingMenus.get(chatId);
  if (pending) {
    pendingMenus.delete(chatId);
    handle.openMenu(pending);
  }
  return () => {
    if (handles.get(chatId) === handle) handles.delete(chatId);
  };
}

/** The menu of the draft shown as `chatId`, when that draft's pane is mounted. */
export function draftWorkspaceMenu(chatId: string | undefined): DraftWorkspaceMenuHandle | undefined {
  return chatId ? handles.get(chatId) : undefined;
}

/** Open the draft's menu now, or as soon as its pane mounts. */
export function requestDraftWorkspaceMenu(chatId: string, view: DraftWorkspaceMenuView): void {
  const handle = handles.get(chatId);
  if (handle) {
    handle.openMenu(view);
    return;
  }
  pendingMenus.set(chatId, view);
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
