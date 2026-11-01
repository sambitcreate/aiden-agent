import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";
import type { ChatPendingAttention } from "../shared/chat-pending-attention";
import {
  debounceNeedsYouLeave,
  filterInboxEntries,
  inboxRowAction,
  inboxRowDescription,
  inboxRowStatus,
  inboxShortcutOrder,
  localInboxEntries,
  markReadThroughMessageId,
  pendingAttentionRequest,
  remoteInboxEntries,
  type InboxEntry,
} from "./sidebar-inbox-view";
import { releasedInboxOrder, type InboxDisplayOrder, type InboxSignals } from "./sidebar-inbox";
import { projectOrderKey } from "./sidebar-organization";
import type { RemoteSidebarRows, SidebarHost } from "./sidebar-remote-groups";
import type { ChatMeta, Workspace } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 31, 12);

function chat(id: string, overrides: Partial<ChatMeta> = {}): ChatMeta {
  return { id, title: `Chat ${id}`, workspaceId: "ws-1", createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR, ...overrides };
}

const workspaces: Workspace[] = [{ id: "ws-1", name: "aiden", permission: "full" } as Workspace];

function entry(
  id: string,
  signals: Partial<InboxSignals> = {},
  options: { remote?: boolean; pending?: ChatPendingAttention; hostLabel?: string; project?: string } = {},
): InboxEntry {
  const hostId = options.remote ? "studio" : "local";
  const base: InboxEntry = {
    key: projectOrderKey(hostId, id),
    title: `Chat ${id}`,
    project: options.project ?? "aiden",
    hostId,
    hostLabel: options.hostLabel ?? (options.remote ? "Studio" : "This Mac"),
    source: options.remote
      ? { kind: "remote", chat: { chatId: id, hostId } as never }
      : { kind: "local", chat: chat(id) },
    signals: {
      rowState: "idle",
      unread: false,
      failed: false,
      isOpen: false,
      hostOnline: true,
      updatedAt: NOW - HOUR,
      ...signals,
    },
  };
  return options.pending ? { ...base, pending: options.pending } : base;
}

function order(partial: Partial<Record<keyof InboxDisplayOrder, string[]>>): InboxDisplayOrder {
  return { needs_you: [], pinned: [], updates: [], earlier: [], working: [], ...partial };
}

test("local entries list Assistant and scheduled chats under their own labels, and skip Bot and removed-workspace chats", () => {
  const entries = localInboxEntries({
    chats: [
      chat("work"),
      chat("assistant", { workspaceId: ASSISTANT_WORKSPACE_ID }),
      chat("scheduled", { workspaceId: undefined }),
      chat("bot", { botId: "bot-1" }),
      chat("gone", { workspaceId: "ws-removed" }),
    ],
    workspaces,
    rowState: () => "idle",
    unread: () => false,
    pending: new Map(),
  });
  assert.deepEqual(
    entries.map((item) => [item.title, item.project]),
    [
      ["Chat work", "aiden"],
      ["Chat assistant", "Assistant"],
      ["Chat scheduled", "Scheduled"],
    ],
  );
});

test("a local chat's pending wait carries its time and a detached prompt into the row", () => {
  const [row] = localInboxEntries({
    chats: [chat("a")],
    workspaces,
    rowState: () => "idle",
    unread: () => false,
    pending: new Map([["a", { chatId: "a", kind: "detached", summary: "rm -rf build", since: NOW - 5 * MINUTE, count: 1 }]]),
  });
  const status = inboxRowStatus(row!, "needs_you", NOW);
  assert.deepEqual([status.label, status.wait, status.tone], ["Unavailable", "5m", "warning"]);
  assert.equal(inboxRowDescription(row!, status), "Approval unavailable — return to retry: rm -rf build");
});

test("remote entries leave out blocked hosts and name an unnamed host", () => {
  const rows: RemoteSidebarRows[] = [
    {
      projects: [{ key: "p-studio", name: "site" } as never],
      chats: [{ key: projectOrderKey("studio", "c1"), chatId: "c1", hostId: "studio", hostLabel: " ", projectKey: "p-studio", title: "Deploy", rowState: "needs_approval", unread: false, lastRunFailed: false, stale: true, createdAt: NOW - HOUR } as never],
    },
    {
      projects: [],
      chats: [{ key: projectOrderKey("blocked", "c2"), chatId: "c2", hostId: "blocked", hostLabel: "Old", projectKey: "x", title: "Hidden", rowState: "idle", unread: true, lastRunFailed: false, stale: false, createdAt: NOW } as never],
    },
  ];
  const hosts = [
    { id: "studio", label: "", availability: "offline" },
    { id: "blocked", label: "Old", availability: "blocked" },
  ] as unknown as SidebarHost[];
  const entries = remoteInboxEntries(rows, hosts);
  assert.deepEqual(
    entries.map((item) => [item.title, item.project, item.hostLabel, item.signals.hostOnline]),
    [["Deploy", "site", "Paired Mac", false]],
  );
});

