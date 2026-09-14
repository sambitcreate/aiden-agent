/* global Buffer */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_HELPERS,
  nativeHelperFileHash,
  nativeHelperSourceHash,
  nativeHelperTarget,
  verifyNativeHelper,
} from "./native-helpers.mjs";

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
    // Real thin Mach-O stores its magic little-endian: CF FA ED FE on disk.
    const thin = path.join(dir, "thin-arm64");
    const bytes = Buffer.alloc(20);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
    writeFileSync(thin, bytes);
    assert.equal(verifyNativeHelper(thin, "darwin", "arm64"), true);
    assert.equal(verifyNativeHelper(thin, "darwin", "x64"), false);
    // 32-bit thin magic never verifies — helpers are 64-bit only.
    const thin32 = path.join(dir, "thin-32");
    const bytes32 = Buffer.alloc(20);
    bytes32.writeUInt32LE(0xfeedface, 0);
    bytes32.writeUInt32LE(0x0100000c, 4);
    writeFileSync(thin32, bytes32);
    assert.equal(verifyNativeHelper(thin32, "darwin", "arm64"), false);
    // A universal binary must actually carry a slice for the host arch.
    const fat = Buffer.alloc(8 + 2 * 20);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4); // nfat_arch
    fat.writeUInt32BE(0x01000007, 8); // slice 1: x86_64
    fat.writeUInt32BE(0x0100000c, 28); // slice 2: arm64
    const fatFile = path.join(dir, "fat");
    writeFileSync(fatFile, fat);
    assert.equal(verifyNativeHelper(fatFile, "darwin", "x64"), true);
    assert.equal(verifyNativeHelper(fatFile, "darwin", "arm64"), true);
    const x64Only = Buffer.alloc(8 + 20);
    x64Only.writeUInt32BE(0xcafebabe, 0);
    x64Only.writeUInt32BE(1, 4);
    x64Only.writeUInt32BE(0x01000007, 8);
    const x64OnlyFile = path.join(dir, "fat-x64-only");
    writeFileSync(x64OnlyFile, x64Only);
    assert.equal(verifyNativeHelper(x64OnlyFile, "darwin", "x64"), true);
    assert.equal(verifyNativeHelper(x64OnlyFile, "darwin", "arm64"), false);
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
      // Manifest checksum must match the shipped bytes, and the recorded
      // source hash must match the current sources (staleness detection).
      assert.equal(nativeHelperFileHash(file), manifest.helpers?.[helper]?.sha256, `${target}/aiden-${helper} checksum mismatch`);
      assert.equal(nativeHelperSourceHash(repositoryRoot, helper), manifest.helpers?.[helper]?.source, `${target}/aiden-${helper} source hash mismatch`);
      // Executable bit must survive into the bundle.
      assert.notEqual(statSync(file).mode & 0o111, 0, `${target}/aiden-${helper} is not executable`);
    }
  }
});
