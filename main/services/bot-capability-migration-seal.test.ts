import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createBotCapabilityMigrationSeal } from "./bot-capability-migration-seal.js";

test("migration seal is independent, private, durable, and strict", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aiden-bot-migration-seal-"));
  try {
    const seal = createBotCapabilityMigrationSeal({ root: () => root, now: () => 7 });
    assert.equal(await seal.isSealed(), false);
    await seal.seal();
    assert.equal(await seal.isSealed(), true);
    await seal.seal();
    const file = path.join(root, "bot-capability-migration-seal.json");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, sealedAt: 7 });

    await fs.writeFile(file, "{}", { mode: 0o600 });
    await assert.rejects(seal.isSealed(), /seal is invalid/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("migration seal rejects symlink substitution", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aiden-bot-migration-link-"));
  const target = path.join(root, "target.json");
  try {
    await fs.writeFile(target, JSON.stringify({ version: 1, sealedAt: 1 }), { mode: 0o600 });
    await fs.symlink(target, path.join(root, "bot-capability-migration-seal.json"));
    const seal = createBotCapabilityMigrationSeal({ root: () => root });
    await assert.rejects(seal.isSealed(), /private regular file/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
