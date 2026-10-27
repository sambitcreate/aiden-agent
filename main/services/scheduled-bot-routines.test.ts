import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { scheduledJobs, type Cron } from "croner";
import { BotSessionError } from "./bot-runtime/bot-session-service.js";
import type {
  BotRoutinePorts,
  BotRoutineSubmissionOutcome,
  BotSessionState,
} from "./bot-routines-port.js";
import { createScheduleServiceCore, type ScheduledRunTrigger } from "./schedule-service-core.js";
import { createScheduleStore } from "./schedule-store.js";
import type { BotDeliveryInput } from "./bot-delivery/funnel.js";
import {
  BOT_ROUTINE_CATCH_UP_WINDOW_MS,
  createBotRoutineCatchUp,
  createBotRoutineCatchUpTrigger,
  createBotRoutineExecutor,
  createBotRoutineService,
  countSkippedWhilePaused,
  parseBotRoutineCreate,
  parseBotRoutineRunNow,
  parseBotRoutineUpdate,
} from "./scheduled-bot-routines.js";
import type { ScheduledTask } from "./types.js";

class MemoryPersistence<T> {
  constructor(private data: T) {}

  async load(): Promise<T> {
    return structuredClone(this.data);
  }

  async update<R>(
    mutation: (draft: T) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    if (!isCurrent()) throw new Error("Stale persistence operation.");
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    if (!isCurrent()) throw new Error("Stale persistence operation.");
    this.data = draft;
    return result;
  }
}

/**
 * In-memory stand-in for the Bot session: it dedupes by requestId the way
 * the real session service must, and records every call so tests can prove
 * what a routine did and did not touch.
 */
class FakeBotSession implements BotRoutinePorts {
  states = new Map<string, BotSessionState>();
  replies: Array<BotRoutineSubmissionOutcome | Promise<BotRoutineSubmissionOutcome>> = [];
  sends: Array<{ botId: string; text: string; requestId: string; label?: string }> = [];
  silenced: Array<{ botId: string; submissionId: string }> = [];
  resumeCalls = 0;
  dismissCalls = 0;
  private submissions = new Map<string, string>();
  failAfterNextAdmission = false;
  failBeforeNextAdmission = false;

  async state(botId: string): Promise<BotSessionState> {
    return this.states.get(botId) ?? { kind: "idle" };
  }

  async submissionForRequest(_botId: string, requestId: string): Promise<string | undefined> {
    return this.submissions.get(requestId);
  }

  async send(botId: string, input: { text: string; requestId: string; label?: string }) {
    if (this.failBeforeNextAdmission) {
      this.failBeforeNextAdmission = false;
      throw new Error("The Bot profile is unavailable.");
    }
    const existing = this.submissions.get(input.requestId);
    if (existing) return { submissionId: existing, deduped: true };
    const submissionId = `sub-${this.submissions.size + 1}`;
    this.submissions.set(input.requestId, submissionId);
    this.sends.push({ botId, ...input });
    if (this.failAfterNextAdmission) {
      this.failAfterNextAdmission = false;
      throw new Error("The Pi admission response was lost.");
    }
    return { submissionId, deduped: false };
  }

  async awaitReply(): Promise<BotRoutineSubmissionOutcome> {
    return this.replies.shift() ?? { kind: "completed", text: "Done." };
  }

  async markSilent(botId: string, submissionId: string): Promise<void> {
    this.silenced.push({ botId, submissionId });
  }

  /**
   * What a visible routine result or failure handed to the delivery funnel;
   * the harness stands in for the real log, Mac banner and Telegram.
   */
  deliveries: BotDeliveryInput[] = [];
  failNextDelivery = false;

  async deliver(input: BotDeliveryInput): Promise<"sent"> {
    if (this.failNextDelivery) {
      this.failNextDelivery = false;
      throw new Error("The delivery queue is unavailable.");
    }
    this.deliveries.push(input);
    return "sent";
  }

  // The session's recovery actions exist on the real service; a routine must
  // never call them, so these only count.
  async resume(): Promise<void> {
    this.resumeCalls += 1;
  }

  async dismiss(): Promise<void> {
    this.dismissCalls += 1;
  }
}

function harness(options: { bots?: string[]; pendingRetryIntervalMs?: number } = {}) {
  const bots = new Set(options.bots ?? ["bot-chef", "bot-scout"]);
  const store = createScheduleStore(
    new MemoryPersistence<unknown[]>([]),
    new MemoryPersistence<unknown[]>([]),
  );
  const session = new FakeBotSession();
  const controllers = new Map<string, AbortController>();
  const executor = createBotRoutineExecutor({
    store,
    ports: () => session,
    deliver: (input) => session.deliver(input),
    broadcast: () => undefined,
  });
  const run = (task: ScheduledTask, runId?: string, trigger?: ScheduledRunTrigger) => {
    const controller = new AbortController();
    controllers.set(task.id, controller);
    return executor
      .run(task, { runId, trigger, signal: controller.signal })
      .finally(() => controllers.delete(task.id));
  };
  const scheduler = createScheduleServiceCore({
    store,
    execution: {
      run,
      cancel: (id) => {
        controllers.get(id)?.abort();
        return controllers.has(id);
      },
      cancelAll: () => {
        for (const controller of controllers.values()) controller.abort();
      },
    },
    globallyEnabled: async () => true,
    broadcast: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    pendingRetryIntervalMs: options.pendingRetryIntervalMs,
    ...(options.pendingRetryIntervalMs !== undefined ? { catchUp: { staggerMs: 0 } } : {}),
  });
  const routines = createBotRoutineService({
    store,
    service: scheduler,
    botExists: async (botId) => bots.has(botId),
    isPaused: async (botId) => (await session.state(botId)).kind === "paused",
    defaultTimezone: () => "UTC",
    notifyChanged: () => undefined,
  });
  return {
    store,
    session,
    executor,
    run,
    scheduler,
    routines,
    bots,
    /** What reached the person's Mac banner: the routine, and the delivered text. */
    get notifications(): Array<{ taskId: string; body: string }> {
      return session.deliveries.map((input) => ({ taskId: input.routineTask?.id ?? "", body: input.body }));
    },
  };
}

function jobFor(taskId: string) {
  const job = scheduledJobs.find((entry) => entry.name === `scheduled:${taskId}`);
  assert.ok(job, "the routine should be scheduled");
  return job;
}

