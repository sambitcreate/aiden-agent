import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { BOT_SUGGESTION_BUDGET, createBotSuggestionBudget } from "./bot-suggestion-budget.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-suggestion-budget-"));
  roots.push(root);
  const clock = { at: Date.UTC(2026, 10, 12, 9) };
  const shown: string[] = [];
  const budget = createBotSuggestionBudget({ profileDir: () => root, now: () => clock.at });
  const offer = (botId: string, label: string, kind: "routine" | "skill" | "lesson" = "routine") =>
    budget.offer(botId, kind, async () => {
      shown.push(label);
      return true;
    });
  return { root, clock, budget, shown, offer };
}

test("a Bot offers at most three suggestions of any kind in a rolling day; the fourth is never shown", async () => {
  const h = harness();
  assert.equal(BOT_SUGGESTION_BUDGET.perWindow, 3);
  assert.equal(await h.offer("bot-a", "routine", "routine"), true);
  h.clock.at += HOUR;
  assert.equal(await h.offer("bot-a", "skill", "skill"), true);
  h.clock.at += HOUR;
  assert.equal(await h.offer("bot-a", "lesson", "lesson"), true);
  h.clock.at += HOUR;
  assert.equal(await h.offer("bot-a", "fourth"), false);
  assert.deepEqual(h.shown, ["routine", "skill", "lesson"], "the fourth card never reaches the chat");
  assert.equal(await h.budget.remaining("bot-a"), 0);
});

test("the window rolls: a slot comes back 24 hours after the suggestion that used it, not at midnight", async () => {
  const h = harness();
  const first = h.clock.at;
  await h.offer("bot-a", "one");
  h.clock.at = first + 2 * HOUR;
  await h.offer("bot-a", "two");
  await h.offer("bot-a", "three");
  h.clock.at = first + 24 * HOUR - 1;
  assert.equal(await h.offer("bot-a", "too soon"), false);
  h.clock.at = first + 24 * HOUR;
  assert.equal(await h.budget.remaining("bot-a"), 1, "only the first one's slot is back");
  assert.equal(await h.offer("bot-a", "four"), true);
  assert.equal(await h.offer("bot-a", "five"), false);
  h.clock.at = first + 26 * HOUR;
  assert.equal(await h.budget.remaining("bot-a"), 2);
  assert.deepEqual(h.shown, ["one", "two", "three", "four"]);
});

test("a suggestion that was not shown costs nothing, and each Bot has its own budget", async () => {
  const h = harness();
  assert.equal(await h.budget.offer("bot-a", "routine", async () => false), false);
  assert.equal(await h.budget.remaining("bot-a"), 3);
  for (const label of ["a1", "a2", "a3"]) await h.offer("bot-a", label);
  assert.equal(await h.offer("bot-b", "b1"), true, "another Bot is unaffected");
  assert.equal(await h.budget.remaining("bot-b"), 2);
});

test("the count survives a restart, and offers made at once never get past the limit", async () => {
  const h = harness();
  await h.offer("bot-a", "before restart");
  const restarted = createBotSuggestionBudget({ profileDir: () => h.root, now: () => h.clock.at });
  assert.equal(await restarted.remaining("bot-a"), 2);
  const results = await Promise.all(
    ["x", "y", "z"].map((label) => restarted.offer("bot-a", "skill", async () => (h.shown.push(label), true))),
  );
  assert.deepEqual(results.filter(Boolean).length, 2);
  assert.equal(h.shown.length, 3, "the one shown before the restart and two more");
});

test("moving the clock back never refills the budget: suggestions stamped in the future stay counted", async () => {
  const h = harness();
  for (const label of ["one", "two", "three"]) assert.equal(await h.offer("bot-a", label), true);
  // The system clock is set back two days.
  h.clock.at -= 48 * HOUR;
  assert.equal(await h.budget.remaining("bot-a"), 0);
  assert.equal(await h.offer("bot-a", "after the change"), false);
  // A day on the new clock is not enough: they were stamped two days ahead of it.
  h.clock.at += 24 * HOUR + 1;
  assert.equal(await h.offer("bot-a", "a day later"), false);
  // Back past the time they were shown, the window rolls as usual.
  h.clock.at += 48 * HOUR;
  assert.equal(await h.offer("bot-a", "once the clock caught up"), true);
  assert.deepEqual(h.shown, ["one", "two", "three", "once the clock caught up"]);
});

test("one the person asked for shows even with the window full, and still counts", async () => {
  const h = harness();
  for (const label of ["one", "two"]) assert.equal(await h.offer("bot-a", label), true);
  const always = (label: string) => h.budget.offer("bot-a", "routine", async () => {
    h.shown.push(label);
    return true;
  }, { always: true });
  assert.equal(await always("asked"), true);
  assert.equal(await h.offer("bot-a", "own idea"), false, "the asked-for one used the last slot");
  assert.equal(await always("asked again"), true);
  assert.deepEqual(h.shown, ["one", "two", "asked", "asked again"]);
});
