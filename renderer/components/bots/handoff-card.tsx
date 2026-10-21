// A step the Bot handed back to the person (plan §4.1): "Your turn: Enter the
// 2FA code for your bank." with the reason, an optional Open for the page that
// helps, Skip and Done. The shared Bot notice card, elevated like an approval,
// with the Bot's own face in the tile; no coloured borders. The composer stays
// below it: typing there answers Done with a note.
//
// A sign-in (plan §5.2) is the same card asking the person to sign in to one
// site for the Bot: "Sign in to github.com for Ada", with Open sign-in (the
// site in a new tab of the Bot's own browser), Skip and I'm signed in.
//
// A Bot that lives on another Mac (`finishOn`) shows the same card here. Its
// sign-in happens in its own browser over there, so that card offers
// "Finish on <Mac>" and Skip instead of Open sign-in and I'm signed in.

import { ExternalLink, Laptop, LogIn } from "lucide-react";
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

type ShownHandoff = Pick<BotPendingHandoff, "kind" | "action" | "why" | "open" | "rule"> & Pick<Partial<BotPendingHandoff>, "origin">;

/** The site a sign-in names ("github.com"): its origin, else its page, else its title. */
function signInHost(handoff: ShownHandoff): string {
  for (const url of [handoff.origin, handoff.open?.url]) {
    const host = url === undefined ? undefined : linkHost(url);
    if (host) return host;
  }
  return handoff.action.replace(/^Sign in to /u, "");
}

/**
 * What the composer says while a sign-in waits: it is answered on the card,
 * never with a note, so a password typed in the chat can't reach the Bot.
 */
export function handoffSignInComposerText(name: string): string {
  return `Sign in for ${name} with Open sign-in above, then choose I’m signed in.`;
}

/** The card's title: whose turn it is, or what to sign in to and for whom. */
export function handoffCardTitle(name: string, handoff: ShownHandoff): string {
  return handoff.kind === "sign_in" ? `Sign in to ${signInHost(handoff)} for ${name}` : `Your turn: ${handoff.action}`;
}

/**
 * The card's buttons: Open (or Open sign-in), Skip and Done (or I'm signed in),
 * or "Finish on <Mac>" and Skip for a sign-in on a Bot's other Mac. The Bot
 * panel repeats them when it floats over the card.
 */
export function HandoffActions({
  handoff,
  busy = false,
  finishOn,
  onOpen,
  onFinish,
  onAnswer,
}: {
  handoff: ShownHandoff;
  busy?: boolean;
  finishOn?: string;
  onOpen(): void;
  onFinish?(): void;
  onAnswer(outcome: BotHandoffOutcome): void;
}) {
  const signIn = handoff.kind === "sign_in";
  const host = handoff.open && !signIn ? linkHost(handoff.open.url) : undefined;
  const skip = (
    <Button variant="transparent" size="small" disabled={busy} onClick={() => onAnswer("skipped")}>
      Skip
    </Button>
  );
  if (signIn && finishOn !== undefined) {
    return (
      <>
        <Button variant="filled" size="small" disabled={busy} onClick={onFinish}>
          <Laptop aria-hidden="true" />
          {`Finish on ${finishOn}`}
        </Button>
        {skip}
      </>
    );
  }
  if (signIn) {
    return (
      <>
        {handoff.open ? (
          <Button variant="filled" size="small" disabled={busy} onClick={onOpen}>
            <LogIn aria-hidden="true" />
            Open sign-in
          </Button>
        ) : null}
        {skip}
        <Button variant="accent" size="small" disabled={busy} onClick={() => onAnswer("done")}>
          I’m signed in
        </Button>
      </>
    );
  }
  return (
    <>
      {handoff.open ? (
        <Button variant="filled" size="small" disabled={busy} aria-label={host ? `Open ${host}` : "Open"} onClick={onOpen}>
          <ExternalLink aria-hidden="true" />
          Open
        </Button>
      ) : null}
      {skip}
      <Button variant="accent" size="small" disabled={busy} onClick={() => onAnswer("done")}>
        Done
      </Button>
    </>
  );
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
  handoff: ShownHandoff;
  /** An answer or Open is on its way: the buttons wait for it. */
  busy?: boolean;
  /** The other Mac the Bot lives on, by name: a sign-in is finished there. */
  finishOn?: string;
  onOpen(): void;
  /** "Finish on <Mac>": bring the sign-in forward on the Bot's own Mac. */
  onFinish?(): void;
  onAnswer(outcome: BotHandoffOutcome): void;
}) {
  const signIn = handoff.kind === "sign_in";
  const elsewhere = signIn && finishOn !== undefined;
  const host = handoff.open && !signIn ? linkHost(handoff.open.url) : undefined;
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
      title={handoffCardTitle(name, handoff)}
      actions={
        <HandoffActions
          handoff={handoff}
          busy={busy}
          finishOn={finishOn}
          onOpen={onOpen}
          onFinish={onFinish}
          onAnswer={onAnswer}
        />
      }
    >
      {handoff.why ? <p className="whitespace-pre-line">{handoff.why}</p> : null}
      {handoff.rule ? <p className="mt-1 text-tertiary">From your rule: {handoff.rule.label}</p> : null}
      {host ? <p className="mt-1 text-tertiary">Opens {host}</p> : null}
      {signIn && !elsewhere ? (
        <p className="mt-1 text-tertiary">{`Opens in ${name}’s own browser. ${name} never sees your password.`}</p>
      ) : null}
    </BotNoticeCard>
  );
}
