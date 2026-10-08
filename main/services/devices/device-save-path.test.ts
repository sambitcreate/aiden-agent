import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import type { PathLike } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDeviceSavePath, writeDeviceSaveFile } from "./device-save-path.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function roots() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "aiden-save-path-")));
  const workspace = path.join(base, "workspace");
  const downloads = path.join(base, "Downloads");
  const outside = path.join(base, "outside");
  await Promise.all([workspace, downloads, outside].map((dir) => mkdir(dir, { recursive: true })));
  return { base, workspace, downloads, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("relative paths land in the workspace; absolute paths may name the workspace or Downloads", async () => {
  const dirs = await roots();
  try {
    const allowed = { workspace: dirs.workspace, downloads: dirs.downloads };
    assert.equal(
      resolveDeviceSavePath("shots/home.png", allowed, "default.png"),
      path.join(dirs.workspace, "shots", "home.png"),
    );
    assert.equal(
      resolveDeviceSavePath(path.join(dirs.downloads, "a.PNG"), allowed, "default.png"),
      path.join(dirs.downloads, "a.PNG"),
    );
    // A folder gets the default file name.
    assert.equal(resolveDeviceSavePath("shots/", allowed, "iPhone-1.png"), path.join(dirs.workspace, "shots", "iPhone-1.png"));
    assert.equal(resolveDeviceSavePath(dirs.downloads, allowed, "iPhone-1.png"), path.join(dirs.downloads, "iPhone-1.png"));
  } finally {
    await dirs.cleanup();
  }
});

test("traversal, other folders, other file types, and control characters are refused", async () => {
  const dirs = await roots();
  try {
    const allowed = { workspace: dirs.workspace, downloads: dirs.downloads };
    for (const bad of [
      "../outside/x.png",
      "shots/../../outside/x.png",
      path.join(dirs.outside, "x.png"),
      path.join(dirs.downloads, "..", "outside", "x.png"),
      "/etc/x.png",
      "notes.txt",
      "evil\n.png",
      "",
      42,
    ]) {
      assert.throws(() => resolveDeviceSavePath(bad, allowed, "d.png"), /save path|PNG|Use an absolute/u, String(bad));
    }
    // Without a workspace, only an absolute Downloads path works.
    assert.throws(() => resolveDeviceSavePath("x.png", { downloads: dirs.downloads }, "d.png"), /absolute path/u);
    assert.throws(() => resolveDeviceSavePath("/x.png", {}, "d.png"), /cannot be saved/u);
    // A sibling that merely shares the root's name as a prefix is outside it.
    assert.throws(() => resolveDeviceSavePath(`${dirs.workspace}.png`, allowed, "d.png"), /outside/u);
  } finally {
    await dirs.cleanup();
  }
});

test("writing creates folders inside the root and refuses symlinks that lead out", async () => {
  const dirs = await roots();
  try {
    const allowed = { workspace: dirs.workspace, downloads: dirs.downloads };
    const file = resolveDeviceSavePath("deep/er/shot.png", allowed, "d.png");
    const written = await writeDeviceSaveFile(file, allowed, PNG);
    assert.deepEqual(new Uint8Array(await readFile(written)), PNG);

    // A folder link inside the workspace that points outside it.
    await symlink(dirs.outside, path.join(dirs.workspace, "escape"));
    const escaping = resolveDeviceSavePath("escape/new/shot.png", allowed, "d.png");
    await assert.rejects(writeDeviceSaveFile(escaping, allowed, PNG), /leads outside/u);
    await assert.rejects(readFile(path.join(dirs.outside, "new", "shot.png")), /ENOENT/u, "nothing is created outside");

    // A file link inside the workspace is never followed.
    await writeFile(path.join(dirs.outside, "target.png"), "keep");
    await symlink(path.join(dirs.outside, "target.png"), path.join(dirs.workspace, "link.png"));
    await assert.rejects(
      writeDeviceSaveFile(resolveDeviceSavePath("link.png", allowed, "d.png"), allowed, PNG),
      /is a link/u,
    );
    assert.equal(await readFile(path.join(dirs.outside, "target.png"), "utf8"), "keep");
  } finally {
    await dirs.cleanup();
  }
});

test("a link swapped in for a missing folder while writing creates nothing outside the root", async () => {
  const dirs = await roots();
  const original = fsPromises.mkdir;
  const swapped = path.join(dirs.workspace, "a");
  try {
    const allowed = { workspace: dirs.workspace, downloads: dirs.downloads };
    const file = resolveDeviceSavePath("a/b/c/shot.png", allowed, "d.png");
    // Another process replaces the missing `a` with a link out of the workspace
    // after the path was checked, just before the folder is created.
    const racing = (async (folder: PathLike, options?: unknown) => {
      if (String(folder).startsWith(swapped)) await symlink(dirs.outside, swapped).catch(() => undefined);
      return original(folder, options as never);
    }) as typeof fsPromises.mkdir;
    fsPromises.mkdir = racing;
    syncBuiltinESMExports();
    await assert.rejects(writeDeviceSaveFile(file, allowed, PNG), /leads outside/u);
    assert.deepEqual(await readdir(dirs.outside), [], "no stray folder was created outside the workspace");

    // A link that stays inside the workspace is refused too: no folder below the root may be a link.
    await rm(swapped);
    await mkdir(path.join(dirs.workspace, "real"));
    await symlink(path.join(dirs.workspace, "real"), swapped);
    await assert.rejects(writeDeviceSaveFile(file, allowed, PNG), /through a link/u);
    assert.deepEqual(await readdir(path.join(dirs.workspace, "real")), []);
  } finally {
    fsPromises.mkdir = original;
    syncBuiltinESMExports();
    await dirs.cleanup();
  }
});
