import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import { emptyPortableConfig } from "./portable-config-core.js";
import { BotRuntimeInventoryLeaseRegistry } from "./bot-runtime-inventory-lease.js";
import { admitBotAfterProviderAuthPreflight } from "./bot-provider-auth-admission-core.js";
import {
  invalidateChangedBotPortableAuthority,
  invalidateChangedBotProviderModelAuthority,
  invalidateChangedBotSettingsAuthority,
  withBotProviderInventoryMutation,
} from "./bot-runtime-inventory-publication.js";

function expectPublicationAbort(
  publish: (invalidate: (reason: Parameters<BotRuntimeInventoryLeaseRegistry["invalidate"]>[0]) => void) => void,
): void {
  const registry = new BotRuntimeInventoryLeaseRegistry();
  const lease = registry.acquire();
  publish((reason) => registry.invalidate(reason));
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertCurrent(), /capabilities changed/u);
}

test("settings availability publication fences active Bot work", () => {
  expectPublicationAbort((invalidate) =>
    invalidateChangedBotSettingsAuthority(
      { settings: { computerUseEnabled: true } },
      { settings: { computerUseEnabled: false } },
      invalidate,
    ));
});

test("provider, MCP, and configured-skill publications each fence active Bot work", () => {
  const cases = [
    (current: ReturnType<typeof emptyPortableConfig>) => {
      current.providers = [{
        id: "provider",
        kind: "openai",
        label: "Provider",
        baseUrl: "https://example.invalid",
        needsKey: false,
      }];
    },
    (current: ReturnType<typeof emptyPortableConfig>) => {
      current.mcpServers = [{
        id: "mcp",
        name: "MCP",
        transport: "http",
        url: "https://example.invalid/mcp",
        enabled: true,
      }];
    },
    (current: ReturnType<typeof emptyPortableConfig>) => {
      current.skills = [{
        id: "skill",
        name: "Skill",
        description: "Description",
        instructions: "Changed instructions",
        enabled: true,
      }];
    },
  ];
  for (const mutate of cases) {
    expectPublicationAbort((invalidate) => {
      const previous = emptyPortableConfig();
      const current = emptyPortableConfig();
      mutate(current);
      invalidateChangedBotPortableAuthority(previous, current, invalidate);
    });
  }
});

test("unchanged and first-observed config publications do not spuriously abort", () => {
  const registry = new BotRuntimeInventoryLeaseRegistry();
  const lease = registry.acquire();
  const current = emptyPortableConfig();
  invalidateChangedBotPortableAuthority(current, structuredClone(current), (reason) =>
    registry.invalidate(reason));
  invalidateChangedBotPortableAuthority(null, current, (reason) => registry.invalidate(reason));
  invalidateChangedBotSettingsAuthority(null, { settings: {} }, (reason) =>
    registry.invalidate(reason));
  invalidateChangedBotSettingsAuthority(
    { settings: { profileName: "Before" } },
    { settings: { profileName: "After" } },
    (reason) => registry.invalidate(reason),
  );
  invalidateChangedBotProviderModelAuthority(
    { byProvider: {} },
    { byProvider: {} },
    (reason) => registry.invalidate(reason),
  );
  invalidateChangedBotProviderModelAuthority(
    null,
    { byProvider: { provider: { models: ["chat"] } } },
    (reason) => registry.invalidate(reason),
  );
  lease.assertCurrent();
});

test("custom provider model-only publication fences active Bot work", () => {
  expectPublicationAbort((invalidate) =>
    invalidateChangedBotProviderModelAuthority(
      { byProvider: { provider: { models: ["old"] } } },
      { byProvider: { provider: { models: ["new"] } } },
      invalidate,
    ));
});

test("Pi provider refresh fences leases acquired during durable-to-memory publication", async () => {
  const registry = new BotRuntimeInventoryLeaseRegistry();
  const before = registry.acquire();
  let between: ReturnType<BotRuntimeInventoryLeaseRegistry["acquire"]> | undefined;
  const result = await withBotProviderInventoryMutation(async () => {
    assert.equal(before.signal.aborted, true);
    between = registry.acquire();
    between.assertCurrent();
    return "published";
  }, (reason) => registry.invalidate(reason));

  assert.equal(result, "published");
  assert.ok(between);
  assert.equal(between.signal.aborted, true);
  assert.throws(() => between!.assertCurrent(), /capabilities changed/u);
});

test("the post-publication fence exposes the new cache before admitting current work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-config-fence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = new BotRuntimeInventoryLeaseRegistry();
  let racingLease: ReturnType<BotRuntimeInventoryLeaseRegistry["acquire"]> | undefined;
  let admittedLease: ReturnType<BotRuntimeInventoryLeaseRegistry["acquire"]> | undefined;
  let admittedRead: Promise<{ value: number }> | undefined;
  let store: DataStore<{ value: number }>;
  store = new DataStore<{ value: number }>("config.json", { value: 0 }, () => root, {
    beforeWritePublish: () => {
      registry.invalidate("settings");
      racingLease = registry.acquire();
    },
    afterWritePublish: () => {
      registry.invalidate("settings");
      admittedLease = registry.acquire();
      admittedRead = store.load();
    },
  });

  await store.save({ value: 1 });

  assert.ok(racingLease);
  assert.equal(racingLease.signal.aborted, true);
  assert.throws(() => racingLease!.assertCurrent(), /capabilities changed/u);
  assert.ok(admittedLease);
  admittedLease.assertCurrent();
  assert.deepEqual(await admittedRead, { value: 1 });
});

test("expired OAuth refresh publishes before Bot admission and the first request succeeds", async () => {
  const inventory = new BotRuntimeInventoryLeaseRegistry();
  let expiresAt = 0;
  let refreshes = 0;

  const resolveAuth = async (): Promise<string> => {
    if (Date.now() >= expiresAt) {
      inventory.invalidate("provider_credential");
      expiresAt = Date.now() + 60_000;
      refreshes += 1;
      inventory.invalidate("provider_credential");
    }
    return `oauth-${refreshes}`;
  };

  const admission = await admitBotAfterProviderAuthPreflight({
    preflightAuth: async () => {
      assert.equal(await resolveAuth(), "oauth-1");
    },
    admit: async () => inventory.acquire(),
  });

  assert.equal(refreshes, 1);
  admission.assertCurrent();
  assert.equal(await resolveAuth(), "oauth-1");
  admission.assertCurrent();

  inventory.invalidate("provider_credential");
  assert.equal(admission.signal.aborted, true);
  assert.throws(() => admission.assertCurrent(), /capabilities changed/u);
});

test("an aborted initialization never admits after auth preflight", async () => {
  const controller = new AbortController();
  let admissions = 0;
  await assert.rejects(
    admitBotAfterProviderAuthPreflight({
      signal: controller.signal,
      preflightAuth: async () => controller.abort(new Error("cancelled")),
      admit: async () => {
        admissions += 1;
        return {};
      },
    }),
    /cancelled/u,
  );
  assert.equal(admissions, 0);
});
