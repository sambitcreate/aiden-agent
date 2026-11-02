import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ChatTriageStore, SNOOZE_WAKE_CHECK_MS, wakeTriageOnAttention } from "./chat-triage.js";
import type { HostRunSummary } from "./host-run-registry.js";
import { parseChatTriageRequest, setChatTriageFromRenderer } from "../handlers/chat-triage-params.js";
import {
  MAX_CHAT_TRIAGE_ENTRIES,
  inverseTriagePatch,
  isChatTriagePatch,
  snoozeOptions,
  type ChatTriageSnapshot,
} from "../../renderer/shared/chat-triage.js";

async function tmpDir(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-triage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never held");
}

function manualTimers() {
  const pending: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  return {
    pending,
    setTimer: (callback: () => void, ms: number) => {
      const handle = { callback, ms, cleared: false };
      pending.push(handle);
      return handle;
    },
    clearTimer: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    live: () => pending.filter((entry) => !entry.cleared),
  };
}

test("pin, done and snooze are independent fields that persist across restarts", async (t) => {
  const root = await tmpDir(t);
  let now = 1_000;
  const published: ChatTriageSnapshot[] = [];
  const store = new ChatTriageStore(() => root, { now: () => now, onChange: (snapshot) => published.push(snapshot) });

  const pinned = await store.set("chat-a", { pinned: true });
  assert.equal(pinned.ok, true);
  now = 2_000;
  await store.set("chat-a", { done: true });
  now = 3_000;
  await store.set("chat-a", { snoozeUntil: 10_000 });

  const entry = await store.get("chat-a");
  assert.deepEqual(entry, { revision: 3, updatedAt: 3_000, pinnedAt: 1_000, doneAt: 2_000, snoozedUntil: 10_000 });
  assert.equal(published.length, 3);
  assert.ok(published[2]!.revision > published[0]!.revision);

  // Pinning again keeps the original pin time, so the shelf order is stable.
  now = 4_000;
  await store.set("chat-a", { pinned: true });
  assert.equal((await store.get("chat-a"))?.pinnedAt, 1_000);

  const reopened = new ChatTriageStore(() => root);
  assert.equal((await reopened.get("chat-a"))?.doneAt, 2_000);
  assert.equal((await reopened.get("chat-a"))?.revision, 4);
});

test("ifRevision only lands when nothing else changed the chat", async (t) => {
  const root = await tmpDir(t);
  const store = new ChatTriageStore(() => root, { now: () => 50 });

  // A chat with no triage reads as revision 0.
  const first = await store.set("chat-a", { done: true }, { ifRevision: 0 });
  assert.equal(first.ok && first.entry.revision, 1);

  // Another surface pins it meanwhile, so an Undo built on revision 1 is refused.
  await store.set("chat-a", { pinned: true });
  const undo = await store.set("chat-a", { done: false }, { ifRevision: 1 });
  assert.equal(undo.ok, false);
  assert.equal(!undo.ok && undo.code, "revision_conflict");
  assert.equal(!undo.ok && undo.code === "revision_conflict" && undo.entry?.revision, 2);
  // The current revision comes back too, as a paired host's answer carries it, so a retry can name it.
  assert.equal(!undo.ok && undo.code === "revision_conflict" && undo.currentRevision, 2);
  assert.equal((await store.get("chat-a"))?.doneAt, 50);

  const matched = await store.set("chat-a", { done: false }, { ifRevision: 2 });
  assert.equal(matched.ok, true);
  assert.equal((await store.get("chat-a"))?.doneAt, undefined);
});

test("bad ids, empty patches and out-of-range snoozes are refused", async (t) => {
  const root = await tmpDir(t);
  const store = new ChatTriageStore(() => root, { now: () => 1_000 });
  assert.deepEqual(await store.set("../escape", { done: true }), { ok: false, code: "invalid" });
  assert.deepEqual(await store.set("chat-a", {}), { ok: false, code: "invalid" });
  assert.deepEqual(await store.set("chat-a", { snoozeUntil: 1_000 + 367 * 86_400_000 }), { ok: false, code: "invalid" });
  assert.deepEqual(await store.set("chat-a", { snoozeUntil: 1.5 }), { ok: false, code: "invalid" });
  assert.deepEqual((await store.snapshot()).chats, {});

  // A snooze already in the past simply clears the snooze.
  await store.set("chat-a", { snoozeUntil: 5_000 });
  await store.set("chat-a", { snoozeUntil: 500 });
  assert.equal((await store.get("chat-a"))?.snoozedUntil, undefined);
});

