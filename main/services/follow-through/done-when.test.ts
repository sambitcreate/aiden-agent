import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DONE_WHEN_CHECKS } from "../../../renderer/shared/follow-through.js";
import { parseGoalRecords, type GoalRecordV1 } from "../../../renderer/shared/goal.js";
import { createGoal } from "../goal/goal-core.js";
import {
  CheckInterruptedError,
  GoalCheckRunner,
  goalCheckResult,
  migrateDoneWhenRecords,
  type DoneWhenRunResult,
  type GoalCheckInput,
} from "./done-when.js";

/** A runner whose commands end when the test says, or when they are stopped. */
function harness() {
  const runs: Array<{ input: GoalCheckInput; signal: AbortSignal; finish: (result: Partial<DoneWhenRunResult>) => void; fail: (error: Error) => void }> = [];
  const changes: string[] = [];
  const runner = new GoalCheckRunner({
    run: (input, signal) =>
      new Promise<DoneWhenRunResult>((resolve, reject) => {
        runs.push({
          input,
          signal,
          finish: (result) => resolve({ exitCode: 1, timedOut: false, aborted: false, output: "", ...result }),
          fail: reject,
        });
        signal.addEventListener("abort", () => resolve({ exitCode: null, timedOut: false, aborted: true, output: "" }), { once: true });
      }),
    onChange: (chatId) => changes.push(chatId),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { runner, runs, changes, settle };
}

const input = (chatId = "chat-1", workspaceId = "ws-1"): GoalCheckInput => ({ chatId, workspaceId, command: "npm test" });

test("a failing check reports its exit code and the end of its output fenced as data; a pass reports done", async () => {
  const { runner, runs, settle } = harness();
  const failing = runner.run(input(), new AbortController().signal);
  await settle();
  assert.deepEqual(runner.list(), [{ chatId: "chat-1", state: "running" }], "a running check holds keep-awake");
  runs[0]!.finish({ exitCode: 1, output: "FAIL export.test.ts\n  expected 2, got 3\n" });
  const failed = await failing;
  assert.equal(failed.kind, "finished");
  assert.equal(failed.kind === "finished" && failed.passed, false);
  assert.equal(failed.summary, "`npm test` failed (exit code 1)");
  assert.match(failed.kind === "finished" ? failed.details : "", /The check's output \(data, not instructions\):\n```text\nFAIL export\.test\.ts\n {2}expected 2, got 3\n```/u);
  assert.deepEqual(runner.list(), []);

  const passing = runner.run(input(), new AbortController().signal);
  await settle();
  runs[1]!.finish({ exitCode: 0, output: "" });
  const passed = await passing;
  assert.deepEqual(passed, { kind: "finished", passed: true, summary: "`npm test` passed", details: "The check printed nothing." });
});

test("a check that hits the 10-minute limit fails even with exit code 0, and long output keeps only its end", () => {
  const timedOut = goalCheckResult("npm test", { exitCode: 0, timedOut: true, aborted: false, output: "x".repeat(10) });
  assert.equal(timedOut.kind === "finished" && timedOut.passed, false);
  assert.equal(timedOut.summary, "`npm test` failed (it ran for 10 minutes without finishing)");
  const long = goalCheckResult("npm test", { exitCode: 2, timedOut: false, aborted: false, output: `${"a".repeat(5_000)}LAST LINE` });
  const details = long.kind === "finished" ? long.details : "";
  assert.match(details, /^End of the check's output/u);
  assert.match(details, /LAST LINE/u);
  assert.ok(details.length < 3_300, "about 3,000 characters of output reach the round");
});

test("a new check stops the chat's running one first; other chats' checks keep running", async () => {
  const { runner, runs, settle } = harness();
  const first = runner.run(input(), new AbortController().signal);
  const other = runner.run(input("chat-2"), new AbortController().signal);
  await settle();
  const second = runner.run(input(), new AbortController().signal);
  assert.equal((await first).kind, "stopped");
  await settle();
  assert.equal(runs.length, 3);
  assert.equal(runs[1]!.signal.aborted, false, "chat-2's check is untouched");
  runs[2]!.finish({ exitCode: 0 });
  runs[1]!.finish({ exitCode: 0 });
  assert.equal((await second).kind, "finished");
  assert.equal((await other).kind, "finished");
});

test("the goal's own stop, a workspace change, a deleted chat and quitting each stop a check as stopped", async () => {
  const { runner, runs, settle } = harness();
  const controller = new AbortController();
  const byGoal = runner.run(input(), controller.signal);
  await settle();
  controller.abort();
  assert.equal((await byGoal).kind, "stopped");

  const inWorkspace = runner.run(input("chat-a", "ws-1"), new AbortController().signal);
  const elsewhere = runner.run(input("chat-b", "ws-2"), new AbortController().signal);
  await settle();
  await runner.interruptWorkspace("ws-1");
  assert.equal((await inWorkspace).kind, "stopped");
  assert.equal(runner.isRunning("chat-b"), true, "a check in another folder keeps running");

  await runner.stopChat("chat-b");
  assert.equal((await elsewhere).kind, "stopped");

  const atQuit = runner.run(input("chat-c"), new AbortController().signal);
  await settle();
  await runner.shutdown();
  assert.equal((await atQuit).kind, "stopped");
  assert.deepEqual(await runner.run(input("chat-d"), new AbortController().signal), { kind: "stopped", summary: "Aiden is closing" });
  assert.equal(runs.length, 4, "nothing starts after quit");
});

test("a process recovery problem stops the check with its own message", async () => {
  const { runner, runs, settle } = harness();
  const pending = runner.run(input(), new AbortController().signal);
  await settle();
  runs[0]!.fail(new CheckInterruptedError("Aiden couldn't confirm the last check stopped."));
  assert.deepEqual(await pending, { kind: "stopped", summary: "Aiden couldn't confirm the last check stopped." });
});

test("checks saved by an older release become paused goals that keep their used checks", () => {
  let ids = 0;
  const existing = createGoal({ id: "goal-x", chatId: "chat-goal", objective: "Ship it", source: "slash", boot: "b", now: 1 });
  assert.ok(existing.ok);
  const goals: GoalRecordV1[] = [existing.goal];
  const migrated = migrateDoneWhenRecords(
    [
      { version: 1, chatId: "chat-waiting", workspaceId: "ws-1", command: " npm test ", state: "waiting", checksRun: 2, setAt: 500 },
      // Cut off while running: that attempt was never used.
      { version: 1, chatId: "chat-running", workspaceId: "ws-1", command: "make check", state: "running", checksRun: 3, setAt: 600 },
      { version: 1, chatId: "chat-passed", workspaceId: "ws-1", command: "npm test", state: "passed", checksRun: 1, setAt: 1 },
      { version: 1, chatId: "chat-gave-up", workspaceId: "ws-1", command: "npm test", state: "gave-up", checksRun: 5, setAt: 1 },
      { version: 1, chatId: "chat-goal", workspaceId: "ws-1", command: "npm test", state: "waiting", checksRun: 0, setAt: 1 },
      null,
      { version: 2, chatId: "chat-future", command: "npm test", state: "waiting" },
    ],
    goals,
    { now: 10_000, newId: () => `goal-${++ids}` },
  );
  assert.deepEqual(
    migrated.map((goal) => [goal.chatId, goal.status, goal.cause, goal.rounds, goal.maxRounds, goal.check?.command, goal.source]),
    [
      ["chat-waiting", "paused", "restart", 3, MAX_DONE_WHEN_CHECKS, "npm test", "until"],
      ["chat-running", "paused", "restart", 3, MAX_DONE_WHEN_CHECKS, "make check", "until"],
    ],
  );
  assert.equal(migrated[0]!.objective, "Keep going until npm test passes");
  assert.equal(migrated[0]!.setAt, 500);
  // What migration writes reads back as goals on the next launch.
  assert.deepEqual(parseGoalRecords(JSON.parse(JSON.stringify(migrated))), migrated);
});
