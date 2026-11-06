// Desktop Settings → Storage: how much disk Aiden uses, by category, and the
// cleanup actions it offers. Shared by the main-process scanner, the IPC
// boundary, and the renderer page so both sides agree on names and limits.

/** Every category, in the order the scan measures them (cheapest and most important first). */
export const STORAGE_CATEGORY_IDS = [
  "threads",
  "logs",
  "artifacts",
  "browser",
  "models",
  "bot-computers",
  "snapshots",
  "other",
  "worktrees",
] as const;

export type StorageCategoryId = (typeof STORAGE_CATEGORY_IDS)[number];

/**
 * What the page offers on a category's row. `manage` opens the settings page
 * that owns the data; the others open a review before anything is removed.
 */
export type StorageCategoryAction =
  | { kind: "review-worktrees" }
  | { kind: "clear-browser-cache" }
  | { kind: "clear-logs" }
  | { kind: "manage"; section: "botComputers" | "voice" };

export interface StorageCategoryDefinition {
  id: StorageCategoryId;
  label: string;
  /** One line naming what the category holds, shown on its row. */
  description: string;
  action?: StorageCategoryAction;
}

export const STORAGE_CATEGORIES: readonly StorageCategoryDefinition[] = [
  {
    id: "threads",
    label: "Chats",
    description: "Chat history, the pictures in it, and Bots’ conversations and memory.",
  },
  {
    id: "logs",
    label: "Logs and diagnostics",
    description: "Diagnostic journal, crash reports and terminal scrollback.",
    action: { kind: "clear-logs" },
  },
  {
    id: "artifacts",
    label: "Artifacts and images",
    description: "Workspace artifacts, generated images and design projects.",
  },
  {
    id: "browser",
    label: "Browser data",
    description: "What the built-in browser and Bots’ browsers saved: sign-ins, site data and cached pages.",
    action: { kind: "clear-browser-cache" },
  },
  {
    id: "models",
    label: "Voice and helper models",
    description: "On-device speech and form-filling models Aiden downloaded.",
    action: { kind: "manage", section: "voice" },
  },
  {
    id: "bot-computers",
    label: "Bot computers",
    description: "The macOS base image and each Bot’s own computer.",
    action: { kind: "manage", section: "botComputers" },
  },
  {
    id: "snapshots",
    label: "Saved work from removed worktrees",
    description: "Kept so a worktree you removed with changes can be restored.",
  },
  {
    id: "other",
    label: "Other app data",
    description: "Settings, paired devices, agent runtimes and Aiden’s own caches.",
  },
  {
    id: "worktrees",
    label: "Worktrees",
    description: "Copies of your projects Aiden made for coding chats.",
    action: { kind: "review-worktrees" },
  },
];

export function storageCategory(id: StorageCategoryId): StorageCategoryDefinition {
  return STORAGE_CATEGORIES.find((category) => category.id === id)!;
}

export function storageCategoryLabel(id: StorageCategoryId): string {
  return STORAGE_CATEGORIES.find((category) => category.id === id)?.label ?? id;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  /** Disk space the category's files occupy, each file counted once. */
  bytes: number;
  /** Files measured for this category; 0 when nothing exists yet. */
  itemCount: number;
  /**
   * False when part of the category could not be measured (a skipped folder or
   * a spent budget), so its size and anything cleared from it are minimums.
   * Omitted means fully measured.
   */
  complete?: boolean;
}

/** One removable thing a cleanup preview lists. */
export interface StorageItem {
  id: string;
  kind: "worktree" | "thread" | "logs" | "browser-cache";
  label: string;
  detail?: string;
  bytes: number;
  /** False when the scan stopped before it finished measuring this item. */
  bytesComplete?: boolean;
}

/**
 * Why a worktree or chat may not be removed. Every reason is a hard block:
 * cleanup never deletes something Aiden cannot prove is idle and saved.
 */
export type StorageProtectionReason =
  | "unknown-git-state"
  | "active"
  | "terminal"
  | "changing"
  | "uncommitted"
  | "unpushed"
  | "routine"
  | "unknown-routines"
  | "pinned"
  | "owned";

export const STORAGE_PROTECTION_COPY: Readonly<Record<StorageProtectionReason, string>> = {
  "unknown-git-state": "Aiden couldn’t read its Git state",
  active: "A chat is using it right now",
  terminal: "A terminal is open in it",
  changing: "Aiden is changing it right now",
  uncommitted: "Has changes not committed to Git",
  unpushed: "Has commits that aren’t pushed",
  routine: "A scheduled task runs here",
  "unknown-routines": "Aiden couldn’t check its scheduled tasks",
  pinned: "Pinned in your Inbox",
  owned: "Belongs to a Bot or Design project",
};

export interface StorageWorktreeView {
  workspaceId: string;
  name: string;
  branch: string;
  bytes: number;
  /** False when the scan's budget ran out before this worktree was fully measured. */
  bytesComplete: boolean;
  lastUsedAt: number | null;
  idleDays: number | null;
  uncommitted: number;
  unpushed: number;
  protected: boolean;
  protectionReason?: StorageProtectionReason;
}

export interface StorageThreadView {
  chatId: string;
  title: string;
  /**
   * What deleting the chat frees: its transcript plus the pictures no other
   * chat shows. Pictures shared with another chat stay, so they are not counted.
   */
  bytes: number;
  bytesComplete: boolean;
  /** Pictures in this chat, shared or not. */
  imageCount: number;
  lastUsedAt: number;
  idleDays: number;
  protected: boolean;
  protectionReason?: StorageProtectionReason;
}

