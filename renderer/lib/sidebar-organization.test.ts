import assert from "node:assert/strict";
import test from "node:test";
import {
  canMoveProjectKey,
  displayedSidebarChats,
  latestProjectChat,
  LOCAL_SIDEBAR_HOST_ID,
  mergeProjectOrder,
  moveProjectKey,
  moveProjectKeyTo,
  organizeSidebar,
  parseProjectOrderKey,
  parseSidebarPreferences,
  projectOrderKey,
  serializeSidebarPreferences,
  sidebarAttention,
  type SidebarChatSummary,
  type SidebarOrganizeInput,
  type SidebarProjectSummary,
  visibleProjectChats,
} from "./sidebar-organization";

const HOUR = 3_600_000;
// Local noon keeps the day buckets independent of the machine's time zone.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

const projects: SidebarProjectSummary[] = [
  { key: "local:alpha", name: "Alpha", searchText: "Alpha /code/alpha", createdAt: 10, lastActivityAt: NOW - 50 * HOUR },
  { key: "local:beta", name: "Beta", createdAt: 30, lastActivityAt: NOW - 60 * HOUR },
  { key: "local:gamma", name: "Gamma", createdAt: 20, lastActivityAt: NOW - 70 * HOUR },
];

function chat(
  key: string,
  projectKey: string,
  overrides: Partial<SidebarChatSummary> = {},
): SidebarChatSummary {
  return { key, projectKey, title: key, attention: "none", ...overrides };
}

function input(overrides: Partial<SidebarOrganizeInput<SidebarProjectSummary, SidebarChatSummary>>) {
  return {
    projects,
    chats: [],
    search: "",
    view: "projects" as const,
    chatSort: "last_activity" as const,
    projectSort: "last_activity" as const,
    projectOrder: [],
    now: NOW,
    ...overrides,
  };
}

const keys = (items: readonly { key: string }[]) => items.map((item) => item.key);
const groupKeys = (result: ReturnType<typeof organizeSidebar>) =>
  result.projectGroups.map((group) => group.project.key);

test("workspace activity includes its newest chat and missing timestamps sort last", () => {
  const result = organizeSidebar(
    input({
      chats: [
        chat("gamma-hot", "local:gamma", { lastActivityAt: NOW - HOUR }),
        chat("alpha-undated", "local:alpha", { lastActivityAt: undefined }),
        chat("alpha-dated", "local:alpha", { lastActivityAt: NOW - 2 * HOUR }),
        chat("alpha-nan", "local:alpha", { lastActivityAt: Number.NaN }),
      ],
    }),
  );
  assert.deepEqual(groupKeys(result), ["local:gamma", "local:alpha", "local:beta"]);
  assert.equal(result.projectGroups[0].lastActivityAt, NOW - HOUR);
  assert.deepEqual(keys(result.projectGroups[1].chats), ["alpha-dated", "alpha-nan", "alpha-undated"]);
});

test("chats sort by creation time when chosen, with title and key breaking ties", () => {
  const result = organizeSidebar(
    input({
      chatSort: "created",
      chats: [
        chat("b-key", "local:alpha", { title: "Same", createdAt: 5, lastActivityAt: NOW }),
        chat("a-key", "local:alpha", { title: "Same", createdAt: 5, lastActivityAt: 1 }),
        chat("newest", "local:alpha", { title: "Zed", createdAt: 9, lastActivityAt: 2 }),
        chat("aardvark", "local:alpha", { title: "Aardvark", createdAt: 5 }),
      ],
    }),
  );
  assert.deepEqual(keys(result.projectGroups.find((group) => group.project.key === "local:alpha")!.chats), [
    "newest",
    "aardvark",
    "a-key",
    "b-key",
  ]);
});

test("the latest chat is the most recently active one under either chat sort", () => {
  const chats = [
    chat("newer", "local:alpha", { createdAt: 20, lastActivityAt: 20 }),
    chat("ongoing", "local:alpha", { createdAt: 10, lastActivityAt: 100 }),
    chat("undated", "local:alpha", { createdAt: 30 }),
  ];
  for (const chatSort of ["last_activity", "created"] as const) {
    const alpha = organizeSidebar(input({ chatSort, chats })).projectGroups.find(
      (group) => group.project.key === "local:alpha",
    )!;
    assert.equal(latestProjectChat(alpha)?.key, "ongoing", chatSort);
  }
  const beta = organizeSidebar(input({ chats })).projectGroups.find(
    (group) => group.project.key === "local:beta",
  )!;
  assert.equal(latestProjectChat(beta), undefined);
});

