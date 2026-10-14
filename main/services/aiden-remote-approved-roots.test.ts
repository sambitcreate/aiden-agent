import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AidenRemoteApprovedRootService,
  verifyApprovedRootIdentity,
} from "./aiden-remote-approved-roots.js";
import { AidenRemoteStateRegistry, createDefaultAidenRemoteState } from "./aiden-remote-state.js";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-approved-root-"));
  let document = createDefaultAidenRemoteState();
  const state = new AidenRemoteStateRegistry({
    load: async () => structuredClone(document),
    save: async (next) => { document = structuredClone(next); },
  });
  const service = new AidenRemoteApprovedRootService(state, {
    now: () => 12_345,
    randomBytes: (size) => Buffer.alloc(size, 3),
    homeDirectory: () => directory,
  });
  return { directory, state, service };
}

test("approved roots canonicalize symlinks and persist filesystem identity without exposing it remotely", async () => {
  const app = await fixture();
  try {
    const folder = path.join(app.directory, "Workspace");
    const alias = path.join(app.directory, "Alias");
    await fs.mkdir(folder);
    await fs.symlink(folder, alias);
    const root = await app.service.addLocalFolder(alias);
    assert.equal(root.folderPath, await fs.realpath(folder));
    assert.equal(root.label, "Workspace");
    assert.match(root.device, /^\d+$/u);
    assert.match(root.inode, /^\d+$/u);
    assert.equal(root.policyRevision, "remote-browser-v1:no-hidden-system");
  } finally {
    await fs.rm(app.directory, { force: true, recursive: true });
  }
});

test("approved roots reject duplicates, nested overlap, files, and filesystem root", async () => {
  const app = await fixture();
  try {
    const parent = path.join(app.directory, "parent");
    const child = path.join(parent, "child");
    const file = path.join(app.directory, "file.txt");
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(file, "x");
    await app.service.addLocalFolder(parent);
    await assert.rejects(app.service.addLocalFolder(parent), /already covered/u);
    await assert.rejects(app.service.addLocalFolder(child), /already covered/u);
    await assert.rejects(app.service.addLocalFolder(file), /must be a directory/u);
    await assert.rejects(app.service.addLocalFolder(path.parse(app.directory).root), /filesystem root/u);
  } finally {
    await fs.rm(app.directory, { force: true, recursive: true });
  }
});

test("approving an entire home folder requires a separate local confirmation", async () => {
  const app = await fixture();
  try {
    await assert.rejects(
      app.service.addLocalFolder(app.directory),
      /requires local confirmation/u,
    );
    const root = await app.service.addLocalFolder(app.directory, { confirmHomeDirectory: true });
    assert.equal(root.folderPath, await fs.realpath(app.directory));
    assert.equal(await app.service.removeLocalRoot(root.id), true);
  } finally {
    await fs.rm(app.directory, { force: true, recursive: true });
  }
});

async function storedRoot(directory: string) {
  const folderPath = await fs.realpath(directory);
  const live = await fs.stat(folderPath, { bigint: true });
  return { folderPath, device: live.dev.toString(), inode: live.ino.toString(), liveDevice: live.dev };
}

test("an approved root survives a remount that renumbers its volume", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-approved-root-"));
  try {
    const stored = await storedRoot(directory);
    // macOS assigns APFS st_dev at mount time, so a reboot changes it while the
    // folder, its path, and its inode stay the same.
    const remounted = { ...stored, device: (stored.liveDevice + 3n).toString() };
    assert.deepEqual(await verifyApprovedRootIdentity(remounted), {
      root: stored.folderPath,
      device: stored.liveDevice.toString(),
      inode: stored.inode,
    });
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("an approved root fails closed when its folder, path, or mounted volume is replaced", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-approved-root-"));
  try {
    const stored = await storedRoot(directory);
    assert.equal(
      await verifyApprovedRootIdentity({ ...stored, inode: (BigInt(stored.inode) + 1n).toString() }),
      null,
    );

    const alias = `${directory}-alias`;
    await fs.symlink(stored.folderPath, alias);
    try {
      assert.equal(await verifyApprovedRootIdentity({ ...stored, folderPath: alias }), null);
    } finally {
      await fs.rm(alias, { force: true });
    }

    // A folder that is itself a mount point keeps the exact device check: a
    // different volume mounted there can reuse the same root inode.
    const live = await fs.stat(stored.folderPath, { bigint: true });
    const mountPoint = {
      realpath: fs.realpath,
      stat: async (target: string) =>
        target === stored.folderPath ? live : { ...(await fs.stat(target, { bigint: true })), dev: live.dev + 1n },
    };
    const renumbered = { ...stored, device: (stored.liveDevice + 3n).toString() };
    assert.equal(await verifyApprovedRootIdentity(renumbered, mountPoint), null);
    assert.notEqual(await verifyApprovedRootIdentity(stored, mountPoint), null);

    await fs.rm(directory, { force: true, recursive: true });
    assert.equal(await verifyApprovedRootIdentity(stored), null);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});
