import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";
import { createCheckBackTool } from "./check-back-tool.js";
import { CheckBacks, type CheckBackPost, type CheckBackRecord } from "./check-backs.js";

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

const MINUTE = 60_000;
/** 2026-11-22 14:50:00 UTC. */
const START = Date.UTC(2026, 10, 22, 14, 50);

function harness(options: { enabled?: boolean; holdPosts?: boolean; enabledRead?: () => boolean | Promise<boolean> } = {}) {
  let now = START;
  let enabled = options.enabled ?? true;
  let nextId = 0;
  const posts: CheckBackPost[] = [];
  const saved: CheckBackRecord[][] = [];
  const changed: string[] = [];
  const timers: Array<{ callback: () => void; at: number; live: boolean }> = [];
  let releasePosts: (() => void) | undefined;
  const postsHeld = options.holdPosts ? new Promise<void>((resolve) => (releasePosts = resolve)) : Promise.resolve();
  const checkBacks = new CheckBacks({
    persist: (records) => saved.push(records),
    post: async (post) => {
      posts.push(post);
      await postsHeld;
    },
    onChange: (chatId) => changed.push(chatId),
    enabled: () => options.enabledRead?.() ?? enabled,
    timezone: () => "UTC",
    now: () => now,
    newId: () => `cb_${(nextId += 1)}`,
    setTimer: (callback, ms) => {
      const timer = { callback, at: now + ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { live: boolean }).live = false;
    },
  });
  const settle = async () => {
    for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    checkBacks,
    posts,
    saved,
    changed,
    settle,
    setEnabled: (value: boolean) => (enabled = value),
    releasePosts: () => releasePosts?.(),
    liveTimers: () => timers.filter((timer) => timer.live),
    /** Moves the clock and runs the armed timer if its time came. */
    advance: async (ms: number) => {
      now += ms;
      for (const timer of timers.filter((entry) => entry.live && entry.at <= now)) {
        timer.live = false;
        timer.callback();
      }
      await settle();
    },
    /** Moves the clock with no timer running (the computer slept). */
    sleep: (ms: number) => {
      now += ms;
    },
  };
}

test("a check-back fires once at its minute, waking the chat with the note", async () => {
  const value = harness();
  const set = await value.checkBacks.set("chat-1", { when: { inMinutes: 20 }, note: "See whether the deploy finished", turnId: "turn-1" });
  assert.equal(set.ok, true);
  assert.deepEqual(value.checkBacks.list("chat-1").map(({ fireAt, note }) => ({ fireAt, note })), [
    { fireAt: START + 20 * MINUTE, note: "See whether the deploy finished" },
  ]);
  assert.equal(last(value.saved)?.[0]?.setByTurnId, "turn-1");
  assert.deepEqual(value.changed, ["chat-1"]);

  await value.advance(19 * MINUTE);
  assert.equal(value.posts.length, 0, "nothing fires before its minute");
  await value.advance(MINUTE);
  assert.equal(value.posts.length, 1);
  const [post] = value.posts;
  assert.equal(post!.wake, true);
  assert.equal(post!.chatId, "chat-1");
  assert.deepEqual(parseAgentNoticeV1(post!.notice), {
    version: 1,
    source: "check_back",
    tone: "info",
    title: "Checking back",
    summary: "See whether the deploy finished",
  });
  assert.match(
    post!.text,
    /You said you would check back at 3:10 PM \(set at 2:50 PM\): See whether the deploy finished\. It is now 3:10 PM\. Do what the note says; if nothing is left to do, say so in one line\./u,
  );
  assert.deepEqual(value.checkBacks.list("chat-1"), []);
  assert.equal(last(value.saved)?.[0]?.state, "fired");
  await value.advance(60 * MINUTE);
  assert.equal(value.posts.length, 1, "it never fires again");
});

