// Desktop Settings → Storage: measuring, classifying, and planning.
//
// Everything here is either a filesystem walk with a hard budget or a pure
// function over already-read facts, so the safety rules that decide what may be
// deleted are testable without Electron, Git, or a real profile directory.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  storageInactiveCutoff,
  STORAGE_CATEGORY_IDS,
  worktreeProtectionReason,
  type StorageCategoryId,
  type StorageCategoryUsage,
  type StorageCleanupPreview,
  type StorageCleanupRequest,
  type StorageCleanupSkipped,
  type StorageInactiveDays,
  type StorageItem,
  type StorageReport,
  type StorageThreadView,
  type StorageWorktreeView,
} from "../../renderer/shared/storage.js";

const GIB = 1024 * 1024 * 1024;

export interface StorageScanBudgetLimits {
  maxEntries: number;
  maxBytes: number;
  maxDurationMs: number;
}

/**
 * Defaults for one background scan. A large profile can exceed these; the walk
 * then reports `truncated` and the page says the totals are a floor instead of
 * blocking the app or spinning forever.
 */
export const DEFAULT_STORAGE_SCAN_LIMITS: StorageScanBudgetLimits = {
  maxEntries: 400_000,
  maxBytes: 64 * GIB,
  maxDurationMs: 20_000,
};

export interface StorageScanBudget {
  /** Entries visited so far across every measurement. */
  readonly entries: number;
  readonly truncated: boolean;
  /** True once the caller should stop walking (time or a hard limit). */
  exhausted(): boolean;
  spendEntries(count: number): void;
}

/** A shared, monotonic budget so several measurements cannot exceed the scan's cost. */
export function createStorageScanBudget(
  options: {
    limits?: StorageScanBudgetLimits;
    now?: () => number;
  } = {},
): StorageScanBudget {
  const limits = options.limits ?? DEFAULT_STORAGE_SCAN_LIMITS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let entries = 0;
  let truncated = false;
  return {
    get entries() {
      return entries;
    },
    get truncated() {
      return truncated;
    },
    exhausted() {
      const expired = now() - startedAt >= limits.maxDurationMs;
      if (expired && !truncated) truncated = true;
      return truncated;
    },
    spendEntries(count: number) {
      entries += count;
      if (entries > limits.maxEntries) truncated = true;
    },
  };
}

export interface MeasuredPath {
  bytes: number;
  files: number;
  /** The walk stopped early (budget or an unreadable directory). */
  truncated: boolean;
}

const ZERO_MEASUREMENT: MeasuredPath = { bytes: 0, files: 0, truncated: false };

/**
 * Total bytes under `target`, counting regular files only. Symlinks are not
 * followed — Aiden's own stores never write them, and following one would let a
 * workspace link the scanner into an unrelated volume.
 */
export async function measurePathBytes(
  target: string,
  budget: StorageScanBudget,
  depthLimit = 24,
): Promise<MeasuredPath> {
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch {
    return ZERO_MEASUREMENT;
  }
  if (stats.isSymbolicLink()) return ZERO_MEASUREMENT;
  if (stats.isFile()) {
    budget.spendEntries(1);
    return { bytes: stats.size, files: 1, truncated: false };
  }
  if (!stats.isDirectory()) return ZERO_MEASUREMENT;

  let bytes = 0;
  let files = 0;
  let truncated = false;
  const stack: Array<{ directory: string; depth: number }> = [{ directory: target, depth: 0 }];
  while (stack.length > 0) {
    if (budget.exhausted()) {
      truncated = true;
      break;
    }
    const next = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(next.directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is a hole in the total, not a failure of the whole scan.
      truncated = true;
      continue;
    }
    budget.spendEntries(entries.length);
    for (const entry of entries) {
      if (budget.exhausted()) {
        truncated = true;
        break;
      }
      const entryPath = path.join(next.directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (next.depth < depthLimit) stack.push({ directory: entryPath, depth: next.depth + 1 });
        else truncated = true;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const fileStats = await fs.lstat(entryPath);
        if (!fileStats.isFile()) continue;
        bytes += fileStats.size;
        files += 1;
      } catch {
        truncated = true;
      }
    }
    if (truncated) break;
  }
  return { bytes, files, truncated };
}

/** Measure several paths as one bucket, sharing the scan budget. */
export async function measurePaths(
  targets: readonly string[],
  budget: StorageScanBudget,
): Promise<MeasuredPath> {
  let bytes = 0;
  let files = 0;
  let truncated = false;
  for (const target of targets) {
    const measured = await measurePathBytes(target, budget);
    bytes += measured.bytes;
    files += measured.files;
    truncated ||= measured.truncated;
  }
  return { bytes, files, truncated };
}

interface CleanupSelection {
  inactiveDays: StorageInactiveDays;
  now: number;
  /** Explicit picks bypass the inactivity window; protection still applies. */
  targetIds?: readonly string[];
}

function isSelected(id: string, targetIds: readonly string[] | undefined): boolean {
  return targetIds === undefined || targetIds.includes(id);
}