test("a corrupt or foreign file loads as empty and bad entries are dropped", async (t) => {
  const root = await tmpDir(t);
  await fs.writeFile(
    path.join(root, "chat-triage.json"),
    JSON.stringify({
      version: 1,
      chats: {
        good: { revision: 2, updatedAt: 10, doneAt: 9 },
        "../bad": { revision: 1, updatedAt: 1 },
        zero: { revision: 0, updatedAt: 1 },
        junk: "nope",
      },
    }),
  );
  const store = new ChatTriageStore(() => root);
  assert.deepEqual(Object.keys((await store.snapshot()).chats), ["good"]);

  const other = await tmpDir(t);
  await fs.writeFile(path.join(other, "chat-triage.json"), "{not json");
  const corrupt = new ChatTriageStore(() => other, { now: () => 5 });
  assert.deepEqual((await corrupt.snapshot()).chats, {});
  assert.equal((await corrupt.set("chat-a", { pinned: true })).ok, true);
});

test("the map stays bounded and drops empty entries before set ones", async (t) => {
  const root = await tmpDir(t);
  const chats: Record<string, unknown> = {};
  for (let index = 0; index < MAX_CHAT_TRIAGE_ENTRIES; index += 1) {
    chats[`chat-${index}`] = index === 0 ? { revision: 1, updatedAt: 1 } : { revision: 1, updatedAt: 1, doneAt: 1 };
  }
  await fs.writeFile(path.join(root, "chat-triage.json"), JSON.stringify({ version: 1, chats }));
  const store = new ChatTriageStore(() => root, { now: () => 100 });
  await store.set("newcomer", { pinned: true });
  const after = (await store.snapshot()).chats;
  assert.equal(Object.keys(after).length, MAX_CHAT_TRIAGE_ENTRIES);
  assert.equal(after["newcomer"]?.pinnedAt, 100);
  assert.equal(after["chat-0"], undefined);
  assert.equal(after["chat-1"]?.doneAt, 1);
});

test("a full map drops Done marks and passed snoozes before pins and live snoozes", async (t) => {
  const root = await tmpDir(t);
  const chats: Record<string, unknown> = {};
  // Pins and live snoozes are the oldest entries, so recency alone would drop them first.
  chats["pinned-old"] = { revision: 1, updatedAt: 1, pinnedAt: 1 };
  chats["snoozed-old"] = { revision: 1, updatedAt: 1, snoozedUntil: 10_000 };
  chats["woke-old"] = { revision: 1, updatedAt: 2, snoozedUntil: 50 };
  for (let index = 3; index < MAX_CHAT_TRIAGE_ENTRIES; index += 1) {
    chats[`done-${index}`] = { revision: 1, updatedAt: 10 + index, doneAt: 10 + index };
  }
  await fs.writeFile(path.join(root, "chat-triage.json"), JSON.stringify({ version: 1, chats }));
  const store = new ChatTriageStore(() => root, { now: () => 100 });
  await store.set("newcomer", { done: true });
  await store.set("another", { done: true });
  const after = (await store.snapshot()).chats;
  assert.equal(Object.keys(after).length, MAX_CHAT_TRIAGE_ENTRIES);
  assert.equal(after["pinned-old"]?.pinnedAt, 1);
  assert.equal(after["snoozed-old"]?.snoozedUntil, 10_000);
  // The passed snooze and then the oldest Done mark made room.
  assert.equal(after["woke-old"], undefined);
  assert.equal(after["done-3"], undefined);
  assert.equal(after["done-4"]?.doneAt, 14);
  assert.ok(after["newcomer"] && after["another"]);
});

