import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ChatTriageStore } from "../../main/services/chat-triage";
import { snoozeOptions, type ChatTriageEntry, type ChatTriagePatch } from "../shared/chat-triage";
import {
  formatSnoozeMenuTime,
  formatSnoozeStatus,
  formatSnoozeUntil,
  groupByHost,
  inboxTriageOffer,
  inboxTriagePatch,
  inboxTriageToastTitle,
  inboxTriageUndoConflictText,
  inboxTriageUndoWrites,
  INBOX_TRIAGE_UNDO_MS,
  mergeInboxTriageUndo,
  newerTriage,
  predictTriage,
  settledTriageOverlayKeys,
  triageSignals,
  type InboxTriageTarget,
  type InboxTriageUndoBatch,
} from "./inbox-triage";
import { inboxState, type InboxSignals } from "./sidebar-inbox";
import { projectOrderKey } from "./sidebar-organization";

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 31, 12, 0).getTime();

function target(chatId: string, hostId = "local"): InboxTriageTarget {
  return { key: projectOrderKey(hostId, chatId), hostId, chatId };
}

function signals(overrides: Partial<InboxSignals> = {}): InboxSignals {
  return {
    rowState: "idle",
    unread: false,
    failed: false,
    isOpen: false,
    hostOnline: true,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

test("the optimistic entry is the one the host's store writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-inbox-triage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = NOW;
  const store = new ChatTriageStore(() => root, { now: () => now });
  const steps: ChatTriagePatch[] = [
    inboxTriagePatch("pin"),
    inboxTriagePatch("done"),
    inboxTriagePatch("snooze", NOW + 5 * HOUR),
    inboxTriagePatch("pin"),
    { snoozeUntil: null, done: false },
    inboxTriagePatch("unpin"),
  ];
  for (const patch of steps) {
    now += 60_000;
    const before = await store.get("chat-1");
    const result = await store.set("chat-1", patch);
    assert.equal(result.ok, true);
    assert.deepEqual(predictTriage(before, patch, now), result.ok ? result.entry : null, JSON.stringify(patch));
  }
});

test("a write shows until its host reports that revision", () => {
  const reported: ChatTriageEntry = { revision: 3, updatedAt: NOW };
  const written: ChatTriageEntry = { revision: 4, updatedAt: NOW, doneAt: NOW };
  assert.equal(newerTriage(reported, written), written);
  assert.equal(newerTriage({ revision: 4, updatedAt: NOW + 1 }, written)?.updatedAt, NOW + 1);
  assert.equal(newerTriage({ revision: 6, updatedAt: NOW }, written)?.revision, 6);
  assert.equal(newerTriage(undefined, written), written);
  assert.equal(newerTriage(reported, undefined), reported);
});

test("each action moves its row the moment it is predicted", () => {
  const placed = (patch: ChatTriagePatch, base: Partial<InboxSignals> = {}) =>
    inboxState(signals({ ...base, ...triageSignals(predictTriage(null, patch, NOW)) }), NOW, 24 * HOUR).shelf;
  assert.equal(placed(inboxTriagePatch("pin")), "pinned");
  assert.equal(placed(inboxTriagePatch("done"), { unread: true, lastAssistantAt: NOW - HOUR }), "hidden");
  assert.equal(placed(inboxTriagePatch("snooze", NOW + HOUR), { unread: true }), "hidden");
  // Mark not done and Unsnooze put a Done or snoozed row back.
  const done = predictTriage(null, { done: true }, NOW - HOUR);
  const back = (patch: ChatTriagePatch) =>
    inboxState(signals({ unread: true, ...triageSignals(predictTriage(done, patch, NOW)) }), NOW, 24 * HOUR).shelf;
  assert.equal(back(inboxTriagePatch("undone")), "updates");
  const snoozed = predictTriage(null, { snoozeUntil: NOW + HOUR }, NOW - HOUR);
  assert.equal(
    inboxState(signals({ unread: true, ...triageSignals(predictTriage(snoozed, inboxTriagePatch("unsnooze"), NOW)) }), NOW, 24 * HOUR).shelf,
    "updates",
  );
});

test("a row offers Mark done and Snooze only where they move it", () => {
  const rows: Record<string, Partial<InboxSignals>> = {
    update: { unread: true, lastAssistantAt: NOW - HOUR },
    earlier: {},
    pinned: { pinnedAt: NOW - 2 * HOUR },
    "unread failure": { failed: true, unread: true, lastAssistantAt: NOW - HOUR },
    "open failure": { failed: true, unread: true, isOpen: true, lastAssistantAt: NOW - HOUR },
    approval: { rowState: "needs_approval", unread: true },
    question: { rowState: "needs_input" },
    running: { rowState: "working" },
    detached: { attention: "detached" },
  };
  for (const [name, base] of Object.entries(rows)) {
    const offer = inboxTriageOffer(signals(base), NOW);
    for (const patch of [inboxTriagePatch("done"), inboxTriagePatch("snooze", NOW + HOUR)]) {
      const after = signals({
        ...base,
        ...(offer.alsoMarkRead ? { unread: false } : {}),
        ...triageSignals(predictTriage(null, patch, NOW)),
      });
      const shelf = inboxState(after, NOW, 24 * HOUR).shelf;
      if (offer.doneAndSnooze) assert.equal(shelf, "hidden", `${name}: ${JSON.stringify(patch)} hides the row`);
      else assert.notEqual(shelf, "hidden", `${name}: the action would leave the row in place, so it isn't offered`);
    }
  }
  // Only an unseen failure needs the read too; without it the row stays in Needs you.
  const failure = signals(rows["unread failure"]);
  assert.equal(inboxTriageOffer(failure, NOW).alsoMarkRead, true);
  assert.equal(inboxState({ ...failure, ...triageSignals(predictTriage(null, { done: true }, NOW)) }, NOW).shelf, "needs_you");
  assert.equal(inboxTriageOffer(signals(rows.update), NOW).alsoMarkRead, false);
  assert.equal(inboxTriageOffer(signals(rows["open failure"]), NOW).alsoMarkRead, false);
});

test("a Done or snoozed row's menu reads Mark not done or Unsnooze", () => {
  const offer = (entry: ChatTriageEntry, base: Partial<InboxSignals> = {}) =>
    inboxTriageOffer(signals({ ...base, ...triageSignals(entry) }), NOW);
  const done = predictTriage(null, { done: true }, NOW - HOUR);
  assert.deepEqual([offer(done).done, offer(done).snoozed], [true, false]);
  // Newer output undoes Done by itself, so the item reads Mark done again.
  assert.equal(offer(done, { lastAssistantAt: NOW }).done, false);
  const snoozed = predictTriage(null, { snoozeUntil: NOW + HOUR }, NOW - HOUR);
  assert.deepEqual([offer(snoozed).done, offer(snoozed).snoozed], [false, true]);
  const woke = predictTriage(null, { snoozeUntil: NOW - 1 + HOUR }, NOW - 2 * HOUR);
  assert.equal(inboxTriageOffer(signals(triageSignals(woke)), NOW + HOUR).snoozed, false, "a passed snooze no longer holds");
});

test("a row held by a wait or a run still offers Unsnooze, so it stays once the wait ends", () => {
  const snoozed = predictTriage(null, { snoozeUntil: NOW + 3 * HOUR }, NOW - HOUR);
  for (const held of [{ rowState: "needs_approval" }, { rowState: "working" }, { attention: "detached" }] as const) {
    const offer = inboxTriageOffer(signals({ ...held, unread: true, ...triageSignals(snoozed) }), NOW);
    assert.deepEqual([offer.doneAndSnooze, offer.snoozed], [false, true], JSON.stringify(held));
  }
  // The approval is answered and the run ends: kept snoozed, the row would drop out.
  const later = (entry: ChatTriageEntry) =>
    inboxState(signals({ unread: true, lastAssistantAt: NOW, ...triageSignals(entry) }), NOW + HOUR, 24 * HOUR).shelf;
  assert.equal(later(snoozed), "hidden");
  assert.equal(later(predictTriage(snoozed, inboxTriagePatch("unsnooze"), NOW)), "updates");
});

test("actions of one kind inside the Undo window merge into one batch", () => {
  const first: InboxTriageUndoBatch = {
    kind: "done",
    items: [{ target: target("a"), before: null, patch: { done: true }, revision: 1 }],
    at: NOW,
  };
  const second: InboxTriageUndoBatch = {
    kind: "done",
    items: [{ target: target("b", "studio"), before: { revision: 4, updatedAt: 0 }, patch: { done: true }, revision: 5 }],
    at: NOW + 2_000,
  };
  const third: InboxTriageUndoBatch = {
    kind: "done",
    items: [{ target: target("c"), before: null, patch: { done: true }, revision: 1 }],
    at: NOW + 4_000,
  };
  const merged = mergeInboxTriageUndo(mergeInboxTriageUndo(first, second), third);
  assert.deepEqual(merged.items.map((item) => item.target.chatId), ["a", "b", "c"]);
  assert.equal(inboxTriageToastTitle(merged, String), "3 chats marked done");

  // Another kind, or a gap of the whole window, starts afresh.
  assert.equal(mergeInboxTriageUndo(first, { ...second, kind: "pin" }).items.length, 1);
  assert.equal(mergeInboxTriageUndo(first, { ...second, at: NOW + INBOX_TRIAGE_UNDO_MS }).items.length, 1);
});

test("Undo restores a chat acted on twice to how it was before both", () => {
  const before: ChatTriageEntry = { revision: 2, updatedAt: 0, snoozedUntil: NOW + 2 * HOUR };
  const first: InboxTriageUndoBatch = {
    kind: "snooze",
    items: [{ target: target("a"), before, patch: { snoozeUntil: NOW + HOUR }, revision: 3 }],
    at: NOW,
    until: NOW + HOUR,
  };
  const second: InboxTriageUndoBatch = {
    kind: "snooze",
    items: [{ target: target("a"), before: { revision: 3, updatedAt: NOW }, patch: { snoozeUntil: NOW + 3 * HOUR }, revision: 4 }],
    at: NOW + 1_000,
    until: NOW + 3 * HOUR,
  };
  const merged = mergeInboxTriageUndo(first, second);
  assert.equal(merged.items.length, 1);
  assert.equal(inboxTriageToastTitle(merged, (at) => (at === NOW + 3 * HOUR ? "3 PM" : "?")), "Snoozed until 3 PM");
  const [write] = inboxTriageUndoWrites(merged);
  assert.deepEqual(write?.patch, { snoozeUntil: NOW + 2 * HOUR });
  assert.equal(write?.ifRevision, 4);
});

test("the Undo toast names a snooze time only when every merged chat wakes then", () => {
  const snooze = (chatId: string, until: number, at: number): InboxTriageUndoBatch => ({
    kind: "snooze",
    items: [{ target: target(chatId), before: null, patch: { snoozeUntil: until }, revision: 1 }],
    at,
    until,
  });
  const label = (at: number) => (at === NOW + HOUR ? "1 PM" : "4 PM");
  const same = mergeInboxTriageUndo(snooze("a", NOW + HOUR, NOW), snooze("b", NOW + HOUR, NOW + 1_000));
  assert.equal(inboxTriageToastTitle(same, label), "2 chats snoozed");
  assert.equal(same.until, NOW + HOUR);
  const mixed = mergeInboxTriageUndo(snooze("a", NOW + HOUR, NOW), snooze("b", NOW + 4 * HOUR, NOW + 1_000));
  assert.equal(mixed.until, undefined);
  // Moving the first chat to the second's time makes them agree again.
  const aligned = mergeInboxTriageUndo(mixed, snooze("a", NOW + 4 * HOUR, NOW + 2_000));
  assert.equal(aligned.until, NOW + 4 * HOUR);
});

test("Undo lands only where nothing changed since, by the store's ifRevision", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-inbox-undo-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatTriageStore(() => root, { now: () => NOW });
  const done = await store.set("a", { done: true });
  const pinned = await store.set("b", { pinned: true });
  assert.ok(done.ok && pinned.ok);
  // Another device pins chat a in between.
  await store.set("a", { pinned: true });
  const batch: InboxTriageUndoBatch = {
    kind: "done",
    items: [
      { target: target("a"), before: null, patch: { done: true }, revision: done.entry.revision },
      { target: target("b"), before: null, patch: { pinned: true }, revision: pinned.entry.revision },
    ],
    at: NOW,
  };
  const results = [];
  for (const write of inboxTriageUndoWrites(batch)) {
    results.push(await store.set(write.target.chatId, write.patch, { ifRevision: write.ifRevision }));
  }
  assert.deepEqual(results.map((result) => (result.ok ? "ok" : result.code)), ["revision_conflict", "ok"]);
  assert.notEqual((await store.get("a"))?.doneAt, undefined);
  assert.equal((await store.get("b"))?.pinnedAt, undefined);
  assert.equal(inboxTriageUndoConflictText(1, 2), "1 chat changed since, so Undo left it as it is.");
});

