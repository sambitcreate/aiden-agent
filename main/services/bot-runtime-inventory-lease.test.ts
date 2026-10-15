import assert from "node:assert/strict";
import test from "node:test";
import {
  BotRuntimeInventoryLeaseInvalidError,
  BotRuntimeInventoryLeaseRegistry,
  readUnderFreshBotRuntimeInventoryLease,
} from "./bot-runtime-inventory-lease.js";

for (const mutation of [
  "settings",
  "provider_configuration",
  "provider_credential",
  "mcp_configuration",
  "mcp_credential",
  "skill_configuration",
  "skill_content",
] as const) {
  test(`${mutation} publication aborts an active Bot inventory lease`, () => {
    const registry = new BotRuntimeInventoryLeaseRegistry();
    const revision = registry.revision();
    const lease = registry.acquire();
    assert.equal(registry.activeCount(), 1);

    registry.invalidate(mutation);
    assert.notEqual(registry.revision(), revision);

    assert.equal(lease.signal.aborted, true);
    assert.throws(() => lease.assertCurrent(), /capabilities changed/u);
    assert.equal(registry.activeCount(), 0);
  });
}

test("a changed discovered-skill/catalog fingerprint aborts old work but not its baseline", () => {
  const registry = new BotRuntimeInventoryLeaseRegistry();
  registry.publishFingerprint("bot:bot-a", "catalog-v1");
  const lease = registry.acquire();

  registry.publishFingerprint("bot:bot-a", "catalog-v1");
  lease.assertCurrent();
  registry.publishFingerprint("bot:bot-a", "catalog-v2");

  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertCurrent(), /capabilities changed/u);
});

test("a controlled publication lets the next fresh snapshot establish a new baseline", () => {
  const registry = new BotRuntimeInventoryLeaseRegistry();
  registry.publishFingerprint("bot:bot-a", "catalog-v1");
  registry.invalidate("settings");
  const next = registry.acquire();
  registry.publishFingerprint("bot:bot-a", "catalog-v2");
  next.assertCurrent();
});

test("release is idempotent and removes the inventory lease", () => {
  const registry = new BotRuntimeInventoryLeaseRegistry();
  const lease = registry.acquire();
  lease.release();
  lease.release();
  assert.equal(registry.activeCount(), 0);
  assert.throws(() => lease.assertCurrent(), /capabilities changed/u);
});

test("a fresh-lease read retries a mid-read fence and returns a still-held current lease", async () => {
  const registry = new BotRuntimeInventoryLeaseRegistry();
  let reads = 0;
  const { lease, value } = await readUnderFreshBotRuntimeInventoryLease(registry, async () => {
    reads += 1;
    if (reads === 1) registry.invalidate("provider_credential");
    return `snapshot-${reads}`;
  });
  assert.equal(value, "snapshot-2");
  assert.doesNotThrow(() => lease.assertCurrent());
  assert.equal(registry.activeCount(), 1);
  lease.release();
});

test("a fresh-lease read gives up after bounded fences and does not retry other failures", async () => {
  const registry = new BotRuntimeInventoryLeaseRegistry();
  let reads = 0;
  await assert.rejects(
    readUnderFreshBotRuntimeInventoryLease(registry, async () => {
      reads += 1;
      registry.invalidate("mcp_credential");
    }),
    BotRuntimeInventoryLeaseInvalidError,
  );
  assert.equal(reads, 3);
  assert.equal(registry.activeCount(), 0);

  reads = 0;
  await assert.rejects(
    readUnderFreshBotRuntimeInventoryLease(registry, async () => {
      reads += 1;
      throw new Error("catalog unavailable");
    }),
    /catalog unavailable/u,
  );
  assert.equal(reads, 1);
  assert.equal(registry.activeCount(), 0);
});
