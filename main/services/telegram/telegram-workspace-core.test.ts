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

test("ordinary Telegram authority accepts Ask and Full folders while denying No Access", async () => {
  const { assertTelegramWorkspaceAccess } = await import("./telegram-workspace-core.js");
  assert.throws(() => assertTelegramWorkspaceAccess({ folderPath: "/project", permission: "none" }), /No Access/u);
  assert.throws(() => assertTelegramWorkspaceAccess({ permission: "full" }), /unavailable/u);
  assert.doesNotThrow(() => assertTelegramWorkspaceAccess({ folderPath: "/project", permission: "ask" }));
  assert.doesNotThrow(() => assertTelegramWorkspaceAccess({ folderPath: "/project", permission: "full" }));
});

test("topic reconciliation preserves existing denied-folder routes for Bots but provisions only accessible folders", async () => {
  const { telegramThreadWorkspacePlan } = await import("./telegram-workspace-core.js");
  const plan = telegramThreadWorkspacePlan([
    { id: "ask", folderPath: "/ask", permission: "ask" },
    { id: "full", folderPath: "/full", permission: "full" },
    { id: "denied", folderPath: "/denied", permission: "none" },
    { id: "scratch", permission: "full" },
  ] as const);
  assert.deepEqual([...plan.retain], ["ask", "full", "denied"]);
  assert.deepEqual(plan.provision.map(({ id }) => id), ["ask", "full"]);
});
