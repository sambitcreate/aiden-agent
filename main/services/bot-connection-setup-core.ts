// Picks the one window that opens a Bot connection's setup dialog. Setup is a
// single flow, so it goes to the focused window, or the most recently focused
// one when none is focused, never to every window.

export interface ConnectionSetupWindow {
  readonly id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface ConnectionSetupWindows {
  /** Every open window, in creation order. */
  all(): readonly ConnectionSetupWindow[];
  /** Ids of windows that gained focus, most recent last. */
  focusHistory(): readonly number[];
}

/** The window that should show setup now, or null when no window is open. */
export function connectionSetupTarget(windows: ConnectionSetupWindows): ConnectionSetupWindow | null {
  const open = windows.all().filter((window) => !window.isDestroyed());
  const focused = open.find((window) => window.isFocused());
  if (focused) return focused;
  const history = windows.focusHistory();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const match = open.find((window) => window.id === history[index]);
    if (match) return match;
  }
  // Nothing was focused yet: the newest open window.
  return open[open.length - 1] ?? null;
}

/** Records focus changes in a bounded most-recent-last list. */
export function createFocusHistory(limit = 32) {
  const ids: number[] = [];
  return {
    focused(id: number): void {
      const index = ids.indexOf(id);
      if (index >= 0) ids.splice(index, 1);
      ids.push(id);
      if (ids.length > limit) ids.shift();
    },
    closed(id: number): void {
      const index = ids.indexOf(id);
      if (index >= 0) ids.splice(index, 1);
    },
    list(): readonly number[] {
      return ids;
    },
  };
}
