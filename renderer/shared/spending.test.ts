import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUsd,
  ordinalDay,
  parseSpendingLimitsSettings,
  parseSpendingStatusView,
  spendingNotice,
  spendingState,
  type SpendingStatusView,
} from "./spending.js";

const chat: SpendingStatusView = {
  ownerKind: "chat",
  ownerId: "chat-1",
  period: "chat",
  limitUsd: 5,
  extraUsd: 0,
  spentUsd: 4.1,
  state: "nearing",
};

test("a setting outside its bounds turns every limit off rather than guessing", () => {
  assert.deepEqual(parseSpendingLimitsSettings({ chatUsd: 5, botMonthUsd: 20.004, monthStartDay: 15 }), {
    chatUsd: 5,
    botMonthUsd: 20,
    monthStartDay: 15,
  });
  assert.deepEqual(parseSpendingLimitsSettings({}), {});
  for (const bad of [{ chatUsd: 0 }, { chatUsd: -1 }, { routineRunUsd: 1e9 }, { monthStartDay: 29 }, { chatUsd: 5, extra: 1 }, null, []]) {
    assert.equal(parseSpendingLimitsSettings(bad), undefined, JSON.stringify(bad));
  }
});

test("a chat is nearing from 80% of what it may spend and reached at it", () => {
  assert.equal(spendingState(3.99, 5), "under");
  assert.equal(spendingState(4, 5), "nearing");
  assert.equal(spendingState(5, 5), "reached");
  assert.equal(spendingState(5.4, 10), "under", "after Allow more the allowance is the limit twice");
});

test("the notice names the chat or Bot, the amounts and the month", () => {
  assert.equal(spendingNotice({ ...chat, state: "under" }), undefined);
  assert.equal(spendingNotice(chat)?.title, "This chat has used $4.10 of its $5.00 limit.");
  const bot = spendingNotice(
    { ...chat, ownerKind: "bot", ownerId: "ada", period: "month", limitUsd: 20, extraUsd: 20, spentUsd: 41.5, state: "reached" },
    "Ada",
  );
  assert.equal(bot?.title, "Ada reached its $40.00 spending limit this month.");
  assert.equal(bot?.body, "It has spent $41.50. Allow $20.00 more to keep going, or change the limit in Settings.");
  assert.equal(bot?.allowMoreLabel, "Allow $20.00 more");
  assert.match(spendingNotice({ ...chat, ownerKind: "bot", period: "month" }, " ")?.title ?? "", /^This Bot /u);
});

test("amounts read as dollars and days as ordinals", () => {
  assert.equal(formatUsd(1250), "$1,250.00");
  assert.equal(formatUsd(0.004), "less than $0.01");
  assert.equal(formatUsd(0), "$0.00");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 28].map(ordinalDay), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "28th"]);
});

test("a status from main is read strictly", () => {
  assert.deepEqual(parseSpendingStatusView(chat), chat);
  assert.equal(parseSpendingStatusView({ ...chat, state: "over" }), null);
  assert.equal(parseSpendingStatusView({ ...chat, limitUsd: 0 }), null);
  assert.equal(parseSpendingStatusView({ ...chat, ownerId: "" }), null);
  assert.equal(parseSpendingStatusView({ ...chat, periodEnd: 1.5 }), null);
});
