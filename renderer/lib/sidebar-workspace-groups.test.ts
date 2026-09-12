import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMeta, Workspace } from "./types";
import { parseSidebarPreferences, projectSidebarWorkspaces } from "./sidebar-workspace-groups";

const workspaces: Workspace[] = [
  {
    id: "alpha",
    name: "Alpha",
    folderPath: "/code/alpha",
    permission: "ask",
    createdAt: 1,
    updatedAt: 20,
  },
  { id: "beta", name: "Beta", permission: "ask", createdAt: 2, updatedAt: 10 },
  { id: "empty", name: "Empty", permission: "none", createdAt: 3, updatedAt: 5 },
];

const chats: ChatMeta[] = [
  { id: "alpha-old", title: "Older plan", workspaceId: "alpha", createdAt: 2, updatedAt: 30 },
  { id: "beta-new", title: "Ship release", workspaceId: "beta", createdAt: 3, updatedAt: 50 },
  { id: "alpha-new", title: "API review", workspaceId: "alpha", createdAt: 4, updatedAt: 40 },
  {
    id: "bot",
    title: "Bot chat",
    workspaceId: "bot-home",
    botId: "bot-1",
    createdAt: 5,
    updatedAt: 60,
  },
  { id: "assistant", title: "Assistant", workspaceId: "assistant", createdAt: 6, updatedAt: 70 },
  { id: "orphan", title: "Removed", workspaceId: "removed", createdAt: 7, updatedAt: 80 },
];

test("projects every registered workspace and only its owned regular chats", () => {
  const projection = projectSidebarWorkspaces(workspaces, chats, "");
  assert.deepEqual(
    projection.groups.map((group) => group.workspace.id),
    ["beta", "alpha", "empty"],
  );
  assert.deepEqual(
    projection.groups[1].chats.map((chat) => chat.id),
    ["alpha-new", "alpha-old"],
  );
  assert.deepEqual(projection.groups[2].chats, []);
  assert.deepEqual(
    projection.recents.map((chat) => chat.id),
    ["beta-new", "alpha-new", "alpha-old"],
  );
});

test("search matches workspace identity and chat titles without leaking orphans", () => {
  const byWorkspace = projectSidebarWorkspaces(workspaces, chats, "code/alpha");
  assert.deepEqual(
    byWorkspace.groups.map((group) => group.workspace.id),
    ["alpha"],
  );
  assert.deepEqual(
    byWorkspace.groups[0].chats.map((chat) => chat.id),
    ["alpha-new", "alpha-old"],
  );
  assert.deepEqual(
    byWorkspace.recents.map((chat) => chat.id),
    ["alpha-new", "alpha-old"],
  );

  const byChat = projectSidebarWorkspaces(workspaces, chats, "release");
  assert.deepEqual(
    byChat.groups.map((group) => group.workspace.id),
    ["beta"],
  );
  assert.deepEqual(
    byChat.groups[0].chats.map((chat) => chat.id),
    ["beta-new"],
  );
  assert.deepEqual(
    byChat.recents.map((chat) => chat.id),
    ["beta-new"],
  );
});

test("sidebar preferences are bounded, sanitized, and backward safe", () => {
  assert.deepEqual(parseSidebarPreferences(null), {
    organization: "workspace",
    expandedWorkspaceIds: [],
  });
  assert.deepEqual(
    parseSidebarPreferences(
      JSON.stringify({
        organization: "recent",
        expandedWorkspaceIds: ["alpha", "removed", "alpha", "bad/id"],
      }),
      ["alpha", "beta"],
    ),
    { organization: "recent", expandedWorkspaceIds: ["alpha"] },
  );
  assert.deepEqual(parseSidebarPreferences("{"), {
    organization: "workspace",
    expandedWorkspaceIds: [],
  });
  assert.deepEqual(
    parseSidebarPreferences(
      JSON.stringify({ organization: "workspace", expandedWorkspaceIds: ["alpha"] }),
      [],
    ),
    { organization: "workspace", expandedWorkspaceIds: [] },
  );
  const manyIds = Array.from({ length: 250 }, (_, index) => `workspace-${index}`);
  assert.equal(
    parseSidebarPreferences(
      JSON.stringify({ organization: "workspace", expandedWorkspaceIds: manyIds }),
    ).expandedWorkspaceIds.length,
    200,
  );
});
