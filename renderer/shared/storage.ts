// Desktop Settings → Storage: how much disk Aiden uses, by category, and the
// cleanup actions it offers. Shared by the main-process scanner, the IPC
// boundary, and the renderer page so both sides agree on names and limits.

export const STORAGE_CATEGORY_IDS = [
  "worktrees",
  "snapshots",
  "threads",
  "artifacts",
  "logs",
  "caches",
  "downloads",
] as const;

export type StorageCategoryId = (typeof STORAGE_CATEGORY_IDS)[number];

export interface StorageCategoryDefinition {
  id: StorageCategoryId;
  label: string;
  /** One line naming what the category holds, shown under its bar segment row. */
  description: string;
}

/** Ordered most to least likely to be cleaned up; the bar follows this order. */
export const STORAGE_CATEGORIES: readonly StorageCategoryDefinition[] = [
  {
    id: "worktrees",
    label: "Worktrees",
    description: "Checkouts Aiden made for chats, one per branch.",
  },
  {
    id: "snapshots",
    label: "Worktree snapshots",
    description: "Restorable copies kept when Aiden removed a worktree with uncommitted work.",
  },
  {
    id: "threads",
    label: "Threads",
    description: "Chat transcripts, their images, and private per-chat runtime history.",
  },
  {
    id: "artifacts",
    label: "Artifacts",
    description: "Workspace artifact snapshots, generated images, and design projects.",
  },
  {
    id: "logs",
    label: "Logs and diagnostics",
    description: "Local diagnostic journal, crash dumps, and terminal scrollback.",
  },
  {
    id: "caches",
    label: "Caches",
    description: "Regenerable indexes, paired-device state, and background job records.",
  },
  {
    id: "downloads",
    label: "Downloads",
    description: "Voice models, agent runtimes, and Bot computer images Aiden downloaded.",
  },
];

export function storageCategoryLabel(id: StorageCategoryId): string {
  return STORAGE_CATEGORIES.find((category) => category.id === id)?.label ?? id;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  /** Directories or records measured for this category; 0 when nothing exists yet. */
  itemCount: number;
}

/** One removable or inspectable thing inside a category. */
export interface StorageItem {
  id: string;
  kind: "worktree" | "thread" | "logs";
  label: string;
  detail?: string;
  bytes: number;
}

/**
 * Why a worktree or thread may not be removed. Every reason is a hard block:
 * cleanup never deletes something Aiden cannot prove is idle and saved.
 */
export type StorageProtectionReason =
  | "uncommitted"
  | "unpushed"
  | "active"
  | "changing"
  | "unknown-git-state"
  | "pinned"
  | "owned";

export const STORAGE_PROTECTION_COPY: Readonly<Record<StorageProtectionReason, string>> = {
  uncommitted: "Has uncommitted changes",
  unpushed: "Has commits that aren’t pushed",
  active: "A chat is using it right now",
  changing: "Aiden is changing it right now",
  "unknown-git-state": "Aiden couldn’t read its Git state",
  pinned: "Pinned in your Inbox",
  owned: "Belongs to another Aiden feature",
};

export interface StorageWorktreeView {
  workspaceId: string;
  name: string;
  branch: string;
  bytes: number;
  lastUsedAt: number | null;
  /** Whole days since `lastUsedAt`, or null when Aiden has no record of use. */
  idleDays: number | null;
  /** Changed and untracked files Git reports. */
  uncommitted: number;
  /** Commits the branch has not pushed anywhere. */
  unpushed: number;
  protected: boolean;
  protectionReason?: StorageProtectionReason;
}

export interface StorageThreadView {
  chatId: string;
  title: string;
  bytes: number;
  lastUsedAt: number;
  idleDays: number;
  protected: boolean;
  protectionReason?: StorageProtectionReason;
}

export type StorageScanStatus = "idle" | "scanning" | "ready" | "failed";

export interface StorageScanState {
  status: StorageScanStatus;
  /** When the last completed scan started, so the page can say how fresh it is. */
  scannedAt: number | null;
  /** Present when the last scan failed as a whole. */
  error: string | null;
  /** True when a bound stopped the walk early and the totals are a floor. */
  truncated: boolean;
}

export interface StorageReport {
  totalBytes: number;
  categories: StorageCategoryUsage[];
  /** Largest worktrees, biggest first. */
  worktrees: StorageWorktreeView[];
  /** Largest threads, biggest first. */
  threads: StorageThreadView[];
  scan: StorageScanState;
}

