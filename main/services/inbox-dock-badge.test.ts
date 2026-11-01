import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPendingAttention } from "../../renderer/shared/chat-pending-attention.js";
import type { PeerFeedRow, PeerHostFeedSnapshot, PeerHostStatus, PeerRunState } from "../../renderer/shared/peer-host.js";
import {
  badgeSurface,
  createInboxBadgeDriver,
  inboxBadgeCount,
  type InboxBadgeLocal,
  type InboxBadgeLocalChat,
  type InboxBadgePeer,
} from "./inbox-dock-badge.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function local(overrides: Partial<InboxBadgeLocal> = {}): InboxBadgeLocal {
  return {
    chats: [],
    workspaceIds: new Set(["ws-1"]),
    activity: { activeChatIds: [], approvalChatIds: [], inputChatIds: [] },
    // Everything before this read as seen.
    markers: { revision: 1, baselineAt: NOW - 10 * HOUR, readThrough: {} },
    triage: {},
    pending: new Map(),
    botsNeedingYou: [],
    ...overrides,
  };
}

function chat(id: string, extra: Partial<InboxBadgeLocalChat> = {}): InboxBadgeLocalChat {
  return { id, workspaceId: "ws-1", updatedAt: NOW - HOUR, lastAssistantAt: NOW - HOUR, ...extra };
}

function status(hostId: string, state: PeerHostStatus["state"] = { kind: "connected", since: NOW - HOUR }, stale = false): PeerHostStatus {
  return { hostId, generation: 1, state, feed: "live", stale };
}

function feed(hostId: string, rows: Partial<PeerHostFeedSnapshot> = {}): PeerHostFeedSnapshot {
  return { hostId, epoch: "e1", sequence: 1, stale: false, summaries: [], workspaces: [], bots: [], runs: [], ...rows };
}

function summary(id: string, extra: Record<string, unknown> = {}): PeerFeedRow {
  return { id, workspaceId: "remote-ws", rowState: "idle", unread: false, ...extra };
}

const approvalRun = (chatId: string): PeerRunState => ({ chatId, runId: `run-${chatId}`, state: "needs_approval", unread: false });

const count = (localInput: InboxBadgeLocal, peers: InboxBadgePeer[] = []) =>
  inboxBadgeCount({ now: NOW, local: localInput, peers });

test("counts this Mac's approvals, questions, detached waits, unseen failures and Bots that need you", () => {
  const detached: ChatPendingAttention = { chatId: "detached", kind: "detached", summary: "npm test", count: 1 };
  const result = count(
    local({
      chats: [
        chat("approval"),
        chat("question"),
        chat("detached"),
        chat("failed", { lastAssistantFailed: true }),
        chat("working"),
        chat("quiet"),
        // A failure the person already read is not waiting on them.
        chat("read-failure", { lastAssistantFailed: true, lastAssistantAt: NOW - 11 * HOUR }),
      ],
      activity: { activeChatIds: ["approval", "question", "working"], approvalChatIds: ["approval"], inputChatIds: ["question"] },
      pending: new Map([["detached", detached]]),
      botsNeedingYou: ["bot-a"],
    }),
  );
  assert.equal(result, 5);
});

test("a chat reported twice counts once, and a working run's pending entry adds nothing", () => {
  const working: ChatPendingAttention = { chatId: "approval", kind: "working", summary: "", count: 0 };
  const twice = chat("approval");
  assert.equal(
    count(
      local({
        chats: [twice, twice],
        activity: { activeChatIds: ["approval"], approvalChatIds: ["approval"], inputChatIds: [] },
        pending: new Map([["approval", working]]),
        botsNeedingYou: ["bot-a", "bot-a"],
      }),
    ),
    2,
  );
});

