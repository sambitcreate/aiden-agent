import assert from "node:assert/strict";
import test from "node:test";

import { goalView, type GoalRecordV1 } from "../../../renderer/shared/goal.js";
import { ASSISTANT_WORKSPACE_ID } from "../../../renderer/shared/assistant.js";
import { GOAL_WINDOW_WANTED_DETAIL, goalBarView } from "../../../renderer/lib/goal-bar-view.js";
import {
  applyGoalCheck,
  applyGoalVerdict,
  compareAndSetGoal,
  createGoal,
  goalAfterSettle,
  goalChatRefusal,
  goalPromptUnanswered,
  goalWaitExpired,
  goalWindowWanted,
  pauseGoal,
  restoreGoal,
  resumeGoal,
  type GoalRoundActivity,
} from "./goal-core.js";
import type { GoalVerdict } from "./goal-verdict.js";

const BOOT = "boot-1";
const MINUTE = 60_000;
const busy: GoalRoundActivity = { toolCalls: 3, newTextChars: 80 };
const quiet: GoalRoundActivity = { toolCalls: 0, newTextChars: 40 };
const settle = { boot: BOOT, stopped: false, lastRunFailed: false, helperRunning: false };

function goal(overrides: { check?: { command: string } } = {}): GoalRecordV1 {
  const created = createGoal({ id: "goal-1", chatId: "chat-1", objective: "Make the tests pass", source: "slash", boot: BOOT, now: 0, ...overrides });
  assert.ok(created.ok);
  return created.goal;
}

const verdict = (kind: GoalVerdict["verdict"], reason = `reason for ${kind}`): GoalVerdict => ({ verdict: kind, reason });

/** Drives a goal through review rounds, each with a verdict and what the round did. */
function run(start: GoalRecordV1, steps: Array<[GoalVerdict | undefined, GoalRoundActivity]>) {
  let current = start;
  const nexts: string[] = [];
  steps.forEach(([answer, activity], index) => {
    const step = applyGoalVerdict(current, answer, activity, (index + 1) * MINUTE);
    current = step.goal;
    nexts.push(step.next);
  });
  return { goal: current, nexts };
}

test("a new goal starts active at round 1 of 50; a command goal gets 5 checks", () => {
  const reviewed = goal();
  assert.equal(reviewed.status, "active");
  assert.equal(reviewed.rounds, 1);
  assert.equal(reviewed.maxRounds, 50);
  const command = goal({ check: { command: "npm test" } });
  assert.equal(command.maxRounds, 5);
  assert.deepEqual(command.check, { command: "npm test" });
  assert.deepEqual(
    createGoal({ id: "g", chatId: "c", objective: "x".repeat(2_001), source: "menu", boot: BOOT, now: 0 }),
    { ok: false, message: "A goal can be up to 2,000 characters." },
  );
});

