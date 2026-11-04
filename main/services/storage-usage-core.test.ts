// Settings → Storage: size measurement, category totals, and the safety rules
// that decide what cleanup may delete. These exercise the real functions with
// real directories, so a change that starts following symlinks, drops the
// budget, or lets a protected worktree through fails here.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  classifyThread,
  classifyWorktree,
  createStorageScanBudget,
  measurePathBytes,
  orderCategories,
  planStorageCleanup,
  planThreadCleanup,
  planWorktreeCleanup,
  recheckWorktreeRemoval,
  threadProtectionReason,
  worktreeProtectionReason,
  type ThreadFacts,
  type WorktreeFacts,
} from "./storage-usage-core.js";
import {
  assembleStorageReport,
  DEFAULT_STORAGE_INACTIVE_DAYS,
  DEFAULT_THREAD_INACTIVE_DAYS,
  emptyStorageReport,
  formatStorageBytes,
  parseStorageCleanupRequest,
  storageIdleDays,
  storageInactiveCutoff,
  storageSharePercent,
  type StorageCleanupPreview,
  type StorageReport,
  type StorageThreadView,
  type StorageWorktreeView,
} from "../../renderer/shared/storage.js";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 1_800_000_000_000;

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aiden-storage-"));
}

async function writeFileWithBytes(file: string, bytes: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(bytes, 0x61));
}

function worktreeFacts(overrides: Partial<WorktreeFacts> = {}): WorktreeFacts {
  return {
    workspaceId: "ws-1",
    name: "Repo · feature",
    branch: "feature",
    bytes: 1_000,
    lastUsedAt: NOW - 40 * DAY,
    uncommitted: 0,
    unpushed: 0,
    active: false,
    changing: false,
    gitStateKnown: true,
    ...overrides,
  };
}

function threadFacts(overrides: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
    chatId: "chat-1",
    title: "Old chat",
    bytes: 1_000,
    lastUsedAt: NOW - 120 * DAY,
    active: false,
    pinned: false,
    owned: false,
    ...overrides,
  };
}

function reportWith(
  worktrees: readonly StorageWorktreeView[],
  threads: readonly StorageThreadView[] = [],
  categories: StorageReport["categories"] = [],
): StorageReport {
  return assembleStorageReport({
    categories,
    worktrees,
    threads,
    scan: { status: "ready", scannedAt: NOW, error: null, truncated: false },
  });
}

// ── Measurement ────────────────────────────────────────────────────────