async function waitForRoutineRun(h: ReturnType<typeof harness>, taskId: string, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await h.store.runById(taskId, runId);
    if (run && !(await h.store.get(taskId))?.pendingRoutineFires?.length) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the pending routine fire did not settle");
}

test("restart recovers a claimed one-time fire before Pi submission", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "One-time reminder",
    schedule: { kind: "once", date: "2027-01-02", time: "09:00" },
    prompt: "Tell me to call Mom.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, undefined);
  assert.equal((await h.store.get(routine.id))?.enabled, false);

  await h.scheduler.start();
  const run = await waitForRoutineRun(h, routine.id, `routine:${routine.id}:${due}`);
  assert.equal(run.result, "success");
  assert.equal(h.session.sends.length, 1);
  assert.equal(h.session.sends[0]?.text.startsWith("Tell me to call Mom."), true);
  assert.equal((await h.store.get(routine.id))?.enabled, false);
});

test("restart observes a Pi submission already admitted for the same fire", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  const requestId = `routine:${routine.id}:${due}`;
  await h.session.send("bot-chef", { text: "Check the inbox.", requestId });
  h.session.replies.push({ kind: "completed", text: "One urgent message." });

  await h.scheduler.start();
  const run = await waitForRoutineRun(h, routine.id, requestId);
  assert.equal(run.output, "One urgent message.");
  assert.equal(h.session.sends.length, 1, "the recovered fire must not admit a second Pi submission");
  assert.equal(h.session.deliveries.length, 1);
});

test("a paused recurring routine never admits an unfinished claimed fire on restart", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  await h.store.setEnabled(routine.id, false);

  await h.scheduler.start();
  const run = await waitForRoutineRun(h, routine.id, `routine:${routine.id}:${due}`);
  assert.equal(run.result, "blocked");
  assert.equal(h.session.sends.length, 0);
});

test("a paused recurring routine observes a fire Pi had already admitted", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  const requestId = `routine:${routine.id}:${due}`;
  await h.session.send("bot-chef", { text: "Check the inbox.", requestId });
  await h.store.setEnabled(routine.id, false);
  h.session.replies.push({ kind: "completed", text: "One urgent message." });

  await h.scheduler.start();
  const run = await waitForRoutineRun(h, routine.id, requestId);
  assert.equal(run.result, "success");
  assert.equal(h.session.sends.length, 1);
  assert.deepEqual(h.session.deliveries.map(({ body }) => body), ["One urgent message."]);
});

test("a person-paused Bot holds an admitted fire until Resume without resubmitting it", async (t) => {
  const h = harness({ pendingRetryIntervalMs: 20 });
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  const requestId = `routine:${routine.id}:${due}`;
  await h.session.send("bot-chef", { text: "Check the inbox.", requestId });
  h.session.states.set("bot-chef", { kind: "paused", since: Date.now(), by: "mac" });

  await h.scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length, 1);
  assert.equal(await h.store.runById(routine.id, requestId), undefined);
  assert.equal(h.session.sends.length, 1);

  h.session.awaitReply = async () => h.session.states.get("bot-chef")?.kind === "interrupted"
    ? { kind: "interrupted" }
    : { kind: "completed", text: "One urgent message." };
  h.session.states.set("bot-chef", { kind: "interrupted", submissionId: "sub-1" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length, 1);
  assert.equal(await h.store.runById(routine.id, requestId), undefined);
  h.session.states.set("bot-chef", { kind: "idle" });
  const recovered = await waitForRoutineRun(h, routine.id, requestId);
  assert.equal(recovered.result, "success");
  assert.equal(h.session.sends.length, 1);
  assert.deepEqual(h.session.deliveries.map(({ body }) => body), ["One urgent message."]);
});

test("restart completes delivery after a run was recorded without re-running Pi", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  const requestId = `routine:${routine.id}:${due}`;
  await h.store.recordRun({
    id: requestId, taskId: routine.id, startedAt: due, finishedAt: Date.now(),
    result: "success", output: "One urgent message.",
  });
  await h.store.updateRuntime(routine.id, { lastRunAt: undefined, lastResult: undefined });

  await h.scheduler.start();
  await waitForRoutineRun(h, routine.id, requestId);
  assert.equal(h.session.sends.length, 0);
  assert.deepEqual(h.session.deliveries.map(({ body }) => body), ["One urgent message."]);
  assert.equal((await h.store.get(routine.id))?.lastResult, "success");
  assert.equal((await h.store.get(routine.id))?.lastRunAt, (await h.store.runById(routine.id, requestId))?.finishedAt);
});

test("an unavailable runtime and delivery cannot overwrite a saved answer awaiting delivery", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  const requestId = `routine:${routine.id}:${due}`;
  await h.store.recordRun({
    id: requestId, taskId: routine.id, startedAt: due, finishedAt: Date.now(),
    result: "success", output: "One urgent message.",
  });
  const unavailable = createBotRoutineExecutor({
    store: h.store,
    ports: async () => { throw new Error("Bot runtime unavailable."); },
    deliver: async () => { throw new Error("The delivery queue is unavailable."); },
    broadcast: () => undefined,
  });
  const previous = await unavailable.run((await h.store.get(routine.id))!, {
    runId: requestId, trigger: { kind: "automatic", fireTime: due }, signal: new AbortController().signal,
  });
  assert.equal(previous.result, "success");
  assert.equal((await h.store.runById(routine.id, requestId))?.output, "One urgent message.");
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length, 1);

  await h.scheduler.start();
  await waitForRoutineRun(h, routine.id, requestId);
  assert.deepEqual(h.session.deliveries.map(({ body }) => body), ["One urgent message."]);
});

test("delivery never waits for the Bot runtime", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  const requestId = `routine:${routine.id}:${due}`;
  await h.store.recordRun({
    id: requestId, taskId: routine.id, startedAt: due, finishedAt: Date.now(),
    result: "success", output: "One urgent message.",
  });
  const bodies: string[] = [];
  const executor = createBotRoutineExecutor({
    store: h.store,
    ports: async () => { throw new Error("Bot runtime unavailable."); },
    deliver: async ({ body }) => {
      bodies.push(body);
      return "sent";
    },
    broadcast: () => undefined,
  });

  await executor.run((await h.store.get(routine.id))!, {
    runId: requestId, trigger: { kind: "automatic", fireTime: due }, signal: new AbortController().signal,
  });

  assert.deepEqual(bodies, ["One urgent message."], "the saved answer reaches the person");
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length ?? 0, 0, "the fire settled");
});

