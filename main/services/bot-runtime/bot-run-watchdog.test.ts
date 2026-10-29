import assert from "node:assert/strict";
import test from "node:test";
import { BOT_RUN_STALL_MS, createBotRunWatchdog, createBotRunStalls } from "./bot-run-watchdog.js";

function setup(kind: "routine" | "attended", options: { waiting?: boolean } = {}) {
  let now = 0;
  let progress = 0;
  let waiting = options.waiting ?? false;
  let limited = false;
  const stopped: string[] = [];
  const raised: string[] = [];
  const watchdog = createBotRunWatchdog({
    running: () => ["bot-1"],
    lastProgressAt: () => progress,
    runKind: () => kind,
    isWaitingOnPerson: () => waiting,
    isWaitingOnUsageLimit: () => limited,
    stopForStall: async (botId) => { stopped.push(botId); },
    raiseStall: async (botId) => { raised.push(botId); },
    now: () => now,
    setInterval: () => ({ cancel: () => undefined }),
  });
  return {
    watchdog, stopped, raised,
    at: (value: number) => { now = value; },
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
  assert.deepEqual(h.raised, []);
});

test("never stops or flags a run that waits on the person", async () => {
  const h = setup("routine", { waiting: true });
  h.at(5 * BOT_RUN_STALL_MS);
  await h.watchdog.check();
  const attended = setup("attended", { waiting: true });
  attended.at(5 * BOT_RUN_STALL_MS);
  await attended.watchdog.check();
  assert.deepEqual([...h.stopped, ...h.raised, ...attended.stopped, ...attended.raised], []);
});

test("a run waiting out a usage limit is neither stopped nor flagged, and gets a full window once it clears", async () => {
  const h = setup("routine");
  const attended = setup("attended");
  for (const run of [h, attended]) {
    run.setLimited(true);
    // A 30-minute reset, checked every minute.
    for (let minute = 1; minute <= 30; minute += 1) {
      run.at(minute * 60_000);
      await run.watchdog.check();
    }
    run.setLimited(false);
    run.at(30 * 60_000 + BOT_RUN_STALL_MS - 1);
    await run.watchdog.check();
  }
  assert.deepEqual([...h.stopped, ...h.raised, ...attended.stopped, ...attended.raised], []);
  h.at(30 * 60_000 + BOT_RUN_STALL_MS);
  await h.watchdog.check();
  assert.deepEqual(h.stopped, ["bot-1"], "a run that stays quiet after the limit clears is still stuck");
});

test("an attended run raises one issue and is not stopped", async () => {
  const h = setup("attended");
  h.at(BOT_RUN_STALL_MS);
  await h.watchdog.check();
  h.at(BOT_RUN_STALL_MS + 60_000);
  await h.watchdog.check();
  assert.deepEqual(h.raised, ["bot-1"], "asked once per stall");
  assert.deepEqual(h.stopped, []);
});

test("keep waiting snoozes for another 10 minutes", async () => {
  const h = setup("attended");
  h.at(BOT_RUN_STALL_MS);
  await h.watchdog.check();
  h.at(BOT_RUN_STALL_MS + 1_000);
  h.watchdog.snooze("bot-1");
  h.at(2 * BOT_RUN_STALL_MS);
  await h.watchdog.check();
  assert.equal(h.raised.length, 1);
  h.at(2 * BOT_RUN_STALL_MS + 1_000);
  await h.watchdog.check();
  assert.equal(h.raised.length, 2, "asked again after the snoozed window");
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
