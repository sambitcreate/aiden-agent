import assert from "node:assert/strict";
import test from "node:test";
import type { GoalView } from "../shared/goal";
import { goalSettleNotification, windowShowsChat } from "./goal-notification";

const active: GoalView = {
  id: "goal-1",
  chatId: "chat-1",
  objective: "Make the test suite pass",
  status: "active",
  rounds: 4,
  maxRounds: 50,
  stalls: 0,
  source: "slash",
  setAt: 1,
  updatedAt: 2,
  revision: 5,
};

test("a goal that settles on its own is announced once, with its reason", () => {
  assert.deepEqual(goalSettleNotification(active, { ...active, status: "done", cause: "done", reason: "All 214 tests pass" }), {
    title: "Goal done",
    body: "All 214 tests pass",
  });
  assert.deepEqual(goalSettleNotification(active, { ...active, status: "needs-you", cause: "blocked", reason: "Needs an API key" }), {
    title: "Goal needs you",
    body: "Needs an API key",
  });
  assert.equal(goalSettleNotification(active, { ...active, status: "paused", cause: "stalled", reason: "Not making progress" })?.title, "Goal paused");
  const done = { ...active, status: "done" as const, reason: "Done" };
  assert.equal(goalSettleNotification(active, done)?.body, "Make the test suite pass", "a bare status word falls back to the objective");
  assert.equal(goalSettleNotification(done, done), undefined, "the same settled goal again says nothing");
});

test("the person's own pause or clear, a new round, an unknown earlier state and a replaced goal say nothing", () => {
  assert.equal(goalSettleNotification(active, { ...active, status: "paused", cause: "person", reason: "Paused" }), undefined);
  assert.equal(goalSettleNotification(active, null), undefined);
  assert.equal(goalSettleNotification(active, { ...active, rounds: 5 }), undefined);
  assert.equal(goalSettleNotification(undefined, { ...active, status: "done" }), undefined);
  assert.equal(goalSettleNotification(active, { ...active, id: "goal-2", status: "done" }), undefined);
});

test("a long reason is cut to one short line", () => {
  const body = goalSettleNotification(active, { ...active, status: "needs-you", reason: `Blocked:\n${"x".repeat(300)}` })?.body ?? "";
  assert.equal([...body].length, 120);
  assert.ok(body.endsWith("…"));
  assert.doesNotMatch(body, /\n/u);
});

test("only a focused window on that chat counts as showing it", () => {
  assert.equal(windowShowsChat({ focused: true, pathname: "/chat/chat-1" }, "chat-1"), true);
  assert.equal(windowShowsChat({ focused: false, pathname: "/chat/chat-1" }, "chat-1"), false);
  assert.equal(windowShowsChat({ focused: true, pathname: "/chat/chat-2" }, "chat-1"), false);
  assert.equal(windowShowsChat({ focused: true, pathname: "/settings" }, "chat-1"), false);
});
