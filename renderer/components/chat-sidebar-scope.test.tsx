// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import * as React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mountWithBotRouter } from "../main/bots/test-providers";
import { NewChatActionsProvider } from "../lib/new-chat-actions";
import { queryKeys } from "../lib/queries";
import type { ChatMeta, Workspace } from "../lib/types";
import { WorkspaceProvider } from "../lib/workspace-context";
import { ChatSidebar } from "./chat-sidebar";
import { EnvironmentPanelProvider } from "./environment-panel";
import { WorkspaceTerminalProvider } from "./terminal-drawer";

function workspace(id: string, folderPath: string): Workspace {
  return { id, name: id, folderPath, permission: "full", createdAt: 1, updatedAt: 1 };
}

function chat(id: string, workspaceId: string, updatedAt: number): ChatMeta {
  return { id, title: `Chat ${id}`, workspaceId, createdAt: 1, updatedAt };
}

let workspaces: Workspace[];
let chats: ChatMeta[];
let clears: number;

const NEW_CHAT_ACTIONS = {
  openNewChatIn: async () => undefined,
  openFolderForNewChat: async () => undefined,
  cloneRepositoryForNewChat: async () => undefined,
};

beforeEach(() => {
  localStorage.clear();
  clears = 0;
  workspaces = [workspace("site", "/Users/person/site"), workspace("docs", "/Users/person/docs")];
  chats = [
    chat("hero", "site", 30),
    chat("pricing", "site", 20),
    chat("guide", "docs", 25),
  ];
  installBotTestIpc({
    "workspaces:list": () => workspaces,
    "chats:list": () => chats,
    "shortcut:get": () => null,
    "settings:get": () => null,
    "browser:link-preference": () => "ask",
  });
});

afterEach(cleanup);

/**
 * The layout's side of the scope: only the person's ‹ All workspaces clears it,
 * and only their "Show only <workspace>" brings it back.
 */
function ScopedSidebar({ initialScope }: { initialScope: string | null }) {
  const [cleared, setCleared] = React.useState(false);
  return (
    <WorkspaceProvider>
      <WorkspaceTerminalProvider>
        <EnvironmentPanelProvider>
          <NewChatActionsProvider value={NEW_CHAT_ACTIONS}>
          <ChatSidebar
            activeChatId="hero"
            scopeWorkspaceId={cleared ? null : initialScope}
            onClearScope={() => {
              clears += 1;
              setCleared(true);
            }}
            restorableScopeWorkspaceId={cleared ? initialScope : null}
            onRestoreScope={() => setCleared(false)}
          />
          </NewChatActionsProvider>
        </EnvironmentPanelProvider>
      </WorkspaceTerminalProvider>
    </WorkspaceProvider>
  );
}

async function mountScoped(scope: string | null) {
  const mounted = await mountWithBotRouter(null, {
    initialPath: "/",
    sidebar: <ScopedSidebar initialScope={scope} />,
  });
  await screen.findByRole("button", { name: /^Chat hero/u });
  return mounted;
}

const chatRows = () =>
  screen
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")
    .filter((text) => text.startsWith("Chat "));

const backRow = () => screen.getByRole("button", { name: "All workspaces" });
const restoreRow = () => screen.queryByRole("button", { name: "Show only site" });
const fullList = () => screen.getByRole("button", { name: /Expand docs/u });

test("a scoped sidebar lists only the workspace's chats under its name and path, after ‹ All workspaces", async () => {
  await mountScoped("site");
  await waitFor(() => assert.deepEqual(chatRows(), ["Chat hero", "Chat pricing"]));

  const heading = screen.getByRole("heading", { name: "site" });
  const group = heading.closest("[data-sidebar-scope]");
  assert.ok(group, "the heading leads the scoped group");
  assert.ok(within(group as HTMLElement).getByTitle("/Users/person/site"), "the path shows under the name");
  assert.equal(screen.queryByRole("button", { name: /docs/u }), null, "other workspaces are hidden");

  const list = backRow().closest("[data-sidebar-scope-list]");
  assert.ok(list);
  const firstRow = list.querySelector("[data-roving-item]");
  assert.equal(firstRow, backRow(), "‹ All workspaces is the first row");
});

