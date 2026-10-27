import assert from "node:assert/strict";
import test from "node:test";
import type { BotRoutinePorts, BotRoutineSubmissionOutcome } from "./bot-routines-port.js";
import {
  BOT_ROUTINE_RETRY_DELAYS_MS,
  createBotRoutineRecovery,
  failureStreak,
  fireOutcomes,
  retryPlan,
} from "./bot-routine-recovery.js";
import type { BotIssueService } from "./bot-issues/service.js";
import { createScheduleServiceCore, type ScheduledRunTrigger } from "./schedule-service-core.js";
import { createScheduleStore } from "./schedule-store.js";
import { createBotRoutineExecutor, createBotRoutineService } from "./scheduled-bot-routines.js";
import type { BotRoutineFailureKind } from "../../renderer/shared/bot-routine-failure.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

class MemoryPersistence<T> {
  constructor(private data: T) {}
  async load(): Promise<T> {
    return structuredClone(this.data);
  }
  async update<R>(mutation: (draft: T) => R | Promise<R>, isCurrent: () => boolean = () => true): Promise<R> {
    if (!isCurrent()) throw new Error("Stale persistence operation.");
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    this.data = draft;
    return result;
  }
}

const T = 1_800_000_000_000;

function run(id: string, result: ScheduledRun["result"], kind?: BotRoutineFailureKind, finishedAt = T): ScheduledRun {
  return {
    id, taskId: "task-1", startedAt: finishedAt, finishedAt, result, output: "",
    ...(kind ? { failure: { kind, code: kind } } : {}),
  };
}

test("retries a temporary failure at 5 then 20 minutes", () => {
  const failure = { kind: "temporary" as const, code: "timeout" };
  assert.deepEqual(retryPlan({ failure, attempt: 0, finishedAt: T }), { at: T + 300_000, attempt: 1 });
  assert.deepEqual(retryPlan({ failure, attempt: 1, finishedAt: T }), { at: T + 1_200_000, attempt: 2 });
  assert.equal(retryPlan({ failure, attempt: 2, finishedAt: T }), undefined);
  assert.deepEqual(BOT_ROUTINE_RETRY_DELAYS_MS, [300_000, 1_200_000]);
});

test("skips a retry when the next regular fire comes first", () => {
  assert.equal(retryPlan({ failure: { kind: "temporary", code: "x" }, attempt: 0, finishedAt: T, nextRunAt: T + 60_000 }), undefined);
});

test("never retries sign_in, access_changed or model_setup", () => {
  for (const kind of ["sign_in", "access_changed", "model_setup", "other", "tool_error"] as const) {
    assert.equal(retryPlan({ failure: { kind, code: kind }, attempt: 0, finishedAt: T }), undefined, kind);
  }
  assert.ok(retryPlan({ failure: { kind: "stalled", code: "no_progress" }, attempt: 0, finishedAt: T }));
});

test("counts a fire and its retries as one failure", () => {
  const outcomes = fireOutcomes([
    run("routine:task-1:100:retry-2", "error", "temporary"),
    run("routine:task-1:100:retry-1", "error", "temporary"),
    run("routine:task-1:100", "error", "temporary"),
  ]);
  assert.deepEqual(outcomes, [{ fireKey: "routine:task-1:100", failed: true, kind: "temporary" }]);
});

test("skipped, silent and blocked runs neither count nor break a streak", () => {
  const streak = failureStreak(fireOutcomes([
    run("routine:task-1:300", "error", "temporary"),
    run("routine:task-1:250", "skipped"),
    run("routine:task-1:200", "error", "temporary"),
    run("routine:task-1:150", "silent"),
    run("routine:task-1:100", "error", "temporary"),
  ]));
  assert.deepEqual(streak, { count: 3, kind: "temporary" });
});

test("a success resets the streak", () => {
  assert.deepEqual(failureStreak(fireOutcomes([
    run("routine:task-1:300", "error", "temporary"),
    run("routine:task-1:200", "success"),
    run("routine:task-1:100", "error", "temporary"),
  ])), { count: 1, kind: "temporary" });
});

/** Issue service stand-in that keeps open issues by key, like the real one. */
function fakeIssues() {
  const open = new Map<string, { title: string; body: string; kind: string }>();
  const resolved: Array<{ key: string; resolution: string }> = [];
  const issues: Pick<BotIssueService, "raise" | "resolve"> = {
    async raise(input) {
      if (!open.has(input.dedupeKey)) open.set(input.dedupeKey, { title: input.title, body: input.body, kind: input.kind });
      return { ...input, id: input.dedupeKey, createdAt: T };
    },
    async resolve(_botId, key, resolution) {
      if (!open.delete(key)) return false;
      resolved.push({ key, resolution });
      return true;
    },
  };
  return { open, resolved, issues };
}

