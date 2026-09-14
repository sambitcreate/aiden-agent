/* global Buffer, process */
/**
 * Shared helpers for the four Aiden native binaries (worktree-remover,
 * subagent-run-store, subagent-shell-runner, subagent-file-mutator):
 * platform/arch target naming and cheap binary-architecture verification so a
 * prebuilt directory can never silently install the wrong architecture.
 */

import { openSync, readSync, closeSync } from "node:fs";

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

function isMachOForHost(file, arch) {
  const bytes = header(file, 20);
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) return true; // universal covers every arch
  if (magic !== 0xfeedface && magic !== 0xfeedfacf) return false;
  return bytes.readUInt32LE(4) === MACHO_CPU[arch];
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