export interface StorageWorktreeFacts {
  workspaceId: string;
  name: string;
  branch: string;
  bytes: number;
  bytesComplete: boolean;
  lastUsedAt: number | null;
  uncommitted: number;
  unpushed: number;
  active: boolean;
  /** Removing the worktree would kill a shell open in it. */
  terminalOpen?: boolean;
  changing: boolean;
  gitStateKnown: boolean;
  /** Scheduled tasks that run in this workspace; null when they could not be read. */
  routineCount: number | null;
}

/**
 * The first reason a worktree must be kept, or null when removing it loses
 * nothing. Unreadable facts come first on purpose: a failed read must never
 * count as "clean" or "no scheduled tasks".
 */
export function worktreeProtectionReason(
  facts: StorageWorktreeFacts,
): StorageProtectionReason | null {
  if (!facts.gitStateKnown) return "unknown-git-state";
  if (facts.routineCount === null) return "unknown-routines";
  if (facts.active) return "active";
  if (facts.terminalOpen) return "terminal";
  if (facts.changing) return "changing";
  if (facts.uncommitted > 0) return "uncommitted";
  if (facts.unpushed > 0) return "unpushed";
  if (facts.routineCount > 0) return "routine";
  return null;
}

export function classifyWorktree(facts: StorageWorktreeFacts, now: number): StorageWorktreeView {
  const view: StorageWorktreeView = {
    workspaceId: facts.workspaceId,
    name: facts.name,
    branch: facts.branch,
    bytes: facts.bytes,
    bytesComplete: facts.bytesComplete,
    lastUsedAt: facts.lastUsedAt,
    idleDays: storageIdleDays(facts.lastUsedAt, now),
    uncommitted: facts.uncommitted,
    unpushed: facts.unpushed,
    protected: false,
  };
  const reason = worktreeProtectionReason(facts);
  if (reason) {
    view.protected = true;
    view.protectionReason = reason;
  }
  return view;
}

export interface StorageThreadFacts {
  chatId: string;
  title: string;
  bytes: number;
  bytesComplete: boolean;
  imageCount: number;
  lastUsedAt: number;
  active: boolean;
  pinned: boolean;
  owned: boolean;
}

export function threadProtectionReason(
  facts: Pick<StorageThreadFacts, "active" | "pinned" | "owned">,
): StorageProtectionReason | null {
  if (facts.owned) return "owned";
  if (facts.active) return "active";
  if (facts.pinned) return "pinned";
  return null;
}

export function classifyThread(facts: StorageThreadFacts, now: number): StorageThreadView {
  const view: StorageThreadView = {
    chatId: facts.chatId,
    title: facts.title,
    bytes: facts.bytes,
    bytesComplete: facts.bytesComplete,
    imageCount: facts.imageCount,
    lastUsedAt: facts.lastUsedAt,
    idleDays: storageIdleDays(facts.lastUsedAt, now) ?? 0,
    protected: false,
  };
  const reason = threadProtectionReason(facts);
  if (reason) {
    view.protected = true;
    view.protectionReason = reason;
  }
  return view;
}

export type StorageScanStatus = "idle" | "scanning" | "ready" | "failed";

export interface StorageScanState {
  status: StorageScanStatus;
  scannedAt: number | null;
  error: string | null;
  /** The walk hit its time or file budget, so totals are a minimum. */
  truncated: boolean;
}

export interface StorageReport {
  totalBytes: number;
  categories: StorageCategoryUsage[];
  worktrees: StorageWorktreeView[];
  threads: StorageThreadView[];
  /** The part of Browser data that Clear cache removes (cached pages and code). */
  browserCacheBytes: number;
  scan: StorageScanState;
}

export function assembleStorageReport(input: {
  categories: readonly StorageCategoryUsage[];
  worktrees: readonly StorageWorktreeView[];
  threads: readonly StorageThreadView[];
  browserCacheBytes: number;
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
    browserCacheBytes: input.browserCacheBytes,
    scan: input.scan,
  };
}

export function emptyStorageReport(scan: StorageScanState): StorageReport {
  return assembleStorageReport({
    categories: STORAGE_CATEGORY_IDS.map((id) => ({ id, bytes: 0, itemCount: 0 })),
    worktrees: [],
    threads: [],
    browserCacheBytes: 0,
    scan,
  });
}

/**
 * `delete-threads` only ever deletes chats the person named one at a time;
 * there is no "delete every old chat" sweep.
 */
export const STORAGE_CLEANUP_ACTIONS = [
  "remove-worktrees",
  "delete-threads",
  "clear-logs",
  "clear-browser-cache",
] as const;

export type StorageCleanupAction = (typeof STORAGE_CLEANUP_ACTIONS)[number];

/** Inactivity thresholds offered for worktrees, in days. */
export const STORAGE_INACTIVE_DAYS = [7, 14, 30, 90] as const;
export type StorageInactiveDays = (typeof STORAGE_INACTIVE_DAYS)[number];
export const DEFAULT_STORAGE_INACTIVE_DAYS: StorageInactiveDays = 14;
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
   * still eligible when it runs. Required for `delete-threads`; omit for a
   * worktree sweep to let Aiden rebuild the set from the inactivity window.
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
  if (record.action === "delete-threads" && (targetIds === undefined || targetIds.length !== 1)) {
    throw new Error("Chats are deleted one at a time.");
  }
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
  /** A `StorageProtectionReason`, or `recent` for an item inside the inactivity window. */
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
  /** False when an item's size is a minimum because the scan stopped early. */
  totalComplete: boolean;
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
