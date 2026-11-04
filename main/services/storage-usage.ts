// Desktop Settings → Storage: the main-process inventory service.
//
// A scan runs off the IPC path: `report()` returns the cached snapshot at once
// and, when it is stale, starts a background walk that broadcasts
// `storage:changed` when it finishes. The renderer therefore never waits on a
// directory walk, and a slow disk only delays the numbers, not the page.
//
// Deletion is decided here, not in the renderer: every cleanup re-reads live
// Git and activity facts and refuses anything with local work or a live user.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatMeta, Workspace } from "./types.js";
import {
  createStorageScanBudget,
  measurePathBytes,
  orderCategories,
  planStorageCleanup,
  recheckWorktreeRemoval,
  DEFAULT_STORAGE_SCAN_LIMITS,
  type StorageScanBudget,
  type StorageScanBudgetLimits,
} from "./storage-usage-core.js";
import { storageCategoryPaths } from "./storage-profile-inventory.js";
import {
  assembleStorageReport,
  classifyThread,
  classifyWorktree,
  DEFAULT_STORAGE_INACTIVE_DAYS,
  emptyStorageReport,
  STORAGE_CATEGORY_IDS,
  STORAGE_INACTIVE_DAYS,
  threadProtectionReason,
  worktreeProtectionReason,
  type StorageCategoryUsage,
  type StorageCleanupPreview,
  type StorageCleanupResult,
  type StorageCleanupSkipped,
  type StorageInactiveDays,
  type StorageItem,
  type StorageReport,
  type StorageScanState,
  type StorageThreadFacts,
  type StorageThreadView,
  type StorageWorktreeFacts,
  type StorageWorktreeView,
} from "../../renderer/shared/storage.js";

/** A scan older than this is refreshed on the next read, in the background. */
export const STORAGE_SCAN_STALE_MS = 60_000;

/** Longest transcript read to attribute its images; larger files skip that step. */
const MAX_TRANSCRIPT_ATTRIBUTION_BYTES = 4 * 1024 * 1024;

const IMAGE_HASH = /"sha256"\s*:\s*"([0-9a-f]{64})"/gu;
const SHAARD_NAME = /^[0-9a-f]{2}$/u;
const IMAGE_FILE_NAME = /^[0-9a-f]{64}$/u;

export interface WorktreeGitState {
  uncommitted: number;
  unpushed: number;
}

/**
 * A pin read that failed is `unknown`, not empty. Cleanup must treat that as
 * "every thread may be pinned": losing a pinned chat to a transient triage
 * read is not recoverable, while skipping cleanup is.
 */
export type ThreadPinState =
  | { kind: "known"; pinned: ReadonlySet<string> }
  | { kind: "unknown" };

export interface StorageCleanupScope {
  action: "remove-worktrees" | "delete-threads" | "clear-logs";
  inactiveDays: StorageInactiveDays;
  targetIds?: string[];
}

export interface StorageServiceDependencies {
  profileRoot(): string;
  listWorkspaces(): Promise<Workspace[]>;
  listChats(): Promise<ChatMeta[]>;
  /** Chats whose generation or subagent work is live right now. */
  isChatBusy(chatId: string): boolean;
  /** Workspaces with an in-flight create or remove. */
  isWorkspaceChanging(workspaceId: string): boolean;
  /** Chats the person pinned in the Inbox; a rejection means the state is unknown. */
  pinnedChatIds(): Promise<ReadonlySet<string>>;
  /** Remove one managed worktree through Aiden's own transactional path. */
  removeWorktree(workspaceId: string): Promise<void>;
  /** Remove one chat and everything it owns. */
  removeChat(chatId: string): Promise<void>;
  /** Read a worktree's Git status; throws when Git cannot be read. */
  worktreeGitState(input: {
    repositoryPath: string;
    worktreePath: string;
    branch: string;
  }): Promise<WorktreeGitState>;
  /** Read a transcript file's bytes, bounded; undefined when too large or unreadable. */
  readTranscript(filePath: string, maxBytes: number): Promise<Buffer | undefined>;
  /** Erase Aiden's logs and diagnostics through the diagnostics owner. */
  clearLogs(): Promise<void>;
  now?(): number;
  broadcast?(event: { kind: "scan-started" | "scan-finished" }): void;
  logError?(area: string, message: string, error: unknown): void;
  /** Test seam for the walk budget. */
  limits?: StorageScanBudgetLimits;
}

