// A Bot that can schedule its own future turns must not remember that it
// can't. Bots made before routines existed sometimes saved "I cannot
// self-schedule" and then believed that note over their instructions,
// writing it back every time the subject came up. While a Bot has routines,
// `bot_memory` refuses a new entry that says it can't schedule, run on a
// timer or message the person first.

import type { BotMemoryTarget } from "../../../renderer/shared/bot-memory.js";

/** Shown to the Bot when such an entry is refused. */
export const BOT_MEMORY_REACH_OUT_CLAIM_ERROR =
  "Not saved: it isn't true. You can arrange future turns in this chat with the routines tool (load it with load_tools if it isn't declared yet) and set wake-ups, so you can message the person first at a scheduled time. If a saved entry says otherwise, remove it.";

const NEGATION = String.raw`(?:can't|cant|cannot|can not|unable to|not able to|(?:have|has) no (?:way|ability|means) to|(?:don't|doesn't|do not|does not) have (?:a way|the ability|any way|the means) to|won't be able to|will not be able to)`;

/** "I", "I'm" or "the Bot is". */
const BOT_SUBJECT = String.raw`\b(?:i|bot|the bot|this bot|assistant|the assistant)(?:'m|'s|'ll| am| is| will)? `;
/** Or, in the Bot's own notes, nothing at the start of an entry or sentence ("Cannot self-schedule."). */
const NOTE_SUBJECT = String.raw`(?:${BOT_SUBJECT}|^|[.!?;:•*-] )`;

/** What a Bot with routines can do, as the words such a note uses. */
const ABILITIES = [
  String.raw`self[- ]?schedule`,
  String.raw`schedule (?:myself|my own|(?:a |any )?(?:future |follow[- ]up )?(?:turns?|messages?|check[- ]ins?|wake[- ]ups?|runs?|routines?|reminders? for myself))`,
  String.raw`run (?:on a (?:timer|schedule|clock)|automatically|by myself|on my own|unprompted)`,
  String.raw`(?:start|initiate|begin) (?:a |the |any |new |a new )?(?:conversations?|chats?|contact)`,
  String.raw`initiate (?:a |any )?messages?`,
  String.raw`(?:message|ping|contact|text|write to|notify|reach out to|talk to|speak to|nudge) (?:\w+ ){0,2}first`,
  String.raw`(?:reach out|speak|talk|post|act|message|ping) (?:first|on my own|unprompted|proactively)`,
  String.raw`send (?:a |any )?messages? (?:first|on my own|unprompted|proactively|without being (?:asked|pinged|prompted))`,
  String.raw`wake myself(?: up)?`,
  String.raw`set (?:a |any )?(?:wake[- ]ups?|timers?) for myself`,
];

const claim = (subject: string) =>
  new RegExp(String.raw`${subject}(?:really |actually |still |simply |just )?${NEGATION} (?:${ABILITIES.join("|")})`, "u");
const NOTE_CLAIM = claim(NOTE_SUBJECT);
const USER_CLAIM = claim(BOT_SUBJECT);

/**
 * Whether `text` says the Bot itself can't schedule, run on a timer or
 * message first. Entries about the person ('user') are written about them
 * ("Can't start conversations at work."), so there it takes the Bot as subject.
 */
export function botMemoryClaimsNoReachOut(text: string, target: BotMemoryTarget = "memory"): boolean {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  return (target === "user" ? USER_CLAIM : NOTE_CLAIM).test(normalized);
}
