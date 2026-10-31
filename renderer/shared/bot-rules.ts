// Plain-language rules for a Bot (plan §6): "Make a purchase or booking →
// Ask first", "Move money or enter card details → Hand off to me (always)".
//
// Rules only make a Bot stricter. Aiden enforces them in main at every tool
// call (`main/services/bot-rules/*`, `bot-tool-assembly.ts`) and also renders
// them into the Bot's prompt so it can plan around them:
//
// - Locked rules are code constants. They are never stored, so a tampered
//   rules file can't remove them, and nobody can change them.
// - Built-in rules can switch between Ask first and Hand off to me. They can't
//   be removed.
// - Custom rules are the person's own words ("When Ada wants to book a flight
//   → Hand off to me"). They can be added, edited and deleted.
//
// This file holds the shapes every surface reads, the fixed rule tables and
// their labels, and the IPC channel names.

export const BOT_ACTION_CLASSES = ["credentials", "money", "purchase", "communicate", "delete", "publish", "install"] as const;
export type BotActionClass = (typeof BOT_ACTION_CLASSES)[number];

/** What a rule asks for. "allowed" is only a baseline, never a rule. */
export type BotRuleBehavior = "ask" | "hand_off";
/** What a call needs before any rule: today's approval decision. */
export type BotBaseline = "allowed" | "ask";
/** A call's outcome after the rules. */
export type BotRuled = "allowed" | "ask" | "hand_off";

/** Strictness order: allowed < ask < hand_off. */
export const BOT_RULED_RANK: Readonly<Record<BotRuled, number>> = Object.freeze({ allowed: 0, ask: 1, hand_off: 2 });

export interface BotRule {
  id: string;
  /** Built-in (locked or not) rules. */
  actionClass?: BotActionClass;
  /** Custom rules: the person's words, completing "When <Bot> wants to …". */
  text?: string;
  behavior: BotRuleBehavior;
  /** Locked rules come from code and can't be changed. */
  locked: boolean;
}

export const BOT_RULE_TEXT_MAX_CHARS = 120;
export const BOT_CUSTOM_RULES_MAX = 20;
/** Custom rule ids: `custom.` and a UUID. */
export const BOT_CUSTOM_RULE_ID_PATTERN = /^custom\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The rule labels, as the editor and the approval and hand-off cards show them (plan §6.1). */
const ACTION_CLASS_LABELS: Readonly<Record<BotActionClass, string>> = Object.freeze({
  credentials: "Enter a password or 2FA code, or change account security",
  money: "Move money or enter card details",
  purchase: "Make a purchase or booking",
  communicate: "Send a message or email to someone",
  publish: "Post or publish something publicly",
  delete: "Permanently delete something",
  // The person's Mac: inside a Bot's own computer, installing is not ruled (plan §8.7).
  install: "Install software on your Mac",
});

function rule(actionClass: BotActionClass, behavior: BotRuleBehavior, locked: boolean): BotRule {
  return Object.freeze({ id: `${locked ? "locked" : "default"}.${actionClass}`, actionClass, behavior, locked });
}

/** Always hand these to the person. */
export const BOT_LOCKED_RULES: readonly BotRule[] = Object.freeze([
  rule("credentials", "hand_off", true),
  rule("money", "hand_off", true),
]);

/** Built-in rules every Bot starts with; each can change to Hand off to me. */
export const BOT_DEFAULT_RULES: readonly BotRule[] = Object.freeze([
  rule("purchase", "ask", false),
  rule("communicate", "ask", false),
  rule("publish", "ask", false),
  rule("delete", "ask", false),
  rule("install", "ask", false),
]);

/** The built-in classes a person can change (Ask first or Hand off to me). */
export type BotChangeableActionClass = "purchase" | "communicate" | "publish" | "delete" | "install";
export const BOT_CHANGEABLE_ACTION_CLASSES: readonly BotChangeableActionClass[] = Object.freeze(
  BOT_DEFAULT_RULES.map((entry) => entry.actionClass as BotChangeableActionClass),
);

export function isBotRuleBehavior(value: unknown): value is BotRuleBehavior {
  return value === "ask" || value === "hand_off";
}

/** Collapses whitespace and drops trailing full stops, as a custom rule's text is stored. */
export function normalizeBotRuleText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().replace(/[.。]+$/u, "").trimEnd();
}

/**
 * The rule as its cards name it: the §6.1 text for a built-in rule, or a
 * custom rule's own words with a capital first letter ("Book a flight").
 * The editor renders custom rules as "When <Bot> wants to <text>".
 */
export function botRuleLabel(entry: Pick<BotRule, "actionClass" | "text">): string {
  if (entry.actionClass !== undefined) return ACTION_CLASS_LABELS[entry.actionClass];
  const text = normalizeBotRuleText(entry.text ?? "");
  return text.length === 0 ? "Your rule" : text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

export function botRuleBehaviorLabel(behavior: BotRuleBehavior): string {
  return behavior === "hand_off" ? "Hand off to me" : "Ask first";
}

/** A Bot's rules: locked, then built-in, then custom. `revision` is 0 until the first edit. */
export interface BotRulesView {
  botId: string;
  revision: number;
  rules: BotRule[];
  /**
   * The saved rules file doesn't parse. `rules` are then the defaults a
   * change starts again from, and the Bot doesn't run a call its rules would
   * check until one is saved.
   */
  unreadable?: true;
}

export type BotRuleChange =
  /** Built-in, non-locked rules only. */
  | { type: "set_behavior"; ruleId: string; behavior: BotRuleBehavior }
  | { type: "add_custom"; text: string; behavior: BotRuleBehavior }
  | { type: "edit_custom"; ruleId: string; text?: string; behavior?: BotRuleBehavior }
  | { type: "remove_custom"; ruleId: string };

export type BotRuleRefusal = "stale" | "locked" | "invalid" | "limit" | "not_found";

/** A refused edit is a result, with the current view, never a throw. */
export type BotRulesUpdateResult =
  | { ok: true; view: BotRulesView }
  | { ok: false; reason: BotRuleRefusal; view: BotRulesView };

export interface BotRulesUpdateInput {
  botId: string;
  /** The view's revision the edit was made against. */
  revision: number;
  change: BotRuleChange;
}

export const BOT_RULE_CHANNELS = {
  get: "bots:rules:get", // invoke(botId) → BotRulesView
  update: "bots:rules:update", // invoke(BotRulesUpdateInput) → BotRulesUpdateResult
} as const;

/** The rules every Bot has before its first edit. */
export function defaultBotRules(): BotRule[] {
  return [...BOT_LOCKED_RULES, ...BOT_DEFAULT_RULES].map((entry) => ({ ...entry }));
}

export function defaultBotRulesView(botId: string): BotRulesView {
  return { botId, revision: 0, rules: defaultBotRules() };
}

/** What the editor says when an edit is refused. */
export function botRuleRefusalText(reason: BotRuleRefusal): string {
  switch (reason) {
    case "stale":
      return "These rules changed somewhere else. Here they are now; try again.";
    case "locked":
      return "That rule is always on and can’t be changed.";
    case "limit":
      return `A Bot can have up to ${BOT_CUSTOM_RULES_MAX} rules of your own. Delete one first.`;
    case "not_found":
      return "That rule was already removed.";
    case "invalid":
      return `Describe the action in a few words, like “book a flight”, in up to ${BOT_RULE_TEXT_MAX_CHARS} characters.`;
  }
}