test("recovery waits for another run on the Bot routine and still submits its pending fire", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  let finishManual: (outcome: BotRoutineSubmissionOutcome) => void = () => {};
  h.session.replies.push(new Promise<BotRoutineSubmissionOutcome>((resolve) => { finishManual = resolve; }));
  const manual = h.scheduler.runNow(routine.id);
  for (let attempt = 0; h.session.sends.length === 0 && attempt < 100; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.session.sends.length, 1);

  await h.scheduler.start();
  finishManual({ kind: "completed", text: "Manual check complete." });
  await manual;
  const run = await waitForRoutineRun(h, routine.id, `routine:${routine.id}:${due}`);
  assert.equal(run.result, "success");
  assert.equal(h.session.sends.length, 2, "the pending fire must not be dropped behind the manual run");
});

test("an ambiguous Pi admission stays pending and restart observes its original submission", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  h.session.failAfterNextAdmission = true;
  const requestId = `routine:${routine.id}:${due}`;
  const first = await h.run((await h.store.get(routine.id))!, requestId, { kind: "automatic", fireTime: due });
  assert.equal(first.result, "blocked");
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length, 1);
  h.session.replies.push({ kind: "completed", text: "One urgent message." });

  await h.scheduler.start();
  const recovered = await waitForRoutineRun(h, routine.id, requestId);
  assert.equal(recovered.result, "success");
  assert.equal(h.session.sends.length, 1);
  assert.deepEqual(h.session.deliveries.map(({ body }) => body), ["One urgent message."]);
});

test("a pending fire retries while Aiden stays open after an ambiguous admission", async (t) => {
  const h = harness({ pendingRetryIntervalMs: 20 });
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  await h.scheduler.start();
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  h.session.failAfterNextAdmission = true;
  const requestId = `routine:${routine.id}:${due}`;
  await h.run((await h.store.get(routine.id))!, requestId, { kind: "automatic", fireTime: due });
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length, 1);
  h.session.replies.push({ kind: "completed", text: "One urgent message." });

  const recovered = await waitForRoutineRun(h, routine.id, requestId);
  assert.equal(recovered.result, "success");
  assert.equal(h.session.sends.length, 1);
  assert.deepEqual(h.session.deliveries.map(({ body }) => body), ["One urgent message."]);
});

test("an automatic send failure before Pi admission is a visible terminal error", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  h.session.failBeforeNextAdmission = true;
  const run = await h.run((await h.store.get(routine.id))!, undefined, { kind: "automatic", fireTime: due });
  assert.equal(run.result, "error");
  assert.match(run.error ?? "", /profile is unavailable/u);
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length ?? 0, 0);
  assert.equal(h.session.sends.length, 0);
  assert.equal(h.session.deliveries.length, 1);
});

test("cancelling an admitted automatic turn leaves the fire for idempotent recovery", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  let finishReply: (outcome: BotRoutineSubmissionOutcome) => void = () => {};
  h.session.replies.push(new Promise<BotRoutineSubmissionOutcome>((resolve) => { finishReply = resolve; }));
  const controller = new AbortController();
  const requestId = `routine:${routine.id}:${due}`;
  const first = h.executor.run((await h.store.get(routine.id))!, {
    runId: requestId, trigger: { kind: "automatic", fireTime: due }, signal: controller.signal,
  });
  for (let attempt = 0; h.session.sends.length === 0 && attempt < 100; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.session.sends.length, 1);
  controller.abort();
  const interrupted = await first;
  assert.equal(interrupted.result, "blocked");
  assert.equal(await h.store.runById(routine.id, requestId), undefined);
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length, 1);
  finishReply({ kind: "completed", text: "One urgent message." });
  h.session.replies.push({ kind: "completed", text: "One urgent message." });

  await h.scheduler.start();
  const recovered = await waitForRoutineRun(h, routine.id, requestId);
  assert.equal(recovered.result, "success");
  assert.equal(h.session.sends.length, 1);
  assert.deepEqual(h.session.deliveries.map(({ body }) => body), ["One urgent message."]);
});

test("a failed delivery handoff leaves the saved result for restart", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef", name: "Daily reminder",
    schedule: { kind: "daily", time: "09:00" }, prompt: "Check the inbox.",
  });
  const due = Date.now() - 1_000;
  await h.store.updateRuntime(routine.id, { nextRunAt: due });
  await h.store.claimRoutineFire(routine.id, due, Date.now() + 60_000);
  h.session.failNextDelivery = true;
  h.session.replies.push({ kind: "completed", text: "One urgent message." });
  const requestId = `routine:${routine.id}:${due}`;
  await h.run((await h.store.get(routine.id))!, undefined, { kind: "automatic", fireTime: due });
  assert.equal((await h.store.get(routine.id))?.pendingRoutineFires?.length, 1);

  await h.scheduler.start();
  await waitForRoutineRun(h, routine.id, requestId);
  assert.equal(h.session.sends.length, 1);
  assert.deepEqual(h.session.deliveries.map(({ body }) => body), ["One urgent message."]);
});

/**
 * Cron fires a routine only once its next fire time arrives, and an automatic
 * run never claims a future fire: move the mocked clock to that time, then fire.
 */
function fireWhenDue(t: TestContext, job: Cron): Promise<void> {
  const due = job.nextRun()?.getTime();
  if (due !== undefined && due > Date.now()) t.mock.timers.enable({ apis: ["Date"], now: due });
  return job.trigger();
}

test("a firing routine submits to its Bot with a stable routine request id", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Weekly meal prep",
    schedule: { kind: "weekly", days: [0], time: "08:41" },
    prompt: "Plan this week's dinners.",
  });
  await h.scheduler.start();
  const due = (await h.store.get(routine.id))!.nextRunAt!;
  h.session.replies.push({ kind: "completed", text: "Monday: lentil soup." });

  await fireWhenDue(t, jobFor(routine.id));

  assert.deepEqual(h.session.sends, [
    {
      botId: "bot-chef",
      requestId: `routine:${routine.id}:${due}`,
      text: "Plan this week's dinners.\n\nIf there is nothing new to report, reply exactly [SILENT].",
      // A routine never dismisses a paused turn, and its turn carries the routine's name.
      ifNotInterrupted: true,
      label: "Weekly meal prep",
    },
  ]);
  const [run] = await h.store.runs(routine.id);
  assert.equal(run?.result, "success");
  assert.equal(run?.output, "Monday: lentil soup.");
  // The routine never claims a workspace chat of its own.
  assert.equal(run?.chatId, undefined);
  assert.equal((await h.store.get(routine.id))?.chatId, undefined);
  assert.deepEqual(h.notifications, [{ taskId: routine.id, body: "Monday: lentil soup." }]);
});

