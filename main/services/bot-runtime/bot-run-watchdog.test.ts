import assert from "node:assert/strict";
import test from "node:test";
import { BOT_RUN_STALL_MS, BOT_RUN_WATCHDOG_INTERVAL_MS, createBotRunWatchdog, createBotRunStalls } from "./bot-run-watchdog.js";

function setup(kind: "routine" | "attended", options: { waiting?: boolean } = {}) {
  let now = 0;
  let progress = 0;
  let waiting = options.waiting ?? false;
  let limited = false;
  const stopped: string[] = [];
  const watchdog = createBotRunWatchdog({
    running: () => ["bot-1"],
    lastProgressAt: () => progress,
    runKind: () => kind,
    isWaitingOnPerson: () => waiting,
    isWaitingOnUsageLimit: () => limited,
    stopForStall: async (botId) => { stopped.push(botId); },
    now: () => now,
    setInterval: () => ({ cancel: () => undefined }),
  });
  return {
    watchdog, stopped,
    wakeFromSleep: () => watchdog.resume(),
    at: (value: number) => { now = value; },
    /** Lets the clock run to `value` with the interval checking every minute on the way. */
    advance: async (value: number) => {
      while (now + BOT_RUN_WATCHDOG_INTERVAL_MS < value) {
        now += BOT_RUN_WATCHDOG_INTERVAL_MS;
        await watchdog.check();
      }
      now = value;
    },
    progressAt: (value: number) => { progress = value; },
    setWaiting: (value: boolean) => { waiting = value; },
    setLimited: (value: boolean) => { limited = value; },
  };
}

test("stops a routine run after 10 minutes without progress", async () => {
  const h = setup("routine");
  h.at(BOT_RUN_STALL_MS - 1);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, []);
  h.at(BOT_RUN_STALL_MS);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, ["bot-1"]);
});

test("never stops a run that waits on the person", async () => {
  const h = setup("routine", { waiting: true });
  h.at(5 * BOT_RUN_STALL_MS);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, []);
});

test("a run waiting out a usage limit is not stopped, and gets a full window once it clears", async () => {
  const h = setup("routine");
  h.setLimited(true);
  // A 30-minute reset, checked every minute.
  for (let minute = 1; minute <= 30; minute += 1) {
    h.at(minute * 60_000);
    await h.watchdog.check();
  }
  h.setLimited(false);
  await h.advance(30 * 60_000 + BOT_RUN_STALL_MS - 1);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, []);
  h.at(30 * 60_000 + BOT_RUN_STALL_MS);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, ["bot-1"], "a run that stays quiet after the limit clears is still stuck");
});

test("a run the person started is never stopped, however long it is quiet", async () => {
  const h = setup("attended");
  await h.advance(10 * BOT_RUN_STALL_MS);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, []);
});

test("a snooze gives the run another full window", async () => {
  const h = setup("routine");
  h.at(BOT_RUN_STALL_MS - 1_000);
  h.watchdog.snooze("bot-1");
  h.at(2 * BOT_RUN_STALL_MS - 1_001);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, []);
  h.at(2 * BOT_RUN_STALL_MS - 1_000);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, ["bot-1"]);
});

test("progress resets the timer", async () => {
  const h = setup("routine");
  h.progressAt(8 * 60_000);
  h.at(BOT_RUN_STALL_MS + 60_000);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, []);
});

test("a stall mark is consumed once", () => {
  const stalls = createBotRunStalls();
  stalls.mark("bot-1");
  assert.equal(stalls.consume("bot-1"), true);
  assert.equal(stalls.consume("bot-1"), false);
});

test("time asleep is not a stall: a run gets a fresh window when the computer wakes", async () => {
  const routine = setup("routine");
  // Last progress at 0, then the lid closes for 15 minutes.
  routine.at(15 * 60_000);
  routine.wakeFromSleep();
  await routine.watchdog.check();
  assert.deepEqual(routine.stopped, [], "the first check after wake does not fire");

  // Still no progress a full window after waking: now it is a real stall.
  await routine.advance(15 * 60_000 + BOT_RUN_STALL_MS);
  await routine.watchdog.check();
  assert.deepEqual(routine.stopped, ["bot-1"]);
});

test("a long gap between checks counts as sleep even when the system reports no wake", async () => {
  const routine = setup("routine");
  // Checked every minute, then the timer goes quiet for 15 minutes.
  await routine.advance(3 * 60_000);
  await routine.watchdog.check();
  routine.at(18 * 60_000);
  await routine.watchdog.check();
  assert.deepEqual(routine.stopped, [], "the first check after the gap does not fire");

  await routine.advance(18 * 60_000 + BOT_RUN_STALL_MS - 1);
  await routine.watchdog.check();
  assert.deepEqual(routine.stopped, [], "the window restarts at the wake");
  routine.at(18 * 60_000 + BOT_RUN_STALL_MS);
  await routine.watchdog.check();
  assert.deepEqual(routine.stopped, ["bot-1"]);
});
