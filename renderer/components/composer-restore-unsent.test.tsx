// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import { restoreUnsentMessage, takeComposerAttachmentSeed } from "../lib/composer-draft-store";
import type { Attachment, Chat, Workspace } from "../lib/types";

// A cancelled worktree send hands its message back to the draft. The real
// Composer, already open on that draft (the user left and came back), must
// take both the text and the attachments, not leave them for a later mount.

let queryClient: QueryClient;

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "app",
  folderPath: "/tmp/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};
const DRAFT = { id: "draft-restore", title: "New chat", messages: [], createdAt: 1, updatedAt: 1 } as unknown as Chat;
const NOTES: Attachment = {
  id: "att-notes",
  kind: "text",
  name: "notes.txt",
  mimeType: "text/plain",
  size: 12,
  text: "login steps",
};

beforeEach(() => {
  localStorage.clear();
  installBotTestIpc({
    "settings:get": () => null,
    "shortcut:get": () => null,
    "app:renderer-ready": () => null,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  takeComposerAttachmentSeed(DRAFT.id);
});

function Harness({ saving }: { saving: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CommandSystemProvider>
          <Composer
            ready
            hasMessages={false}
            chatId={DRAFT.id}
            sessionChat={DRAFT}
            workspace={WORKSPACE}
            freezeWhileSending
            firstMessageSaving={saving}
            onRenameChat={() => undefined}
            onSend={async () => undefined}
            onStop={() => undefined}
            isGenerating={false}
          />
        </CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("an open composer takes back both the text and the attachments of a cancelled send", async () => {
  // Reopened while the send was pending: frozen and empty.
  const view = render(<Harness saving />);
  await settle();
  assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).value, "");
  assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly, true, "a pending first send freezes the draft");

  await act(async () => {
    restoreUnsentMessage(DRAFT.id, "Fix the login bug", [NOTES]);
  });
  // Cancel then unlocks the draft.
  await act(async () => {
    view.rerender(<Harness saving={false} />);
  });
  await settle();
  assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).value, "Fix the login bug");
  assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly, false, "cancelling unfreezes it");
  assert.ok(screen.queryAllByText("notes.txt").length > 0, "the attachment is back in the composer");
  assert.equal(takeComposerAttachmentSeed(DRAFT.id), undefined, "nothing is left waiting for a later mount");
});

test("with no composer open, the message waits for the next one", async () => {
  restoreUnsentMessage(DRAFT.id, "Fix the login bug", [NOTES]);
  render(<Harness saving={false} />);
  await settle();
  assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).value, "Fix the login bug");
  assert.ok(screen.queryAllByText("notes.txt").length > 0);
});
