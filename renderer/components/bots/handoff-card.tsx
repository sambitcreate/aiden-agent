// A step the Bot handed back to the person (plan §4.1): "Your turn: Enter the
// 2FA code for your bank." with the reason, an optional Open for the page that
// helps, Skip and Done. The shared Bot notice card, elevated like an approval,
// with the Bot's own face in the tile; no coloured borders. The composer stays
// below it: typing there answers Done with a note.

import { ExternalLink } from "lucide-react";
import { BotAvatar } from "../bot-avatar";
import { Button } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import type { BotAvatar as BotAvatarValue } from "../../shared/bots";
import type { BotHandoffOutcome, BotPendingHandoff } from "../../shared/bot-handoffs";

/** The page Open goes to, as the card names it ("bank.example"). */
function linkHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

export function HandoffCard({
  botId,
  name,
  avatar,
  handoff,
  busy = false,
  onOpen,
  onAnswer,
}: {
  botId: string;
  name: string;
  avatar: BotAvatarValue;
  handoff: BotPendingHandoff;
  /** An answer or Open is on its way: the buttons wait for it. */
  busy?: boolean;
  onOpen(): void;
  onAnswer(outcome: BotHandoffOutcome): void;
}) {
  const host = handoff.open ? linkHost(handoff.open.url) : undefined;
  return (
    <BotNoticeCard
      label={`${name} needs you`}
      elevated
      iconTile={<BotAvatar botId={botId} avatar={avatar} name={name} photoLoading="immediate" size="small" />}
      title={`Your turn: ${handoff.action}`}
      actions={
        <>
          {handoff.open ? (
            <Button
              variant="filled"
              size="small"
              disabled={busy}
              aria-label={host ? `Open ${host}` : "Open"}
              onClick={onOpen}
            >
              <ExternalLink aria-hidden="true" />
              Open
            </Button>
          ) : null}
          <Button variant="transparent" size="small" disabled={busy} onClick={() => onAnswer("skipped")}>
            Skip
          </Button>
          <Button variant="accent" size="small" disabled={busy} onClick={() => onAnswer("done")}>
            Done
          </Button>
        </>
      }
    >
      {handoff.why ? <p className="whitespace-pre-line">{handoff.why}</p> : null}
      {handoff.rule ? <p className="mt-1 text-tertiary">From your rule: {handoff.rule.label}</p> : null}
      {host ? <p className="mt-1 text-tertiary">Opens {host}</p> : null}
    </BotNoticeCard>
  );
}
