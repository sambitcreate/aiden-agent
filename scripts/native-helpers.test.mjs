/* global Buffer */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HELPERS, nativeHelperTarget, verifyNativeHelper } from "./native-helpers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "aiden-native-helpers-"));
}

function writeElf(file, machine, { badMagic = false } = {}) {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt32BE(badMagic ? 0x0badf00d : 0x7f454c46, 0);
  bytes.writeUInt16LE(machine, 18);
  writeFileSync(file, bytes);
}

test("nativeHelperTarget names darwin-universal, linux-<arch>, nothing else", () => {
  assert.equal(nativeHelperTarget("darwin", "x64"), "darwin-universal");
  assert.equal(nativeHelperTarget("darwin", "arm64"), "darwin-universal");
  assert.equal(nativeHelperTarget("linux", "x64"), "linux-x64");
  assert.equal(nativeHelperTarget("linux", "arm64"), "linux-arm64");
  assert.equal(nativeHelperTarget("win32", "x64"), undefined);
});

test("verifyNativeHelper checks ELF machine on linux", () => {
  const dir = scratch();
  try {
    const x64 = path.join(dir, "x64");
    const arm64 = path.join(dir, "arm64");
    writeElf(x64, 0x3e);
    writeElf(arm64, 0xb7);
    assert.equal(verifyNativeHelper(x64, "linux", "x64"), true);
    assert.equal(verifyNativeHelper(x64, "linux", "arm64"), false);
    assert.equal(verifyNativeHelper(arm64, "linux", "arm64"), true);
    assert.equal(verifyNativeHelper(arm64, "linux", "x64"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyNativeHelper rejects non-ELF on linux and unreadable files", () => {
  const dir = scratch();
  try {
    const bogus = path.join(dir, "bogus");
    writeElf(bogus, 0x3e, { badMagic: true });
    assert.equal(verifyNativeHelper(bogus, "linux", "x64"), false);
    assert.equal(verifyNativeHelper(path.join(dir, "missing"), "linux", "x64"), false);
    // Unsupported platform never verifies anything.
    assert.equal(verifyNativeHelper(bogus, "win32", "x64"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyNativeHelper accepts the Mach-O shape on darwin", () => {
  const dir = scratch();
  try {
    const thin = path.join(dir, "thin-arm64");
    const bytes = Buffer.alloc(20);
    bytes.writeUInt32BE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
    writeFileSync(thin, bytes);
    assert.equal(verifyNativeHelper(thin, "darwin", "arm64"), true);
    assert.equal(verifyNativeHelper(thin, "darwin", "x64"), false);
    const fat = path.join(dir, "fat");
    bytes.writeUInt32BE(0xcafebabe, 0);
    writeFileSync(fat, bytes);
    assert.equal(verifyNativeHelper(fat, "darwin", "x64"), true);
    assert.equal(verifyNativeHelper(fat, "darwin", "arm64"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checked-in prebuilt trees carry all helpers, executable bits, and a matching manifest", () => {
  const prebuiltRoot = path.join(repositoryRoot, "prebuilt", "native");
  for (const target of ["darwin-universal", "linux-x64", "linux-arm64"]) {
    const dir = path.join(prebuiltRoot, target);
    const manifestPath = path.join(dir, "manifest.json");
    assert.ok(existsSync(manifestPath), `${target} missing manifest.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.target, target);
    for (const helper of NATIVE_HELPERS) {
      const file = path.join(dir, `aiden-${helper}`);
      assert.ok(existsSync(file), `${target} missing aiden-${helper}`);
      assert.ok((readFileSync(file).readUInt32BE(0) >>> 0) !== 0, `${helper} is empty`);
      // Manifest checksum must match the shipped bytes.
      const sha = manifest.helpers?.[helper]?.sha256;
      assert.ok(sha, `${target} manifest missing sha256 for ${helper}`);
      // Executable bit must survive into the bundle.
      assert.notEqual(statSync(file).mode & 0o111, 0, `${target}/aiden-${helper} is not executable`);
    }
  }
});