test("search matches title, project and host, and the machine filter narrows to one machine", () => {
  const entries = [
    entry("a", {}, { project: "aiden" }),
    entry("b", {}, { remote: true, project: "site" }),
  ];
  const titles = (items: InboxEntry[]) => items.map((item) => item.title);
  assert.deepEqual(titles(filterInboxEntries(entries, { search: "studio", machineFilter: "all" })), ["Chat b"]);
  assert.deepEqual(titles(filterInboxEntries(entries, { search: "chat AIDEN", machineFilter: "all" })), ["Chat a"]);
  assert.deepEqual(titles(filterInboxEntries(entries, { search: "", machineFilter: "local" })), ["Chat a"]);
  assert.deepEqual(titles(filterInboxEntries(entries, { search: "chat", machineFilter: "host:studio" })), ["Chat b"]);
});

test("Needs you statuses name the wait, and only Failed uses the danger tone", () => {
  const cases: [Partial<InboxSignals>, string, string][] = [
    [{ rowState: "needs_approval", attentionSince: NOW - 3 * MINUTE }, "Approval", "warning"],
    [{ rowState: "needs_input", attentionSince: NOW - 3 * MINUTE }, "Question", "warning"],
    [{ failed: true, unread: true, lastAssistantAt: NOW - 3 * MINUTE }, "Failed", "danger"],
    [{ attention: "interrupted", attentionSince: NOW - 3 * MINUTE }, "Interrupted", "warning"],
  ];
  for (const [signals, label, tone] of cases) {
    const status = inboxRowStatus(entry("a", signals), "needs_you", NOW);
    assert.deepEqual([status.label, status.tone, status.wait], [label, tone, "3m"], label);
  }
});

test("a working row reads its run length, and an offline host's clock stops where it dropped", () => {
  const running = entry("a", { rowState: "working", runStartedAt: NOW - 90 * MINUTE });
  assert.equal(inboxRowStatus(running, "working", NOW).label, "Working 1h");
  const waiting = entry("b", { rowState: "needs_approval", attentionSince: NOW - 10 * MINUTE }, { remote: true });
  // The view passes the moment the host went offline as the row's clock.
  assert.equal(inboxRowStatus(waiting, "needs_you", NOW - 8 * MINUTE).wait, "2m");
});

test("descriptions carry the request text for local rows and status, host and wait for remote rows", () => {
  const approval = entry("a", { rowState: "needs_approval", attentionSince: NOW - MINUTE }, {
    pending: { chatId: "a", kind: "approval", summary: "npm publish", since: NOW - MINUTE, count: 3 },
  });
  assert.equal(inboxRowDescription(approval, inboxRowStatus(approval, "needs_you", NOW)), "Approve: npm publish (+2 more)");
  const remote = entry("b", { rowState: "needs_input", updatedAt: NOW - 4 * MINUTE, hostOnline: false }, { remote: true });
  assert.equal(
    inboxRowDescription(remote, inboxRowStatus(remote, "needs_you", NOW)),
    "Question on Studio, waiting 4m. Studio is offline",
  );
  const quiet = entry("c", { unread: true });
  assert.equal(inboxRowDescription(quiet, inboxRowStatus(quiet, "updates", NOW)), undefined);
});

test("only unread Updates and Earlier rows offer Mark read, and only a Failed Needs you row offers Acknowledge", () => {
  const action = (item: InboxEntry, section: "needs_you" | "updates" | "earlier" | "working", canMarkRead = true) =>
    inboxRowAction(item, section, inboxRowStatus(item, section, NOW), canMarkRead);
  assert.equal(action(entry("a", { unread: true }), "updates"), "mark_read");
  assert.equal(action(entry("a", { unread: false }), "earlier"), null);
  assert.equal(action(entry("a", { rowState: "needs_approval" }), "needs_you"), null);
  assert.equal(action(entry("a", { rowState: "needs_input" }), "needs_you"), null);
  assert.equal(action(entry("a", { failed: true, unread: true }), "needs_you"), "acknowledge");
  assert.equal(action(entry("a", { rowState: "working", unread: true }), "working"), null);
  // Remote rows need the host's read grant and a live connection.
  assert.equal(action(entry("b", { unread: true }, { remote: true }), "updates", false), null);
  assert.equal(action(entry("b", { unread: true, hostOnline: false }, { remote: true }), "updates"), null);
  assert.equal(action(entry("b", { unread: true }, { remote: true }), "updates"), "mark_read");
});

