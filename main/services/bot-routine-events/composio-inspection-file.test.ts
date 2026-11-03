import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { botDirectoryName } from "../bot-runtime/harness-host.js";
import { COMPOSIO_INSPECTION_FILE, saveComposioWatchInspection } from "./composio-inspection-file.js";
import type { ComposioWatchProbeResult } from "./connector-watch-composio-probe.js";

const result: ComposioWatchProbeResult = { available: false, checkedAt: 1700000000000, status: "unavailable", code: "unsupported_meta_schema" };
async function fixture(t: TestContext) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-composio-proof-"));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const directory = path.join(profile, "bots", botDirectoryName("bot-a"));
  await fs.mkdir(directory, { recursive: true });
  return { profile, directory, file: path.join(directory, COMPOSIO_INSPECTION_FILE) };
}

test("inspection evidence is private, bounded, and survives reopening without retaining extra response fields", async (t) => {
  const f = await fixture(t);
  await saveComposioWatchInspection(f.profile, "bot-a", { ...result, vendorResponse: { credential: "never-retain-this" } } as ComposioWatchProbeResult, async () => {});
  const contents = await fs.readFile(f.file, "utf8");
  assert.deepEqual(JSON.parse(contents), { version: 1, checkedAt: result.checkedAt, status: "unavailable", code: "unsupported_meta_schema" });
  assert.ok(!contents.includes("never-retain-this"));
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test("a late revoked inspection leaves the previous evidence intact and cleans staging files", async (t) => {
  const f = await fixture(t);
  await saveComposioWatchInspection(f.profile, "bot-a", result, async () => {});
  const before = await fs.readFile(f.file, "utf8");
  let checks = 0;
  await assert.rejects(saveComposioWatchInspection(f.profile, "bot-a", { ...result, checkedAt: result.checkedAt + 1 }, async () => {
    if (++checks === 3) throw new Error("Access revoked.");
  }), /Access revoked/u);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.deepEqual(await fs.readdir(f.directory), [COMPOSIO_INSPECTION_FILE]);
});

test("an inspection neither recreates a deleted Bot nor follows a replaced directory symlink", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.directory, { recursive: true });
  await assert.rejects(saveComposioWatchInspection(f.profile, "bot-a", result, async () => {}), { code: "ENOENT" });
  assert.equal(await fs.stat(f.directory).then(() => true, () => false), false);
  const other = path.join(f.profile, "other");
  await fs.mkdir(other);
  await fs.symlink(other, f.directory, "dir");
  await assert.rejects(saveComposioWatchInspection(f.profile, "bot-a", result, async () => {}), /private directory/u);
  assert.deepEqual(await fs.readdir(other), []);
});

test("a slower earlier inspection cannot replace the latest diagnostic", async (t) => {
  const f = await fixture(t);
  const latest = { ...result, checkedAt: result.checkedAt + 2 };
  await saveComposioWatchInspection(f.profile, "bot-a", latest, async () => {});
  const before = await fs.readFile(f.file, "utf8");
  await saveComposioWatchInspection(f.profile, "bot-a", { ...result, checkedAt: result.checkedAt + 1, code: "inspection_failed" }, async () => {});
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.deepEqual(await fs.readdir(f.directory), [COMPOSIO_INSPECTION_FILE]);
});

test("corrupt or newer-version diagnostics are preserved instead of overwritten", async (t) => {
  const f = await fixture(t);
  for (const existing of ["{ torn", JSON.stringify({ version: 2, checkedAt: result.checkedAt }), JSON.stringify({ version: 1, checkedAt: result.checkedAt, status: "inspected", code: "private-unknown-code" }), "x".repeat(32 * 1024 + 1)]) {
    await fs.writeFile(f.file, existing);
    await assert.rejects(saveComposioWatchInspection(f.profile, "bot-a", { ...result, checkedAt: result.checkedAt + 1 }, async () => {}));
    assert.equal(await fs.readFile(f.file, "utf8"), existing);
    assert.deepEqual(await fs.readdir(f.directory), [COMPOSIO_INSPECTION_FILE]);
  }
});
