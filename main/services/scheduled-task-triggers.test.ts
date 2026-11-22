import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BotWatchCheck } from "./bot-routine-events/watch-sources.js";
import { runScheduledScript } from "./schedule-script.js";
import type { ScheduledRunTrigger } from "./schedule-service-core.js";
import { createScheduledTaskTriggers } from "./scheduled-task-triggers.js";
import { createScheduledTaskTriggerStore } from "./scheduled-task-triggers-store.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

class MemoryPersistence<T> {
  constructor(private data: T) {}
  async load(): Promise<T> { return structuredClone(this.data); }
  async update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    this.data = draft;
    return result;
  }
  snapshot(): T { return structuredClone(this.data); }
}

const MINUTE = 60_000;

function watchTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1", name: "Status page", enabled: true, mode: "llm", cron: "", timezone: "UTC",
    prompt: "Tell me what changed.", permission: "read-only", notify: true, webSearchEnabled: false,
    trigger: { kind: "watch", source: { type: "url", url: "https://example.com/status" }, everyMinutes: 15 },
    createdAt: 1, updatedAt: 1, ...overrides,
  } as ScheduledTask;
}

function harness(options: { tasks?: ScheduledTask[]; checks?: BotWatchCheck[]; runResult?: ScheduledRun["result"]; stateDir?: string } = {}) {
  let clock = 1_800_000_000_000;
  const tasks = options.tasks ?? [watchTask()];
  const checks = [...(options.checks ?? [])];
  const events: Array<{ taskId: string; event: Extract<ScheduledRunTrigger, { kind: "event" }>; runId: string }> = [];
  const cards: Array<{ taskId: string; error: string }> = [];
  const runs = new Map<string, ScheduledRun>();
  const persistence = new MemoryPersistence<unknown>({ version: 1, tasks: {} });
  const store = createScheduledTaskTriggerStore({
    persistence,
    tasks: async () => structuredClone(tasks),
    pauseTask: async (taskId, reason) => {
      const index = tasks.findIndex((task) => task.id === taskId);
      tasks[index] = { ...tasks[index]!, enabled: false, lastError: reason, updatedAt: tasks[index]!.updatedAt + 1 };
    },
    now: () => clock,
  });
  const triggers = createScheduledTaskTriggers({
    store,
    isActive: () => true,
    runEvent: async (taskId, event, runId) => {
      events.push({ taskId, event, runId });
      const run: ScheduledRun = { id: runId, taskId, startedAt: clock, finishedAt: clock, result: options.runResult ?? "success", output: "" };
      runs.set(runId, run);
      return run;
    },
    findRun: async (_taskId, runId) => runs.get(runId),
    fetchUrl: async () => checks.shift() ?? { ok: false, error: "No more checks." },
    resolveScript: async (_task, script) => {
      const dir = options.stateDir!;
      return { path: path.join(dir, script), cwd: dir };
    },
    execScript: (scriptPath, execOptions) => runScheduledScript(scriptPath, execOptions),
    checkStateDir: async () => path.join(options.stateDir ?? os.tmpdir(), "state"),
    paused: async (task, error) => { cards.push({ taskId: task.id, error }); },
    now: () => clock,
    timeZone: () => "UTC",
    setTimer: () => ({ cancel() {} }),
  });
  const bytes = (text: string): BotWatchCheck => ({ ok: true, bytes: new TextEncoder().encode(text) });
  return {
    tasks, store, triggers, events, cards, persistence, bytes,
    advance: (ms: number) => { clock += ms; },
    async check(taskId = "task-1") {
      const outcome = await triggers.checkNow(taskId);
      await triggers.idle();
      return outcome;
    },
  };
}

test("a watched page that changes runs the task once with what changed", async () => {
  const pages = ["Status: all good", "Status: all good", "Status: degraded"];
  const checks = pages.map((page): BotWatchCheck => ({ ok: true, bytes: new TextEncoder().encode(page) }));
  const local = harness({ checks });
  await local.triggers.start();

  assert.equal(await local.check(), "baseline");
  assert.equal(local.events.length, 0, "the first look only records a baseline");
  local.advance(15 * MINUTE);
  assert.equal(await local.check(), "no_change");
  assert.equal(local.events.length, 0, "an unchanged page runs no model");
  local.advance(15 * MINUTE);
  assert.equal(await local.check(), "changed");

  assert.equal(local.events.length, 1);
  const [{ event, runId, taskId }] = local.events;
  assert.equal(taskId, "task-1");
  assert.equal(event.kind, "event");
  assert.equal(event.source, "watch");
  assert.match(event.payload, /degraded/u);
  assert.match(event.payload, /all good/u, "the payload carries the change, not only the new page");
  assert.equal(runId, `event:task-1:${event.eventId}`);
  local.triggers.stop();
});

test("three failed checks pause the task with one card, and the bookkeeping survives without re-running", async () => {
  const value = harness({ checks: [
    { ok: false, error: "Aiden couldn't reach example.com." },
    { ok: false, error: "Aiden couldn't reach example.com." },
    { ok: false, error: "Aiden couldn't reach example.com." },
  ] });
  await value.triggers.start();
  assert.equal(await value.check(), "error");
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "error");
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "paused");

  assert.equal(value.tasks[0]!.enabled, false, "the task itself is turned off");
  assert.deepEqual(value.cards, [{ taskId: "task-1", error: "Aiden couldn't reach example.com." }]);
  assert.equal(value.events.length, 0);
  value.advance(15 * MINUTE);
  assert.equal(await value.check(), "skipped", "a paused task isn't checked");
  assert.equal(value.cards.length, 1);

  // Turning it back on clears the failures and checks again right away.
  value.tasks[0] = { ...value.tasks[0]!, enabled: true, updatedAt: value.tasks[0]!.updatedAt + 1 };
  const [routine] = await value.store.list("task-1");
  assert.equal(routine!.watch?.failures, 0);
  value.triggers.stop();
});