test("Mark read names the newest rendered message, so a reply landing mid-click stays unread", () => {
  const messages = [
    { id: "u1", role: "user", createdAt: NOW - 3 * MINUTE },
    { id: "a1", role: "assistant", createdAt: NOW - 2 * MINUTE },
    { id: "t1", role: "tool", createdAt: NOW - MINUTE },
    { id: "a2", role: "assistant", createdAt: NOW },
  ];
  assert.equal(markReadThroughMessageId(messages, NOW - 2 * MINUTE), "a1");
  assert.equal(markReadThroughMessageId(messages, undefined), "a2");
  assert.equal(markReadThroughMessageId([], NOW), null);
});

test("a row leaving Needs you holds its slot for 400 ms, then goes; a deleted or touched row goes at once", () => {
  const a = projectOrderKey("local", "a");
  const b = projectOrderKey("local", "b");
  const present = new Set([a, b]);
  const next = order({ needs_you: [b], working: [a] });
  const first = debounceNeedsYouLeave({ previous: [a, b], next, leftAt: new Map(), present, touched: new Set(), now: NOW });
  assert.deepEqual(first.order.needs_you, [a, b]);
  assert.deepEqual(first.order.working, []);
  assert.equal(first.nextCheckAt, NOW + 400);
  const later = debounceNeedsYouLeave({
    previous: first.order.needs_you,
    next,
    leftAt: first.leftAt,
    present,
    touched: new Set(),
    now: NOW + 399,
  });
  assert.deepEqual(later.order.needs_you, [a, b]);
  const due = debounceNeedsYouLeave({ previous: later.order.needs_you, next, leftAt: later.leftAt, present, touched: new Set(), now: NOW + 400 });
  assert.deepEqual([due.order.needs_you, due.order.working, due.nextCheckAt], [[b], [a], null]);
  const deleted = debounceNeedsYouLeave({ previous: [a, b], next: order({ needs_you: [b] }), leftAt: new Map(), present: new Set([b]), touched: new Set(), now: NOW });
  assert.deepEqual(deleted.order.needs_you, [b]);
  const touched = debounceNeedsYouLeave({ previous: [a, b], next, leftAt: new Map(), present, touched: new Set([a]), now: NOW });
  assert.deepEqual(touched.order.needs_you, [b]);
});

test("shortcut order follows the visible sections, skips held-over rows, and leaves out a collapsed Working shelf", () => {
  const key = (id: string) => projectOrderKey("local", id);
  const held = releasedInboxOrder(order({
    needs_you: [key("n")],
    pinned: [key("p")],
    updates: [key("u")],
    earlier: [key("e1"), key("e2")],
    working: [key("w")],
  }));
  const withLeaving = { ...held, earlier: [held.earlier[0]!, { ...held.earlier[1]!, leaving: true }] };
  assert.deepEqual(inboxShortcutOrder(withLeaving, { workingExpanded: true }), [key("n"), key("u"), key("e1"), key("w")]);
  assert.deepEqual(inboxShortcutOrder(withLeaving, { workingExpanded: false }), [key("n"), key("u"), key("e1")]);
});

test("the pending attention request asks about live chats first, then the newest, and never Bot chats", () => {
  const chats = [
    chat("old", { updatedAt: NOW - 9 * HOUR }),
    chat("new", { updatedAt: NOW - MINUTE }),
    chat("mid", { updatedAt: NOW - 3 * HOUR }),
    chat("bot", { updatedAt: NOW, botId: "bot-1" }),
  ];
  // "old" is waiting on an approval, so it is asked about even past the cap.
  const request = pendingAttentionRequest(chats, [new Set(["old", "bot", "gone"])], 2);
  assert.deepEqual(request.ids, ["old", "new"]);
  assert.deepEqual(pendingAttentionRequest(chats, [], 10).ids, ["new", "mid", "old"]);
});

test("the pending attention key is short, follows the ids, and ignores the order they arrive in", () => {
  const many = Array.from({ length: 500 }, (_, index) => chat(`chat-${index}`, { updatedAt: NOW - index * MINUTE }));
  const request = pendingAttentionRequest(many, []);
  assert.equal(request.ids.length, 500);
  assert.ok(request.key.length < 20, request.key);
  assert.equal(pendingAttentionRequest([...many].reverse(), []).key, request.key);
  assert.notEqual(pendingAttentionRequest(many.slice(1), []).key, request.key);
  assert.notEqual(pendingAttentionRequest(many, [new Set(["chat-499"])]).key, request.key);
});
