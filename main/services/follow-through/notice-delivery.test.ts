import assert from "node:assert/strict";
import test from "node:test";
import { agentNotice } from "../../../renderer/shared/agent-notices.js";
import {
  agentNoticeRun,
  MAX_WAKES_PER_CHAT_PER_HOUR,
  NoticeDelivery,
  type AgentNoticePost,
  type AppendResult,
  type NoticeDeliveryDeps,
  type QueueIntoRunResult,
  type StartTurnResult,
} from "./notice-delivery.js";

function post(text: string, wake = true, chatId = "chat-1"): AgentNoticePost {
  return {
    chatId,
    notice: agentNotice({
      source: "background_job",
      tone: "failure",
      title: "Background job ended",
      summary: text,
    }),
    text,
    wake,
  };
}

/**
 * A chat that is either running a turn (which takes queued input) or idle.
 * Transcript order is what the chat would show.
 */
function fakeChat(options: { running?: boolean; scheduledRun?: boolean; now?: () => number } = {}) {
  let running = options.running ?? false;
  // A scheduled task's run holds the chat: it takes no input and blocks other turns.
  let scheduledRun = options.scheduledRun ?? false;
  const runWaiters: Array<() => void> = [];
  const runEndWaiters: Array<(settled: boolean) => void> = [];
  // The scheduled task's run that holds the chat; a new one gets a new id.
  let holder = "s-task-1";
  let ids = 0;
  const transcript: Array<{ text: string; via: string }> = [];
  const idleWaiters: Array<() => void> = [];
  const calls: string[] = [];
  const deps: NoticeDeliveryDeps & {
    queueAnswer?: (post: AgentNoticePost) => QueueIntoRunResult | undefined;
    startAnswer?: (post?: AgentNoticePost) => StartTurnResult | undefined;
    appendAnswer?: (post: AgentNoticePost) => AppendResult | undefined;
  } = {
    async queueIntoRun(item) {
      calls.push("queue");
      const forced = deps.queueAnswer?.(item);
      if (forced) return forced;
      if (scheduledRun) return { kind: "busy", holder };
      if (!running) return { kind: "no-run" };
      transcript.push({ text: item.text, via: "queued" });
      return { kind: "queued", messageId: `m${++ids}` };
    },
    async startTurn(chatId, item) {
      calls.push(item ? "start-with-notice" : "start");
      const forced = deps.startAnswer?.(item);
      if (forced) return forced;
      if (running || scheduledRun) return { kind: "busy" };
      running = true;
      if (item) transcript.push({ text: item.text, via: "woke" });
      return {
        kind: "started",
        streamId: `s-${chatId}-${ids}`,
        ...(item ? { messageId: `m${++ids}` } : {}),
      };
    },
    async append(item) {
      calls.push("append");
      const forced = deps.appendAnswer?.(item);
      if (forced) return forced;
      if (running || scheduledRun) return { kind: "busy" };
      transcript.push({ text: item.text, via: "recorded" });
      return { kind: "appended", messageId: `m${++ids}` };
    },
    waitForIdle() {
      calls.push("wait");
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    waitForRunToSettle() {
      calls.push("wait-run");
      return new Promise<void>((resolve) => runWaiters.push(resolve));
    },
    waitForRunToEnd() {
      calls.push("wait-run-end");
      return new Promise<boolean>((resolve) => runEndWaiters.push(resolve));
    },
    now: options.now ?? (() => 0),
  };
  return {
    deps,
    transcript,
    calls,
    finishTurn() {
      running = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
    },
    finishScheduledRun() {
      scheduledRun = false;
      for (const resolve of runWaiters.splice(0)) resolve();
      for (const resolve of runEndWaiters.splice(0)) resolve(true);
    },
    /** The long wait ran out with the scheduled run still holding the chat. */
    runWaitTimedOut() {
      for (const resolve of runWaiters.splice(0)) resolve();
    },
    /** The day-long wait ran out too, the scheduled run still holding the chat. */
    runEndWaitTimedOut() {
      for (const resolve of runEndWaiters.splice(0)) resolve(false);
    },
    /** Another scheduled task's run takes the chat. */
    startScheduledRun() {
      scheduledRun = true;
      holder = `s-task-${Number(holder.slice(7)) + 1}`;
    },
    get running() {
      return running;
    },
  };
}

test("a running turn takes the notice as queued input instead of starting another turn", async () => {
  const chat = fakeChat({ running: true });
  const delivery = new NoticeDelivery(chat.deps);
  const outcome = await delivery.post(post("npm test exited with code 1"));
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(chat.transcript, [{ text: "npm test exited with code 1", via: "queued" }]);
  assert.equal(
    delivery.wakesLeft("chat-1"),
    MAX_WAKES_PER_CHAT_PER_HOUR,
    "queueing spends no wake",
  );
});

test("an idle chat is woken for news the agent must act on, and only recorded otherwise", async () => {
  const woke = fakeChat();
  const wakeOutcome = await new NoticeDelivery(woke.deps).post(post("checks failed"));
  assert.equal(wakeOutcome.kind, "woke");
  assert.deepEqual(woke.transcript, [{ text: "checks failed", via: "woke" }]);
  assert.equal(woke.running, true);

  const quiet = fakeChat();
  const quietOutcome = await new NoticeDelivery(quiet.deps).post(post("checks passed", false));
  assert.deepEqual(quietOutcome, { kind: "recorded", messageId: "m1", reason: "not-waking" });
  assert.equal(quiet.running, false, "a notice that needs nothing never starts a turn");
});

test("one chat may start six unattended turns an hour; later news is only recorded until the hour passes", async () => {
  let now = 1_000;
  const chat = fakeChat({ now: () => now });
  const delivery = new NoticeDelivery(chat.deps);
  for (let index = 0; index < MAX_WAKES_PER_CHAT_PER_HOUR; index += 1) {
    const outcome = await delivery.post(post(`failure ${index}`));
    assert.equal(outcome.kind, "woke");
    chat.finishTurn();
    now += 60_000;
  }
  const overBudget = await delivery.post(post("one more failure"));
  assert.equal(overBudget.kind, "recorded");
  assert.equal(overBudget.kind === "recorded" && overBudget.reason, "wake-budget");
  assert.equal(chat.transcript[chat.transcript.length - 1]?.via, "recorded");

  const other = await delivery.post(post("another chat", true, "chat-2"));
  assert.equal(other.kind, "woke", "the budget is per chat");
  chat.finishTurn();

  now += 60 * 60_000;
  assert.equal(delivery.wakesLeft("chat-1"), MAX_WAKES_PER_CHAT_PER_HOUR);
  assert.equal((await delivery.post(post("next hour"))).kind, "woke");
});

test("notices for one chat are delivered in the order they were posted", async () => {
  const chat = fakeChat();
  const delivery = new NoticeDelivery(chat.deps);
  const first = delivery.post(post("first"));
  const second = delivery.post(post("second"));
  const third = delivery.post(post("third", false));
  assert.equal((await first).kind, "woke");
  // The woken turn is running now, so the next notices join it in order.
  assert.equal((await second).kind, "queued");
  assert.equal((await third).kind, "queued");
  assert.deepEqual(
    chat.transcript.map((entry) => entry.text),
    ["first", "second", "third"],
  );
});

test("a turn that ended just as the notice was saved is followed by a turn of its own", async () => {
  const chat = fakeChat();
  chat.deps.queueAnswer = () => ({ kind: "saved", messageId: "saved-1" });
  const outcome = await new NoticeDelivery(chat.deps).post(post("dev server crashed"));
  assert.equal(outcome.kind, "woke");
  assert.equal(outcome.kind === "woke" && outcome.messageId, "saved-1");
  assert.ok(
    chat.calls.includes("start"),
    "the saved notice is answered without appending it again",
  );
  assert.ok(!chat.calls.includes("start-with-notice"));
  assert.ok(!chat.calls.includes("append"));
});

test("a saved notice that needs no answer is not woken", async () => {
  const chat = fakeChat();
  chat.deps.queueAnswer = () => ({ kind: "saved", messageId: "saved-1" });
  const outcome = await new NoticeDelivery(chat.deps).post(post("checks passed", false));
  assert.deepEqual(outcome, { kind: "recorded", messageId: "saved-1", reason: "not-waking" });
  assert.ok(!chat.calls.some((call) => call.startsWith("start")));
});

test("when another turn holds the chat, delivery waits for it and then joins or wakes", async () => {
  const chat = fakeChat();
  let busy = true;
  chat.deps.startAnswer = () => (busy ? { kind: "busy" } : undefined);
  const delivery = new NoticeDelivery(chat.deps);
  const pending = delivery.post(post("failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chat.calls, ["queue", "start-with-notice", "wait"]);
  busy = false;
  chat.finishTurn();
  const outcome = await pending;
  assert.equal(outcome.kind, "woke");
  assert.deepEqual(chat.transcript, [{ text: "failure", via: "woke" }]);
});

test("a scheduled task's run in the chat never takes a notice; once it settles the chat's own turn answers it", async () => {
  const chat = fakeChat({ scheduledRun: true });
  const delivery = new NoticeDelivery(chat.deps);
  const pending = delivery.post(post("“Run tests” finished"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chat.transcript, [], "nothing lands in the scheduled run");
  assert.deepEqual(chat.calls, ["queue", "wait-run"]);
  chat.finishScheduledRun();
  const outcome = await pending;
  assert.equal(outcome.kind, "woke");
  assert.deepEqual(chat.transcript, [{ text: "“Run tests” finished", via: "woke" }]);

  const quiet = fakeChat({ scheduledRun: true });
  const recorded = new NoticeDelivery(quiet.deps).post(post("checks passed", false));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(quiet.transcript, []);
  quiet.finishScheduledRun();
  assert.equal((await recorded).kind, "recorded");
  assert.deepEqual(quiet.transcript, [{ text: "checks passed", via: "recorded" }]);
});

test("a notice outlasts another feature's run that holds the chat past the long wait, and is recorded once that run settles", async () => {
  const chat = fakeChat({ scheduledRun: true });
  const delivery = new NoticeDelivery(chat.deps);
  let settled = false;
  const pending = delivery.post(post("checks failed")).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    delivery.hasPending("chat-1"),
    false,
    "a goal is not held back while the other run keeps the chat busy",
  );
  // The long wait ends with the scheduled run still holding the chat.
  chat.runWaitTimedOut();
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "the notice is neither dropped nor recorded while that run holds the chat",
  );
  assert.deepEqual(chat.transcript, []);
  assert.equal(delivery.hasPending("chat-1"), false, "and still doesn't hold a goal back");
  assert.equal(chat.calls.includes("append"), false, "nothing tries to save into the held chat");
  chat.finishScheduledRun();
  const outcome = await pending;
  assert.deepEqual(outcome.kind === "recorded" ? outcome.reason : outcome.kind, "wake-unavailable");
  assert.deepEqual(
    chat.transcript,
    [{ text: "checks failed", via: "recorded" }],
    "recorded, not woken: the news is hours old",
  );
  assert.equal(
    chat.calls.filter((call) => call === "wait-run").length,
    1,
    "the long wait runs once",
  );
  assert.equal(delivery.hasPending("chat-1"), false);
});

test("behind a run that never ends, only the first notice waits the day out; later ones are dropped at once, and a new run is waited on again", async () => {
  const chat = fakeChat({ scheduledRun: true });
  const errors: unknown[] = [];
  chat.deps.onError = (error) => void errors.push(error);
  // Recording's own short waits for the chat return at once: the run never ends.
  chat.deps.waitForIdle = async () => void chat.calls.push("wait");
  const delivery = new NoticeDelivery(chat.deps);
  const first = delivery.post(post("checks failed"));
  const later = [
    delivery.post(post("checks passed", false)),
    delivery.post(post("review requested")),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  chat.runWaitTimedOut();
  await new Promise((resolve) => setImmediate(resolve));
  chat.runEndWaitTimedOut();
  const outcome = await first;
  assert.equal(outcome.kind, "dropped");
  assert.equal(
    outcome.kind === "dropped" ? outcome.gone : undefined,
    undefined,
    "not gone: the chat is still there",
  );
  // No further waits: each later notice is settled without anyone finishing a wait.
  for (const notice of await Promise.all(later)) assert.equal(notice.kind, "dropped");
  assert.equal(
    chat.calls.filter((call) => call === "wait-run").length,
    1,
    "the 30-minute wait ran once for that run",
  );
  assert.equal(
    chat.calls.filter((call) => call === "wait-run-end").length,
    1,
    "and the day-long wait once",
  );
  assert.equal(errors.length, 1, "reported once for that run");
  assert.deepEqual(chat.transcript, []);

  // That run ends and another takes the chat: a notice waits on the new one again.
  chat.finishScheduledRun();
  chat.startScheduledRun();
  const fresh = delivery.post(post("checks failed again"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chat.calls.filter((call) => call === "wait-run").length, 2);
  chat.finishScheduledRun();
  assert.equal((await fresh).kind, "woke");
});

test("a notice that waited out another run and then can't be saved is dropped and reported, not taken for a deleted chat", async () => {
  const chat = fakeChat({ scheduledRun: true });
  const errors: unknown[] = [];
  chat.deps.onError = (error) => void errors.push(error);
  chat.deps.appendAnswer = () => ({ kind: "failed", reason: "disk full" });
  const pending = new NoticeDelivery(chat.deps).post(post("checks failed"));
  await new Promise((resolve) => setImmediate(resolve));
  chat.runWaitTimedOut();
  await new Promise((resolve) => setImmediate(resolve));
  // The run ends within the day; saving the notice then fails.
  chat.finishScheduledRun();
  const outcome = await pending;
  assert.deepEqual(outcome, { kind: "dropped", reason: "disk full" });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /disk full/u);
});

test("a notice joins only the chat's own running turn, never a run another feature owns", () => {
  const own = { chatId: "chat-1", cancelRequested: false, chatTurn: true };
  const scheduled = { chatId: "chat-1", cancelRequested: false, chatTurn: false };
  assert.deepEqual(agentNoticeRun([["s-own", own]], "chat-1"), { streamId: "s-own" });
  assert.deepEqual(agentNoticeRun([["s-task", scheduled]], "chat-1"), { busyWith: "s-task" });
  assert.deepEqual(
    agentNoticeRun(
      [
        ["s-task", scheduled],
        ["s-own", own],
      ],
      "chat-1",
    ),
    { streamId: "s-own" },
  );
  assert.equal(
    agentNoticeRun([["s-own", { ...own, cancelRequested: true }]], "chat-1"),
    undefined,
    "a stopping run takes nothing",
  );
  assert.equal(agentNoticeRun([["s-own", { ...own, chatId: "chat-2" }]], "chat-1"), undefined);
  assert.equal(agentNoticeRun([], "chat-1"), undefined);
});

test("a chat that cannot take a follow-up turn still shows the notice", async () => {
  const chat = fakeChat();
  chat.deps.startAnswer = () => ({ kind: "unavailable", reason: "The chat has no model yet." });
  const outcome = await new NoticeDelivery(chat.deps).post(post("failure"));
  assert.equal(outcome.kind, "recorded");
  assert.equal(outcome.kind === "recorded" && outcome.reason, "wake-unavailable");
  assert.deepEqual(chat.transcript, [{ text: "failure", via: "recorded" }]);
});

test("a turn that saved the notice before failing to start is not saved twice", async () => {
  const chat = fakeChat();
  chat.deps.startAnswer = () => ({ kind: "unavailable", reason: "stopped", messageId: "m-saved" });
  const outcome = await new NoticeDelivery(chat.deps).post(post("failure"));
  assert.deepEqual(outcome, { kind: "recorded", messageId: "m-saved", reason: "wake-unavailable" });
  assert.ok(!chat.calls.includes("append"));
});

test("a deleted chat drops the notice, and a throwing dependency never rejects the post", async () => {
  const gone = fakeChat();
  gone.deps.appendAnswer = () => ({ kind: "gone", reason: "The chat no longer exists." });
  // Marked gone: a retry never could deliver it, unlike a chat that stayed busy.
  assert.deepEqual(await new NoticeDelivery(gone.deps).post(post("x", false)), {
    kind: "dropped",
    reason: "The chat no longer exists.",
    gone: true,
  });

  const errors: unknown[] = [];
  const broken = fakeChat();
  broken.deps.queueAnswer = () => {
    throw new Error("store offline");
  };
  broken.deps.onError = (error) => errors.push(error);
  const delivery = new NoticeDelivery(broken.deps);
  assert.deepEqual(await delivery.post(post("x")), { kind: "dropped", reason: "store offline" });
  assert.equal(errors.length, 1);
  // The chain recovers for the next notice.
  broken.deps.queueAnswer = undefined;
  assert.equal((await delivery.post(post("y"))).kind, "woke");
});

test("while the chat has an active goal, waking news starts a goal round that spends no wake budget", async () => {
  let now = 1_000;
  const chat = fakeChat({ now: () => now });
  let goalActive = true;
  const rounds: string[] = [];
  chat.deps.startGoalRound = async (chatId, item) => {
    if (!goalActive) return undefined;
    rounds.push(item?.text ?? "(saved)");
    return {
      kind: "started",
      streamId: `goal-${chatId}-${rounds.length}`,
      ...(item ? { messageId: `g${rounds.length}` } : {}),
    };
  };
  const delivery = new NoticeDelivery(chat.deps);
  for (let index = 0; index < MAX_WAKES_PER_CHAT_PER_HOUR + 2; index += 1) {
    const outcome = await delivery.post(post(`job ${index} finished`));
    assert.equal(outcome.kind, "woke", `notice ${index}`);
    now += 60_000;
  }
  assert.equal(
    rounds.length,
    MAX_WAKES_PER_CHAT_PER_HOUR + 2,
    "no hourly limit on rounds the goal owns",
  );
  assert.equal(delivery.wakesLeft("chat-1"), MAX_WAKES_PER_CHAT_PER_HOUR);
  assert.ok(
    !chat.calls.includes("start-with-notice"),
    "no unattended turn while the goal is active",
  );

  // A notice that needs no answer is only recorded, goal or not.
  assert.equal((await delivery.post(post("checks passed", false))).kind, "recorded");
  assert.equal(rounds.length, MAX_WAKES_PER_CHAT_PER_HOUR + 2);

  // A notice saved as a run ended is answered by a goal round too.
  chat.deps.queueAnswer = () => ({ kind: "saved", messageId: "saved-1" });
  const saved = await delivery.post(post("dev server crashed"));
  assert.deepEqual(saved, {
    kind: "woke",
    messageId: "saved-1",
    streamId: `goal-chat-1-${rounds.length}`,
  });
  assert.equal(rounds[rounds.length - 1], "(saved)");
  chat.deps.queueAnswer = undefined;

  // Without a goal, the unattended wake and its budget apply again.
  goalActive = false;
  assert.equal((await delivery.post(post("after the goal"))).kind, "woke");
  assert.equal(delivery.wakesLeft("chat-1"), MAX_WAKES_PER_CHAT_PER_HOUR - 1);
});
