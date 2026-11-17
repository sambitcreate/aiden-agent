// Desktop Settings → Storage: measuring, classifying, and planning.
//
// Everything here is either a filesystem walk with a hard budget or a pure
// function over already-read facts, so the safety rules that decide what may be
// deleted are testable without Electron, Git, or a real profile directory.

import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
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

export interface StorageScanBudgetLimits {
  maxEntries: number;
  maxDurationMs: number;
}

/**
 * Defaults for one background scan. A large profile can exceed these; the walk
 * then reports `truncated` and the page says the totals are a minimum instead
 * of blocking the app or spinning forever. The walk measures worktrees last, so
 * running out of budget only leaves worktree sizes unfinished.
 */
export const DEFAULT_STORAGE_SCAN_LIMITS: StorageScanBudgetLimits = {
  maxEntries: 1_000_000,
  maxDurationMs: 20_000,
};

export interface StorageScanBudget {
  /** Entries visited so far across every measurement. */
  readonly entries: number;
  readonly truncated: boolean;
  /** True once the caller should stop walking (time or entry limit). */
  exhausted(): boolean;
  spendEntries(count: number): void;
  /**
   * Whether this file's bytes still need counting. A hard-linked file (chat
   * images share bytes this way) is counted the first time any path reaches it.
   */
  firstSighting(stats: Pick<Stats, "dev" | "ino" | "nlink">): boolean;
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
  const linked = new Set<string>();
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
      if (!truncated && now() - startedAt >= limits.maxDurationMs) truncated = true;
      return truncated;
    },
    spendEntries(count: number) {
      entries += count;
      if (entries > limits.maxEntries) truncated = true;
    },
    firstSighting(stats) {
      if (stats.nlink <= 1) return true;
      const key = `${stats.dev}:${stats.ino}`;
      if (linked.has(key)) return false;
      linked.add(key);
      return true;
    },
  };
}

/**
 * Space a file takes on disk. Allocated blocks rather than the apparent size:
 * a Bot computer's disk image is sparse, so its apparent size can be many times
 * what it really occupies. Windows reports no blocks, so it falls back to size.
 */
export function diskBytes(stats: Pick<Stats, "size" | "blocks">): number {
  return typeof stats.blocks === "number" && Number.isFinite(stats.blocks) && stats.blocks >= 0
    && process.platform !== "win32"
    ? stats.blocks * 512
    : stats.size;
}

export interface MeasuredPath {
  bytes: number;
  files: number;
  /** The walk stopped early (budget or an unreadable directory). */
  truncated: boolean;
}

export interface MeasureOptions {
  /** Directories measured separately (each worktree); the walk skips them. */
  exclude?: ReadonlySet<string>;
  /** Called with each counted file, so a caller can attribute bytes without a second walk. */
  onFile?: (filePath: string, bytes: number) => void;
  depthLimit?: number;
}

const ZERO_MEASUREMENT: MeasuredPath = { bytes: 0, files: 0, truncated: false };

/**
 * Disk space under `target`, counting regular files only, each hard-linked file
 * once per scan. Symlinks are not followed: following one would let a
 * workspace link the scanner into an unrelated volume.
 */
export async function measurePathBytes(
  target: string,
  budget: StorageScanBudget,
  options: MeasureOptions = {},
): Promise<MeasuredPath> {
  const depthLimit = options.depthLimit ?? 24;
  if (budget.exhausted()) return { ...ZERO_MEASUREMENT, truncated: true };
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch {
    return ZERO_MEASUREMENT;
  }
  if (stats.isSymbolicLink()) return ZERO_MEASUREMENT;
  if (stats.isFile()) {
    budget.spendEntries(1);
    if (!budget.firstSighting(stats)) return { bytes: 0, files: 1, truncated: false };
    const bytes = diskBytes(stats);
    options.onFile?.(target, bytes);
    return { bytes, files: 1, truncated: false };
  }
  if (!stats.isDirectory()) return ZERO_MEASUREMENT;

  let bytes = 0;
  let files = 0;
  // A hole (unreadable folder or file, or too deep) is skipped and marks the
  // result partial; only a spent budget stops the walk.
  let truncated = false;
  let stopped = false;
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
        stopped = true;
        break;
      }
      const entryPath = path.join(next.directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (options.exclude?.has(entryPath)) continue;
        if (next.depth < depthLimit) stack.push({ directory: entryPath, depth: next.depth + 1 });
        else truncated = true;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const fileStats = await fs.lstat(entryPath);
        if (!fileStats.isFile()) continue;
        files += 1;
        if (!budget.firstSighting(fileStats)) continue;
        const fileBytes = diskBytes(fileStats);
        bytes += fileBytes;
        options.onFile?.(entryPath, fileBytes);
      } catch {
        truncated = true;
      }
    }
    if (stopped) break;
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

