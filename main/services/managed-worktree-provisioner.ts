// `.worktreeinclude` provisioning: copy explicitly selected ignored+untracked
// files from the source checkout into a freshly created managed worktree.
// Git performs the pattern matching; this module performs the safe copies.

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const INCLUDE_FILE = ".worktreeinclude";
const MAX_INCLUDE_BYTES = 64 * 1024;
const MAX_PROVISIONED_FILES = 4_096;
const MAX_PROVISIONED_BYTES = 256 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;

export type ManagedWorktreeProvisionerErrorCode =
  | "include_invalid"
  | "too_many_files"
  | "too_many_bytes"
  | "unsafe_source"
  | "destination_exists"
  | "source_changed";

export class ManagedWorktreeProvisionerError extends Error {
  readonly code: ManagedWorktreeProvisionerErrorCode;
  declare readonly cause: unknown;
  constructor(code: ManagedWorktreeProvisionerErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "ManagedWorktreeProvisionerError";
  }
}

export interface WorktreeProvisionerDependencies {
  /** Run `git <args>` in `cwd` and return raw (-z) stdout. */
  listFiles(cwd: string, args: readonly string[]): Promise<string>;
}

function normalizedRelativePath(candidate: string): string | undefined {
  if (
    candidate.length === 0 ||
    candidate.length > MAX_PATH_LENGTH ||
    candidate.includes("\\") ||
    candidate.includes("\u0000") ||
    candidate.startsWith("/") ||
    path.isAbsolute(candidate)
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== candidate) {
    return undefined;
  }
  return normalized;
}

/**
 * Return the absolute path of a usable `.worktreeinclude` at the repository
 * root, or undefined when absent. The file must be a regular, non-symlink,
 * bounded file — the exact same file is later handed to Git, so validation
 * here is on the filesystem object, not a copy of its contents.
 */
export async function readWorktreeInclude(repositoryRoot: string): Promise<string | undefined> {
  const candidate = path.join(repositoryRoot, INCLUDE_FILE);
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INCLUDE_BYTES) {
    throw new ManagedWorktreeProvisionerError(
      "include_invalid",
      ".worktreeinclude must be a small regular file at the repository root.",
    );
  }
  return candidate;
}

async function realDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Verify every ancestor of `relativePath` under `root` is a real directory —
 * never a symlink — so the walk cannot be redirected outside the root.
 */
async function assertContainedAncestors(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!(await realDirectory(current))) {
      throw new ManagedWorktreeProvisionerError(
        "unsafe_source",
        "A provisioned file path traverses a symlinked or missing directory.",
      );
    }
  }
}

async function assertContainedFile(root: string, relativePath: string): Promise<import("node:fs").Stats> {
  await assertContainedAncestors(root, relativePath);
  const stat = await fs.lstat(path.join(root, relativePath));
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ManagedWorktreeProvisionerError(
      "unsafe_source",
      "A provisioned file is not a regular file.",
    );
  }
  return stat;
}

function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Copy the `.worktreeinclude`-selected ignored+untracked files into the new
 * managed worktree. Returns the worktree-relative paths actually provisioned —
 * the caller persists them as the authoritative `provisionedFiles` record.
 */
