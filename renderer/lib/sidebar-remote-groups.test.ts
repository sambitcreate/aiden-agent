import assert from "node:assert/strict";
import test from "node:test";
import type {
  PeerFeedRow,
  PeerHostFeedSnapshot,
  PeerHostStatus,
  PeerHostView,
  PeerRunState,
} from "../shared/peer-host";
import {
  organizeSidebar,
  type SidebarChatSummary,
  type SidebarProjectSummary,
  type SidebarView,
} from "./sidebar-organization";
import {
  combineSidebarRows,
  effectiveMachineFilter,
  isRemoteSidebarChat,
  machineFilterLabel,
  projectEntryMachineLabels,
  remoteSidebarRows,
  sidebarHosts,
  type RemoteSidebarRows,
  type SidebarHost,
} from "./sidebar-remote-groups";
import { localSidebarChats, localSidebarProjects } from "./sidebar-workspace-groups";
import { applyPeerHostFeedMessage, FEED_RESYNC } from "./hosts/peer-host-feed-state";
import type { ChatMeta, Workspace } from "./types";

const T0 = Date.UTC(2026, 5, 1);
const iso = (offsetHours: number) => new Date(T0 + offsetHours * 3_600_000).toISOString();

function view(id: string, name: string, enabled = true): PeerHostView {
  return { id, name, enabled, state: "connected", features: [], capabilities: [] };
}

function status(hostId: string, state: PeerHostStatus["state"], generation = 1): PeerHostStatus {
  return { hostId, generation, state, feed: "live", stale: false };
}

const connected = { kind: "connected", since: T0 } as const;

function workspaceRow(id: string, name: string, extra: Record<string, unknown> = {}): PeerFeedRow {
  return { id, name, createdAt: iso(0), updatedAt: iso(1), revision: "r1", ...extra };
}

function summaryRow(id: string, workspaceId: string, extra: Record<string, unknown> = {}): PeerFeedRow {
  return {
    id,
    workspaceId,
    title: `Chat ${id}`,
    titlePending: false,
    createdAt: iso(0),
    updatedAt: iso(2),
    revision: "r1",
    activity: "idle",
    ...extra,
  };
}

function snapshot(hostId: string, rows: Partial<PeerHostFeedSnapshot> = {}): PeerHostFeedSnapshot {
  return {
    hostId,
    epoch: "e1",
    sequence: 1,
    stale: false,
    summaries: [],
    workspaces: [],
    bots: [],
    runs: [],
    ...rows,
  };
}

function host(id: string, label: string, availability: SidebarHost["availability"] = "online"): SidebarHost {
  return { id, label, availability };
}

const localWorkspaces: Workspace[] = [
  { id: "ws-1", name: "aiden", folderPath: "/code/aiden", permission: "full", createdAt: 5, updatedAt: 50 },
  { id: "ws-2", name: "notes", folderPath: "/code/notes", permission: "full", createdAt: 6, updatedAt: 40 },
];
const localChats = [
  { id: "chat-1", title: "Local one", workspaceId: "ws-1", createdAt: 7, updatedAt: 60 },
] as ChatMeta[];
const local = {
  projects: localSidebarProjects(localWorkspaces),
  chats: localSidebarChats(localWorkspaces, localChats, () => "none"),
};

function organize<P extends SidebarProjectSummary, C extends SidebarChatSummary>(
  projects: P[],
  chats: C[],
  view: SidebarView = "projects",
) {
  return organizeSidebar({
    projects,
    chats,
    search: "",
    view,
    chatSort: "last_activity",
    projectSort: "last_activity",
    projectOrder: [],
    now: T0,
  });
}

test("hosts list only enabled hosts and suffix names shared with another host or this Mac", () => {
  const hosts = sidebarHosts(
    [
      view("host-aaaa1111", "Studio"),
      view("host-bbbb2222", "studio"),
      view("host-cccc3333", "Laptop"),
      view("host-dddd4444", "Laptop", false),
      view("host-eeee5555", "This Mac"),
      view("host-ffff6666", "  "),
    ],
    [
      status("host-aaaa1111", connected),
      status("host-bbbb2222", { kind: "backoff", attempt: 2, retryAt: T0 }),
      status("host-cccc3333", { kind: "blocked", reason: "auth" }),
    ],
  );
  assert.deepEqual(
    hosts.map(({ id, label, availability, blockedReason }) => ({ id, label, availability, blockedReason })),
    [
      { id: "host-aaaa1111", label: "Studio (1111)", availability: "online", blockedReason: undefined },
      { id: "host-bbbb2222", label: "studio (2222)", availability: "offline", blockedReason: undefined },
      // The disabled host with the same name does not force a suffix.
      { id: "host-cccc3333", label: "Laptop", availability: "blocked", blockedReason: "auth" },
      { id: "host-eeee5555", label: "This Mac (5555)", availability: "connecting", blockedReason: undefined },
      { id: "host-ffff6666", label: "Paired Mac", availability: "connecting", blockedReason: undefined },
    ],
  );
});