test("firing the same scheduled time twice submits once and stays quiet the second time", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Morning check",
    schedule: { kind: "daily", time: "09:00" },
    prompt: "Anything due today?",
  });
  const task = (await h.store.get(routine.id))!;
  const trigger: ScheduledRunTrigger = { kind: "automatic", fireTime: 1_800_000_000_000 };

  const first = await h.run(task, undefined, trigger);
  const second = await h.run(task, undefined, trigger);

  assert.equal(h.session.sends.length, 1);
  assert.equal(first.result, "success");
  assert.equal(second.result, "skipped");
  assert.equal(second.reason, "duplicate");
  assert.equal(h.notifications.length, 1);

  await h.run(task, undefined, { kind: "automatic", fireTime: 1_800_000_060_000 });
  assert.equal(h.session.sends.length, 2, "a different fire time is a new submission");
});

test("a [SILENT] reply is kept but produces no notification and is hidden from unread", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-scout",
    name: "Inbox sweep",
    schedule: { kind: "weekdays", time: "07:30" },
    prompt: "Tell me about urgent mail.",
  });
  const task = (await h.store.get(routine.id))!;
  h.session.replies.push({ kind: "completed", text: "  [SILENT]\n" });

  const run = await h.run(task, undefined, { kind: "automatic", fireTime: 1 });

  assert.equal(run.result, "silent");
  assert.deepEqual(h.session.silenced, [{ botId: "bot-scout", submissionId: "sub-1" }]);
  assert.deepEqual(h.notifications, []);
  assert.equal((await h.store.get(routine.id))?.lastResult, "silent");

  // Words around the token are a real report, not silence.
  h.session.replies.push({ kind: "completed", text: "[SILENT] but one thing: rent is due" });
  const spoken = await h.run(task, undefined, { kind: "automatic", fireTime: 2 });
  assert.equal(spoken.result, "success");
  assert.equal(h.session.silenced.length, 1);
  assert.equal(h.notifications.length, 1);
});

test("failures always surface, even when the Bot would otherwise stay silent", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-scout",
    name: "Inbox sweep",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Tell me about urgent mail.",
  });
  const task = (await h.store.get(routine.id))!;
  h.session.replies.push({ kind: "failed", error: "The AI service is unreachable." });

  const failed = await h.run(task, undefined, { kind: "automatic", fireTime: 1 });
  assert.equal(failed.result, "error");
  assert.equal(failed.error, "The AI service is unreachable.");

  h.session.states.set("bot-scout", { kind: "needs_model" });
  const noModel = await h.run(task, undefined, { kind: "automatic", fireTime: 2 });
  assert.equal(noModel.result, "error");
  assert.match(noModel.error ?? "", /needs an AI model/u);

  assert.deepEqual(
    h.notifications.map((entry) => entry.body),
    ["The AI service is unreachable.", "This Bot needs an AI model before its routines can run."],
  );
  assert.equal(h.session.sends.length, 1, "no submission is attempted without a model");
});

test("records a classified failure on the run", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-scout",
    name: "Inbox sweep",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Tell me about urgent mail.",
  });
  const task = (await h.store.get(routine.id))!;
  h.session.replies.push({
    kind: "failed",
    error: "model_error",
    reason: "model_error",
    detail: "429 rate limit",
  });

  const run = await h.run(task, undefined, { kind: "automatic", fireTime: 1 });

  assert.equal(run.result, "error");
  assert.equal(run.failure?.kind, "temporary");
  assert.equal(run.failure?.code, "rate_limit");
  // The person and the healing features see the provider's words, not the code.
  assert.match(run.error ?? "", /429 rate limit/u);
  assert.notEqual(run.error, "model_error");

  // Persisted with the run, not only returned by the executor.
  const [stored] = await h.store.runs(routine.id);
  assert.equal(stored?.failure?.kind, "temporary");
  assert.match(stored?.failure?.detail ?? "", /429 rate limit/u);
});

test("a Bot session refusal from the send is classified, not recorded as a generic failure", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-scout",
    name: "Inbox sweep",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Tell me about urgent mail.",
  });
  // The real service refuses the send before Pi admission when the Bot has no model.
  h.session.send = async () => {
    throw new BotSessionError("needs_model");
  };

  const run = await h.run((await h.store.get(routine.id))!, undefined, {
    kind: "automatic",
    fireTime: 1,
  });

  assert.equal(run.result, "error");
  // Task 5 raises an immediate "set a model" issue from this kind.
  assert.equal(run.failure?.kind, "model_setup");
  assert.equal(run.failure?.code, "needs_model");
  // The person reads the refusal, not `run_failed`.
  assert.match(run.error ?? "", /needs an AI model/u);

  const [stored] = await h.store.runs(routine.id);
  assert.equal(stored?.failure?.kind, "model_setup");

  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.body, run.error);
});

test("a provider detail carrying a credential is redacted on the run and its notification", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-scout",
    name: "Inbox sweep",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Tell me about urgent mail.",
  });
  const secret = "sk-live-2f4c9a1b8e7d6c5f4a3b2c1d";
  h.session.replies.push({
    kind: "failed",
    error: "model_error",
    reason: "model_error",
    detail: `401 Unauthorized: api key ${secret} was rejected`,
  });

  const run = await h.run((await h.store.get(routine.id))!, undefined, {
    kind: "automatic",
    fireTime: 1,
  });

  assert.equal(run.result, "error");
  // Classification still reads the provider's words: 401 means sign in again.
  assert.equal(run.failure?.kind, "sign_in");
  // The detail survives, minus the credential.
  assert.match(run.error ?? "", /401 Unauthorized/u);
  assert.match(run.error ?? "", /\[redacted\]/u);
  assert.equal(run.error?.includes(secret), false);
  assert.equal(run.failure?.detail?.includes(secret), false);

  const [stored] = await h.store.runs(routine.id);
  assert.equal(stored?.error?.includes(secret), false);
  assert.equal(stored?.failure?.detail?.includes(secret), false);

  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0]?.body ?? "", /401 Unauthorized/u);
  assert.equal(h.notifications[0]?.body.includes(secret), false);
});