test("chats of removed workspaces, Bot chats and feature-owned chats don't count", () => {
  assert.equal(
    count(
      local({
        chats: [
          chat("gone", { workspaceId: "ws-removed", lastAssistantFailed: true }),
          chat("bot-chat", { botId: "bot-a", lastAssistantFailed: true }),
          chat("feature", { owner: { kind: "feature", id: "x" } as never, lastAssistantFailed: true }),
          chat("kept", { lastAssistantFailed: true }),
        ],
      }),
    ),
    1,
  );
});

test("Done follows the sidebar: a failure read on Done is gone, a newer one comes back, a live prompt shows through Snooze", () => {
  const triage = {
    "done-read": { revision: 2, updatedAt: NOW - HOUR, doneAt: NOW - HOUR },
    "done-new-failure": { revision: 2, updatedAt: NOW - 2 * HOUR, doneAt: NOW - 2 * HOUR },
    "snoozed-quiet": { revision: 2, updatedAt: NOW - HOUR, snoozedUntil: NOW + HOUR },
    "snoozed-approval": { revision: 2, updatedAt: NOW - HOUR, snoozedUntil: NOW + HOUR },
  };
  const result = count(
    local({
      chats: [
        chat("done-read", { lastAssistantFailed: true }),
        chat("done-new-failure", { lastAssistantFailed: true }),
        chat("snoozed-quiet"),
        chat("snoozed-approval"),
      ],
      activity: { activeChatIds: ["snoozed-approval"], approvalChatIds: ["snoozed-approval"], inputChatIds: [] },
      // Marking Done reads the chat through its newest reply.
      markers: { revision: 2, baselineAt: NOW - 10 * HOUR, readThrough: { "done-read": NOW - HOUR } },
      triage,
    }),
  );
  assert.equal(result, 2);
});

test("unreadable read markers make no chat an unseen failure", () => {
  assert.equal(count(local({ chats: [chat("failed", { lastAssistantFailed: true })], markers: null })), 0);
});

test("paired hosts count only while online, and their rows are keyed by host", () => {
  const rows = feed("mac-b", {
    summaries: [
      summary("approval"),
      summary("failed", { lastRunFailed: true, unread: true }),
      summary("failed-read", { lastRunFailed: true, unread: false }),
      summary("done", { rowState: "idle", unread: true, triageRevision: 2, doneAt: iso(NOW - HOUR) }),
      summary("no-workspace", { workspaceId: undefined, rowState: "needs_input" }),
    ],
    runs: [approvalRun("approval")],
    bots: [{ id: "bot-1", needsYou: true }, { id: "bot-2", failed: true }, { id: "bot-3" }],
  });
  assert.equal(count(local(), [{ status: status("mac-b"), feed: rows }]), 4);

  // The same chat and Bot ids on this Mac and another host are different rows.
  const sameIds = local({
    chats: [chat("approval")],
    activity: { activeChatIds: ["approval"], approvalChatIds: ["approval"], inputChatIds: [] },
    botsNeedingYou: ["bot-1"],
  });
  assert.equal(count(sameIds, [{ status: status("mac-b"), feed: rows }]), 6);

  const offline: InboxBadgePeer[] = [
    { status: status("mac-b", { kind: "backoff", attempt: 2, retryAt: NOW + 1000 }), feed: rows },
    { status: status("mac-b", { kind: "blocked", reason: "auth" }), feed: rows },
    { status: status("mac-b", { kind: "connecting", attempt: 1 }), feed: rows },
    { status: status("mac-b", undefined, true), feed: rows },
    { status: status("mac-b"), feed: { ...rows, stale: true } },
    { status: status("mac-b"), feed: null },
    { status: status("mac-c"), feed: rows },
  ];
  for (const peer of offline) assert.equal(count(local(), [peer]), 0, JSON.stringify(peer.status));
});

test("a host's chat reported by both its summary and its run counts once", () => {
  const rows = feed("mac-b", {
    summaries: [summary("approval", { rowState: "needs_approval" })],
    runs: [approvalRun("approval"), approvalRun("approval")],
  });
  assert.equal(count(local(), [{ status: status("mac-b"), feed: rows }]), 1);
});