export interface StorageUsageService {
  /** Cached report; starts a background scan when the cache is missing or stale. */
  report(): Promise<StorageReport>;
  /** Force a fresh scan and await it (used by cleanup and by tests). */
  refresh(): Promise<StorageReport>;
  /** What an action would remove, with each item's size. */
  preview(scope: StorageCleanupScope): Promise<StorageCleanupPreview>;
  cleanup(scope: StorageCleanupScope): Promise<StorageCleanupResult>;
  /** Stop accepting scan results (the window closed or the app is quitting). */
  dispose(): void;
}

/**
 * Build the storage service over injected profile, Git, and deletion ports so
 * the safety rules are testable without Electron, a live profile, or Git.
 */
export function createStorageUsageService(
  dependencies: StorageServiceDependencies,
): StorageUsageService {
  const now = dependencies.now ?? Date.now;
  const limits = dependencies.limits ?? DEFAULT_STORAGE_SCAN_LIMITS;
  let cached: { report: StorageReport; scannedAt: number } | null = null;
  let inFlight: Promise<StorageReport> | null = null;
  let disposed = false;

  async function runScan(): Promise<StorageReport> {
    const startedAt = now();
    const budget = createStorageScanBudget({ limits, now });
    const profileRoot = dependencies.profileRoot();

    const [workspaces, chats, pins] = await Promise.all([
      dependencies.listWorkspaces(),
      dependencies.listChats(),
      readPinState(),
    ]);

    // Every category total comes from measuring the profile's own directories,
    // so files Aiden no longer tracks still count while they occupy the disk.
    const categories: StorageCategoryUsage[] = [];
    for (const category of STORAGE_CATEGORY_IDS) {
      let bytes = 0;
      let itemCount = 0;
      for (const target of storageCategoryPaths(profileRoot, category)) {
        const measured = await measurePathBytes(target, budget);
        bytes += measured.bytes;
        itemCount += measured.files;
      }
      categories.push({ id: category, bytes, itemCount });
    }

    const worktrees = await measureWorktrees(profileRoot, workspaces, chats, budget);
    const threads = await measureThreads(profileRoot, chats, pins, budget);

    const scan: StorageScanState = {
      status: "ready",
      scannedAt: startedAt,
      error: null,
      truncated: budget.truncated,
    };
    return assembleStorageReport({
      categories: orderCategories(categories),
      worktrees,
      threads,
      scan,
    });
  }

  async function measureWorktrees(
    profileRoot: string,
    workspaces: readonly Workspace[],
    chats: readonly ChatMeta[],
    budget: StorageScanBudget,
  ): Promise<StorageWorktreeView[]> {
    const managed = workspaces.filter((workspace) => workspace.managedWorktree);
    if (managed.length === 0) return [];
    const worktreeRoot = path.join(profileRoot, "worktrees");
    const lastChatAt = new Map<string, number>();
    for (const chat of chats) {
      if (!chat.workspaceId) continue;
      const previous = lastChatAt.get(chat.workspaceId) ?? 0;
      if (chat.updatedAt > previous) lastChatAt.set(chat.workspaceId, chat.updatedAt);
    }
    const views: StorageWorktreeView[] = [];
    for (const workspace of managed) {
      if (budget.exhausted()) break;
      const tree = workspace.managedWorktree!;
      // Only paths under Aiden's worktree root are measured; a record pointing
      // elsewhere reports zero rather than walking an unrelated directory.
      const relative = path.relative(worktreeRoot, tree.worktreePath);
      const insideRoot = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      const bytes = insideRoot ? (await measurePathBytes(tree.worktreePath, budget)).bytes : 0;
      let gitState: WorktreeGitState | null = null;
      try {
        gitState = await dependencies.worktreeGitState({
          repositoryPath: tree.repositoryPath,
          worktreePath: tree.worktreePath,
          branch: tree.branch,
        });
      } catch {
        gitState = null;
      }
      const lastUsedAt =
        Math.max(
          workspace.updatedAt ?? 0,
          workspace.createdAt ?? 0,
          lastChatAt.get(workspace.id) ?? 0,
        ) || null;
      const facts: StorageWorktreeFacts = {
        workspaceId: workspace.id,
        name: workspace.name,
        branch: tree.branch,
        bytes,
        lastUsedAt,
        uncommitted: gitState?.uncommitted ?? 0,
        unpushed: gitState?.unpushed ?? 0,
        active: chats.some(
          (chat) => chat.workspaceId === workspace.id && dependencies.isChatBusy(chat.id),
        ),
        changing: dependencies.isWorkspaceChanging(workspace.id),
        gitStateKnown: gitState !== null,
      };
      views.push(classifyWorktree(facts, now()));
    }
    return views;
  }

  async function measureThreads(
    profileRoot: string,
    chats: readonly ChatMeta[],
    pinState: ThreadPinState,
    budget: StorageScanBudget,
  ): Promise<StorageThreadView[]> {
    const chatsDir = path.join(profileRoot, "chats");
    // The image pass shares the scan budget, so a large store cannot outlive the
    // documented limit. When it runs out, attribution stops and the thread's own
    // bytes still count.
    const imageSizes = await imageFileSizes(path.join(chatsDir, "images"), budget);
    const views: StorageThreadView[] = [];
    for (const chat of chats) {
      if (budget.exhausted()) break;
      const transcript = path.join(chatsDir, `${chat.id}.json`);
      let bytes = 0;
      let size = 0;
      try {
        const stats = await fs.lstat(transcript);
        if (stats.isFile()) size = stats.size;
      } catch {
        // A chat whose file is gone holds no disk; it still lists at zero.
      }
      budget.spendEntries(1);
      bytes += size;
      if (size > 0 && size <= MAX_TRANSCRIPT_ATTRIBUTION_BYTES && !budget.exhausted()) {
        const contents = await dependencies
          .readTranscript(transcript, MAX_TRANSCRIPT_ATTRIBUTION_BYTES)
          .catch(() => undefined);
        if (contents) bytes += attributedImageBytes(contents.toString("utf8"), imageSizes);
      }
      const facts: StorageThreadFacts = {
        chatId: chat.id,
        title: chat.title,
        bytes,
        lastUsedAt: chat.updatedAt,
        active: dependencies.isChatBusy(chat.id),
        // An unreadable triage store protects every chat instead of unpinning
        // the whole Inbox: a failed read must never allow a pinned chat's delete.
        pinned: pinState.kind === "unknown" || pinState.pinned.has(chat.id),
        owned: chat.owner !== undefined || chat.botId !== undefined,
      };
      views.push(classifyThread(facts, now()));
    }
    return views;
  }

  function idleReport(): StorageReport {
    return emptyStorageReport({
      status: "idle",
      scannedAt: null,
      error: null,
      truncated: false,
    });
  }

  function isStale(): boolean {
    return cached === null || now() - cached.scannedAt >= STORAGE_SCAN_STALE_MS;
  }

  function startScan(): Promise<StorageReport> {
    if (inFlight) return inFlight;
    const startedAt = now();
    if (cached) {
      cached = {
        scannedAt: cached.scannedAt,
        report: { ...cached.report, scan: { ...cached.report.scan, status: "scanning" } },
      };
    }
    dependencies.broadcast?.({ kind: "scan-started" });
    inFlight = (async () => {
      try {
        const report = await runScan();
        if (!disposed) cached = { report, scannedAt: report.scan.scannedAt ?? startedAt };
        return report;
      } catch (error) {
        dependencies.logError?.("storage", "Aiden could not measure local storage.", error);
        const message = "Aiden could not finish measuring local storage. Try again.";
        const failed: StorageReport = cached
          ? { ...cached.report, scan: { ...cached.report.scan, status: "failed", error: message } }
          : emptyStorageReport({ status: "failed", scannedAt: startedAt, error: message, truncated: false });
        if (!disposed) cached = { report: failed, scannedAt: startedAt };
        return failed;
      } finally {
        inFlight = null;
        dependencies.broadcast?.({ kind: "scan-finished" });
      }
    })();
    return inFlight;
  }

  /** Read the Inbox pins, treating a failure as unknown rather than empty. */
  async function readPinState(): Promise<ThreadPinState> {
    try {
      return { kind: "known", pinned: await dependencies.pinnedChatIds() };
    } catch (error) {
      dependencies.logError?.("storage", "Aiden could not read Inbox pins for cleanup.", error);
      return { kind: "unknown" };
    }
  }

  /** A report fresh enough to decide a deletion, scanning now when needed. */
  async function freshReport(): Promise<StorageReport> {
    if (cached && !isStale()) return cached.report;
    return startScan();
  }

  async function preview(scope: StorageCleanupScope): Promise<StorageCleanupPreview> {
    const report = await freshReport();
    const request = {
      action: scope.action,
      inactiveDays: clampDays(scope.inactiveDays),
      ...(scope.targetIds === undefined ? {} : { targetIds: scope.targetIds }),
    };
    return planStorageCleanup(request, report, now());
  }
  /** Re-read one worktree's live Git state and activity right before removal. */
  async function liveWorktreeProtection(
    worktree: StorageWorktreeView,
  ): Promise<string | null> {
    const changingState = worktreeProtectionReason({
      workspaceId: worktree.workspaceId,
      name: worktree.name,
      branch: worktree.branch,
      bytes: worktree.bytes,
      lastUsedAt: worktree.lastUsedAt,
      uncommitted: 0,
      unpushed: 0,
      active: worktree.protectionReason === "active",
      changing: worktree.protectionReason === "changing",
      gitStateKnown: true,
    });
    if (changingState) return changingState;
    const workspace = (await dependencies.listWorkspaces()).find(
      (entry) => entry.id === worktree.workspaceId,
    );
    const tree = workspace?.managedWorktree;
    if (!tree) return "unknown-git-state";
    let gitState: WorktreeGitState | null = null;
    try {
      gitState = await dependencies.worktreeGitState({
        repositoryPath: tree.repositoryPath,
        worktreePath: tree.worktreePath,
        branch: tree.branch,
      });
    } catch {
      gitState = null;
    }
    const activeNow = (await dependencies.listChats()).some(
      (chat) => chat.workspaceId === worktree.workspaceId && dependencies.isChatBusy(chat.id),
    );
    return recheckWorktreeRemoval({
      workspaceId: worktree.workspaceId,
      name: worktree.name,
      branch: worktree.branch,
      bytes: worktree.bytes,
      lastUsedAt: worktree.lastUsedAt,
      uncommitted: gitState?.uncommitted ?? 0,
      unpushed: gitState?.unpushed ?? 0,
      active: activeNow,
      changing: dependencies.isWorkspaceChanging(worktree.workspaceId),
      gitStateKnown: gitState !== null,
    });
  }

  async function cleanup(scope: StorageCleanupScope): Promise<StorageCleanupResult> {
    const targetIds = scope.targetIds === undefined ? undefined : [...new Set(scope.targetIds)];
    const plan = await preview({
      action: scope.action,
      inactiveDays: clampDays(scope.inactiveDays),
      ...(targetIds === undefined ? {} : { targetIds }),
    });
    const removed: StorageItem[] = [];
    const failed: Array<{ id: string; label: string; reason: string }> = [];
    const skipped: StorageCleanupSkipped[] = [...plan.skipped];

    if (plan.action === "clear-logs") {
      if (plan.items.length > 0) {
        try {
          await dependencies.clearLogs();
          removed.push(...plan.items);
        } catch (error) {
          dependencies.logError?.("storage", "Aiden could not clear its logs.", error);
          failed.push({
            id: "logs",
            label: "Logs and diagnostics",
            reason: "Aiden could not clear its logs.",
          });
        }
      }
      return finish(removed, skipped, failed);
    }

    await removeSelected(plan, removed, skipped, failed);
    return finish(removed, skipped, failed);

    async function removeSelected(
      selected: StorageCleanupPreview,
      removedItems: StorageItem[],
      skippedItems: StorageCleanupSkipped[],
      failures: Array<{ id: string; label: string; reason: string }>,
    ): Promise<void> {
      // Live facts are re-read per target: a worktree that gained a commit, or a
      // chat that started generating since the preview, is kept instead.
      const report = await freshReport();
      for (const item of selected.items) {
        if (item.kind === "worktree") {
          const worktree = report.worktrees.find((entry) => entry.workspaceId === item.id);
          if (!worktree) continue;
          const reason = await liveWorktreeProtection(worktree);
          if (reason) {
            skippedItems.push({ id: item.id, label: item.label, reason, bytes: item.bytes });
            continue;
          }
          try {
            await dependencies.removeWorktree(item.id);
            removedItems.push(item);
          } catch (error) {
            dependencies.logError?.("storage", "Aiden could not remove a worktree.", error);
            failures.push({
              id: item.id,
              label: item.label,
              reason:
                error instanceof Error && error.message
                  ? error.message
                  : "Aiden could not remove this worktree.",
            });
          }
          continue;
        }
        const thread = report.threads.find((entry) => entry.chatId === item.id);
        if (!thread) continue;
        // Re-read the pins here too: a chat pinned since the preview is kept, and
        // an unreadable triage store keeps every thread rather than unpinning them.
        const pinsNow = await readPinState();
        const reason = threadProtectionReason({
          chatId: thread.chatId,
          title: thread.title,
          bytes: thread.bytes,
          lastUsedAt: thread.lastUsedAt,
          active: dependencies.isChatBusy(thread.chatId),
          pinned: pinsNow.kind === "unknown" || pinsNow.pinned.has(thread.chatId),
          owned: thread.protected === true && thread.protectionReason === "owned",
        });
        if (reason) {
          skippedItems.push({ id: item.id, label: item.label, reason, bytes: item.bytes });
          continue;
        }
        try {
          await dependencies.removeChat(item.id);
          removedItems.push(item);
        } catch (error) {
          dependencies.logError?.("storage", "Aiden could not delete a thread.", error);
          failures.push({
            id: item.id,
            label: item.label,
            reason:
              error instanceof Error && error.message
                ? error.message
                : "Aiden could not delete this thread.",
          });
        }
      }
    }

    function finish(
      removedItems: StorageItem[],
      skippedItems: StorageCleanupSkipped[],
      failures: Array<{ id: string; label: string; reason: string }>,
    ): StorageCleanupResult {
      cached = null;
      if (!disposed) void startScan();
      return {
        removed: removedItems,
        skipped: skippedItems,
        failed: failures,
        freedBytes: removedItems.reduce((total, item) => total + item.bytes, 0),
      };
    }
  }

  return {
    async report() {
      const snapshot = cached?.report ?? idleReport();
      if (isStale() && !inFlight) void startScan();
      return snapshot;
    },
    async refresh() {
      return inFlight ?? startScan();
    },
    preview,
    cleanup,
    dispose() {
      disposed = true;
    },
  };
}

