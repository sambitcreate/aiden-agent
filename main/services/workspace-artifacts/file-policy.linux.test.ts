import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWorkspaceArtifactFile } from "./file-policy.js";
import { readLinuxArtifactFile, LinuxArtifactFileChangedError } from "./linux-file-read.js";
import { captureManagedWorktreeRootIdentity } from "../managed-worktree-file-io.js";

const linuxOnly = { skip: process.platform !== "linux" };
async function fixture(t: test.TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-linux-artifact-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "workspace"); await fs.mkdir(root);
  await fs.mkdir(path.join(root, "selected")); await fs.mkdir(path.join(root, "selected", "nested"));
  await fs.writeFile(path.join(root, "selected", "nested", "data.txt"), "ordinary workspace data\n");
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_FIXTURE_VALUE");
  const file = await fs.stat(path.join(root, "selected", "nested", "data.txt"), { bigint: true });
  return { base, root, identity: { root: await captureManagedWorktreeRootIdentity(root), file: { device: String(file.dev), inode: String(file.ino) } } };
}

test("Linux artifact reads ordinary and empty files without the macOS native helper", linuxOnly, async (t) => {
  const { root } = await fixture(t);
  assert.equal(await readWorkspaceArtifactFile(root, "selected/nested/data.txt"), "ordinary workspace data\n");
  await fs.symlink("selected/nested/data.txt", path.join(root, "safe-alias.txt"));
  assert.equal(await readWorkspaceArtifactFile(root, "safe-alias.txt"), "ordinary workspace data\n");
  await fs.writeFile(path.join(root, "empty.txt"), "");
  assert.equal(await readWorkspaceArtifactFile(root, "empty.txt"), "");
  await fs.writeFile(path.join(root, ".env.example"), "TEMPLATE=");
  assert.equal(await readWorkspaceArtifactFile(root, ".env.example"), "TEMPLATE=");
});

test("Linux artifact reads reject lexical/canonical secret aliases and pre-open directory or file replacement", linuxOnly, async (t) => {
  const { root } = await fixture(t);
  await fs.symlink(".env", path.join(root, "ordinary.txt"));
  await assert.rejects(readWorkspaceArtifactFile(root, ".env"), /Credential files/u);
  await assert.rejects(readWorkspaceArtifactFile(root, "ordinary.txt"), /Credential files/u);
  await assert.rejects(readWorkspaceArtifactFile(root, "selected/nested/data.txt", undefined, {
    beforeRead: async () => {
      await fs.rename(path.join(root, "selected"), path.join(root, "held"));
      await fs.symlink("held", path.join(root, "selected"));
    },
  }), /Credential files/u);
  await fs.unlink(path.join(root, "selected")); await fs.rename(path.join(root, "held"), path.join(root, "selected"));
  await assert.rejects(readWorkspaceArtifactFile(root, "selected/nested/data.txt", undefined, {
    beforeRead: async () => {
      await fs.rename(path.join(root, "selected", "nested", "data.txt"), path.join(root, "original.txt"));
      await fs.writeFile(path.join(root, "selected", "nested", "data.txt"), "REPLACEMENT_FIXTURE_VALUE");
    },
  }), /Credential files/u);
});

test("Linux descriptor traversal retains the opened directory during an adversarial mid-walk swap", linuxOnly, async (t) => {
  const { base, root, identity } = await fixture(t);
  const outside = path.join(base, "outside"); await fs.mkdir(outside); await fs.mkdir(path.join(outside, "nested"));
  await fs.writeFile(path.join(outside, "nested", "data.txt"), "OUTSIDE_PRIVATE_VALUE");
  const content = await readLinuxArtifactFile(identity, "selected/nested/data.txt", undefined, {
    afterDirectoryOpen: async (relative) => {
      if (relative !== "selected") return;
      await fs.rename(path.join(root, "selected"), path.join(root, "displaced"));
      await fs.symlink(outside, path.join(root, "selected"));
    },
  });
  assert.equal(content.toString("utf8"), "ordinary workspace data\n");
});

test("Linux descriptor reads reject changed root identity, late hard links, oversized data and cancellation", linuxOnly, async (t) => {
  const { root, identity } = await fixture(t);
  await assert.rejects(readLinuxArtifactFile({ ...identity, root: { ...identity.root, inode: "0" } }, "selected/nested/data.txt"), LinuxArtifactFileChangedError);
  await assert.rejects(readLinuxArtifactFile(identity, "selected/nested/data.txt", undefined, {
    afterRead: async () => fs.link(path.join(root, "selected", "nested", "data.txt"), path.join(root, "extra-link")),
  }), LinuxArtifactFileChangedError);
  await fs.unlink(path.join(root, "extra-link"));
  await fs.writeFile(path.join(root, "selected", "nested", "data.txt"), Buffer.alloc(1_500_001, 65));
  await assert.rejects(readLinuxArtifactFile(identity, "selected/nested/data.txt"), /too large/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readLinuxArtifactFile(identity, "selected/nested/data.txt", controller.signal), { name: "AbortError" });
});
