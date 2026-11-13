// A step the Bot handed back to the person (plan §4.1; take control in
// docs/plans/bot-ux-simplification.md §3.4): "Needs you: Enter the 2FA code
// for your bank." with the reason and, first, **Take control** alone (the page
// or screen that helps, when there is one). Once the person has taken
// control the card offers **I'm done** and **Skip**. It sits in the chat's
// Needs-you slot, the shared Bot notice card elevated like an approval, with
// the Bot's own face in the tile; no coloured borders. The composer stays
// below it: typing there answers Done with a note, which the Bot reads, so the
// card says so. A card a password-or-code rule opened takes no note at all.
//
// A sign-in (plan §5.2) is the same card asking the person to sign in to one
// site for the Bot: "Sign in to github.com for Ada". Take control opens the
// site in a new tab of the Bot's own browser; a sign-in on the Bot's own
// computer (`target: "computer"`, plan §8.6) opens it there with the person in
// control, and the Bot's computer tools wait until the card is answered (a
// program it left running in the guest is the limit; docs/bot-computers.md).
//
// A step on the Bot's own screen (an action with `target`) opens in the Bot's
// browser or on its computer, never in the person's own browser.
//
// A Bot that lives on another Mac (`finishOn`) shows the same card here. Its
// sign-in happens in its own browser over there, so the first step is
// "Finish on <Mac>" and the second Skip alone. A step on its screen over
// there (`onMac`, Remote contract revision 43) offers "Finish on <Mac>", then
// Skip and I'm done.

import { ExternalLink, Globe, Laptop, LogIn, Monitor } from "lucide-react";
import { BotAvatar } from "../bot-avatar";
import { Button } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import type { BotAvatar as BotAvatarValue } from "../../shared/bots";
import { botHandoffTakesNote, type BotHandoffOutcome, type BotPendingHandoff } from "../../shared/bot-handoffs";

/** The page Open goes to, as the card names it ("bank.example"). */
function linkHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

type ShownHandoff = Pick<BotPendingHandoff, "kind" | "action" | "why" | "open" | "rule"> &
  Pick<Partial<BotPendingHandoff>, "origin" | "target"> & {
    /** A paired Mac's card that takes no note (Remote contract revision 40). */
    takesNote?: boolean;
    /** A paired Mac’s step on the Bot’s own screen there (Remote contract revision 43). */
    onMac?: boolean;
  };

/** An action on the Bot's own browser or computer, here or on its other Mac. */
function onBotScreen(handoff: ShownHandoff): boolean {
  return handoff.kind === "action" && (handoff.target !== undefined || handoff.onMac === true);
}

/** Take control's accessible name on the Bot's own screen: "Take control of Ada's computer". */
function screenControlLabel(name: string | undefined, target: "browser" | "computer"): string {
  const owner = name ? `${name}’s` : "the Bot’s";
  return `${TAKE_CONTROL} of ${owner} ${target}`;
}

function onComputer(handoff: Pick<ShownHandoff, "kind" | "target">): boolean {
  return handoff.kind === "sign_in" && handoff.target === "computer";
}

/** Every hand-off's first button: the person takes the step over. */
export const TAKE_CONTROL = "Take control";
/** Every hand-off's answer once the person did the step. */
export const IM_DONE = "I’m done";

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
  return `Sign in for ${name} with ${TAKE_CONTROL} above, then choose ${IM_DONE}.`;
}

/**
 * What the composer says while a password-or-code card waits: it is answered
 * on the card, never with a note, so the code can't reach the Bot.
 */
export function handoffNoNoteComposerText(name: string): string {
  return `Enter it yourself, then choose ${IM_DONE} above. This card takes no note, so a password or code never reaches ${name}.`;
}

/** The card's title: whose turn it is, or what to sign in to and for whom. */
export function handoffCardTitle(name: string, handoff: ShownHandoff): string {
  return handoff.kind === "sign_in" ? `Sign in to ${signInHost(handoff)} for ${name}` : `Needs you: ${handoff.action}`;
}

/**
 * The card's buttons, in two steps (§3.4). First **Take control** alone: it
 * opens the page, the sign-in, or the Bot's own browser or computer when
 * there is one, or "Finish on <Mac>" for a Bot that lives on another Mac.
 * Then **I'm done** and **Skip**, with the page one press away again. A
 * sign-in finished on another Mac is answered there, so its second step is
 * Skip alone. The answers on the wire are unchanged ("done", "skipped"). The
 * Bot panel repeats the buttons when it floats over the card, and both copies
 * share whether control was taken.
 */
