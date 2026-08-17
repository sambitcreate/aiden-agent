import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTelegramFolderWorkspace,
  telegramWorkspaceSelectionId,
} from "./telegram-workspace-core.js";

test("telegramWorkspaceSelectionId trims a non-empty workspace id", () => {
  assert.equal(telegramWorkspaceSelectionId("  workspace-a  "), "workspace-a");
});

test("telegramWorkspaceSelectionId clears non-string and blank values", () => {
  assert.equal(telegramWorkspaceSelectionId(undefined), undefined);
  assert.equal(telegramWorkspaceSelectionId("  "), undefined);
  assert.equal(telegramWorkspaceSelectionId(12), undefined);
});

test("isTelegramFolderWorkspace accepts only a configured folder workspace", () => {
  assert.equal(isTelegramFolderWorkspace({ folderPath: "/tmp/aiden" }), true);
  assert.equal(isTelegramFolderWorkspace({}), false);
  assert.equal(isTelegramFolderWorkspace(null), false);
});