test("verdict scenarios", () => {
  const cases: Array<{
    name: string;
    steps: Array<[GoalVerdict | undefined, GoalRoundActivity]>;
    status: GoalRecordV1["status"];
    cause?: GoalRecordV1["cause"];
    rounds: number;
    nexts: string[];
  }> = [
    { name: "done settles Done", steps: [[verdict("done"), busy]], status: "done", cause: "done", rounds: 1, nexts: ["settled"] },
    { name: "blocked needs the person", steps: [[verdict("blocked"), busy]], status: "needs-you", cause: "blocked", rounds: 1, nexts: ["settled"] },
    { name: "paused when the person asked", steps: [[verdict("paused"), busy]], status: "paused", cause: "asked", rounds: 1, nexts: ["settled"] },
    {
      name: "continue with progress starts the next round",
      steps: [[verdict("continue", "tests still fail"), busy], [verdict("continue", "one test left"), busy]],
      status: "active",
      rounds: 3,
      nexts: ["round", "round"],
    },
    {
      name: "the same reason three times pauses as stalled",
      steps: [
        [verdict("continue", "Tests still fail."), busy],
        [verdict("continue", "tests still fail"), busy],
        [verdict("continue", "Tests  still fail"), busy],
        [verdict("continue", "tests still fail!"), busy],
      ],
      status: "paused",
      cause: "stalled",
      rounds: 4,
      nexts: ["round", "round", "round", "settled"],
    },
    {
      name: "three rounds with no tool calls and little text pause",
      steps: [[verdict("continue", "a"), quiet], [verdict("continue", "b"), quiet], [verdict("continue", "c"), quiet]],
      status: "paused",
      cause: "stalled",
      rounds: 3,
      nexts: ["round", "round", "settled"],
    },
    {
      name: "substantial new text without tool calls is progress",
      steps: [1, 2, 3, 4].map((n) => [verdict("continue", `section ${n} still missing`), { toolCalls: 0, newTextChars: 2_400 }]),
      status: "active",
      rounds: 5,
      nexts: ["round", "round", "round", "round"],
    },
    {
      name: "progress between stalls resets the count",
      steps: [[verdict("continue", "a"), quiet], [verdict("continue", "b"), quiet], [verdict("continue", "c"), busy], [verdict("continue", "d"), quiet], [verdict("continue", "e"), quiet]],
      status: "active",
      rounds: 6,
      nexts: ["round", "round", "round", "round", "round"],
    },
    {
      name: "one unusable answer retries, two pause",
      steps: [[undefined, busy], [undefined, busy]],
      status: "paused",
      cause: "reviewer",
      rounds: 1,
      nexts: ["retry-review", "settled"],
    },
    {
      name: "a usable answer clears the unusable count",
      steps: [[undefined, busy], [verdict("continue", "x"), busy], [undefined, busy]],
      status: "active",
      rounds: 2,
      nexts: ["retry-review", "round", "retry-review"],
    },
    {
      name: "wait stays active without a new round",
      steps: [[verdict("wait", "build still running"), busy]],
      status: "active",
      rounds: 1,
      nexts: ["wait"],
    },
  ];
  for (const scenario of cases) {
    const result = run(goal(), scenario.steps);
    assert.equal(result.goal.status, scenario.status, scenario.name);
    assert.equal(result.goal.cause, scenario.cause, scenario.name);
    assert.equal(result.goal.rounds, scenario.rounds, scenario.name);
    assert.deepEqual(result.nexts, scenario.nexts, scenario.name);
  }
});

test("the reviewer's reason is shown, and a pause names its cause", () => {
  assert.equal(run(goal(), [[verdict("continue", "two tests fail"), busy]]).goal.reason, "two tests fail");
  assert.equal(run(goal(), [[verdict("blocked", "needs an API key"), busy]]).goal.reason, "needs an API key");
  const stalled = run(goal(), [[verdict("continue", "a"), quiet], [verdict("continue", "b"), quiet], [verdict("continue", "c"), quiet]]);
  assert.equal(stalled.goal.reason, "Not making progress");
});

test("round 50 pauses at the limit; Keep going starts again at round 1 of 50 with no stalls", () => {
  let current = goal();
  const steps = Array.from({ length: 50 }, (_, index) => [verdict("continue", `step ${index}`), busy] as [GoalVerdict, GoalRoundActivity]);
  steps[48] = [verdict("continue", "step 48"), quiet];
  const result = run(current, steps);
  current = result.goal;
  assert.equal(result.nexts.filter((next) => next === "round").length, 49);
  assert.equal(current.status, "paused");
  assert.equal(current.cause, "round-limit");
  assert.equal(current.reason, "Reached the limit of 50 rounds");
  assert.equal(current.rounds, 50);

  const resumed = resumeGoal(current, { now: 100 * MINUTE, boot: "boot-2" });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.rounds, 1);
  assert.equal(resumed.maxRounds, 50);
  assert.equal(resumed.stalls, 0);
  assert.equal(resumed.boot, "boot-2");
  assert.equal(resumed.reason, undefined);
  assert.equal(resumed.revision, current.revision + 1);
  // The old stall reason is forgotten, so repeating it is not a stall.
  assert.equal(run(resumed, [[verdict("continue", "step 49"), busy]]).goal.stalls, 0);
});

test("a done verdict on the last round still wins over the limit", () => {
  let current = goal();
  for (let index = 0; index < 49; index += 1) current = applyGoalVerdict(current, verdict("continue", `s${index}`), busy, index).goal;
  assert.equal(current.rounds, 50);
  assert.equal(applyGoalVerdict(current, verdict("done", "all green"), busy, 99).goal.status, "done");
});