test("a routine that fires while its Bot is paused is skipped without touching the paused turn", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Weekly meal prep",
    schedule: { kind: "weekly", days: [0], time: "08:41" },
    prompt: "Plan this week's dinners.",
  });
  h.session.states.set("bot-chef", { kind: "interrupted", submissionId: "sub-paused" });
  await h.scheduler.start();

  await fireWhenDue(t, jobFor(routine.id));

  const [run] = await h.store.runs(routine.id);
  assert.equal(run?.result, "skipped");
  assert.equal(run?.reason, "bot_paused");
  assert.deepEqual(h.session.sends, []);
  assert.equal(h.session.resumeCalls, 0);
  assert.equal(h.session.dismissCalls, 0);
  assert.deepEqual(h.session.silenced, []);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(await h.session.state("bot-chef"), {
    kind: "interrupted",
    submissionId: "sub-paused",
  });
  // The routine keeps its schedule for the next firing.
  const latest = await h.store.get(routine.id);
  assert.equal(latest?.enabled, true);
  assert.ok((latest?.nextRunAt ?? 0) > Date.now());
});

const PERSON_PAUSED: BotSessionState = { kind: "paused", since: 1_700_000_000_000, by: "mac" };

test("a routine that fires while the person paused its Bot is skipped quietly and never caught up", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Weekly meal prep",
    schedule: { kind: "weekly", days: [0], time: "08:41" },
    prompt: "Plan this week's dinners.",
  });
  h.session.states.set("bot-chef", { ...PERSON_PAUSED, interrupted: "sub-under-pause" });
  await h.scheduler.start();

  await fireWhenDue(t, jobFor(routine.id));

  const [run] = await h.store.runs(routine.id);
  assert.equal(run?.result, "skipped");
  assert.equal(run?.reason, "paused_by_person");
  assert.deepEqual(h.session.sends, [], "the paused Bot gets no input");
  assert.equal(h.session.resumeCalls + h.session.dismissCalls, 0);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(h.session.deliveries, []);

  h.session.states.set("bot-chef", { kind: "idle" });
  const catchUp = createBotRoutineCatchUp({ store: h.store, scheduler: h.scheduler });
  assert.deepEqual(await catchUp.catchUp("bot-chef"), [], "a person's pause is never caught up on its own");
  assert.deepEqual(h.session.sends, []);
});

test("a Bot paused between the state check and the send records a pause skip", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Inbox check",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Anything new?",
  });
  h.session.send = async () => {
    throw Object.assign(new Error("This Bot is paused. Resume it to continue."), {
      name: "BotSessionError",
      reason: "paused_by_person",
    });
  };
  const run = await h.run((await h.store.get(routine.id))!, undefined, { kind: "automatic", fireTime: 1_800_000_000_000 });
  assert.deepEqual([run.result, run.reason], ["skipped", "paused_by_person"]);
  assert.deepEqual(h.notifications, []);
});

test("pausing a Bot while its routine runs records a pause skip instead of a failure", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Inbox check",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Anything new?",
  });
  h.session.awaitReply = async () => {
    // The person pauses mid-reply: the turn is left interrupted under the pause.
    h.session.states.set("bot-chef", { ...PERSON_PAUSED, interrupted: "sub-1" });
    return { kind: "interrupted" };
  };
  const run = await h.run((await h.store.get(routine.id))!, undefined, { kind: "manual", key: "k1" });
  assert.deepEqual([run.result, run.reason, run.error], ["skipped", "paused_by_person", undefined]);
  assert.deepEqual(h.notifications, [], "a pause the person chose is not reported as a failure");
  assert.deepEqual(h.session.deliveries, []);

  // An interruption that is not a pause (a quit) is still a failure to surface.
  h.session.states.set("bot-chef", { kind: "idle" });
  h.session.awaitReply = async () => {
    h.session.states.set("bot-chef", { kind: "interrupted", submissionId: "sub-2" });
    return { kind: "interrupted" };
  };
  const quit = await h.run((await h.store.get(routine.id))!, undefined, { kind: "manual", key: "k2" });
  assert.equal(quit.result, "error");
  assert.equal(h.notifications.length, 1);
});

test("the skipped-while-paused count covers only this Bot's pause skips since the pause began", async () => {
  const h = harness();
  const since = 1_800_000_000_000;
  const digest = await h.routines.create({
    botId: "bot-chef",
    name: "Daily digest",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Digest.",
  });
  const prep = await h.routines.create({
    botId: "bot-chef",
    name: "Meal prep",
    schedule: { kind: "daily", time: "08:30" },
    prompt: "Prep.",
  });
  const quiet = await h.routines.create({
    botId: "bot-chef",
    name: "Quiet one",
    schedule: { kind: "daily", time: "09:30" },
    prompt: "Nothing.",
  });
  const other = await h.routines.create({
    botId: "bot-scout",
    name: "Scout sweep",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Sweep.",
  });
  const skip = (taskId: string, startedAt: number, reason: "paused_by_person" | "bot_paused" = "paused_by_person") =>
    h.store.recordRun({ taskId, startedAt, finishedAt: startedAt, result: "skipped", reason, output: "" });
  await skip(digest.id, since - 60_000); // before the pause
  await skip(digest.id, since + 60_000);
  await skip(digest.id, since + 120_000);
  await skip(prep.id, since + 60_000);
  await skip(quiet.id, since + 60_000, "bot_paused"); // an interruption, not the pause
  await skip(other.id, since + 60_000);

  assert.deepEqual(await countSkippedWhilePaused(h.store, "bot-chef", since), [
    { routineId: digest.id, name: "Daily digest", count: 2 },
    { routineId: prep.id, name: "Meal prep", count: 1 },
  ]);
  assert.deepEqual(await countSkippedWhilePaused(h.store, "bot-chef", since + 600_000), []);
});

test("Run now starts one run of the Bot's own routine and refuses another Bot's", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Daily digest",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Digest.",
  });
  await assert.rejects(h.routines.runNow({ botId: "bot-scout", routineId: routine.id }), /no longer exists/u);
  // A routine edited since the card was drawn is refused, not reported as started.
  await assert.rejects(
    h.routines.runNow({ botId: "bot-chef", routineId: routine.id, expectedUpdatedAt: routine.updatedAt + 1 }),
    /changed/u,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await h.store.runs(routine.id), []);
  assert.deepEqual(h.session.sends, []);

  const { runId } = await h.routines.runNow({ botId: "bot-chef", routineId: routine.id });
  await waitForRun(h, routine.id, runId);
  assert.deepEqual(
    h.session.sends.map(({ requestId, label }) => ({ requestId, label })),
    [{ requestId: `routine:${routine.id}:manual-${runId}`, label: "Daily digest" }],
  );
  const [run] = await h.store.runs(routine.id);
  assert.deepEqual([run?.id, run?.result], [runId, "success"]);
});

