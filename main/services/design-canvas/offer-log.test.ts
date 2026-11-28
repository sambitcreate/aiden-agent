import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OfferLog } from "./offer-log.js";

async function tempDir(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-offer-log-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a key is claimed once per run, settle(true) persists it and settle(false) releases it", async (t) => {
  const dir = await tempDir(t);
  const file = () => path.join(dir, "offers.json");
  const log = new OfferLog({ file, now: () => 5 });
  const key = await log.keyFor("/work/space", "apps/web");
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.notEqual(key, await log.keyFor("/work/space", "apps/admin"));
  assert.notEqual(key, await log.keyFor("/work/spaceapps/web"));

  assert.equal(await log.claim(key), true);
  assert.equal(await log.claim(key), false, "not twice in one run");
  await log.settle(key, false);
  assert.equal(await log.claim(key), true, "released by an undelivered turn");
  await log.settle(key, true);
  assert.equal(await log.claim(key), false);

  const later = new OfferLog({ file });
  assert.equal(await later.claim(await later.keyFor("/work/space", "apps/web")), false, "still logged after a restart");
  assert.equal(await later.claim(await later.keyFor("/work/space", "apps/admin")), true);
  const text = await fs.readFile(file(), "utf8");
  assert.ok(!text.includes("work") && !text.includes("apps"));
});

test("a log in the shape v1's design-system offers wrote reads unchanged", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "design-system-offers.json");
  const secret = randomBytes(32);
  await fs.writeFile(`${file}.key`, `${secret.toString("hex")}\n`, { mode: 0o600 });
  const folder = path.resolve(dir, "some-workspace");
  const logged = createHmac("sha256", secret).update(folder).digest("hex");
  await fs.writeFile(file, JSON.stringify({ version: 2, offered: { [logged]: 1_000 } }));

  const log = new OfferLog({ file: () => file, now: () => 2_000 });
  assert.equal(await log.keyFor(folder), logged);
  assert.equal(await log.claim(logged), false);
  const other = await log.keyFor(path.resolve(dir, "other"));
  assert.equal(await log.claim(other), true);
  await log.settle(other, true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 2, offered: { [logged]: 1_000, [other]: 2_000 } });
});

test("an unreadable key file gives a run-only key", async (t) => {
  const dir = await tempDir(t);
  const file = () => path.join(dir, "offers.json");
  // The key file's path is a folder, so it can be neither read nor written.
  await fs.mkdir(`${file()}.key`);
  const log = new OfferLog({ file });
  const key = await log.keyFor("/work/space");
  assert.equal(await log.claim(key), true);
  await log.settle(key, true);
  assert.equal(await log.claim(key), false);
  const next = new OfferLog({ file });
  assert.notEqual(await next.keyFor("/work/space"), key);
  assert.equal(await next.claim(await next.keyFor("/work/space")), true);
});

test("1 000 entries are kept, oldest out", async (t) => {
  const dir = await tempDir(t);
  const file = () => path.join(dir, "offers.json");
  const offered: Record<string, number> = {};
  for (let index = 0; index < 1_000; index++) offered[index.toString(16).padStart(64, "0")] = index + 1;
  await fs.writeFile(file(), JSON.stringify({ version: 2, offered }));
  const log = new OfferLog({ file, now: () => 10_000 });
  const key = await log.keyFor("/new");
  assert.equal(await log.claim(key), true);
  await log.settle(key, true);
  const saved = JSON.parse(await fs.readFile(file(), "utf8")) as { offered: Record<string, number> };
  assert.equal(Object.keys(saved.offered).length, 1_000);
  assert.equal(saved.offered[key], 10_000);
  assert.ok(!("0".repeat(64) in saved.offered), "the oldest entry went out");
});