test("a check-back is saved as claimed before its notice goes out, so a quit mid-delivery cannot fire it twice", async () => {
  const value = harness({ holdPosts: true });
  await value.checkBacks.set("chat-1", { when: { inMinutes: 5 }, note: "Look at the build" });
  await value.advance(5 * MINUTE);
  assert.equal(value.posts.length, 1);
  assert.equal(last(value.saved)?.[0]?.state, "claimed", "claimed while the notice is still being delivered");

  // Aiden quits now; the next launch restores the claimed record.
  const relaunch = harness();
  relaunch.checkBacks.restore(JSON.parse(JSON.stringify(last(value.saved))));
  await relaunch.settle();
  assert.equal(relaunch.posts.length, 1);
  assert.equal(relaunch.posts[0]!.wake, false, "only a card: the chat is not woken a second time");
  assert.equal(relaunch.posts[0]!.notice.title, "Check-back interrupted (due 2:55 PM)");
  assert.match(relaunch.posts[0]!.text, /may not have finished\. Look at the chat above before redoing anything/u, "not told it never happened");
  assert.equal(last(relaunch.saved)?.[0]?.state, "fired");
  await relaunch.advance(24 * 60 * MINUTE);
  assert.equal(relaunch.posts.length, 1);
  value.releasePosts();
});

test("found up to 2 hours late it still wakes the chat and says it is late; later than that it only leaves a card", async () => {
  const value = harness();
  await value.checkBacks.set("chat-1", { when: { inMinutes: 10 }, note: "Check the queue" });
  await value.checkBacks.set("chat-2", { when: { inMinutes: 10 }, note: "Check the logs" });
  value.sleep(100 * MINUTE);
  value.checkBacks.rearm();
  await value.settle();
  assert.equal(value.posts.length, 2);
  for (const post of value.posts) {
    assert.equal(post.wake, true);
    assert.equal(post.notice.title, "Checking back (due 3:00 PM)");
    assert.match(post.text, /It is now 4:30 PM, so this check-back is 90 minutes late/u);
  }

  const old = harness();
  await old.checkBacks.set("chat-1", { when: { inMinutes: 10 }, note: "Check the queue" });
  old.sleep(10 * MINUTE + 2 * 60 * MINUTE + MINUTE);
  old.checkBacks.rearm();
  await old.settle();
  assert.equal(old.posts.length, 1);
  assert.equal(old.posts[0]!.wake, false);
  assert.equal(old.posts[0]!.notice.title, "Missed check-back (due 3:00 PM)");
  assert.equal(old.posts[0]!.notice.summary, "Check the queue");
});

test("a chat keeps at most 3 pending and Aiden at most 20, even when sets race", async () => {
  const value = harness();
  const raced = await Promise.all(
    Array.from({ length: 5 }, (_, index) => value.checkBacks.set("chat-1", { when: { inMinutes: 10 + index }, note: `note ${index}` })),
  );
  assert.equal(raced.filter((outcome) => outcome.ok).length, 3);
  const refused = raced.find((outcome) => !outcome.ok);
  assert.ok(refused && !refused.ok);
  assert.equal(refused.code, "too_many_pending");
  assert.equal(refused.pending?.length, 3, "the refusal lists what is pending");

  for (let chat = 2; chat <= 7; chat += 1) {
    for (let index = 0; index < 3; index += 1) {
      await value.checkBacks.set(`chat-${chat}`, { when: { inMinutes: 30 }, note: "n" });
    }
  }
  assert.equal(value.checkBacks.pendingAll().length, 20);
  const overTotal = await value.checkBacks.set("chat-8", { when: { inMinutes: 30 }, note: "n" });
  assert.equal(overTotal.ok, false);
  assert.equal(!overTotal.ok && overTotal.code, "too_many_pending");
  // Cancelling one frees a place.
  const [first] = value.checkBacks.list("chat-1");
  assert.equal((await value.checkBacks.cancel("chat-1", first!.id)).ok, true);
  assert.equal((await value.checkBacks.set("chat-8", { when: { inMinutes: 30 }, note: "n" })).ok, true);
});

test("cancel removes only a pending check-back of that chat", async () => {
  const value = harness();
  const set = await value.checkBacks.set("chat-1", { when: { inMinutes: 10 }, note: "n" });
  assert.ok(set.ok);
  const elsewhere = await value.checkBacks.cancel("chat-2", set.checkBack.id);
  assert.equal(!elsewhere.ok && elsewhere.code, "not_found");
  assert.equal((await value.checkBacks.cancel("chat-1", set.checkBack.id)).ok, true);
  assert.deepEqual(value.checkBacks.list("chat-1"), []);
  const again = await value.checkBacks.cancel("chat-1", set.checkBack.id);
  assert.equal(!again.ok && again.code, "not_found");
  assert.equal(value.liveTimers().length, 0, "no timer waits for a cancelled check-back");
  await value.advance(20 * MINUTE);
  assert.equal(value.posts.length, 0);
});

