export const COMMAND_CHAT_SHORTCUT_LIMIT = 9;
export const COMMAND_CHAT_SHORTCUT_REVEAL_MS = 500;

const ACCELERATOR_TO_EVENT_MODIFIER: Record<string, string> = {
  Command: "Meta",
  Control: "Control",
  Alt: "Alt",
  Shift: "Shift",
};

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

export function sidebarChatNavigationTargets<T extends { id: string }>(
  chats: readonly T[],
  activeChatId: string | undefined,
): { previous: T | null; next: T | null } {
  const activeIndex = chats.findIndex((chat) => chat.id === activeChatId);
  return {
    previous: activeIndex > 0 ? chats[activeIndex - 1] : null,
    next:
      activeIndex >= 0 && activeIndex < chats.length - 1
        ? chats[activeIndex + 1]
        : null,
  };
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

/** Complete modifier sets that can invoke at least one chat-jump binding. */
export function chatShortcutRevealModifierSets(
  bindings: readonly (string | null)[],
): string[][] {
  const unique = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!binding) continue;
    const modifiers: string[] = [];
    for (const part of binding.split("+").slice(0, -1)) {
      const modifier = ACCELERATOR_TO_EVENT_MODIFIER[part];
      if (modifier) modifiers.push(modifier);
    }
    modifiers.sort();
    if (modifiers.length > 0) unique.set(modifiers.join("+"), modifiers);
  }
  return [...unique.values()];
}