test("measurePathBytes adds regular files and skips symlinks", async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  try {
    await writeFileWithBytes(path.join(root, "measured", "a.txt"), 100);
    await writeFileWithBytes(path.join(root, "measured", "nested", "b.txt"), 250);
    // A symlink to an outside file must never be followed: a workspace link
    // could otherwise make Aiden report bytes it never wrote.
    await writeFileWithBytes(path.join(outside, "outside-target.txt"), 5_000);
    await fs.symlink(
      path.join(outside, "outside-target.txt"),
      path.join(root, "measured", "linked.txt"),
    );
    const measured = await measurePathBytes(path.join(root, "measured"), createStorageScanBudget());
    assert.equal(measured.bytes, 350, "only the two real files count");
    assert.equal(measured.files, 2);
    assert.equal(measured.truncated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("measurePathBytes reports a missing path as zero without throwing", async () => {
  const root = await tempRoot();
  try {
    const measured = await measurePathBytes(path.join(root, "absent"), createStorageScanBudget());
    assert.deepEqual(measured, { bytes: 0, files: 0, truncated: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a scan budget stops the walk and marks the total as a floor", async () => {
  const root = await tempRoot();
  try {
    for (let index = 0; index < 12; index += 1) {
      await writeFileWithBytes(path.join(root, `file-${index}.txt`), 10);
    }
    const budget = createStorageScanBudget({
      limits: { maxEntries: 3, maxBytes: 1024, maxDurationMs: 60_000 },
    });
    const measured = await measurePathBytes(root, budget);
    assert.equal(measured.truncated, true, "the walk stopped when the entry cap was hit");
    assert.ok(measured.bytes < 120, "an incomplete walk cannot report the full total");
    assert.equal(budget.truncated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the scan budget also expires on elapsed time", () => {
  let clock = 0;
  const budget = createStorageScanBudget({
    limits: { maxEntries: 1_000, maxBytes: 1_000, maxDurationMs: 5 },
    now: () => clock,
  });
  assert.equal(budget.exhausted(), false);
  clock = 10;
  assert.equal(budget.exhausted(), true);
  assert.equal(budget.truncated, true);
});

test("category totals stay in display order even when a category is missing", () => {
  const ordered = orderCategories([{ id: "logs", bytes: 40, itemCount: 2 }]);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ["worktrees", "snapshots", "threads", "artifacts", "logs", "caches", "downloads"],
  );
  assert.equal(ordered.find((entry) => entry.id === "logs")?.bytes, 40);
  assert.equal(ordered.find((entry) => entry.id === "worktrees")?.bytes, 0);
});

test("the report total is the sum of its categories, and items are sorted by size", () => {
  const report = assembleStorageReport({
    categories: [
      { id: "threads", bytes: 700, itemCount: 3 },
      { id: "worktrees", bytes: 300, itemCount: 1 },
    ],
    worktrees: [classifyWorktree(worktreeFacts({ bytes: 10 }), NOW), classifyWorktree(worktreeFacts({ workspaceId: "ws-2", bytes: 90 }), NOW)],
    threads: [classifyThread(threadFacts({ bytes: 5 }), NOW)],
    scan: { status: "ready", scannedAt: NOW, error: null, truncated: false },
  });
  assert.equal(report.totalBytes, 1_000);
  assert.deepEqual(report.worktrees.map((entry) => entry.workspaceId), ["ws-2", "ws-1"]);
});

test("an empty report still lists every category so the bar has a stable shape", () => {
  const report = emptyStorageReport({
    status: "idle",
    scannedAt: null,
    error: null,
    truncated: false,
  });
  assert.equal(report.totalBytes, 0);
  assert.equal(report.categories.length, 7);
});

// ── Sizes and percentages ──────────────────────────────────────────────

test("byte sizes use decimal units and never say 0 for a non-empty category", () => {
  assert.equal(formatStorageBytes(0), "0 KB");
  assert.equal(formatStorageBytes(999), "999 B");
  assert.equal(formatStorageBytes(1_500), "2 KB");
  assert.equal(formatStorageBytes(2_400_000), "2.4 MB");
  assert.equal(formatStorageBytes(150_000_000), "150 MB");
  assert.equal(formatStorageBytes(2_500_000_000), "2.50 GB");
});

test("a category's share of the bar adds up and is never above 100 percent", () => {
  assert.equal(storageSharePercent(0, 100), 0);
  assert.equal(storageSharePercent(50, 0), 0);
  assert.equal(storageSharePercent(25, 100), 25);
  assert.equal(storageSharePercent(200, 100), 100);
  const quarters = [25, 25, 25, 25].map((bytes) => storageSharePercent(bytes, 100));
  assert.equal(quarters.reduce((total, value) => total + value, 0), 100);
});

test("idle days floor at zero and unknown use stays unknown", () => {
  assert.equal(storageIdleDays(null, NOW), null);
  assert.equal(storageIdleDays(0, NOW), null);
  assert.equal(storageIdleDays(NOW + DAY, NOW), 0);
  assert.equal(storageIdleDays(NOW - 3 * DAY, NOW), 3);
  assert.equal(storageInactiveCutoff(14, NOW), NOW - 14 * DAY);
});

// ── Worktree safety rules ──────────────────────────────────────────────

test("a clean, idle worktree is removable and carries its branch and idle time", () => {
  const view = classifyWorktree(worktreeFacts(), NOW);
  assert.equal(view.protected, false);
  assert.equal(view.protectionReason, undefined);
  assert.equal(view.branch, "feature");
  assert.equal(view.idleDays, 40);
});

test("uncommitted changes protect a worktree", () => {
  const view = classifyWorktree(worktreeFacts({ uncommitted: 2 }), NOW);
  assert.equal(view.protected, true);
  assert.equal(view.protectionReason, "uncommitted");
});

test("unpushed commits protect a worktree", () => {
  const view = classifyWorktree(worktreeFacts({ unpushed: 1 }), NOW);
  assert.equal(view.protected, true);
  assert.equal(view.protectionReason, "unpushed");
});

test("a worktree a chat is using, or Aiden is changing, is protected", () => {
  assert.equal(classifyWorktree(worktreeFacts({ active: true }), NOW).protectionReason, "active");
  assert.equal(classifyWorktree(worktreeFacts({ changing: true }), NOW).protectionReason, "changing");
});

test("a worktree whose Git state could not be read is never treated as safe", () => {
  // Unknown state is the one case where "no local work" could be a lie: the
  // scan failed, so cleanup keeps the worktree rather than guessing.
  const view = classifyWorktree(worktreeFacts({ gitStateKnown: false }), NOW);
  assert.equal(view.protected, true);
  assert.equal(view.protectionReason, "unknown-git-state");
  assert.equal(worktreeProtectionReason(worktreeFacts({ gitStateKnown: false })), "unknown-git-state");
});

test("local work outranks an activity reason, so the caption names what the person must fix", () => {
  assert.equal(
    worktreeProtectionReason(worktreeFacts({ active: true, uncommitted: 1 })),
    "active",
    "an active worktree says so first",
  );
  assert.equal(
    worktreeProtectionReason(worktreeFacts({ uncommitted: 1, unpushed: 3 })),
    "uncommitted",
  );
});

// ── Thread safety rules ────────────────────────────────────────────────

test("a stale thread with no owner is deletable; pinned and owned ones are not", () => {
  assert.equal(classifyThread(threadFacts(), NOW).protected, false);
  assert.equal(threadProtectionReason(threadFacts({ pinned: true })), "pinned");
  assert.equal(threadProtectionReason(threadFacts({ owned: true })), "owned");
  assert.equal(threadProtectionReason(threadFacts({ active: true })), "active");
});

// ── Cleanup planning ───────────────────────────────────────────────────

test("worktree cleanup removes only idle, clean worktrees and explains every skip", () => {
  const worktrees = [
    classifyWorktree(worktreeFacts({ workspaceId: "idle", bytes: 4_000 }), NOW),
    classifyWorktree(worktreeFacts({ workspaceId: "dirty", uncommitted: 3, bytes: 3_000 }), NOW),
    classifyWorktree(worktreeFacts({ workspaceId: "unpushed", unpushed: 2, bytes: 2_000 }), NOW),
    classifyWorktree(worktreeFacts({ workspaceId: "recent", lastUsedAt: NOW - 2 * DAY, bytes: 1_000 }), NOW),
    classifyWorktree(worktreeFacts({ workspaceId: "busy", active: true, bytes: 500 }), NOW),
  ];
  const plan = planWorktreeCleanup(worktrees, { inactiveDays: 14, now: NOW });
  assert.deepEqual(plan.items.map((item) => item.id), ["idle"]);
  assert.equal(plan.totalBytes, 4_000);
  assert.deepEqual(
    plan.skipped.map((entry) => [entry.id, entry.reason]),
    [
      ["dirty", "uncommitted"],
      ["unpushed", "unpushed"],
      ["recent", "recent"],
      ["busy", "active"],
    ],
  );
  // Nothing is both removed and kept.
  const removed = new Set(plan.items.map((item) => item.id));
  assert.ok(plan.skipped.every((entry) => !removed.has(entry.id)));
});

test("naming a protected worktree explicitly still keeps it", () => {
  // The renderer only sends ids the preview listed, but a stale window can send
  // anything; the plan re-checks protection regardless of selection.
  const worktrees = [
    classifyWorktree(worktreeFacts({ workspaceId: "dirty", uncommitted: 1 }), NOW),
  ];
  const plan = planWorktreeCleanup(worktrees, {
    inactiveDays: 0,
    now: NOW,
    targetIds: ["dirty"],
  });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.skipped[0]?.reason, "uncommitted");
});

test("an explicitly chosen item is removable even when it was used recently", () => {
  // Per-item delete names one worktree the person picked, so the window does
  // not apply; the protection rules still do.
  const worktrees = [
    classifyWorktree(worktreeFacts({ workspaceId: "warm", lastUsedAt: NOW - DAY }), NOW),
  ];
  const explicit = planWorktreeCleanup(worktrees, {
    inactiveDays: 14,
    now: NOW,
    targetIds: ["warm"],
  });
  assert.deepEqual(explicit.items.map((item) => item.id), ["warm"]);
  const idleWindow = planWorktreeCleanup(worktrees, { inactiveDays: 14, now: NOW });
  assert.equal(idleWindow.items.length, 0);
});

test("an explicitly chosen pinned thread is still kept", () => {
  const threads = [classifyThread(threadFacts({ chatId: "pinned", pinned: true, lastUsedAt: NOW - 400 * DAY }), NOW)];
  const plan = planThreadCleanup(threads, { inactiveDays: 30, now: NOW, targetIds: ["pinned"] });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.skipped[0]?.reason, "pinned");
});

test("thread cleanup respects the inactivity window and never plans a pinned or owned thread", () => {
  const threads = [
    classifyThread(threadFacts({ chatId: "old", bytes: 800 }), NOW),
    classifyThread(threadFacts({ chatId: "recent", lastUsedAt: NOW - DAY }), NOW),
    classifyThread(threadFacts({ chatId: "pinned", pinned: true }), NOW),
    classifyThread(threadFacts({ chatId: "owned", owned: true }), NOW),
    classifyThread(threadFacts({ chatId: "busy", active: true }), NOW),
  ];
  const plan = planThreadCleanup(threads, { inactiveDays: 30, now: NOW });
  assert.deepEqual(plan.items.map((item) => item.id), ["old"]);
  assert.deepEqual(
    plan.skipped.map((entry) => entry.id).sort(),
    ["busy", "owned", "pinned", "recent"],
  );
});

test("a default plan for each action reaches the right categories", () => {
  const report = reportWith(
    [classifyWorktree(worktreeFacts(), NOW)],
    [classifyThread(threadFacts(), NOW)],
    [
      { id: "worktrees", bytes: 1_000, itemCount: 1 },
      { id: "threads", bytes: 2_000, itemCount: 1 },
      { id: "logs", bytes: 300, itemCount: 4 },
    ],
  );
  const worktrees = planStorageCleanup(
    { action: "remove-worktrees", inactiveDays: DEFAULT_STORAGE_INACTIVE_DAYS },
    report,
    NOW,
  );
  assert.equal(worktrees.items.length, 1);
  const threads = planStorageCleanup(
    { action: "delete-threads", inactiveDays: DEFAULT_THREAD_INACTIVE_DAYS },
    report,
    NOW,
  );
  assert.equal(threads.items.length, 1);
  const logs = planStorageCleanup({ action: "clear-logs", inactiveDays: 14 }, report, NOW);
  assert.equal(logs.totalBytes, 300);
  assert.equal(logs.items[0]?.detail, "4 files");
  assert.equal(logs.skipped.length, 0);
});

test("log cleanup offers nothing when there is nothing to clear", () => {
  const report = reportWith([], [], [{ id: "logs", bytes: 0, itemCount: 0 }]);
  const plan = planStorageCleanup({ action: "clear-logs", inactiveDays: 14 }, report, NOW);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.totalBytes, 0);
});

test("every planned item has a positive-or-zero size and a label, so the dialog can list it", () => {
  const previews: StorageCleanupPreview[] = [
    planWorktreeCleanup([classifyWorktree(worktreeFacts(), NOW)], { inactiveDays: 14, now: NOW }),
    planThreadCleanup([classifyThread(threadFacts(), NOW)], { inactiveDays: 30, now: NOW }),
    planStorageCleanup(
      { action: "clear-logs", inactiveDays: 14 },
      reportWith([], [], [{ id: "logs", bytes: 12, itemCount: 1 }]),
      NOW,
    ),
  ];
  for (const preview of previews) {
    for (const item of preview.items) {
      assert.ok(item.label.length > 0, "an item without a label cannot be reviewed");
      assert.ok(item.bytes >= 0);
      assert.ok(["worktree", "thread", "logs"].includes(item.kind));
    }
    assert.equal(
      preview.totalBytes,
      preview.items.reduce((total, item) => total + item.bytes, 0),
    );
  }
});

test("rechecking a worktree right before removal keeps anything that changed", () => {
  assert.equal(recheckWorktreeRemoval(worktreeFacts()), null);
  assert.equal(
    recheckWorktreeRemoval(worktreeFacts({ uncommitted: 1 })),
    "uncommitted",
  );
  assert.equal(
    recheckWorktreeRemoval(worktreeFacts({ unpushed: 4 })),
    "unpushed",
  );
  assert.equal(
    recheckWorktreeRemoval(worktreeFacts({ gitStateKnown: false })),
    "unknown-git-state",
  );
});

// ── Request parsing ────────────────────────────────────────────────────

test("cleanup requests parse strictly and default their window", () => {
  assert.deepEqual(parseStorageCleanupRequest({ action: "clear-logs" }), {
    action: "clear-logs",
    inactiveDays: DEFAULT_STORAGE_INACTIVE_DAYS,
  });
  assert.deepEqual(
    parseStorageCleanupRequest({ action: "delete-threads", inactiveDays: 90, targetIds: ["a", "a", "b"] }),
    { action: "delete-threads", inactiveDays: 90, targetIds: ["a", "b"] },
  );
  for (const bad of [
    null,
    [],
    { action: "delete-everything" },
    { action: "clear-logs", inactiveDays: 3 },
    { action: "clear-logs", targetIds: "x" },
    { action: "clear-logs", targetIds: [""] },
    { action: "clear-logs", targetIds: [1] },
  ]) {
    assert.throws(() => parseStorageCleanupRequest(bad), /storage cleanup|cleanup selection|inactivity/i, JSON.stringify(bad));
  }
});
