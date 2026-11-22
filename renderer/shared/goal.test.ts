import assert from "node:assert/strict";
import test from "node:test";

import { goalRoundLabel, parseGoalCommand, validateGoalCheck } from "./goal.js";

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
