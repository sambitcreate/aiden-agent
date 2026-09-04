import * as React from "react";
import type { ChatMeta } from "../../lib/types";

const RECENT_LIMIT = 5;

/** Recent Aiden threads. chats:list already returns newest first. */
export function AssistantRecent({
  threads,
  disabled = false,
  onOpen,
}: {
  threads: ChatMeta[];
  disabled?: boolean;
  onOpen: (chatId: string) => void;
}): React.ReactElement | null {
  if (threads.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="px-1 text-small font-medium text-tertiary">Recent</p>
      {threads.slice(0, RECENT_LIMIT).map((thread) => (
        <button
          key={thread.id}
          type="button"
          disabled={disabled}
          className="truncate rounded-lg px-2 py-1.5 text-left text-regular text-secondary transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary disabled:opacity-40"
          onClick={() => onOpen(thread.id)}
        >
          {thread.title}
        </button>
      ))}
    </div>
  );
}
