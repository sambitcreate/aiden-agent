// `.worktreeinclude` provisioning: copy explicitly selected ignored+untracked
// files from the source checkout into a freshly created managed worktree.
// Git performs the pattern matching; this module performs the safe copies.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { captureManagedWorktreeRootIdentity, ManagedWorktreeFileIoError, transferManagedWorktreeFile } from "./managed-worktree-file-io.js";

const INCLUDE_FILE = ".worktreeinclude";
const MAX_INCLUDE_BYTES = 64 * 1024;
const MAX_PROVISIONED_FILES = 4_096;
export const MAX_PROVISIONED_BYTES = 256 * 1024 * 1024;
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
  // The descriptor-relative transfer helper ships only in macOS builds today;
  // `.worktreeinclude` provisioning is a no-op elsewhere until it gains a Linux port.
  if (process.platform !== "darwin") return [];
  const includeFile = await readWorktreeInclude(options.sourceRoot);
  if (includeFile === undefined) return [];

  const canonicalSource = await fs.realpath(options.sourceRoot);
  const canonicalWorktree = await fs.realpath(options.worktreePath);
  const sourceIdentity = await captureManagedWorktreeRootIdentity(canonicalSource);
  const destinationIdentity = await captureManagedWorktreeRootIdentity(canonicalWorktree);
  if (sourceIdentity.path !== canonicalSource || destinationIdentity.path !== canonicalWorktree) {
    throw new ManagedWorktreeProvisionerError(
      "unsafe_source", "A managed worktree root changed while provisioning was starting.",
    );
  }
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
    try {
      const copied = await transferManagedWorktreeFile({
        operation: "copy",
        sourceRoot: canonicalSource,
        sourceIdentity,
        sourceRelativePath: relativePath,
        destinationRoot: canonicalWorktree,
        destinationIdentity,
        destinationRelativePath: relativePath,
        byteLimit: MAX_PROVISIONED_BYTES - totalBytes,
        mode: "source",
      });
      totalBytes += copied.size;
    } catch (error) {
      if (error instanceof ManagedWorktreeFileIoError) {
        const code = error.code === "destination_exists" ? "destination_exists"
          : error.code === "too_many_bytes" ? "too_many_bytes"
          : error.code === "source_changed" ? "source_changed"
          : error.code === "unsafe_source" ? "unsafe_source"
          : error.code === "invalid_input" ? "unsafe_source"
          : "unsafe_source";
        throw new ManagedWorktreeProvisionerError(
          code,
          code === "destination_exists"
            ? "A provisioned file would overwrite an existing worktree file."
            : "A provisioned file could not be copied safely.",
          error,
        );
      }
      throw error;
    }
    provisioned.push(relativePath);
    options.onProvisioned?.(relativePath);
  }
  return provisioned;
}
