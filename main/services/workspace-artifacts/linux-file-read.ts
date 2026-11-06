/** Linux openat-style reads through /proc/self/fd, matching ACP's anchored creation strategy. */
import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { ConfinedWorkspaceFileIdentity } from "../managed-worktree-file-io.js";

const MAX_BYTES = 1_500_000;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

export class LinuxArtifactFileChangedError extends Error {
  constructor() { super("The artifact file could not be read safely."); }
}

function segments(value: string): string[] {
  const parts = value.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new LinuxArtifactFileChangedError();
  }
  return parts;
}

function sameIdentity(info: BigIntStats, expected: { device: string; inode: string }): boolean {
  return String(info.dev) === expected.device && String(info.ino) === expected.inode;
}

/**
 * Every directory component is opened through its predecessor's held descriptor.
 * A replaced ancestor cannot redirect a later open. /proc must be mounted; there
 * is deliberately no pathname-read fallback if descriptor traversal is unavailable.
 */
export async function readLinuxArtifactFile(
  identity: ConfinedWorkspaceFileIdentity,
  relativePath: string,
  signal?: AbortSignal,
  hooks: {
    /** Deterministic race seams; production leaves them unset. */
    afterDirectoryOpen?: (relativeDirectory: string) => Promise<void>;
    afterRead?: () => Promise<void>;
  } = {},
): Promise<Buffer> {
  if (process.platform !== "linux" || !identity.root.path.startsWith("/")) throw new LinuxArtifactFileChangedError();
  const rootParts = identity.root.path === "/" ? [] : segments(identity.root.path.slice(1));
  const parts = segments(relativePath);
  const leaf = parts.pop()!;
  signal?.throwIfAborted();
  let directory = await open("/", DIRECTORY_FLAGS);
  let file: FileHandle | undefined;
  const descend = async (part: string): Promise<void> => {
    signal?.throwIfAborted();
    const next = await open(`/proc/self/fd/${directory.fd}/${part}`, DIRECTORY_FLAGS);
    const previous = directory;
    directory = next;
    await previous.close();
  };
  try {
    for (const part of rootParts) await descend(part);
    const root = await directory.stat({ bigint: true });
    if (!root.isDirectory() || !sameIdentity(root, identity.root)) throw new LinuxArtifactFileChangedError();
    let relativeDirectory = "";
    for (const part of parts) {
      await descend(part);
      relativeDirectory = relativeDirectory ? `${relativeDirectory}/${part}` : part;
      await hooks.afterDirectoryOpen?.(relativeDirectory);
    }
    signal?.throwIfAborted();
    file = await open(`/proc/self/fd/${directory.fd}/${leaf}`, FILE_FLAGS);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameIdentity(before, identity.file)) throw new LinuxArtifactFileChangedError();
    if (before.size < 0n || before.size > BigInt(MAX_BYTES)) throw new Error("The artifact file is too large to read.");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > MAX_BYTES) throw new Error("The artifact file is too large to read.");
    }
    await hooks.afterRead?.();
    const after = await file.stat({ bigint: true });
    if (!after.isFile() || after.nlink !== 1n || !sameIdentity(after, identity.file) ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || BigInt(total) !== before.size) {
      throw new LinuxArtifactFileChangedError();
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, total);
  } catch (error) {
    // A symlink inserted at a directory position can report either error on Linux.
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new LinuxArtifactFileChangedError();
    throw error;
  } finally {
    try { await file?.close(); }
    finally { await directory.close(); }
  }
}
