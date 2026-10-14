// The Bots sidebar's rows (spec §9): one per Bot, newest activity first, read
// from the same live summaries main projects for the chat. A question or an
// approval appearing or settling (`bots:attention`) re-reads that one Bot's
// row; state changes already re-read every row through `bots:changed`.

import * as React from "react";
import { useQueries, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { botsApi, onNotification } from "../../lib/ipc";
import { useBots } from "../../lib/queries";
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

export const BOT_WORKING_LINE = "Thinking…";
export const BOT_WAITING_LINE = "Waiting for you";

export const botLiveSummaryKey = (botId: string) => ["bot-live-summary", botId] as const;

export function botSidebarRows(
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
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.bot.name, row.bot.description ?? "", row.preview ?? ""].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

export type BotRowLine = { kind: "working" | "waiting" | "status" | "preview"; text: string };

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
  return queryClient.getQueryData<BotLiveSummary>(botLiveSummaryKey(botId)) ?? summary;
}

export function useBotRows() {
  const queryClient = useQueryClient();
  const bots = useBots();
  const list = bots.data ?? [];
  const summaries = useQueries({
    queries: list.map((bot) => ({
      queryKey: botLiveSummaryKey(bot.id),
      queryFn: () => readLiveSummary(queryClient, bot.id),
      retry: false,
    })),
  });
  React.useEffect(
    () =>
      onNotification<{ botId?: unknown }>("bots:attention", (payload) => {
        // "Re-read this Bot", never the whole list.
        const botId = payload?.botId;
        if (typeof botId === "string" && botId) void queryClient.invalidateQueries({ queryKey: botLiveSummaryKey(botId) });
      }),
    [queryClient],
  );
  const rows = botSidebarRows(
    list,
    summaries.map((result) => result.data),
  );
  return { bots, rows, summariesSettled: summaries.every((result) => !result.isPending) };
}
