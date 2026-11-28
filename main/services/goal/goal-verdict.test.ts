import assert from "node:assert/strict";
import test from "node:test";

import { parseGoalVerdict } from "./goal-verdict.js";

const open = { allowWait: false };

test("a fenced JSON verdict parses, with prose around it", () => {
  assert.deepEqual(
    parseGoalVerdict(
      'Looking at the output:\n```json\n{"verdict": "continue", "reason": "Two tests still fail."}\n```\nThat is all.',
      open,
    ),
    { verdict: "continue", reason: "Two tests still fail." },
  );
  assert.deepEqual(
    parseGoalVerdict('```\n{"verdict":"DONE","reason":"all 41 tests pass"}\n```', open),
    {
      verdict: "done",
      reason: "all 41 tests pass",
    },
  );
});

test("a bare JSON object parses and its reason is tidied", () => {
  assert.deepEqual(
    parseGoalVerdict('{"verdict": "blocked", "reason": "  needs\\n the   API key "}', open),
    {
      verdict: "blocked",
      reason: "needs the API key",
    },
  );
  const long = parseGoalVerdict(
    JSON.stringify({ verdict: "continue", reason: "x".repeat(500) }),
    open,
  );
  assert.equal([...long!.reason].length, 300);
});

test("anything else is no verdict", () => {
  for (const answer of [
    "The goal is done.",
    '{"verdict": "finished", "reason": "ok"}',
    '{"verdict": "done"}',
    '{"verdict": "done", "reason": "   "}',
    '["done", "ok"]',
    "```json\n{not json}\n```",
    "",
  ]) {
    assert.equal(parseGoalVerdict(answer, open), undefined, answer);
  }
});

test("wait is refused with nothing running in the background", () => {
  const answer = '{"verdict": "wait", "reason": "the build is still running"}';
  assert.equal(parseGoalVerdict(answer, { allowWait: false }), undefined);
  assert.deepEqual(parseGoalVerdict(answer, { allowWait: true }), {
    verdict: "wait",
    reason: "the build is still running",
  });
});