export function HandoffActions({
  handoff,
  name,
  busy = false,
  finishOn,
  taken,
  onTake,
  onOpen,
  onFinish,
  onAnswer,
}: {
  handoff: ShownHandoff;
  /** The Bot's name, for Take control's accessible name ("Take control of Ada's computer"). */
  name?: string;
  busy?: boolean;
  finishOn?: string;
  /** The person took control: the card offers I'm done and Skip. */
  taken: boolean;
  /** Take control was pressed; the card moves to its second step. */
  onTake(): void;
  onOpen(): void;
  onFinish?(): void;
  onAnswer(outcome: BotHandoffOutcome): void;
}) {
  const signIn = handoff.kind === "sign_in";
  const host = handoff.open && !signIn ? linkHost(handoff.open.url) : undefined;
  const elsewhere = finishOn !== undefined && (signIn || onBotScreen(handoff));
  const done = (
    <Button variant="accent" size="small" disabled={busy} onClick={() => onAnswer("done")}>
      {IM_DONE}
    </Button>
  );
  const skip = (
    <Button variant="transparent" size="small" disabled={busy} onClick={() => onAnswer("skipped")}>
      Skip
    </Button>
  );
  if (elsewhere) {
    const finish = (variant: "accent" | "transparent") => (
      <Button
        variant={variant}
        size="small"
        disabled={busy}
        onClick={() => {
          onTake();
          onFinish?.();
        }}
      >
        <Laptop aria-hidden="true" />
        {`Finish on ${finishOn}`}
      </Button>
    );
    if (!taken) return finish("accent");
    return (
      <>
        {finish("transparent")}
        {skip}
        {signIn ? null : done}
      </>
    );
  }
  // What Take control opens, if anything, and how it is named and drawn.
  const opens = signIn ? handoff.open !== undefined : onBotScreen(handoff) ? handoff.target !== undefined : handoff.open !== undefined;
  const takeLabel = signIn
    ? onComputer(handoff) ? screenControlLabel(name, "computer") : `${TAKE_CONTROL} to sign in`
    : onBotScreen(handoff) && handoff.target !== undefined
      ? screenControlLabel(name, handoff.target)
      : host ? `${TAKE_CONTROL} at ${host}` : TAKE_CONTROL;
  const Icon = signIn
    ? onComputer(handoff) ? Monitor : LogIn
    : onBotScreen(handoff) && handoff.target !== undefined
      ? handoff.target === "computer" ? Monitor : Globe
      : handoff.open ? ExternalLink : null;
  if (!taken) {
    return (
      <Button
        variant="accent"
        size="small"
        disabled={busy}
        aria-label={takeLabel}
        onClick={() => {
          onTake();
          if (opens) onOpen();
        }}
      >
        {Icon ? <Icon aria-hidden="true" /> : null}
        {TAKE_CONTROL}
      </Button>
    );
  }
  return (
    <>
      {opens ? (
        <Button variant="transparent" size="small" disabled={busy} aria-label={`Open again: ${takeLabel}`} onClick={onOpen}>
          Open again
        </Button>
      ) : null}
      {skip}
      {done}
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
  taken,
  onTake,
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
  /** The person took control: the card offers I'm done and Skip. */
  taken: boolean;
  onTake(): void;
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
          name={name}
          busy={busy}
          finishOn={finishOn}
          taken={taken}
          onTake={onTake}
          onOpen={onOpen}
          onFinish={onFinish}
          onAnswer={onAnswer}
        />
      }
    >
      {handoff.why ? <p className="whitespace-pre-line">{handoff.why}</p> : null}
      {handoff.rule ? <p className="mt-1 text-tertiary">From your rule: {handoff.rule.label}</p> : null}
      {host && !onBotScreen(handoff) ? <p className="mt-1 text-tertiary">Opens {host}</p> : null}
      {onBotScreen(handoff) && finishOn === undefined && handoff.target !== undefined ? (
        <p className="mt-1 text-tertiary">
          {handoff.target === "computer"
            ? `Opens on ${name}’s own computer, with you in control. ${name} waits until you answer.`
            : `Opens in ${name}’s own browser${host ? ` at ${host}` : ""}, not in yours.`}
        </p>
      ) : null}
      {onBotScreen(handoff) && finishOn !== undefined ? (
        <p className="mt-1 text-tertiary">{`This step is on ${name}’s own screen on ${finishOn}.`}</p>
      ) : null}
      {!signIn && botHandoffTakesNote(handoff) ? (
        <p className="mt-1 text-tertiary">{`${name} reads any note you send. Enter passwords, codes and card numbers on the page, never in the chat.`}</p>
      ) : null}
      {signIn && !elsewhere ? (
        <p className="mt-1 text-tertiary">
          {onComputer(handoff)
            ? `Opens on ${name}’s own computer, with you in control. ${name} waits until you answer, and never sees your password.`
            : `Opens in ${name}’s own browser. ${name} never sees your password.`}
        </p>
      ) : null}
    </BotNoticeCard>
  );
}