test("Undo of Done on a chat newer output had reopened puts it back where it was, not hidden again", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-inbox-undo-reopened-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new ChatTriageStore(() => root, { now: () => now });
  const shelf = (entry: ChatTriageEntry | null | undefined, lastAssistantAt: number) =>
    inboxState(signals({ unread: true, lastAssistantAt, ...triageSignals(entry ?? undefined) }), now, 24 * HOUR).shelf;
  assert.ok((await store.set("a", { done: true })).ok);
  // A reply at 2000 ends that Done; the chat is back in Updates.
  const reply = 2_000;
  now = 2_500;
  const before = (await store.get("a")) ?? null;
  assert.equal(shelf(before, reply), "updates");
  now = 3_000;
  const done = await store.set("a", { done: true });
  assert.ok(done.ok);
  assert.notEqual(shelf(done.entry, reply), "updates");
  now = 4_000;
  const [write] = inboxTriageUndoWrites({
    kind: "done",
    items: [{ target: target("a"), before, lastAssistantAt: reply, patch: { done: true }, revision: done.entry.revision }],
    at: 3_000,
  });
  assert.ok(write);
  const undone = await store.set("a", write.patch, { ifRevision: write.ifRevision });
  assert.ok(undone.ok);
  assert.equal(shelf(undone.entry, reply), "updates");
  // A Done that still held is restored as Done.
  const [held] = inboxTriageUndoWrites({
    kind: "done",
    items: [{ target: target("b"), before: { revision: 1, updatedAt: 0, doneAt: 1_000 }, lastAssistantAt: 900, patch: { done: true }, revision: 2 }],
    at: 3_000,
  });
  assert.deepEqual(held?.patch, { done: true });
});

