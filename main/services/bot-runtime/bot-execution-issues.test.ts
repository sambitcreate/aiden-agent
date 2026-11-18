import assert from "node:assert/strict";
import test from "node:test";
import type { BotExecutionClaim } from "../bot-routine-models.js";
import { BOT_EXECUTION_RETRY_DELAYS_MS, createBotExecutionIssues, type BotExecutionRetryResult } from "./bot-execution-issues.js";

const claim = { id: "claim-1", botId: "bot-1", requestId: "req-1", root: { botId: "bot-1", requestId: "req-1" } } as unknown as BotExecutionClaim;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(answers: BotExecutionRetryResult[] = [], pendingDispatch?: string) {
  const raised: { dedupeKey: string; title: string; quiet?: true }[] = [];
  const resolved: [string, string][] = [];
  const tries: number[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const issues = createBotExecutionIssues(
    {
      raise: async (input) => { raised.push({ dedupeKey: input.dedupeKey, title: input.title, ...(input.quiet ? { quiet: true as const } : {}) }); return input as never; },
      resolve: async (_botId, key, resolution) => { resolved.push([key, resolution]); return true; },
    },
    { pendingDispatch: async () => (pendingDispatch ? { dispatchId: pendingDispatch } as never : undefined) },
    {
      retry: async (_botId, _claim, attempt) => { tries.push(attempt); return answers.shift() ?? "failed"; },
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return { cancel: () => { timer.cancelled = true; } };
      },
    },
  );
  /** Fire the newest live timer, then let its retry settle. */
  const fire = async () => {
    const live = timers.filter((row) => !row.cancelled);
    const timer = live[live.length - 1];
    assert.ok(timer, "a quiet try is scheduled");
    timer.cancelled = true;
    timer.fn();
    await flush();
  };
  const live = () => timers.filter((row) => !row.cancelled);
  return { issues, raised, resolved, tries, timers, live, fire };
}

test("a block that clears on a quiet try never shows a card", async () => {
  const h = setup(["resumed"]);
  await h.issues.blocked("bot-1", claim, "Model not ready", "unavailable");
  assert.deepEqual(h.raised, [], "no card while the first try is waiting");
  assert.equal(h.timers[0]!.ms, BOT_EXECUTION_RETRY_DELAYS_MS[0]);
  await h.fire();
  assert.deepEqual(h.tries, [1]);
  // The resumed run reaches its model: the block is over.
  await h.issues.settled("bot-1", claim);
  assert.deepEqual(h.raised, []);
  assert.deepEqual(h.live(), []);
});

test("a block that outlasts every quiet try asks the person once", async () => {
  const h = setup();
  await h.issues.blocked("bot-1", claim, "Model not ready", "unavailable");
  for (let attempt = 0; attempt < BOT_EXECUTION_RETRY_DELAYS_MS.length; attempt += 1) {
    assert.deepEqual(h.raised, [], `no card before try ${attempt + 1}`);
    await h.fire();
  }
  assert.deepEqual(h.tries, [1, 2, 3]);
  assert.deepEqual(h.raised, [{ dedupeKey: "execution:claim-1", title: "Review this run before resuming", quiet: true }]);
  assert.deepEqual(h.live(), [], "nothing more is tried after the card");
});

test("a run that blocks again after a resume uses up the next try, not a fresh set", async () => {
  const h = setup(["resumed", "resumed", "resumed"]);
  await h.issues.blocked("bot-1", claim, "Model not ready", "unavailable");
  for (let attempt = 0; attempt < BOT_EXECUTION_RETRY_DELAYS_MS.length; attempt += 1) {
    await h.fire();
    await h.issues.blocked("bot-1", claim, "Model not ready", "unavailable");
  }
  assert.deepEqual(h.tries, [1, 2, 3]);
  assert.equal(h.raised.length, 1);
});

test("a resume that blocks again on its way back counts as one try, not two", async () => {
  const h = setup();
  // The host reports the re-block while the resume is still answering; the resume then says "failed".
  await h.issues.blocked("bot-1", claim, "Model not ready", "unavailable");
  for (let attempt = 0; attempt < BOT_EXECUTION_RETRY_DELAYS_MS.length; attempt += 1) {
    const live = h.live();
    const timer = live[live.length - 1]!;
    timer.cancelled = true;
    timer.fn();
    await h.issues.blocked("bot-1", claim, "Model not ready", "unavailable");
    await flush();
    if (attempt < BOT_EXECUTION_RETRY_DELAYS_MS.length - 1) assert.deepEqual(h.raised, [], `no card after try ${attempt + 1}`);
  }
  assert.deepEqual(h.tries, [1, 2, 3], "each scheduled try ran once");
  assert.equal(h.raised.length, 1, "the card comes only after the third try");
});

test("the person answering first ends the tries without a card", async () => {
  const moot = setup(["moot"]);
  await moot.issues.blocked("bot-1", claim, "Model not ready", "unavailable");
  await moot.fire();
  assert.deepEqual(moot.raised, []);
  assert.deepEqual(moot.live(), []);

  const dismissed = setup();
  await dismissed.issues.blocked("bot-1", claim, "Model not ready", "unavailable");
  await dismissed.issues.dismissed("bot-1", claim);
  assert.deepEqual(dismissed.live(), [], "Dismiss cancels the waiting try");
  assert.deepEqual(dismissed.tries, []);
  assert.deepEqual(dismissed.raised, []);
});

test("an uncertain provider cost asks at once and is never retried", async () => {
  const h = setup([], "dispatch-9");
  await h.issues.blocked("bot-1", claim, "The cost is unknown", "spending_unknown");
  assert.deepEqual(h.raised, [{ dedupeKey: "execution-cost:dispatch-9", title: "Review this run before resuming" }]);
  assert.deepEqual(h.timers, []);
});

test("a blocked routine run still alerts the person: nobody is in its chat to see it", async () => {
  const h = setup();
  const routine = { ...claim, id: "claim-2", routineId: "routine-1" } as BotExecutionClaim;
  await h.issues.blocked("bot-1", routine, "Model not ready", "unavailable");
  for (let attempt = 0; attempt < BOT_EXECUTION_RETRY_DELAYS_MS.length; attempt += 1) await h.fire();
  assert.deepEqual(h.raised, [{ dedupeKey: "execution:claim-2", title: "Review this run before resuming" }], "an ask, not a quiet heads-up");
});