test("Run now on a paused Bot is refused, and records no skip for the next unpause to report", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Daily digest",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Digest.",
  });
  h.session.states.set("bot-chef", { kind: "paused", since: 1_000, by: "mac" });
  await assert.rejects(h.routines.runNow({ botId: "bot-chef", routineId: routine.id }), /paused\. Resume it/u);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await h.store.runs(routine.id), [], "nothing ran and nothing was recorded");
  assert.deepEqual(h.session.sends, []);
  assert.deepEqual(await countSkippedWhilePaused(h.store, "bot-chef", 0), []);

  h.session.states.delete("bot-chef");
  const { runId } = await h.routines.runNow({ botId: "bot-chef", routineId: routine.id });
  await waitForRun(h, routine.id, runId);
  assert.equal(h.session.sends.length, 1, "once resumed, Run now runs it");
});

async function waitForRun(h: ReturnType<typeof harness>, taskId: string, runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await h.store.runs(taskId)).some((run) => run.id === runId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the run was never recorded");
}

test("a one-off routine runs once and then switches itself off", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const nextYear = new Date().getUTCFullYear() + 1;
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Party reminder",
    schedule: { kind: "once", date: `${nextYear}-03-14`, time: "17:00" },
    prompt: "Remind me to buy candles.",
  });
  assert.equal(routine.nextRunAt, Date.UTC(nextYear, 2, 14, 17, 0));
  await h.scheduler.start();
  const job = jobFor(routine.id);

  await fireWhenDue(t, job);

  const latest = await h.store.get(routine.id);
  assert.equal(latest?.enabled, false);
  assert.equal(latest?.nextRunAt, undefined);
  assert.equal(h.session.sends.length, 1);
  assert.equal(
    scheduledJobs.some((entry) => entry.name === `scheduled:${routine.id}` && entry.isRunning()),
    false,
  );
});

test("a one-off fire skipped by a paused Bot catches up once after Resume", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const nextYear = new Date().getUTCFullYear() + 1;
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Party reminder",
    schedule: { kind: "once", date: `${nextYear}-03-14`, time: "17:00" },
    prompt: "Remind me to buy candles.",
  });
  h.session.states.set("bot-chef", { kind: "interrupted", submissionId: "paused" });
  await h.scheduler.start();
  await fireWhenDue(t, jobFor(routine.id));

  const [missed] = await h.store.runs(routine.id);
  assert.equal(missed?.reason, "bot_paused");
  assert.equal((await h.store.get(routine.id))?.enabled, false);
  assert.equal(h.session.sends.length, 0);

  h.session.states.set("bot-chef", { kind: "idle" });
  const catchUp = createBotRoutineCatchUp({ store: h.store, scheduler: h.scheduler, now: () => missed!.startedAt + 1 });
  await settle(await catchUp.catchUp("bot-chef"));
  assert.equal(h.session.sends.length, 1);
  assert.equal(h.session.sends[0]?.requestId, missed?.id);
  assert.equal((await h.store.get(routine.id))?.enabled, false);
  assert.deepEqual(await catchUp.catchUp("bot-chef"), []);
});

test("a deferred startup catch-up the Cron already covered never turns the next fire into a duplicate", async (t) => {
  // Yesterday's 09:00 fire was missed while the app was closed; it restarts locked at 08:59:59.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 5, 8, 59, 59) });
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Morning check",
    schedule: { kind: "daily", time: "09:00" },
    prompt: "Anything due today?",
  });
  await h.store.updateRuntime(routine.id, { nextRunAt: Date.UTC(2026, 0, 4, 9, 0) });
  let locked = true;
  h.scheduler.setCatchUpDeferPolicy(() => locked);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await h.scheduler.start();

  t.mock.timers.tick(1_000); // today's 09:00 fire lands while the catch-up waits
  await settle();
  locked = false;
  h.scheduler.reevaluateCatchUp();
  await settle();
  t.mock.timers.tick(24 * 60 * 60 * 1_000); // tomorrow's 09:00 fire
  await settle();

  const runs = await h.store.runs(routine.id);
  assert.deepEqual(
    runs.map((run) => [run.result, run.reason]).sort(),
    [["success", undefined], ["success", undefined]],
    "both real fires must reach the Bot; neither may be skipped as a duplicate",
  );
  assert.equal(h.session.sends.length, 2);
});

test("routines list per Bot with friendly labels and reject a one-off in the past", async () => {
  const h = harness();
  await h.routines.create({
    botId: "bot-chef",
    name: "Morning",
    schedule: { kind: "daily", time: "09:00" },
    prompt: "Good morning summary.",
  });
  await h.routines.create({
    botId: "bot-chef",
    name: "Sunday",
    schedule: { kind: "weekly", days: [0], time: "08:41" },
    prompt: "Weekly plan.",
  });
  await h.routines.create({
    botId: "bot-scout",
    name: "Other Bot",
    schedule: { kind: "weekdays", time: "07:30" },
    prompt: "Not the chef's.",
  });

  const listed = await h.routines.list("bot-chef");
  assert.deepEqual(
    listed.map((routine) => [routine.name, routine.label]),
    [
      ["Morning", "Every day at 9:00 AM"],
      ["Sunday", "Every Sunday at 8:41 AM"],
    ],
  );
  await assert.rejects(
    h.routines.create({
      botId: "bot-chef",
      name: "Too late",
      schedule: { kind: "once", date: "2020-01-01", time: "09:00" },
      prompt: "Never.",
    }),
    /future/u,
  );
  await assert.rejects(
    h.routines.create({
      botId: "bot-gone",
      name: "Orphan",
      schedule: { kind: "daily", time: "09:00" },
      prompt: "Hello?",
    }),
    /no longer exists/u,
  );
});

