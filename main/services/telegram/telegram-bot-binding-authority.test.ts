import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramBotBinding } from "./telegram-bot-binding-store.js";
import { createTelegramBotBindingAuthorityNarrower } from "./telegram-bot-binding-authority.js";

const disabled: TelegramBotBinding = {
  botId: "bot:one",
  profile: "work",
  chatId: 42,
  ownerUserId: 7,
  workspaceId: "external",
  backingWorkspaceId: "managed",
  backingChatId: "telegram-bot-11111111-1111-4111-8111-111111111111",
  createdAt: 1,
  updatedAt: 2,
  enabled: false,
};

test("direct disconnect and profile reset share a reduction-only authority surface", async () => {
  const events: string[] = [];
  const authority = createTelegramBotBindingAuthorityNarrower({
    async unbind(botId) {
      events.push(`disable-bot:${botId}`);
      return { ...disabled, botId };
    },
    async unbindProfile(profile) {
      events.push(`disable-profile:${profile}`);
      return 2;
    },
  });

  assert.equal((await authority.disableBot("bot:one")).enabled, false);
  assert.equal(await authority.disableProfile("work"), 2);
  assert.deepEqual(events, ["disable-bot:bot:one", "disable-profile:work"]);
  assert.deepEqual(Object.keys(authority).sort(), ["disableBot", "disableProfile"]);
  assert.equal(Object.isFrozen(authority), true);
  assert.equal("bind" in authority, false);
});

test("protected-store poison fails closed without a widening fallback", async () => {
  let calls = 0;
  const authority = createTelegramBotBindingAuthorityNarrower({
    async unbind() {
      calls += 1;
      throw new Error("independent binding authority unavailable");
    },
    async unbindProfile() {
      calls += 1;
      throw new Error("independent binding authority unavailable");
    },
  });

  await assert.rejects(
    authority.disableBot("bot:one"),
    /independent binding authority unavailable/u,
  );
  await assert.rejects(
    authority.disableProfile("work"),
    /independent binding authority unavailable/u,
  );
  assert.equal(calls, 2);
});
