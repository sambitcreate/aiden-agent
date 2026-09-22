import * as React from "react";
import {
  chatMessageQueue,
  deliverQueuedMessage,
  type QueuedChatMessage,
} from "./chat-message-queue";
import { chatsApi } from "./ipc";
import { isAppendReconciliationRequired } from "../shared/chat-message-contract";
import { toast } from "../components/ui";

export function useChatMessageQueue(input: {
  chatId: string;
  contextKey: string;
  enabled: boolean;
  send: (message: QueuedChatMessage) => Promise<void>;
}) {
  const queue = React.useMemo(() => chatMessageQueue(input.chatId), [input.chatId]);
  const snapshot = React.useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const current = React.useRef<typeof input | null>(null);
  React.useLayoutEffect(() => {
    current.current = input;
    return () => {
      current.current = null;
    };
  });
  React.useEffect(() => {
    if (!input.enabled) return;
    void deliverQueuedMessage({
      queue,
      isCurrent: () =>
        current.current?.chatId === input.chatId &&
        current.current?.contextKey === input.contextKey &&
        current.current?.enabled === true,
      waitUntilIdle: () => chatsApi.waitUntilIdle(input.chatId),
      send: (message) => current.current!.send(message),
      isUnknownAppend: isAppendReconciliationRequired,
      onError: (error) =>
        toast.error(error instanceof Error ? error.message : "Couldn't send the queued message."),
    });
  }, [input.chatId, input.contextKey, input.enabled, queue, snapshot]);
  return { queue, snapshot };
}
