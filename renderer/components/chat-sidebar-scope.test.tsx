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

/** The layout's side of the scope: a person's ‹ All projects clears it for good. */
function ScopedSidebar({ initialScope }: { initialScope: string | null }) {
  const [scope, setScope] = React.useState(initialScope);
  return (
    <WorkspaceProvider>
      <WorkspaceTerminalProvider>
        <EnvironmentPanelProvider>
          <NewChatActionsProvider value={NEW_CHAT_ACTIONS}>
          <ChatSidebar
            activeChatId="hero"
            scopeWorkspaceId={scope}
            onClearScope={() => {
              clears += 1;
              setScope(null);
            }}
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

const backRow = () => screen.getByRole("button", { name: "All projects" });

test("a scoped sidebar lists only the project's chats under its name and path, after ‹ All projects", async () => {
  await mountScoped("site");
  await waitFor(() => assert.deepEqual(chatRows(), ["Chat hero", "Chat pricing"]));

  const heading = screen.getByRole("heading", { name: "site" });
  const group = heading.closest("[data-sidebar-scope]");
  assert.ok(group, "the heading leads the scoped group");
  assert.ok(within(group as HTMLElement).getByTitle("/Users/person/site"), "the path shows under the name");
  assert.equal(screen.queryByRole("button", { name: /docs/u }), null, "other projects are hidden");

  const list = backRow().closest("[data-sidebar-scope-list]");
  assert.ok(list);
  const firstRow = list.querySelector("[data-roving-item]");
  assert.equal(firstRow, backRow(), "‹ All projects is the first row");
});

test("‹ All projects clears the scope once and brings every project back", async () => {
  await mountScoped("site");
  await act(async () => {
    fireEvent.click(backRow());
  });
  assert.equal(clears, 1);
  await waitFor(() => screen.getByRole("button", { name: /Expand docs/u }));
  assert.equal(screen.queryByRole("button", { name: "All projects" }), null);
});

test("arrow keys in a scoped sidebar start from ‹ All projects", async () => {
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

test("a scope whose project has no chats left falls back to every project and clears", async () => {
  chats = chats.filter((entry) => entry.workspaceId !== "site");
  await mountWithBotRouter(null, { initialPath: "/", sidebar: <ScopedSidebar initialScope="site" /> });
  await screen.findByRole("button", { name: /^Chat guide|^Expand docs/u });
  await waitFor(() => assert.equal(clears, 1));
  assert.equal(screen.queryByRole("button", { name: "All projects" }), null, "no empty scoped list");
});

test("deleting the project's last chat or removing the project clears the scope", async () => {
  const { queryClient } = await mountScoped("site");
  await act(async () => {
    queryClient.setQueryData<ChatMeta[]>(queryKeys.chatsIn(undefined), (current) =>
      current?.filter((entry) => entry.id !== "pricing"),
    );
  });
  assert.equal(clears, 0, "one chat left keeps the scope");
  await waitFor(() => assert.deepEqual(chatRows(), ["Chat hero"]));

  await act(async () => {
    queryClient.setQueryData<Workspace[]>(queryKeys.workspaces, (current) =>
      current?.filter((entry) => entry.id !== "site"),
    );
  });
  await waitFor(() => assert.equal(clears, 1));
  assert.equal(screen.queryByRole("button", { name: "All projects" }), null);
  await waitFor(() => screen.getByRole("button", { name: /^Chat guide|^Expand docs/u }));
});

test("an unscoped sidebar shows no back row", async () => {
  await mountScoped(null);
  assert.equal(screen.queryByRole("button", { name: "All projects" }), null);
  assert.equal(clears, 0);
});
