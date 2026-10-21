import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  captureManagedWorktreeRootIdentity, createPrivateConfinedWorkspaceFile, readConfinedWorkspaceFile,
  type ManagedWorktreeRootIdentity,
} from "./managed-worktree-file-io.js";
import { isPeerProjectEnvironmentFile, PEER_PROJECT_FILE_MAX_BYTES } from "../../renderer/shared/peer-project-clone.js";

/** The caller admits one real directory. Later checks must keep this exact identity. */
export async function capturePeerProjectRoot(value: string): Promise<ManagedWorktreeRootIdentity> {
  const expected = process.platform === "darwin"
    ? path.resolve(value).replace(/^\/(tmp|var|etc)(?=\/|$)/u, "/private/$1")
    : path.resolve(value);
  const root = await captureManagedWorktreeRootIdentity(expected);
  if (root.path !== expected) throw new Error("The project folder changed or is a link.");
  return root;
}

export async function assertPeerProjectRoot(root: ManagedWorktreeRootIdentity): Promise<void> {
  const current = await capturePeerProjectRoot(root.path);
  if (current.device !== root.device || current.inode !== root.inode) throw new Error("The project folder changed.");
}

/** Linux has procfs descriptor paths; macOS uses the packaged openat helper. */
async function pinnedLinuxRoot(root: ManagedWorktreeRootIdentity): Promise<fs.FileHandle> {
  let current = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of root.path.split(path.sep).filter(Boolean)) {
      if (part === "." || part === "..") throw new Error("Invalid project folder.");
      const next = await fs.open(`/proc/self/fd/${current.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await current.close(); current = next;
    }
    const stat = await current.stat({ bigint: true });
    if (String(stat.dev) !== root.device || String(stat.ino) !== root.inode) throw new Error("The project folder changed.");
    return current;
  } catch (error) { await current.close(); throw error; }
}

export async function readPeerProjectFile(root: ManagedWorktreeRootIdentity, name: string, identity: { device: string; inode: string }): Promise<Buffer> {
  if (!isPeerProjectEnvironmentFile(name)) throw new Error("Invalid environment file.");
  if (process.platform === "darwin") {
    const content = await readConfinedWorkspaceFile({ root, file: identity }, name);
    if (content.length > PEER_PROJECT_FILE_MAX_BYTES) throw new Error("An environment file is too large.");
    return content;
  }
  const directory = await pinnedLinuxRoot(root);
  try {
    const file = await fs.open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== identity.device || String(stat.ino) !== identity.inode || stat.size > BigInt(PEER_PROJECT_FILE_MAX_BYTES)) throw new Error("The environment file changed.");
      const buffer = Buffer.alloc(PEER_PROJECT_FILE_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > PEER_PROJECT_FILE_MAX_BYTES) throw new Error("An environment file is too large.");
      const after = await file.stat({ bigint: true });
      if (after.nlink !== 1n || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new Error("The environment file changed while being read.");
      return buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
  } finally { await directory.close(); }
}

export async function createPeerProjectFile(root: ManagedWorktreeRootIdentity, name: string, content: string, signal: AbortSignal): Promise<void> {
  if (!isPeerProjectEnvironmentFile(name) || Buffer.byteLength(content) > PEER_PROJECT_FILE_MAX_BYTES) throw new Error("Invalid environment file.");
  if (process.platform === "darwin") return createPrivateConfinedWorkspaceFile(root, name, Buffer.from(content), signal);
  signal.throwIfAborted();
  const directory = await pinnedLinuxRoot(root);
  try {
    const file = await fs.open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { signal.throwIfAborted(); await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
  } finally { await directory.close(); }
}
