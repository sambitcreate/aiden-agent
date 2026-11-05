// Desktop Settings → Storage: the main-process inventory service.
//
// A scan runs off the IPC path: `report()` returns the cached snapshot at once
// and, when it is stale, starts a background walk that broadcasts
// `storage:changed` when it finishes. The renderer therefore never waits on a
// directory walk, and a slow disk only delays the numbers, not the page.
//
// Deletion is decided here, not in the renderer: every cleanup re-reads live
// Git, scheduled-task and activity facts and refuses anything with local work
// or a live user.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatMeta, Workspace } from "./types.js";
import {
  createStorageScanBudget,
  diskBytes,
  measurePathBytes,
  orderCategories,
  planStorageCleanup,
  recheckWorktreeRemoval,
  DEFAULT_STORAGE_SCAN_LIMITS,
  type StorageScanBudget,
  type StorageScanBudgetLimits,
} from "./storage-usage-core.js";
import {
  BROWSER_CACHE_DIRECTORY_NAMES,
  aidenBrowserPartitionName,
  storageCategoryForEntry,
} from "./storage-profile-inventory.js";
import {
  assembleStorageReport,
  classifyThread,
  classifyWorktree,
  DEFAULT_STORAGE_INACTIVE_DAYS,
  emptyStorageReport,
  STORAGE_CATEGORY_IDS,
  STORAGE_INACTIVE_DAYS,
  threadProtectionReason,
  type StorageCategoryUsage,
  type StorageCleanupPreview,
  type StorageCleanupResult,
  type StorageCleanupSkipped,
  type StorageInactiveDays,
  type StorageItem,
  type StorageReport,
  type StorageScanState,
  type StorageThreadView,
  type StorageWorktreeView,
} from "../../renderer/shared/storage.js";

/** A scan older than this is refreshed on the next read, in the background. */
export const STORAGE_SCAN_STALE_MS = 60_000;

/** Longest transcript read to attribute its images; larger files skip that step. */
const MAX_TRANSCRIPT_ATTRIBUTION_BYTES = 4 * 1024 * 1024;

const IMAGE_HASH = /"sha256"\s*:\s*"([0-9a-f]{64})"/gu;
const IMAGE_FILE_NAME = /^[0-9a-f]{64}$/u;

export interface WorktreeGitState {
  uncommitted: number;
  unpushed: number;
}

/**
 * A pin read that failed is `unknown`, not empty. Cleanup must treat that as
 * "every chat may be pinned": losing a pinned chat to a transient triage read
 * is not recoverable, while skipping cleanup is.
 */
export type ThreadPinState =
  | { kind: "known"; pinned: ReadonlySet<string> }
  | { kind: "unknown" };

export interface StorageCleanupScope {
  action: "remove-worktrees" | "delete-threads" | "clear-logs" | "clear-browser-cache";
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
  /**
   * The workspace of every scheduled task, one entry per task. Removing a
   * workspace stops its tasks for good, so a rejection keeps every worktree.
   */
  scheduledTaskWorkspaceIds(): Promise<readonly string[]>;
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
  /** Empty the browser profiles' caches through their sessions, keeping sign-ins. */
  clearBrowserCache(): Promise<void>;
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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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
  let cleaning: Promise<unknown> | null = null;
  let disposed = false;