test("identical workspace and chat IDs and names on two hosts and this Mac stay separate rows", () => {
  const rows = (id: string) =>
    snapshot(id, {
      workspaces: [workspaceRow("ws-1", "aiden")],
      summaries: [summaryRow("chat-1", "ws-1", { title: "Local one" })],
    });
  const hosts = [host("studio", "Studio"), host("laptop", "Laptop")];
  const combined = combineSidebarRows({
    local,
    remote: hosts.map((h) => remoteSidebarRows(h, rows(h.id))),
    hosts,
    filter: "all",
    grouping: "separate",
  });
  const organized = organize(combined.projects, combined.chats);
  const aidenGroups = organized.projectGroups.filter((group) => group.project.name === "aiden");
  assert.equal(aidenGroups.length, 3);
  assert.equal(new Set(aidenGroups.map((group) => group.project.key)).size, 3);
  for (const group of aidenGroups) {
    assert.equal(group.chats.length, 1, group.project.key);
    const [chat] = group.chats;
    const member = group.project.primary;
    if (isRemoteSidebarChat(chat)) {
      assert.equal(chat.hostId, (member as { hostId?: string }).hostId);
      assert.equal(chat.chatId, "chat-1");
    } else {
      assert.equal(chat.key, "chat-1");
    }
  }
  assert.equal(new Set(combined.chats.map((chat) => chat.key)).size, 3);
});

test("with no paired host the combined rows reproduce the local projection exactly", () => {
  const combined = combineSidebarRows({
    local,
    remote: [],
    hosts: [],
    filter: "host:gone",
    grouping: "repository",
    localRepository: () => ({ canonicalKey: "github.com/a/b", relativePath: "" }),
  });
  const before = organize(local.projects, local.chats);
  const after = organize(combined.projects, combined.chats);
  assert.deepEqual(
    after.projectGroups.map((group) => ({ key: group.project.key, primary: group.project.primary, chats: group.chats })),
    before.projectGroups.map((group) => ({ key: group.project.key, primary: group.project, chats: group.chats })),
  );
  assert.deepEqual(after.projectOrder, before.projectOrder);
  // Local chat objects pass through untouched.
  assert.equal(combined.chats[0], local.chats[0]);
});

test("the machine filter narrows rows and an unknown host falls back to all machines", () => {
  const hosts = [host("studio", "Studio"), host("laptop", "Laptop")];
  const remote = hosts.map((h) =>
    remoteSidebarRows(
      h,
      snapshot(h.id, { workspaces: [workspaceRow(`${h.id}-ws`, h.label)], summaries: [summaryRow(`${h.id}-chat`, `${h.id}-ws`)] }),
    ),
  );
  const machines = (filter: Parameters<typeof combineSidebarRows>[0]["filter"]) => {
    const combined = combineSidebarRows({ local, remote, hosts, filter, grouping: "separate" });
    return {
      projects: combined.projects.map((project) => project.name),
      chats: combined.chats.length,
    };
  };
  assert.deepEqual(machines("all"), { projects: ["aiden", "notes", "Studio", "Laptop"], chats: 3 });
  assert.deepEqual(machines("local"), { projects: ["aiden", "notes"], chats: 1 });
  assert.deepEqual(machines("host:laptop"), { projects: ["Laptop"], chats: 1 });
  assert.deepEqual(machines("host:unpaired"), machines("all"));
  assert.equal(effectiveMachineFilter("host:unpaired", hosts), "all");
  assert.equal(effectiveMachineFilter("local", []), "all");
  assert.equal(machineFilterLabel("host:laptop", hosts), "Laptop");
  assert.equal(machineFilterLabel("local", hosts), "This Mac");
});

