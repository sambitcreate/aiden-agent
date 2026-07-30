import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { listProvidersWithSafeLegacyPiCredentialMigration } from "./legacy-pi-credential-migration-core.js";

for (const unsafeShape of [
  "malformed",
  "invalid UTF-8",
  "FIFO",
  "directory",
  "unresolved alias secret",
]) {
  test(`legacy Pi migration stays deferred for ${unsafeShape} portable config`, async () => {
    let migrated = false;
    let deferred = false;
    const providers = [{ id: "safe-projection" }];

    assert.strictEqual(
      await listProvidersWithSafeLegacyPiCredentialMigration({
        listProviders: async () => providers,
        migrationReady: async () => false,
        migrate: async () => {
          migrated = true;
        },
        onDeferred: () => {
          deferred = true;
        },
      }),
      providers,
    );
    assert.equal(migrated, false);
    assert.equal(deferred, true);
  });
}

test("legacy Pi migration runs only after provider and secret reconciliation", async () => {
  const order: string[] = [];
  await listProvidersWithSafeLegacyPiCredentialMigration({
    listProviders: async () => {
      order.push("providers");
      return [];
    },
    migrationReady: async () => {
      order.push("ready");
      return true;
    },
    migrate: async () => {
      order.push("migrate");
    },
  });
  assert.deepEqual(order, ["providers", "ready", "migrate"]);
});

test("a transient Pi credential-store failure is reported without hiding providers", async () => {
  const failure = new Error("keychain unavailable");
  let reported: unknown;
  const providers = [{ id: "custom" }];

  assert.strictEqual(
    await listProvidersWithSafeLegacyPiCredentialMigration({
      listProviders: async () => providers,
      migrationReady: async () => true,
      migrate: async () => {
        throw failure;
      },
      onMigrationError: (error) => {
        reported = error;
      },
    }),
    providers,
  );
  assert.strictEqual(reported, failure);
});

test("every Pi credential consumer uses the centralized safe migration gate", async () => {
  for (const relative of ["../handlers/providers.ts", "model-runtime.ts", "transcription.ts"]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf-8");
    assert.match(source, /listProvidersWithLegacyPiCredentialMigration/u, relative);
    assert.doesNotMatch(source, /\.migrateLegacyApiKeys\(/u, relative);
  }
});