test("workspaces sort by creation time or by identical names deterministically", () => {
  assert.deepEqual(groupKeys(organizeSidebar(input({ projectSort: "created" }))), [
    "local:beta",
    "local:gamma",
    "local:alpha",
  ]);
  const twins: SidebarProjectSummary[] = [
    { key: "local:twin-b", name: "Twin" },
    { key: "local:twin-a", name: "Twin" },
    { key: "local:dated", name: "Zulu", createdAt: 1 },
  ];
  assert.deepEqual(
    groupKeys(organizeSidebar(input({ projects: twins, projectSort: "created" }))),
    ["local:dated", "local:twin-a", "local:twin-b"],
  );
});

test("manual order keeps stored keys first, ignores stale keys, and appends new workspaces", () => {
  const result = organizeSidebar(
    input({
      projectSort: "manual",
      projectOrder: ["local:gamma", "local:removed", "remote%3Ahost:other", "local:beta"],
      chats: [chat("alpha-hot", "local:alpha", { lastActivityAt: NOW })],
    }),
  );
  assert.deepEqual(groupKeys(result), ["local:gamma", "local:beta", "local:alpha"]);
  assert.deepEqual(result.projectOrder, ["local:gamma", "local:beta", "local:alpha"]);
});

test("search keeps every chat of a matching workspace and only matching chats elsewhere", () => {
  const chats = [
    chat("alpha-1", "local:alpha", { title: "Plan" }),
    chat("alpha-2", "local:alpha", { title: "Ship" }),
    chat("beta-1", "local:beta", { title: "Ship release" }),
    chat("orphan", "local:removed", { title: "Ship orphan" }),
  ];
  const byWorkspace = organizeSidebar(input({ chats, search: "  CODE/ALPHA " }));
  assert.deepEqual(groupKeys(byWorkspace), ["local:alpha"]);
  assert.equal(byWorkspace.projectGroups[0].chats.length, 2);
  assert.deepEqual(byWorkspace.projectOrder, ["local:alpha", "local:beta", "local:gamma"]);

  const byTitle = organizeSidebar(input({ chats, search: "ship", view: "recent" }));
  assert.deepEqual(groupKeys(byTitle), ["local:alpha", "local:beta"]);
  assert.deepEqual(keys(byTitle.projectGroups[0].chats), ["alpha-2"]);
  assert.deepEqual(
    byTitle.chatSections.flatMap((section) => keys(section.chats)).sort(),
    ["alpha-2", "beta-1"],
  );
});

