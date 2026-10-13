import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { chatsApi } from "../ipc";
import { queryKeys } from "../queries";
import { isChatCacheDeleted } from "../chat-deletion-cache";
import { localHostAdapter } from "./local-host-adapter";
import { observeLocalRun } from "./observed-local-run";

/**
 * Mirrors a run this Mac hosts for the visible chat while this pane is not
 * the one running it (a paired phone's turn, another window's). `enabled`
 * should hold only while main reports the chat active and the pane has no
 * generation of its own, so nobody watching costs nothing.
 */
export function useObservedLocalRun(chatId: string, workspaceId: string | undefined, enabled: boolean): void {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!enabled || !workspaceId) return;
    const chatKey = queryKeys.chat(chatId);
    return observeLocalRun({
      adapter: localHostAdapter,
      chatId,
      workspaceId,
      refetch: async () => {
        if (isChatCacheDeleted(chatId)) return;
        await queryClient.cancelQueries({ queryKey: chatKey, exact: true });
        if (isChatCacheDeleted(chatId)) return;
        await queryClient.fetchQuery({ queryKey: chatKey, queryFn: () => chatsApi.get(chatId), staleTime: 0 });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      },
    });
  }, [chatId, enabled, queryClient, workspaceId]);
}
