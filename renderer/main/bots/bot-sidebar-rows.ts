// The Bots sidebar's rows (spec §9): one per Bot, newest activity first, read
// from the same live summaries main projects for the chat. The window's one
// `useBotNotificationsSync` re-reads a single Bot's row on its `bots:attention`
// and on its session state change (`bots:changed`).

import * as React from "react";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { botsApi } from "../../lib/ipc";
import { queryKeys, useBots } from "../../lib/queries";
import { matchesSearch } from "../../lib/search-fold";
import type { BotLiveSummary } from "../../shared/bot-live";
import type { BotDefinition } from "../../shared/bots";
import { botRowStatusLabel, type BotSessionState } from "./bot-session-state";

export interface BotSidebarRow {
  bot: BotDefinition;
  state?: BotSessionState;
  /** Last message preview, one line of plain text. */
  preview?: string;
  /** When the Bot's chat last changed, or the Bot itself when it has no messages. */
  activityAt: number;
  needsYou: boolean;
  lastReplyAt: number | null;
}

const BOT_WORKING_LINE = "Thinking…";
const BOT_WAITING_LINE = "Waiting for you";

function botSidebarRows(
  bots: readonly BotDefinition[],
  summaries: ReadonlyArray<BotLiveSummary | undefined>,
): BotSidebarRow[] {
  return bots
    .map((bot, index): BotSidebarRow => {
      const summary = summaries[index];
      return {
        bot,
        ...(summary ? { state: summary.state } : {}),
        ...(summary?.preview ? { preview: summary.preview } : {}),
        activityAt: summary?.updatedAt ?? bot.updatedAt,
        needsYou: summary?.needsYou ?? false,
        lastReplyAt: summary?.lastReplyAt ?? null,
      };
    })
    .sort((left, right) => right.activityAt - left.activityAt || left.bot.name.localeCompare(right.bot.name));
}

export function matchesBotSearch(row: BotSidebarRow, query: string): boolean {
  return matchesSearch([row.bot.name, row.bot.description ?? "", row.preview ?? ""], query);
}

type BotRowLine = { kind: "working" | "waiting" | "status" | "preview"; text: string };

export function botRowLine(row: BotSidebarRow): BotRowLine | null {
  if (row.needsYou) return { kind: "waiting", text: BOT_WAITING_LINE };
  if (row.state?.kind === "running") return { kind: "working", text: BOT_WORKING_LINE };
  const status = botRowStatusLabel(row.state);
  if (status) return { kind: "status", text: status };
  return row.preview ? { kind: "preview", text: row.preview } : null;
}

// Reads of one Bot's summary can overlap (an attention event during a refresh);
// only the newest read may set the row, so a slow older answer never wins.
const latestSummaryRead = new Map<string, number>();
let summaryReads = 0;

async function readLiveSummary(queryClient: QueryClient, botId: string): Promise<BotLiveSummary> {
  const read = (summaryReads += 1);
  latestSummaryRead.set(botId, read);
  const summary = await botsApi.liveSummary(botId);
  if (latestSummaryRead.get(botId) === read) return summary;
  return queryClient.getQueryData<BotLiveSummary>(queryKeys.botLiveSummary(botId)) ?? summary;
}

/** One Bot's live summary, from the same cache (and the same newest-read rule) as its sidebar row. */
export function useBotLiveSummary(botId: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.botLiveSummary(botId),
    queryFn: () => readLiveSummary(queryClient, botId),
    retry: false,
  });
}

export function useBotRows() {
  const queryClient = useQueryClient();
  const bots = useBots();
  const list = bots.data ?? [];
  const summaries = useQueries({
    queries: list.map((bot) => ({
      queryKey: queryKeys.botLiveSummary(bot.id),
      queryFn: () => readLiveSummary(queryClient, bot.id),
      retry: false,
    })),
  });
  React.useEffect(() => {
    // Forget read numbers of Bots no longer listed, so the map tracks only live Bots.
    if (!bots.data) return;
    const live = new Set(bots.data.map((bot) => bot.id));
    for (const botId of latestSummaryRead.keys()) if (!live.has(botId)) latestSummaryRead.delete(botId);
  }, [bots.data]);
  const rows = botSidebarRows(
    list,
    summaries.map((result) => result.data),
  );
  return { bots, rows, summariesSettled: summaries.every((result) => !result.isPending) };
}
