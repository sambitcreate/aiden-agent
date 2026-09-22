import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import type { AidenRemoteApprovedRoot } from "./aiden-remote-state.js";

async function fixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-browser-test-"));
  const rootDirectory = path.join(temporary, "Approved");
  const outsideDirectory = path.join(temporary, "Outside");
  await fs.mkdir(rootDirectory);
  await fs.mkdir(outsideDirectory);
  const rootPath = await fs.realpath(rootDirectory);
  const outside = await fs.realpath(outsideDirectory);
  await fs.mkdir(path.join(rootPath, "Alpha"));
  await fs.mkdir(path.join(rootPath, "Beta"));
  await fs.mkdir(path.join(rootPath, ".Hidden"));
  await fs.mkdir(path.join(rootPath, "Library"));
  await fs.writeFile(path.join(rootPath, "file.txt"), "not a directory");
  await fs.symlink(outside, path.join(rootPath, "Escape"));
  const identity = await fs.stat(rootPath, { bigint: true });
  const root: AidenRemoteApprovedRoot = {
    id: "root-1",
    label: "Projects",
    folderPath: rootPath,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    policyRevision: "remote-browser-v1:no-hidden-system",
    createdAt: 1,
  };
  let approvedRoots = [root];
  let now = 1_000;
  const service = new AidenRemoteWorkspaceBrowserService({
    instanceId: "instance-1",
    state: {
      snapshot: async () => ({ approvedRoots }) as never,
    },
    now: () => now,
  });
  return {
    service,
    root,
    rootPath,
    setRoots: (value: AidenRemoteApprovedRoot[]) => { approvedRoots = value; },
    advance: (milliseconds: number) => { now += milliseconds; },
    cleanup: () => fs.rm(temporary, { recursive: true, force: true }),
  };
}

test("approved-root browsing exposes only opaque directory entries and consumes selections once", async () => {
  const app = await fixture();
  try {
    const roots = await app.service.listRoots("device-1");
    assert.equal(roots.roots.length, 1);
    assert.match(roots.roots[0]!.location, /^loc_[A-Za-z0-9_-]{43}$/u);
    assert.equal(JSON.stringify(roots).includes(app.rootPath), false);

    const page = await app.service.listChildren(
      "device-1",
      roots.roots[0]!.location,
    );
    assert.deepEqual(page.entries.map((entry) => entry.name), ["Alpha", "Beta"]);
    assert.equal(page.entries.every((entry) => /^loc_[A-Za-z0-9_-]{43}$/u.test(entry.location)), true);
    assert.equal(JSON.stringify(page).includes(app.rootPath), false);

    const selection = await app.service.createSelection(
      "device-1",
      page.entries[0]!.location,
    );
    const claims = await app.service.consumeSelection("device-1", selection.selection);
    assert.equal(claims.canonicalPath, path.join(app.rootPath, "Alpha"));
    await assert.rejects(
      app.service.consumeSelection("device-1", selection.selection),
      (error: unknown) => (error as { code?: string }).code === "handle_invalid",
    );
  } finally {
    await app.cleanup();
  }
});

test("browser handles are device-bound, expire, and fail closed after root-policy removal", async () => {
  const app = await fixture();
  try {
    const location = (await app.service.listRoots("device-1")).roots[0]!.location;
    await assert.rejects(
      app.service.listChildren("device-2", location),
      (error: unknown) => (error as { code?: string }).code === "handle_wrong_device",
    );

    const selection = await app.service.createSelection("device-1", location);
    const consumed = await app.service.consumeSelection("device-1", selection.selection);

    app.setRoots([]);
    await assert.rejects(
      app.service.listChildren("device-1", location),
      (error: unknown) => (error as { code?: string }).code === "root_policy_changed",
    );
    await assert.rejects(
      app.service.revalidateConsumedSelection("device-1", consumed),
      (error: unknown) => (error as { code?: string }).code === "root_policy_changed",
    );

    app.setRoots([app.root]);
    const expiring = (await app.service.listRoots("device-1")).roots[0]!.location;
    app.advance(10 * 60_000 + 1);
    await assert.rejects(
      app.service.listChildren("device-1", expiring),
      (error: unknown) => (error as { code?: string }).code === "handle_expired",
    );
  } finally {
    await app.cleanup();
  }
});

test("directory pagination binds cursors to the exact location and snapshot", async () => {
  const app = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        fs.mkdir(path.join(app.rootPath, `Paged-${String(index).padStart(3, "0")}`)),
      ),
    );
    const rootLocation = (await app.service.listRoots("device-1")).roots[0]!.location;
    const first = await app.service.listChildren("device-1", rootLocation);
    assert.equal(first.entries.length, 200);
    assert.match(first.nextCursor ?? "", /^cur_[A-Za-z0-9_-]{43}$/u);
    const second = await app.service.listChildren(
      "device-1",
      rootLocation,
      first.nextCursor,
    );
    assert.equal(second.entries.length, 7);

    await fs.mkdir(path.join(app.rootPath, "Snapshot-Changed"));
    await assert.rejects(
      app.service.listChildren("device-1", rootLocation, first.nextCursor),
      (error: unknown) => (error as { code?: string }).code === "filesystem_identity_changed",
    );
  } finally {
    await app.cleanup();
  }
});