  async function runScan(): Promise<StorageReport> {
    const startedAt = now();
    const budget = createStorageScanBudget({ limits, now });
    const profileRoot = dependencies.profileRoot();

    const [workspaces, chats, pins, routines] = await Promise.all([
      dependencies.listWorkspaces(),
      dependencies.listChats(),
      readPinState(),
      readRoutineCounts(),
    ]);

    const worktreeRoot = path.join(profileRoot, "worktrees");
    const imagesDir = path.join(profileRoot, "chats", "images");
    const partitionsDir = path.join(profileRoot, "Partitions");
    // Every managed worktree is listed; only those under Aiden's own worktree
    // root are measured, so a record pointing elsewhere never walks an
    // unrelated directory.
    const managed = workspaces.filter((workspace) => workspace.managedWorktree);
    const measurable = managed.filter((workspace) =>
      isInside(worktreeRoot, workspace.managedWorktree!.worktreePath),
    );
    const worktreeBytes = new Map<string, { bytes: number; complete: boolean }>();
    const imageSizes = new Map<string, number>();
    let browserCacheBytes = 0;

    // One walk feeds every number: category totals, each chat's pictures, and
    // the browser's cache share. Nothing is walked twice.
    const onFile = (filePath: string, bytes: number) => {
      const name = path.basename(filePath);
      if (path.dirname(path.dirname(filePath)) === imagesDir && IMAGE_FILE_NAME.test(name)) {
        imageSizes.set(name, bytes);
        return;
      }
      if (isBrowserCacheFile(profileRoot, partitionsDir, filePath)) browserCacheBytes += bytes;
    };

    let topLevel: string[] = [];
    try {
      topLevel = (await fs.readdir(profileRoot)).sort();
    } catch {
      topLevel = [];
    }
    const usage: StorageCategoryUsage[] = [];
    // Any walk that skipped something makes every total a minimum, not only a spent budget.
    let partial = false;
    for (const category of STORAGE_CATEGORY_IDS) {
      for (const name of topLevel.filter((entry) => storageCategoryForEntry(entry) === category)) {
        const target = path.join(profileRoot, name);
        if (category === "worktrees" && target === worktreeRoot) {
          const measured = await measureWorktreeRoot(worktreeRoot, measurable, worktreeBytes, budget);
          partial ||= measured.truncated;
          usage.push(measured.usage);
          continue;
        }
        const measured = await measurePathBytes(target, budget, { onFile });
        partial ||= measured.truncated;
        usage.push({ id: category, bytes: measured.bytes, itemCount: measured.files });
      }
    }

    const worktrees = await describeWorktrees(managed, chats, worktreeBytes, routines);
    const threads = await describeThreads(profileRoot, chats, pins, imageSizes, budget);

    const scan: StorageScanState = {
      status: "ready",
      scannedAt: startedAt,
      error: null,
      truncated: budget.truncated || partial,
    };
    return assembleStorageReport({
      categories: orderCategories(usage),
      worktrees,
      threads,
      browserCacheBytes,
      scan,
    });
  }

  /** Each managed worktree measured once, then whatever else lives under the root. */
  async function measureWorktreeRoot(
    worktreeRoot: string,
    managed: readonly Workspace[],
    into: Map<string, { bytes: number; complete: boolean }>,
    budget: StorageScanBudget,
  ): Promise<{ usage: StorageCategoryUsage; truncated: boolean }> {
    let bytes = 0;
    let files = 0;
    let truncated = false;
    const exclude = new Set<string>();
    for (const workspace of managed) {
      const tree = workspace.managedWorktree!;
      exclude.add(tree.worktreePath);
      const measured = await measurePathBytes(tree.worktreePath, budget);
      into.set(workspace.id, { bytes: measured.bytes, complete: !measured.truncated });
      bytes += measured.bytes;
      files += measured.files;
      truncated ||= measured.truncated;
    }
    const rest = await measurePathBytes(worktreeRoot, budget, { exclude });
    return {
      usage: { id: "worktrees", bytes: bytes + rest.bytes, itemCount: files + rest.files },
      truncated: truncated || rest.truncated,
    };
  }

