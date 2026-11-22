import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import type { GoalView } from "../shared/goal";
import { GoalBar, optimisticGoal, type GoalBarAction } from "./goal-bar";

const active: GoalView = {
  id: "goal-1",
  chatId: "chat-1",
  objective: "Make the test suite pass",
  status: "active",
  rounds: 3,
  maxRounds: 50,
  stalls: 0,
  source: "slash",
  setAt: 1,
  updatedAt: 2,
  revision: 5,
};

function render(goal: GoalView, pending?: GoalBarAction) {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(<GoalBar goal={goal} pending={pending} onAction={() => {}} />);
  const group = document.querySelector("[role=group]");
  assert.ok(group, "the bar is one named group");
  const buttons = [...document.querySelectorAll("button")];
  return {
    group,
    text: group.textContent ?? "",
    actions: buttons.map((button) => button.textContent),
    buttons,
  };
}

test("an active goal says which round it is on and offers Pause and Clear", () => {
  const bar = render(active);
  assert.equal(bar.group.getAttribute("aria-label"), "Goal: Make the test suite pass");
  assert.match(bar.text, /Working · round 3 of 50/u);
  assert.match(bar.text, /Make the test suite pass/u);
  assert.deepEqual(bar.actions, ["Pause", "Clear"]);
});

test("the person's pause offers Resume; a pause the loop chose offers Keep going and says why", () => {
  const paused = render({ ...active, status: "paused", cause: "person", reason: "Paused" });
  assert.match(paused.text, /^Paused/u);
  assert.deepEqual(paused.actions, ["Resume", "Clear"]);

  const limit = render({ ...active, status: "paused", rounds: 50, cause: "round-limit", reason: "Reached the limit of 50 rounds" });
  assert.match(limit.text, /Reached the limit of 50 rounds/u);
  assert.deepEqual(limit.actions, ["Keep going", "Clear"]);
});

test("Needs you shows the reviewer's reason with Keep going; Done can only be cleared", () => {
  const needsYou = render({ ...active, status: "needs-you", cause: "blocked", reason: "Needs an API key for the staging server" });
  assert.match(needsYou.text, /Needs you/u);
  assert.match(needsYou.text, /Needs an API key for the staging server/u);
  assert.deepEqual(needsYou.actions, ["Keep going", "Clear"]);

  const done = render({ ...active, status: "done", cause: "done", reason: "All 214 tests pass" });
  assert.match(done.text, /Done/u);
  assert.match(done.text, /All 214 tests pass/u);
  assert.deepEqual(done.actions, ["Clear"]);
});

test("every action is a real, keyboard-reachable button, and a pending one waits", () => {
  for (const goal of [active, { ...active, status: "needs-you" as const, reason: "Blocked" }]) {
    for (const button of render(goal).buttons) {
      assert.equal(button.getAttribute("type"), "button");
      assert.equal(button.hasAttribute("tabindex"), false, "no button is taken out of the tab order");
      assert.equal(button.hasAttribute("disabled"), false);
    }
  }
  const pending = render(active, "pause");
  assert.equal(pending.buttons.find((button) => button.textContent === "Pause")?.hasAttribute("disabled"), true);
  assert.equal(pending.buttons.find((button) => button.textContent === "Clear")?.hasAttribute("disabled"), false);
});

test("a tap shows its result at once: pause, Keep going from round 1, and clear", () => {
  const paused = optimisticGoal(active, "pause", 10);
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.cause, "person");

  const stalled = { ...active, status: "paused" as const, rounds: 17, stalls: 3, cause: "stalled" as const, reason: "Not making progress" };
  const resumed = optimisticGoal(stalled, "keep-going", 10);
  assert.equal(resumed?.status, "active");
  assert.equal(resumed?.rounds, 1);
  assert.equal(resumed?.stalls, 0);
  assert.equal(resumed?.reason, undefined);
  assert.equal(resumed?.cause, undefined);

  assert.equal(optimisticGoal(active, "clear", 10), null);
  assert.equal(optimisticGoal(stalled, "pause", 10), stalled, "pausing a goal that isn't running changes nothing");
});

test("after a round off screen needed the window, Needs you and Aiden's pause offer Continue here; the person's pause and a working goal don't", () => {
  const needsYou = render({ ...active, status: "needs-you", cause: "blocked", reason: "It needs the browser", windowWanted: true });
  assert.match(needsYou.text, /Needs you/u);
  assert.match(needsYou.text, /Open this chat to let Aiden use the browser or Computer Use/u);
  assert.deepEqual(needsYou.actions, ["Continue here", "Clear"]);

  const stalled = render({ ...active, status: "paused", cause: "stalled", reason: "Not making progress", windowWanted: true });
  assert.deepEqual(stalled.actions, ["Continue here", "Clear"]);

  assert.deepEqual(render({ ...active, status: "paused", cause: "person", windowWanted: true }).actions, ["Resume", "Clear"]);
  assert.deepEqual(render({ ...active, windowWanted: true }).actions, ["Pause", "Clear"]);
  // Continue here starts the next round as Keep going does.
  assert.equal(optimisticGoal({ ...active, status: "needs-you", windowWanted: true }, "continue-here", 9)?.status, "active");
});
