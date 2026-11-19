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

test("a long chat list shows a page of chats and a Show more row that reveals the rest", async () => {
  const many = Array.from({ length: 70 }, (_, index) =>
    chat(`c${index}`, `Chat ${String(index).padStart(2, "0")}`, november - index),
  );
  const input = await openChatSearch(many);
  const selected = () => document.querySelector("[cmdk-item][aria-selected='true']")?.textContent ?? "";

  // New chat, the 50 newest chats, then Show more.
  await waitFor(() => assert.equal(optionNames().length, 52));
  assert.equal(screen.getAllByRole("option")[51].getAttribute("aria-label"), "Show 20 more, 20 not shown");
  assert.ok(!screen.queryByText("Chat 50"));

  fireEvent.keyDown(input, { key: "End" });
  await waitFor(() => assert.match(selected(), /^Show 20 more/u));
  fireEvent.keyDown(input, { key: "Enter" });

  // Every chat is reachable, and the first one revealed takes Show more's place.
  await waitFor(() => assert.equal(optionNames().length, 71));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(selected(), /^Chat 50/u);
  assert.ok(input.isConnected, "Show more keeps the palette open");

  // A new query starts from one page again, and the count names every match
  // (New chat matches too).
  fireEvent.change(input, { target: { value: "chat" } });
  await waitFor(() => assert.equal(optionNames().length, 52));
  assert.match(optionNames()[51], /^Show 20 more/u);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  assert.equal(document.querySelector("[cmdk-root] [aria-live='polite']")?.textContent, "71 results");
});
