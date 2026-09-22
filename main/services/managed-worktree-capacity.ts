// Free-space admission for the managed-worktree lifecycle. Creation is
// deliberately stricter than snapshot/removal so a nearly-full disk can never
// trap Aiden in "cannot snapshot → cannot delete → cannot free disk".

import * as fs from "node:fs/promises";

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

/** Free bytes on the filesystem containing `dir`, from the user's view. */
export async function statfsAvailableBytes(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function checkCapacity(
  dir: string,
  estimatedBytes: number,
  policy: DiskCapacityPolicy,
): Promise<DiskCapacityReport> {
  const availableBytes = await statfsAvailableBytes(dir);
  const requiredBytes =
    Math.ceil(estimatedBytes * policy.overheadFactor) + policy.reserveBytes;
  const report: DiskCapacityReport = {
    availableBytes,
    requiredBytes,
    reserveBytes: policy.reserveBytes,
    estimatedBytes,
  };
  if (availableBytes < requiredBytes) {
    throw new InsufficientDiskSpaceError(report);
  }
  return report;
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