/**
 * The real store, scheduler and executor with a scripted Bot session, so a
 * test can drive fires and see what recovery did to durable state.
 */
function harness() {
  const store = createScheduleStore(new MemoryPersistence<unknown[]>([]), new MemoryPersistence<unknown[]>([]));
  const replies: BotRoutineSubmissionOutcome[] = [];
  const sends: string[] = [];
  const submissions = new Map<string, string>();
  const session: BotRoutinePorts = {
    async state() { return { kind: "idle" }; },
    async submissionForRequest(_botId, requestId) { return submissions.get(requestId); },
    async send(_botId, input) {
      const existing = submissions.get(input.requestId);
      if (existing) return { submissionId: existing, deduped: true };
      const submissionId = `sub-${submissions.size + 1}`;
      submissions.set(input.requestId, submissionId);
      sends.push(input.requestId);
      return { submissionId, deduped: false };
    },
    async awaitReply() { return replies.shift() ?? { kind: "completed", text: "Done." }; },
    async markSilent() {},
  };
  const { open, resolved, issues } = fakeIssues();
  let routines: ReturnType<typeof createBotRoutineService> | undefined;
  const recovery = createBotRoutineRecovery({
    store,
    routines: { pause: (botId, id) => routines!.pause(botId, id) },
    issues,
    now: () => Date.now(),
  });
  const executor = createBotRoutineExecutor({
    store,
    ports: () => session,
    deliver: async () => "sent",
    broadcast: () => undefined,
    afterRun: (task, recorded, trigger) => recovery.afterRun(task, recorded, trigger),
  });
  const scheduler = createScheduleServiceCore({
    store,
    execution: {
      run: (task: ScheduledTask, runId?: string, trigger?: ScheduledRunTrigger) =>
        executor.run(task, { runId, trigger, signal: new AbortController().signal }),
      cancel: () => false,
      cancelAll: () => undefined,
    },
    globallyEnabled: async () => true,
    broadcast: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    pendingRetryIntervalMs: 5,
    catchUp: { staggerMs: 0 },
  });
  routines = createBotRoutineService({
    store,
    service: scheduler,
    botExists: async () => true,
    isPaused: async () => false,
    defaultTimezone: () => "UTC",
    notifyChanged: () => undefined,
  });
  return { store, scheduler, routines, executor, replies, sends, open, resolved };
}

const TIMEOUT: BotRoutineSubmissionOutcome = { kind: "failed", error: "model_error", reason: "model_error", detail: "503 Service Unavailable" };
const SIGNED_OUT: BotRoutineSubmissionOutcome = { kind: "failed", error: "model_error", reason: "model_error", detail: "401 Unauthorized: token expired" };

async function fire(h: ReturnType<typeof harness>, taskId: string, at: number): Promise<ScheduledRun> {
  await h.store.updateRuntime(taskId, { nextRunAt: at });
  const task = await h.store.claimRoutineFire(taskId, at, at + 86_400_000);
  return h.executor.run(task, {
    runId: `routine:${taskId}:${at}`,
    trigger: { kind: "automatic", fireTime: at },
    signal: new AbortController().signal,
  });
}

test("a temporary failure queues one durable retry 5 minutes later", async () => {
  const h = harness();
  const routine = await h.routines.create({ botId: "bot-1", name: "Briefing", schedule: { kind: "daily", time: "09:00" }, prompt: "Brief me." });
  h.replies.push(TIMEOUT);
  const failed = await fire(h, routine.id, Date.now() - 1_000);
  const retries = (await h.store.get(routine.id))?.pendingRoutineFires?.filter((entry) => entry.retry) ?? [];
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.requestId, `${failed.id}:retry-1`);
  assert.equal(retries[0]?.fireTime, failed.finishedAt + 300_000);
  assert.equal(h.open.size, 0, "a passing failure does not bother the person");
});

test("a sign-in failure raises one issue at once and is not retried", async () => {
  const h = harness();
  const routine = await h.routines.create({ botId: "bot-1", name: "Briefing", schedule: { kind: "daily", time: "09:00" }, prompt: "Brief me." });
  h.replies.push(SIGNED_OUT);
  await fire(h, routine.id, Date.now() - 1_000);
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.some((entry) => entry.retry) ?? false, false);
  assert.deepEqual([...h.open.values()], [{
    title: "Briefing needs you", body: "Sign in to your AI provider again so it can run.", kind: "routine_failed",
  }]);
});

