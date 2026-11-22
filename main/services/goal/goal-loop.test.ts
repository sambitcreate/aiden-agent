// The keep-going loop with fake chats: rounds, pre-checks, the person's
// actions racing a review, and what it reports.

import assert from "node:assert/strict";
import { test } from "node:test";
import { GOAL_MAX_ROUNDS, type GoalRecordV1, type GoalView } from "../../../renderer/shared/goal.js";
import type { AgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";
import { createGoal, type GoalRoundActivity } from "./goal-core.js";
import { GoalLoop, type GoalAnalyticsEvent, type GoalRoundStart } from "./goal-loop.js";
import type { GoalReviewOutcome } from "./goal-reviewer.js";

const CHAT = "chat-1";

function last<T>(values: readonly T[]): T | undefined {
  return values[values.length - 1];
}
const BOOT = "boot-a";
const CONTEXT = { providerId: "anthropic", model: "claude" };

type Review = (goal: GoalRecordV1, input: { allowWait: boolean; signal: AbortSignal }) => Promise<GoalReviewOutcome>;

function continueWith(reason: string): GoalReviewOutcome {
  return { kind: "verdict", verdict: { verdict: "continue", reason }, via: "continuation" };
}

function harness(options: { enabled?: boolean; refusal?: string } = {}) {
  let clock = 1_000;
  let ids = 0;
  let reviewCount = 0;
  const state = {
    busy: false,
    helper: false,
    jobs: false,
    activity: { toolCalls: 1, newTextChars: 0 } as GoalRoundActivity,
    roundStart: "started" as GoalRoundStart,
    review: (async (goal) => continueWith(`Next step ${goal.rounds}`)) as Review,
  };
  const rounds: Array<{ text: string; notice: AgentNoticeV1 }> = [];
  const events: GoalAnalyticsEvent[] = [];
  const changes: Array<GoalView | null> = [];
  const saved: GoalRecordV1[][] = [];
  const settled: GoalRecordV1[] = [];
  const loop = new GoalLoop({
    enabled: () => options.enabled ?? true,
    boot: BOOT,
    now: () => clock,
    newId: () => `goal-${++ids}`,
    delay: (_ms, signal) => (signal.aborted ? Promise.reject(signal.reason) : Promise.resolve()),
    setTimer: () => () => {},
    persist: (goals) => saved.push([...goals]),
    onChange: (_chatId, goal) => changes.push(goal),
    eligibility: async () => options.refusal,
    isChatBusy: () => state.busy,
    helperRunning: () => state.helper,
    jobsRunning: () => state.jobs,
    roundActivity: async () => state.activity,
    fallbackContext: async () => CONTEXT,
    review: (goal, input) => {
      reviewCount += 1;
      return state.review(goal, input);
    },
    startRound: async (_chatId, _context, round) => {
      rounds.push(round);
      return state.roundStart;
    },
    report: (event) => events.push(event),
    settled: (goal) => settled.push(goal),
    log: () => {},
  });
  async function flush() {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  /** A run in the chat settles and the loop finishes looking at it. */
  async function runSettles(run: { stopped?: boolean; failed?: boolean } = {}) {
    loop.runSettled({ chatId: CHAT, streamId: "s", context: CONTEXT, stopped: run.stopped ?? false, failed: run.failed ?? false });
    await flush();
  }
  return {
    loop,
    state,
    rounds,
    events,
    changes,
    saved,
    settled,
    runSettles,
    flush,
    reviews: () => reviewCount,
    tick: (ms: number) => (clock += ms),
    goal: () => loop.get(CHAT),
  };
}

test("setting a goal reports it, gives the kickoff note once and reminds only while active", async () => {
  const h = harness();
  const view = await h.loop.set(CHAT, { objective: "Make the tests pass", source: "slash" });
  assert.equal(view.status, "active");
  assert.equal(view.rounds, 1);
  assert.deepEqual(h.events, [{ event: "goal_started", properties: { source: "slash" } }]);
  assert.equal(last(h.saved)?.length, 1, "the goal is saved");

  const kickoff = h.loop.kickoff(CHAT);
  assert.match(kickoff ?? "", /Make the tests pass/);
  assert.equal(h.loop.kickoff(CHAT), undefined, "the kickoff is given once");
  assert.match(h.loop.reminder(CHAT) ?? "", /Make the tests pass/);

  h.loop.pause(CHAT);
  assert.equal(h.loop.reminder(CHAT), undefined, "no reminder for a paused goal");
});

test("set is refused while the loop is off, for an ineligible chat, and for a command goal without a check runner", async () => {
  await assert.rejects(harness({ enabled: false }).loop.set(CHAT, { objective: "x", source: "slash" }), /aren't available/);
  await assert.rejects(harness({ refusal: "Bots keep their own goals." }).loop.set(CHAT, { objective: "x", source: "menu" }), /Bots keep/);
  const h = harness();
  await assert.rejects(h.loop.set(CHAT, { objective: "x", source: "until", check: "npm test" }), /command/);
  await assert.rejects(h.loop.set(CHAT, { objective: "   ", source: "slash" }));
  assert.equal(h.goal(), null);
  assert.deepEqual(h.events, []);
});

test("a continue verdict starts the next round as a 'Keep going' card", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  h.state.review = async () => continueWith("Write the migration next");
  await h.runSettles();
  assert.equal(h.goal()?.rounds, 2);
  assert.equal(h.rounds.length, 1);
  assert.equal(h.rounds[0]!.notice.source, "goal");
  assert.equal(h.rounds[0]!.notice.title, "Keep going · round 2 of 50");
  assert.match(h.rounds[0]!.text, /Write the migration next/);
});

test("Stop, a failed answer and a restart pause the goal without asking the reviewer", async () => {
  const stopped = harness();
  await stopped.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  await stopped.runSettles({ stopped: true });
  assert.equal(stopped.goal()?.status, "paused");
  assert.equal(stopped.goal()?.cause, "stopped");

  const failed = harness();
  await failed.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  await failed.runSettles({ failed: true });
  assert.equal(failed.goal()?.cause, "failed");
  assert.deepEqual(last(failed.events), { event: "goal_settled", properties: { outcome: "paused", rounds: "1" } });
  assert.equal(stopped.reviews() + failed.reviews(), 0);
  assert.equal(stopped.rounds.length + failed.rounds.length, 0);

  const created = createGoal({ id: "goal-old", chatId: CHAT, objective: "Ship it", source: "slash", boot: "boot-before", now: 1 });
  assert.ok(created.ok);
  const restarted = harness();
  restarted.loop.restore([created.goal]);
  assert.equal(restarted.goal()?.status, "paused");
  assert.equal(restarted.goal()?.cause, "restart");
  assert.equal(last(restarted.saved)?.[0]?.status, "paused", "the paused goal is saved");
});

test("a goal pauses at the 50-round limit, and Keep going starts again from round 1 with no stalls", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Refactor everything", source: "menu" });
  for (let round = 1; round <= GOAL_MAX_ROUNDS; round += 1) await h.runSettles();
  assert.equal(h.rounds.length, GOAL_MAX_ROUNDS - 1, "rounds 2 to 50 started");
  assert.equal(h.goal()?.status, "paused");
  assert.equal(h.goal()?.cause, "round-limit");
  assert.deepEqual(last(h.events), { event: "goal_settled", properties: { outcome: "paused", rounds: "50" } });
  assert.equal(h.settled.length, 1);

  const resumed = await h.loop.resume(CHAT);
  assert.equal(resumed?.status, "active");
  assert.equal(resumed?.rounds, 1);
  assert.equal(resumed?.stalls, 0);
  assert.equal(h.rounds.length, GOAL_MAX_ROUNDS, "Keep going starts a round in the idle chat");
  assert.equal(last(h.rounds)!.notice.title, "Keep going · round 1 of 50");
});

test("three quiet rounds in a row stall the goal, but a long answer is progress", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Write the essay", source: "slash" });
  h.state.activity = { toolCalls: 0, newTextChars: 2_000 };
  for (let i = 0; i < 4; i += 1) await h.runSettles();
  assert.equal(h.goal()?.status, "active", "long answers without tools are not stalls");
  assert.equal(h.goal()?.stalls, 0);

  h.state.activity = { toolCalls: 0, newTextChars: 20 };
  for (let i = 0; i < 3; i += 1) await h.runSettles();
  assert.equal(h.goal()?.status, "paused");
  assert.equal(h.goal()?.cause, "stalled");
});

