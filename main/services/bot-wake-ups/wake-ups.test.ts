import assert from "node:assert/strict";
import test from "node:test";
import { createScheduleServiceCore } from "../schedule-service-core.js";
import { createScheduleStore } from "../schedule-store.js";
import { createBotRoutineCatchUp, createBotRoutineService } from "../scheduled-bot-routines.js";
import type { ScheduledRun } from "../types.js";
import { BOT_WAKE_UP_ENTRY_KIND, botWakeUpWhen } from "../../../renderer/shared/bot-wake-ups.js";
import { createWakeUpTool, type BotWakeUpEntryData } from "./wake-up-tool.js";
import { createBotWakeUps, resolveBotWakeUpTime } from "./wake-ups.js";

class MemoryPersistence<T> {
  constructor(private data: T) {}
  async load(): Promise<T> {
    return structuredClone(this.data);
  }
  async update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    this.data = draft;
    return result;
  }
}

const MINUTE = 60_000;

/** A real schedule store and Bot routine service; nothing ever fires. */
function harness(options: { routineDeleted?: (botId: string, routineId: string) => Promise<void> } = {}) {
  const store = createScheduleStore(new MemoryPersistence<unknown[]>([]), new MemoryPersistence<unknown[]>([]));
  const scheduler = createScheduleServiceCore({
    store,
    execution: {
      run: async () => {
        throw new Error("Nothing fires in these tests.");
      },
      cancel: () => false,
      cancelAll: () => undefined,
    },
    globallyEnabled: async () => true,
    broadcast: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  const routines = createBotRoutineService({
    store,
    service: scheduler,
    botExists: async () => true,
    isPaused: async () => false,
    defaultTimezone: () => "UTC",
    notifyChanged: () => undefined,
    ...(options.routineDeleted ? { routineDeleted: options.routineDeleted } : {}),
  });
  const switches = new Map<string, boolean>();
  const wakeUps = createBotWakeUps({
    store,
    routines,
    timezone: () => "UTC",
    enabled: async (botId) => switches.get(botId) ?? true,
  });
  return { store, scheduler, routines, switches, wakeUps };
}

test("in_minutes is bounded to 1 through 1440 and lands on a whole minute ahead of now", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  for (const inMinutes of [0, -5, 1441, 2.5]) {
    const outcome = await h.wakeUps.set("bot-chef", { when: { inMinutes }, note: "Check the oven." });
    assert.equal(outcome.ok, false, `in_minutes ${inMinutes}`);
    if (!outcome.ok) assert.equal(outcome.code, "invalid_time");
  }
  const before = Date.now();
  const soon = await h.wakeUps.set("bot-chef", { when: { inMinutes: 1 }, note: "Check the oven." });
  const late = await h.wakeUps.set("bot-chef", { when: { inMinutes: 1440 }, note: "Ask how the bake went." });
  assert.ok(soon.ok && late.ok);
  assert.equal(soon.wakeUp.fireAt % MINUTE, 0);
  assert.ok(soon.wakeUp.fireAt >= before + 30_000 && soon.wakeUp.fireAt <= Date.now() + MINUTE + 30_000);
  assert.ok(late.wakeUp.fireAt <= Date.now() + 1440 * MINUTE && late.wakeUp.fireAt > before + 1439 * MINUTE - 1_000);
  assert.deepEqual(
    (await h.routines.list("bot-chef")).map((routine) => [routine.name, routine.wakeUp !== undefined, routine.enabled]),
    [
      ["Wake-up", true, true],
      ["Wake-up", true, true],
    ],
  );
});

test("a local time means its next occurrence within a day, in the host's zone", () => {
  const now = Date.UTC(2026, 9, 28, 14, 0); // 10:00 in New York
  assert.deepEqual(resolveBotWakeUpTime({ at: "15:10" }, now, "America/New_York"), {
    fireAt: Date.UTC(2026, 9, 28, 19, 10),
    schedule: { kind: "once", date: "2026-10-28", time: "15:10" },
  });
  assert.deepEqual(resolveBotWakeUpTime({ at: "09:00" }, now, "America/New_York")?.schedule, {
    kind: "once",
    date: "2026-10-29",
    time: "09:00",
  });
  for (const at of ["24:00", "9:00", "3:10 PM", "tomorrow", ""]) {
    assert.equal(resolveBotWakeUpTime({ at }, now, "UTC"), undefined, at);
  }
});

test("in_minutes never lands on a minute less than 30 seconds away", () => {
  const now = Date.UTC(2026, 9, 28, 14, 0, 45);
  assert.equal(resolveBotWakeUpTime({ inMinutes: 1 }, now, "UTC")?.fireAt, Date.UTC(2026, 9, 28, 14, 2));
  assert.equal(resolveBotWakeUpTime({ inMinutes: 1 }, Date.UTC(2026, 9, 28, 14, 0, 20), "UTC")?.fireAt, Date.UTC(2026, 9, 28, 14, 1));
});

test("a delay into the repeated hour of a daylight-saving change is refused instead of firing an hour early", () => {
  // 00:45 EDT on the night New York falls back: 01:00-01:59 happens twice.
  const now = Date.UTC(2026, 10, 1, 4, 45);
  // 105 minutes is 06:30Z, the second 01:30 (EST); the schedule would fire at the first (05:30Z).
  assert.equal(resolveBotWakeUpTime({ inMinutes: 105 }, now, "America/New_York"), undefined);
  assert.deepEqual(resolveBotWakeUpTime({ inMinutes: 45 }, now, "America/New_York"), {
    fireAt: Date.UTC(2026, 10, 1, 5, 30),
    schedule: { kind: "once", date: "2026-11-01", time: "01:30" },
  });
  assert.deepEqual(resolveBotWakeUpTime({ inMinutes: 135 }, now, "America/New_York"), {
    fireAt: Date.UTC(2026, 10, 1, 7, 0),
    schedule: { kind: "once", date: "2026-11-01", time: "02:00" },
  });
});

test("the note is required and at most 500 characters", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  for (const note of ["", "   ", "x".repeat(501)]) {
    const outcome = await h.wakeUps.set("bot-chef", { when: { inMinutes: 5 }, note });
    assert.equal(outcome.ok ? "ok" : outcome.code, "invalid_note");
  }
  assert.equal((await h.wakeUps.set("bot-chef", { when: { inMinutes: 5 }, note: "x".repeat(500) })).ok, true);
});

