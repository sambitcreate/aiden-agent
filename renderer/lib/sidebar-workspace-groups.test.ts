import assert from "node:assert/strict";
import test from "node:test";
import { organizeSidebar, type SidebarView } from "./sidebar-organization";
import type { ChatMeta, Workspace } from "./types";
import { localSidebarChats, localSidebarProjects } from "./sidebar-workspace-groups";

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
  { id: "unowned", title: "No workspace", createdAt: 8, updatedAt: 90 },
];

function organize(search: string, view: SidebarView = "projects", attention = new Map<string, "needs_input">()) {
  return organizeSidebar({
    projects: localSidebarProjects(workspaces),
    chats: localSidebarChats(workspaces, chats, (chat) => attention.get(chat.id) ?? "none"),
    search,
    view,
    chatSort: "last_activity",
    projectSort: "last_activity",
    projectOrder: [],
    now: 100,
  });
}

const workspaceIds = (result: ReturnType<typeof organize>) =>
  result.projectGroups.map((group) => group.project.workspace.id);
const chatIds = (items: readonly { chat: ChatMeta }[]) => items.map((item) => item.chat.id);

test("projects every registered workspace and only its owned regular chats", () => {
  const result = organize("", "recent");
  assert.deepEqual(workspaceIds(result), ["beta", "alpha", "empty"]);
  assert.deepEqual(chatIds(result.projectGroups[1].chats), ["alpha-new", "alpha-old"]);
  assert.deepEqual(result.projectGroups[2].chats, []);
  assert.deepEqual(
    result.chatSections.flatMap((section) => chatIds(section.chats)),
    ["beta-new", "alpha-new", "alpha-old"],
  );
});

test("search matches the workspace folder path and chat titles without leaking orphans", () => {
  const byWorkspace = organize("code/alpha", "recent");
  assert.deepEqual(workspaceIds(byWorkspace), ["alpha"]);
  assert.deepEqual(chatIds(byWorkspace.projectGroups[0].chats), ["alpha-new", "alpha-old"]);
  assert.deepEqual(
    byWorkspace.chatSections.flatMap((section) => chatIds(section.chats)),
    ["alpha-new", "alpha-old"],
  );

  const byChat = organize("removed", "recent");
  assert.deepEqual(workspaceIds(byChat), []);
  assert.deepEqual(byChat.chatSections, []);
});

test("the attention tier supplied for a local chat drives the triage view", () => {
  const result = organize("", "attention", new Map([["alpha-old", "needs_input"]]));
  assert.deepEqual(
    result.chatSections.map((section) => [section.label, chatIds(section.chats)]),
    [
      ["Needs input", ["alpha-old"]],
      ["Other chats", ["beta-new", "alpha-new"]],
    ],
  );
});
