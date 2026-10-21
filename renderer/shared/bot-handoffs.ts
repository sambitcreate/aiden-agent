// Bot hand-offs (plan §4): a step the Bot hands back to the person, such as
// "Your turn: Enter the 2FA code for your bank.", answered with Done or Skip.
//
// Main owns the waits (`main/services/bot-runtime/bot-handoffs.ts`); this file
// holds the shapes every surface reads, their bounds, and the parsers for what
// comes back out of the durable transcript. A hand-off comes from the Bot's
// own `hand_off` tool (`source: "tool"`) or from one of its rules
// (`source: "rule"`); a sign-in (`kind: "sign_in"`) is the same card asking
// the person to sign in to one site in the Bot's own browser or computer.

import { isBoundedBotText } from "./bot-capabilities.js";

export const BOT_HANDOFF_TOOL_NAME = "hand_off";
export const BOT_SIGN_IN_TOOL_NAME = "sign_in";
export const BOT_HANDOFF_ACTION_MAX_CHARS = 160;
export const BOT_HANDOFF_WHY_MAX_CHARS = 400;
export const BOT_HANDOFF_NOTE_MAX_CHARS = 4_000;
export const BOT_HANDOFF_URL_MAX_CHARS = 2_048;
/** Entry kind main writes for rule-driven hand-off results; its data is `BotHandoffResultDetails`. */
export const BOT_HANDOFF_RESULT_ENTRY_KIND = "aiden.handoff-result";

const RULE_ID_MAX_CHARS = 128;
const RULE_LABEL_MAX_CHARS = 200;
const TOOL_CALL_ID_MAX_CHARS = 256;

export type BotHandoffKind = "action" | "sign_in";
export type BotHandoffOutcome = "done" | "skipped";
export type BotHandoffSource = "tool" | "rule";
export type BotHandoffTarget = "browser" | "computer";

/** The rule that made a hand-off, as the card names it. */
export interface BotHandoffRule {
  id: string;
  label: string;
}

/** A hand-off card waiting on the person. One per Bot at a time. */
export interface BotPendingHandoff {
  botId: string;
  /** The durable wait id (a UUID); the answer is posted against it. */
  waitId: string;
  toolCallId: string;
  kind: BotHandoffKind;
  /** The card's title after "Your turn: "; for a sign-in, "Sign in to <host>". */
  action: string;
  why?: string;
  /** An https page that helps; for a sign-in, always the site's origin. */
  open?: { url: string };
  /** Sign-in only: the normalized https origin. */
  origin?: string;
  /** Sign-in only: where the person signs in. Defaults to the Bot's browser. */
  target?: BotHandoffTarget;
  source: BotHandoffSource;
  /** Set when `source` is "rule". */
  rule?: BotHandoffRule;
}

export interface BotHandoffAnswer {
  outcome: BotHandoffOutcome;
  /** What the person typed with their answer, if anything. */
  note?: string;
}

/**
 * The person's answer as the transcript keeps it: the `details` of a settled
 * `hand_off` / `sign_in` tool result, or the data of an
 * `aiden.handoff-result` entry for a rule-driven hand-off.
 */
export interface BotHandoffResultDetails {
  kind: BotHandoffKind;
  outcome: BotHandoffOutcome;
  action: string;
  note?: string;
  origin?: string;
  /** Rule entries: the call the rule handed off. */
  toolCallId?: string;
  /** Rule entries: the rule that handed it off. */
  rule?: BotHandoffRule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return isBoundedBotText(value, maximum) && value.trim().length > 0;
}

/**
 * Control characters but tab, newline, vertical tab, form feed and carriage
 * return (whitespace, handled where the text is laid out), DEL, C1 controls,
 * and the marks that embed, override or isolate text direction.
 */
// eslint-disable-next-line no-control-regex -- these are exactly the characters it removes
const CARD_CONTROL_CHARACTERS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Text the Bot wrote for a card, without the characters that could make it
 * read differently from what it says (a reversed host, a hidden line).
 */
