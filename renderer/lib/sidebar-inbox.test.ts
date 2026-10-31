import assert from "node:assert/strict";
import test from "node:test";
import {
  freezeInboxOrder,
  inboxDisplayOrder,
  inboxState,
  organizeInbox,
  releasedInboxOrder,
  type HeldInboxOrder,
  type InboxDisplayOrder,
  type InboxRow,
  type InboxSignals,
} from "./sidebar-inbox";
import { projectOrderKey } from "./sidebar-organization";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 31, 12);

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

function row(id: string, overrides: Partial<InboxSignals> = {}, hostId = "local"): InboxRow {
  return { key: projectOrderKey(hostId, id), signals: signals(overrides) };
}

const ids = (rows: readonly InboxRow[]) => rows.map((entry) => decodeURIComponent(entry.key.split(":")[1] ?? ""));

test("each placement rule lands on its shelf", () => {
  const cases: [string, Partial<InboxSignals>, string, number][] = [
    ["approval", { rowState: "needs_approval" }, "needs_you", 0],
    ["question", { rowState: "needs_input" }, "needs_you", 1],
    ["unread failure", { failed: true, unread: true }, "needs_you", 2],
    ["detached", { attention: "detached" }, "needs_you", 3],
    ["interrupted", { attention: "interrupted" }, "needs_you", 3],
    ["working", { rowState: "working" }, "working", 0],
    ["pinned", { pinnedAt: NOW - DAY }, "pinned", 0],
    ["unread", { unread: true }, "updates", 0],
    ["read and recent", {}, "earlier", 0],
    ["read and old", { updatedAt: NOW - 8 * DAY }, "hidden", 0],
  ];
  for (const [label, overrides, shelf, tier] of cases) {
    const placement = inboxState(signals(overrides), NOW);
    assert.deepEqual([placement.shelf, placement.tier], [shelf, tier], label);
  }
});

test("a read failure is not urgent, and a failed run that is working again is working", () => {
  assert.equal(inboxState(signals({ failed: true }), NOW).shelf, "earlier");
  assert.equal(inboxState(signals({ failed: true, unread: true, rowState: "working" }), NOW).shelf, "working");
});

test("the open chat is never unread and stays listed however old", () => {
  assert.equal(inboxState(signals({ unread: true, isOpen: true }), NOW).shelf, "earlier");
  assert.equal(inboxState(signals({ failed: true, unread: true, isOpen: true }), NOW).shelf, "earlier");
  assert.equal(inboxState(signals({ isOpen: true, updatedAt: NOW - 30 * DAY }), NOW).shelf, "earlier");
});

test("the recent window is a parameter", () => {
  const twoDaysOld = signals({ updatedAt: NOW - 2 * DAY });
  assert.equal(inboxState(twoDaysOld, NOW, DAY).shelf, "hidden");
  assert.equal(inboxState(twoDaysOld, NOW, 3 * DAY).shelf, "earlier");
  assert.equal(inboxState(signals({ updatedAt: NOW - 7 * DAY }), NOW).shelf, "earlier");
});

test("Done hides a chat until newer output arrives", () => {
  const doneAt = NOW - 2 * HOUR;
  assert.equal(inboxState(signals({ doneAt, lastAssistantAt: doneAt - MINUTE }), NOW).shelf, "hidden");
  assert.equal(inboxState(signals({ doneAt, lastAssistantAt: doneAt }), NOW).shelf, "hidden");
  assert.equal(inboxState(signals({ doneAt }), NOW).shelf, "hidden");
  assert.equal(
    inboxState(signals({ doneAt, lastAssistantAt: doneAt + MINUTE, unread: true }), NOW).shelf,
    "updates",
  );
});

test("a snooze hides until it expires, and prompts or failures wake it early", () => {
  const snoozedUntil = NOW + HOUR;
  assert.equal(inboxState(signals({ snoozedUntil, unread: true }), NOW).shelf, "hidden");
  assert.equal(inboxState(signals({ snoozedUntil, unread: true }), snoozedUntil).shelf, "updates");
  assert.equal(inboxState(signals({ snoozedUntil, rowState: "needs_approval" }), NOW).shelf, "needs_you");
  assert.equal(inboxState(signals({ snoozedUntil, failed: true, unread: true }), NOW).shelf, "needs_you");
  assert.equal(
    inboxState(signals({ doneAt: NOW, rowState: "needs_input" }), NOW).shelf,
    "needs_you",
  );
});