test("a fourth pending wake-up is refused with the three it would join, and cancelling one makes room", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const ids: string[] = [];
  for (const minutes of [30, 10, 20]) {
    const outcome = await h.wakeUps.set("bot-chef", { when: { inMinutes: minutes }, note: `In ${minutes}` });
    assert.ok(outcome.ok);
    ids.push(outcome.wakeUp.id);
  }
  // Another Bot's wake-ups never count against this one.
  assert.equal((await h.wakeUps.set("bot-scout", { when: { inMinutes: 5 }, note: "Mine." })).ok, true);

  const refused = await h.wakeUps.set("bot-chef", { when: { inMinutes: 5 }, note: "One more." });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.code, "too_many_pending");
  assert.deepEqual(
    refused.pending?.map((wakeUp) => wakeUp.note),
    ["In 10", "In 20", "In 30"],
    "the pending list comes soonest first",
  );

  const missing = await h.wakeUps.cancel("bot-chef", "no-such-wake-up");
  assert.equal(missing.ok ? "ok" : missing.code, "not_found");
  assert.equal((await h.wakeUps.cancel("bot-scout", ids[0]!)).ok, false, "a Bot cannot cancel another Bot's wake-up");

  const cancelled = await h.wakeUps.cancel("bot-chef", ids[0]!);
  assert.ok(cancelled.ok);
  assert.equal(cancelled.cancelled.note, "In 30");
  assert.equal(await h.store.get(ids[0]!), undefined, "a cancelled wake-up is gone, not paused");
  assert.equal((await h.wakeUps.set("bot-chef", { when: { inMinutes: 5 }, note: "Now there's room." })).ok, true);
});

test("two wake-ups set at once cannot both slip past the cap", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const outcomes = await Promise.all(
    [1, 2, 3, 4, 5].map((minutes) => h.wakeUps.set("bot-chef", { when: { inMinutes: minutes }, note: `n${minutes}` })),
  );
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 3);
  assert.equal((await h.wakeUps.pending("bot-chef")).length, 3);
});