test("pauses after three failed fires of the same kind and raises one issue", async () => {
  const h = harness();
  const routine = await h.routines.create({ botId: "bot-1", name: "Briefing", schedule: { kind: "daily", time: "09:00" }, prompt: "Brief me." });
  const base = Date.now() - 10 * 86_400_000;
  for (let day = 0; day < 3; day += 1) {
    h.replies.push(SIGNED_OUT);
    await fire(h, routine.id, base + day * 86_400_000);
  }
  const task = await h.store.get(routine.id);
  assert.equal(task?.enabled, false);
  const paused = h.open.get(`routine_paused:${routine.id}`);
  assert.equal(paused?.title, "Paused Briefing");
  assert.equal(paused?.body, "It failed 3 times in a row. Its AI provider needs signing in again.");
  assert.equal(h.open.has(`routine_failed:${routine.id}`), false, "the pause card replaces the earlier card");
});

test("different kinds do not pause", async () => {
  const h = harness();
  const routine = await h.routines.create({ botId: "bot-1", name: "Briefing", schedule: { kind: "daily", time: "09:00" }, prompt: "Brief me." });
  const base = Date.now() - 10 * 86_400_000;
  // Temporary failures retry; drop each queued retry so only the fires count.
  for (const [day, reply] of [[0, TIMEOUT], [1, SIGNED_OUT], [2, TIMEOUT]] as const) {
    h.replies.push(reply);
    await fire(h, routine.id, base + day * 86_400_000);
    await h.store.clearRoutineRetries(routine.id);
  }
  assert.equal((await h.store.get(routine.id))?.enabled, true);
  assert.equal(h.open.has(`routine_paused:${routine.id}`), false);
  assert.equal(h.open.get(`routine_failed:${routine.id}`)?.title, "Briefing needs you");
});

test("a success resolves the routine's open cards", async () => {
  const h = harness();
  const routine = await h.routines.create({ botId: "bot-1", name: "Briefing", schedule: { kind: "daily", time: "09:00" }, prompt: "Brief me." });
  h.replies.push(SIGNED_OUT);
  await fire(h, routine.id, Date.now() - 2 * 86_400_000);
  await fire(h, routine.id, Date.now() - 86_400_000);
  assert.equal(h.open.size, 0);
  assert.deepEqual(h.resolved, [{ key: `routine_failed:${routine.id}`, resolution: "fixed" }]);
});

test("a one-time routine's temporary failure still retries while disabled", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({ botId: "bot-1", name: "Reminder", schedule: { kind: "once", date: "2027-01-02", time: "09:00" }, prompt: "Remind me." });
  h.replies.push(TIMEOUT);
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  const claimed = await h.store.claimRoutineFire(routine.id, due, undefined);
  const failed = await h.executor.run(claimed, { runId: `routine:${routine.id}:${due}`, trigger: { kind: "automatic", fireTime: due }, signal: new AbortController().signal });
  assert.equal((await h.store.get(routine.id))?.enabled, false);
  // Bring the queued retry due now, then let the scheduler replay it.
  const task = await h.store.get(routine.id);
  const retry = task?.pendingRoutineFires?.find((entry) => entry.retry);
  assert.ok(retry, "the retry was queued");
  await h.store.clearRoutineRetries(routine.id);
  await h.store.addRoutineRetry(routine.id, { failedRunId: failed.id, attempt: 1, at: Date.now() - 1 });
  await h.scheduler.start();
  const retryId = `${failed.id}:retry-1`;
  for (let attempt = 0; attempt < 200 && !(await h.store.runById(routine.id, retryId)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const replayed = await h.store.runById(routine.id, retryId);
  assert.equal(replayed?.result, "success");
  assert.deepEqual(h.sends.filter((id) => id === retryId), [retryId], "the retry ran exactly once");
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length ?? 0, 0);
});

test("a retry that is not due yet does not run", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({ botId: "bot-1", name: "Briefing", schedule: { kind: "daily", time: "09:00" }, prompt: "Brief me." });
  h.replies.push(TIMEOUT);
  const failed = await fire(h, routine.id, Date.now() - 1_000);
  await h.scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await h.store.runById(routine.id, `${failed.id}:retry-1`), undefined);
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.filter((entry) => entry.retry).length, 1);
});