test("Needs you orders by tier, then the longest wait, falling back to updatedAt", () => {
  const organized = organizeInbox([
    row("failed-new", { failed: true, unread: true, updatedAt: NOW - MINUTE }),
    row("question", { rowState: "needs_input", attentionSince: NOW - 5 * MINUTE }),
    row("approval-recent", { rowState: "needs_approval", attentionSince: NOW - MINUTE }),
    row("interrupted", { attention: "interrupted", attentionSince: NOW - 3 * DAY }),
    row("approval-remote", { rowState: "needs_approval", updatedAt: NOW - 20 * MINUTE }, "mac-2"),
    row("approval-old", { rowState: "needs_approval", attentionSince: NOW - 30 * MINUTE }),
    row("failed-old", { failed: true, unread: true, updatedAt: NOW - 2 * HOUR }),
  ], NOW);
  assert.deepEqual(ids(organized.needsYou), [
    "approval-old",
    "approval-remote",
    "approval-recent",
    "question",
    "failed-old",
    "failed-new",
    "interrupted",
  ]);
});

test("every other shelf follows its own order", () => {
  const organized = organizeInbox([
    row("pin-old", { pinnedAt: NOW - 3 * DAY }),
    row("pin-new", { pinnedAt: NOW - DAY }),
    row("update-old", { unread: true, lastAssistantAt: NOW - 3 * HOUR }),
    row("update-new", { unread: true, lastAssistantAt: NOW - MINUTE }),
    row("earlier-old", { updatedAt: NOW - 2 * DAY }),
    row("earlier-new", { updatedAt: NOW - MINUTE }),
    row("work-late", { rowState: "working", runStartedAt: NOW - MINUTE }),
    row("work-early", { rowState: "working", runStartedAt: NOW - HOUR }),
  ], NOW);
  assert.deepEqual(ids(organized.pinned), ["pin-new", "pin-old"]);
  assert.deepEqual(ids(organized.updates), ["update-new", "update-old"]);
  assert.deepEqual(ids(organized.earlier), ["earlier-new", "earlier-old"]);
  assert.deepEqual(ids(organized.working), ["work-early", "work-late"]);
});

test("ties break on the host-qualified key, whatever the input order", () => {
  const tied = [
    row("b", { updatedAt: NOW - HOUR }),
    row("a", { updatedAt: NOW - HOUR }, "mac-2"),
    row("a", { updatedAt: NOW - HOUR }),
  ];
  const expected = ["local:a", "local:b", "mac-2:a"];
  assert.deepEqual(organizeInbox(tied, NOW).earlier.map((entry) => entry.key), expected);
  assert.deepEqual(organizeInbox([...tied].reverse(), NOW).earlier.map((entry) => entry.key), expected);
});

test("Earlier is capped with a Show more count, and hidden rows are counted", () => {
  const rows = Array.from({ length: 23 }, (_, index) => row(`chat-${String(index).padStart(2, "0")}`, {
    updatedAt: NOW - (index + 1) * MINUTE,
  }));
  rows.push(row("stale", { updatedAt: NOW - 9 * DAY }), row("done", { doneAt: NOW }));
  const capped = organizeInbox(rows, NOW);
  assert.equal(capped.earlier.length, 20);
  assert.deepEqual(ids(capped.earlier).slice(-2), ["chat-18", "chat-19"]);
  assert.equal(capped.earlierMoreCount, 3);
  assert.equal(capped.hiddenCount, 2);

  const all = organizeInbox(rows, NOW, { showAllEarlier: true });
  assert.equal(all.earlier.length, 23);
  assert.equal(all.earlierMoreCount, 0);
  assert.equal(organizeInbox(rows, NOW, { earlierLimit: 5 }).earlierMoreCount, 18);
});

test("rows from an offline host keep their place but leave the Needs you count", () => {
  const organized = organizeInbox([
    row("local-approval", { rowState: "needs_approval" }),
    row("offline-approval", { rowState: "needs_approval", hostOnline: false }, "mac-2"),
  ], NOW);
  assert.equal(organized.needsYou.length, 2);
  assert.equal(organized.needsYouCount, 1);
});

