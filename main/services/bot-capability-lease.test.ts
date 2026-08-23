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
