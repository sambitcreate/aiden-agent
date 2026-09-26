/* global Buffer, process */
/**
 * Shared helpers for the four Aiden native binaries (worktree-remover,
 * subagent-run-store, subagent-shell-runner, subagent-file-mutator):
 * platform/arch target naming and cheap binary-architecture verification so a
 * prebuilt directory can never silently install the wrong architecture.
 */

import { openSync, readSync, closeSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const NATIVE_HELPERS = [
  "worktree-remover",
  "subagent-run-store",
  "subagent-shell-runner",
  "subagent-file-mutator",
];

/** Directory name for a platform's prebuilt helpers. macOS builds are universal. */
export function nativeHelperTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") return "darwin-universal";
  if (platform === "linux") return `linux-${arch}`;
  return undefined;
}

const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7 };
const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c };
// Mach-O magics: thin 64-bit little-endian, plus universal/fat (BE).
const MACHO_MAGIC_64_LE = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

function header(file, length) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function isElfForArch(file, arch) {
  const bytes = header(file, 20);
  if (bytes.readUInt32BE(0) !== 0x7f454c46) return false; // \x7fELF
  return bytes.readUInt16LE(18) === ELF_MACHINE[arch];
}

/**
 * A fat/universal binary only counts for the host when it actually contains a
 * slice for the host cputype — an x86_64-only fat binary must not "verify" on
 * arm64 (and vice versa). Fat headers are big-endian: nfat_arch at offset 4,
 * then 20-byte (fat) or 32-byte (fat64) fat_arch entries with cputype first.
 */
function isMachOForHost(file, arch) {
  const expected = MACHO_CPU[arch];
  if (expected === undefined) return false;
  const bytes = header(file, 8);
  const magicBE = bytes.readUInt32BE(0);
  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const entrySize = magicBE === FAT_MAGIC_64 ? 32 : 20;
    const count = Math.min(bytes.readUInt32BE(4), 64);
    const sliceBytes = header(file, 8 + count * entrySize);
    for (let index = 0; index < count; index += 1) {
      if (sliceBytes.readUInt32BE(8 + index * entrySize) === expected) return true;
    }
    return false;
  }
  // Thin Mach-O is stored little-endian on every supported host; the magic
  // value itself is endian-swapped when read BE, so compare LE directly.
  if (bytes.readUInt32LE(0) !== MACHO_MAGIC_64_LE) return false;
  return bytes.readUInt32LE(4) === expected;
}

/** True when `file` is a native executable matching the host platform/arch. */
export function verifyNativeHelper(file, platform = process.platform, arch = process.arch) {
  try {
    if (platform === "darwin") return isMachOForHost(file, arch);
    if (platform === "linux") return isElfForArch(file, arch);
    return false;
  } catch {
    return false;
  }
}

/**
 * sha256 over a helper's C sources — recorded in the prebuilt manifest so the
 * installer can detect a stale binary whose sources changed after the build.
 */
export function nativeHelperSourceHash(repositoryRoot, helper) {
  const hash = createHash("sha256");
  const add = (directory, pattern, prefix) => {
    let names;
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (error?.code === "ENOENT" && prefix) return;
      throw error;
    }
    for (const name of names.filter((entry) => pattern.test(entry)).sort()) {
      hash.update(`${prefix}${name}`);
      hash.update("\0");
      hash.update(readFileSync(join(directory, name)));
      hash.update("\0");
    }
  };
  add(join(repositoryRoot, "native", helper), /\.(?:c|h)$/u, "");
  // Helpers include ../shared/*.h, so a shared header edit must also mark
  // every prebuilt stale.
  add(join(repositoryRoot, "native", "shared"), /\.h$/u, "shared/");
  return hash.digest("hex");
}

/** sha256 of an installed helper binary, for manifest verification. */
export function nativeHelperFileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
