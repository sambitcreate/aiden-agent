import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createScratchWorkspaceDirectory,
  generateScratchWorkspaceName,
} from "./scratch-workspace.js";

test("generates a three-word name using only three- or four-letter words", () => {
  const name = generateScratchWorkspaceName(() => 0);
  assert.equal(name, "day-game-run");
  assert.match(name, /^[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}$/);
});

test("creates a unique directory without reusing an existing name", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-scratch-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "day-game-run"));

  let calls = 0;
  const created = await createScratchWorkspaceDirectory(root, () => Math.floor(calls++ / 3));

  assert.equal(created.name, "calm-code-make");
  assert.equal(created.folderPath, path.join(root, "calm-code-make"));
  assert.equal((await fs.stat(created.folderPath)).isDirectory(), true);
});
