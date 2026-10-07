import assert from "node:assert/strict";
import test from "node:test";
import { scheduledJobs } from "croner";
import type {
  BotRoutinePorts,
  BotRoutineSubmissionOutcome,
  BotSessionState,
} from "./bot-routines-port.js";
import { createScheduleServiceCore, type ScheduledRunTrigger } from "./schedule-service-core.js";
import { createScheduleStore } from "./schedule-store.js";
import {
  createBotRoutineExecutor,
  createBotRoutineService,
  parseBotRoutineCreate,
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
  sends: Array<{ botId: string; text: string; requestId: string }> = [];
  silenced: Array<{ botId: string; submissionId: string }> = [];
  resumeCalls = 0;
  dismissCalls = 0;
  private submissions = new Map<string, string>();

  async state(botId: string): Promise<BotSessionState> {
    return this.states.get(botId) ?? { kind: "idle" };
  }

  async send(botId: string, input: { text: string; requestId: string }) {
    const existing = this.submissions.get(input.requestId);
    if (existing) return { submissionId: existing, deduped: true };
    const submissionId = `sub-${this.submissions.size + 1}`;
    this.submissions.set(input.requestId, submissionId);
    this.sends.push({ botId, ...input });
    return { submissionId, deduped: false };
  }

  async awaitReply(): Promise<BotRoutineSubmissionOutcome> {
    return this.replies.shift() ?? { kind: "completed", text: "Done." };
  }

  async markSilent(botId: string, submissionId: string): Promise<void> {
    this.silenced.push({ botId, submissionId });
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

function harness(options: { bots?: string[] } = {}) {
  const bots = new Set(options.bots ?? ["bot-chef", "bot-scout"]);
  const store = createScheduleStore(
    new MemoryPersistence<unknown[]>([]),
    new MemoryPersistence<unknown[]>([]),
  );
  const session = new FakeBotSession();
  const notifications: Array<{ taskId: string; body: string }> = [];
  const controllers = new Map<string, AbortController>();
  const executor = createBotRoutineExecutor({
    store,
    ports: () => session,
    notify: (task, body) => void notifications.push({ taskId: task.id, body }),
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
  });
  const routines = createBotRoutineService({
    store,
    service: scheduler,
    botExists: async (botId) => bots.has(botId),
    defaultTimezone: () => "UTC",
    notifyChanged: () => undefined,
  });
  return { store, session, notifications, executor, run, scheduler, routines, bots };
}

function jobFor(taskId: string) {
  const job = scheduledJobs.find((entry) => entry.name === `scheduled:${taskId}`);
  assert.ok(job, "the routine should be scheduled");
  return job;
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

  await jobFor(routine.id).trigger();

  assert.deepEqual(h.session.sends, [
    {
      botId: "bot-chef",
      requestId: `routine:${routine.id}:${due}`,
      text: "Plan this week's dinners.\n\nIf there is nothing new to report, reply exactly [SILENT].",
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

  await jobFor(routine.id).trigger();

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

  await job.trigger();

  const latest = await h.store.get(routine.id);
  assert.equal(latest?.enabled, false);
  assert.equal(latest?.nextRunAt, undefined);
  assert.equal(h.session.sends.length, 1);
  assert.equal(
    scheduledJobs.some((entry) => entry.name === `scheduled:${routine.id}` && entry.isRunning()),
    false,
  );
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
});