test("with the Bot's switch off nothing is set, and turning it off cancels its wake-ups but not its routines", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Morning check",
    schedule: { kind: "daily", time: "09:00" },
    prompt: "Anything due today?",
  });
  await h.wakeUps.set("bot-chef", { when: { inMinutes: 15 }, note: "Check the oven." });
  await h.wakeUps.set("bot-chef", { when: { inMinutes: 45 }, note: "Ask about dessert." });

  h.switches.set("bot-chef", false);
  assert.equal(await h.wakeUps.cancelAll("bot-chef"), 2);
  assert.deepEqual(
    (await h.routines.list("bot-chef")).map((each) => each.id),
    [routine.id],
    "the person's own routines stay",
  );
  const off = await h.wakeUps.set("bot-chef", { when: { inMinutes: 15 }, note: "Check again." });
  assert.equal(off.ok ? "ok" : off.code, "off");
  assert.deepEqual(await h.wakeUps.pending("bot-chef"), []);
});

test("turning the switch off also removes a wake-up that fired while the Bot was paused, so Resume can't run it", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const set = await h.wakeUps.set("bot-chef", { when: { inMinutes: 15 }, note: "Check the oven." });
  assert.ok(set.ok);
  // Its fire was claimed while the Bot was paused: spent, skipped, owed a catch-up.
  const skippedAt = Date.now();
  await h.store.updateRuntime(set.wakeUp.id, { enabled: false, nextRunAt: undefined, lastRunAt: skippedAt, lastResult: "skipped" });
  const caughtUp: string[] = [];
  const catchUp = createBotRoutineCatchUp({
    store: {
      list: () => h.store.list(),
      runs: async () => [{ id: "run-1", result: "skipped", reason: "bot_paused", startedAt: skippedAt } as ScheduledRun],
    },
    scheduler: {
      catchUp: (id) => {
        caughtUp.push(id);
        return Promise.resolve({} as ScheduledRun);
      },
    },
  });
  assert.equal((await catchUp.catchUp("bot-chef")).length, 1, "while the switch is on, Resume would run it");

  h.switches.set("bot-chef", false);
  assert.equal(await h.wakeUps.cancelAll("bot-chef"), 1);
  caughtUp.length = 0;
  assert.deepEqual(await catchUp.catchUp("bot-chef"), []);
  assert.deepEqual(caughtUp, []);
  assert.equal(await h.store.get(set.wakeUp.id), undefined);
});

test("the Bot's own cancel and set return while a removed wake-up's cleanup waits for the Bot's chat", async (t) => {
  // The cleanup settles the wake-up's issues by appending to the Bot's chat,
  // which waits until the calling tool's turn ends.
  let release!: () => void;
  const chatFree = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleaned: string[] = [];
  const h = harness({
    routineDeleted: async (_botId, routineId) => {
      await chatFree;
      cleaned.push(routineId);
    },
  });
  t.after(() => h.scheduler.stop());
  const withinTurn = <T>(work: Promise<T>) =>
    Promise.race([work, new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 1_000))]);

  const old = await h.wakeUps.set("bot-chef", { when: { inMinutes: 15 }, note: "Long ago." });
  const current = await h.wakeUps.set("bot-chef", { when: { inMinutes: 30 }, note: "Soon." });
  assert.ok(old.ok && current.ok);
  // The old one fired eight days ago, past the catch-up window: the next set prunes it.
  await h.store.updateRuntime(old.wakeUp.id, {
    enabled: false,
    nextRunAt: undefined,
    lastRunAt: Date.now() - 8 * 24 * 60 * MINUTE,
    lastResult: "success",
  });

  const tool = createWakeUpTool("bot-chef", h.wakeUps, async () => undefined);
  const cancelled = await withinTurn(run(tool, { action: "cancel", id: current.wakeUp.id }));
  assert.notEqual(cancelled, "stuck");
  const again = await withinTurn(run(tool, { action: "set", in_minutes: 45, note: "Later." }));
  assert.notEqual(again, "stuck");
  assert.equal(await h.store.get(old.wakeUp.id), undefined, "the spent wake-up was pruned");
  assert.deepEqual(cleaned, []);

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cleaned.sort(), [current.wakeUp.id, old.wakeUp.id].sort(), "each removed wake-up still settles");
});

