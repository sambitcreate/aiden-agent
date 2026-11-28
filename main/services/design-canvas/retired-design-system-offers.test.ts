// v1's design-system offer leftovers are removed and nothing else (S114).

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanUpRetiredDesignSystemOffers } from "./retired-design-system-offers.js";

async function userData(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-retired-offers-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the old offers log and key are removed, a missing file is fine, and nothing else in userData is touched", async (t) => {
  const dir = await userData(t);
  await fs.writeFile(path.join(dir, "design-system-offers.json"), '{"version":1,"offered":{}}');
  await fs.writeFile(path.join(dir, "design-system-offers.json.key"), "secret");
  await fs.writeFile(path.join(dir, "design-md-offers.json"), "{}");
  await fs.writeFile(path.join(dir, "design-md-offers.json.key"), "kept");
  await fs.mkdir(path.join(dir, "design-system-offers.json.d"));

  assert.deepEqual(await cleanUpRetiredDesignSystemOffers(dir), []);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["design-md-offers.json", "design-md-offers.json.key", "design-system-offers.json.d"]);
  assert.equal(await fs.readFile(path.join(dir, "design-md-offers.json.key"), "utf8"), "kept");

  // Again, with nothing left to remove.
  assert.deepEqual(await cleanUpRetiredDesignSystemOffers(dir), []);
});

test("a failed removal is reported and the other file still goes; it never rejects", async (t) => {
  const dir = await userData(t);
  await fs.writeFile(path.join(dir, "design-system-offers.json.key"), "secret");
  const failures: string[] = [];
  const failed = await cleanUpRetiredDesignSystemOffers(dir, {
    removeFile: async (filePath) => {
      if (filePath.endsWith(".json")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await fs.rm(filePath, { force: true });
    },
    onFailure: (file) => failures.push(file),
  });
  assert.deepEqual(failed, ["design-system-offers.json"]);
  assert.deepEqual(failures, ["design-system-offers.json"]);
  assert.deepEqual(await fs.readdir(dir), []);
});
