import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { isContainedRelativePath } from "./worktree-snapshot-store-core.js";

export const WORKTREE_INCLUDE_FILENAME = ".worktreeinclude";
export const WORKTREE_INCLUDE_MAX_BYTES = 256 * 1024;
export const WORKTREE_PROVISION_MAX_FILES = 512;
export const WORKTREE_PROVISION_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const WORKTREE_PROVISION_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export type WorktreeProvisionFailure =
  | "invalid" // inputs could not be validated
  | "exceeded" // file-count or byte budget exceeded
  | "io"; // filesystem operation failed

export class WorktreeProvisionError extends Error {
  declare public readonly cause: unknown;
  constructor(
    public readonly failure: WorktreeProvisionFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "WorktreeProvisionError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export interface ProvisionedFileEntry {
  relativePath: string;
  mode: number;
  /**
   * SHA-256 of the bytes Aiden wrote. A copy still matching it is Aiden's own
   * regenerable output, so deletion may discard it; an edited copy is user data.
   */
  sha256?: string;
}

/** Bound on filesystem entries inspected when classifying ignored status paths. */
export const WORKTREE_PROVISION_MAX_INSPECTED_ENTRIES = 4_096;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function isProvisionedFileDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function parseLsFilesZero(output: string): string[] {
  if (output.length === 0) return [];
  return output.split("\u0000").filter((entry) => entry.length > 0);
}

/**
 * The provisioned set: untracked files that match `.worktreeinclude`
 * (gitignore semantics, `!` negations included) AND are ignored by the
 * repository's standard excludes. Tracked and merely-untracked files are
 * never provisioned.
 *
 * - `allUntracked`: `git ls-files -z --others`
 * - `includeVisible`: `git ls-files -z --others --exclude-from=<include>` —
 *   untracked files NOT matched by the include file, so membership in
 *   `allUntracked ∖ includeVisible` means "matched by .worktreeinclude".
 * - `ignored`: `git ls-files -z --others --ignored --exclude-standard`
 */
export function selectProvisionedFiles(
  allUntracked: readonly string[],
  includeVisible: readonly string[],
  ignored: readonly string[],
): string[] {
  const ignoredSet = new Set(ignored);
  const visibleSet = new Set(includeVisible);
  const selected: string[] = [];
  for (const entry of allUntracked) {
    if (visibleSet.has(entry) || !ignoredSet.has(entry)) continue;
    if (!isContainedRelativePath(entry)) continue;
    selected.push(entry);
  }
  selected.sort();
  if (selected.length > WORKTREE_PROVISION_MAX_FILES) {
    throw new WorktreeProvisionError(
      "exceeded",
      `The .worktreeinclude set is too large to provision (more than ${WORKTREE_PROVISION_MAX_FILES} files).`,
    );
  }
  return selected;
}

/**
 * Resolve the repository-root `.worktreeinclude`, or null when provisioning
 * does not apply. The include file must be a regular file — never a symlink —
 * inside the repository.
 */
export async function resolveWorktreeInclude(
  repositoryPath: string,
): Promise<string | null> {
  const candidate = path.join(repositoryPath, WORKTREE_INCLUDE_FILENAME);
  let info;
  try {
    info = await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) return null;
  if (info.size > WORKTREE_INCLUDE_MAX_BYTES) {
    throw new WorktreeProvisionError(
      "exceeded",
      "The .worktreeinclude file is too large to use for provisioning.",
    );
  }
  const canonicalRepo = await fs.realpath(repositoryPath);
  const canonicalInclude = await fs.realpath(candidate);
  if (!canonicalInclude.startsWith(`${canonicalRepo}${path.sep}`)) return null;
  return canonicalInclude;
}

/**
 * Bounded byte estimate of the files provisioning would copy — the input to
 * the post-creation disk re-check. Vanished or non-regular files count zero.
 */
export async function estimateProvisionedBytes(
  sourceRoot: string,
  relativePaths: readonly string[],
  lstat: typeof fs.lstat = fs.lstat,
): Promise<number> {
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    if (!isContainedRelativePath(relativePath)) {
      throw new WorktreeProvisionError(
        "invalid",
        "A provisioned file path escapes the repository.",
      );
    }
    let info;
    try {
      info = await lstat(path.join(sourceRoot, relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    totalBytes += info.size;
    if (totalBytes > WORKTREE_PROVISION_MAX_TOTAL_BYTES || !Number.isSafeInteger(totalBytes)) {
      throw new WorktreeProvisionError(
        "exceeded",
        "The provisioned files are too large to copy into the worktree.",
      );
    }
  }
  return totalBytes;
}

/**
 * Copy the selected files from the source checkout into the new worktree.
 * Never overwrites, never follows symlinks, verifies both sides stay inside
 * their respective roots, and records the durable manifest. A partial copy is
 * removed again before the error propagates.
 */
export async function copyProvisionedFiles(
  sourceRoot: string,
  worktreePath: string,
  relativePaths: readonly string[],
): Promise<ProvisionedFileEntry[]> {
  if (relativePaths.length === 0) return [];
  const canonicalSource = await fs.realpath(sourceRoot);
  const canonicalWorktree = await fs.realpath(worktreePath);
  const manifest: ProvisionedFileEntry[] = [];
  let totalBytes = 0;
  try {
    for (const relativePath of relativePaths) {
      if (!isContainedRelativePath(relativePath)) {
        throw new WorktreeProvisionError(
          "invalid",
          "A provisioned file path escapes the worktree.",
        );
      }
      const source = path.join(canonicalSource, relativePath);
      let info;
      try {
        info = await fs.lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const resolvedSource = await fs.realpath(source);
      if (!resolvedSource.startsWith(`${canonicalSource}${path.sep}`)) {
        // A symlinked directory in the middle of the path resolved outside
        // the source checkout — never follow it.
        continue;
      }
      if (info.size > WORKTREE_PROVISION_MAX_FILE_BYTES) {
        throw new WorktreeProvisionError(
          "exceeded",
          `The provisioned file ${relativePath} is too large to copy.`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > WORKTREE_PROVISION_MAX_TOTAL_BYTES || !Number.isSafeInteger(totalBytes)) {
        throw new WorktreeProvisionError(
          "exceeded",
          "The provisioned files are too large to copy into the worktree.",
        );
      }
      const destination = path.join(canonicalWorktree, relativePath);
      const parent = path.dirname(destination);
      await fs.mkdir(parent, { recursive: true });
      const canonicalParent = await fs.realpath(parent);
      if (
        canonicalParent !== canonicalWorktree &&
        !canonicalParent.startsWith(`${canonicalWorktree}${path.sep}`)
      ) {
        throw new WorktreeProvisionError(
          "invalid",
          "A provisioned file destination escaped the worktree.",
        );
      }
      await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      // Recorded before any later step can fail, so the partial-copy cleanup
      // below always knows about this destination.
      const entry: ProvisionedFileEntry = { relativePath, mode: info.mode & 0o777 };
      manifest.push(entry);
      await fs.chmod(destination, entry.mode);
      entry.sha256 = await sha256File(destination);
    }
  } catch (error) {
    for (const entry of manifest) {
      await fs
        .rm(path.join(canonicalWorktree, entry.relativePath), { force: true })
        .catch(() => undefined);
    }
    if (error instanceof WorktreeProvisionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorktreeProvisionError(
        "invalid",
        "A provisioned file already exists in the worktree.",
        { cause: error },
      );
    }
    throw new WorktreeProvisionError(
      "io",
      "Aiden could not copy the provisioned files into the worktree.",
      { cause: error },
    );
  }
  return manifest;
}

/**
 * Best-effort removal of files Aiden provisioned — used when a later creation
 * step fails and the recorded manifest is the only set Aiden may safely delete.
 */
export async function removeProvisionedFiles(
  worktreePath: string,
  manifest: readonly ProvisionedFileEntry[],
): Promise<void> {
  const canonicalWorktree = await fs.realpath(worktreePath).catch(() => null);
  if (!canonicalWorktree) return;
  for (const entry of manifest) {
    if (!isContainedRelativePath(entry.relativePath)) continue;
    const target = path.join(canonicalWorktree, entry.relativePath);
    await fs.rm(target, { force: true }).catch(() => undefined);
  }
}

/**
 * Whether every ignored path Git reports in a managed checkout is a file Aiden
 * provisioned and that still holds exactly the bytes Aiden wrote. Directory
 * entries (`dir/`, reported when a whole directory is ignored) qualify only
 * when every file beneath them does. Symlinks, special files, unrecorded or
 * edited files, legacy manifest entries without a digest, and oversized trees
 * all return false so the caller preserves the checkout.
 */
export async function ignoredPathsAreUnchangedProvisionedFiles(
  worktreePath: string,
  ignoredPaths: readonly string[],
  manifest: readonly ProvisionedFileEntry[] | undefined,
): Promise<boolean> {
  if (ignoredPaths.length === 0) return true;
  if (!manifest?.length) return false;
  const expected = new Map<string, string>();
  for (const entry of manifest) {
    if (!isContainedRelativePath(entry.relativePath)) return false;
    if (isProvisionedFileDigest(entry.sha256)) expected.set(entry.relativePath, entry.sha256);
  }
  let canonicalWorktree: string;
  try {
    canonicalWorktree = await fs.realpath(worktreePath);
  } catch {
    return false;
  }
  let inspected = 0;

  const fileMatches = async (relativePath: string): Promise<boolean> => {
    const digest = expected.get(relativePath);
    if (!digest) return false;
    const absolute = path.join(canonicalWorktree, relativePath);
    const info = await fs.lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    const parent = await fs.realpath(path.dirname(absolute));
    if (parent !== canonicalWorktree && !parent.startsWith(`${canonicalWorktree}${path.sep}`)) {
      return false;
    }
    return (await sha256File(absolute)) === digest;
  };

  const entryMatches = async (relativePath: string): Promise<boolean> => {
    inspected += 1;
    if (inspected > WORKTREE_PROVISION_MAX_INSPECTED_ENTRIES) return false;
    if (!isContainedRelativePath(relativePath)) return false;
    const absolute = path.join(canonicalWorktree, relativePath);
    const info = await fs.lstat(absolute);
    if (info.isSymbolicLink()) return false;
    if (info.isFile()) return fileMatches(relativePath);
    if (!info.isDirectory()) return false;
    for (const child of await fs.readdir(absolute)) {
      if (!(await entryMatches(`${relativePath}/${child}`))) return false;
    }
    return true;
  };

  try {
    for (const reported of ignoredPaths) {
      const relativePath = reported.endsWith("/") ? reported.slice(0, -1) : reported;
      if (!(await entryMatches(relativePath))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
