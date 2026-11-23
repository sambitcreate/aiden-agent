// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Chat, Workspace } from "../lib/types";
import {
  attachableProjectWorkspaces,
  AttachWorkspaceDialog,
} from "./attach-workspace-dialog";

const WORKSPACES: Workspace[] = [
  { id: "default", name: "No workspace", folderPath: "/tmp/nows", permission: "ask", noWorkspace: true, createdAt: 1, updatedAt: 50 },
  { id: "assistant", name: "Assistant", folderPath: "/tmp/asst", permission: "ask", createdAt: 1, updatedAt: 40 },
  { id: "folderless", name: "Folderless", permission: "ask", createdAt: 1, updatedAt: 30 },
  { id: "ws-alpha", name: "Alpha", folderPath: "/Users/me/alpha", permission: "ask", createdAt: 1, updatedAt: 20 },
  { id: "ws-beta", name: "Beta", folderPath: "/Users/me/beta", permission: "ask", createdAt: 1, updatedAt: 100 },
];

afterEach(() => cleanup());

test("attachableProjectWorkspaces keeps only folder-backed project workspaces sorted by recency", () => {
  assert.deepEqual(
    attachableProjectWorkspaces(WORKSPACES).map((ws) => ws.id),
    ["ws-beta", "ws-alpha"],
  );
});

test("AttachWorkspaceDialog attaches immediately when scratch folder is empty", async () => {
  const calls = installBotTestIpc({
    "chats:inspectAttachFiles": () => ({
      hasFiles: false,
      totalBytes: 0,
      truncated: false,
      entries: [],
    }),
    "chats:attachToWorkspace": () => ({
      chat: { id: "chat-1", title: "Quick", workspaceId: "ws-beta", createdAt: 1, updatedAt: 2, messages: [] } satisfies Chat,
      copiedPaths: [],
      oldWorkspaceId: "nows-1",
    }),
  });

  let closed = false;
  let attachedTo = "";
  render(
    <AttachWorkspaceDialog
      open
      onOpenChange={(next) => { if (!next) closed = true; }}
      chatId="chat-1"
      workspaces={WORKSPACES}
      onAttached={(_result, target) => { attachedTo = target.id; }}
    />,
  );

  // Filter input narrows the list to Beta only.
  fireEvent.change(screen.getByLabelText("Filter workspaces"), { target: { value: "Beta" } });
  assert.equal(screen.queryByRole("button", { name: /Alpha/u }), null);
  const betaBtn = screen.getByRole("button", { name: /Beta/u });

  await act(async () => {
    fireEvent.click(betaBtn);
  });

  assert.deepEqual(calls, [
    { channel: "chats:inspectAttachFiles", args: ["chat-1"] },
    { channel: "chats:attachToWorkspace", args: [{ chatId: "chat-1", targetWorkspaceId: "ws-beta" }] },
  ]);
  assert.equal(attachedTo, "ws-beta");
  assert.equal(closed, true);
});

test("AttachWorkspaceDialog shows scratch-file preflight and respects Trash vs Copy", async () => {
  const attachCalls: unknown[] = [];
  installBotTestIpc({
    "chats:inspectAttachFiles": () => ({
      hasFiles: true,
      totalBytes: 512,
      truncated: false,
      entries: [{ relativePath: "notes.md", sizeBytes: 512, isDirectory: false }],
    }),
    "chats:attachToWorkspace": (input) => {
      attachCalls.push(input);
      return {
        chat: { id: "chat-1", title: "Quick", workspaceId: "ws-alpha", createdAt: 1, updatedAt: 2, messages: [] } satisfies Chat,
        copiedPaths: [],
        oldWorkspaceId: "nows-1",
      };
    },
  });

  render(
    <AttachWorkspaceDialog
      open
      onOpenChange={() => undefined}
      chatId="chat-1"
      workspaces={WORKSPACES}
      onAttached={() => undefined}
    />,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Alpha/u }));
  });

  // Preflight lists notes.md and does NOT call attachToWorkspace yet.
  assert.equal(attachCalls.length, 0);
  assert.equal(Boolean(screen.getByText("notes.md")), true);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Leave behind (Trash)" }));
  });

  assert.deepEqual(attachCalls, [
    { chatId: "chat-1", targetWorkspaceId: "ws-alpha", fileAction: "trash" },
  ]);
});
