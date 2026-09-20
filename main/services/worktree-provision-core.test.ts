import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyProvisionedFiles,
  estimateProvisionedBytes,
  parseLsFilesZero,
  removeProvisionedFiles,
  resolveWorktreeInclude,
  selectProvisionedFiles,
  WORKTREE_PROVISION_MAX_FILE_BYTES,
  WorktreeProvisionError,
} from "./worktree-provision-core.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-provision-"));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("selectProvisionedFiles keeps only ignored files matched by .worktreeinclude", () => {
  // `git ls-files --others --exclude-from=<include>` lists untracked files NOT
  // matched by the include file; membership in all ∖ visible means "matched".
  const all = [".env.local", ".env", "notes.txt", "fixtures/a.bin", "generated/x"];
  const includeVisible = ["notes.txt"]; // everything else in `all` matched the include
  const ignored = [".env.local", ".env", "generated/x", "other.bin"];
  assert.deepEqual(selectProvisionedFiles(all, includeVisible, ignored), [
    ".env",
    ".env.local",
    "generated/x",
  ]);
});

test("selectProvisionedFiles drops escaping entries and enforces the file bound", () => {
  assert.deepEqual(
    selectProvisionedFiles(["../escape", "abs/../ok", ".env"], [], ["../escape", ".env"]),
    [".env"],
  );
  const many = Array.from({ length: 600 }, (_, i) => `f${i}.bin`);
  assert.throws(
    () => selectProvisionedFiles(many, [], many),
    (error: unknown) =>
      error instanceof WorktreeProvisionError && error.failure === "exceeded",
  );
});

test("parseLsFilesZero splits NUL-separated output", () => {
  assert.deepEqual(parseLsFilesZero("a\u0000b\u0000"), ["a", "b"]);
  assert.deepEqual(parseLsFilesZero(""), []);
});

test("resolveWorktreeInclude requires a regular in-repo file", async (t) => {
  const repository = await temporaryDirectory(t);
  assert.equal(await resolveWorktreeInclude(repository), null);

  const include = path.join(repository, ".worktreeinclude");
  await fs.mkdir(include);
  assert.equal(await resolveWorktreeInclude(repository), null);
  await fs.rmdir(include);

  const outside = await temporaryDirectory(t);
  const target = path.join(outside, "include");
  await fs.writeFile(target, ".env\n");
  await fs.symlink(target, include);
  assert.equal(await resolveWorktreeInclude(repository), null);
  await fs.rm(include);

  await fs.writeFile(include, ".env\n");
  assert.equal(await resolveWorktreeInclude(repository), include);
});

test("copyProvisionedFiles copies modes, skips symlinks, and never overwrites", async (t) => {
  const source = await temporaryDirectory(t);
  const worktree = await temporaryDirectory(t);
  await fs.writeFile(path.join(source, ".env"), "KEY=1\n", { mode: 0o600 });
  await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await fs.symlink(".env", path.join(source, ".env.link"));

  const manifest = await copyProvisionedFiles(source, worktree, [
    ".env",
    "run.sh",
    ".env.link",
    "gone",
  ]);
  assert.deepEqual(manifest, [
    { relativePath: ".env", mode: 0o600 },
    { relativePath: "run.sh", mode: 0o755 },
  ]);
  assert.equal(await fs.readFile(path.join(worktree, ".env"), "utf8"), "KEY=1\n");
  assert.equal((await fs.stat(path.join(worktree, ".env"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(worktree, "run.sh"))).mode & 0o777, 0o755);
  await assert.rejects(fs.lstat(path.join(worktree, ".env.link")));

  // A second provisioning run refuses to overwrite.
  await assert.rejects(copyProvisionedFiles(source, worktree, [".env"]), WorktreeProvisionError);
});

test("copyProvisionedFiles refuses destinations escaping through symlinked parents", async (t) => {
  const source = await temporaryDirectory(t);
  const worktree = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  await fs.mkdir(path.join(source, "sub"));
  await fs.writeFile(path.join(source, "sub", "secret"), "token\n");
  // The worktree's `sub/` is a symlink outside the checkout — the destination
  // realpath check must catch it rather than write through.
  await fs.symlink(outside, path.join(worktree, "sub"));
  await assert.rejects(
    copyProvisionedFiles(source, worktree, ["sub/secret"]),
    (error: unknown) => error instanceof WorktreeProvisionError,
  );
  await assert.rejects(fs.stat(path.join(outside, "secret")));
});

test("copyProvisionedFiles removes partial copies when a later file fails", async (t) => {
  const source = await temporaryDirectory(t);
  const worktree = await temporaryDirectory(t);
  await fs.writeFile(path.join(source, "ok"), "fine\n");
  await fs.writeFile(path.join(source, "first"), "1\n");
  // `existing` already lives in the worktree, so the EXCL copy fails after
  // `ok` and `first` were written — those copies must be removed again.
  await fs.writeFile(path.join(worktree, "existing"), "original\n");
  await fs.writeFile(path.join(source, "existing"), "new\n");
  await assert.rejects(
    copyProvisionedFiles(source, worktree, ["ok", "first", "existing"]),
    WorktreeProvisionError,
  );
  assert.equal(await fs.readFile(path.join(worktree, "existing"), "utf8"), "original\n");
  await assert.rejects(fs.stat(path.join(worktree, "ok")));
  await assert.rejects(fs.stat(path.join(worktree, "first")));
});

test("estimateProvisionedBytes bounds the provisioning byte budget", async (t) => {
  const source = await temporaryDirectory(t);
  await fs.writeFile(path.join(source, "a"), "1234");
  await fs.writeFile(path.join(source, "b"), "123456");
  await fs.symlink("a", path.join(source, "link"));
  assert.equal(await estimateProvisionedBytes(source, ["a", "b", "link", "gone"]), 10);
  await assert.rejects(
    estimateProvisionedBytes(source, ["../outside"]),
    (error: unknown) =>
      error instanceof WorktreeProvisionError && error.failure === "invalid",
  );
});

test("estimateProvisionedBytes fails files past the per-file budget", async (t) => {
  const source = await temporaryDirectory(t);
  const handle = await fs.open(path.join(source, "huge"), "w");
  try {
    await handle.truncate(WORKTREE_PROVISION_MAX_FILE_BYTES + 1);
  } finally {
    await handle.close();
  }
  await assert.rejects(
    copyProvisionedFiles(source, await temporaryDirectory(t), ["huge"]),
    (error: unknown) =>
      error instanceof WorktreeProvisionError && error.failure === "exceeded",
  );
});

test("removeProvisionedFiles deletes only recorded manifest entries", async (t) => {
  const worktree = await temporaryDirectory(t);
  await fs.writeFile(path.join(worktree, ".env"), "KEY=1\n");
  await fs.writeFile(path.join(worktree, "user-file"), "keep\n");
  await removeProvisionedFiles(worktree, [
    { relativePath: ".env", mode: 0o600 },
    { relativePath: "../escape", mode: 0o600 },
  ]);
  await assert.rejects(fs.stat(path.join(worktree, ".env")));
  assert.equal(await fs.readFile(path.join(worktree, "user-file"), "utf8"), "keep\n");
});
