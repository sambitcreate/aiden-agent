// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceFolderMissingNotice, type ContinueInNewChatChoice } from "./workspace-folder-missing-notice";

// Boolean and string oracles throughout: a failing assert on a happy-dom node would print the DOM.

const CHOICES: ContinueInNewChatChoice[] = [
  { workspaceId: "default", name: "No workspace", noWorkspace: true },
  { workspaceId: "api", name: "api" },
  { workspaceId: "site", name: "site" },
];

beforeEach(() => installBotTestIpc());
afterEach(() => cleanup());

async function openContinueMenu() {
  const trigger = screen.getByRole("button", { name: "Continue in a new chat" });
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  return screen.findAllByRole("menuitem");
}

test("Continue in a new chat lists No workspace first, then the workspaces, and starts the chosen one", async () => {
  const chosen: string[] = [];
  render(
    <WorkspaceFolderMissingNotice
      workspaceName="parser"
      folder="/Users/me/parser"
      continueChoices={CHOICES}
      onCheckAgain={() => undefined}
      onContinueIn={(workspaceId) => chosen.push(workspaceId)}
    />,
  );
  const items = await openContinueMenu();
  assert.deepEqual(items.map((item) => item.textContent), ["No workspace", "api", "site"]);
  await act(async () => {
    fireEvent.click(items[1]!);
  });
  assert.deepEqual(chosen, ["api"]);
});

test("with nowhere else to go, or no handler, the notice offers only Check again", () => {
  const { rerender } = render(
    <WorkspaceFolderMissingNotice workspaceName="parser" continueChoices={[]} onCheckAgain={() => undefined} onContinueIn={() => undefined} />,
  );
  assert.equal(screen.queryByRole("button", { name: "Continue in a new chat" }) === null, true);
  rerender(<WorkspaceFolderMissingNotice workspaceName="parser" continueChoices={CHOICES} onCheckAgain={() => undefined} />);
  assert.equal(screen.queryByRole("button", { name: "Continue in a new chat" }) === null, true);
  assert.equal(Boolean(screen.getByRole("button", { name: "Check again" })), true);
});

test("while the new chat is being made, every action waits", () => {
  render(
    <WorkspaceFolderMissingNotice
      workspaceName="parser"
      continuing
      continueChoices={CHOICES}
      onCheckAgain={() => undefined}
      onContinueIn={() => undefined}
    />,
  );
  const continuing = screen.getByRole("button", { name: "Continuing…" }) as HTMLButtonElement;
  const checkAgain = screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement;
  assert.equal(continuing.disabled, true);
  assert.equal(checkAgain.disabled, true);
});

test("a deleted worktree keeps Restore worktree as the main action next to Continue", () => {
  render(
    <WorkspaceFolderMissingNotice
      workspaceName="api"
      worktree={{ branch: "aiden/fix", restorable: true, mainWorkspaceId: "api", mainWorkspaceName: "api" }}
      continueChoices={CHOICES}
      onCheckAgain={() => undefined}
      onRestore={() => undefined}
      onNewChatInMain={() => undefined}
      onContinueIn={() => undefined}
    />,
  );
  const labels = screen.getAllByRole("button").map((button) => button.textContent);
  assert.deepEqual(labels, ["Check again", "Continue in a new chat", "New chat in main checkout", "Restore worktree"]);
});