test("turning the switch off returns while the removed wake-ups' cleanup waits, and a call queued behind it answers off", async (t) => {
  // The cleanup appends to the Bot's chat, which a Pause can hold until the
  // Bot's current tool call ends, and that call can be queued behind the switch.
  let release!: () => void;
  const chatFree = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleaned: string[] = [];
  const h = harness({
    routineDeleted: async (_botId, routineId) => {
      await chatFree;
      cleaned.push(routineId);
    },
  });
  t.after(() => h.scheduler.stop());
  const routine = await h.routines.create({
    botId: "bot-chef",
    name: "Morning check",
    schedule: { kind: "daily", time: "09:00" },
    prompt: "Anything due today?",
  });
  const first = await h.wakeUps.set("bot-chef", { when: { inMinutes: 15 }, note: "Check the oven." });
  const second = await h.wakeUps.set("bot-chef", { when: { inMinutes: 45 }, note: "Ask about dessert." });
  assert.ok(first.ok && second.ok);

  h.switches.set("bot-chef", false);
  const tool = createWakeUpTool("bot-chef", h.wakeUps, async () => undefined);
  const stuck = new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 1_000));
  const [switchedOff, queued] = await Promise.all([
    Promise.race([h.wakeUps.cancelAll("bot-chef"), stuck]),
    Promise.race([run(tool, { action: "set", in_minutes: 20, note: "Check again." }), stuck]),
  ]);
  assert.equal(switchedOff, 2);
  assert.notEqual(queued, "stuck");
  if (queued !== "stuck") assert.equal(queued.body.code, "off");
  assert.deepEqual((await h.routines.list("bot-chef")).map((each) => each.id), [routine.id]);
  assert.deepEqual(cleaned, []);

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cleaned.sort(), [first.wakeUp.id, second.wakeUp.id].sort(), "each removed wake-up still settles");
});

function run(tool: ReturnType<typeof createWakeUpTool>, params: Record<string, unknown>) {
  return tool.execute("call-1", params as never, undefined).then((outcome) => ({
    isError: (outcome as { isError?: boolean }).isError === true,
    body: JSON.parse((outcome.content[0] as { text: string }).text) as Record<string, unknown>,
  }));
}

test("the tool sets a wake-up with a chat chip, lists it, and cancels it by id", async (t) => {
  const h = harness();
  t.after(() => h.scheduler.stop());
  const chips = [] as Array<{ kind: string; data: BotWakeUpEntryData }>;
  const tool = createWakeUpTool("bot-chef", h.wakeUps, async (kind, data) => {
    chips.push({ kind, data });
  });

  const both = await run(tool, { action: "set", in_minutes: 5, at: "15:10", note: "Check." });
  assert.equal(both.isError, true);
  assert.equal(both.body.code, "invalid_time");
  const neither = await run(tool, { action: "set", note: "Check." });
  assert.equal(neither.body.code, "invalid_time");
  assert.equal(chips.length, 0, "a refused set shows nothing in the chat");

  const set = await run(tool, { action: "set", in_minutes: 20, note: "  See if the dough rose.  " });
  assert.equal(set.isError, false);
  const wakeUp = set.body.wakeUp as { id: string; at: string; note: string };
  assert.equal(wakeUp.note, "See if the dough rose.");
  assert.match(wakeUp.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
  assert.equal(chips.length, 1);
  assert.equal(chips[0]?.kind, BOT_WAKE_UP_ENTRY_KIND);
  assert.equal(chips[0]?.data.wakeUpId, wakeUp.id);
  assert.equal(chips[0]?.data.fireAt, (await h.store.get(wakeUp.id))?.nextRunAt);

  const listed = await run(tool, { action: "list" });
  assert.deepEqual(listed.body.pending, [wakeUp]);

  const cancelled = await run(tool, { action: "cancel", id: wakeUp.id });
  assert.equal(cancelled.isError, false);
  assert.deepEqual((await run(tool, { action: "list" })).body.pending, []);
  const again = await run(tool, { action: "cancel", id: wakeUp.id });
  assert.equal(again.isError, true);
  assert.equal(again.body.code, "not_found");
});

test("the chip names when the wake-up fires the way the person reads a clock", () => {
  const now = Date.UTC(2026, 9, 28, 14, 0);
  assert.equal(botWakeUpWhen(Date.UTC(2026, 9, 28, 15, 10), now, "UTC"), "at 3:10 PM");
  assert.equal(botWakeUpWhen(Date.UTC(2026, 9, 29, 9, 0), now, "UTC"), "tomorrow at 9:00 AM");
  assert.equal(botWakeUpWhen(Date.UTC(2026, 9, 31, 9, 0), now, "UTC"), "on Oct 31 at 9:00 AM");
});