  async function describeWorktrees(
    managed: readonly Workspace[],
    chats: readonly ChatMeta[],
    sizes: ReadonlyMap<string, { bytes: number; complete: boolean }>,
    routines: ReadonlyMap<string, number> | null,
  ): Promise<StorageWorktreeView[]> {
    const lastChatAt = new Map<string, number>();
    for (const chat of chats) {
      if (!chat.workspaceId) continue;
      const previous = lastChatAt.get(chat.workspaceId) ?? 0;
      if (chat.updatedAt > previous) lastChatAt.set(chat.workspaceId, chat.updatedAt);
    }
    // Every worktree is listed even when the walk ran out of time, so it can
    // still be reviewed and removed; only its size is then a minimum.
    const views: StorageWorktreeView[] = [];
    for (const workspace of managed) {
      const tree = workspace.managedWorktree!;
      const gitState = await readGitState(tree);
      const size =
        sizes.get(workspace.id) ??
        { bytes: 0, complete: !isInside(path.join(dependencies.profileRoot(), "worktrees"), tree.worktreePath) };
      const lastUsedAt =
        Math.max(workspace.updatedAt ?? 0, workspace.createdAt ?? 0, lastChatAt.get(workspace.id) ?? 0) || null;
      views.push(
        classifyWorktree(
          {
            workspaceId: workspace.id,
            name: workspace.name,
            branch: tree.branch,
            bytes: size.bytes,
            bytesComplete: size.complete,
            lastUsedAt,
            uncommitted: gitState?.uncommitted ?? 0,
            unpushed: gitState?.unpushed ?? 0,
            active: chats.some(
              (chat) => chat.workspaceId === workspace.id && dependencies.isChatBusy(chat.id),
            ),
            changing: dependencies.isWorkspaceChanging(workspace.id),
            gitStateKnown: gitState !== null,
            routineCount: routines === null ? null : (routines.get(workspace.id) ?? 0),
          },
          now(),
        ),
      );
    }
    return views;
  }

  /**
   * A chat's size is what deleting it frees: its transcript plus the pictures
   * no other chat shows. A picture two chats share stays on disk after either
   * one is deleted, so it is not counted for either.
   */
  async function describeThreads(
    profileRoot: string,
    chats: readonly ChatMeta[],
    pinState: ThreadPinState,
    imageSizes: ReadonlyMap<string, number>,
    budget: StorageScanBudget,
  ): Promise<StorageThreadView[]> {
    const chatsDir = path.join(profileRoot, "chats");
    const facts: Array<{ chat: ChatMeta; transcriptBytes: number; hashes: Set<string> | null }> = [];
    const users = new Map<string, number>();
    for (const chat of chats) {
      const transcript = path.join(chatsDir, `${chat.id}.json`);
      let transcriptBytes = 0;
      let size = 0;
      try {
        const stats = await fs.lstat(transcript);
        if (stats.isFile()) {
          size = stats.size;
          transcriptBytes = diskBytes(stats);
        }
      } catch {
        // A chat whose file is gone holds no disk; it still lists at zero.
      }
      budget.spendEntries(1);
      let hashes: Set<string> | null = new Set();
      if (size > 0) {
        const contents =
          size <= MAX_TRANSCRIPT_ATTRIBUTION_BYTES && !budget.exhausted()
            ? await dependencies.readTranscript(transcript, MAX_TRANSCRIPT_ATTRIBUTION_BYTES).catch(() => undefined)
            : undefined;
        hashes = contents ? imageHashes(contents.toString("utf8")) : null;
      }
      for (const hash of hashes ?? []) users.set(hash, (users.get(hash) ?? 0) + 1);
      facts.push({ chat, transcriptBytes, hashes });
    }
    return facts.map(({ chat, transcriptBytes, hashes }) => {
      let bytes = transcriptBytes;
      for (const hash of hashes ?? []) {
        if (users.get(hash) === 1) bytes += imageSizes.get(hash) ?? 0;
      }
      return classifyThread(
        {
          chatId: chat.id,
          title: chat.title,
          bytes,
          bytesComplete: hashes !== null,
          imageCount: hashes?.size ?? 0,
          lastUsedAt: chat.updatedAt,
          active: dependencies.isChatBusy(chat.id),
          // An unreadable triage store protects every chat instead of unpinning
          // the whole Inbox: a failed read must never allow a pinned chat's delete.
          pinned: pinState.kind === "unknown" || pinState.pinned.has(chat.id),
          owned: chat.owner !== undefined || chat.botId !== undefined,
        },
        now(),
      );
    });
  }