function preview(
  action: StorageCleanupPreview["action"],
  inactiveDays: StorageInactiveDays,
  items: StorageItem[],
  skipped: StorageCleanupSkipped[],
): StorageCleanupPreview {
  return {
    action,
    inactiveDays,
    items,
    skipped,
    totalBytes: items.reduce((total, item) => total + item.bytes, 0),
    totalComplete: items.every((item) => item.bytesComplete !== false),
  };
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
    if (worktree.protected) {
      skipped.push({
        id: worktree.workspaceId,
        label: worktree.name,
        reason: worktree.protectionReason ?? "active",
        bytes: worktree.bytes,
      });
      continue;
    }
    if (!explicitlyChosen && (worktree.lastUsedAt === null || worktree.lastUsedAt > cutoff)) {
      // Recently used worktrees are simply outside the window; they are not
      // listed as "kept", which would read as a warning.
      continue;
    }
    items.push({
      id: worktree.workspaceId,
      kind: "worktree",
      label: worktree.name,
      detail: worktree.branch,
      bytes: worktree.bytes,
      bytesComplete: worktree.bytesComplete,
    });
  }
  return preview("remove-worktrees", selection.inactiveDays, items, skipped);
}

/**
 * The one chat a person asked to delete, or why it is kept. There is no sweep:
 * without an explicit id nothing is offered.
 */
export function planThreadCleanup(
  threads: readonly StorageThreadView[],
  selection: CleanupSelection,
): StorageCleanupPreview {
  const items: StorageItem[] = [];
  const skipped: StorageCleanupSkipped[] = [];
  const targets = selection.targetIds ?? [];
  for (const thread of threads) {
    if (!targets.includes(thread.chatId)) continue;
    if (thread.protected) {
      skipped.push({
        id: thread.chatId,
        label: thread.title,
        reason: thread.protectionReason ?? "active",
        bytes: thread.bytes,
      });
      continue;
    }
    items.push({
      id: thread.chatId,
      kind: "thread",
      label: thread.title,
      bytes: thread.bytes,
      bytesComplete: thread.bytesComplete,
    });
  }
  return preview("delete-threads", selection.inactiveDays, items, skipped);
}

/**
 * Logs and diagnostics are pure app output: nothing here is the person's work,
 * so "clear logs" always offers everything it measured.
 */
export function planLogCleanup(
  inactiveDays: StorageInactiveDays,
  measured: { bytes: number; files: number; complete?: boolean },
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
            bytesComplete: measured.complete !== false,
          },
        ];
  return preview("clear-logs", inactiveDays, items, []);
}

/** Cached pages and files in the browser profiles; sign-ins are not part of it. */
export function planBrowserCacheCleanup(
  inactiveDays: StorageInactiveDays,
  cacheBytes: number,
  complete = true,
): StorageCleanupPreview {
  const items: StorageItem[] =
    cacheBytes <= 0
      ? []
      : [
          {
            id: "browser-cache",
            kind: "browser-cache",
            label: "Cached pages and files",
            bytes: cacheBytes,
            bytesComplete: complete,
          },
        ];
  return preview("clear-browser-cache", inactiveDays, items, []);
}

/** Build the preview for any action from an already-scanned report. */
export function planStorageCleanup(
  request: StorageCleanupRequest,
  report: Pick<StorageReport, "worktrees" | "threads" | "categories" | "browserCacheBytes">,
  now: number,
): StorageCleanupPreview {
  const selection = {
    inactiveDays: request.inactiveDays,
    now,
    ...(request.targetIds === undefined ? {} : { targetIds: request.targetIds }),
  };
  switch (request.action) {
    case "remove-worktrees":
      return planWorktreeCleanup(report.worktrees, selection);
    case "delete-threads":
      return planThreadCleanup(report.threads, selection);
    case "clear-browser-cache": {
      // Every cache folder lives in a Browser data entry, so a partial walk there
      // makes the clearable amount a minimum too.
      const browser = report.categories.find((category) => category.id === "browser");
      return planBrowserCacheCleanup(request.inactiveDays, report.browserCacheBytes, browser?.complete !== false);
    }
    case "clear-logs": {
      const logs = report.categories.find((category) => category.id === "logs");
      return planLogCleanup(request.inactiveDays, {
        bytes: logs?.bytes ?? 0,
        files: logs?.itemCount ?? 0,
        complete: logs?.complete !== false,
      });
    }
  }
}

/**
 * Re-check one worktree against live facts immediately before removal. Returns
 * the reason it must be kept, or null when it is still safe to remove.
 */
export const recheckWorktreeRemoval = worktreeProtectionReason;

/** Force every category into the report in scan order, filling gaps with zero. */
export function orderCategories(
  usage: readonly StorageCategoryUsage[],
): StorageCategoryUsage[] {
  return STORAGE_CATEGORY_IDS.map((id: StorageCategoryId) => {
    const found = usage.filter((category) => category.id === id);
    return {
      id,
      bytes: found.reduce((total, category) => total + category.bytes, 0),
      itemCount: found.reduce((total, category) => total + category.itemCount, 0),
      complete: found.every((category) => category.complete !== false),
    };
  });
}
