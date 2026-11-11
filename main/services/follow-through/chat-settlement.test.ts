// When a quiet chat's opted-in jobs stop. Time is faked; the job registry is a
// small stand-in that records which chats were asked to stop, since the real
// stop (process groups and the `chat-settled` reason) is covered with real
// processes in background-jobs.test.ts.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { ChatSettlement } from "./chat-settlement.js";

const MINUTE = 60_000;

function harness(t: test.TestContext, options: { stoppable?: Set<string>; busy?: Set<string> } = {}) {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const stoppable = options.stoppable ?? new Set(["chat-1"]);
  const busy = options.busy ?? new Set<string>();
  const stopped: string[] = [];
  const settlement = new ChatSettlement({
    hasStoppableJobs: (chatId) => stoppable.has(chatId),
    isChatBusy: (chatId) => busy.has(chatId),
    stopSettled: async (chatId) => {
      stopped.push(chatId);
      stoppable.delete(chatId);
    },
  });
  const advance = async (ms: number) => {
    mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { settlement, stoppable, busy, stopped, advance };
}

test("an opted-in job stops twenty minutes after the chat's answer ends, not before", async (t) => {
  const { settlement, stopped, advance } = harness(t);
  settlement.runStarted("chat-1", "run-1");
  await advance(30 * MINUTE);
  assert.deepEqual(stopped, [], "nothing stops while the answer runs");
  settlement.runEnded("chat-1", "run-1");
  await advance(20 * MINUTE - 1);
  assert.deepEqual(stopped, []);
  await advance(1);
  assert.deepEqual(stopped, ["chat-1"]);
});

test("a new answer cancels the window, and its end starts a fresh one", async (t) => {
  const { settlement, stopped, advance } = harness(t);
  settlement.runStarted("chat-1", "run-1");
  settlement.runEnded("chat-1", "run-1");
  await advance(15 * MINUTE);
  settlement.runStarted("chat-1", "run-2");
  await advance(30 * MINUTE);
  assert.deepEqual(stopped, [], "a running answer keeps the jobs");
  settlement.runEnded("chat-1", "run-2");
  await advance(19 * MINUTE);
  assert.deepEqual(stopped, [], "the window restarted when the second answer ended");
  await advance(MINUTE);
  assert.deepEqual(stopped, ["chat-1"]);
});

test("the chat is quiet only once all of its answers have ended", async (t) => {
  const { settlement, stopped, advance } = harness(t);
  settlement.runStarted("chat-1", "run-1");
  settlement.runStarted("chat-1", "run-2");
  settlement.runEnded("chat-1", "run-1");
  await advance(40 * MINUTE);
  assert.deepEqual(stopped, []);
  settlement.runEnded("chat-1", "run-2");
  await advance(20 * MINUTE);
  assert.deepEqual(stopped, ["chat-1"]);
});

test("a chat without opted-in jobs is never stopped", async (t) => {
  const { settlement, stopped, advance } = harness(t, { stoppable: new Set() });
  settlement.runStarted("chat-1", "run-1");
  settlement.runEnded("chat-1", "run-1");
  settlement.jobsChanged("chat-1");
  await advance(5 * 60 * MINUTE);
  assert.deepEqual(stopped, []);
  assert.equal(settlement.isArmed("chat-1"), false);
});

test("the person reading a job's output starts the window over; their absence does not", async (t) => {
  const { settlement, stopped, advance } = harness(t);
  settlement.runEnded("chat-1", "run-1");
  await advance(18 * MINUTE);
  settlement.personActive("chat-1");
  await advance(18 * MINUTE);
  assert.deepEqual(stopped, [], "reading restarted the window");
  await advance(2 * MINUTE);
  assert.deepEqual(stopped, ["chat-1"]);
});

test("reading output while an answer runs does not start a window early", async (t) => {
  const { settlement, stopped, advance } = harness(t);
  settlement.runStarted("chat-1", "run-1");
  settlement.personActive("chat-1");
  await advance(60 * MINUTE);
  assert.deepEqual(stopped, []);
  assert.equal(settlement.isArmed("chat-1"), false);
});

test("a chat that is still busy without a running answer waits another window", async (t) => {
  const { settlement, busy, stopped, advance } = harness(t, { busy: new Set(["chat-1"]) });
  settlement.runEnded("chat-1", "run-1");
  await advance(20 * MINUTE);
  assert.deepEqual(stopped, [], "a follow-up waiting to be answered keeps the jobs");
  assert.equal(settlement.isArmed("chat-1"), true);
  busy.delete("chat-1");
  await advance(20 * MINUTE);
  assert.deepEqual(stopped, ["chat-1"]);
});

test("a job started outside an answer arms the window; the last opted-in job ending clears it", async (t) => {
  const { settlement, stoppable, stopped, advance } = harness(t, { stoppable: new Set() });
  stoppable.add("chat-1");
  settlement.jobsChanged("chat-1");
  assert.equal(settlement.isArmed("chat-1"), true);
  stoppable.delete("chat-1");
  settlement.jobsChanged("chat-1");
  assert.equal(settlement.isArmed("chat-1"), false);
  await advance(60 * MINUTE);
  assert.deepEqual(stopped, []);
});

test("other output from the jobs does not restart a running window", async (t) => {
  const { settlement, stopped, advance } = harness(t);
  settlement.runEnded("chat-1", "run-1");
  await advance(10 * MINUTE);
  settlement.jobsChanged("chat-1");
  await advance(10 * MINUTE);
  assert.deepEqual(stopped, ["chat-1"]);
});

test("deleting a chat clears its window, and other chats keep theirs", async (t) => {
  const { settlement, stopped, advance } = harness(t, { stoppable: new Set(["chat-1", "chat-2"]) });
  settlement.runEnded("chat-1", "run-1");
  settlement.runEnded("chat-2", "run-2");
  settlement.clear("chat-1");
  await advance(20 * MINUTE);
  assert.deepEqual(stopped, ["chat-2"]);
});

test("a stop that could not be confirmed is tried again after another window", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let attempts = 0;
  const settlement = new ChatSettlement({
    hasStoppableJobs: () => attempts < 2,
    isChatBusy: () => false,
    stopSettled: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("could not confirm");
    },
  });
  const advance = async (ms: number) => {
    mock.timers.tick(ms);
    for (let round = 0; round < 3; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  settlement.runEnded("chat-1", "run-1");
  await advance(20 * MINUTE);
  assert.equal(attempts, 1);
  assert.equal(settlement.isArmed("chat-1"), true);
  await advance(20 * MINUTE);
  assert.equal(attempts, 2);
  assert.equal(settlement.isArmed("chat-1"), false);
});

test("after quitting nothing is stopped for being quiet, and a new launch starts with no windows", async (t) => {
  const { settlement, stopped, advance } = harness(t);
  settlement.runEnded("chat-1", "run-1");
  settlement.shutdown();
  settlement.runEnded("chat-1", "run-2");
  settlement.jobsChanged("chat-1");
  await advance(60 * MINUTE);
  assert.deepEqual(stopped, []);
  const stoppedAfterRelaunch: string[] = [];
  const relaunched = new ChatSettlement({
    hasStoppableJobs: () => true,
    isChatBusy: () => false,
    stopSettled: async (chatId) => {
      stoppedAfterRelaunch.push(chatId);
    },
  });
  assert.equal(relaunched.isArmed("chat-1"), false, "windows are not saved across a restart");
  await advance(60 * MINUTE);
  assert.deepEqual(stoppedAfterRelaunch, []);
});
