import assert from "node:assert/strict";
import test from "node:test";
import { INVOKE_PREFIXES, NATIVE_INVOKE_CHANNELS, NOTIFICATION_CHANNELS } from "./preload-channels.js";
import {
  QUICK_CHAT_INVOKE_CHANNELS,
  QUICK_CHAT_NOTIFICATION_CHANNELS,
} from "./quick-chat-preload-channels.js";
import { createQuickChatPreloadApi } from "./quick-chat-preload-core.js";

test("every Quick Chat invoke channel is covered by the shared INVOKE_PREFIXES", () => {
  for (const channel of QUICK_CHAT_INVOKE_CHANNELS) {
    assert.ok(
      INVOKE_PREFIXES.some((prefix) => channel.startsWith(prefix)),
      `Quick Chat invoke channel ${channel} must be covered by INVOKE_PREFIXES`,
    );
  }
});

test("every Quick Chat notification channel is in the shared NOTIFICATION_CHANNELS allowlist", () => {
  for (const channel of QUICK_CHAT_NOTIFICATION_CHANNELS) {
    assert.ok(
      NOTIFICATION_CHANNELS.has(channel),
      `Quick Chat notification channel ${channel} must be in NOTIFICATION_CHANNELS`,
    );
  }
});

test("Quick Chat preload excludes privileged desktop, terminal, browser, remote, bot, settings mutation, and screen-capture channels", () => {
  const forbiddenPrefixes = [
    "terminal:",
    "browser:",
    "remote:",
    "bots:",
    "botComputers:",
    "computerUse:",
    "devices:",
    "diagnostics:",
    "storage:",
    "telegram:",
    "aiden:",
    "mcp:",
    "schedule:",
    "hooks:",
  ];
  for (const channel of QUICK_CHAT_INVOKE_CHANNELS) {
    for (const prefix of forbiddenPrefixes) {
      assert.equal(
        channel.startsWith(prefix),
        false,
        `Quick Chat preload must not expose privileged channel ${channel}`,
      );
    }
  }
  assert.equal(QUICK_CHAT_INVOKE_CHANNELS.has("settings:set"), false);
  assert.equal(QUICK_CHAT_INVOKE_CHANNELS.has("providers:listModels"), false);
});

test("createQuickChatPreloadApi enforces invoke, notification, and microphone-only media gates at runtime", async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const subscribed: string[] = [];
  const api = createQuickChatPreloadApi({
    invoke: async <T,>(channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      return true as T;
    },
    onNotification: (channel) => {
      subscribed.push(channel);
      return () => {};
    },
    getPathForFile: () => "/tmp/sample.txt",
  });

  await api.ipc.invoke("quickChat:hide");
  assert.throws(() => api.ipc.invoke("settings:set", { approvalMode: "auto" }), /not available/);
  assert.throws(() => api.ipc.invoke("providers:listModels", {}), /not available/);
  assert.throws(() => api.ipc.invoke("terminal:create"), /not available/);

  api.ipc.onNotification("quickChat:opened", () => {});
  assert.throws(() => api.ipc.onNotification("terminal:data", () => {}), /not available/);
  assert.deepEqual(subscribed, ["quickChat:opened"]);

  await api.systemPreferences.getMediaAccessStatus("microphone");
  await api.systemPreferences.askForMediaAccess("microphone");
  assert.throws(
    () => api.systemPreferences.getMediaAccessStatus("screen" as "microphone"),
    /microphone/,
  );
  assert.throws(
    () => api.systemPreferences.askForMediaAccess("camera" as "microphone"),
    /microphone/,
  );
  assert.deepEqual(calls, [
    { channel: "quickChat:hide", args: [] },
    { channel: NATIVE_INVOKE_CHANNELS.mediaStatus, args: ["microphone"] },
    { channel: NATIVE_INVOKE_CHANNELS.mediaRequest, args: ["microphone"] },
  ]);
});
