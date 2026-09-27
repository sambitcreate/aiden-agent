import * as React from "react";
import { chatsApi } from "./ipc";

interface ReadableMessage {
  id: string;
  role: string;
}

/**
 * The newest persisted user/assistant message id, which is exactly what the
 * viewer has rendered. Streaming output is not yet persisted, so the marker
 * can only ever cover output the user could actually see.
 */
export function latestReadableMessageId(
  messages: readonly ReadableMessage[] | undefined,
): string | null {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" || message.role === "assistant") return message.id;
  }
  return null;
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Report the open chat as read through its newest persisted message while the
 * window is visible. A chat that finishes in a hidden window stays unread until
 * the user actually brings it into view.
 */
export function useMarkChatRead(
  chatId: string | undefined,
  messages: readonly ReadableMessage[] | undefined,
): void {
  const throughMessageId = latestReadableMessageId(messages);
  const reported = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!chatId || !throughMessageId) return;
    const key = `${chatId}\u0000${throughMessageId}`;
    const report = () => {
      if (!documentIsVisible() || reported.current === key) return;
      reported.current = key;
      void chatsApi.markRead(chatId, throughMessageId).catch(() => {
        reported.current = null;
      });
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, [chatId, throughMessageId]);
}
