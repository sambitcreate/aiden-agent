import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createUnavailableTelegramBotBindingStore,
  TelegramBotBindingsUnsupportedError,
} from "./telegram-bot-binding-platform.js";

test("unsupported Bot bindings leave ordinary Telegram routing healthy and unbound", async () => {
  const store = createUnavailableTelegramBotBindingStore();
  await store.assertHealthy();
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get("bot"), null);
  assert.equal(await store.resolve("default", 42), null);
  assert.equal(await store.unbindProfile("default"), 0);
});
test("unsupported Bot binding mutations fail closed", async () => {
  const store = createUnavailableTelegramBotBindingStore();
  await assert.rejects(
    store.bind({
      botId: "bot",
      profile: "default",
      chatId: 42,
      ownerUserId: 42,
      workspaceId: "workspace",
      backingWorkspaceId: "bot-workspace",
    }),
    TelegramBotBindingsUnsupportedError,
  );
  await assert.rejects(store.unbind("bot"), TelegramBotBindingsUnsupportedError);
});

test("ordinary Telegram cleanup cannot activate Bot notice storage on Linux", () => {
  const source = readFileSync(new URL("./telegram-service.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /revokeTelegramBotNoticeForCurrentOwner[\s\S]*?if \(!hostPlatformCapabilities\(\)\.bots\) return;[\s\S]*?botApplicationService\.revokeNoticeAudience/u,
  );
});
