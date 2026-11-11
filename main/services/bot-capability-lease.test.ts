import assert from "node:assert/strict";
import test from "node:test";
import { BotCapabilityLeaseRegistry } from "./bot-capability-lease.js";

test("Bot authority leases invalidate synchronously and reject stale durable epochs", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const first = registry.acquire({
    audienceId: "device:a",
    botId: "bot:one",
    botPolicyEpoch: 1,
    chatId: "chat:one",
    chatPolicyEpoch: 1,
  });
  first.assertCurrent();
  registry.invalidateBot("bot:one");
  assert.equal(first.signal.aborted, true);
  assert.throws(() => first.assertCurrent(), /access changed/u);

  registry.publishBotEpoch("bot:one", 2);
  assert.throws(
    () =>
      registry.acquire({
        audienceId: "device:a",
        botId: "bot:one",
        botPolicyEpoch: 1,
      }),
    /stale/u,
  );
  assert.throws(() => registry.publishBotEpoch("bot:one", 1), /rolled back/u);
  registry.acquire({ audienceId: "device:a", botId: "bot:one", botPolicyEpoch: 2 }).assertCurrent();
});

test("chat invalidation is isolated while Bot invalidation fences every child", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const first = registry.acquire({
    audienceId: "device:a",
    botId: "bot:one",
    botPolicyEpoch: 1,
    chatId: "chat:first",
    chatPolicyEpoch: 1,
  });
  const second = registry.acquire({
    audienceId: "device:a",
    botId: "bot:one",
    botPolicyEpoch: 1,
    chatId: "chat:second",
    chatPolicyEpoch: 1,
  });
  registry.invalidateChat("bot:one", "chat:first");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  second.assertCurrent();

  registry.invalidateBot("bot:one");
  assert.equal(second.signal.aborted, true);
  assert.equal(registry.activeCount("bot:one"), 0);
});

test("revoking one notice audience aborts only that principal's active leases", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const phoneA = registry.acquire({
    audienceId: "device:a",
    botId: "bot:one",
    botPolicyEpoch: 1,
  });
  const phoneB = registry.acquire({
    audienceId: "device:b",
    botId: "bot:one",
    botPolicyEpoch: 1,
  });
  registry.invalidateAudience("device:a");
  assert.equal(phoneA.signal.aborted, true);
  assert.equal(phoneB.signal.aborted, false);
  phoneB.assertCurrent();
});

test("released leases are idempotent and malformed identities fail before admission", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const lease = registry.acquire({
    audienceId: "desktop:internal",
    botId: "bot:one",
    botPolicyEpoch: 1,
  });
  assert.equal(registry.activeCount("bot:one"), 1);
  lease.release();
  lease.release();
  assert.equal(registry.activeCount("bot:one"), 0);
  assert.throws(() => lease.assertCurrent(), /access changed/u);
  assert.throws(
    () => registry.acquire({ audienceId: "../device", botId: "bot:one", botPolicyEpoch: 1 }),
    /audience/u,
  );
  assert.throws(
    () => registry.acquire({ audienceId: "device:a", botId: "../bot", botPolicyEpoch: 1 }),
    /identity/u,
  );
  assert.throws(
    () =>
      registry.acquire({
        audienceId: "device:a",
        botId: "bot:one",
        botPolicyEpoch: 1,
        chatId: "chat:one",
      }),
    /supplied together/u,
  );
});

test("no lease re-acquired from an abort listener survives the invalidation that fired it", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const identity = { audienceId: "device:a", botId: "bot:one", botPolicyEpoch: 1 };
  const first = registry.acquire(identity);
  let reacquired: ReturnType<typeof registry.acquire> | undefined;
  first.signal.addEventListener("abort", () => {
    reacquired = registry.acquire(identity);
  });
  registry.invalidateBot("bot:one");
  assert.throws(() => reacquired!.assertCurrent(), /access changed/u);
  assert.equal(registry.activeCount("bot:one"), 0);
});

test("publishing a newer epoch ends older leases, and a higher admission publishes it", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const chat = { audienceId: "device:a", botId: "bot:one", botPolicyEpoch: 1, chatId: "chat:one" };
  const older = registry.acquire({ ...chat, chatPolicyEpoch: 1 });
  const sibling = registry.acquire({ ...chat, chatId: "chat:two", chatPolicyEpoch: 1 });

  const newer = registry.acquire({ ...chat, chatPolicyEpoch: 2 });
  assert.equal(older.signal.aborted, true);
  assert.equal(sibling.signal.aborted, false);
  assert.throws(() => registry.acquire({ ...chat, chatPolicyEpoch: 1 }), /stale/u);
  assert.throws(() => registry.publishChatEpoch("bot:one", "chat:one", 1), /rolled back/u);

  const nextBot = registry.acquire({ ...chat, botPolicyEpoch: 2, chatPolicyEpoch: 2 });
  assert.equal(newer.signal.aborted, true);
  assert.equal(sibling.signal.aborted, true);
  nextBot.assertCurrent();
});

test("publishing the current epoch again leaves active leases alone", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const lease = registry.acquire({
    audienceId: "device:a",
    botId: "bot:one",
    botPolicyEpoch: 3,
    chatId: "chat:one",
    chatPolicyEpoch: 2,
  });
  registry.publishBotEpoch("bot:one", 3);
  registry.publishChatEpoch("bot:one", "chat:one", 2);
  lease.assertCurrent();
});

test("a revoked audience may be admitted afresh, but its old lease stays dead", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const identity = { audienceId: "device:a", botId: "bot:one", botPolicyEpoch: 1 };
  const old = registry.acquire(identity);
  registry.invalidateAudience("device:a");
  const fresh = registry.acquire(identity);
  fresh.assertCurrent();
  assert.throws(() => old.assertCurrent(), /access changed/u);
});

test("releasing one lease does not fence, and a released lease is not aborted later", () => {
  const registry = new BotCapabilityLeaseRegistry();
  const identity = { audienceId: "device:a", botId: "bot:one", botPolicyEpoch: 1 };
  const released = registry.acquire(identity);
  const held = registry.acquire(identity);
  released.release();
  held.assertCurrent();
  registry.invalidateBot("bot:one");
  assert.equal(released.signal.aborted, false);
  assert.equal(held.signal.aborted, true);
  assert.throws(() => released.assertCurrent(), /access changed/u);
});
