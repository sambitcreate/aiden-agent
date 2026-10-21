// Answering and opening a Bot's hand-off card (plan §4, §5.2), shared by the
// card above the chat's composer and the copy of its buttons the Bot panel
// shows while it floats over that card.

import * as React from "react";
import { toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotHandoffOutcome, BotPendingHandoff } from "../../shared/bot-handoffs";
import { useBotPanelActions } from "./bot-panel-context";

export interface BotHandoffActions {
  /** An answer or Open is on its way: the buttons wait for it. */
  busy: boolean;
  /** Send Done or Skip: null once main recorded it, else what to tell the person. */
  send(pending: BotPendingHandoff, outcome: BotHandoffOutcome, note?: string): Promise<string | null>;
  /** The card's Done or Skip; a problem shows as a toast. */
  answer(pending: BotPendingHandoff, outcome: BotHandoffOutcome): Promise<void>;
  /**
   * The card's Open. A sign-in opens in the Bot's own browser, or on its own
   * computer with the person in control, and the panel's Browser or Computer
   * tab comes forward with focus, so the person can sign in there.
   */
  open(pending: BotPendingHandoff): Promise<void>;
}

/**
 * How many answers and Opens are on their way, per card, shared by every copy
 * of that card's buttons (the chat's card and the floating panel's): one
 * finishing leaves every copy waiting for the others, so a note sent from the
 * composer keeps the panel's Done waiting too. Keyed by card, so a call that
 * never ends can't hold the buttons of the Bot's next card.
 */
const inFlightByCard = new Map<string, number>();
const inFlightListeners = new Set<() => void>();
const cardKey = (botId: string, waitId: string) => `${botId}\u0000${waitId}`;

function adjustInFlight(key: string, by: number): void {
  const next = Math.max(0, (inFlightByCard.get(key) ?? 0) + by);
  if (next === 0) inFlightByCard.delete(key);
  else inFlightByCard.set(key, next);
  for (const listener of inFlightListeners) listener();
}

function subscribeInFlight(listener: () => void): () => void {
  inFlightListeners.add(listener);
  return () => inFlightListeners.delete(listener);
}

/** `waitId`: the card the buttons are shown for now, if any. */
export function useBotHandoffActions(botId: string, waitId: string | undefined): BotHandoffActions {
  const panel = useBotPanelActions();
  const inFlight = React.useSyncExternalStore(subscribeInFlight, () =>
    waitId === undefined ? 0 : (inFlightByCard.get(cardKey(botId, waitId)) ?? 0),
  );

  const send = async (pending: BotPendingHandoff, outcome: BotHandoffOutcome, note?: string): Promise<string | null> => {
    const key = cardKey(botId, pending.waitId);
    adjustInFlight(key, 1);
    try {
      const { answered } = await botsApi.answerHandoff(botId, pending.waitId, outcome, note);
      return answered ? null : "That card was already answered or closed.";
    } catch (error) {
      return userFacingErrorMessage(error, "Aiden couldn’t send that answer.");
    } finally {
      adjustInFlight(key, -1);
    }
  };

  const answer = async (pending: BotPendingHandoff, outcome: BotHandoffOutcome) => {
    const problem = await send(pending, outcome);
    if (problem) toast.error(problem);
  };

  const open = async (pending: BotPendingHandoff) => {
    const signIn = pending.kind === "sign_in";
    const failed = signIn ? "Aiden couldn’t open the sign-in page." : "Aiden couldn’t open that page.";
    const key = cardKey(botId, pending.waitId);
    adjustInFlight(key, 1);
    try {
      const { opened } = await botsApi.openHandoff(botId, pending.waitId);
      if (opened === "none") toast.error(failed);
      else if (signIn && opened === "browser") panel.show("browser");
      else if (signIn && opened === "computer") panel.show("computer");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, failed));
    } finally {
      adjustInFlight(key, -1);
    }
  };

  return { busy: inFlight > 0, send, answer, open };
}
