// Free-space admission for the managed-worktree lifecycle. Creation is
// deliberately stricter than snapshot/removal so a nearly-full disk can never
// trap Aiden in "cannot snapshot → cannot delete → cannot free disk".

import * as path from "node:path";
import * as fs from "node:fs/promises";

export class WorktreeCapacityUnavailableError extends Error {
  readonly code = "capacity_unavailable";
  constructor(message = "Disk capacity could not be verified. Check that the worktree and repository volumes are available.") {
    super(message);
    this.name = "WorktreeCapacityUnavailableError";
  }
}

export class InsufficientDiskSpaceError extends Error {
  readonly code = "insufficient_disk_space";
  readonly availableBytes: number;
  readonly requiredBytes: number;
  readonly reserveBytes: number;
  readonly estimatedBytes: number;

  constructor(report: DiskCapacityReport) {
    super(
      `Not enough free disk space: ${report.availableBytes} bytes available, ` +
        `${report.requiredBytes} required.`,
    );
    this.name = "InsufficientDiskSpaceError";
    this.availableBytes = report.availableBytes;
    this.requiredBytes = report.requiredBytes;
    this.reserveBytes = report.reserveBytes;
    this.estimatedBytes = report.estimatedBytes;
  }
}

export interface DiskCapacityReport {
  availableBytes: number;
  requiredBytes: number;
  reserveBytes: number;
  estimatedBytes: number;
}

export interface DiskCapacityPolicy {
  /** Always kept free after the operation. */
  reserveBytes: number;
  /** Inflates the estimate to cover transient overhead (index, temp files). */
  overheadFactor: number;
}

/** The estimator accepts at most 1 MiB of ls-tree records (<20k entries).
 * Reserve room for registration, refs and multiple index writes, not a second
 * copy of repository objects, which worktrees share with the original repo.
 */
export const WORKTREE_GIT_METADATA_BYTES = 16 * 1024 * 1024;

/** Creating a worktree needs a real reserve: checkout + hooks-free add. */
export const CREATE_CAPACITY_POLICY: DiskCapacityPolicy = {
  reserveBytes: 512 * 1024 * 1024,
  overheadFactor: 1.25,
};

/** Snapshot/removal only preserves recoverable bytes — keep this cheap. */
export const SNAPSHOT_CAPACITY_POLICY: DiskCapacityPolicy = {
  reserveBytes: 64 * 1024 * 1024,
  overheadFactor: 1.1,
};

export interface WorktreeFilesystemCapacity {
  device: string;
  availableBytes: number;
}

async function inspectFilesystemCapacity(dir: string): Promise<WorktreeFilesystemCapacity> {
  // A new worktree root may not exist yet. Inspect its nearest existing parent
  // without creating directories or substituting the source repository volume.
  let candidate = path.resolve(dir);
  while (true) {
    try {
      const [stats, identity] = await Promise.all([
        fs.statfs(candidate),
        fs.stat(candidate, { bigint: true }),
      ]);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 ||
          !Number.isSafeInteger(Number(stats.bsize)) || Number(stats.bsize) <= 0) {
        throw new WorktreeCapacityUnavailableError();
      }
      return { device: identity.dev.toString(), availableBytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(candidate) === candidate) {
        throw new WorktreeCapacityUnavailableError();
      }
      candidate = path.dirname(candidate);
    }
  }
}

/** Free bytes on the filesystem containing `dir`, from the user's view. */
export async function statfsAvailableBytes(dir: string): Promise<number> {
  return (await inspectFilesystemCapacity(dir)).availableBytes;
}

function capacityReport(
  availableBytes: number,
  estimatedBytes: number,
  policy: DiskCapacityPolicy,
): DiskCapacityReport {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0 ||
      !Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new WorktreeCapacityUnavailableError("The worktree allocation size could not be verified.");
  }
  const requiredBytes = Math.ceil(estimatedBytes * policy.overheadFactor) + policy.reserveBytes;
  const report = { availableBytes, requiredBytes, reserveBytes: policy.reserveBytes, estimatedBytes };
  if (availableBytes < requiredBytes) throw new InsufficientDiskSpaceError(report);
  return report;
}

async function checkCapacity(
  dir: string,
  estimatedBytes: number,
  policy: DiskCapacityPolicy,
): Promise<DiskCapacityReport> {
  return capacityReport(await statfsAvailableBytes(dir), estimatedBytes, policy);
}

/** Admit bytes exactly on the volume receiving them; combine shared volumes.
 * The inspector seam allows deterministic split-volume tests without mounts.
 */
export async function checkWorktreeAllocation(
  destination: string,
  commonDirectory: string,
  checkoutAndPayloadBytes: number,
  inspect: (directory: string) => Promise<WorktreeFilesystemCapacity> = inspectFilesystemCapacity,
): Promise<void> {
  if (!Number.isSafeInteger(checkoutAndPayloadBytes) || checkoutAndPayloadBytes < 0) {
    throw new WorktreeCapacityUnavailableError("The worktree allocation size could not be verified.");
  }
  const [checkout, metadata] = await Promise.all([inspect(destination), inspect(commonDirectory)]);
  if (!checkout.device || !metadata.device) throw new WorktreeCapacityUnavailableError();
  if (checkout.device === metadata.device) {
    capacityReport(Math.min(checkout.availableBytes, metadata.availableBytes),
      checkoutAndPayloadBytes + WORKTREE_GIT_METADATA_BYTES, CREATE_CAPACITY_POLICY);
  } else {
    capacityReport(checkout.availableBytes, checkoutAndPayloadBytes, CREATE_CAPACITY_POLICY);
    capacityReport(metadata.availableBytes, WORKTREE_GIT_METADATA_BYTES, CREATE_CAPACITY_POLICY);
  }
}

/** Admission before `mkdir` + `git worktree add`. */
export function checkCreateCapacity(
  worktreeRoot: string,
  estimatedBytes: number,
): Promise<DiskCapacityReport> {
  return checkCapacity(worktreeRoot, estimatedBytes, CREATE_CAPACITY_POLICY);
}

/** Admission before writing snapshot blobs into the snapshot root. */
export function checkSnapshotCapacity(
  snapshotRoot: string,
  estimatedBytes: number,
): Promise<DiskCapacityReport> {
  return checkCapacity(snapshotRoot, estimatedBytes, SNAPSHOT_CAPACITY_POLICY);
}