test("the switch: off refuses new check-backs and cancels every pending one", async () => {
  const value = harness();
  await value.checkBacks.set("chat-1", { when: { inMinutes: 10 }, note: "a" });
  await value.checkBacks.set("chat-2", { when: { inMinutes: 20 }, note: "b" });
  value.setEnabled(false);
  const refused = await value.checkBacks.set("chat-1", { when: { inMinutes: 10 }, note: "c" });
  assert.equal(!refused.ok && refused.code, "off");
  assert.equal(value.checkBacks.cancelAll(), 2);
  assert.deepEqual(value.checkBacks.pendingAll(), []);
  value.setEnabled(true);
  await value.advance(30 * MINUTE);
  assert.equal(value.posts.length, 0, "turning it back on restores nothing");

  // Turned off while Aiden was closed: what was due is cancelled, not fired.
  const closed = harness();
  await closed.checkBacks.set("chat-1", { when: { inMinutes: 10 }, note: "a" });
  closed.setEnabled(false);
  await closed.advance(10 * MINUTE);
  assert.equal(closed.posts.length, 0);
  assert.equal(last(closed.saved)?.[0]?.state, "cancelled");
});

test("deleting a chat drops its check-backs", async () => {
  const value = harness();
  await value.checkBacks.set("chat-1", { when: { inMinutes: 10 }, note: "a" });
  await value.checkBacks.set("chat-2", { when: { inMinutes: 15 }, note: "b" });
  value.checkBacks.deleteChat("chat-1");
  assert.deepEqual(last(value.saved)?.map((record) => record.chatId), ["chat-2"]);
  await value.advance(20 * MINUTE);
  assert.deepEqual(value.posts.map((post) => post.chatId), ["chat-2"]);
});

test("times and notes are bounded", async () => {
  const value = harness();
  for (const when of [{ inMinutes: 0 }, { inMinutes: 1441 }, { inMinutes: 2.5 }, { at: "25:00" }, { at: "3pm" }]) {
    const outcome = await value.checkBacks.set("chat-1", { when, note: "n" });
    assert.equal(!outcome.ok && outcome.code, "invalid_time", JSON.stringify(when));
  }
  for (const note of ["   ", "x".repeat(501)]) {
    const outcome = await value.checkBacks.set("chat-1", { when: { inMinutes: 5 }, note });
    assert.equal(!outcome.ok && outcome.code, "invalid_note");
  }
  // "HH:MM" already past today means tomorrow.
  const at = await value.checkBacks.set("chat-1", { when: { at: "09:00" }, note: "Morning check" });
  assert.ok(at.ok);
  assert.equal(at.checkBack.fireAt, Date.UTC(2026, 10, 23, 9, 0));
});

function toolHarness(refusal?: (args: unknown) => string | undefined) {
  const value = harness();
  const tool = createCheckBackTool({ chatId: "chat-1", turnId: "turn-9", checkBacks: value.checkBacks, timezone: () => "UTC", refusal });
  const call = async (args: Record<string, unknown>) => {
    const result = await tool.execute("call-1", args as never);
    const text = (result.content[0] as { text: string }).text;
    return { body: JSON.parse(text) as Record<string, unknown>, details: result.details, isError: (result as { isError?: boolean }).isError === true };
  };
  return { value, tool, call };
}

