import * as React from "react";
import { toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotAccessChoice, BotPendingAccessRequest } from "../../shared/bot-access-requests";

// Shared by mounted copies, scoped to the authorization attempt, not the
// durable logical request. An old answer cannot keep a new card busy.
const inFlightByCard = new Map<string, number>();
const listeners = new Set<() => void>();
const cardKey = (botId: string, waitId: string) => `${botId}\u0000${waitId}`;
function adjust(key: string, by: number): void {
  const next = Math.max(0, (inFlightByCard.get(key) ?? 0) + by);
  if (next === 0) inFlightByCard.delete(key);
  else inFlightByCard.set(key, next);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBotAccessRequestActions(botId: string, waitId: string | undefined) {
  const count = React.useSyncExternalStore(subscribe, () =>
    waitId === undefined ? 0 : (inFlightByCard.get(cardKey(botId, waitId)) ?? 0),
  );
  const answer = async (pending: BotPendingAccessRequest, choice: BotAccessChoice): Promise<void> => {
    const key = cardKey(botId, pending.waitId);
    adjust(key, 1);
    try {
      const { answered, savedForFuture } = await botsApi.answerAccessRequest(botId, pending.waitId, choice);
      if (!answered) toast.error("That card was already answered or closed.");
      else if (savedForFuture) toast.success("Folder approval recorded.");
      // Only the host's fresh projection removes a card. A response never
      // fabricates a grant or hides a failed authorization attempt.
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t send that answer."));
    } finally {
      adjust(key, -1);
    }
  };
  return { busy: count > 0, answer };
}
