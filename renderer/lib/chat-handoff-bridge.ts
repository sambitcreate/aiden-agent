// Lightweight renderer-local bridge notifying ChatPane that main has a
// pending cross-window handoff ticket for a specific chatId (handling both
// freshly mounted panes and panes already viewing that chat).

const pendingChatIds = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

export function notifyPendingChatHandoff(chatId: string): void {
  pendingChatIds.add(chatId);
  const subs = listeners.get(chatId);
  if (!subs) return;
  for (const fn of [...subs]) fn();
}

export function consumePendingChatHandoff(chatId: string): boolean {
  if (!pendingChatIds.has(chatId)) return false;
  pendingChatIds.delete(chatId);
  return true;
}

export function subscribePendingChatHandoff(chatId: string, onNotify: () => void): () => void {
  let subs = listeners.get(chatId);
  if (!subs) {
    subs = new Set();
    listeners.set(chatId, subs);
  }
  subs.add(onNotify);
  return () => {
    subs?.delete(onNotify);
    if (subs?.size === 0) listeners.delete(chatId);
  };
}