test("updating a routine keeps it with its Bot and refuses another Bot's routine", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Morning",
    schedule: { kind: "daily", time: "09:00" },
    prompt: "Good morning summary.",
  });

  const updated = await h.routines.update({
    botId: "bot-chef",
    id: routine.id,
    expectedUpdatedAt: routine.updatedAt,
    schedule: { kind: "weekdays", time: "07:30" },
  });
  assert.equal(updated.label, "Weekdays at 7:30 AM");
  assert.equal(updated.prompt, "Good morning summary.");
  assert.equal((await h.store.get(routine.id))?.cron, "30 7 * * 1-5");

  await assert.rejects(
    h.routines.update({
      botId: "bot-scout",
      id: routine.id,
      expectedUpdatedAt: updated.updatedAt,
      name: "Stolen",
    }),
    /no longer exists/u,
  );
  await assert.rejects(
    h.routines.update({
      botId: "bot-chef",
      id: routine.id,
      expectedUpdatedAt: routine.updatedAt,
      name: "Stale",
    }),
    /changed/u,
  );
  await assert.rejects(
    h.store.save({
      id: routine.id,
      name: "Moved",
      mode: "llm",
      cron: "0 9 * * *",
      prompt: "x",
      botId: "bot-scout",
    }),
    /another Bot/u,
  );
});

test("deleting a Bot's routines removes only that Bot's routines and their history", async () => {
  const h = harness();
  const chef = await h.routines.create({
    botId: "bot-chef",
    name: "Morning",
    schedule: { kind: "daily", time: "09:00" },
    prompt: "Good morning summary.",
  });
  await h.routines.create({
    botId: "bot-chef",
    name: "Evening",
    schedule: { kind: "daily", time: "19:00" },
    prompt: "Evening recap.",
  });
  const scout = await h.routines.create({
    botId: "bot-scout",
    name: "Inbox",
    schedule: { kind: "daily", time: "07:00" },
    prompt: "Inbox recap.",
  });
  await h.run((await h.store.get(chef.id))!, undefined, { kind: "automatic", fireTime: 1 });
  await h.run((await h.store.get(scout.id))!, undefined, { kind: "automatic", fireTime: 1 });

  const removed = await h.routines.deleteRoutinesForBot("bot-chef");

  assert.equal(removed.length, 2);
  assert.deepEqual(await h.routines.list("bot-chef"), []);
  assert.deepEqual(await h.store.runs(chef.id), []);
  assert.equal((await h.routines.list("bot-scout")).length, 1);
  assert.equal((await h.store.runs(scout.id)).length, 1);
  assert.deepEqual(await h.routines.deleteRoutinesForBot("bot-chef"), [], "repeat is a no-op");
});

test("deleting a Bot's routines cancels a routine that is waiting on its reply", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Morning",
    schedule: { kind: "daily", time: "09:00" },
    prompt: "Good morning summary.",
  });
  h.session.replies.push(new Promise<BotRoutineSubmissionOutcome>(() => undefined));
  const live = h.scheduler.runNow(routine.id);
  while (h.session.sends.length === 0) await new Promise((resolve) => setImmediate(resolve));

  await h.routines.deleteRoutinesForBot("bot-chef");

  const run = await live;
  assert.equal(run.result, "blocked");
  assert.equal(await h.store.get(routine.id), undefined);
  assert.deepEqual(h.notifications, []);
});

test("routine IPC payloads are parsed strictly", () => {
  assert.deepEqual(
    parseBotRoutineCreate({
      botId: "bot-chef",
      name: "  Weekly meal prep ",
      schedule: { kind: "weekly", days: [0], time: "08:41" },
      prompt: "Plan dinners.",
    }),
    {
      botId: "bot-chef",
      name: "Weekly meal prep",
      schedule: { kind: "weekly", days: [0], time: "08:41" },
      prompt: "Plan dinners.",
    },
  );
  for (const invalid of [
    { botId: "../x", name: "a", schedule: { kind: "daily", time: "09:00" }, prompt: "p" },
    { botId: "bot", name: "", schedule: { kind: "daily", time: "09:00" }, prompt: "p" },
    { botId: "bot", name: "a", schedule: "0 9 * * *", prompt: "p" },
    { botId: "bot", name: "a", schedule: { kind: "daily", time: "09:00" }, prompt: "p", cron: "* * * * *" },
    { botId: "bot", name: "a", schedule: { kind: "daily", time: "09:00" }, prompt: "p", workspaceId: "w" },
  ]) {
    assert.throws(() => parseBotRoutineCreate(invalid), /Invalid/u);
  }
  assert.throws(
    () => parseBotRoutineUpdate({ botId: "bot", id: "r1", expectedUpdatedAt: "1" }),
    /Invalid/u,
  );
  assert.deepEqual(parseBotRoutineUpdate({ botId: "bot", id: "r1", expectedUpdatedAt: 5, enabled: false }), {
    botId: "bot",
    id: "r1",
    expectedUpdatedAt: 5,
    enabled: false,
  });
  assert.deepEqual(parseBotRoutineRunNow({ botId: "bot", routineId: "r1" }), { botId: "bot", routineId: "r1" });
  assert.deepEqual(parseBotRoutineRunNow({ botId: "bot", routineId: "r1", expectedUpdatedAt: 3 }), {
    botId: "bot",
    routineId: "r1",
    expectedUpdatedAt: 3,
  });
  for (const invalid of [
    null,
    { botId: "bot" },
    { botId: "../x", routineId: "r1" },
    { botId: "bot", routineId: "r/1" },
    { botId: "bot", routineId: "r1", expectedUpdatedAt: -1 },
    { botId: "bot", routineId: "r1", runId: "chosen" },
  ]) {
    assert.throws(() => parseBotRoutineRunNow(invalid), /Invalid/u);
  }
});

/** A routine whose scheduled fire was skipped because its Bot was paused. */
async function missedWhilePaused(h: ReturnType<typeof harness>, fires = 1) {
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Weekly meal prep",
    schedule: { kind: "weekly", days: [0], time: "08:41" },
    prompt: "Plan this week's dinners.",
  });
  h.session.states.set("bot-chef", { kind: "interrupted", submissionId: "sub-paused" });
  const task = (await h.store.get(routine.id))!;
  for (let fire = 0; fire < fires; fire += 1) {
    // Real fires are minutes apart; keep their records' start times distinct.
    if (fire > 0) await new Promise((resolve) => setTimeout(resolve, 3));
    await h.run(task, undefined, { kind: "automatic", fireTime: 1_800_000_000_000 + fire * 60_000 });
  }
  const [skipped] = await h.store.runs(routine.id);
  assert.equal(skipped?.reason, "bot_paused");
  h.session.states.set("bot-chef", { kind: "idle" });
  return { routine, task, skipped: skipped! };
}

async function settle(dispatched: Array<{ completion: Promise<unknown> }>) {
  await Promise.all(dispatched.map(({ completion }) => completion));
}