function order(partial: Partial<Record<keyof InboxDisplayOrder, string[]>>): InboxDisplayOrder {
  return { needs_you: [], pinned: [], updates: [], earlier: [], working: [], ...partial };
}

function shown(held: HeldInboxOrder, section: keyof InboxDisplayOrder): string[] {
  return held[section].map((entry) =>
    entry.leaving ? `${entry.key}(leaving)` : entry.liveSection ? `${entry.key}(→${entry.liveSection})` : entry.key);
}

const NOTHING = new Set<string>();

test("a freeze appends new rows to the end of their section", () => {
  const previous = releasedInboxOrder(order({ updates: ["a", "b"] }));
  const held = freezeInboxOrder({
    previous,
    next: order({ updates: ["new", "b", "a"] }),
    touched: NOTHING,
    present: new Set(["a", "b", "new"]),
  });
  assert.deepEqual(shown(held, "updates"), ["a", "b", "new"]);
});

test("a freeze keeps a row whose state changed in its slot", () => {
  const previous = releasedInboxOrder(order({ needs_you: ["x"], updates: ["a", "b", "c"] }));
  const held = freezeInboxOrder({
    previous,
    next: order({ needs_you: ["b", "x"], updates: ["a", "c"] }),
    touched: NOTHING,
    present: new Set(["a", "b", "c", "x"]),
  });
  assert.deepEqual(shown(held, "updates"), ["a", "b(→needs_you)", "c"]);
  assert.deepEqual(shown(held, "needs_you"), ["x"]);
});

test("a freeze holds a row that left the list, dimmed, until it comes back", () => {
  const previous = releasedInboxOrder(order({ updates: ["a", "b", "c"] }));
  const present = new Set(["a", "b", "c"]);
  const left = freezeInboxOrder({ previous, next: order({ updates: ["a", "c"] }), touched: NOTHING, present });
  assert.deepEqual(shown(left, "updates"), ["a", "b(leaving)", "c"]);
  const back = freezeInboxOrder({ previous: left, next: order({ updates: ["b", "a", "c"] }), touched: NOTHING, present });
  assert.deepEqual(shown(back, "updates"), ["a", "b", "c"]);
});

test("a freeze drops deleted rows at once", () => {
  const previous = releasedInboxOrder(order({ earlier: ["a", "b", "c"] }));
  const held = freezeInboxOrder({
    previous,
    next: order({ earlier: ["a", "c"] }),
    touched: NOTHING,
    present: new Set(["a", "c"]),
  });
  assert.deepEqual(shown(held, "earlier"), ["a", "c"]);
});

test("a freeze places a touched row at its live position", () => {
  // Mark read on `b`: it moves from Updates into Earlier, after `e1` where the live order puts it.
  const previous = releasedInboxOrder(order({ updates: ["a", "b", "c"], earlier: ["e1", "e2"] }));
  const held = freezeInboxOrder({
    previous,
    next: order({ updates: ["a", "c"], earlier: ["e1", "b", "e2"] }),
    touched: new Set(["b"]),
    present: new Set(["a", "b", "c", "e1", "e2"]),
  });
  assert.deepEqual(shown(held, "updates"), ["a", "c"]);
  assert.deepEqual(shown(held, "earlier"), ["e1", "b", "e2"]);

  // A touched row first in its live section goes to the top; one that left the list goes at once.
  const top = freezeInboxOrder({
    previous,
    next: order({ updates: ["c"], earlier: ["b", "e1", "e2"] }),
    touched: new Set(["b", "a"]),
    present: new Set(["a", "b", "c", "e1", "e2"]),
  });
  assert.deepEqual(shown(top, "updates"), ["c"]);
  assert.deepEqual(shown(top, "earlier"), ["b", "e1", "e2"]);
});

test("the display order follows the organized sections", () => {
  const organized = organizeInbox([
    row("w", { rowState: "working", runStartedAt: NOW - MINUTE }),
    row("u", { unread: true }),
  ], NOW);
  assert.deepEqual(inboxDisplayOrder(organized), order({ working: ["local:w"], updates: ["local:u"] }));
});
