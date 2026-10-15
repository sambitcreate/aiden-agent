import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { chatsApi } from "../ipc";
import { queryKeys } from "../queries";
import { isChatCacheDeleted } from "../chat-deletion-cache";
import { localHostAdapter } from "./local-host-adapter";
import { createObservedRunLifecycle, observeLocalRun, type ObservedChatRead } from "./observed-local-run";

type ObservedRunLifecycle = ReturnType<typeof createObservedRunLifecycle>;

/**
 * Mirrors a run this Mac hosts for the visible chat while this pane is not
 * the one running it (a paired phone's turn, another window's). Observation
 * starts while main reports the chat `active`; when the chat goes idle the
 * finished run stays until its saved reply is in the cache. `chatId` null (a
 * draft, or the pane running its own turn) stops it at once, so nobody
 * watching costs nothing.
 */
export function useObservedLocalRun(chatId: string | null, workspaceId: string | undefined, active: boolean): void {
  const queryClient = useQueryClient();
  const lifecycleRef = React.useRef<ObservedRunLifecycle | null>(null);

  React.useEffect(() => {
    const lifecycle = createObservedRunLifecycle((target) =>
      observeLocalRun({
        adapter: localHostAdapter,
        chatId: target.chatId,
        workspaceId: target.workspaceId,
        refetch: async (): Promise<ObservedChatRead> => {
          const chatKey = queryKeys.chat(target.chatId);
          if (isChatCacheDeleted(target.chatId)) return { kind: "gone" };
          await queryClient.cancelQueries({ queryKey: chatKey, exact: true });
          if (isChatCacheDeleted(target.chatId)) return { kind: "gone" };
          // A competing read cancelling this one rejects; the observer retries.
          const chat = await queryClient.fetchQuery({
            queryKey: chatKey,
            queryFn: () => chatsApi.get(target.chatId),
            staleTime: 0,
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
          return chat ? { kind: "read", messages: chat.messages } : { kind: "gone" };
        },
      }),
    );
    lifecycleRef.current = lifecycle;
    return () => {
      lifecycle.dispose();
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
    };
  }, [queryClient]);

  // Declared after the lifecycle so it runs once one exists.
  React.useEffect(() => {
    lifecycleRef.current?.update({ target: chatId && workspaceId ? { chatId, workspaceId } : null, active });
  }, [active, chatId, workspaceId, queryClient]);
}