function clampDays(value: number): StorageInactiveDays {
  if (!Number.isFinite(value)) return DEFAULT_STORAGE_INACTIVE_DAYS;
  const days = Math.min(3_650, Math.max(0, Math.floor(value)));
  return (STORAGE_INACTIVE_DAYS as readonly number[]).includes(days)
    ? (days as StorageInactiveDays)
    : DEFAULT_STORAGE_INACTIVE_DAYS;
}

/** Sizes of chat images by content hash, from `chats/images/<2 hex>/<sha256>`. */
async function imageFileSizes(
  imagesDir: string,
  budget: StorageScanBudget,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let shards;
  try {
    shards = await fs.readdir(imagesDir, { withFileTypes: true });
  } catch {
    return sizes;
  }
  budget.spendEntries(shards.length);
  for (const shard of shards) {
    if (budget.exhausted()) break;
    if (!shard.isDirectory() || !SHAARD_NAME.test(shard.name)) continue;
    let files;
    try {
      files = await fs.readdir(path.join(imagesDir, shard.name), { withFileTypes: true });
    } catch {
      continue;
    }
    budget.spendEntries(files.length);
    for (const file of files) {
      if (budget.exhausted()) break;
      if (!file.isFile() || !IMAGE_FILE_NAME.test(file.name)) continue;
      try {
        const stats = await fs.lstat(path.join(imagesDir, shard.name, file.name));
        if (stats.isFile()) sizes.set(file.name, stats.size);
      } catch {
        // Removed mid-scan.
      }
    }
  }
  return sizes;
}

/** Bytes of the image files one transcript names: its own share of the image store. */
export function attributedImageBytes(
  transcript: string,
  imageSizes: ReadonlyMap<string, number>,
): number {
  let bytes = 0;
  const seen = new Set<string>();
  for (const match of transcript.matchAll(IMAGE_HASH)) {
    const hash = match[1]!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    bytes += imageSizes.get(hash) ?? 0;
  }
  return bytes;
}
