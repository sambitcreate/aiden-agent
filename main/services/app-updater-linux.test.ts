import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, statSync, realpathSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appImageIdentity, canUpdateLinuxAppImage, isRegularAppImage, replaceAppImageAtomically } from "./app-updater-linux.js";
import { shouldEnableAppUpdates } from "./app-updater-core.js";

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "aiden-appimage-update-")));
  const appDir = path.join(root, "mount");
  const resourcesPath = path.join(appDir, "resources");
  mkdirSync(resourcesPath, { recursive: true });
  const executablePath = path.join(appDir, "aiden-agent");
  const appImage = path.join(root, "Aiden.AppImage");
  writeFileSync(appImage, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2, 0]), { mode: 0o755 });
  writeFileSync(executablePath, "executable");
  writeFileSync(path.join(resourcesPath, "app-update.yml"), "provider: github\n");
  const runtime = { appImage, appDir, resourcesPath, executablePath, mountInfo: `1 0 0:1 / ${appDir} ro - fuse.Aiden Aiden ro`, uid: process.getuid?.() };
  return { root, runtime, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Linux updates require packaged production plus verified AppImage eligibility", () => {
  for (const isPackaged of [false, true]) for (const runtimeProfile of ["development", "production"] as const) for (const updateConfigExists of [false, true]) for (const linuxAppImageEligible of [false, true]) {
    assert.equal(shouldEnableAppUpdates({ platform: "linux", isPackaged, runtimeProfile, updateConfigExists, linuxAppImageEligible }), isPackaged && runtimeProfile === "production" && updateConfigExists && linuxAppImageEligible);
  }
});

test("mounted portable AppImage is eligible but extraction and distro packages are not", () => {
  const f = fixture();
  try {
    assert.equal(canUpdateLinuxAppImage(f.runtime), true);
    assert.equal(canUpdateLinuxAppImage({ ...f.runtime, mountInfo: "" }), false);
    assert.equal(canUpdateLinuxAppImage({ ...f.runtime, appImage: undefined }), false);
    assert.equal(canUpdateLinuxAppImage({ ...f.runtime, executablePath: process.execPath }), false);
    for (const type of ["deb", "rpm", "pacman", "unknown"]) {
      writeFileSync(path.join(f.runtime.resourcesPath, "package-type"), type);
      assert.equal(canUpdateLinuxAppImage(f.runtime), false);
    }
    writeFileSync(path.join(f.runtime.resourcesPath, "package-type"), "appimage");
    assert.equal(canUpdateLinuxAppImage(f.runtime), true);
  } finally { f.cleanup(); }
});

test("image and embedded metadata must remain regular and replacement-ready", () => {
  const f = fixture();
  try {
    const link = path.join(f.root, "linked.AppImage");
    symlinkSync(f.runtime.appImage, link);
    assert.equal(canUpdateLinuxAppImage({ ...f.runtime, appImage: link }), false);
    assert.equal(isRegularAppImage(link), false);
    assert.equal(canUpdateLinuxAppImage({ ...f.runtime, uid: (process.getuid?.() ?? 0) + 1 }), false);
    chmodSync(f.runtime.appImage, 0o555);
    assert.equal(canUpdateLinuxAppImage(f.runtime), false);
    chmodSync(f.runtime.appImage, 0o644);
    assert.equal(canUpdateLinuxAppImage(f.runtime), false);
    chmodSync(f.runtime.appImage, 0o755);
    writeFileSync(path.join(f.runtime.resourcesPath, "app-update.yml"), "");
    assert.equal(canUpdateLinuxAppImage(f.runtime), false);
    writeFileSync(path.join(f.runtime.resourcesPath, "app-update.yml"), "provider: github\n");
    writeFileSync(f.runtime.appImage, "ordinary executable");
    assert.equal(canUpdateLinuxAppImage(f.runtime), false);
  } finally { f.cleanup(); }
});

test("AppImage replacement verifies its digest and atomically preserves the current filename", () => {
  const f = fixture();
  try {
    const installer = path.join(f.root, "Aiden-9.9.9.AppImage");
    const next = Buffer.concat([readFileSync(f.runtime.appImage), Buffer.from("new-version")]);
    writeFileSync(installer, next);
    const original = appImageIdentity(f.runtime.appImage);
    const sha512 = createHash("sha512").update(next).digest("base64");
    assert.equal(replaceAppImageAtomically({ current: original, installer, sha512, eligible: () => canUpdateLinuxAppImage(f.runtime) }), original.path);
    assert.deepEqual(readFileSync(original.path), next);
    assert.equal(statSync(original.path).mode & 0o777, 0o755);
    assert.notEqual(statSync(original.path).ino, original.ino);
    assert.ok(readdirSync(f.root).every(name => !name.startsWith(".aiden-update-")));
  } finally { f.cleanup(); }
});

test("failed AppImage checksum and changed installation retain the original file and clean temporary data", () => {
  const f = fixture();
  try {
    const installer = path.join(f.root, "next.AppImage");
    const original = readFileSync(f.runtime.appImage);
    const next = Buffer.concat([original, Buffer.from("new-version")]);
    writeFileSync(installer, next);
    const identity = appImageIdentity(f.runtime.appImage);
    const sha512 = createHash("sha512").update(next).digest("base64");
    assert.throws(() => replaceAppImageAtomically({ current: identity, installer, sha512: createHash("sha512").update("wrong").digest("base64"), eligible: () => true }), /checksum/);
    assert.deepEqual(readFileSync(identity.path), original);
    let checks = 0;
    assert.throws(() => replaceAppImageAtomically({ current: identity, installer, sha512, eligible: () => ++checks === 1 }), /changed/);
    assert.deepEqual(readFileSync(identity.path), original);
    const moved = path.join(f.root, "replacement.AppImage");
    writeFileSync(moved, original);
    renameSync(moved, identity.path);
    assert.throws(() => replaceAppImageAtomically({ current: identity, installer, sha512, eligible: () => true }), /unavailable/);
    assert.deepEqual(readFileSync(identity.path), original);
    assert.ok(readdirSync(f.root).every(name => !name.startsWith(".aiden-update-")));
  } finally { f.cleanup(); }
});