test("grouping merges by repository, optionally by path, one workspace per machine", () => {
  const repo = (canonicalKey: string, relativePath = "") => ({ repository: { canonicalKey, relativePath } });
  const hosts = [host("studio", "Studio"), host("laptop", "Laptop")];
  const remote: RemoteSidebarRows[] = [
    remoteSidebarRows(
      hosts[0],
      snapshot("studio", {
        workspaces: [
          workspaceRow("s-aiden", "aiden-studio", repo("github.com/acme/aiden")),
          workspaceRow("s-aiden-docs", "aiden docs", repo("github.com/acme/aiden", "docs")),
          workspaceRow("s-scratch", "scratch"),
        ],
        summaries: [summaryRow("c-studio", "s-aiden")],
      }),
    ),
    remoteSidebarRows(
      hosts[1],
      snapshot("laptop", {
        workspaces: [
          workspaceRow("l-aiden", "aiden", repo("github.com/acme/aiden")),
          workspaceRow("l-scratch", "scratch"),
        ],
      }),
    ),
  ];
  const localRepository = (project: (typeof local.projects)[number]) =>
    project.workspace.id === "ws-1" ? { canonicalKey: "github.com/acme/aiden", relativePath: "" } : null;
  const grouped = (grouping: "separate" | "repository" | "repository_path") =>
    combineSidebarRows({ local, remote, hosts, filter: "all", grouping, localRepository });

  assert.equal(grouped("separate").projects.length, 7);

  const byRepository = grouped("repository");
  const merged = byRepository.projects.find((entry) => entry.members.length > 1)!;
  assert.equal(merged.key, local.projects[0].key);
  assert.equal(merged.name, "aiden");
  // Studio's root workspace joins first; its docs workspace is a second Studio match and stays apart.
  assert.deepEqual(projectEntryMachineLabels(merged), ["This Mac", "Studio", "Laptop"]);
  assert.equal(byRepository.projects.length, 5);
  assert.ok(byRepository.projects.some((entry) => entry.primary.name === "aiden docs" && entry.members.length === 1));
  // Projects with no repository identity never merge, even with equal names.
  assert.equal(byRepository.projects.filter((entry) => entry.name === "scratch").length, 2);
  // The Studio chat now belongs to the merged group.
  const organized = organize(byRepository.projects, byRepository.chats);
  const mergedGroup = organized.projectGroups.find((group) => group.project.key === merged.key)!;
  assert.deepEqual(mergedGroup.chats.map((chat) => chat.key).sort(), ["chat-1", "studio:c-studio"]);
  assert.equal(merged.createdAt, 5);
  assert.equal(merged.lastActivityAt, T0 + 3_600_000);
  assert.match(merged.searchText ?? "", /Studio/);

  const byPath = grouped("repository_path");
  const pathMerged = byPath.projects.filter((entry) => entry.members.length > 1);
  assert.equal(pathMerged.length, 1);
  assert.deepEqual(projectEntryMachineLabels(pathMerged[0]), ["This Mac", "Studio", "Laptop"]);
  assert.ok(byPath.projects.some((entry) => entry.name === "aiden docs" && entry.members.length === 1));
});

test("remote rows without this Mac merge under the first host's key", () => {
  const hosts = [host("studio", "Studio"), host("laptop", "Laptop")];
  const remote = hosts.map((h) =>
    remoteSidebarRows(
      h,
      snapshot(h.id, {
        workspaces: [workspaceRow("w", `api on ${h.label}`, { repository: { canonicalKey: "github.com/acme/api", relativePath: "" } })],
      }),
    ),
  );
  const { projects } = combineSidebarRows({ local, remote, hosts, filter: "all", grouping: "repository" });
  const merged = projects.find((entry) => entry.members.length === 2)!;
  assert.equal(merged.key, "studio:w");
  assert.equal(merged.name, "api on Studio");
});

