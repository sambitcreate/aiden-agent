// A Bot's memory view, kept fresh: one query per Bot that refetches whenever
// main reports a write with a revision the cache hasn't seen (the person's own
// edit, the Bot's `bot_memory` tool, a background review or a compaction flush).

import * as React from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { botsApi } from "../../lib/ipc";
import type { BotMemoryView } from "../../shared/bot-memory";

export const botMemoryKey = (botId: string) => ["bot-memory", botId] as const;

export function useBotMemory(botId: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: botMemoryKey(botId),
    queryFn: () => botsApi.memory.get(botId),
  });
  React.useEffect(
    () =>
      botsApi.onMemoryChanged((event) => {
        if (event.botId !== botId) return;
        if (qc.getQueryData<BotMemoryView>(botMemoryKey(botId))?.revision === event.revision) return;
        void qc.invalidateQueries({ queryKey: botMemoryKey(botId) });
      }),
    [botId, qc],
  );
  return query;
}

/** Puts a view an edit answered with into the cache, so the page shows it at once. */
export function storeBotMemoryView(qc: QueryClient, view: BotMemoryView): void {
  qc.setQueryData(botMemoryKey(view.botId), view);
}

/** How many things the Bot remembers across both stores. */
export function botMemoryCount(view: BotMemoryView): number {
  return view.user.entries.length + view.memory.entries.length;
}

/** "1 thing", "6 things". */
export function botMemoryCountLabel(count: number): string {
  return count === 1 ? "1 thing" : `${new Intl.NumberFormat().format(count)} things`;
}
