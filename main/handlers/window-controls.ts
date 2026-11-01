// IPC for the window controls Aiden draws in its own top bar on Linux.
// Only the main window's own document may move, resize or close it.

import type { WindowControlsState } from "../../renderer/shared/window-chrome.js";

export const WINDOW_GET_STATE_CHANNEL = "app:window:getState";
export const WINDOW_MINIMIZE_CHANNEL = "app:window:minimize";
export const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = "app:window:toggleMaximize";
export const WINDOW_CLOSE_CHANNEL = "app:window:close";
export const WINDOW_SHOW_MENU_CHANNEL = "app:window:showMenu";
export const WINDOW_STATE_NOTIFICATION_CHANNEL = "app:window-state";

/** The slice of `BrowserWindow` these handlers use. */
export interface ControlledWindow {
  readonly webContents: { readonly id: number };
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
}

type Handle = (channel: string, handler: (event: { sender: { id: number } }, ...args: unknown[]) => unknown) => void;

export interface WindowControlHandlerDeps<W extends ControlledWindow> {
  handle: Handle;
  /** The main window, or null while none is open. */
  mainWindow: () => W | null;
  /**
   * Pops the application menu at a point in the window's content, in CSS
   * pixels. Returns false when there is no menu to show.
   */
  popupMenu: (window: W, point: { x: number; y: number }) => boolean;
}

export function windowControlsState(window: ControlledWindow): WindowControlsState {
  return { maximized: window.isMaximized(), fullScreen: window.isFullScreen() };
}

function parseMenuPoint(value: unknown): { x: number; y: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > 100_000 || y > 100_000) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export function registerWindowControlHandlers<W extends ControlledWindow>(deps: WindowControlHandlerDeps<W>): void {
  const owned = (event: { sender: { id: number } }): W | null => {
    const window = deps.mainWindow();
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) return null;
    return window;
  };

  deps.handle(WINDOW_GET_STATE_CHANNEL, (event) => {
    const window = owned(event);
    return window ? windowControlsState(window) : null;
  });
  deps.handle(WINDOW_MINIMIZE_CHANNEL, (event) => {
    const window = owned(event);
    if (!window) return false;
    window.minimize();
    return true;
  });
  deps.handle(WINDOW_TOGGLE_MAXIMIZE_CHANNEL, (event) => {
    const window = owned(event);
    if (!window || window.isFullScreen()) return null;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return windowControlsState(window);
  });
  deps.handle(WINDOW_CLOSE_CHANNEL, (event) => {
    const window = owned(event);
    if (!window) return false;
    // Goes through the window's guarded `close` handler, like the title bar's X.
    window.close();
    return true;
  });
  deps.handle(WINDOW_SHOW_MENU_CHANNEL, (event, point) => {
    const window = owned(event);
    const parsed = parseMenuPoint(point);
    if (!window || !parsed) return false;
    return deps.popupMenu(window, parsed);
  });
}

/**
 * Sends the window's maximize and full-screen state to its document whenever
 * either changes. Returns a function that stops listening.
 */
export function trackWindowControlsState(
  window: ControlledWindow & {
    on(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
  },
  send: (state: WindowControlsState) => void,
): () => void {
  let last: WindowControlsState | null = null;
  const publish = () => {
    if (window.isDestroyed()) return;
    const next = windowControlsState(window);
    if ((last && last.maximized === next.maximized && last.fullScreen === next.fullScreen)) return;
    last = next;
    send(next);
  };
  const events = ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore", "resize"];
  for (const name of events) window.on(name, publish);
  return () => {
    for (const name of events) window.removeListener(name, publish);
  };
}
