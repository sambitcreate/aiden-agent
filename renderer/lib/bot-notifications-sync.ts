import { forgetBotPendingChanges, pendingChangeBotIds } from "./bot-local-pending";
// What the Bot notifications re-read. `bots:changed`: Main sends one on every Bot
// session state change (`{ botId, session }`), so that common case re-reads
// only that Bot's live summary: its definition, the list and its Telegram
// binding can't have changed. Any other change naming a Bot (a photo, an edit
// from a phone, a routine) re-reads that Bot and the list; one naming no Bot
// re-reads everything, as before. A routine change (a Bot pausing one, a phone
// accepting or editing one) also re-reads that Bot's Routines panel.
// `bots:attention` (a question, approval, hand-off or issue appeared or settled)
// re-reads that one Bot's summary.

import * as React from "react";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateBotCanonicalPhotos } from "./bot-canonical-photo-cache";
import { botsApi, onNotification } from "./ipc";
import { queryKeys } from "./queries";

export async function invalidateForBotsChanged(queryClient: QueryClient, payload: unknown): Promise<void> {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const botId = typeof record.botId === "string" && record.botId ? record.botId : null;
  if (botId && record.deleted === true) {
    forgetBotPendingChanges(botId);
    queryClient.removeQueries({ queryKey: ["bot-open-work", botId] });
    queryClient.removeQueries({ queryKey: ["bot-routine-models", botId] });
  }
  if (botId && "session" in record) {
    await queryClient.invalidateQueries({ queryKey: queryKeys.botLiveSummary(botId) });
    return;
  }
  invalidateBotCanonicalPhotos();
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.bots }),
    queryClient.invalidateQueries({ queryKey: botId ? queryKeys.bot(botId) : ["bot"] }),
    queryClient.invalidateQueries({ queryKey: botId ? queryKeys.botLiveSummary(botId) : queryKeys.botLiveSummaries }),
    queryClient.invalidateQueries({ queryKey: botId ? queryKeys.botTelegramBinding(botId) : ["bot-telegram-binding"] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.botTelegramTargets }),
    queryClient.invalidateQueries({ queryKey: botId ? ["bot-routine-models", botId] : ["bot-routine-models"] }),
    // A routine change (a wake-up set, cancelled or switched off) names its Bot.
    queryClient.invalidateQueries({ queryKey: botId ? queryKeys.botRoutines(botId) : ["bot-routines"] }),
    // Profile-wide Bot settings can change from a paired phone.
    ...(!botId ? [queryClient.invalidateQueries({ queryKey: queryKeys.settings })] : []),
  ]);
}

/** "Re-read this Bot's summary", never the whole list; a payload without a Bot is ignored. */
async function invalidateForBotAttention(queryClient: QueryClient, payload: unknown): Promise<void> {
  const botId = payload && typeof payload === "object" ? (payload as { botId?: unknown }).botId : undefined;
  if (typeof botId === "string" && botId) await queryClient.invalidateQueries({ queryKey: queryKeys.botLiveSummary(botId) });
}

/** Keeps Bot queries in step with main's `bots:changed` and `bots:attention`; mount once per window. */
export function useBotNotificationsSync(queryClient: QueryClient): void {
  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const ids = pendingChangeBotIds();
        for (let start = 0; active && start < ids.length; start += 256) {
          const retired = await botsApi.confirmedRetiredPendingBots(ids.slice(start, start + 256));
          if (active) retired.forEach(forgetBotPendingChanges);
        }
      } catch { /* Unknown ownership must retain the original pending identities. */ }
    })();
    const stopChanged = onNotification("bots:changed", (payload: unknown) => void invalidateForBotsChanged(queryClient, payload));
    const stopAttention = onNotification("bots:attention", (payload: unknown) => void invalidateForBotAttention(queryClient, payload));
    return () => {
      active = false;
      stopChanged();
      stopAttention();
    };
  }, [queryClient]);
}
