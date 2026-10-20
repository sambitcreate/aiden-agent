// What the model reads after a hand-off settles (plan §4.1, §4.4, §5.2).
//
// The tool path (`hand_off`, `sign_in`) returns these as its result text; the
// rule path (a rule that hands a call to the person) blocks the call with
// them. They are the one wording every surface shares, so a Done from a phone
// reads exactly like a Done on the Mac.

import type { BotHandoffTarget } from "../../../renderer/shared/bot-handoffs.js";

function noteLine(note: string | undefined): string {
  return note === undefined || !note.trim() ? "" : `\nTheir note: ${note.trim()}`;
}

/** Done on an action card. */
export function handoffDoneText(action: string, note?: string): string {
  return `The person says they did this: ${action}. Check the result before continuing.${noteLine(note)}`;
}

/** Skip on any card. */
export function handoffSkippedText(action: string, note?: string): string {
  return (
    `The person chose not to do this: ${action}. Do not try another way to do it; say what you will do instead.` +
    noteLine(note)
  );
}

/** "I'm signed in" on a sign-in card; the check the Bot makes depends on where the person signed in. */
export function signInDoneText(origin: string, note?: string, target: BotHandoffTarget = "browser"): string {
  const check = target === "computer" ? "Check with a fresh computer capture" : "Check with browser_snapshot";
  return `The person says they signed in to ${origin}. ${check}; never ask for or type their password.${noteLine(note)}`;
}

/** Done on a card a rule opened instead of running the call. */
export function ruleHandoffDoneBlock(summary: string): string {
  return `The person did this themselves: ${summary}. Continue from there.`;
}

/** A rule hand-off on a turn nobody is watching (a routine, Telegram). */
export function ruleUnattendedBlock(ruleLabel: string): string {
  return `This needs the person (${ruleLabel}). Tell them in your reply.`;
}

/** A rule-made ask on a turn nobody is watching. */
export function ruleAskUnattendedBlock(ruleLabel: string): string {
  return `This needs the person's OK (${ruleLabel}). Tell them in your reply.`;
}
