// While the Bot panel floats over a narrow chat it covers the hand-off card
// above the composer, so the panel shows the card's title and buttons at its
// top: a sign-in the person opened in the panel's Browser tab is answered
// beside that tab, with no need to close the panel to reach I'm signed in.

import { BotAvatar } from "../../components/bot-avatar";
import { BotNoticeCard } from "../../components/bots/bot-notice-card";
import { HandoffActions, handoffCardTitle } from "../../components/bots/handoff-card";
import { useBotLive } from "../../lib/use-bot-live";
import type { BotAvatar as BotAvatarValue } from "../../shared/bots";
import { useBotHandoffActions } from "./use-bot-handoff-actions";

export function BotPanelHandoff({ botId, name, avatar }: { botId: string; name: string; avatar: BotAvatarValue }) {
  const handoff = useBotLive(botId).snapshot?.handoff ?? null;
  const actions = useBotHandoffActions(botId);
  if (!handoff) return null;
  return (
    <div className="shrink-0 px-3 pt-3">
      <BotNoticeCard
        key={handoff.waitId}
        label={`${name} needs you`}
        iconTile={<BotAvatar botId={botId} photoLoading="immediate" avatar={avatar} name={name} size="small" />}
        title={handoffCardTitle(name, handoff)}
        actions={
          <HandoffActions
            handoff={handoff}
            busy={actions.busy}
            onOpen={() => void actions.open(handoff)}
            onAnswer={(outcome) => void actions.answer(handoff, outcome)}
          />
        }
      />
    </div>
  );
}
