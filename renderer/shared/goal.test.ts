import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_CHECK_MAX_ROUNDS, GOAL_MAX_ROUNDS, goalRoundBucket, goalRoundLabel, goalView, parseGoalCommand, parseGoalRecords, parseGoalView, validateGoalCheck, type GoalRecordV1 } from "./goal.js";

test("/goal commands", () => {
  assert.deepEqual(parseGoalCommand("/goal"), { kind: "show" });
  assert.deepEqual(parseGoalCommand("  /goal   "), { kind: "show" });
  assert.deepEqual(parseGoalCommand("/goal pause"), { kind: "pause" });
  assert.deepEqual(parseGoalCommand("/goal Resume"), { kind: "resume" });
  assert.deepEqual(parseGoalCommand("/goal clear"), { kind: "clear" });
  assert.deepEqual(parseGoalCommand("/goal  make CI green\nand ship it "), { kind: "set", objective: "make CI green\nand ship it" });
  assert.deepEqual(parseGoalCommand("/goal pause the music in the demo"), { kind: "set", objective: "pause the music in the demo" });
  assert.equal(parseGoalCommand("/goals"), undefined);
  assert.equal(parseGoalCommand("please /goal x"), undefined);
  assert.deepEqual(parseGoalCommand(`/goal ${"é".repeat(2_000)}`), { kind: "set", objective: "é".repeat(2_000) });
  assert.deepEqual(parseGoalCommand(`/goal ${"é".repeat(2_001)}`), { kind: "invalid", message: "A goal can be up to 2,000 characters." });
});

test("check commands are one line within the limit", () => {
  assert.deepEqual(validateGoalCheck("  npm test "), { command: "npm test" });
  assert.equal(validateGoalCheck("npm test\nrm -rf /"), undefined);
  assert.equal(validateGoalCheck(" "), undefined);
  assert.equal(validateGoalCheck("x".repeat(1_001)), undefined);
});

test("round labels", () => {
  assert.equal(goalRoundLabel({ rounds: 3, maxRounds: 50 }), "round 3 of 50");
  assert.equal(goalRoundLabel({ rounds: 1, maxRounds: 5, check: { command: "make" } }), "check 1 of 5");
});

const saved: GoalRecordV1 = {
  version: 1,
  id: "goal-1",
  chatId: "chat-1",
  objective: "Ship it",
  status: "active",
  rounds: 3,
  maxRounds: 50,
  stalls: 1,
  source: "slash",
  setAt: 10,
  updatedAt: 20,
  revision: 4,
  boot: "boot-a",
  unusableReviews: 1,
  lastContinueReason: "Write the docs",
  waitingSince: 15,
};

test("saved goals survive a JSON round trip, and malformed ones are dropped", () => {
  const restored = parseGoalRecords(JSON.parse(JSON.stringify([saved, { ...saved, id: 7 }, { ...saved, version: 2 }, { ...saved, status: "running" }, null])));
  assert.deepEqual(restored, [saved]);
  assert.deepEqual(parseGoalRecords({ goals: [saved] }), []);
});

test("the renderer's view of a goal leaves out the loop's bookkeeping", () => {
  const view = goalView(saved);
  assert.equal("boot" in view, false);
  assert.equal("lastContinueReason" in view, false);
  assert.equal("waitingSince" in view, false);
  assert.deepEqual(parseGoalView(JSON.parse(JSON.stringify(view))), view);
  assert.equal(parseGoalView({ ...view, rounds: -1 }), null);
  assert.equal(parseGoalView(undefined), null);
});

test("settled rounds are bucketed up to the 50-round limit", () => {
  assert.deepEqual([1, 2, 5, 6, 10, 11, 20, 21, 49, 50].map(goalRoundBucket), ["1", "2-5", "2-5", "6-10", "6-10", "11-20", "11-20", "21-49", "21-49", "50"]);
});

test("a saved goal is held to the limits a new one gets, and a chat keeps one goal", () => {
  const read = (entry: Record<string, unknown>) => parseGoalRecords(JSON.parse(JSON.stringify([{ ...saved, ...entry }])))[0];
  assert.equal(read({ maxRounds: 1_000_000_000 })?.maxRounds, GOAL_MAX_ROUNDS, "a reviewed goal runs at most 50 rounds");
  assert.equal(read({ maxRounds: 0 })?.maxRounds, 1, "a goal runs at least one round");
  assert.equal(read({ maxRounds: 40, check: { command: "npm test" } })?.maxRounds, GOAL_CHECK_MAX_ROUNDS, "a command goal runs at most its checks");
  assert.equal(read({ cause: "stalled", status: "paused" })?.cause, "stalled");
  assert.equal(read({ cause: "gremlins", status: "paused" }), undefined, "an unknown cause drops the goal");
  assert.equal(read({ check: { command: "npm test\nrm -rf ~" } }), undefined, "a check with a newline never reaches a prompt");
  assert.equal(read({ check: { command: "  npm test  " } })?.check?.command, "npm test");

  const older = { ...saved, id: "goal-old", updatedAt: 5 };
  const newer = { ...saved, id: "goal-new", updatedAt: 30 };
  const other = { ...saved, id: "goal-other", chatId: "chat-2" };
  const restored = parseGoalRecords(JSON.parse(JSON.stringify([newer, older, other])));
  assert.deepEqual(restored.map((goal) => [goal.chatId, goal.id]), [["chat-1", "goal-new"], ["chat-2", "goal-other"]]);
});