test("writes group by host in first-seen order", () => {
  const writes = [target("a"), target("b", "studio"), target("c"), target("d", "studio")].map((entry) => ({ target: entry }));
  const groups = groupByHost(writes);
  assert.deepEqual([...groups.keys()], ["local", "studio"]);
  assert.deepEqual(groups.get("studio")?.map((write) => write.target.chatId), ["b", "d"]);
});

test("the toast names a snooze's end by day", () => {
  const at = (days: number, hour: number) => new Date(2026, 9, 31 + days, hour, 0).getTime();
  assert.doesNotMatch(formatSnoozeUntil(at(0, 18), NOW, "en-US"), /tomorrow|day/u);
  assert.match(formatSnoozeUntil(at(1, 9), NOW, "en-US"), /^tomorrow, 9:00\sAM$/u);
  assert.match(formatSnoozeUntil(at(2, 9), NOW, "en-US"), /^Monday, 9:00\sAM$/u);
  assert.match(formatSnoozeUntil(at(9, 9), NOW, "en-US"), /^Mon, Nov 9, 9:00\sAM$/u);
});

test("the Snooze menu's trailing time never repeats the preset's day", () => {
  const at = (days: number, hour: number) => new Date(2026, 9, 31 + days, hour, 0).getTime();
  // Today: the time alone. Within the week: the short weekday, never "tomorrow". Further: the date.
  assert.match(formatSnoozeMenuTime(at(0, 18), NOW, "en-US"), /^6:00\sPM$/u);
  assert.match(formatSnoozeMenuTime(at(1, 9), NOW, "en-US"), /^Sun 9:00\sAM$/u);
  assert.match(formatSnoozeMenuTime(at(2, 9), NOW, "en-US"), /^Mon 9:00\sAM$/u);
  assert.match(formatSnoozeMenuTime(at(9, 9), NOW, "en-US"), /^Nov 9, 9:00\sAM$/u);
});

