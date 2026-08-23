import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import { emptyPortableConfig } from "./portable-config-core.js";
import { BotRuntimeInventoryLeaseRegistry } from "./bot-runtime-inventory-lease.js";
import {
  invalidateChangedBotPortableAuthority,
  invalidateChangedBotSettingsAuthority,
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
  lease.assertCurrent();
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
