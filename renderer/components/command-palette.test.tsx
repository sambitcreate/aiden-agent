import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { mountWithBotRouter } from "../main/bots/test-providers";
import { useCommandSystem } from "../lib/command-system";
import { NewChatActionsProvider, type NewChatActions } from "../lib/new-chat-actions";
import { WorkspaceProvider } from "../lib/workspace-context";
import type { ChatMeta, Workspace } from "../lib/types";
import { AppCommandPalette } from "./command-palette";

afterEach(cleanup);

const workspace = { id: "ws-1", name: "Project", folderPath: "/tmp/project", permission: "ask" } as Workspace;
const november = new Date(2026, 10, 11, 11, 11).getTime();

function chat(id: string, title: string, updatedAt = november): ChatMeta {
  return { id, title, workspaceId: workspace.id, createdAt: updatedAt, updatedAt };
}

const newChatActions: NewChatActions = {
  openNewChatIn: async () => undefined,
  openFolderForNewChat: async () => {},
  cloneRepositoryForNewChat: async () => {},
};

function OpenChats() {
  const { palette } = useCommandSystem();
  return (
    <button type="button" onClick={() => palette.openMode("chats")}>
      Open chats
    </button>
  );
}

async function openChatSearch(chats: ChatMeta[]) {
  installBotTestIpc({
    "workspaces:list": () => [workspace],
    "chats:list": () => chats,
    "providers:list": () => [],
    "settings:get": () => ({}),
    "models:info": () => ({}),
  });
  await mountWithBotRouter(
    <WorkspaceProvider>
      <NewChatActionsProvider value={newChatActions}>
        <OpenChats />
        <AppCommandPalette navigationBlockedReason={null} />
      </NewChatActionsProvider>
    </WorkspaceProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open chats" }));
  const input = await screen.findByLabelText("Search chats");
  await screen.findByText(chats[0].title);
  return input;
}

function optionNames(): string[] {
  return screen.getAllByRole("option").map((option) => option.textContent ?? "");
}

test("chat search ranks title matches and highlights the matched part", async () => {
  const input = await openChatSearch([
    chat("a", "Notes about deploys"),
    chat("b", "Deploy checklist"),
    chat("c", "Weekly review"),
  ]);
  fireEvent.change(input, { target: { value: "deploy" } });

  await waitFor(() => assert.equal(optionNames().length, 2));
  const names = optionNames();
  // The title that starts with the query comes first.
  assert.match(names[0], /^Deploy checklist/u);
  assert.match(names[1], /^Notes about deploys/u);
  const marks = [...document.querySelectorAll("[cmdk-item] mark")].map((mark) => mark.textContent);
  assert.deepEqual(marks, ["Deploy", "deploy"]);
});

test("a chat's date is not searchable, so a day number doesn't match every chat", async () => {
  const input = await openChatSearch([chat("a", "Trip planning"), chat("b", "Budget for Q11")]);
  fireEvent.change(input, { target: { value: "11" } });

  // Both chats were last updated on 11 November; only the title with "11" matches.
  await waitFor(() => assert.equal(optionNames().length, 1));
  assert.match(optionNames()[0], /^Budget for Q11/u);
});

test("the result count is announced once typing pauses", async () => {
  const input = await openChatSearch([chat("a", "Alpha"), chat("b", "Alpine"), chat("c", "Beta")]);
  fireEvent.change(input, { target: { value: "alp" } });
  const region = document.querySelector("[cmdk-root] [aria-live='polite']");
  assert.ok(region);
  assert.equal(region.textContent, "");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  assert.equal(region.textContent, "2 results");
});