test("pre-checks before a review", () => {
  const active = goal();
  assert.deepEqual(goalAfterSettle(active, { ...settle, now: 1 }), { kind: "review" });
  const pausedBy = (input: Partial<typeof settle>) => {
    const step = goalAfterSettle(active, { ...settle, ...input, now: 1 });
    assert.equal(step.kind, "paused");
    return step.kind === "paused" ? step.goal.cause : undefined;
  };
  assert.equal(pausedBy({ boot: "boot-2" }), "restart");
  assert.equal(pausedBy({ stopped: true }), "stopped");
  assert.equal(pausedBy({ lastRunFailed: true }), "failed");
  assert.deepEqual(goalAfterSettle(goal({ check: { command: "make" } }), { ...settle, now: 1 }), { kind: "check", command: "make" });
  const done = run(active, [[verdict("done"), busy]]).goal;
  assert.deepEqual(goalAfterSettle(done, { ...settle, now: 1 }), { kind: "idle" });
});

test("a running helper skips reviews for up to 30 minutes, then pauses", () => {
  const first = goalAfterSettle(goal(), { ...settle, helperRunning: true, now: 0 });
  assert.equal(first.kind, "skip");
  const waiting = first.kind === "skip" ? first.goal : goal();
  assert.equal(waiting.waitingSince, 0);
  assert.equal(goalAfterSettle(waiting, { ...settle, helperRunning: true, now: 29 * MINUTE }).kind, "skip");
  const late = goalAfterSettle(waiting, { ...settle, helperRunning: true, now: 30 * MINUTE });
  assert.equal(late.kind === "paused" && late.goal.cause, "wait-limit");
  assert.equal(goalWaitExpired(waiting, 10 * MINUTE), undefined);
  assert.equal(goalWaitExpired(waiting, 31 * MINUTE)?.cause, "wait-limit");
  // A review after the helper finished clears the wait.
  const reviewed = applyGoalVerdict(waiting, verdict("continue", "next"), busy, 5 * MINUTE).goal;
  assert.equal(reviewed.waitingSince, undefined);
});

test("wait verdicts keep their first start, and pause after 30 minutes", () => {
  const first = applyGoalVerdict(goal(), verdict("wait"), busy, 0).goal;
  const second = applyGoalVerdict(first, verdict("wait"), busy, 20 * MINUTE).goal;
  assert.equal(second.waitingSince, 0);
  const third = applyGoalVerdict(second, verdict("wait"), busy, 30 * MINUTE);
  assert.equal(third.goal.cause, "wait-limit");
  assert.equal(third.next, "settled");
});

test("a command goal is done on exit 0 and pauses after 5 checks; Keep going grants 5 more", () => {
  let current = goal({ check: { command: "npm test" } });
  const nexts: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const step = applyGoalCheck(current, { passed: false, summary: "exit 1" }, index);
    current = step.goal;
    nexts.push(step.next);
  }
  assert.deepEqual(nexts, ["round", "round", "round", "round", "settled"]);
  assert.equal(current.reason, "Check still failing after 5 checks");
  current = resumeGoal(current, { now: 10, boot: BOOT });
  assert.equal(current.rounds, 1);
  assert.equal(current.maxRounds, 5);
  const passed = applyGoalCheck(current, { passed: true, summary: "exit 0" }, 11);
  assert.equal(passed.goal.status, "done");
  assert.equal(passed.goal.reason, "exit 0");
});

