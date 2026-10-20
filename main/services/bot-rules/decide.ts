// What a Bot's rules make of one classified call (plan §6.3):
//
//   ruled = max(baseline, strictest matching rule)   allowed < ask < hand_off
//
// Rules only tighten. The baseline is today's approval decision, untouched,
// and no rule can lower it. The locked rules always come from code here, so a
// caller that dropped or weakened them still hands credentials and money off.

import {
  BOT_LOCKED_RULES,
  BOT_RULED_RANK,
  type BotBaseline,
  type BotRule,
  type BotRuled,
} from "../../../renderer/shared/bot-rules.js";
import type { BotActionClassification } from "./classify.js";

/** Today's decision for a call: it asks when it already has an approval. */
export function botBaselineOf(approval: unknown): BotBaseline {
  return approval === undefined || approval === null ? "allowed" : "ask";
}

/** Ties between equally strict rules go to the locked rule, then built-in, then custom. */
function tierOf(rule: BotRule): number {
  if (rule.locked) return 0;
  return rule.actionClass === undefined ? 2 : 1;
}

function matches(rule: BotRule, classification: BotActionClassification): boolean {
  if (rule.actionClass !== undefined) return classification.classes.has(rule.actionClass);
  return classification.customRuleIds.has(rule.id);
}

/**
 * The call's outcome and the rule that decided it. `rule` is the strictest
 * matching rule, set whenever any rule matched, so an existing approval that a
 * rule also covers still names that rule.
 */
export function decideBotRule(
  baseline: BotBaseline,
  rules: readonly BotRule[],
  classification: BotActionClassification,
): { ruled: BotRuled; rule?: BotRule } {
  const effective = [...BOT_LOCKED_RULES, ...rules.filter((rule) => !rule.locked)];
  let strictest: BotRule | undefined;
  for (const rule of effective) {
    if (!matches(rule, classification)) continue;
    if (
      strictest === undefined ||
      BOT_RULED_RANK[rule.behavior] > BOT_RULED_RANK[strictest.behavior] ||
      (BOT_RULED_RANK[rule.behavior] === BOT_RULED_RANK[strictest.behavior] && tierOf(rule) < tierOf(strictest))
    ) {
      strictest = rule;
    }
  }
  if (strictest === undefined) return { ruled: baseline };
  const ruled = BOT_RULED_RANK[strictest.behavior] > BOT_RULED_RANK[baseline] ? strictest.behavior : baseline;
  return { ruled, rule: strictest };
}
