import assert from "node:assert/strict";
import test from "node:test";
import { agentNotice } from "../../../renderer/shared/agent-notices.js";
import {
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
    notice: agentNotice({ source: "background_job", tone: "failure", title: "Background job ended", summary: text }),
    text,
    wake,
  };
}

/**
 * A chat that is either running a turn (which takes queued input) or idle.
 * Transcript order is what the chat would show.
 */
function fakeChat(options: { running?: boolean; now?: () => number } = {}) {
  let running = options.running ?? false;
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
      if (!running) return { kind: "no-run" };
      transcript.push({ text: item.text, via: "queued" });
      return { kind: "queued", messageId: `m${++ids}` };
    },
    async startTurn(chatId, item) {
      calls.push(item ? "start-with-notice" : "start");
      const forced = deps.startAnswer?.(item);
      if (forced) return forced;
      if (running) return { kind: "busy" };
      running = true;
      if (item) transcript.push({ text: item.text, via: "woke" });
      return { kind: "started", streamId: `s-${chatId}-${ids}`, ...(item ? { messageId: `m${++ids}` } : {}) };
    },
    async append(item) {
      calls.push("append");
      const forced = deps.appendAnswer?.(item);
      if (forced) return forced;
      if (running) return { kind: "busy" };
      transcript.push({ text: item.text, via: "recorded" });
      return { kind: "appended", messageId: `m${++ids}` };
    },
    waitForIdle() {
      calls.push("wait");
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
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
  assert.equal(delivery.wakesLeft("chat-1"), MAX_WAKES_PER_CHAT_PER_HOUR, "queueing spends no wake");
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
  assert.ok(chat.calls.includes("start"), "the saved notice is answered without appending it again");
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
  assert.deepEqual(await new NoticeDelivery(gone.deps).post(post("x", false)), {
    kind: "dropped",
    reason: "The chat no longer exists.",
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
