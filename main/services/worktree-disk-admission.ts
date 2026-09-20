import * as fs from "node:fs/promises";
import * as path from "node:path";

// Disk admission for managed worktree creation and provisioning.
//
// A worktree checkout copies every tracked file, and provisioning may add the
// ignored payload `.worktreeinclude` selects. Both happen before a chat has
// produced any value, so creation refuses early when the filesystem cannot
// hold roughly twice each estimate (checkout now, recovery room later) plus a
// system reserve. Every failure is closed: statfs errors, unbounded listings,
// and arithmetic overflow all refuse creation rather than guess.

export type WorktreeDiskAdmissionFailure =
  | "unavailable" // free space could not be determined
  | "insufficient"; // free space known but too small

export class WorktreeDiskAdmissionError extends Error {
  declare public readonly cause: unknown;
  constructor(
    public readonly failure: WorktreeDiskAdmissionFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "WorktreeDiskAdmissionError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const GIB = 1024 * 1024 * 1024;

/** Reserve is 10% of filesystem capacity, clamped to [4 GiB, 16 GiB]. */
export const WORKTREE_RESERVE_MIN_BYTES = 4 * GIB;
export const WORKTREE_RESERVE_MAX_BYTES = 16 * GIB;
export const WORKTREE_RESERVE_FRACTION = 0.1;

/** Bounds that keep the estimate honest and the arithmetic safe. */
export const MAX_TRACKED_CHECKOUT_FILES = 500_000;
export const MAX_TRACKED_CHECKOUT_BYTES = 256 * GIB;
export const MAX_PROVISIONED_ESTIMATE_BYTES = 64 * GIB;

export interface FilesystemStats {
  /** Bytes available to an unprivileged process (bsize * bavail). */
  freeBytes: number;
  /** Total filesystem capacity in bytes. */
  capacityBytes: number;
}

export type StatfsProbe = (targetPath: string) => Promise<FilesystemStats>;

export interface WorktreeDiskAdmissionEstimate {
  /** Estimated size of the `git worktree add` checkout of tracked files. */
  checkoutBytes: number;
  /** Estimated size of provisioned `.worktreeinclude` payloads. */
  provisionedBytes: number;
}

/** 10% of capacity, clamped into the [4, 16] GiB reserve band. */
export function worktreeReserveBytes(capacityBytes: number): number {
  const reserve = Math.ceil(capacityBytes * WORKTREE_RESERVE_FRACTION);
  return Math.min(WORKTREE_RESERVE_MAX_BYTES, Math.max(WORKTREE_RESERVE_MIN_BYTES, reserve));
}

/**
 * Total free space required to admit a worktree: the reserve plus double the
 * checkout and provisioned estimates (room for the operation and a recovery
 * snapshot). Throws `unavailable` on any unsafe or unbounded input rather than
 * comparing with a guessed number.
 */
export function requiredWorktreeFreeBytes(
  capacityBytes: number,
  estimate: WorktreeDiskAdmissionEstimate,
): number {
  for (const value of [capacityBytes, estimate.checkoutBytes, estimate.provisionedBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WorktreeDiskAdmissionError(
        "unavailable",
        "Aiden could not determine how much disk space this worktree needs.",
      );
    }
  }
  if (
    estimate.checkoutBytes > MAX_TRACKED_CHECKOUT_BYTES ||
    estimate.provisionedBytes > MAX_PROVISIONED_ESTIMATE_BYTES
  ) {
    throw new WorktreeDiskAdmissionError(
      "unavailable",
      "Aiden could not determine how much disk space this worktree needs.",
    );
  }
  return (
    worktreeReserveBytes(capacityBytes) +
    estimate.checkoutBytes * 2 +
    estimate.provisionedBytes * 2
  );
}

function formatBytes(bytes: number): string {
  const gib = bytes / GIB;
  if (gib >= 0.95) return `${gib.toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

const defaultProbe: StatfsProbe = async (targetPath) => {
  const stats = await fs.statfs(targetPath);
  return {
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
    capacityBytes: Number(stats.blocks) * Number(stats.bsize),
  };
};

/**
 * statfs the filesystem holding `targetPath`, walking up to the nearest
 * existing ancestor when the path itself does not exist yet. Refuses (closed)
 * when availability cannot be determined or when free space is below the
 * required bytes.
 */
export async function assertWorktreeDiskAdmission(
  targetPath: string,
  estimate: WorktreeDiskAdmissionEstimate,
  probe: StatfsProbe = defaultProbe,
): Promise<void> {
  if (!path.isAbsolute(targetPath)) {
    throw new WorktreeDiskAdmissionError(
      "unavailable",
      "Aiden could not determine free disk space for this worktree.",
    );
  }
  let candidate = path.resolve(targetPath);
  let stats: FilesystemStats | undefined;
  for (;;) {
    try {
      stats = await probe(candidate);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorktreeDiskAdmissionError(
          "unavailable",
          "Aiden could not determine free disk space for this worktree.",
          { cause: error },
        );
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new WorktreeDiskAdmissionError(
          "unavailable",
          "Aiden could not determine free disk space for this worktree.",
          { cause: error },
        );
      }
      candidate = parent;
    }
  }
  if (
    !Number.isSafeInteger(stats.freeBytes) ||
    stats.freeBytes < 0 ||
    !Number.isSafeInteger(stats.capacityBytes) ||
    stats.capacityBytes <= 0
  ) {
    throw new WorktreeDiskAdmissionError(
      "unavailable",
      "Aiden could not determine free disk space for this worktree.",
    );
  }
  const required = requiredWorktreeFreeBytes(stats.capacityBytes, estimate);
  if (stats.freeBytes < required) {
    throw new WorktreeDiskAdmissionError(
      "insufficient",
      `Aiden needs approximately ${formatBytes(required)} available to create this worktree, but only ${formatBytes(stats.freeBytes)} is free.`,
    );
  }
}

export type LstatProbe = (filePath: string) => Promise<{ size: number }>;

/**
 * Sum the tracked-file sizes of a checkout from a `git ls-files -z` listing.
 * The listing is bounded in file count and total bytes — exceeding either
 * bound refuses creation (fail closed, not a partial estimate). Files that
 * vanish between listing and lstat are skipped.
 */
export async function estimateTrackedCheckoutBytes(
  lsFilesZero: string | Uint8Array,
  repositoryPath: string,
  lstat: LstatProbe = fs.lstat,
): Promise<number> {
  const listing =
    typeof lsFilesZero === "string" ? lsFilesZero : Buffer.from(lsFilesZero).toString("utf8");
  const entries = listing.split("\u0000").filter((entry) => entry.length > 0);
  if (entries.length > MAX_TRACKED_CHECKOUT_FILES) {
    throw new WorktreeDiskAdmissionError(
      "unavailable",
      "Aiden could not determine how much disk space this worktree needs.",
    );
  }
  let total = 0;
  for (const entry of entries) {
    if (
      entry === ".." ||
      entry.startsWith("../") ||
      entry.endsWith("/..") ||
      entry.includes("/../") ||
      path.isAbsolute(entry)
    ) {
      // ls-files never emits these — treat them as a corrupted listing.
      throw new WorktreeDiskAdmissionError(
        "unavailable",
        "Aiden could not determine how much disk space this worktree needs.",
      );
    }
    let info;
    try {
      info = await lstat(path.join(repositoryPath, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new WorktreeDiskAdmissionError(
        "unavailable",
        "Aiden could not determine how much disk space this worktree needs.",
        { cause: error },
      );
    }
    if (!Number.isSafeInteger(info.size) || info.size < 0) {
      throw new WorktreeDiskAdmissionError(
        "unavailable",
        "Aiden could not determine how much disk space this worktree needs.",
      );
    }
    total += info.size;
    if (total > MAX_TRACKED_CHECKOUT_BYTES || !Number.isSafeInteger(total)) {
      throw new WorktreeDiskAdmissionError(
        "unavailable",
        "Aiden could not determine how much disk space this worktree needs.",
      );
    }
  }
  return total;
}
