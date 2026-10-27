import assert from "node:assert/strict";
import test from "node:test";
import type { BotHealthReport } from "../../../renderer/shared/bot-health.js";
import type { BotIssueService } from "../bot-issues/service.js";
import type { ScheduledTask } from "../types.js";
import {
  BOT_ROUTINE_PREFLIGHT_LEAD_MS,
  createBotHealthReports,
  createBotRoutinePreflight,
} from "./preflight.js";

const HOUR = 3_600_000;

function routine(id: string, nextRunAt: number | undefined, extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id, botId: "bot-1", name: "Morning briefing", enabled: true, mode: "llm", cron: "0 9 * * *",
    timezone: "UTC", permission: "read-only", notify: true, createdAt: 1, updatedAt: 1,
    ...(nextRunAt !== undefined ? { nextRunAt } : {}), ...extra,
  } as ScheduledTask;
}

function report(results: BotHealthReport["results"], routineId = "r1"): BotHealthReport {
  return { botId: "bot-1", checkedAt: 0, trigger: "pre_fire", routineId, results };
}

const SIGNED_OUT = report([
  { id: "bot_state", status: "ok", label: "Bot" },
  { id: "model", status: "ok", label: "AI model" },
  { id: "provider_auth", status: "needs_you", label: "Sign-in", failure: { kind: "sign_in", code: "signed_out" } },
]);
const ALL_OK = report([
  { id: "bot_state", status: "ok", label: "Bot" },
  { id: "model", status: "ok", label: "AI model" },
  { id: "provider_auth", status: "ok", label: "Sign-in" },
]);

/** A clock and a timer queue the test advances by hand. */
function setup(tasks: ScheduledTask[], reports: BotHealthReport[]) {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const runs: string[] = [];
  const open = new Map<string, { title: string; body: string }>();
  const resolved: string[] = [];
  const issues: Pick<BotIssueService, "raise" | "resolve"> = {
    async raise(input) {
      if (!open.has(input.dedupeKey)) open.set(input.dedupeKey, { title: input.title, body: input.body });
      return { ...input, id: input.dedupeKey, createdAt: now };
    },
    async resolve(_botId, key) {
      if (!open.delete(key)) return false;
      resolved.push(key);
      return true;
    },
  };
  const preflight = createBotRoutinePreflight({
    routines: async () => tasks,
    run: async (_botId, routineId) => {
      runs.push(routineId);
      return reports.shift() ?? ALL_OK;
    },
    issues,
    reports: createBotHealthReports(),
    now: () => now,
    setTimer: (fn, ms) => {
      const entry = { at: now + ms, fn, cancelled: false };
      timers.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
  });
  async function advance(to: number) {
    now = to;
    for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= to)) {
      timer.cancelled = true;
      timer.fn();
    }
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { preflight, advance, runs, open, resolved, setNow: (value: number) => { now = value; } };
}

test("checks once 30 minutes before a fire", async () => {
  const fire = 2 * HOUR;
  const h = setup([routine("r1", fire)], []);
  await h.preflight.rearm();
  await h.advance(fire - BOT_ROUTINE_PREFLIGHT_LEAD_MS - 1);
  assert.deepEqual(h.runs, []);
  await h.advance(fire - BOT_ROUTINE_PREFLIGHT_LEAD_MS);
  assert.deepEqual(h.runs, ["r1"]);
  await h.preflight.rearm();
  await h.advance(fire - 1);
  assert.deepEqual(h.runs, ["r1"], "the same fire is checked once");
});

test("a fire under 2 minutes away is not checked", async () => {
  const h = setup([routine("r1", 60_000)], []);
  await h.preflight.rearm();
  await h.advance(60_000);
  assert.deepEqual(h.runs, []);
});

test("a fire 10 minutes away is checked right away", async () => {
  const h = setup([routine("r1", 10 * 60_000)], []);
  await h.preflight.rearm();
  await h.advance(0);
  assert.deepEqual(h.runs, ["r1"]);
});

test("a needs_you result raises one issue keyed preflight:<check> with the routine's name", async () => {
  const h = setup([routine("r1", 10 * 60_000)], [SIGNED_OUT]);
  await h.preflight.rearm();
  await h.advance(0);
  assert.deepEqual([...h.open.entries()], [["preflight:provider_auth", {
    title: "Morning briefing may not run",
    body: "Sign in to your AI provider again before it runs.",
  }]]);
});

test("a later passing check resolves the issue as fixed", async () => {
  const tasks = [routine("r1", 10 * 60_000)];
  const h = setup(tasks, [SIGNED_OUT, ALL_OK]);
  await h.preflight.rearm();
  await h.advance(0);
  assert.equal(h.open.size, 1);
  tasks[0] = routine("r1", 24 * HOUR + 10 * 60_000);
  h.setNow(24 * HOUR);
  await h.preflight.rearm();
  await h.advance(24 * HOUR);
  assert.equal(h.open.size, 0);
  assert.deepEqual(h.resolved, ["preflight:provider_auth"]);
});

test("editing the routine's time rearms the timer", async () => {
  const tasks = [routine("r1", 5 * HOUR)];
  const h = setup(tasks, []);
  await h.preflight.rearm();
  tasks[0] = routine("r1", 2 * HOUR);
  await h.preflight.rearm();
  await h.advance(2 * HOUR - BOT_ROUTINE_PREFLIGHT_LEAD_MS);
  assert.deepEqual(h.runs, ["r1"]);
  await h.advance(5 * HOUR - BOT_ROUTINE_PREFLIGHT_LEAD_MS);
  assert.deepEqual(h.runs, ["r1"], "the old timer was cancelled");
});

test("a disabled routine is never checked", async () => {
  const h = setup([routine("r1", 10 * 60_000, { enabled: false })], []);
  await h.preflight.rearm();
  await h.advance(10 * 60_000);
  assert.deepEqual(h.runs, []);
});