test("run state and row hints drive attention, and the open chat is never unread", () => {
  const runs: PeerRunState[] = [
    { chatId: "approval", runId: "r1", state: "done", unread: false },
    { chatId: "approval", runId: "r2", state: "needs_approval", unread: false },
    { chatId: "question", runId: "r3", state: "needs_input", unread: false },
    { chatId: "finished", runId: "r4", state: "working", unread: false },
    { chatId: "finished", runId: "r5", state: "done", unread: true },
    { chatId: "open", runId: "r6", state: "done", unread: true },
  ];
  const rows = remoteSidebarRows(
    host("studio", "Studio"),
    snapshot("studio", {
      workspaces: [workspaceRow("w", "api")],
      summaries: [
        summaryRow("approval", "w"),
        summaryRow("question", "w"),
        summaryRow("finished", "w"),
        summaryRow("open", "w"),
        summaryRow("busy", "w", { activity: "active" }),
        summaryRow("hinted", "w", { rowState: "needs_input", unread: true }),
        summaryRow("quiet", "w"),
        summaryRow("orphan", "", {}),
      ],
      runs,
    }),
    (hostId, chatId) => hostId === "studio" && chatId === "open",
  );
  const attention = Object.fromEntries(rows.chats.map((chat) => [chat.chatId, chat.attention]));
  assert.deepEqual(attention, {
    approval: "needs_approval",
    question: "needs_input",
    finished: "unread",
    open: "none",
    busy: "working",
    hinted: "needs_input",
    quiet: "none",
  });
  const sections = organize(rows.projects, rows.chats, "attention").chatSections;
  assert.deepEqual(
    sections.map((section) => section.id),
    ["needs_approval", "needs_input", "working", "unread", "none"],
  );
});

test("reading a chat on its host clears the unread left by its finished run", () => {
  const studio = host("studio", "Studio");
  const unreadFeed = snapshot("studio", {
    sequence: 4,
    workspaces: [workspaceRow("w", "api")],
    summaries: [summaryRow("done", "w", { unread: true })],
    runs: [{ chatId: "done", runId: "r1", state: "done", unread: true }],
  });
  const before = remoteSidebarRows(studio, unreadFeed).chats[0];
  assert.equal(before?.attention, "unread");

  const read = applyPeerHostFeedMessage(unreadFeed, {
    hostId: "studio",
    epoch: "e1",
    sequence: 5,
    change: { type: "chat.upsert", row: summaryRow("done", "w", { unread: false, revision: "r2" }) },
  });
  if (read === FEED_RESYNC) assert.fail("the read marker should apply in sequence");
  const after = remoteSidebarRows(studio, read);
  assert.equal(after.chats[0]?.unread, false);
  assert.deepEqual(
    organize(after.projects, after.chats, "attention").chatSections.map((section) => section.id),
    ["none"],
  );
});

test("an offline host's rows stay listed, stale, and stop claiming work in progress", () => {
  const feed = snapshot("studio", {
    workspaces: [workspaceRow("w", "api")],
    summaries: [
      summaryRow("busy", "w", { activity: "active" }),
      summaryRow("approval", "w", { rowState: "needs_approval" }),
    ],
  });
  const offline = remoteSidebarRows(host("studio", "Studio", "offline"), feed);
  assert.equal(offline.projects.length, 1);
  assert.ok(offline.projects.every((project) => project.stale));
  assert.ok(offline.chats.every((chat) => chat.stale));
  assert.deepEqual(
    offline.chats.map((chat) => [chat.chatId, chat.rowState]),
    [
      ["busy", "idle"],
      ["approval", "needs_approval"],
    ],
  );
  const online = remoteSidebarRows(host("studio", "Studio"), feed);
  assert.ok(online.chats.every((chat) => !chat.stale));
  assert.equal(online.chats[0].rowState, "working");
  // A connected host whose feed is marked stale is still last-known data.
  assert.ok(remoteSidebarRows(host("studio", "Studio"), { ...feed, stale: true }).chats.every((chat) => chat.stale));
  // A snapshot for another host never leaks into this one.
  assert.deepEqual(remoteSidebarRows(host("laptop", "Laptop"), feed), { projects: [], chats: [] });
});

test("malformed feed rows fall back to safe titles and drop unusable dates", () => {
  const rows = remoteSidebarRows(
    host("studio", "Studio"),
    snapshot("studio", {
      workspaces: [{ id: "w", name: 7, createdAt: "not a date", repository: { canonicalKey: "" } }],
      summaries: [{ id: "c", workspaceId: "w", title: "", updatedAt: 12 }],
    }),
  );
  assert.equal(rows.projects[0].name, "Untitled project");
  assert.equal(rows.projects[0].createdAt, undefined);
  assert.equal(rows.projects[0].repository, null);
  assert.equal(rows.chats[0].title, "New chat");
  assert.equal(rows.chats[0].lastActivityAt, undefined);
  assert.equal(rows.chats[0].rowState, "idle");
});