test("a running helper holds the goal without a review or a round", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  h.state.helper = true;
  await h.runSettles();
  assert.equal(h.reviews(), 0);
  assert.equal(h.rounds.length, 0);
  assert.equal(h.goal()?.status, "active");
});

test("the person's send wins over the loop: a busy chat is neither reviewed nor given a round", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  h.state.busy = true;
  await h.runSettles();
  assert.equal(h.reviews(), 0, "a queued send settles later and the loop looks again");

  h.state.busy = false;
  h.state.review = async () => {
    h.state.busy = true; // the person sent while the review ran
    return continueWith("Keep going on the parser");
  };
  await h.runSettles();
  assert.equal(h.goal()?.rounds, 2, "the verdict is kept");
  assert.equal(h.rounds.length, 0, "their send is this round's work");
});

test("the person's pause during a review wins over its verdict", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  let signal: AbortSignal | undefined;
  let finish: (outcome: GoalReviewOutcome) => void = () => {};
  h.state.review = (_goal, input) => {
    signal = input.signal;
    return new Promise((resolve) => (finish = resolve));
  };
  h.loop.runSettled({ chatId: CHAT, streamId: "s", context: CONTEXT, stopped: false, failed: false });
  await h.flush();
  assert.equal(h.reviews(), 1);

  h.loop.pause(CHAT);
  assert.equal(signal?.aborted, true, "the review is cancelled");
  finish(continueWith("Keep going"));
  await h.flush();
  assert.equal(h.goal()?.status, "paused");
  assert.equal(h.goal()?.cause, "person");
  assert.equal(h.rounds.length, 0);
});