/** Build a report: the total derives from the categories and items sort by size. */
export function assembleStorageReport(input: {
  categories: readonly StorageCategoryUsage[];
  worktrees: readonly StorageWorktreeView[];
  threads: readonly StorageThreadView[];
  scan: StorageScanState;
}): StorageReport {
  const bySize = (
    a: { bytes: number; lastUsedAt: number | null },
    b: { bytes: number; lastUsedAt: number | null },
  ) => (b.bytes === a.bytes ? (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) : b.bytes - a.bytes);
  return {
    totalBytes: input.categories.reduce((total, category) => total + category.bytes, 0),
    categories: [...input.categories],
    worktrees: [...input.worktrees].sort(bySize),
    threads: [...input.threads].sort(bySize),
    scan: input.scan,
  };
}

/** Every category at zero, so the bar and legend have a stable shape while scanning. */
export function emptyStorageReport(scan: StorageScanState): StorageReport {
  return assembleStorageReport({
    categories: STORAGE_CATEGORY_IDS.map((id) => ({ id, bytes: 0, itemCount: 0 })),
    worktrees: [],
    threads: [],
    scan,
  });
}

export const STORAGE_CLEANUP_ACTIONS = [
  "remove-worktrees",
  "delete-threads",
  "clear-logs",
] as const;

export type StorageCleanupAction = (typeof STORAGE_CLEANUP_ACTIONS)[number];

/** Inactivity thresholds offered for worktrees and threads, in days. */
export const STORAGE_INACTIVE_DAYS = [7, 14, 30, 90] as const;
export type StorageInactiveDays = (typeof STORAGE_INACTIVE_DAYS)[number];
export const DEFAULT_STORAGE_INACTIVE_DAYS: StorageInactiveDays = 14;
export const DEFAULT_THREAD_INACTIVE_DAYS: StorageInactiveDays = 90;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function isStorageInactiveDays(value: unknown): value is StorageInactiveDays {
  return STORAGE_INACTIVE_DAYS.includes(value as StorageInactiveDays);
}

export function isStorageCleanupAction(value: unknown): value is StorageCleanupAction {
  return STORAGE_CLEANUP_ACTIONS.includes(value as StorageCleanupAction);
}

export interface StorageCleanupRequest {
  action: StorageCleanupAction;
  inactiveDays: StorageInactiveDays;
  /**
   * Ids the preview showed. Cleanup removes only these, and only if they are
   * still eligible when it runs. Omit to let Aiden rebuild the full set.
   */
  targetIds?: string[];
}

/** Strict parse of an IPC cleanup request; anything unexpected is rejected. */
export function parseStorageCleanupRequest(value: unknown): StorageCleanupRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid storage cleanup request.");
  }
  const record = value as Record<string, unknown>;
  if (!isStorageCleanupAction(record.action)) throw new Error("Unknown storage cleanup action.");
  const inactiveDays = record.inactiveDays ?? DEFAULT_STORAGE_INACTIVE_DAYS;
  if (!isStorageInactiveDays(inactiveDays)) throw new Error("Invalid inactivity window.");
  const targetIds = parseTargetIds(record.targetIds);
  return targetIds === undefined
    ? { action: record.action, inactiveDays }
    : { action: record.action, inactiveDays, targetIds };
}

function parseTargetIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error("Invalid cleanup selection.");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) {
      throw new Error("Invalid cleanup selection.");
    }
  }
  return [...new Set(value as string[])];
}

export interface StorageCleanupSkipped {
  id: string;
  label: string;
  reason: string;
  bytes: number;
}

export interface StorageCleanupPreview {
  action: StorageCleanupAction;
  inactiveDays: StorageInactiveDays;
  /** What confirming removes, with the space each frees. */
  items: StorageItem[];
  /** What the action leaves alone, and why. Never removed. */
  skipped: StorageCleanupSkipped[];
  totalBytes: number;
}

export interface StorageCleanupFailure {
  id: string;
  label: string;
  reason: string;
}

export interface StorageCleanupResult {
  removed: StorageItem[];
  skipped: StorageCleanupSkipped[];
  failed: StorageCleanupFailure[];
  freedBytes: number;
}

/** Whole days between `at` and `now`, floored at zero. */
export function storageIdleDays(at: number | null | undefined, now: number): number | null {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

export function storageInactiveCutoff(inactiveDays: number, now: number): number {
  return now - Math.max(0, Math.floor(inactiveDays)) * DAY_MS;
}

/** Decimal units, matching what macOS and download pages show. */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) {
    const megabytes = bytes / 1_000_000;
    return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
  }
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/** A share of the total for one bar segment, in percent, rounded to 0.1. */
export function storageSharePercent(bytes: number, totalBytes: number): number {
  if (totalBytes <= 0 || bytes <= 0) return 0;
  return Math.round(Math.min(100, (bytes / totalBytes) * 100) * 10) / 10;
}