  async function readGitState(tree: NonNullable<Workspace["managedWorktree"]>): Promise<WorktreeGitState | null> {
    try {
      return await dependencies.worktreeGitState({
        repositoryPath: tree.repositoryPath,
        worktreePath: tree.worktreePath,
        branch: tree.branch,
      });
    } catch {
      return null;
    }
  }

  function idleReport(): StorageReport {
    return emptyStorageReport({ status: "idle", scannedAt: null, error: null, truncated: false });
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

  /** Scheduled tasks per workspace; null when they could not be read. */
  async function readRoutineCounts(): Promise<ReadonlyMap<string, number> | null> {
    try {
      const counts = new Map<string, number>();
      for (const workspaceId of await dependencies.scheduledTaskWorkspaceIds()) {
        counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
      }
      return counts;
    } catch (error) {
      dependencies.logError?.("storage", "Aiden could not read scheduled tasks for cleanup.", error);
      return null;
    }
  }

  /** A report fresh enough to decide a deletion, scanning now when needed. */
  async function freshReport(): Promise<StorageReport> {
    if (cached && !isStale() && cached.report.scan.status === "ready") return cached.report;
    return startScan();
  }

  async function preview(scope: StorageCleanupScope): Promise<StorageCleanupPreview> {
    const report = await freshReport();
    return planStorageCleanup(
      {
        action: scope.action,
        inactiveDays: clampDays(scope.inactiveDays),
        ...(scope.targetIds === undefined ? {} : { targetIds: scope.targetIds }),
      },
      report,
      now(),
    );
  }

  /** Re-read one worktree's live Git state, scheduled tasks and activity right before removal. */
  async function liveWorktreeProtection(worktree: StorageWorktreeView): Promise<string | null> {
    const workspace = (await dependencies.listWorkspaces()).find(
      (entry) => entry.id === worktree.workspaceId,
    );
    const tree = workspace?.managedWorktree;
    if (!tree) return "unknown-git-state";
    const [gitState, routines, chats] = await Promise.all([
      readGitState(tree),
      readRoutineCounts(),
      dependencies.listChats(),
    ]);
    return recheckWorktreeRemoval({
      workspaceId: worktree.workspaceId,
      name: worktree.name,
      branch: worktree.branch,
      bytes: worktree.bytes,
      bytesComplete: worktree.bytesComplete,
      lastUsedAt: worktree.lastUsedAt,
      uncommitted: gitState?.uncommitted ?? 0,
      unpushed: gitState?.unpushed ?? 0,
      active: chats.some(
        (chat) => chat.workspaceId === worktree.workspaceId && dependencies.isChatBusy(chat.id),
      ),
      changing: dependencies.isWorkspaceChanging(worktree.workspaceId),
      gitStateKnown: gitState !== null,
      routineCount: routines === null ? null : (routines.get(worktree.workspaceId) ?? 0),
    });
  }

  /** Re-read one chat's pin, owner and activity right before deleting it. */
  async function liveThreadProtection(chatId: string): Promise<string | null> {
    const [pins, chats] = await Promise.all([readPinState(), dependencies.listChats()]);
    const chat = chats.find((entry) => entry.id === chatId);
    if (!chat) return "owned";
    return threadProtectionReason({
      active: dependencies.isChatBusy(chatId),
      pinned: pins.kind === "unknown" || pins.pinned.has(chatId),
      owned: chat.owner !== undefined || chat.botId !== undefined,
    });
  }

  async function runCleanup(scope: StorageCleanupScope): Promise<StorageCleanupResult> {
    const targetIds = scope.targetIds === undefined ? undefined : [...new Set(scope.targetIds)];
    if (scope.action === "delete-threads" && targetIds?.length !== 1) {
      throw new Error("Chats are deleted one at a time.");
    }
    const plan = await preview({
      action: scope.action,
      inactiveDays: clampDays(scope.inactiveDays),
      ...(targetIds === undefined ? {} : { targetIds }),
    });
    const removed: StorageItem[] = [];
    const failed: Array<{ id: string; label: string; reason: string }> = [];
    const skipped: StorageCleanupSkipped[] = [...plan.skipped];

    if (plan.action === "clear-logs" || plan.action === "clear-browser-cache") {
      if (plan.items.length > 0) {
        const logs = plan.action === "clear-logs";
        try {
          await (logs ? dependencies.clearLogs() : dependencies.clearBrowserCache());
          removed.push(...plan.items);
        } catch (error) {
          const reason = logs ? "Aiden could not clear its logs." : "Aiden could not clear the browser cache.";
          dependencies.logError?.("storage", reason, error);
          failed.push({ id: plan.items[0]!.id, label: plan.items[0]!.label, reason });
        }
      }
      return finish(removed, skipped, failed);
    }

    // Live facts are re-read per target: a worktree that gained a commit or a
    // scheduled task, or a chat that started generating since the preview, is
    // kept instead.
    for (const item of plan.items) {
      const reason =
        item.kind === "worktree"
          ? await liveWorktreeProtectionFor(item.id)
          : await liveThreadProtection(item.id);
      if (reason) {
        skipped.push({ id: item.id, label: item.label, reason, bytes: item.bytes });
        continue;
      }
      try {
        await (item.kind === "worktree"
          ? dependencies.removeWorktree(item.id)
          : dependencies.removeChat(item.id));
        removed.push(item);
      } catch (error) {
        const fallback =
          item.kind === "worktree" ? "Aiden could not remove this worktree." : "Aiden could not delete this chat.";
        dependencies.logError?.("storage", fallback, error);
        failed.push({
          id: item.id,
          label: item.label,
          reason: error instanceof Error && error.message ? error.message : fallback,
        });
      }
    }
    return finish(removed, skipped, failed);

    async function liveWorktreeProtectionFor(workspaceId: string): Promise<string | null> {
      const report = await freshReport();
      const worktree = report.worktrees.find((entry) => entry.workspaceId === workspaceId);
      return worktree ? liveWorktreeProtection(worktree) : "unknown-git-state";
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
    async cleanup(scope) {
      // One cleanup at a time: two overlapping runs could both pass the live
      // re-check for the same item before either removes it.
      while (cleaning) await cleaning.catch(() => undefined);
      const run = runCleanup(scope);
      cleaning = run;
      try {
        return await run;
      } finally {
        if (cleaning === run) cleaning = null;
      }
    },
    dispose() {
      disposed = true;
    },
  };
}

function clampDays(value: number): StorageInactiveDays {
  return (STORAGE_INACTIVE_DAYS as readonly number[]).includes(value)
    ? (value as StorageInactiveDays)
    : DEFAULT_STORAGE_INACTIVE_DAYS;
}

/**
 * Whether a file is in a cache folder that Clear cache empties: the app's own
 * `Cache`, `Code Cache` or `GPUCache`, or the same folders inside one of
 * Aiden's browser partitions under `Partitions/<partition>/`. Clear cache
 * visits exactly those partitions, including ones left behind by a deleted
 * profile or Bot, so what is counted here is what it frees.
 */
function isBrowserCacheFile(profileRoot: string, partitionsDir: string, filePath: string): boolean {
  const fromPartitions = path.relative(partitionsDir, filePath).split(path.sep);
  if (fromPartitions[0] !== "..") {
    return (
      fromPartitions.length >= 3 &&
      aidenBrowserPartitionName(fromPartitions[0]!) !== null &&
      BROWSER_CACHE_DIRECTORY_NAMES.has(fromPartitions[1]!)
    );
  }
  const fromRoot = path.relative(profileRoot, filePath).split(path.sep);
  return fromRoot.length >= 2 && BROWSER_CACHE_DIRECTORY_NAMES.has(fromRoot[0]!);
}

/** The picture hashes one transcript names. */
export function imageHashes(transcript: string): Set<string> {
  const hashes = new Set<string>();
  for (const match of transcript.matchAll(IMAGE_HASH)) hashes.add(match[1]!);
  return hashes;
}

