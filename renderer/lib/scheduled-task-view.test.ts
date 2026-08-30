import assert from "node:assert/strict";
import test from "node:test";
import {
  cronFromScheduleDraft,
  filterScheduledTasks,
  formatNextRun,
  formatSchedule,
  scheduleDraftFromCron,
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
    task({
      id: "script",
      name: "Log watcher",
      mode: "script",
      prompt: undefined,
      script: "watch.sh",
    }),
  ];
  assert.deepEqual(
    filterScheduledTasks(tasks, "", "active").map(({ id }) => id),
    ["active", "script"],
  );
  assert.deepEqual(
    filterScheduledTasks(tasks, "weekly", "all").map(({ id }) => id),
    ["paused"],
  );
  assert.deepEqual(
    filterScheduledTasks(tasks, "watch.sh", "all").map(({ id }) => id),
    ["script"],
  );
});

test("relative next-run labels and status stay deterministic", () => {
  const now = Date.parse("2026-07-23T12:00:00Z");
  assert.match(formatNextRun(now + 2 * 3_600_000, now), /2 hours/iu);
  assert.equal(formatNextRun(undefined, now), "No next run");
  assert.equal(scheduledTaskStatus(task({ id: "a", name: "A" })), "active");
  assert.equal(scheduledTaskStatus(task({ id: "b", name: "B", enabled: false })), "paused");
  assert.equal(scheduledTaskStatus(task({ id: "c", name: "C", lastResult: "blocked" })), "error");
});

test("common cron schedules are presented as human-readable cadence", () => {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const reference = new Date("2026-07-30T12:00:00Z");
  assert.equal(formatSchedule("0 9 * * *", localTimezone, reference), "Every day at 9:00 AM");
  assert.equal(formatSchedule("0 8 * * 1-5", localTimezone, reference), "Weekdays at 8:00 AM");
  assert.equal(formatSchedule("0 16 * * 5", localTimezone, reference), "Every Friday at 4:00 PM");
  assert.equal(
    formatSchedule("0 9 * * 1,3,5", localTimezone, reference),
    "Every Monday, Wednesday, and Friday at 9:00 AM",
  );
  assert.equal(formatSchedule("*/15 * * * *", localTimezone, reference), "Every 15 minutes");
  assert.equal(
    formatSchedule("20 * * * *", localTimezone, reference),
    "Every hour at 20 minutes past",
  );
  assert.equal(
    formatSchedule("0 9 1 * *", localTimezone, reference),
    "Monthly on the 1st at 9:00 AM",
  );
  assert.equal(formatSchedule("5 0 9 * * *", localTimezone, reference), "Custom schedule");
});

test("common schedules round-trip through human editor controls", () => {
  for (const cron of [
    "*/15 * * * *",
    "20 * * * *",
    "0 9 * * *",
    "30 8 * * 1-5",
    "0 16 * * 5",
    "45 7 12 * *",
  ]) {
    assert.equal(cronFromScheduleDraft(scheduleDraftFromCron(cron)), cron);
  }
});

test("unusual and legacy schedules remain byte-for-byte custom until edited", () => {
  for (const cron of ["5 0 9 * * *", "0 9 * * 1,3,5", "0 9 * 1 *"]) {
    const draft = scheduleDraftFromCron(cron);
    assert.equal(draft.cadence, "custom");
    assert.equal(cronFromScheduleDraft(draft), cron);
  }
});

test("human editor controls build bounded persisted cron expressions", () => {
  const base = scheduleDraftFromCron("0 9 * * *");
  assert.equal(
    cronFromScheduleDraft({ ...base, cadence: "minutes", minuteInterval: 100 }),
    "*/59 * * * *",
  );
  assert.equal(
    cronFromScheduleDraft({ ...base, cadence: "weekly", time: "13:05", weekday: 3 }),
    "5 13 * * 3",
  );
  assert.equal(cronFromScheduleDraft({ ...base, cadence: "monthly", monthDay: 0 }), "0 9 1 * *");
});
