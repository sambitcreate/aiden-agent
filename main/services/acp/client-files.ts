/**
 * ACP `fs/read_text_file` and `fs/write_text_file`, performed by Aiden.
 *
 * Adapted from T3 Code apps/server/src/provider/acp/AntigravityClientFiles.ts
 * @ f870c419fc (MIT). Advertising these client capabilities means the agent's
 * own file tools read and write through Aiden instead of touching the disk
 * directly, so every path is confined to the generation's workspace roots.
 * Unlike T3, the workspace permission is enforced here too: a read-only
 * generation refuses writes even when the agent's native mode would allow
 * them.
 */
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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

export async function readClientTextFile(
  params: ReadTextFileParams,
  policy: AcpClientFilePolicy,
): Promise<{ content: string }> {
  const target = await resolveConfinedPath(params.path, policy.roots);
  const info = await stat(target);
  if (!info.isFile()) throw new AcpHarnessError("invalid_input", "The path is not a file.");
  if (info.size > MAX_CLIENT_READ_BYTES) {
    throw new AcpHarnessError("invalid_input", "The file is too large to read (8 MiB limit).");
  }
  const text = await readFile(target, "utf8");
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
  let before: string | undefined;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new AcpHarnessError("invalid_input", "The path is not a file.");
    if (info.size <= MAX_CLIENT_READ_BYTES) before = await readFile(target, "utf8");
  } catch (error) {
    if (error instanceof AcpHarnessError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Recheck right before the write: permission can change mid-turn.
  if (!policy.canWrite()) {
    throw new AcpHarnessError("unavailable", "This chat's folder is read-only for the agent.");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, params.content, "utf8");
  policy.onWrite?.(target, before, params.content);
  return {};
}
