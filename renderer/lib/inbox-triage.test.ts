import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ChatTriageStore } from "../../main/services/chat-triage";
import type { ChatTriageEntry, ChatTriagePatch } from "../shared/chat-triage";
import {
  formatSnoozeUntil,
  groupByHost,
  inboxTriagePatch,
  inboxTriageToastTitle,
  inboxTriageUndoConflictText,
  inboxTriageUndoWrites,
  INBOX_TRIAGE_UNDO_MS,
  mergeInboxTriageUndo,
  newerTriage,
  predictTriage,
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
  // A Needs you row stays where it is: triage never hides an approval.
  assert.equal(placed(inboxTriagePatch("snooze", NOW + HOUR), { rowState: "needs_approval" }), "needs_you");
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
