import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { botsApi } from "../../lib/ipc";
import type { BotOpenWorkSnapshot } from "../../shared/bot-open-work";

export type BotOpenWorkApi = typeof botsApi.openWork;
export const botOpenWorkKey = (botId: string) => ["bot-open-work", botId] as const;

export function useBotOpenWork(botId: string, api: BotOpenWorkApi = botsApi.openWork) {
  const client = useQueryClient();
  const view = useQuery({
    queryKey: botOpenWorkKey(botId),
    queryFn: () => api.snapshot(botId),
    staleTime: 0,
  });
  React.useEffect(() => api.onChanged((changed) => {
    if (changed === botId) void client.invalidateQueries({ queryKey: botOpenWorkKey(botId) });
  }), [api, botId, client]);
  const adopt = React.useCallback((snapshot: BotOpenWorkSnapshot, expected?: BotOpenWorkSnapshot) => {
    if (snapshot.botId !== botId) return;
    const current = client.getQueryData<BotOpenWorkSnapshot>(botOpenWorkKey(botId));
    // A read received since dispatch may already be newer than this response.
    if (expected && current && current !== expected) {
      void client.invalidateQueries({ queryKey: botOpenWorkKey(botId) });
      return;
    }
    void client.cancelQueries({ queryKey: botOpenWorkKey(botId) });
    client.setQueryData(botOpenWorkKey(botId), snapshot);
  }, [botId, client]);
  return { ...view, adopt };
}
