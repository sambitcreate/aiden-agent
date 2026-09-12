import assert from "node:assert/strict";
import test from "node:test";
import { memoryEnabledForChat } from "./memory-policy.js";
import type { Chat, Workspace } from "./types.js";

const chat = (overrides: Partial<Chat> = {}): Chat => ({
  id: "chat-1",
  title: "Chat",
  workspaceId: "workspace-1",
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

function reader(globalEnabled: boolean | undefined, workspaceEnabled: boolean | undefined) {
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Workspace",
    permission: "ask",
    ...(typeof workspaceEnabled === "boolean" ? { memoryEnabled: workspaceEnabled } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    getSettings: async () =>
      typeof globalEnabled === "boolean" ? { memoryEnabled: globalEnabled } : {},
    getWorkspace: async () => workspace,
  };
}

test("memory defaults on and requires both global and workspace policy", async () => {
  assert.equal(await memoryEnabledForChat(reader(undefined, undefined), chat()), true);
  assert.equal(await memoryEnabledForChat(reader(false, true), chat()), false);
  assert.equal(await memoryEnabledForChat(reader(true, false), chat()), false);
  assert.equal(await memoryEnabledForChat(reader(true, true), chat()), true);
});

test("Bot scopes follow global policy rather than an incidental workspace", async () => {
  assert.equal(await memoryEnabledForChat(reader(true, false), chat({ botId: "bot-1" })), true);
  assert.equal(await memoryEnabledForChat(reader(false, true), chat({ botId: "bot-1" })), false);
});
