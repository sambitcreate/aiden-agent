import assert from "node:assert/strict";
import test from "node:test";
import {
  filterScheduledTasks,
  formatNextRun,
  scheduledTaskStatus,
} from "./scheduled-task-view.js";
import type { ScheduledTask } from "./types.js";

function task(input: Partial<ScheduledTask> & Pick<ScheduledTask, "id" | "name">): ScheduledTask {
  return {
    enabled: true,
    mode: "llm",
    cron: "0 9 * * 1-5",
    timezone: "UTC",
    prompt: "Summarize changes",
    permission: "read-only",
    notify: true,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

test("scheduled task filtering combines tab and text matches", () => {
  const tasks = [
    task({ id: "active", name: "Daily brief" }),
    task({ id: "paused", name: "Weekly review", enabled: false }),
    task({ id: "script", name: "Log watcher", mode: "script", prompt: undefined, script: "watch.sh" }),
  ];
  assert.deepEqual(filterScheduledTasks(tasks, "", "active").map(({ id }) => id), ["active", "script"]);
  assert.deepEqual(filterScheduledTasks(tasks, "weekly", "all").map(({ id }) => id), ["paused"]);
  assert.deepEqual(filterScheduledTasks(tasks, "watch.sh", "all").map(({ id }) => id), ["script"]);
});

test("relative next-run labels and status stay deterministic", () => {
  const now = Date.parse("2026-07-23T12:00:00Z");
  assert.match(formatNextRun(now + 2 * 3_600_000, now), /2 hours/iu);
  assert.equal(formatNextRun(undefined, now), "No next run");
  assert.equal(scheduledTaskStatus(task({ id: "a", name: "A" })), "active");
  assert.equal(scheduledTaskStatus(task({ id: "b", name: "B", enabled: false })), "paused");
  assert.equal(
    scheduledTaskStatus(task({ id: "c", name: "C", lastResult: "blocked" })),
    "error",
  );
});
