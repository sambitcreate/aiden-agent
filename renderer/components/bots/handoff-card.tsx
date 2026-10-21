// A step the Bot handed back to the person (plan §4.1): "Your turn: Enter the
// 2FA code for your bank." with the reason, an optional Open for the page that
// helps, Skip and Done. The shared Bot notice card, elevated like an approval,
// with the Bot's own face in the tile; no coloured borders. The composer stays
// below it: typing there answers Done with a note.
//
// A Bot that lives on another Mac (`finishOn`) shows the same card here. Its
// sign-in happens in its own browser over there, so that card offers
// "Finish on <Mac>" and Skip instead of Open and Done.

import { ExternalLink, Laptop } from "lucide-react";
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
  finishOn,
  onOpen,
  onFinish,
  onAnswer,
}: {
  /** A Bot of this Mac, whose photo the tile may show; left out for a Bot on another Mac. */
  botId?: string;
  name: string;
  avatar: BotAvatarValue;
  handoff: Pick<BotPendingHandoff, "kind" | "action" | "why" | "open" | "rule">;
  /** An answer or Open is on its way: the buttons wait for it. */
  busy?: boolean;
  /** The other Mac the Bot lives on, by name: a sign-in is finished there. */
  finishOn?: string;
  onOpen(): void;
  /** "Finish on <Mac>": bring the sign-in forward on the Bot's own Mac. */
  onFinish?(): void;
  onAnswer(outcome: BotHandoffOutcome): void;
}) {
  const elsewhere = handoff.kind === "sign_in" && finishOn !== undefined;
  const host = handoff.open && !elsewhere ? linkHost(handoff.open.url) : undefined;
  return (
    <BotNoticeCard
      label={`${name} needs you`}
      elevated
      iconTile={
        <BotAvatar
          {...(botId === undefined ? {} : { botId, photoLoading: "immediate" as const })}
          avatar={avatar}
          name={name}
          size="small"
        />
      }
      title={`Your turn: ${handoff.action}`}
      actions={
        <>
          {elsewhere ? (
            <Button variant="filled" size="small" disabled={busy} onClick={onFinish}>
              <Laptop aria-hidden="true" />
              {`Finish on ${finishOn}`}
            </Button>
          ) : handoff.open ? (
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
          {elsewhere ? null : (
            <Button variant="accent" size="small" disabled={busy} onClick={() => onAnswer("done")}>
              Done
            </Button>
          )}
        </>
      }
    >
      {handoff.why ? <p className="whitespace-pre-line">{handoff.why}</p> : null}
      {handoff.rule ? <p className="mt-1 text-tertiary">From your rule: {handoff.rule.label}</p> : null}
      {host ? <p className="mt-1 text-tertiary">Opens {host}</p> : null}
    </BotNoticeCard>
  );
}
