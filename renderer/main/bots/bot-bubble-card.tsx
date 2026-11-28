// What a bubbled Bot's chat shows in the Aiden window: the chat lives in its
// bubble now (one home at a time), with a way to bring it back here or open
// the bubble's mini chat.

import * as React from "react";
import { BotAvatar } from "../../components/bot-avatar";
import { Button, EmptyState, toast } from "../../components/ui";
import {
  applyBotBubbleChange,
  botBubblesApi,
  useBotBubbles,
  useBotBubblesLoaded,
} from "../../lib/bot-bubbles-api";
import { isBotBubbled } from "../../shared/bot-bubbles";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotDefinition } from "../../shared/bots";

/**
 * Where a Bot's chat lives now. A bubbled Bot's chat lives in its bubble (one
 * home at a time), so this window must not read its live feed: a subscription
 * here would tell main the chat is on screen in this window. `liveHere` is
 * false until this window has heard main's bubble state once.
 */
export function useBotChatHome(botId: string): { bubbled: boolean; liveHere: boolean } {
  const state = useBotBubbles();
  const loaded = useBotBubblesLoaded();
  const bubbled = state.host !== "off" && isBotBubbled(state, botId);
  return { bubbled, liveHere: loaded && !bubbled };
}

export function BotBubbleCard({ bot }: { bot: Pick<BotDefinition, "id" | "name" | "avatar"> }) {
  const [busy, setBusy] = React.useState(false);
  const run = async (change: () => Promise<unknown>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await change();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, fallback));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full flex-col items-center justify-center" data-bot-bubble-card="">
      <BotAvatar
        avatar={bot.avatar}
        botId={bot.id}
        name={bot.name}
        size="large"
        photoLoading="immediate"
      />
      <EmptyState
        role="status"
        className="pt-4"
        title={`${bot.name} is in a bubble`}
        description="This chat is open in its bubble at the edge of your screen. Bring it back to chat here."
        action={
          <>
            <Button
              variant="filled"
              disabled={busy}
              onClick={() =>
                void run(
                  () => applyBotBubbleChange(botBubblesApi.open(bot.id)),
                  `Aiden couldn’t open ${bot.name}’s bubble.`,
                )
              }
            >
              Open bubble
            </Button>
            <Button
              variant="accent"
              disabled={busy}
              onClick={() =>
                void run(
                  () => applyBotBubbleChange(botBubblesApi.bringBack(bot.id)),
                  `Aiden couldn’t bring ${bot.name} back.`,
                )
              }
            >
              Bring back here
            </Button>
          </>
        }
      />
    </div>
  );
}