test("a snoozed row's status is short beside its workspace", () => {
  const at = (days: number, hour: number, minute = 0) => new Date(2026, 9, 31 + days, hour, minute).getTime();
  // Today: the time, without ":00" on the hour. Within the week: the short weekday too. Further: the date.
  assert.match(formatSnoozeStatus(at(0, 13, 42), NOW, "en-US"), /^1:42\sPM$/u);
  assert.match(formatSnoozeStatus(at(0, 18), NOW, "en-US"), /^6\sPM$/u);
  assert.match(formatSnoozeStatus(at(2, 9), NOW, "en-US"), /^Mon 9\sAM$/u);
  assert.match(formatSnoozeStatus(at(16, 9), NOW, "en-US"), /^Nov 16$/u);
  // A 24-hour clock keeps its minutes: a bare "18" wouldn't read as a time.
  assert.equal(formatSnoozeStatus(at(0, 18), NOW, "en-GB"), "18:00");
  assert.match(formatSnoozeStatus(at(2, 9), NOW, "en-GB"), /^Mon 0?9:00$/u);
  assert.equal(formatSnoozeStatus(at(0, 13, 42), NOW, "en-GB"), "13:42");
});

test("no two Snooze presets read the same time, whatever the day", () => {
  // A whole week of mornings and evenings, Sunday included, where Tomorrow and
  // Next week both land on a Monday.
  for (let day = 0; day < 7; day += 1) {
    // This evening (18:00) shows only while it is more than an hour away:
    // still there at 16:59, gone from 17:00.
    const cases = [[8, 0, true], [16, 0, true], [16, 59, true], [17, 0, false], [17, 30, false]] as const;
    for (const [hour, minute, eveningShown] of cases) {
      const now = new Date(2026, 10, 1 + day, hour, minute);
      const options = snoozeOptions(now);
      const times = options.map((option) => formatSnoozeMenuTime(option.until, now.getTime(), "en-US"));
      const label = `${now.toDateString()} ${hour}:${String(minute).padStart(2, "0")}`;
      assert.equal(new Set(times).size, times.length, `${label} reads ${times.join(" | ")}`);
      assert.equal(
        options.some((option) => option.preset === "evening"),
        eveningShown,
        `${label}: This evening ${eveningShown ? "shows" : "drops out"}`,
      );
    }
  }
});

