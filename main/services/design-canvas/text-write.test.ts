import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { replaceWorkspaceText } from "./text-write.js";

const ORIGINAL = "<h1>Ship faster</h1>";

async function page(t: test.TestContext, mode: number): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-text-write-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "hero.html");
  await fs.writeFile(file, ORIGINAL);
  await fs.chmod(file, mode);
  return file;
}

test("a word edit keeps the page's own permissions", async (t) => {
  const file = await page(t, 0o640);
  assert.equal(await replaceWorkspaceText(file, "<h1>Ship sooner</h1>", ORIGINAL), "written");
  assert.equal(await fs.readFile(file, "utf8"), "<h1>Ship sooner</h1>");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
});

test("an edit already in place counts as written when the flush after it fails", async (t) => {
  const file = await page(t, 0o644);
  const result = await replaceWorkspaceText(file, "<h1>Ship sooner</h1>", ORIGINAL, {
    syncDirectory: async () => {
      throw new Error("EIO");
    },
  });
  assert.equal(result, "written");
  assert.equal(await fs.readFile(file, "utf8"), "<h1>Ship sooner</h1>");
});

test("an edit that never reached the file is reported as failed and leaves it as it was", async (t) => {
  const file = await page(t, 0o644);
  const result = await replaceWorkspaceText(file, "<h1>Ship sooner</h1>", ORIGINAL, {
    rename: async () => {
      throw new Error("EXDEV");
    },
  });
  assert.equal(result, "failed");
  assert.equal(await fs.readFile(file, "utf8"), "<h1>Ship faster</h1>");
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["hero.html"], "no staged file is left behind");
});

test("a change another writer makes while the edit is being saved is kept, and the edit says so", async (t) => {
  const file = await page(t, 0o644);
  const result = await replaceWorkspaceText(file, "<h1>Ship sooner</h1>", ORIGINAL, {
    // Aiden or an editor saves the page after the edit was planned, just before it goes in.
    syncFile: async () => {
      await fs.writeFile(file, "<h1>Ship today</h1>");
    },
  });
  assert.equal(result, "changed");
  assert.equal(await fs.readFile(file, "utf8"), "<h1>Ship today</h1>");
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["hero.html"]);
});