test("the macOS surface writes the Dock text and clears it at zero", () => {
  const writes: string[] = [];
  const surface = badgeSurface("darwin", { dock: { setBadge: (text) => void writes.push(text) } });
  assert.ok(surface);
  surface.show(3);
  surface.show(0);
  assert.deepEqual(writes, ["3", ""]);
});

test("the Linux surface sets the launcher count; other platforms have no badge", () => {
  const counts: (number | undefined)[] = [];
  const dock = { setBadge: () => assert.fail("Linux has no Dock") };
  const surface = badgeSurface("linux", { dock, setBadgeCount: (n) => (counts.push(n), false) });
  assert.ok(surface);
  surface.show(2);
  surface.show(0);
  assert.deepEqual(counts, [2, 0]);
  assert.equal(badgeSurface("win32", { setBadgeCount: () => true }), null);
  assert.equal(badgeSurface("darwin", {}), null);
});

function harness(counts: number[] | (() => Promise<number>)) {
  const shown: number[] = [];
  const timers: (() => void)[] = [];
  let calls = 0;
  const errors: unknown[] = [];
  const driver = createInboxBadgeDriver({
    surface: { show: (n) => void shown.push(n) },
    count: typeof counts === "function" ? counts : async () => counts[Math.min(calls++, counts.length - 1)]!,
    onError: (error) => void errors.push(error),
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: (handle) => {
      timers[(handle as number) - 1] = () => {};
    },
  });
  const flush = async () => {
    while (timers.length) {
      timers.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { driver, shown, timers, errors, flush, calls: () => calls };
}

test("the driver stays off until enabled, coalesces changes and skips repeated writes", async () => {
  const h = harness([2, 2, 4]);
  h.driver.invalidate();
  assert.equal(h.timers.length, 0, "off: nothing counted");

  h.driver.setEnabled(true);
  h.driver.invalidate();
  h.driver.invalidate();
  assert.equal(h.timers.length, 1, "changes coalesce into one recount");
  await h.flush();
  assert.deepEqual(h.shown, [2]);

  h.driver.invalidate();
  await h.flush();
  assert.deepEqual(h.shown, [2], "an unchanged count writes nothing");
  h.driver.invalidate();
  await h.flush();
  assert.deepEqual(h.shown, [2, 4]);
  assert.equal(h.calls(), 3);
});

test("switching off clears the badge, even when a count was in flight", async () => {
  let release!: (n: number) => void;
  const h = harness(() => new Promise<number>((resolve) => (release = resolve)));
  h.driver.setEnabled(true);
  h.timers.shift()!();
  h.driver.setEnabled(false);
  release(5);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.shown, [0]);
  h.driver.invalidate();
  assert.equal(h.timers.length, 0);
});

test("a change during a count triggers one more count", async () => {
  const pending: ((n: number) => void)[] = [];
  const h = harness(() => new Promise<number>((resolve) => pending.push(resolve)));
  h.driver.setEnabled(true);
  h.timers.shift()!();
  h.driver.invalidate();
  h.timers.shift()!();
  assert.equal(pending.length, 1, "the second count waits for the first");
  pending[0]!(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.timers.length, 1, "rescheduled after the first count");
  h.timers.shift()!();
  pending[1]!(3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.shown, [1, 3]);
});

test("a failed count keeps the last badge and reports the error; dispose clears", async () => {
  let fail = false;
  const h = harness(async () => {
    if (fail) throw new Error("store unavailable");
    return 2;
  });
  h.driver.setEnabled(true);
  await h.flush();
  fail = true;
  h.driver.invalidate();
  await h.flush();
  assert.deepEqual(h.shown, [2]);
  assert.equal(h.errors.length, 1);
  h.driver.dispose();
  assert.deepEqual(h.shown, [2, 0]);
  h.driver.setEnabled(true);
  assert.equal(h.timers.length, 0, "a disposed driver stays off");
});
