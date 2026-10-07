/**
 * ACP `fs/read_text_file` and `fs/write_text_file`, performed by Aiden.
 *
 * Adapted from T3 Code apps/server/src/provider/acp/AntigravityClientFiles.ts
 * @ f870c419fc (MIT). Advertising these client capabilities means the agent's
 * own file tools read and write through Aiden instead of touching the disk
 * directly, so every path is confined to the generation's workspace roots.
 * Unlike T3, the workspace permission is enforced here too: a read-only
 * generation refuses writes even when the agent's native mode would allow
 * them. Reads keep Aiden's `.env` exclusion, and all I/O goes through a
 * descriptor whose identity and location are re-verified before any byte is
 * read or written, so a symlink swapped in after validation is refused.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { isEnvironmentSecretPath } from "../coding-tools.js";
import {
  captureManagedWorktreeRootIdentity,
  createConfinedWorkspaceFile,
  ManagedWorktreeFileIoError,
} from "../managed-worktree-file-io.js";
import { AcpHarnessError } from "./errors.js";

export const MAX_CLIENT_READ_BYTES = 8 * 1024 * 1024;
export const MAX_CLIENT_WRITE_BYTES = 8 * 1024 * 1024;

export interface AcpClientFilePolicy {
  /** Absolute directories the agent may touch. The first is the workspace. */
  roots: readonly string[];
  /** Whether writes are currently allowed; read at the moment of each write. */
  canWrite(): boolean;
  /** Called after a successful write with the absolute real path. */
  onWrite?(absolutePath: string, before: string | undefined, after: string): void;
  /** Test seam: runs after validation, immediately before a new file is created. */
  beforeCreate?(): Promise<void> | void;
}

export interface ReadTextFileParams {
  path: string;
  line?: number | null;
  limit?: number | null;
}

export interface WriteTextFileParams {
  path: string;
  content: string;
}

async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  const output: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root)) continue;
    try {
      output.push(await realpath(root));
    } catch {
      // A missing root grants nothing.
    }
  }
  return output;
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve the real location of `requested`. Existing paths are realpath'd
 * including a final symlink; a missing file resolves through its nearest
 * existing ancestor so a write cannot escape through a symlinked parent.
 */
export async function resolveConfinedPath(
  requested: string,
  roots: readonly string[],
): Promise<string> {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) {
    throw new AcpHarnessError("invalid_input", "The agent asked for an invalid file path.");
  }
  if (!path.isAbsolute(requested)) {
    throw new AcpHarnessError("invalid_input", "The agent must use absolute file paths.");
  }
  const allowed = await canonicalRoots(roots);
  if (allowed.length === 0) {
    throw new AcpHarnessError("unavailable", "This chat has no folder the agent can use.");
  }
  const normalized = path.resolve(requested);
  let resolved: string;
  try {
    const info = await lstat(normalized);
    if (info.isSymbolicLink()) {
      try {
        resolved = await realpath(normalized);
      } catch {
        throw new AcpHarnessError("invalid_input", "The file is a broken link.");
      }
    } else {
      resolved = await realpath(normalized);
    }
  } catch (error) {
    if (error instanceof AcpHarnessError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const missing: string[] = [];
    let ancestor = normalized;
    for (;;) {
      const parent = path.dirname(ancestor);
      missing.unshift(path.basename(ancestor));
      if (parent === ancestor) {
        throw new AcpHarnessError("invalid_input", "The file is outside this chat's folder.");
      }
      ancestor = parent;
      try {
        const real = await realpath(ancestor);
        resolved = path.join(real, ...missing);
        break;
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
      }
    }
  }
  if (!allowed.some((root) => within(resolved, root))) {
    throw new AcpHarnessError("invalid_input", "The file is outside this chat's folder.");
  }
  return resolved;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Aiden's parent read policy: `.env` and `.env.*` (except examples) stay out of model context. */
async function rejectEnvironmentSecret(target: string, roots: readonly string[]): Promise<void> {
  for (const root of await canonicalRoots(roots)) {
    if (within(target, root) && isEnvironmentSecretPath(path.relative(root, target))) {
      throw new AcpHarnessError(
        "invalid_input",
        "Reading .env files is disabled to keep workspace secrets out of model context.",
      );
    }
  }
}

/**
 * Re-check, through an open descriptor, that the path still names the file
 * that was opened and that it still resolves inside the roots. Runs before any
 * byte is read or written, so a symlink or parent swap after validation is
 * refused instead of followed.
 */
async function assertStillConfined(
  requested: string,
  roots: readonly string[],
  opened: Stats,
): Promise<string> {
  const verified = await resolveConfinedPath(requested, roots);
  let current: Stats;
  try {
    current = await lstat(verified);
  } catch {
    throw new AcpHarnessError("invalid_input", "The file changed while it was being opened.");
  }
  if (current.isSymbolicLink() || !sameFile(opened, current)) {
    throw new AcpHarnessError("invalid_input", "The file changed while it was being opened.");
  }
  return verified;
}

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Create a new file anchored to directory identities, so a parent swapped
 * after validation cannot redirect the creation outside the folder. macOS uses
 * Aiden's packaged native helper (openat/mkdirat with O_NOFOLLOW); Linux walks
 * /proc/self/fd, which resolves each step through the previous descriptor.
 */
async function createAnchored(target: string, content: string, roots: readonly string[]): Promise<void> {
  const root = (await canonicalRoots(roots)).find((candidate) => within(target, candidate));
  if (!root) throw new AcpHarnessError("invalid_input", "The file is outside this chat's folder.");
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AcpHarnessError("invalid_input", "The file is outside this chat's folder.");
  }
  const bytes = Buffer.from(content, "utf8");
  if (process.platform === "darwin") {
    try {
      const identity = await captureManagedWorktreeRootIdentity(root);
      await createConfinedWorkspaceFile(identity, relative.split(path.sep).join("/"), bytes);
    } catch (error) {
      if (error instanceof ManagedWorktreeFileIoError && error.code === "destination_exists") {
        throw new AcpHarnessError("invalid_input", "The file changed while it was being created.");
      }
      throw new AcpHarnessError("invalid_input", "The file could not be created safely in this chat's folder.", {
        cause: error,
      });
    }
    return;
  }
  if (process.platform !== "linux") {
    throw new AcpHarnessError("unavailable", "Creating files is not supported on this platform.");
  }
  const parts = relative.split(path.sep);
  const leaf = parts.pop()!;
  let current = await open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NO_FOLLOW);
  try {
    for (const part of parts) {
      const step = `/proc/self/fd/${current.fd}/${part}`;
      let next: FileHandle;
      try {
        next = await open(step, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NO_FOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(step);
        next = await open(step, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NO_FOLLOW);
      }
      await current.close();
      current = next;
    }
    const file = await open(
      `/proc/self/fd/${current.fd}/${leaf}`,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o644,
    );
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof AcpHarnessError) throw error;
    throw new AcpHarnessError("invalid_input", "The file could not be created safely in this chat's folder.", {
      cause: error,
    });
  } finally {
    await current.close().catch(() => undefined);
  }
}