test("‹ All workspaces brings every workspace back, and Show only <workspace> scopes again", async () => {
  await mountScoped("site");
  assert.equal(restoreRow(), null, "nothing to restore while scoped");
  await act(async () => {
    fireEvent.click(backRow());
  });
  assert.equal(clears, 1);
  await waitFor(() => fullList());
  assert.equal(screen.queryByRole("button", { name: "All workspaces" }), null);

  const restore = restoreRow();
  assert.ok(restore, "the cleared workspace is offered back");
  await act(async () => {
    fireEvent.click(restore);
  });
  await waitFor(() => assert.deepEqual(chatRows(), ["Chat hero", "Chat pricing"]));
  backRow();
  assert.equal(restoreRow(), null);
});

test("arrow keys in a scoped sidebar start from ‹ All workspaces", async () => {
  await mountScoped("site");
  const hero = screen.getByRole("button", { name: /^Chat hero/u });
  // The open chat holds the list's Tab stop, as in the unscoped sidebar.
  assert.equal(hero.getAttribute("tabindex"), null);
  assert.equal(backRow().getAttribute("tabindex"), "-1");

  hero.focus();
  fireEvent.keyDown(hero, { key: "ArrowUp" });
  assert.equal(document.activeElement, backRow(), "↑ from the first chat reaches the back row");
  fireEvent.keyDown(backRow(), { key: "ArrowDown" });
  assert.equal(document.activeElement, hero);
  fireEvent.keyDown(hero, { key: "Home" });
  assert.equal(document.activeElement, backRow(), "Home lands on the back row");
});

test("a scope with no chats right now shows every workspace and comes back with its chats", async () => {
  const { queryClient } = await mountScoped("site");
  const siteChats = queryClient.getQueryData<ChatMeta[]>(queryKeys.chatsIn(undefined))?.filter(
    (entry) => entry.workspaceId === "site",
  );
  assert.equal(siteChats?.length, 2);

  // The list empties for a moment (a refetch, or the last chats archived elsewhere).
  await act(async () => {
    queryClient.setQueryData<ChatMeta[]>(queryKeys.chatsIn(undefined), (current) =>
      current?.filter((entry) => entry.workspaceId !== "site"),
    );
  });
  await waitFor(() => fullList());
  assert.equal(screen.queryByRole("button", { name: "All workspaces" }), null, "no empty scoped list");
  assert.equal(clears, 0, "the scope is not cleared for good");

  await act(async () => {
    queryClient.setQueryData<ChatMeta[]>(queryKeys.chatsIn(undefined), (current) => [
      ...(siteChats ?? []),
      ...(current ?? []),
    ]);
  });
  await waitFor(() => assert.deepEqual(chatRows(), ["Chat hero", "Chat pricing"]));
  backRow();
});

test("a removed workspace shows every workspace without clearing the scope", async () => {
  const { queryClient } = await mountScoped("site");
  await act(async () => {
    queryClient.setQueryData<Workspace[]>(queryKeys.workspaces, (current) =>
      current?.filter((entry) => entry.id !== "site"),
    );
  });
  await waitFor(() => screen.getByRole("button", { name: /^Chat guide|^Expand docs/u }));
  assert.equal(screen.queryByRole("button", { name: "All workspaces" }), null);
  assert.equal(clears, 0);
});

test("an unscoped sidebar shows no back row and nothing to restore", async () => {
  await mountScoped(null);
  assert.equal(screen.queryByRole("button", { name: "All workspaces" }), null);
  assert.equal(restoreRow(), null);
  assert.equal(clears, 0);
});