/**
 * Worktrees a "remove unused worktrees" run would delete, plus everything it
 * deliberately leaves behind. Protected worktrees are always skipped, even when
 * the caller named them explicitly.
 */
export function planWorktreeCleanup(
  worktrees: readonly StorageWorktreeView[],
  selection: CleanupSelection,
): StorageCleanupPreview {
  const cutoff = storageInactiveCutoff(selection.inactiveDays, selection.now);
  const explicitlyChosen = selection.targetIds !== undefined;
  const items: StorageItem[] = [];
  const skipped: StorageCleanupSkipped[] = [];
  for (const worktree of worktrees) {
    if (!isSelected(worktree.workspaceId, selection.targetIds)) continue;
    const protection = worktree.protectionReason;
    if (worktree.protected) {
      skipped.push({
        id: worktree.workspaceId,
        label: worktree.name,
        reason: protection ?? "active",
        bytes: worktree.bytes,
      });
      continue;
    }
    if (!explicitlyChosen && (worktree.lastUsedAt === null || worktree.lastUsedAt > cutoff)) {
      skipped.push({
        id: worktree.workspaceId,
        label: worktree.name,
        reason: "recent",
        bytes: worktree.bytes,
      });
      continue;
    }
    items.push({
      id: worktree.workspaceId,
      kind: "worktree",
      label: worktree.name,
      detail: worktree.branch,
      bytes: worktree.bytes,
    });
  }
  return {
    action: "remove-worktrees",
    inactiveDays: selection.inactiveDays,
    items,
    skipped,
    totalBytes: items.reduce((total, item) => total + item.bytes, 0),
  };
}

export function planThreadCleanup(
  threads: readonly StorageThreadView[],
  selection: CleanupSelection,
): StorageCleanupPreview {
  const cutoff = storageInactiveCutoff(selection.inactiveDays, selection.now);
  const explicitlyChosen = selection.targetIds !== undefined;
  const items: StorageItem[] = [];
  const skipped: StorageCleanupSkipped[] = [];
  for (const thread of threads) {
    if (!isSelected(thread.chatId, selection.targetIds)) continue;
    const protection = thread.protectionReason;
    if (thread.protected) {
      skipped.push({
        id: thread.chatId,
        label: thread.title,
        reason: protection ?? "active",
        bytes: thread.bytes,
      });
      continue;
    }
    if (!explicitlyChosen && thread.lastUsedAt > cutoff) {
      skipped.push({
        id: thread.chatId,
        label: thread.title,
        reason: "recent",
        bytes: thread.bytes,
      });
      continue;
    }
    items.push({
      id: thread.chatId,
      kind: "thread",
      label: thread.title,
      bytes: thread.bytes,
    });
  }
  return {
    action: "delete-threads",
    inactiveDays: selection.inactiveDays,
    items,
    skipped,
    totalBytes: items.reduce((total, item) => total + item.bytes, 0),
  };
}

/**
 * Logs and diagnostics are pure app output: nothing here is the person's work,
 * so "clear logs" always offers everything it measured.
 */
export function planLogCleanup(
  request: Pick<StorageCleanupRequest, "inactiveDays">,
  measured: { bytes: number; files: number },
): StorageCleanupPreview {
  const items: StorageItem[] =
    measured.files === 0
      ? []
      : [
          {
            id: "logs",
            kind: "logs",
            label: "Logs and diagnostics",
            detail: measured.files === 1 ? "1 file" : `${measured.files} files`,
            bytes: measured.bytes,
          },
        ];
  return {
    action: "clear-logs",
    inactiveDays: request.inactiveDays,
    items,
    skipped: [],
    totalBytes: measured.bytes,
  };
}

/** Build the preview for any action from an already-scanned report. */
export function planStorageCleanup(
  request: StorageCleanupRequest,
  report: Pick<StorageReport, "worktrees" | "threads" | "categories">,
  now: number,
): StorageCleanupPreview {
  const selection = {
    inactiveDays: request.inactiveDays,
    now,
    ...(request.targetIds === undefined ? {} : { targetIds: request.targetIds }),
  };
  if (request.action === "remove-worktrees") return planWorktreeCleanup(report.worktrees, selection);
  if (request.action === "delete-threads") return planThreadCleanup(report.threads, selection);
  const logs = report.categories.find((category) => category.id === "logs");
  return planLogCleanup(request, { bytes: logs?.bytes ?? 0, files: logs?.itemCount ?? 0 });
}

/**
 * Re-check one worktree against live facts immediately before removal. Returns
 * the reason it must be kept, or null when it is still safe to remove.
 */
export const recheckWorktreeRemoval = worktreeProtectionReason;

export const STORAGE_CATEGORY_ORDER: readonly StorageCategoryId[] = STORAGE_CATEGORY_IDS;

/** Force every category into the report in display order, filling gaps with zero. */
export function orderCategories(
  usage: readonly StorageCategoryUsage[],
): StorageCategoryUsage[] {
  return STORAGE_CATEGORY_ORDER.map((id) => {
    const found = usage.find((category) => category.id === id);
    return { id, bytes: found?.bytes ?? 0, itemCount: found?.itemCount ?? 0 };
  });
}
