import assert from "node:assert/strict";
import test from "node:test";
import { BOT_BUBBLE_CHANNELS } from "./shared/bot-bubbles.js";
import { INVOKE_PREFIXES, NOTIFICATION_CHANNELS } from "./preload-channels.js";
import { BOT_BUBBLES_INVOKE_CHANNELS, BOT_BUBBLES_NOTIFICATION_CHANNELS } from "./bot-bubbles-preload-channels.js";
import { createBotBubblesPreloadApi } from "./bot-bubbles-preload-core.js";

test("every overlay invoke channel is one the shared preload prefixes cover", () => {
  for (const channel of BOT_BUBBLES_INVOKE_CHANNELS) {
    assert.ok(INVOKE_PREFIXES.some((prefix) => channel.startsWith(prefix)), channel);
  }
});

test("every overlay notification is in the shared notification allowlist", () => {
  for (const channel of BOT_BUBBLES_NOTIFICATION_CHANNELS) assert.ok(NOTIFICATION_CHANNELS.has(channel), channel);
});

test("the main window hears bubble changes and Open in Aiden", () => {
  assert.ok(NOTIFICATION_CHANNELS.has(BOT_BUBBLE_CHANNELS.changed));
  assert.ok(NOTIFICATION_CHANNELS.has(BOT_BUBBLE_CHANNELS.showChat));
});

test("the overlay bridge passes allowed channels through and refuses everything else", async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const subscribed: string[] = [];
  const api = createBotBubblesPreloadApi({
    invoke: async <T,>(channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      return null as T;
    },
    onNotification: (channel) => {
      subscribed.push(channel);
      return () => {};
    },
  });

  await api.ipc.invoke(BOT_BUBBLE_CHANNELS.open, { botId: "bot-a" });
  await api.ipc.invoke("bots:live:subscribe", "bot-a");
  await api.ipc.invoke("bots:approve", { waitId: "w", decision: "allow" });
  for (const channel of [
    "settings:set",
    "terminal:create",
    "browser:navigate",
    "bots:delete",
    "bots:update",
    "attachments:pickAndRead",
    "chat:start",
    "remote:pair",
  ]) {
    assert.throws(() => api.ipc.invoke(channel), /not available/, channel);
  }

  api.ipc.onNotification(BOT_BUBBLE_CHANNELS.transition, () => {});
  api.ipc.onNotification(BOT_BUBBLE_CHANNELS.overlayInfoChanged, () => {});
  api.ipc.onNotification("bots:live:event", () => {});
  assert.throws(() => api.ipc.onNotification("terminal:data", () => {}), /not available/);
  assert.throws(() => api.ipc.onNotification("chat:delta", () => {}), /not available/);

  assert.deepEqual(
    calls.map((call) => call.channel),
    [BOT_BUBBLE_CHANNELS.open, "bots:live:subscribe", "bots:approve"],
  );
  assert.deepEqual(calls[0]!.args, [{ botId: "bot-a" }]);
  assert.deepEqual(subscribed, [BOT_BUBBLE_CHANNELS.transition, BOT_BUBBLE_CHANNELS.overlayInfoChanged, "bots:live:event"]);
});
