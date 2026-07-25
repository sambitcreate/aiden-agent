import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_INVOKE_CHANNELS,
  ASSISTANT_NOTIFICATION_CHANNELS,
} from "./preload-assistant-channels.js";
import { NOTIFICATION_CHANNELS } from "./preload-channels.js";

test("assistant preload exposes exactly its chat, history, config, and nudge surface", () => {
  assert.deepEqual([...ASSISTANT_INVOKE_CHANNELS].sort(), [
    "assistant:dismiss-nudge",
    "assistant:get-config",
    "assistant:get-state",
    "assistant:hide-window",
    "assistant:set-config",
    "assistant:snooze-nudge",
    "assistant:toggle-window",
    "chat:approve",
    "chat:cancel",
    "chat:start",
    "chats:create",
    "chats:get",
    "chats:list",
    "settings:get",
  ]);
  assert.deepEqual([...ASSISTANT_NOTIFICATION_CHANNELS].sort(), [
    "aiden:theme:changed",
    "assistant:nudge",
    "assistant:open-thread",
    "assistant:state-changed",
    "chat:approval",
    "chat:delta",
    "chat:done",
    "chat:error",
    "chat:reasoning-delta",
    "chat:status",
    "chat:timeline",
    "chat:tool",
    "chats:metadata-updated",
  ]);
});

test("the assistant window cannot reach key material, git writes, or the scheduler", () => {
  for (const forbidden of [
    "providers:setKey",
    "mcp:setPresetKey",
    "settings:set",
    "git:push",
    "git:commit",
    "schedule:save",
    "computerUse:start",
    "terminal:create",
  ]) {
    assert.equal(ASSISTANT_INVOKE_CHANNELS.has(forbidden), false, forbidden);
  }
});

test("every assistant notification is also in the shared preload allowlist", () => {
  // ipcMain.broadcast reaches every window, so the shared list is the contract
  // the ipc-contract test enforces; this one keeps the two from drifting.
  for (const channel of ASSISTANT_NOTIFICATION_CHANNELS) {
    assert.equal(NOTIFICATION_CHANNELS.has(channel), true, channel);
  }
});
