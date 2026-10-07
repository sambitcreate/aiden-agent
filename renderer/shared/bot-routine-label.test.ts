import assert from "node:assert/strict";
import test from "node:test";
import { Cron } from "croner";
import { formatBotRoutineLabel } from "./bot-routine-label.js";
import { botRoutineCron, parseBotRoutineSchedule } from "./bot-routine-schedule.js";

function nextFire(schedule: Parameters<typeof botRoutineCron>[0], from: string, timezone = "UTC"): string {
  const job = new Cron(botRoutineCron(schedule), { paused: true, timezone, mode: "5-or-6-parts" });
  try {
    return job.nextRun(new Date(from))!.toISOString();
  } finally {
    job.stop();
  }
}

test("friendly labels read like plain sentences", () => {
  assert.equal(formatBotRoutineLabel({ kind: "daily", time: "09:00" }), "Every day at 9:00 AM");
  assert.equal(formatBotRoutineLabel({ kind: "weekdays", time: "07:30" }), "Weekdays at 7:30 AM");
  assert.equal(formatBotRoutineLabel({ kind: "weekly", days: [0], time: "08:41" }), "Every Sunday at 8:41 AM");
  assert.equal(formatBotRoutineLabel({ kind: "once", date: "2026-10-09", time: "17:00" }), "Once on Oct 9 at 5:00 PM");
});

test("labels cover midnight, noon, several days, and monthly ordinals", () => {
  assert.equal(formatBotRoutineLabel({ kind: "daily", time: "00:05" }), "Every day at 12:05 AM");
  assert.equal(formatBotRoutineLabel({ kind: "daily", time: "12:00" }), "Every day at 12:00 PM");
  assert.equal(
    formatBotRoutineLabel({ kind: "weekly", days: [5, 1, 3], time: "18:15" }),
    "Every Mon, Wed and Fri at 6:15 PM",
  );
  assert.equal(formatBotRoutineLabel({ kind: "weekly", days: [6, 0], time: "10:00" }), "Every Sun and Sat at 10:00 AM");
  assert.equal(formatBotRoutineLabel({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" }), "Weekdays at 7:30 AM");
  assert.equal(formatBotRoutineLabel({ kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "09:00" }), "Every day at 9:00 AM");
  assert.equal(formatBotRoutineLabel({ kind: "monthly", day: 1, time: "09:00" }), "Monthly on the 1st at 9:00 AM");
  assert.equal(formatBotRoutineLabel({ kind: "monthly", day: 22, time: "09:00" }), "Monthly on the 22nd at 9:00 AM");
  assert.equal(formatBotRoutineLabel({ kind: "monthly", day: 13, time: "09:00" }), "Monthly on the 13th at 9:00 AM");
});

test("a one-off routine in another year names the year", () => {
  assert.equal(
    formatBotRoutineLabel({ kind: "once", date: "2027-01-02", time: "08:00" }, { currentYear: 2026 }),
    "Once on Jan 2, 2027 at 8:00 AM",
  );
  assert.equal(
    formatBotRoutineLabel({ kind: "once", date: "2026-01-02", time: "08:00" }, { currentYear: 2026 }),
    "Once on Jan 2 at 8:00 AM",
  );
});

test("each frequency fires at the moment the person picked", () => {
  // Thursday 2026-10-08 12:00 UTC.
  const from = "2026-10-08T12:00:00.000Z";
  assert.equal(nextFire({ kind: "daily", time: "09:00" }, from), "2026-10-09T09:00:00.000Z");
  assert.equal(nextFire({ kind: "weekdays", time: "07:30" }, "2026-10-09T08:00:00.000Z"), "2026-10-12T07:30:00.000Z");
  assert.equal(nextFire({ kind: "weekly", days: [0], time: "08:41" }, from), "2026-10-11T08:41:00.000Z");
  assert.equal(nextFire({ kind: "monthly", day: 1, time: "09:00" }, from), "2026-11-01T09:00:00.000Z");
  assert.equal(nextFire({ kind: "once", date: "2026-10-09", time: "17:00" }, from), "2026-10-09T17:00:00.000Z");
  assert.equal(
    nextFire({ kind: "daily", time: "09:00" }, from, "America/New_York"),
    "2026-10-08T13:00:00.000Z",
  );
});

test("schedule parsing accepts the picker shapes and rejects anything else", () => {
  assert.deepEqual(parseBotRoutineSchedule({ kind: "weekly", days: [3, 1, 3], time: "08:00" }), {
    kind: "weekly",
    days: [1, 3],
    time: "08:00",
  });
  assert.deepEqual(parseBotRoutineSchedule({ kind: "once", date: "2026-02-28", time: "23:59" }), {
    kind: "once",
    date: "2026-02-28",
    time: "23:59",
  });
  for (const invalid of [
    null,
    "0 9 * * *",
    { kind: "hourly", time: "09:00" },
    { kind: "daily", time: "9:00" },
    { kind: "daily", time: "24:00" },
    { kind: "daily", time: "09:60" },
    { kind: "daily", time: "09:00", cron: "* * * * *" },
    { kind: "weekly", days: [], time: "09:00" },
    { kind: "weekly", days: [7], time: "09:00" },
    { kind: "monthly", day: 0, time: "09:00" },
    { kind: "monthly", day: 32, time: "09:00" },
    { kind: "once", date: "2026-02-30", time: "09:00" },
    { kind: "once", date: "2026-13-01", time: "09:00" },
  ]) {
    assert.throws(() => parseBotRoutineSchedule(invalid), /schedule/iu, JSON.stringify(invalid));
  }
});