test("the toast's titles and conflict notes read naturally", () => {
  const items = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ target: target(`c${index}`), before: null, patch: {}, revision: 1 }));
  assert.equal(inboxTriageToastTitle({ kind: "pin", items: items(1) }, String), "Pinned");
  assert.equal(inboxTriageToastTitle({ kind: "unpin", items: items(2) }, String), "2 chats unpinned");
  assert.equal(inboxTriageToastTitle({ kind: "snooze", items: items(4) }, String), "4 chats snoozed");
  assert.equal(inboxTriageUndoConflictText(1, 1), "That chat changed since, so Undo left it as it is.");
  assert.equal(inboxTriageUndoConflictText(3, 3), "Those chats changed since, so Undo left them as they are.");
  assert.equal(inboxTriageUndoConflictText(2, 3), "2 chats changed since, so Undo left them as they are.");
});

test("an overlay entry goes once its host reports that revision or a newer one, and stays while a host reports nothing", () => {
  const entry = (revision: number): ChatTriageEntry => ({ revision, updatedAt: 1_000, pinnedAt: 1_000 });
  const overlay = new Map([
    [projectOrderKey("local", "a"), entry(3)],
    [projectOrderKey("local", "b"), entry(3)],
    [projectOrderKey("studio", "c"), entry(5)],
    [projectOrderKey("studio", "d"), entry(5)],
    [projectOrderKey("older", "e"), entry(2)],
  ]);
  const local = { a: entry(3), b: entry(2) };
  const reported = new Map([
    [projectOrderKey("studio", "c"), entry(6)],
    [projectOrderKey("studio", "d"), entry(4)],
    // The same chat id on this Mac is a different row.
    [projectOrderKey("studio", "b"), entry(9)],
  ]);
  assert.deepEqual(
    settledTriageOverlayKeys(overlay, local, reported).sort(),
    [projectOrderKey("local", "a"), projectOrderKey("studio", "c")].sort(),
  );
  assert.deepEqual(settledTriageOverlayKeys(overlay, undefined, undefined), [], "nothing reported yet keeps every entry");
});