test("compare-and-set refuses a stale write, so the person's pause wins", () => {
  const active = goal();
  const read = { id: active.id, revision: active.revision };
  const paused = pauseGoal(active, { now: 5, cause: "person" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.reason, "Paused");
  // A review that read the goal before the pause lands afterwards.
  assert.deepEqual(
    compareAndSetGoal(paused, read, (current) => applyGoalVerdict(current, verdict("continue"), busy, 6).goal),
    { ok: false },
  );
  assert.deepEqual(compareAndSetGoal(undefined, read, (current) => current), { ok: false }, "a cleared goal refuses too");
  const replaced = { ...goal(), id: "goal-2" };
  assert.deepEqual(compareAndSetGoal(replaced, read, (current) => current), { ok: false });
  const fresh = compareAndSetGoal(active, read, (current) => applyGoalVerdict(current, verdict("done"), busy, 6).goal);
  assert.ok(fresh.ok);
  assert.equal(fresh.goal.revision, active.revision + 1);
});

test("pausing or resuming in the wrong state changes nothing", () => {
  const active = goal();
  assert.equal(resumeGoal(active, { now: 1, boot: BOOT }), active);
  const done = run(active, [[verdict("done"), busy]]).goal;
  assert.equal(pauseGoal(done, { now: 2, cause: "person" }), done);
  assert.equal(applyGoalVerdict(done, verdict("continue"), busy, 3).goal, done);
});

test("a goal left active by another process comes back paused", () => {
  const active = goal();
  assert.equal(restoreGoal(active, { now: 1, boot: BOOT }), active);
  const restored = restoreGoal(active, { now: 1, boot: "boot-2" });
  assert.equal(restored.status, "paused");
  assert.equal(restored.reason, "Aiden restarted");
  const paused = pauseGoal(active, { now: 1, cause: "person" });
  assert.equal(restoreGoal(paused, { now: 2, boot: "boot-2" }), paused);
});

test("Continue here is offered only while the stop came from a round that wanted the window", () => {
  // A round off screen had the browser refused.
  const wanted = goalWindowWanted(goal(), true, MINUTE);
  const detail = (record: GoalRecordV1) => goalBarView(goalView(record)).detail;

  const blocked = applyGoalVerdict(wanted, verdict("blocked", "I need the browser to sign in"), busy, 2 * MINUTE).goal;
  assert.equal(detail(blocked), GOAL_WINDOW_WANTED_DETAIL, "the reviewer's Needs you after that round offers Continue here");
  const stalled = run(wanted, [[verdict("continue", "same"), quiet], [verdict("continue", "same"), quiet], [verdict("continue", "same"), quiet]]).goal;
  assert.equal(stalled.cause, "stalled");
  assert.equal(stalled.windowWanted, undefined, "the next round started, so the earlier round's want is gone");

  // Anything else that stops the goal says its own reason.
  for (const [label, stopped] of [
    ["your Pause", pauseGoal(wanted, { now: 2 * MINUTE, cause: "person" })],
    ["Stop", (goalAfterSettle(wanted, { ...settle, now: 2 * MINUTE, stopped: true }) as { goal: GoalRecordV1 }).goal],
    ["a failed answer", (goalAfterSettle(wanted, { ...settle, now: 2 * MINUTE, lastRunFailed: true }) as { goal: GoalRecordV1 }).goal],
    ["an unanswered approval", goalPromptUnanswered(wanted, 2 * MINUTE)],
    ["the spending limit", pauseGoal(wanted, { now: 2 * MINUTE, cause: "spending" })],
  ] as const) {
    assert.notEqual(stopped.status, "active", label);
    assert.notEqual(detail(stopped), GOAL_WINDOW_WANTED_DETAIL, label);
    assert.equal(stopped.windowWanted, undefined, label);
  }

  // Keep going starts fresh, so a later Needs you shows the reviewer's own reason.
  const resumed = resumeGoal(blocked, { now: 3 * MINUTE, boot: BOOT });
  assert.equal(resumed.windowWanted, undefined);
  const later = applyGoalVerdict(resumed, verdict("blocked", "The API key is missing"), busy, 4 * MINUTE).goal;
  assert.equal(detail(later), "The API key is missing");
});

test("which chats can have a goal", () => {
  const chat = { workspaceId: "ws-1", providerId: "anthropic", model: "claude" };
  assert.equal(goalChatRefusal(chat), undefined, "an ordinary chat with a model");
  assert.equal(goalChatRefusal({ ...chat, workspaceId: undefined }), undefined, "a chat without a folder");
  assert.match(goalChatRefusal(null) ?? "", /no longer exists/u);
  assert.match(goalChatRefusal({ ...chat, botId: "bot-1" }) ?? "", /Bots/u);
  assert.match(goalChatRefusal({ ...chat, workspaceId: ASSISTANT_WORKSPACE_ID }) ?? "", /Assistant/u);
  assert.match(goalChatRefusal({ ...chat, model: undefined }) ?? "", /Choose a model/u);
  assert.match(goalChatRefusal({ ...chat, owner: { kind: "schedule" } as never }) ?? "", /runs its own way/u);
  assert.match(goalChatRefusal({ ...chat, ephemeral: true }) ?? "", /Save this Temporary chat or attach it/u, "a Temporary Quick Chat");
  assert.equal(goalChatRefusal({ ...chat, workspaceId: undefined, ephemeral: undefined }), undefined, "the same chat once saved");
});
