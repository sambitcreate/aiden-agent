import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BOT_CHANGEABLE_ACTION_CLASSES,
  BOT_DEFAULT_RULES,
  BOT_LOCKED_RULES,
  type BotBaseline,
  type BotRule,
  type BotRuleBehavior,
  type BotRuled,
} from "../../../renderer/shared/bot-rules.js";
import { classifyBotAction, type BotActionClassification, type BotClassifiableAction } from "./classify.js";
import { botBaselineOf, decideBotRule } from "./decide.js";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/actions.json", import.meta.url), "utf8")) as {
  rows: Array<{ id: string; action: BotClassifiableAction; customRules?: BotRule[] }>;
};

const RANK: Record<BotRuled, number> = { allowed: 0, ask: 1, hand_off: 2 };
const STATES: ReadonlyArray<BotRuleBehavior | "absent"> = ["absent", "ask", "hand_off"];

/** Every combination of the five changeable built-in rules: absent, Ask first or Hand off. */
function* builtInCombinations(): Generator<BotRule[]> {
  const total = STATES.length ** BOT_CHANGEABLE_ACTION_CLASSES.length;
  for (let index = 0; index < total; index += 1) {
    let rest = index;
    const rules: BotRule[] = [];
    for (const actionClass of BOT_CHANGEABLE_ACTION_CLASSES) {
      const state = STATES[rest % STATES.length]!;
      rest = Math.floor(rest / STATES.length);
      if (state !== "absent") rules.push({ id: `default.${actionClass}`, actionClass, behavior: state, locked: false });
    }
    yield rules;
  }
}

function classification(classes: string[], customRuleIds: string[] = []): BotActionClassification {
  return { classes: new Set(classes) as BotActionClassification["classes"], customRuleIds: new Set(customRuleIds), evidence: [] };
}

test("rules only tighten: every baseline, every built-in combination, custom on and off, every corpus row", () => {
  const classified = corpus.rows.map((row) => {
    const customRules = row.customRules ?? [];
    return { id: row.id, customRules, classification: classifyBotAction(row.action, customRules) };
  });
  let checked = 0;
  for (const builtIns of builtInCombinations()) {
    for (const customOn of [false, true]) {
      for (const row of classified) {
        const rules = [...BOT_LOCKED_RULES, ...builtIns, ...(customOn ? row.customRules : [])];
        const matching = rules.filter((rule) =>
          rule.actionClass !== undefined
            ? row.classification.classes.has(rule.actionClass)
            : row.classification.customRuleIds.has(rule.id),
        );
        for (const baseline of ["allowed", "ask"] as const satisfies readonly BotBaseline[]) {
          const { ruled, rule } = decideBotRule(baseline, rules, row.classification);
          checked += 1;
          const where = `${row.id} baseline ${baseline} custom ${customOn}`;
          assert.ok(RANK[ruled] >= RANK[baseline], `${where}: ${ruled} is looser than ${baseline}`);
          if (matching.length === 0) {
            assert.equal(ruled, baseline, where);
            assert.equal(rule, undefined, where);
            continue;
          }
          // The decision names a rule that really matched this call.
          assert.ok(rule !== undefined && matching.some((entry) => entry.id === rule.id), where);
          // Hand off wins over Ask first whenever any matching rule hands off.
          if (matching.some((entry) => entry.behavior === "hand_off")) {
            assert.equal(ruled, "hand_off", where);
            assert.equal(rule!.behavior, "hand_off", where);
          } else {
            assert.equal(ruled, "ask", where);
          }
          if (row.classification.classes.has("credentials") || row.classification.classes.has("money")) {
            assert.equal(ruled, "hand_off", `${where}: a locked class must hand off`);
            assert.equal(rule!.locked, true, `${where}: the locked rule wins the tie`);
          }
        }
      }
    }
  }
  assert.equal(checked, 3 ** 5 * 2 * 2 * corpus.rows.length);
});

test("locked rules hand off even when the caller's list drops or weakens them", () => {
  const card = classification(["money"]);
  assert.equal(decideBotRule("allowed", [], card).ruled, "hand_off");
  const weakened: BotRule[] = [{ id: "locked.money", actionClass: "money", behavior: "ask", locked: true }];
  const decision = decideBotRule("ask", weakened, card);
  assert.equal(decision.ruled, "hand_off");
  assert.equal(decision.rule?.id, "locked.money");
});

test("ties go to the locked rule, then the built-in rule, then the person's own", () => {
  const purchaseAndCustom = classification(["purchase"], ["custom.a"]);
  const rules: BotRule[] = [
    { id: "custom.a", text: "book a table", behavior: "hand_off", locked: false },
    { id: "default.purchase", actionClass: "purchase", behavior: "hand_off", locked: false },
  ];
  assert.equal(decideBotRule("allowed", rules, purchaseAndCustom).rule?.id, "default.purchase");
  const askOnly: BotRule[] = [
    { id: "custom.a", text: "book a table", behavior: "ask", locked: false },
    ...BOT_DEFAULT_RULES,
  ];
  assert.equal(decideBotRule("ask", askOnly, purchaseAndCustom).rule?.id, "default.purchase");
  // A stricter custom rule beats a looser built-in one.
  const stricterCustom: BotRule[] = [{ ...rules[0]! }, ...BOT_DEFAULT_RULES];
  assert.equal(decideBotRule("allowed", stricterCustom, purchaseAndCustom).rule?.id, "custom.a");
});

test("a rule-made ask on an already approved call names the rule", () => {
  const decision = decideBotRule("ask", BOT_DEFAULT_RULES, classification(["communicate"]));
  assert.equal(decision.ruled, "ask");
  assert.equal(decision.rule?.id, "default.communicate");
});

test("the baseline is today's approval decision", () => {
  assert.equal(botBaselineOf(undefined), "allowed");
  assert.equal(botBaselineOf(null), "allowed");
  assert.equal(botBaselineOf({ summary: "Send email" }), "ask");
});
