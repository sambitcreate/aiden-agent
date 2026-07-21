import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  cleanupStaleProfileShareDirectories,
  createProfileShareFile,
  PROFILE_SHARE_DIRECTORY_PREFIX,
  PROFILE_SHARE_FILE_NAME,
  PROFILE_SHARE_STALE_AGE_MS,
} from "./profile-share-files.js";

async function withTemporaryRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-profile-share-test-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("creates a private, uniquely named temporary PNG", async () => {
  await withTemporaryRoot(async (root) => {
    const image = Buffer.from("private aggregate image");
    const created = await createProfileShareFile(image, root);
    assert.equal(path.basename(created.filePath), PROFILE_SHARE_FILE_NAME);
    assert.ok(path.basename(created.directory).startsWith(PROFILE_SHARE_DIRECTORY_PREFIX));
    assert.deepEqual(await fs.readFile(created.filePath), image);
    assert.equal((await fs.stat(created.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(created.filePath)).mode & 0o777, 0o600);
  });
});

test("removes only stale, inactive Aiden share directories", async () => {
  await withTemporaryRoot(async (root) => {
    const now = Date.now();
    const stale = await fs.mkdtemp(path.join(root, PROFILE_SHARE_DIRECTORY_PREFIX));
    const active = await fs.mkdtemp(path.join(root, PROFILE_SHARE_DIRECTORY_PREFIX));
    const fresh = await fs.mkdtemp(path.join(root, PROFILE_SHARE_DIRECTORY_PREFIX));
    const unrelated = await fs.mkdtemp(path.join(root, "unrelated-"));
    const staleTime = new Date(now - PROFILE_SHARE_STALE_AGE_MS - 1_000);
    await fs.utimes(stale, staleTime, staleTime);
    await fs.utimes(active, staleTime, staleTime);

    assert.equal(
      await cleanupStaleProfileShareDirectories({
        temporaryRoot: root,
        activeDirectories: new Set([active]),
        now,
      }),
      1,
    );
    await assert.rejects(fs.stat(stale), { code: "ENOENT" });
    await fs.stat(active);
    await fs.stat(fresh);
    await fs.stat(unrelated);
  });
});
