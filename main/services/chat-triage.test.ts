import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ChatTriageStore, wakeTriageOnAttention } from "./chat-triage.js";
import { parseChatTriageRequest } from "../handlers/chat-triage-params.js";
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

  // On a Monday, next week means the following Monday, not today.
  const monday = snoozeOptions(new Date(2026, 10, 2, 8, 0, 0, 0));
  const nextMonday = new Date(monday.find((option) => option.preset === "next_week")!.until);
  assert.deepEqual([nextMonday.getDay(), nextMonday.getDate()], [1, 9]);
  // On a Sunday, it is tomorrow.
  const sunday = snoozeOptions(new Date(2026, 10, 8, 20, 0, 0, 0));
  assert.equal(new Date(sunday.find((option) => option.preset === "next_week")!.until).getDate(), 9);
});

test("a run that needs approval, input or has failed wakes its snoozed chat", async () => {
  const listeners: Array<(summary: { chatId: string; state: string }, removed: boolean) => void> = [];
  const woken: string[] = [];
  const stop = wakeTriageOnAttention(
    {
      onChange(listener) {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    },
    { wake: async (chatId) => (woken.push(chatId), true) },
  );
  const emit = (chatId: string, state: string, removed = false) => listeners.forEach((listener) => listener({ chatId, state }, removed));
  emit("a", "working");
  emit("b", "needs_approval");
  emit("c", "needs_input");
  emit("d", "failed");
  emit("e", "done");
  emit("f", "failed", true);
  assert.deepEqual(woken, ["b", "c", "d"]);
  stop();
  emit("g", "failed");
  assert.deepEqual(woken, ["b", "c", "d"]);
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