test("recent view buckets by the chosen timestamp and puts undated chats in Older", () => {
  const chats = [
    chat("today", "local:alpha", { lastActivityAt: NOW - HOUR, createdAt: NOW - 400 * 24 * HOUR }),
    chat("yesterday", "local:beta", { lastActivityAt: NOW - 24 * HOUR, createdAt: NOW - 2 * HOUR }),
    chat("undated", "local:beta"),
    chat("earlier-month", "local:gamma", { lastActivityAt: new Date(2026, 2, 3).getTime() }),
    chat("last-year", "local:gamma", { lastActivityAt: new Date(2025, 2, 3).getTime() }),
    chat("orphan", "local:removed", { lastActivityAt: NOW }),
  ];
  const byActivity = organizeSidebar(input({ chats, view: "recent" }));
  assert.deepEqual(
    byActivity.chatSections.map((section) => [section.label, keys(section.chats)]),
    [
      ["Recent", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["March", ["earlier-month"]],
      ["Older", ["last-year", "undated"]],
    ],
  );
  const byCreation = organizeSidebar(input({ chats, view: "recent", chatSort: "created" }));
  assert.deepEqual(
    byCreation.chatSections.map((section) => [section.label, keys(section.chats)]),
    [
      ["Recent", ["yesterday"]],
      ["Older", ["today", "earlier-month", "last-year", "undated"]],
    ],
  );
});

test("needs attention orders triage tiers, then newest activity, ignoring the chat sort", () => {
  const chats = [
    chat("idle-new", "local:alpha", { lastActivityAt: NOW, createdAt: 1 }),
    chat("unread", "local:alpha", { attention: "unread", lastActivityAt: NOW - 5 * HOUR }),
    chat("working-old", "local:beta", { attention: "working", lastActivityAt: NOW - 9 * HOUR, createdAt: 9 }),
    chat("working-new", "local:gamma", { attention: "working", lastActivityAt: NOW - HOUR, createdAt: 2 }),
    chat("input", "local:beta", { attention: "needs_input", lastActivityAt: NOW - 8 * HOUR }),
    chat("approval", "local:gamma", { attention: "needs_approval" }),
    chat("orphan", "local:removed", { attention: "needs_approval", lastActivityAt: NOW }),
  ];
  const result = organizeSidebar(input({ chats, view: "attention", chatSort: "created" }));
  assert.deepEqual(
    result.chatSections.map((section) => [section.label, keys(section.chats)]),
    [
      ["Needs approval", ["approval"]],
      ["Needs input", ["input"]],
      ["Working", ["working-new", "working-old"]],
      ["Unread", ["unread"]],
      ["Other chats", ["idle-new"]],
    ],
  );
  assert.deepEqual(
    organizeSidebar(input({ chats: [chat("calm", "local:alpha")], view: "attention" })).chatSections.map(
      (section) => section.label,
    ),
    ["Other chats"],
  );
});

test("displayed chats follow the visible rows: collapsed groups, previews, and search", () => {
  const chats = [
    chat("alpha-1", "local:alpha", { lastActivityAt: NOW - 1 }),
    chat("alpha-2", "local:alpha", { lastActivityAt: NOW - 2 }),
    chat("alpha-3", "local:alpha", { lastActivityAt: NOW - 3 }),
    chat("beta-1", "local:beta", { lastActivityAt: NOW - 30 * HOUR, title: "Release" }),
    chat("beta-2", "local:beta", { lastActivityAt: NOW - 31 * HOUR }),
    chat("gamma-1", "local:gamma", { lastActivityAt: NOW - 4 }),
  ];
  // Manual order puts the most active workspace (gamma) last on screen.
  const organized = organizeSidebar(
    input({ chats, projectSort: "manual", projectOrder: ["local:beta", "local:alpha", "local:gamma"] }),
  );
  const options = {
    search: "",
    isExpanded: (project: SidebarProjectSummary) => project.key !== "local:gamma",
    isFullyRevealed: (project: SidebarProjectSummary) => project.key === "local:beta",
    collapsedChatLimit: 2,
  };
  assert.deepEqual(
    displayedSidebarChats(organized, "projects", options).map((section) => keys(section.chats)),
    [["beta-1", "beta-2", "alpha-1", "alpha-2"]],
  );
  assert.deepEqual(visibleProjectChats(organized.projectGroups[2], options), []);

  const searched = organizeSidebar(input({ chats, search: "alpha" }));
  assert.deepEqual(
    displayedSidebarChats(searched, "projects", { ...options, search: "alpha" }).map((section) =>
      keys(section.chats),
    ),
    [["alpha-1", "alpha-2", "alpha-3"]],
  );

  const recent = organizeSidebar(input({ chats, view: "recent" }));
  assert.deepEqual(
    displayedSidebarChats(recent, "recent", options).map((section) => keys(section.chats)),
    [["alpha-1", "alpha-2", "alpha-3", "gamma-1"], ["beta-1", "beta-2"]],
  );
});

test("attention tier follows the live row state before unread", () => {
  assert.equal(sidebarAttention("needs_approval", true), "needs_approval");
  assert.equal(sidebarAttention("working", true), "working");
  assert.equal(sidebarAttention("idle", true), "unread");
  assert.equal(sidebarAttention("idle", false), "none");
});

test("project order keys qualify hosts unambiguously", () => {
  const key = projectOrderKey("studio:mac", "ws:1");
  assert.notEqual(key, projectOrderKey("studio", "mac:ws:1"));
  assert.deepEqual(parseProjectOrderKey(key), { hostId: "studio:mac", projectId: "ws:1" });
  assert.equal(projectOrderKey(LOCAL_SIDEBAR_HOST_ID, "alpha"), "local:alpha");
  assert.equal(parseProjectOrderKey("no-separator"), null);
  assert.equal(parseProjectOrderKey(":alpha"), null);
  assert.equal(parseProjectOrderKey("local:%E0%A4%A"), null);
});

test("move helpers shift one workspace without losing or duplicating keys", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(moveProjectKey(order, "b", -1), ["b", "a", "c", "d"]);
  assert.deepEqual(moveProjectKey(order, "b", 1), ["a", "c", "b", "d"]);
  assert.deepEqual(moveProjectKey(order, "a", -1), order);
  assert.deepEqual(moveProjectKey(order, "missing", 1), order);
  assert.equal(canMoveProjectKey(order, "a", -1), false);
  assert.equal(canMoveProjectKey(order, "a", 1), true);
  assert.equal(canMoveProjectKey(order, "d", 1), false);
  assert.deepEqual(moveProjectKeyTo(order, "a", "d", "after"), ["b", "c", "d", "a"]);
  assert.deepEqual(moveProjectKeyTo(order, "d", "b", "before"), ["a", "d", "b", "c"]);
  assert.deepEqual(moveProjectKeyTo(order, "c", "c", "before"), order);
  assert.deepEqual(moveProjectKeyTo(order, "c", "missing", "before"), order);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("a reordered list keeps stored keys for workspaces that are not currently listed", () => {
  assert.deepEqual(
    mergeProjectOrder(["local:b", "local:a"], ["local:a", "offline:x", "local:b", "offline:y"]),
    ["local:b", "local:a", "offline:x", "offline:y"],
  );
  assert.deepEqual(mergeProjectOrder(["local:a"], []), ["local:a"]);
});

test("legacy preferences migrate and invalid input falls back to defaults", () => {
  const defaults = {
    view: "projects",
    chatSort: "last_activity",
    projectSort: "last_activity",
    projectOrder: [],
    expandedWorkspaceIds: [],
  };
  assert.deepEqual(parseSidebarPreferences(null), defaults);
  assert.deepEqual(parseSidebarPreferences("{"), defaults);
  assert.deepEqual(parseSidebarPreferences("[]"), defaults);
  assert.deepEqual(
    parseSidebarPreferences(
      JSON.stringify({ organization: "recent", expandedWorkspaceIds: ["alpha", "removed", "alpha", "bad/id"] }),
      ["alpha", "beta"],
    ),
    { ...defaults, view: "recent", expandedWorkspaceIds: ["alpha"] },
  );
  assert.equal(parseSidebarPreferences(JSON.stringify({ organization: "workspace" })).view, "projects");
  assert.deepEqual(
    parseSidebarPreferences(
      JSON.stringify({ view: "nonsense", chatSort: "alphabetical", projectSort: 3, organization: "recent" }),
    ),
    { ...defaults, view: "recent" },
  );
});

test("stored preferences round-trip, keep a downgrade-safe organization, and prune only local keys", () => {
  const stored = serializeSidebarPreferences({
    view: "attention",
    chatSort: "created",
    projectSort: "manual",
    projectOrder: ["local:beta", "local:removed", "studio:proj", "local:beta", "garbage", "local:bad%2Fid"],
    expandedWorkspaceIds: ["beta"],
  });
  assert.equal(JSON.parse(stored).organization, "workspace");
  assert.deepEqual(parseSidebarPreferences(stored, ["alpha", "beta"]), {
    view: "attention",
    chatSort: "created",
    projectSort: "manual",
    projectOrder: ["local:beta", "studio:proj"],
    expandedWorkspaceIds: ["beta"],
  });
  assert.equal(
    JSON.parse(serializeSidebarPreferences({ ...parseSidebarPreferences(null), view: "recent" })).organization,
    "recent",
  );
  const many = Array.from({ length: 700 }, (_, index) => `host:project-${index}`);
  assert.equal(parseSidebarPreferences(JSON.stringify({ projectOrder: many })).projectOrder.length, 500);
  const manyExpanded = Array.from({ length: 250 }, (_, index) => `workspace-${index}`);
  assert.equal(
    parseSidebarPreferences(JSON.stringify({ expandedWorkspaceIds: manyExpanded })).expandedWorkspaceIds.length,
    200,
  );
});