export async function readClientTextFile(
  params: ReadTextFileParams,
  policy: AcpClientFilePolicy,
): Promise<{ content: string }> {
  const target = await resolveConfinedPath(params.path, policy.roots);
  await rejectEnvironmentSecret(target, policy.roots);
  let handle: FileHandle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | NO_FOLLOW | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new AcpHarnessError("invalid_input", "The file changed while it was being opened.");
    }
    throw error;
  }
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new AcpHarnessError("invalid_input", "The path is not a file.");
    if (info.size > MAX_CLIENT_READ_BYTES) {
      throw new AcpHarnessError("invalid_input", "The file is too large to read (8 MiB limit).");
    }
    await rejectEnvironmentSecret(await assertStillConfined(params.path, policy.roots, info), policy.roots);
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const line = params.line ?? undefined;
  const limit = params.limit ?? undefined;
  if (line === undefined && limit === undefined) return { content: text };
  const lines = text.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + Math.max(0, limit);
  return { content: lines.slice(start, end).join("\n") };
}

export async function writeClientTextFile(
  params: WriteTextFileParams,
  policy: AcpClientFilePolicy,
): Promise<Record<string, never>> {
  if (!policy.canWrite()) {
    throw new AcpHarnessError("unavailable", "This chat's folder is read-only for the agent.");
  }
  if (typeof params.content !== "string") {
    throw new AcpHarnessError("invalid_input", "The agent sent no file content.");
  }
  if (Buffer.byteLength(params.content, "utf8") > MAX_CLIENT_WRITE_BYTES) {
    throw new AcpHarnessError("invalid_input", "The file is too large to write (8 MiB limit).");
  }
  const target = await resolveConfinedPath(params.path, policy.roots);
  let handle: FileHandle;
  try {
    handle = await open(target, fsConstants.O_RDWR | NO_FOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new AcpHarnessError("invalid_input", "The file changed while it was being opened.");
    if (code !== "ENOENT") throw error;
    if (!policy.canWrite()) {
      throw new AcpHarnessError("unavailable", "This chat's folder is read-only for the agent.");
    }
    await policy.beforeCreate?.();
    await createAnchored(target, params.content, policy.roots);
    policy.onWrite?.(target, undefined, params.content);
    return {};
  }
  let before: string | undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new AcpHarnessError("invalid_input", "The path is not a file.");
    const verified = await assertStillConfined(params.path, policy.roots, info);
    if (info.size <= MAX_CLIENT_READ_BYTES) before = await handle.readFile("utf8");
    // Recheck right before the write: permission can change mid-turn.
    if (!policy.canWrite()) {
      throw new AcpHarnessError("unavailable", "This chat's folder is read-only for the agent.");
    }
    await handle.truncate(0);
    await handle.write(params.content, 0, "utf8");
    policy.onWrite?.(verified, before, params.content);
  } finally {
    await handle.close();
  }
  return {};
}
