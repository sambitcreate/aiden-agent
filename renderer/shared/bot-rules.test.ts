import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_ACTION_CLASSES,
  BOT_CUSTOM_RULE_ID_PATTERN,
  botRuleBehaviorLabel,
  botRuleLabel,
  botRuleRefusalText,
  defaultBotRules,
  defaultBotRulesView,
  normalizeBotRuleText,
  type BotRuleRefusal,
} from "./bot-rules.js";

test("every Bot starts with the plan's rule table", () => {
  // Plan §6.1: label, behavior and whether it is locked.
  const expected = [
    ["Enter a password or 2FA code, or change account security", "hand_off", true],
    ["Move money or enter card details", "hand_off", true],
    ["Make a purchase or booking", "ask", false],
    ["Send a message or email to someone", "ask", false],
    ["Post or publish something publicly", "ask", false],
    ["Permanently delete something", "ask", false],
    ["Install software", "ask", false],
  ];
  const rules = defaultBotRules();
  assert.deepEqual(
    rules.map((rule) => [botRuleLabel(rule), rule.behavior, rule.locked]),
    expected,
  );
  // One built-in rule per class, and every class has one.
  assert.deepEqual(rules.map((rule) => rule.actionClass).sort(), [...BOT_ACTION_CLASSES].sort());
  assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
  assert.deepEqual(defaultBotRulesView("bot:1"), { botId: "bot:1", revision: 0, rules });
});

test("the default rules are fresh copies each time", () => {
  const first = defaultBotRules();
  first[2]!.behavior = "hand_off";
  assert.equal(defaultBotRules()[2]!.behavior, "ask");
});

test("custom rules are named in the person's words, tidied", () => {
  assert.equal(botRuleLabel({ text: "  book   a flight..  " }), "Book a flight");
  assert.equal(botRuleLabel({ text: "" }), "Your rule");
  assert.equal(normalizeBotRuleText("order\n\tfood."), "order food");
  assert.equal(normalizeBotRuleText("email the team。"), "email the team");
});

test("behaviors read as the editor's choices", () => {
  assert.equal(botRuleBehaviorLabel("ask"), "Ask first");
  assert.equal(botRuleBehaviorLabel("hand_off"), "Hand off to me");
});

test("custom rule ids are custom. and a UUID", () => {
  assert.ok(BOT_CUSTOM_RULE_ID_PATTERN.test("custom.0b8a3f5e-2c11-4d5f-9b7a-0123456789ab"));
  for (const id of ["custom.1", "default.purchase", "locked.money", "custom.0B8A3F5E-2C11-4D5F-9B7A-0123456789AB"]) {
    assert.equal(BOT_CUSTOM_RULE_ID_PATTERN.test(id), false, id);
  }
});

test("each refusal says something different", () => {
  const reasons: BotRuleRefusal[] = ["stale", "locked", "invalid", "limit", "not_found"];
  const texts = reasons.map(botRuleRefusalText);
  assert.equal(new Set(texts).size, reasons.length);
  assert.ok(botRuleRefusalText("limit").includes("20"));
  assert.ok(botRuleRefusalText("invalid").includes("120"));
});