export function withoutBotHandoffControls(text: string): string {
  return text.replace(CARD_CONTROL_CHARACTERS, "");
}

/** Collapses whitespace and drops trailing full stops, so "Done" texts never read "code.." */
export function normalizeBotHandoffAction(text: string): string {
  return withoutBotHandoffControls(text.replace(/\s+/gu, " ")).trim().replace(/[.。]+$/u, "").trimEnd();
}

/**
 * A link a hand-off card may open: an absolute `https:` URL with a host, no
 * user name or password, no surrounding whitespace, at most 2,048 characters.
 */
export function isBotHandoffOpenUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > BOT_HANDOFF_URL_MAX_CHARS) return false;
  if (url.trim() !== url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
}

/** An https origin as `URL.origin` prints it ("https://github.com"). */
export function isBotHandoffOrigin(value: unknown): value is string {
  if (typeof value !== "string" || !isBotHandoffOpenUrl(value)) return false;
  return new URL(value).origin === value;
}

function ruleOf(value: unknown): BotHandoffRule | undefined {
  if (!isRecord(value)) return undefined;
  if (!boundedText(value.id, RULE_ID_MAX_CHARS) || !boundedText(value.label, RULE_LABEL_MAX_CHARS)) return undefined;
  return { id: value.id, label: value.label };
}

/** The person's answer to a card, or undefined when `value` is not exactly `{ outcome, note? }`. */
export function botHandoffAnswerOf(value: unknown): BotHandoffAnswer | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) if (key !== "outcome" && key !== "note") return undefined;
  const { outcome, note } = value;
  if (outcome !== "done" && outcome !== "skipped") return undefined;
  if (note === undefined) return { outcome };
  if (!boundedText(note, BOT_HANDOFF_NOTE_MAX_CHARS)) return undefined;
  return { outcome, note: note.trim() };
}

/** A hand-off answer from the transcript, or undefined for anything else (an error result, other details). */
export function botHandoffResultOf(details: unknown): BotHandoffResultDetails | undefined {
  if (!isRecord(details)) return undefined;
  const { kind, outcome, action, note, origin, toolCallId, rule } = details;
  if (kind !== "action" && kind !== "sign_in") return undefined;
  if (outcome !== "done" && outcome !== "skipped") return undefined;
  if (!boundedText(action, BOT_HANDOFF_ACTION_MAX_CHARS)) return undefined;
  if (note !== undefined && !boundedText(note, BOT_HANDOFF_NOTE_MAX_CHARS)) return undefined;
  if (origin !== undefined && !isBotHandoffOrigin(origin)) return undefined;
  if (toolCallId !== undefined && !boundedText(toolCallId, TOOL_CALL_ID_MAX_CHARS)) return undefined;
  const parsedRule = rule === undefined ? undefined : ruleOf(rule);
  if (rule !== undefined && parsedRule === undefined) return undefined;
  return {
    kind,
    outcome,
    action,
    ...(note === undefined ? {} : { note }),
    ...(origin === undefined ? {} : { origin }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(parsedRule === undefined ? {} : { rule: parsedRule }),
  };
}

/** The host a sign-in names ("github.com"), from its origin, else its action text. */
function signInHost(result: Pick<BotHandoffResultDetails, "action" | "origin">): string {
  if (result.origin !== undefined) {
    try {
      return new URL(result.origin).host;
    } catch {
      // Fall through to the action text.
    }
  }
  return result.action.replace(/^Sign in to /u, "");
}

/** What the transcript says the person did: "You did this: …", "You skipped this: …", "You signed in to …". */
export function botHandoffResultLine(result: Pick<BotHandoffResultDetails, "kind" | "outcome" | "action" | "origin">): string {
  if (result.outcome === "skipped") return `You skipped this: ${result.action}`;
  if (result.kind === "sign_in") return `You signed in to ${signInHost(result)}`;
  return `You did this: ${result.action}`;
}
