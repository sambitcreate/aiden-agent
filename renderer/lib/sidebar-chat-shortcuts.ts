export const COMMAND_CHAT_SHORTCUT_LIMIT = 9;
export const COMMAND_CHAT_SHORTCUT_REVEAL_MS = 500;

export interface SidebarChatSection<T> {
  chats: readonly T[];
}

export interface SidebarChatShortcut<T> {
  chat: T;
  number: number;
}

/**
 * Assign shortcuts from the canonical sidebar section order. This deliberately
 * does not sort: recency, pinning, and future user-selected sorting belong to
 * the sidebar order provider, and the shortcut projection follows that order.
 */
export function createSidebarChatShortcutAssignments<T>(
  sections: readonly SidebarChatSection<T>[],
): SidebarChatShortcut<T>[] {
  const assignments: SidebarChatShortcut<T>[] = [];

  for (const section of sections) {
    for (const chat of section.chats) {
      assignments.push({ chat, number: assignments.length + 1 });
      if (assignments.length === COMMAND_CHAT_SHORTCUT_LIMIT) return assignments;
    }
  }

  return assignments;
}

export interface CommandChatShortcutEvent {
  key: string;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** Return the requested chat number for an exact, non-repeating Command+digit. */
export function commandChatShortcutNumber(event: CommandChatShortcutEvent): number | null {
  if (
    !event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.repeat ||
    event.isComposing ||
    !/^[1-9]$/.test(event.key)
  ) {
    return null;
  }

  return Number(event.key);
}
