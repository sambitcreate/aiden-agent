import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BotComputersStatus, BotComputerStatus } from "../shared/bot-computers";
import { useAppCapabilities } from "./app-capabilities";
import { botComputersApi } from "./ipc";

export const BOT_COMPUTERS_QUERY_KEY = ["bot-computers", "status"] as const;

/**
 * Bot-computer status for this Mac, kept current by main's change broadcasts.
 * Where the platform has no Bot computers (Linux, Intel Macs) it never asks
 * main and reports `supported: false`.
 */
export function useBotComputersStatus() {
  const { botComputers: supported } = useAppCapabilities();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: BOT_COMPUTERS_QUERY_KEY,
    queryFn: () => botComputersApi.status(),
    enabled: supported,
  });
  React.useEffect(() => {
    if (!supported) return undefined;
    return botComputersApi.onChanged((status) => queryClient.setQueryData(BOT_COMPUTERS_QUERY_KEY, status));
  }, [supported, queryClient]);
  return { ...query, supported };
}

/** Writers for replies that carry a newer status than the cache. */
export function useBotComputersCache() {
  const queryClient = useQueryClient();
  return React.useMemo(() => {
    const update = (change: (status: BotComputersStatus) => BotComputersStatus): void => {
      queryClient.setQueryData<BotComputersStatus>(BOT_COMPUTERS_QUERY_KEY, (current) => (current ? change(current) : current));
    };
    return {
      set: (status: BotComputersStatus): void => {
        queryClient.setQueryData(BOT_COMPUTERS_QUERY_KEY, status);
      },
      update,
      putComputer: (computer: BotComputerStatus): void =>
        update((current) => ({
          ...current,
          computers: [...current.computers.filter((entry) => entry.botId !== computer.botId), computer],
        })),
      dropComputer: (botId: string): void =>
        update((current) => ({ ...current, computers: current.computers.filter((entry) => entry.botId !== botId) })),
      refresh: (): Promise<void> => queryClient.invalidateQueries({ queryKey: BOT_COMPUTERS_QUERY_KEY }),
    };
  }, [queryClient]);
}