test("one timer wakes the next snooze and wake() brings a chat back early", async (t) => {
  const root = await tmpDir(t);
  let now = 1_000;
  const timers = manualTimers();
  const published: ChatTriageSnapshot[] = [];
  const store = new ChatTriageStore(() => root, {
    now: () => now,
    onChange: (snapshot) => published.push(snapshot),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  t.after(() => store.dispose());
  await store.start();
  assert.equal(timers.live().length, 0);

  await store.set("late", { snoozeUntil: 9_000 });
  await store.set("soon", { snoozeUntil: 4_000 });
  await waitFor(() => timers.live().length === 1 && timers.live()[0]!.ms === 3_000);
  assert.equal(timers.live().length, 1);
  assert.equal(timers.live()[0]!.ms, 3_000);

  now = 4_000;
  const fired = timers.live()[0]!;
  fired.cleared = true;
  fired.callback();
  await waitFor(async () => (await store.get("soon"))?.snoozedUntil === undefined && timers.live().length === 1);
  assert.equal((await store.get("soon"))?.snoozedUntil, undefined);
  assert.equal((await store.get("late"))?.snoozedUntil, 9_000);
  assert.equal(timers.live().length, 1);
  assert.equal(timers.live()[0]!.ms, 5_000);

  // An approval arrives on the snoozed chat: it wakes now and its revision moves,
  // so an Undo of the snooze built on the old revision is refused.
  const before = (await store.get("late"))!.revision;
  assert.equal(await store.wake("late"), true);
  assert.equal((await store.get("late"))?.snoozedUntil, undefined);
  assert.equal((await store.get("late"))?.revision, before + 1);
  assert.equal(await store.wake("late"), false);
  assert.equal(await store.wake("unknown"), false);
  await waitFor(() => timers.live().length === 0);
  assert.ok(published.length >= 4);
});

test("start() clears snoozes that passed while the app was closed", async (t) => {
  const root = await tmpDir(t);
  const first = new ChatTriageStore(() => root, { now: () => 1_000 });
  await first.set("chat-a", { snoozeUntil: 2_000, pinned: true });
  const timers = manualTimers();
  const reopened = new ChatTriageStore(() => root, { now: () => 3_000, ...timers });
  t.after(() => reopened.dispose());
  await reopened.start();
  const entry = await reopened.get("chat-a");
  assert.equal(entry?.snoozedUntil, undefined);
  assert.equal(entry?.pinnedAt, 1_000);
});

test("remove forgets a deleted chat", async (t) => {
  const root = await tmpDir(t);
  const store = new ChatTriageStore(() => root, { now: () => 1 });
  await store.set("chat-a", { done: true });
  await store.remove("chat-a");
  assert.equal(await store.get("chat-a"), null);
});

test("inverse patches restore only the fields an action touched", () => {
  assert.deepEqual(inverseTriagePatch(null, { done: true }), { done: false });
  assert.deepEqual(inverseTriagePatch({ revision: 2, updatedAt: 1, pinnedAt: 1 }, { pinned: false }), { pinned: true });
  assert.deepEqual(
    inverseTriagePatch({ revision: 2, updatedAt: 1, snoozedUntil: 500 }, { snoozeUntil: 900 }),
    { snoozeUntil: 500 },
  );
  assert.deepEqual(inverseTriagePatch(undefined, { snoozeUntil: 900 }), { snoozeUntil: null });
});

test("patch validation accepts only known, well-formed fields", () => {
  assert.equal(isChatTriagePatch({ done: true }), true);
  assert.equal(isChatTriagePatch({ snoozeUntil: null }), true);
  assert.equal(isChatTriagePatch({}), false);
  assert.equal(isChatTriagePatch({ done: "yes" }), false);
  assert.equal(isChatTriagePatch({ snoozeUntil: -1 }), false);
  assert.equal(isChatTriagePatch({ archived: true }), false);
});

test("snooze presets land on the acting device's local clock", () => {
  // A Wednesday afternoon.
  const wednesday = new Date(2026, 10, 4, 14, 30, 0, 0);
  const options = snoozeOptions(wednesday);
  assert.deepEqual(
    options.map((option) => option.preset),
    ["hour", "evening", "tomorrow", "next_week"],
  );
  const at = (preset: string) => new Date(options.find((option) => option.preset === preset)!.until);
  assert.equal(at("hour").getTime() - wednesday.getTime(), 3_600_000);
  assert.deepEqual([at("evening").getDate(), at("evening").getHours()], [4, 18]);
  assert.deepEqual([at("tomorrow").getDate(), at("tomorrow").getHours()], [5, 9]);
  assert.deepEqual([at("next_week").getDay(), at("next_week").getDate(), at("next_week").getHours()], [1, 9, 9]);

  // After 18:00 there is no "This evening".
  const late = snoozeOptions(new Date(2026, 10, 4, 18, 0, 0, 0));
  assert.equal(late.some((option) => option.preset === "evening"), false);

  // At 17:30 "This evening" would land before "1 hour", so it drops out and
  // the presets stay earliest first.
  const halfPastFive = snoozeOptions(new Date(2026, 10, 4, 17, 30, 0, 0));
  assert.deepEqual(halfPastFive.map((option) => option.preset), ["hour", "tomorrow", "next_week"]);
  const times = (options: { until: number }[]) => options.map((option) => option.until);
  for (const list of [options, halfPastFive, late]) {
    assert.deepEqual(times(list), [...times(list)].sort((left, right) => left - right));
  }

  // On a Monday, next week means the following Monday, not today.
  const monday = snoozeOptions(new Date(2026, 10, 2, 8, 0, 0, 0));
  const nextMonday = new Date(monday.find((option) => option.preset === "next_week")!.until);
  assert.deepEqual([nextMonday.getDay(), nextMonday.getDate()], [1, 9]);
  // On a Sunday, tomorrow is already Monday, so next week is the Monday after (8 days on).
  const sundayAt = new Date(2026, 10, 8, 20, 0, 0, 0);
  const sunday = snoozeOptions(sundayAt);
  const sundayNext = new Date(sunday.find((option) => option.preset === "next_week")!.until);
  const sundayTomorrow = new Date(sunday.find((option) => option.preset === "tomorrow")!.until);
  assert.deepEqual([sundayNext.getDay(), sundayNext.getDate(), sundayNext.getMonth()], [1, 16, 10]);
  assert.deepEqual([sundayTomorrow.getDay(), sundayTomorrow.getDate()], [1, 9]);
  // On a Saturday, Monday is two days away and counts as next week.
  const saturday = snoozeOptions(new Date(2026, 10, 7, 10, 0, 0, 0));
  assert.equal(new Date(saturday.find((option) => option.preset === "next_week")!.until).getDate(), 9);
});

type AttentionListener = Parameters<Parameters<typeof wakeTriageOnAttention>[0]["onChange"]>[0];

function attentionRuns() {
  const listeners: AttentionListener[] = [];
  const emit = (
    chatId: string,
    state: HostRunSummary["state"],
    { removed = false, runId = `run-${chatId}`, approvals = [] as string[], questions = [] as string[] } = {},
  ) => listeners.forEach((listener) =>
    listener({ runId, chatId, state, pendingApprovalIds: approvals, pendingQuestionIds: questions }, removed));
  return {
    emit,
    runs: {
      onChange(listener: AttentionListener) {
        listeners.push(listener);
        return () => void listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  };
}

test("a run that needs approval, input or has failed wakes its snoozed chat", async () => {
  const woken: string[] = [];
  const { emit, runs } = attentionRuns();
  const stop = wakeTriageOnAttention(runs, { wake: async (chatId) => (woken.push(chatId), true) });
  emit("a", "working");
  emit("b", "needs_approval", { approvals: ["approval-b"] });
  emit("c", "needs_input", { questions: ["question-c"] });
  emit("d", "failed");
  emit("e", "done");
  emit("f", "failed", { removed: true });
  assert.deepEqual(woken, ["b", "c", "d"]);
  stop();
  emit("g", "failed");
  assert.deepEqual(woken, ["b", "c", "d"]);
});

test("answering one of two approvals keeps a snooze set while the run waits; a new ask wakes it", async (t) => {
  const root = await tmpDir(t);
  let now = 1_000;
  const store = new ChatTriageStore(() => root, { now: () => now, ...manualTimers() });
  t.after(() => store.dispose());
  await store.start();
  const { emit, runs } = attentionRuns();
  const stop = wakeTriageOnAttention(runs, store);
  t.after(stop);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  // The run asks two approvals, then the person snoozes the chat anyway.
  emit("chat-a", "needs_approval", { approvals: ["approval-1", "approval-2"] });
  await settled();
  now = 2_000;
  await store.set("chat-a", { snoozeUntil: 60_000 });

  // One is answered: still waiting, nothing new asked. The snooze stays.
  emit("chat-a", "needs_approval", { approvals: ["approval-2"] });
  await settled();
  assert.equal((await store.get("chat-a"))?.snoozedUntil, 60_000);

  // A new approval arrives: the chat comes back.
  emit("chat-a", "needs_approval", { approvals: ["approval-2", "approval-3"] });
  await waitFor(async () => (await store.get("chat-a"))?.snoozedUntil === undefined);

  // Snoozed again, then the run moves on and comes back to waiting: that wakes it too.
  await store.set("chat-a", { snoozeUntil: 60_000 });
  emit("chat-a", "working");
  await settled();
  assert.equal((await store.get("chat-a"))?.snoozedUntil, 60_000);
  emit("chat-a", "needs_input", { questions: ["question-1"] });
  await waitFor(async () => (await store.get("chat-a"))?.snoozedUntil === undefined);
});

test("answering an approval while the run's question still waits keeps a snooze set during the wait", async (t) => {
  const root = await tmpDir(t);
  let now = 1_000;
  const store = new ChatTriageStore(() => root, { now: () => now, ...manualTimers() });
  t.after(() => store.dispose());
  await store.start();
  const { emit, runs } = attentionRuns();
  const stop = wakeTriageOnAttention(runs, store);
  t.after(stop);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  // The run waits on an approval and a question; the person snoozes the chat.
  emit("chat-a", "needs_approval", { approvals: ["approval-1"], questions: ["question-1"] });
  await settled();
  now = 2_000;
  await store.set("chat-a", { snoozeUntil: 60_000 });

  // The approval is answered and the run reads as waiting on its answer: the same wait, nothing new asked.
  emit("chat-a", "needs_input", { questions: ["question-1"] });
  await settled();
  assert.equal((await store.get("chat-a"))?.snoozedUntil, 60_000);

  // The run fails: that wakes it.
  emit("chat-a", "failed");
  await waitFor(async () => (await store.get("chat-a"))?.snoozedUntil === undefined);
});

test("a listener that throws on a write is logged, and never fails the write or stops the next snooze", async (t) => {
  const root = await tmpDir(t);
  let failPublish = false;
  const timers = manualTimers();
  const logged: unknown[] = [];
  const store = new ChatTriageStore(() => root, {
    now: () => 1_000,
    onChange: () => {
      if (failPublish) throw new Error("broadcast failed");
    },
    logError: (_message, error) => logged.push(error),
    ...timers,
  });
  t.after(() => store.dispose());
  await store.start();
  await store.set("later", { snoozeUntil: 9_000 });
  await store.set("soon", { snoozeUntil: 5_000 });
  await waitFor(() => timers.live().length === 1 && timers.live()[0]!.ms === 4_000);

  // Waking the sooner chat, or forgetting it, leaves the later one armed even when the broadcast fails.
  // The writes stand and the calls succeed, so a Remote retry of the same write
  // doesn't read a conflict.
  failPublish = true;
  const live = () => timers.live().map((timer) => timer.ms).join(",");
  assert.equal(await store.wake("soon"), true);
  assert.equal((await store.get("soon"))?.snoozedUntil, undefined);
  await waitFor(() => live() === "8000");
  const other = await store.set("other", { snoozeUntil: 3_000 });
  assert.equal(other.ok, true);
  assert.equal((await store.get("other"))?.snoozedUntil, 3_000);
  await waitFor(() => live() === "2000");
  await store.remove("other");
  assert.equal(await store.get("other"), null);
  await waitFor(() => live() === "8000");
  assert.equal(logged.length, 3, "each failed announcement is logged");
});

test("a failed clear still re-arms, and a wake check after a clock jump clears a passed snooze", async (t) => {
  const root = await tmpDir(t);
  let now = 1_000;
  let failPublish = false;
  const timers = manualTimers();
  const logged: unknown[] = [];
  const store = new ChatTriageStore(() => root, {
    now: () => now,
    onChange: () => {
      if (failPublish) throw new Error("broadcast failed");
    },
    logError: (_message, error) => logged.push(error),
    ...timers,
  });
  t.after(() => store.dispose());
  await store.start();
  await store.set("soon", { snoozeUntil: 5_000 });
  await store.set("later", { snoozeUntil: 500_000 });
  await waitFor(() => timers.live().length === 1 && timers.live()[0]!.ms === 4_000);

  // The clear that the timer runs fails part-way: the next snooze is still armed.
  now = 5_000;
  failPublish = true;
  const fired = timers.live()[0]!;
  fired.cleared = true;
  fired.callback();
  await waitFor(() => timers.live().length === 1);
  failPublish = false;
  assert.equal((await store.get("soon"))?.snoozedUntil, undefined);
  assert.equal(logged.length, 1, "the failed announcement of the snooze ending is logged");
  // A far snooze is checked at least once a minute, so a clock change is caught.
  assert.equal(timers.live()[0]!.ms, SNOOZE_WAKE_CHECK_MS);

  // The clock jumps past the later snooze (sleep, a manual change) before the
  // timer fires; the resume or unlock check clears it at once.
  now = 600_000;
  await store.checkSnoozes();
  assert.equal((await store.get("later"))?.snoozedUntil, undefined);
  await waitFor(() => timers.live().length === 0);
});

test("the desktop IPC parser copies only known fields and refuses bad input", () => {
  assert.deepEqual(parseChatTriageRequest("chat-a", { done: true }, 3), {
    chatId: "chat-a",
    patch: { done: true },
    ifRevision: 3,
  });
  assert.deepEqual(parseChatTriageRequest("chat-a", { snoozeUntil: null }), { chatId: "chat-a", patch: { snoozeUntil: null } });
  assert.throws(() => parseChatTriageRequest("../x", { done: true }));
  assert.throws(() => parseChatTriageRequest("chat-a", { done: true, extra: 1 }));
  assert.throws(() => parseChatTriageRequest("chat-a", { done: true }, -1));
  assert.throws(() => parseChatTriageRequest("chat-a", { done: true }, "2"));
});

test("the desktop IPC refuses chats this host doesn't list, Bot chats and feature-owned chats, as the Remote route does", async (t) => {
  const root = await tmpDir(t);
  const store = new ChatTriageStore(() => root, { now: () => 100 });
  const dependencies = {
    chats: async () => [
      { id: "chat-a" },
      { id: "assistant-chat", workspaceId: "assistant" },
      { id: "bot-chat", botId: "bot-1" },
      { id: "design-chat", owner: { kind: "design-project" as const, projectId: "project-1" } },
    ],
    triage: store,
  };
  assert.equal((await setChatTriageFromRenderer(dependencies, "chat-a", { pinned: true })).ok, true);
  assert.equal((await setChatTriageFromRenderer(dependencies, "assistant-chat", { done: true })).ok, true);
  await assert.rejects(setChatTriageFromRenderer(dependencies, "gone", { pinned: true }), /no longer exists/u);
  await assert.rejects(setChatTriageFromRenderer(dependencies, "bot-chat", { done: true }), /no longer exists/u);
  await assert.rejects(setChatTriageFromRenderer(dependencies, "design-chat", { pinned: true }), /no longer exists/u);
  assert.deepEqual(Object.keys((await store.snapshot()).chats).sort(), ["assistant-chat", "chat-a"]);
});
