import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createBotRoutineNotificationFeed } from "./bot-routine-notifications.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

const NOW = Date.parse("2026-08-19T15:01:00.000Z");

function task(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name: "Morning brief",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    botId: "bot_fixture_01",
    routineSchedule: { kind: "daily", time: "09:00" },
    notify: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function run(id: string, taskId: string, finishedAt: number, overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return { id, taskId, startedAt: finishedAt - 9_000, finishedAt, result: "success", output: "Done.", ...overrides };
}

function feed(tasks: ScheduledTask[], runs: ScheduledRun[], names: Record<string, string> = { bot_fixture_01: "Scout" }) {
  return createBotRoutineNotificationFeed({
    store: {
      list: async () => tasks,
      runs: async (taskId) => runs.filter((candidate) => candidate.taskId === taskId).sort((a, b) => b.startedAt - a.startedAt),
    },
    botName: async (botId) => names[botId],
    now: () => NOW,
  });
}

test("the feed serves the shared fixture's notification for a routine's visible reply", async () => {
  const fixture = JSON.parse(
    await readFile(path.resolve(process.cwd(), "protocol/aiden-remote/v1/fixtures/contract.json"), "utf8"),
  ) as { botRoutineNotifications: unknown };
  const served = await feed(
    [task("task_fixture_routine_01")],
    [run("run_fixture_bot_01", "task_fixture_routine_01", Date.parse("2026-08-19T15:00:09.000Z"), {
      output: "Your first meeting is at 9:30 with Priya.",
    })],
  ).list(undefined);
  assert.deepEqual(served, fixture.botRoutineNotifications);
});

test("replies and failures are announced; silence, skips, cancellations and quiet routines are not", async () => {
  const at = NOW - 60_000;
  const served = await feed(
    [
      task("routine"),
      task("quiet", { notify: false }),
      task("schedule", { botId: undefined }),
      task("orphan", { botId: "bot_deleted" }),
    ],
    [
      run("reply", "routine", at),
      run("failure", "routine", at + 1, { result: "error", output: "", error: "Provider at /Users/sam/key failed" }),
      run("silent", "routine", at + 2, { result: "silent", output: "" }),
      run("paused", "routine", at + 3, { result: "skipped", reason: "bot_paused", output: "" }),
      run("duplicate", "routine", at + 4, { result: "skipped", reason: "duplicate", output: "" }),
      run("cancelled", "routine", at + 5, { result: "blocked", output: "" }),
      run("silent-token", "routine", at + 6, { output: "[SILENT]" }),
      run("quiet-reply", "quiet", at + 7),
      run("workspace-task", "schedule", at + 8),
      run("deleted-bot", "orphan", at + 9),
    ],
  ).list(undefined);
  assert.deepEqual(
    served.notifications.map(({ id, status, preview }) => ({ id, status, preview })),
    [
      // Newest first; a failure never shows its error text.
      { id: "failure", status: "failed", preview: "I couldn't finish this routine." },
      { id: "reply", status: "succeeded", preview: "Done." },
    ],
  );
  assert.equal(served.now, new Date(NOW).toISOString());
});

test("since returns only runs that finished later", async () => {
  const runs = [run("old", "routine", NOW - 10_000), run("new", "routine", NOW - 1_000)];
  const served = await feed([task("routine")], runs).list(NOW - 5_000);
  assert.deepEqual(served.notifications.map(({ id }) => id), ["new"]);
  assert.deepEqual((await feed([task("routine")], runs).list(NOW - 1_000)).notifications, [], "a run at exactly since was already served");
});

test("the feed is capped at the newest 100", async () => {
  const runs = Array.from({ length: 130 }, (_, index) => run(`run-${index}`, `task-${index % 13}`, NOW - 200_000 + index * 1_000));
  const tasks = Array.from({ length: 13 }, (_, index) => task(`task-${index}`));
  const served = await feed(tasks, runs).list(undefined);
  assert.equal(served.notifications.length, 100);
  assert.equal(served.notifications[0]!.id, "run-129");
  assert.equal(served.notifications[99]!.id, "run-30");
});

test("previews are cut to 160 characters and never carry local paths or key-shaped secrets", async () => {
  const output = `Saved the report to /Users/sam/Library/Aiden/report.md using sk-abcdefghijklmnop1234. ${"More detail. ".repeat(30)}`;
  const [notification] = (await feed([task("routine")], [run("r", "routine", NOW - 1_000, { output })]).list(undefined)).notifications;
  assert.ok(notification);
  assert.doesNotMatch(notification.preview, /\/Users|sk-abcdef/u);
  assert.match(notification.preview, /^Saved the report to \[path\] using \[redacted\]\./u);
  assert.ok([...notification.preview].length <= 160);
});