test("after Resume the newest fire missed while paused runs once, under the missed fire's own request id", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const { routine } = await missedWhilePaused(h, 3);
  await h.scheduler.start();
  h.session.replies.push({ kind: "completed", text: "Monday: lentil soup." });
  const catchUp = createBotRoutineCatchUp({ store: h.store, scheduler: h.scheduler });

  await settle(await catchUp.catchUp("bot-chef"));

  // Three misses coalesce into one run of the newest.
  assert.deepEqual(
    h.session.sends.map(({ requestId, label }) => ({ requestId, label })),
    [{ requestId: `routine:${routine.id}:${1_800_000_000_000 + 2 * 60_000}`, label: "Weekly meal prep (missed while paused)" }],
  );
  assert.deepEqual(h.notifications.map(({ body }) => body), ["Monday: lentil soup."]);

  // The catch-up ran, so another state change finds nothing to catch up.
  await settle(await catchUp.catchUp("bot-chef"));
  assert.equal(h.session.sends.length, 1);
});

test("a repeated catch-up of the same miss submits once", async () => {
  const h = harness();
  const { task, skipped } = await missedWhilePaused(h);
  const trigger = { kind: "catch_up", missedRunId: skipped.id, missedAt: skipped.startedAt } as const;

  const first = await h.run(task, undefined, trigger);
  const second = await h.run(task, undefined, trigger);

  assert.equal(first.result, "success");
  assert.equal(second.result, "skipped");
  assert.equal(second.reason, "duplicate");
  assert.equal(h.session.sends.length, 1);
});

test("a miss older than 7 days, or followed by a later run, is not caught up", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const { task, skipped } = await missedWhilePaused(h);
  await h.scheduler.start();
  const late = createBotRoutineCatchUp({
    store: h.store,
    scheduler: h.scheduler,
    now: () => skipped.startedAt + BOT_ROUTINE_CATCH_UP_WINDOW_MS + 1,
  });
  assert.deepEqual(await late.catchUp("bot-chef"), []);

  await h.run(task, undefined, { kind: "manual", key: "person-ran-it" });
  const sendsBefore = h.session.sends.length;
  const current = createBotRoutineCatchUp({ store: h.store, scheduler: h.scheduler });
  assert.deepEqual(await current.catchUp("bot-chef"), [], "a later run supersedes the miss");
  assert.equal(h.session.sends.length, sendsBefore);
});

test("catch-up starts when a Bot leaves its paused state, not on ordinary state changes", () => {
  const caughtUp: string[] = [];
  const onState = createBotRoutineCatchUpTrigger((botId) => caughtUp.push(botId));

  onState("bot-chef", { kind: "interrupted" });
  assert.deepEqual(caughtUp, []);
  onState("bot-chef", { kind: "running" });
  assert.deepEqual(caughtUp, ["bot-chef"], "Resume");
  onState("bot-chef", { kind: "idle" });
  onState("bot-chef", { kind: "running" });
  assert.deepEqual(caughtUp, ["bot-chef"], "ordinary turns never catch up");
  onState("bot-chef", { kind: "interrupted" });
  onState("bot-chef", { kind: "unavailable" });
  onState("bot-chef", { kind: "idle" });
  assert.deepEqual(caughtUp, ["bot-chef", "bot-chef"], "Dismiss");
  // A Bot first seen running may have been paused before this listener existed.
  onState("bot-scout", { kind: "idle" });
  assert.deepEqual(caughtUp, ["bot-chef", "bot-chef", "bot-scout"]);
});

test("a person's pause holds catch-up like an interruption, and only running again releases it", () => {
  const caughtUp: string[] = [];
  const onState = createBotRoutineCatchUpTrigger((botId) => caughtUp.push(botId));

  onState("bot-chef", { kind: "interrupted" });
  onState("bot-chef", { kind: "paused" });
  assert.deepEqual(caughtUp, [], "pausing an interrupted Bot does not catch up");
  onState("bot-chef", { kind: "interrupted" });
  assert.deepEqual(caughtUp, [], "unpausing back to the interrupted turn does not either");
  onState("bot-chef", { kind: "running" });
  assert.deepEqual(caughtUp, ["bot-chef"], "Resume after unpause");

  onState("bot-chef", { kind: "idle" });
  onState("bot-chef", { kind: "paused" });
  onState("bot-chef", { kind: "idle" });
  assert.deepEqual(caughtUp, ["bot-chef", "bot-chef"], "unpausing an idle Bot checks once");
  // First seen paused: nothing runs until it is unpaused.
  onState("bot-scout", { kind: "paused" });
  assert.deepEqual(caughtUp, ["bot-chef", "bot-chef"]);
});

test("a visible reply or a failure reaches the Bot's other surfaces once; silence and skips do not", async () => {
  const h = harness();
  const routine = await h.routines.create({
    botId: "bot-scout",
    name: "Inbox sweep",
    schedule: { kind: "daily", time: "07:30" },
    prompt: "Tell me about urgent mail.",
  });
  const task = (await h.store.get(routine.id))!;

  h.session.replies.push({ kind: "completed", text: "Rent is due Friday." });
  await h.run(task, undefined, { kind: "automatic", fireTime: 1 });
  h.session.replies.push({ kind: "completed", text: "[SILENT]" });
  await h.run(task, undefined, { kind: "automatic", fireTime: 2 });
  await h.run(task, undefined, { kind: "automatic", fireTime: 1 });
  h.session.replies.push({ kind: "failed", error: "The AI service at /Users/sam is unreachable." });
  await h.run(task, undefined, { kind: "automatic", fireTime: 3 });
  h.session.states.set("bot-scout", { kind: "interrupted", submissionId: "sub-paused" });
  await h.run(task, undefined, { kind: "automatic", fireTime: 4 });

  assert.deepEqual(
    h.session.deliveries.map(({ botId, requestId, title, body, status }) => ({ botId, requestId, title, body, status })),
    [
      {
        botId: "bot-scout", requestId: `routine:${routine.id}:1`, title: "Inbox sweep",
        body: "Rent is due Friday.", status: "succeeded",
      },
      // The Mac banner keeps the failure's own text; Telegram and phones show
      // the fixed line for a failed row.
      {
        botId: "bot-scout", requestId: `routine:${routine.id}:3`, title: "Inbox sweep",
        body: "The AI service at /Users/sam is unreachable.", status: "failed",
      },
    ],
  );
});
