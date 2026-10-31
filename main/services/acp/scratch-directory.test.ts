import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAcpScratchDirectories } from "./scratch-directory.js";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("a deleted chat's scratch directory is removed and other chats keep theirs", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "aiden-acp-scratch-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const scratch = createAcpScratchDirectories({ root: () => join(base, "scratch") });

  const deleted = await scratch.directoryFor("chat-a");
  const kept = await scratch.directoryFor("chat-b");
  await writeFile(join(deleted, "agent-notes.txt"), "left by the agent");
  assert.equal((await stat(deleted)).mode & 0o777, 0o700);

  await scratch.forget("chat-a");

  assert.equal(await exists(deleted), false);
  assert.equal(await exists(kept), true);
});

test("a fallback directory used when the scratch root is unusable is removed with its chat", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "aiden-acp-scratch-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // A file where the root should be makes every per-chat mkdir fail.
  const blockedRoot = join(base, "scratch");
  await writeFile(blockedRoot, "not a directory");
  const tempRoot = join(base, "tmp");
  await mkdir(tempRoot);
  const errors: unknown[] = [];
  const scratch = createAcpScratchDirectories({
    root: () => blockedRoot,
    tempRoot: () => tempRoot,
    onPrepareError: (error) => errors.push(error),
  });

  const first = await scratch.directoryFor("chat-a");
  assert.equal(await scratch.directoryFor("chat-a"), first, "the chat reuses one private fallback");
  assert.notEqual(first, tempRoot);
  const other = await scratch.directoryFor("chat-b");
  assert.equal(errors.length, 3);

  await scratch.forget("chat-a");

  assert.equal(await exists(first), false);
  assert.equal(await exists(other), true);
  assert.equal(await exists(tempRoot), true);
  const next = await scratch.directoryFor("chat-a");
  assert.notEqual(next, first, "a later turn gets a fresh fallback, not a stale path");
});

test("forgetting a chat never removes the shared temp folder its fallback degraded to", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "aiden-acp-scratch-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const blockedRoot = join(base, "scratch");
  await writeFile(blockedRoot, "not a directory");
  // A missing temp root makes mkdtemp fail too, so the fallback is the temp root itself.
  const sharedTemp = join(base, "missing-tmp");
  const scratch = createAcpScratchDirectories({ root: () => blockedRoot, tempRoot: () => sharedTemp });

  assert.equal(await scratch.directoryFor("chat-a"), sharedTemp);
  await mkdir(sharedTemp);
  await writeFile(join(sharedTemp, "someone-else.txt"), "shared");

  await scratch.forget("chat-a");

  assert.deepEqual(await readdir(sharedTemp), ["someone-else.txt"]);
});