test("the tool sets, lists and cancels, and answers with the documented codes", async () => {
  const { value, call } = toolHarness();
  const set = await call({ action: "set", in_minutes: 20, note: "See whether CI passed" });
  assert.equal(set.isError, false);
  assert.deepEqual(set.details, { checkBack: { fireAt: START + 20 * MINUTE } });
  assert.deepEqual((set.body.checkBack as Record<string, unknown>).at, "3:10 PM");
  assert.equal(last(value.saved)?.[0]?.setByTurnId, "turn-9");

  const listed = await call({ action: "list" });
  const pending = listed.body.pending as Array<{ id: string; note: string }>;
  assert.deepEqual(pending.map((entry) => entry.note), ["See whether CI passed"]);

  assert.equal((await call({ action: "set", in_minutes: 5, at: "16:00", note: "x" })).body.code, "invalid_time");
  assert.equal((await call({ action: "set", in_minutes: 5, note: "" })).body.code, "invalid_note");
  assert.equal((await call({ action: "cancel", id: "cb_404" })).body.code, "not_found");
  for (let index = 0; index < 2; index += 1) await call({ action: "set", in_minutes: 30, note: "more" });
  const full = await call({ action: "set", in_minutes: 30, note: "one too many" });
  assert.equal(full.isError, true);
  assert.equal(full.body.code, "too_many_pending");

  const cancelled = await call({ action: "cancel", id: pending[0]!.id });
  assert.equal(cancelled.body.ok, true);
  value.setEnabled(false);
  assert.equal((await call({ action: "set", in_minutes: 5, note: "x" })).body.code, "off");
});

test("the tool refuses set in a turn the policy refuses it, but still lists and cancels", async () => {
  const { value, call } = toolHarness((args) => ((args as { action?: string }).action === "set" ? "refused here" : undefined));
  await assert.rejects(call({ action: "set", in_minutes: 5, note: "x" }), /refused here/u);
  assert.deepEqual(value.checkBacks.pendingAll(), []);
  assert.equal((await call({ action: "list" })).body.ok, true);
});

test("a check-back set before the clock jumped back waits with an hourly recheck, never a tight loop", async () => {
  const value = harness();
  // Saved at a clock 40 days ahead of now: its delay is past what a timer can hold.
  value.checkBacks.restore([
    { id: "cb_far", chatId: "chat-1", fireAt: START + 40 * 24 * 60 * MINUTE, note: "Look again", setAt: START + 40 * 24 * 60 * MINUTE - 20 * MINUTE, state: "pending" },
  ]);
  await value.settle();
  const [timer] = value.liveTimers();
  assert.ok(timer, "one timer armed");
  assert.ok(timer.at - START <= 60 * MINUTE && timer.at - START > 0, "it waits at most an hour");
  await value.advance(60 * MINUTE);
  assert.equal(value.posts.length, 0);
  assert.equal(value.liveTimers().length, 1, "re-armed once, not spinning");
  assert.ok(value.liveTimers()[0]!.at - (START + 60 * MINUTE) >= 59 * MINUTE);
});

test("a check-back due while reading the setting failed is tried again a minute later", async () => {
  let reads = 0;
  const value = harness({
    enabledRead: () => {
      reads += 1;
      if (reads === 2) return Promise.reject(new Error("settings unreadable"));
      return true;
    },
  });
  await value.checkBacks.set("chat-1", { when: { inMinutes: 5 }, note: "Look at the build" });
  await value.advance(5 * MINUTE);
  assert.equal(value.posts.length, 0, "the failed read posts nothing");
  const [retry] = value.liveTimers();
  assert.ok(retry, "a retry is armed instead of waiting for a resume or unlock");
  assert.ok(retry.at - (START + 5 * MINUTE) >= MINUTE);
  await value.advance(MINUTE);
  assert.equal(value.posts.length, 1);
  assert.equal(value.posts[0]!.notice.title, "Checking back");
});

test("quitting while a check-back is being delivered waits for it, so it is saved as fired", async () => {
  const value = harness({ holdPosts: true });
  await value.checkBacks.set("chat-1", { when: { inMinutes: 5 }, note: "Look at the build" });
  await value.advance(5 * MINUTE);
  assert.equal(last(value.saved)?.[0]?.state, "claimed");
  let quit = false;
  const quitting = value.checkBacks.shutdown().then(() => (quit = true));
  await value.settle();
  assert.equal(quit, false, "quitting waits for the notice already going out");
  value.releasePosts();
  await quitting;
  assert.equal(last(value.saved)?.[0]?.state, "fired", "the next launch shows no interrupted card");
});

test("a restored note is trimmed to the note limit", async () => {
  const value = harness();
  value.checkBacks.restore([
    { id: "cb_long", chatId: "chat-1", fireAt: START + 30 * MINUTE, note: "x".repeat(1_200), setAt: START, state: "pending" },
  ]);
  await value.settle();
  assert.equal(value.checkBacks.list("chat-1")[0]?.note.length, 500);
});
