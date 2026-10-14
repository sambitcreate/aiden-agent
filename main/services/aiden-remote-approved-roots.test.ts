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

// The approval records live on the same volume as the temporary folders.
const approvalStore = os.tmpdir();

test("an approved root on the approval-store volume survives a remount that renumbers it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-approved-root-"));
  try {
    const stored = await storedRoot(directory);
    // macOS assigns APFS st_dev at mount time, so a reboot changes it while the
    // folder, its path, and its inode stay the same.
    const remounted = { ...stored, device: (stored.liveDevice + 3n).toString() };
    assert.deepEqual(await verifyApprovedRootIdentity(remounted, approvalStore), {
      root: stored.folderPath,
      device: stored.liveDevice.toString(),
      inode: stored.inode,
    });
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("an approved root fails closed when its folder, path, or volume is replaced", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-approved-root-"));
  try {
    const stored = await storedRoot(directory);
    const renumbered = { ...stored, device: (stored.liveDevice + 3n).toString() };
    assert.equal(
      await verifyApprovedRootIdentity({ ...stored, inode: (BigInt(stored.inode) + 1n).toString() }, approvalStore),
      null,
    );

    const alias = `${directory}-alias`;
    await fs.symlink(stored.folderPath, alias);
    try {
      assert.equal(await verifyApprovedRootIdentity({ ...stored, folderPath: alias }, approvalStore), null);
    } finally {
      await fs.rm(alias, { force: true });
    }

    // A folder on another volume (an external drive, a disk image) keeps the
    // exact device check: a replacement volume can present the same path and
    // inode without touching the approval records.
    const live = await fs.stat(stored.folderPath, { bigint: true });
    const otherVolume = {
      realpath: fs.realpath,
      stat: async (target: string) =>
        target === approvalStore ? { ...live, dev: live.dev + 1n } : fs.stat(target, { bigint: true }),
    };
    assert.equal(await verifyApprovedRootIdentity(renumbered, approvalStore, otherVolume), null);
    assert.notEqual(await verifyApprovedRootIdentity(stored, approvalStore, otherVolume), null);

    await fs.rm(directory, { force: true, recursive: true });
    assert.equal(await verifyApprovedRootIdentity(stored, approvalStore), null);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});