test("clearing during a review leaves no goal behind and reports it cleared", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  let finish: (outcome: GoalReviewOutcome) => void = () => {};
  h.state.review = () => new Promise((resolve) => (finish = resolve));
  h.loop.runSettled({ chatId: CHAT, streamId: "s", context: CONTEXT, stopped: false, failed: false });
  await h.flush();
  h.loop.clear(CHAT);
  finish(continueWith("Keep going"));
  await h.flush();
  assert.equal(h.goal(), null);
  assert.equal(last(h.changes), null);
  assert.deepEqual(last(h.events), { event: "goal_settled", properties: { outcome: "cleared", rounds: "1" } });
});

test("verdicts settle the goal: done, needs you, and an unusable review twice pauses it", async () => {
  const done = harness();
  await done.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  done.state.review = async () => ({ kind: "verdict", verdict: { verdict: "done", reason: "All tests pass" }, via: "continuation" });
  await done.runSettles();
  assert.equal(done.goal()?.status, "done");
  assert.equal(done.goal()?.reason, "All tests pass");
  assert.deepEqual(last(done.events), { event: "goal_settled", properties: { outcome: "done", rounds: "1" } });

  const blocked = harness();
  await blocked.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  blocked.state.review = async () => ({ kind: "verdict", verdict: { verdict: "blocked", reason: "Needs an API key" }, via: "isolated" });
  await blocked.runSettles();
  assert.equal(blocked.goal()?.status, "needs-you");
  assert.deepEqual(last(blocked.events), { event: "goal_settled", properties: { outcome: "needs_you", rounds: "1" } });

  const unusable = harness();
  await unusable.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  unusable.state.review = async () => ({ kind: "unusable", why: "no-verdict", via: "continuation" });
  await unusable.runSettles();
  assert.equal(unusable.reviews(), 2, "one retry");
  assert.equal(unusable.goal()?.status, "paused");
  assert.equal(unusable.goal()?.cause, "reviewer");
});

test("a spending refusal pauses the goal", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  h.state.review = async () => ({ kind: "refused", message: "Over the limit" });
  await h.runSettles();
  assert.equal(h.goal()?.status, "paused");
  assert.equal(h.goal()?.cause, "spending");
  assert.equal(h.rounds.length, 0);
});

test("a round that cannot start pauses the goal", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  h.state.roundStart = "unavailable";
  await h.runSettles();
  assert.equal(h.goal()?.status, "paused");
  assert.equal(h.goal()?.cause, "failed");
  assert.equal(h.goal()?.reason, "The next round could not start");
});

test("the loop offers wait only while background jobs run", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  const offered: boolean[] = [];
  h.state.review = async (goal, input) => {
    offered.push(input.allowWait);
    return continueWith(`Step ${goal.rounds}`);
  };
  await h.runSettles();
  h.state.jobs = true;
  await h.runSettles();
  assert.deepEqual(offered, [false, true]);
});

test("access changes pause an active goal, a moving chat is refused while it is active, and deletion forgets it", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  assert.match(h.loop.moveRefusal(CHAT) ?? "", /Pause or clear/);
  h.loop.accessChanged([CHAT]);
  assert.equal(h.goal()?.cause, "access-changed");
  assert.equal(h.loop.moveRefusal(CHAT), undefined);
  h.loop.deleteChat(CHAT);
  assert.equal(h.goal(), null);
  assert.deepEqual(last(h.saved), []);
});

test("after shutdown, runs that settle (the quit's own aborts) leave the goal alone", async () => {
  const h = harness();
  await h.loop.set(CHAT, { objective: "Ship it", source: "slash" });
  h.loop.shutdown();
  await h.runSettles({ stopped: true });
  assert.equal(h.goal()?.status, "active", "the next launch restores it as paused after a restart");
  assert.equal(h.reviews(), 0);
});