test("recording a run doesn't retire a change, but editing the prompt or source does", async () => {
  const value = harness();
  const [first] = await value.store.list("task-1");
  // A recorded run bumps the task's own revision; the trigger's stays.
  value.tasks[0] = { ...value.tasks[0]!, updatedAt: 99, lastRunAt: 5 };
  const [afterRun] = await value.store.list("task-1");
  assert.equal(afterRun!.updatedAt, first!.updatedAt);

  value.advance(MINUTE);
  value.tasks[0] = { ...value.tasks[0]!, prompt: "Only tell me about outages." };
  const [edited] = await value.store.list("task-1");
  assert.ok(edited!.updatedAt > first!.updatedAt);

  value.advance(MINUTE);
  value.tasks[0] = { ...value.tasks[0]!, trigger: { kind: "watch", source: { type: "url", url: "https://example.com/other" }, everyMinutes: 15 } };
  const [moved] = await value.store.list("task-1");
  assert.ok(moved!.updatedAt > edited!.updatedAt);
  assert.equal(moved!.watch?.hash, undefined, "a new source starts with a new baseline");

  // A task that loses its trigger leaves no bookkeeping behind.
  value.tasks[0] = { ...value.tasks[0]!, trigger: undefined, cron: "0 9 * * *" };
  assert.deepEqual(await value.store.list("task-1"), []);
  assert.deepEqual((value.persistence.snapshot() as { tasks: Record<string, unknown> }).tasks, {});
});

test("a script watch stays quiet on empty output, reports what it prints, and keeps a capped private state file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-task-trigger-"));
  try {
    // Prints the run count once AIDEN_CHECK_RUNS reaches 2; always appends to its state.
    await fs.writeFile(path.join(dir, "check.sh"), [
      "#!/bin/bash",
      "printf 'run-%s\\n' \"$AIDEN_CHECK_RUNS\" >> \"$AIDEN_CHECK_STATE\"",
      "head -c 9000 /dev/zero | tr '\\0' 'x' >> \"$AIDEN_CHECK_STATE\"",
      "if [ \"$AIDEN_CHECK_RUNS\" -ge 2 ]; then echo \"new build $AIDEN_CHECK_RUNS\"; fi",
    ].join("\n"), { mode: 0o755 });
    const task = watchTask({ permission: "full", trigger: { kind: "watch", source: { type: "script", script: "check.sh" }, everyMinutes: 5 } });
    const value = harness({ tasks: [task], stateDir: dir });
    await value.triggers.start();

    assert.equal(await value.check(), "no_change");
    value.advance(5 * MINUTE);
    assert.equal(await value.check(), "no_change");
    assert.equal(value.events.length, 0, "a quiet script runs no model");
    value.advance(5 * MINUTE);
    assert.equal(await value.check(), "changed");
    assert.equal(value.events.length, 1);
    assert.equal(value.events[0]!.event.payload, "new build 2");

    const stateFile = (await fs.readdir(path.join(dir, "state")))[0]!;
    const state = await fs.readFile(path.join(dir, "state", stateFile), "utf8");
    assert.equal(Buffer.byteLength(state), 8 * 1024, "the state file is capped at 8 KB");
    assert.match(state, /^run-0\n/u, "the state file persists between checks and keeps its start");
    value.triggers.stop();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("trigger runs share one cap of four at once across every task", async () => {
  // Every task watches its own address; each sees "a" first, then "b".
  const tasks = Array.from({ length: 6 }, (_, index) => watchTask({
    id: `task-${index}`,
    trigger: { kind: "watch", source: { type: "url", url: `https://example.com/${index}` }, everyMinutes: 15 },
  }));
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const persistence = new MemoryPersistence<unknown>({ version: 1, tasks: {} });
  let clock = 1_800_000_000_000;
  const store = createScheduledTaskTriggerStore({ persistence, tasks: async () => structuredClone(tasks), pauseTask: async () => {}, now: () => clock });
  const emitted = createScheduledTaskTriggers({
    store,
    isActive: () => true,
    runEvent: async (taskId, _event, runId) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return { id: runId, taskId, startedAt: 0, finishedAt: 0, result: "success", output: "" };
    },
    findRun: async () => undefined,
    fetchUrl: (() => {
      const seen = new Map<string, number>();
      return async (url: string) => {
        const count = seen.get(url) ?? 0;
        seen.set(url, count + 1);
        return { ok: true as const, bytes: new TextEncoder().encode(count === 0 ? "a" : "b") };
      };
    })(),
    resolveScript: async () => { throw new Error("unused"); },
    execScript: async () => { throw new Error("unused"); },
    checkStateDir: async () => os.tmpdir(),
    paused: async () => {},
    now: () => clock,
    timeZone: () => "UTC",
    setTimer: () => ({ cancel() {} }),
  });
  await emitted.start();
  for (const task of tasks) assert.equal(await emitted.checkNow(task.id), "baseline");
  clock += 15 * MINUTE;
  const changes = tasks.map((task) => emitted.checkNow(task.id));
  for (let tick = 0; tick < 50 && releases.length < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(running, 4, "four runs start");
  assert.equal(peak, 4);
  while (releases.length) {
    releases.shift()!();
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(changes);
  await emitted.idle();
  assert.equal(peak, 4, "never more than four at once");
  emitted.stop();
});
