import assert from "node:assert/strict";
import test from "node:test";
import { BotRuntimeInventoryLeaseRegistry } from "./bot-runtime-inventory-lease.js";

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
    const lease = registry.acquire();
    assert.equal(registry.activeCount(), 1);

    registry.invalidate(mutation);

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