export async function provisionWorktreeIncludedFiles(
  dependencies: WorktreeProvisionerDependencies,
  options: {
    /** The source checkout's repository root. */
    sourceRoot: string;
    /** The freshly created managed worktree root. */
    worktreePath: string;
    signal?: AbortSignal;
    /** Called after each file is fully copied — for partial-rollback safety. */
    onProvisioned?(relativePath: string): void;
  },
): Promise<string[]> {
  const includeFile = await readWorktreeInclude(options.sourceRoot);
  if (includeFile === undefined) return [];

  const canonicalSource = await fs.realpath(options.sourceRoot);
  const canonicalWorktree = await fs.realpath(options.worktreePath);
  if (pathsEqual(canonicalSource, canonicalWorktree)) {
    throw new ManagedWorktreeProvisionerError(
      "unsafe_source",
      "The provisioning source and destination are the same directory.",
    );
  }

  // `ls-files -o -i` is "untracked AND ignored". The WI file is itself an
  // exclude source, so intersecting standard-ignored with WI-ignored yields
  // exactly the files that are both ignored by the project and selected for
  // provisioning — tracked files and non-ignored untracked files can never
  // appear in either list.
  const standardArgs = [
    "ls-files",
    "-z",
    "-o",
    "-i",
    "--exclude-standard",
    "--full-name",
  ];
  const [ignoredRaw, includedRaw] = await Promise.all([
    dependencies.listFiles(canonicalSource, standardArgs),
    dependencies.listFiles(canonicalSource, [
      "ls-files",
      "-z",
      "-o",
      "-i",
      `--exclude-from=${includeFile}`,
      "--full-name",
    ]),
  ]);
  if (options.signal?.aborted) throw new Error("Provision aborted.");
  const ignored = new Set(ignoredRaw.split("\u0000").filter(Boolean));
  const eligible = includedRaw
    .split("\u0000")
    .filter(Boolean)
    .filter((entry) => ignored.has(entry))
    .sort();
  if (eligible.length > MAX_PROVISIONED_FILES) {
    throw new ManagedWorktreeProvisionerError(
      "too_many_files",
      ".worktreeinclude selects more files than Aiden can safely provision.",
    );
  }

  const provisioned: string[] = [];
  let totalBytes = 0;
  for (const entry of eligible) {
    if (options.signal?.aborted) throw new Error("Provision aborted.");
    const relativePath = normalizedRelativePath(entry);
    if (relativePath === undefined) {
      throw new ManagedWorktreeProvisionerError(
        "unsafe_source",
        "A provisioned file path could not be verified.",
      );
    }
    const source = path.join(canonicalSource, relativePath);
    const before = await assertContainedFile(canonicalSource, relativePath);
    totalBytes += before.size;
    if (totalBytes > MAX_PROVISIONED_BYTES) {
      throw new ManagedWorktreeProvisionerError(
        "too_many_bytes",
        ".worktreeinclude selects more bytes than Aiden can safely provision.",
      );
    }

    const destination = path.join(canonicalWorktree, relativePath);
    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    // mkdir -p may reuse an ancestor that is a symlink; verify the real parent
    // stays inside the managed worktree before writing into it.
    const canonicalParent = await fs.realpath(parent);
    const parentRelative = path.relative(canonicalWorktree, canonicalParent);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
      throw new ManagedWorktreeProvisionerError(
        "unsafe_source",
        "A provisioned file destination escapes the managed worktree.",
      );
    }
    try {
      // Bind the copy to the verified filesystem object. A pathname-based copy
      // re-resolves `source` after the identity check, so a concurrently
      // mutable checkout could swap the file or an ancestor for a symlink,
      // restore it before the post-copy lstat, and still have the wrong bytes
      // provisioned. Opening without O_NOFOLLOW and reading through that
      // descriptor closes the window. Whole-file reads match the snapshot
      // capture path and stay inside the same provisioned-size budget.
      const sourceHandle = await fs.open(
        source,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const opened = await sourceHandle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size
        ) {
          throw new ManagedWorktreeProvisionerError(
            "source_changed",
            "A provisioned file changed while Aiden was copying it.",
          );
        }
        const bytes = await sourceHandle.readFile();
        // The descriptor still refers to the verified inode, so a same-inode
        // rewrite during the read is the remaining change this can detect.
        const settled = await sourceHandle.stat();
        if (
          settled.size !== before.size ||
          settled.mtimeMs !== before.mtimeMs ||
          bytes.byteLength !== before.size
        ) {
          throw new ManagedWorktreeProvisionerError(
            "source_changed",
            "A provisioned file changed while Aiden was copying it.",
          );
        }
        await fs.writeFile(destination, bytes, {
          flag: "wx",
          mode: before.mode & 0o777,
        });
      } finally {
        await sourceHandle.close().catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new ManagedWorktreeProvisionerError(
          "destination_exists",
          "A provisioned file would overwrite an existing worktree file.",
          error,
        );
      }
      // ELOOP means the pathname became a symlink and ENOENT means it vanished;
      // neither can be provisioned from the verified object any more.
      if (code === "ELOOP" || code === "ENOENT") {
        throw new ManagedWorktreeProvisionerError(
          "source_changed",
          "A provisioned file changed while Aiden was copying it.",
          error,
        );
      }
      throw error;
    }
    await fs.chmod(destination, before.mode & 0o777).catch(() => undefined);
    provisioned.push(relativePath);
    options.onProvisioned?.(relativePath);
  }
  return provisioned;
}
