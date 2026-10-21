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
   * The card's Open. A sign-in opens in the Bot's own browser, and its panel's
   * Browser tab comes forward with focus, so the person can sign in there.
   */
  open(pending: BotPendingHandoff): Promise<void>;
}

export function useBotHandoffActions(botId: string): BotHandoffActions {
  const panel = useBotPanelActions();
  const [busy, setBusy] = React.useState(false);

  const send = async (pending: BotPendingHandoff, outcome: BotHandoffOutcome, note?: string): Promise<string | null> => {
    setBusy(true);
    try {
      const { answered } = await botsApi.answerHandoff(botId, pending.waitId, outcome, note);
      return answered ? null : "That card was already answered or closed.";
    } catch (error) {
      return userFacingErrorMessage(error, "Aiden couldn’t send that answer.");
    } finally {
      setBusy(false);
    }
  };

  const answer = async (pending: BotPendingHandoff, outcome: BotHandoffOutcome) => {
    const problem = await send(pending, outcome);
    if (problem) toast.error(problem);
  };

  const open = async (pending: BotPendingHandoff) => {
    const signIn = pending.kind === "sign_in";
    const failed = signIn ? "Aiden couldn’t open the sign-in page." : "Aiden couldn’t open that page.";
    setBusy(true);
    try {
      const { opened } = await botsApi.openHandoff(botId, pending.waitId);
      if (opened === "none") toast.error(failed);
      else if (signIn && opened === "browser") panel.show("browser");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, failed));
    } finally {
      setBusy(false);
    }
  };

  return { busy, send, answer, open };
}
