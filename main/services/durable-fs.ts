// Shared durable-write primitives for main-process stores.
//
// A crash-safe replacement is: stage a uniquely named sibling, fsync it,
// atomically publish it over (or beside) the destination, then fsync the
// directory so the new name survives power loss. Hand-rolled copies of this
// sequence drifted (fixed `.tmp` names that collide between writers, missing
// fsyncs, swallowed errors), so new code should use these helpers instead.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Flush a directory entry table so renames and unlinks inside it are durable. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flush a regular file's contents and metadata. */
export async function syncFile(target: string): Promise<void> {
  const handle = await fs.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Filesystem seams for fault-injection tests. Production callers never pass these. */
export interface DurableFsIo {
  syncFile(target: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
}

export interface WriteFileAtomicOptions {
  /** Exact POSIX mode of the published file, independent of the process umask. */
  mode?: number;
  /**
   * Publish only when the destination does not exist yet. The staged file is
   * hard-linked into place, which fails with EEXIST instead of replacing a
   * concurrent writer's file the way rename would.
   */
  exclusive?: boolean;
  /**
   * Flush the staged bytes before publication and the directory afterwards.
   * Defaults to true. Turn it off only for regenerable or ephemeral state where
   * a stale-but-whole file after power loss is acceptable.
   */
  fsync?: boolean;
  /** Create missing parent directories (with this mode) before staging. */
  mkdirMode?: number;
  /** Test-only filesystem seams. */
  io?: Partial<DurableFsIo>;
}

/** Sibling staging name. Dot-prefixed, so directory scans that skip hidden files ignore it. */
export function stagedPathFor(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
}

/**
 * Atomically replace (or exclusively create) `target` with `data`.
 *
 * Readers observe either the previous complete file or the new complete file,
 * never a truncated mix. On any failure the staged file is removed and the
 * previous destination is left untouched.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const io: DurableFsIo = {
    syncFile,
    syncDirectory,
    rename: fs.rename,
    link: fs.link,
    ...options.io,
  };
  const durable = options.fsync !== false;
  const directory = path.dirname(target);
  if (options.mkdirMode !== undefined) {
    await fs.mkdir(directory, { recursive: true, mode: options.mkdirMode });
  }
  const staged = stagedPathFor(target);
  let published = false;
  try {
    const handle = await fs.open(
      staged,
      "wx",
      options.mode === undefined ? 0o666 : options.mode,
    );
    try {
      await handle.writeFile(data);
      // open()'s mode is filtered by the umask; chmod pins the requested bits.
      if (options.mode !== undefined) await handle.chmod(options.mode);
    } finally {
      await handle.close();
    }
    if (durable) await io.syncFile(staged);
    if (options.exclusive) {
      await io.link(staged, target);
      published = true;
      await fs.rm(staged, { force: true });
    } else {
      await io.rename(staged, target);
      published = true;
    }
    if (durable) await io.syncDirectory(directory);
  } finally {
    if (!published || options.exclusive) {
      await fs.rm(staged, { force: true }).catch(() => undefined);
    }
  }
}

export interface WriteJsonAtomicOptions extends WriteFileAtomicOptions {
  /** JSON.stringify indentation. Omit for compact output. */
  space?: number;
  /** Append a trailing newline (friendlier for hand-edited files). */
  trailingNewline?: boolean;
}

/** Serialize `value` as JSON and publish it with {@link writeFileAtomic}. */
export async function writeJsonAtomic(
  target: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  const { space, trailingNewline, ...writeOptions } = options;
  const serialized = JSON.stringify(value, null, space);
  if (serialized === undefined) throw new TypeError("Value is not JSON-serializable.");
  await writeFileAtomic(
    target,
    trailingNewline ? `${serialized}\n` : serialized,
    writeOptions,
  );
}
