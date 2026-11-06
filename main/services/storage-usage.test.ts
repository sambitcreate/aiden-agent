// Settings → Storage service: the background scan never blocks a read, the
// cache refreshes in the background, and a cleanup never hands a protected
// worktree or an in-use thread to the app's deletion paths.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createStorageUsageService, imageHashes } from "./storage-usage.js";
import { diskBytes } from "./storage-usage-core.js";
import type { ChatMeta, Workspace } from "./types.js";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 1_800_000_000_000;

interface Harness {
  service: ReturnType<typeof createStorageUsageService>;
  root: string;
  removed: { worktrees: string[]; chats: string[] };
  cleared: number;
  browserCleared: number;
  broadcasts: string[];
  setBusy(chatId: string): void;
  setGitState(input: { uncommitted?: number; unpushed?: number; fail?: boolean }): void;
  setChanging(workspaceId: string): void;
  setRoutines(workspaceIds: string[] | "fail"): void;
  setTerminalOpen(workspaceId: string): void;
  /** The live workspace list; a test edits it to model a removal or a new record. */
  workspaces: Workspace[];
  /** Holds every Git read until the returned function is called. */
  holdGit(): () => void;
  /** Git reads the current hold has stopped so far. */
  heldGitReads(): number;
}

/** A promise a test resolves by hand, to pause a port at an exact moment. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Polls until `check` holds; a held port is reached a few turns after the call that leads to it. */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(check(), "the awaited moment never came");
}

/** Allocated bytes of profile files, the oracle for what the scan should report. */
async function allocated(root: string, ...relativePaths: string[]): Promise<number> {
  let total = 0;
  for (const relativePath of relativePaths) total += diskBytes(await fs.lstat(path.join(root, relativePath)));
  return total;
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    folderPath: `/repos/${id}`,
    permission: "full",
    managedWorktree: {
      repositoryPath: "/repos/source",
      worktreePath: `/worktrees/${id}`,
      branch: `branch-${id}`,
      createdFromHead: "0".repeat(40),
    },
    createdAt: NOW - 100 * DAY,
    updatedAt: NOW - 100 * DAY,
    ...overrides,
  };
}

function chat(id: string, overrides: Partial<ChatMeta> = {}): ChatMeta {
  return {
    id,
    title: `Chat ${id}`,
    workspaceId: "ws-clean",
    createdAt: NOW - 200 * DAY,
    updatedAt: NOW - 200 * DAY,
    ...overrides,
  };
}

async function harness(options: {
  workspaces?: Workspace[];
  chats?: ChatMeta[];
  pinned?: string[];
  pinnedReadFails?: boolean;
  gitState?: { uncommitted?: number; unpushed?: number; fail?: boolean };
  profileFiles?: Record<string, number>;
  routines?: string[] | "fail";
  /** Put managed worktrees under the profile's own worktree root. */
  worktreesInProfile?: boolean;
  /** Stand-ins for the app's deletion paths, run instead of only recording the id. */
  onRemoveWorktree?: (workspaceId: string, assertStillSafe: () => void) => Promise<void>;
  onRemoveChat?: (chatId: string, assertStillSafe: () => void) => Promise<void>;
  onClearLogs?: (root: string) => Promise<void>;
  onClearBrowserCache?: (root: string) => Promise<void>;
} = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-storage-service-"));
  const removed = { worktrees: [] as string[], chats: [] as string[] };
  const broadcasts: string[] = [];
  const busy = new Set<string>();
  const changing = new Set<string>();
  const terminals = new Set<string>();
  let gitHold: Promise<void> | null = null;
  let heldGitReads = 0;
  let gitState = options.gitState ?? {};
  const pinned = new Set(options.pinned ?? []);

  for (const [relativePath, bytes] of Object.entries(options.profileFiles ?? {})) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.alloc(bytes, 0x61));
  }

  let cleared = 0;
  let browserCleared = 0;
  let routines = options.routines ?? [];
  const workspaces = (options.workspaces ?? []).map((entry) =>
    options.worktreesInProfile && entry.managedWorktree
      ? {
          ...entry,
          managedWorktree: {
            ...entry.managedWorktree,
            worktreePath: path.join(root, "worktrees", "repo", entry.id),
          },
        }
      : entry,
  );
  const service = createStorageUsageService({
    profileRoot: () => root,
    listWorkspaces: async () => workspaces,
    listChats: async () => options.chats ?? [],
    isChatBusy: (chatId) => busy.has(chatId),
    isWorkspaceChanging: (workspaceId) => changing.has(workspaceId),
    hasOpenTerminal: (workspaceId) => terminals.has(workspaceId),
    pinnedChatIds: async () => {
      if (options.pinnedReadFails) throw new Error("triage store unreadable");
      return pinned;
    },
    scheduledTaskWorkspaceIds: async () => {
      if (routines === "fail") throw new Error("schedule store unreadable");
      return routines;
    },
    removeWorktree: async (workspaceId, assertStillSafe) => {
      await options.onRemoveWorktree?.(workspaceId, assertStillSafe);
      removed.worktrees.push(workspaceId);
    },
    removeChat: async (chatId, assertStillSafe) => {
      await options.onRemoveChat?.(chatId, assertStillSafe);
      removed.chats.push(chatId);
    },
    worktreeGitState: async () => {
      if (gitHold) {
        heldGitReads += 1;
        await gitHold;
      }
      if (gitState.fail) throw new Error("git is unavailable");
      return { uncommitted: gitState.uncommitted ?? 0, unpushed: gitState.unpushed ?? 0 };
    },
    readTranscript: async (filePath) => {
      try {
        return await fs.readFile(filePath);
      } catch {
        return undefined;
      }
    },
    clearLogs: async () => {
      cleared += 1;
      await options.onClearLogs?.(root);
    },
    clearBrowserCache: async () => {
      browserCleared += 1;
      await options.onClearBrowserCache?.(root);
    },
    now: () => NOW,
    broadcast: (event) => broadcasts.push(event.kind),
    limits: { maxEntries: 100_000, maxDurationMs: 10_000 },
  });

  return {
    service,
    root,
    removed,
    get cleared() {
      return cleared;
    },
    get browserCleared() {
      return browserCleared;
    },
    broadcasts,
    setBusy: (chatId) => busy.add(chatId),
    setGitState: (next) => {
      gitState = next;
    },
    setChanging: (workspaceId) => changing.add(workspaceId),
    setRoutines: (next) => {
      routines = next;
    },
    setTerminalOpen: (workspaceId) => terminals.add(workspaceId),
    workspaces,
    holdGit: () => {
      const hold = deferred();
      gitHold = hold.promise;
      return () => {
        gitHold = null;
        hold.release();
      };
    },
    heldGitReads: () => heldGitReads,
  };
}

async function withHarness(
  harnessOptions: Parameters<typeof harness>[0],
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await harness(harnessOptions);
  try {
    await run(h);
  } finally {
    h.service.dispose();
    await fs.rm(h.root, { recursive: true, force: true });
  }
}

test("the first read returns at once and the scan fills in behind it", async () => {
  await withHarness(
    { profileFiles: { "chats/index.json": 1_200, "worktrees/w/README": 3_400 } },
    async (h) => {
      const first = await h.service.report();
      assert.equal(first.scan.status, "scanning", "a cold read never waits on a walk, and says one started");
      assert.equal(first.totalBytes, 0);

      const fresh = await h.service.refresh();
      assert.equal(fresh.scan.status, "ready");
      const threads = fresh.categories.find((entry) => entry.id === "threads");
      const worktrees = fresh.categories.find((entry) => entry.id === "worktrees");
      assert.equal(threads?.bytes, await allocated(h.root, "chats/index.json"));
      assert.equal(worktrees?.bytes, await allocated(h.root, "worktrees/w/README"));
      assert.equal(fresh.totalBytes, await allocated(h.root, "chats/index.json", "worktrees/w/README"));
      assert.ok(h.broadcasts.includes("scan-started"));
      assert.ok(h.broadcasts.includes("scan-finished"));
    },
  );
});

test("a cached report is served without rescanning", async () => {
  await withHarness({ profileFiles: { "chats/index.json": 500 } }, async (h) => {
    const fresh = await h.service.refresh();
    const started = h.broadcasts.filter((kind) => kind === "scan-started").length;
    const second = await h.service.report();
    assert.equal(second.totalBytes, fresh.totalBytes);
    assert.equal(
      h.broadcasts.filter((kind) => kind === "scan-started").length,
      started,
      "a fresh cache does not start another walk",
    );
  });
});

test("worktrees are classified with real Git facts and idle days", async () => {
  await withHarness(
    {
      workspaces: [workspace("ws-clean"), workspace("ws-dirty")],
      chats: [chat("chat-a", { workspaceId: "ws-dirty", updatedAt: NOW - 2 * DAY })],
    },
    async (h) => {
      const report = await h.service.refresh();
      const clean = report.worktrees.find((entry) => entry.workspaceId === "ws-clean");
      const dirty = report.worktrees.find((entry) => entry.workspaceId === "ws-dirty");
      assert.equal(clean?.protected, false);
      assert.equal(clean?.idleDays, 100);
      // The chat's newer timestamp is what "last used" means for a worktree.
      assert.equal(dirty?.idleDays, 2);
    },
  );
});

test("a worktree Git cannot be read is listed as protected, never as safe", async () => {
  await withHarness(
    { workspaces: [workspace("ws-clean")], gitState: { fail: true } },
    async (h) => {
      const report = await h.service.refresh();
      const worktree = report.worktrees[0];
      assert.equal(worktree?.protected, true);
      assert.equal(worktree?.protectionReason, "unknown-git-state");
    },
  );
});

test("cleanup removes only the idle worktree, never the one with local work", async () => {
  await withHarness(
    {
      workspaces: [workspace("ws-clean"), workspace("ws-dirty")],
      gitState: { uncommitted: 1 },
    },
    async (h) => {
      assert.equal((await h.service.refresh()).worktrees.every((entry) => entry.protected), true);
      const result = await h.service.cleanup({
        action: "remove-worktrees",
        inactiveDays: 14,
        targetIds: ["ws-clean", "ws-dirty"],
      });
      assert.deepEqual(h.removed.worktrees, []);
      assert.equal(result.removed.length, 0);
      assert.ok(result.skipped.every((entry) => entry.reason === "uncommitted"));

      // The same fixtures with clean trees are removable.
      h.setGitState({ uncommitted: 0, unpushed: 0 });
      await h.service.refresh();
      const clean = await h.service.cleanup({
        action: "remove-worktrees",
        inactiveDays: 14,
        targetIds: ["ws-clean", "ws-dirty"],
      });
      assert.deepEqual(h.removed.worktrees.sort(), ["ws-clean", "ws-dirty"]);
      assert.equal(clean.removed.length, 2);
    },
  );
});

test("a worktree that gains local work after the preview is kept, not deleted", async () => {
  await withHarness({ workspaces: [workspace("ws-clean")] }, async (h) => {
    await h.service.refresh();
    const preview = await h.service.preview({ action: "remove-worktrees", inactiveDays: 14 });
    assert.equal(preview.items.length, 1, "the preview was built from a clean tree");

    // Someone edited a file between the review dialog and the confirmation.
    h.setGitState({ uncommitted: 3 });
    const result = await h.service.cleanup({
      action: "remove-worktrees",
      inactiveDays: 14,
      targetIds: preview.items.map((item) => item.id),
    });
    assert.deepEqual(h.removed.worktrees, [], "the live re-read protected it");
    assert.equal(result.removed.length, 0);
    assert.equal(result.skipped[0]?.reason, "uncommitted");
  });
});

test("a worktree attached to an active chat is never removed", async () => {
  await withHarness(
    {
      workspaces: [workspace("ws-clean")],
      chats: [chat("chat-a", { workspaceId: "ws-clean", updatedAt: NOW - 200 * DAY })],
    },
    async (h) => {
      h.setBusy("chat-a");
      const report = await h.service.refresh();
      assert.equal(report.worktrees[0]?.protectionReason, "active");
      const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 7, targetIds: ["ws-clean"] });
      assert.deepEqual(h.removed.worktrees, []);
      assert.equal(result.freedBytes, 0);
    },
  );
});

test("a chat's size counts only the pictures no other chat shows", async () => {
  const own = "a".repeat(64);
  const shared = "b".repeat(64);
  await withHarness(
    {
      chats: [chat("chat-old", { title: "Old" }), chat("chat-other", { title: "Other" })],
      profileFiles: {
        [`chats/images/${own.slice(0, 2)}/${own}`]: 200_000,
        [`chats/images/${shared.slice(0, 2)}/${shared}`]: 300_000,
      },
    },
    async (h) => {
      await fs.writeFile(
        path.join(h.root, "chats", "chat-old.json"),
        JSON.stringify({ attachments: [{ sha256: own }, { sha256: shared }] }),
      );
      await fs.writeFile(path.join(h.root, "chats", "chat-other.json"), JSON.stringify({ attachments: [{ sha256: shared }] }));
      const report = await h.service.refresh();
      const old = report.threads.find((entry) => entry.chatId === "chat-old");
      const other = report.threads.find((entry) => entry.chatId === "chat-other");
      // Deleting "Old" frees its transcript and its own picture; the shared one stays for "Other".
      assert.equal(old?.bytes, await allocated(h.root, "chats/chat-old.json", `chats/images/${own.slice(0, 2)}/${own}`));
      assert.equal(old?.imageCount, 2);
      assert.equal(other?.bytes, await allocated(h.root, "chats/chat-other.json"));
      assert.equal(old?.bytesComplete, true);
    },
  );
});

test("chats are deleted only one at a time, and protected chats never", async () => {
  await withHarness(
    {
      chats: [
        chat("chat-old", { title: "Old" }),
        chat("chat-older", { title: "Older" }),
        chat("chat-pinned", { title: "Pinned" }),
        chat("chat-owned", { title: "A Bot's", botId: "bot-1" }),
      ],
      pinned: ["chat-pinned"],
    },
    async (h) => {
      await h.service.refresh();
      await assert.rejects(
        h.service.cleanup({ action: "delete-threads", inactiveDays: 30 }),
        /one at a time/u,
        "there is no sweep of old chats",
      );
      await assert.rejects(
        h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-old", "chat-older"] }),
        /one at a time/u,
      );
      assert.deepEqual(h.removed.chats, []);

      const pinned = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-pinned"] });
      const owned = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-owned"] });
      assert.equal(pinned.skipped[0]?.reason, "pinned");
      assert.equal(owned.skipped[0]?.reason, "owned");
      assert.deepEqual(h.removed.chats, []);

      const result = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-old"] });
      assert.deepEqual(h.removed.chats, ["chat-old"]);
      assert.equal(result.removed.length, 1);
    },
  );
});

test("a worktree a scheduled task runs in is kept, and an unreadable task list keeps them all", async () => {
  await withHarness(
    { workspaces: [workspace("ws-routine"), workspace("ws-clean")], routines: ["ws-routine"] },
    async (h) => {
      const report = await h.service.refresh();
      assert.equal(
        report.worktrees.find((entry) => entry.workspaceId === "ws-routine")?.protectionReason,
        "routine",
      );
      const preview = await h.service.preview({ action: "remove-worktrees", inactiveDays: 14 });
      assert.deepEqual(preview.items.map((item) => item.id), ["ws-clean"]);

      // A task added to the clean worktree after the preview keeps it too.
      h.setRoutines(["ws-routine", "ws-clean"]);
      const late = await h.service.cleanup({
        action: "remove-worktrees",
        inactiveDays: 14,
        targetIds: preview.items.map((item) => item.id),
      });
      assert.deepEqual(h.removed.worktrees, []);
      assert.equal(late.skipped.find((entry) => entry.id === "ws-clean")?.reason, "routine");

      h.setRoutines("fail");
      await h.service.refresh(); // joins the rescan the last cleanup started
      await h.service.refresh();
      const blind = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-clean"] });
      assert.deepEqual(h.removed.worktrees, [], "no worktree is removed while scheduled tasks can't be read");
      assert.equal(blind.skipped[0]?.reason, "unknown-routines");
    },
  );
});

test("each worktree is measured once and still listed when the walk runs out of budget", async () => {
  const files: Record<string, number> = {};
  for (let index = 0; index < 30; index += 1) files[`worktrees/repo/ws-a/file-${index}`] = 1_000;
  await withHarness(
    { workspaces: [workspace("ws-a"), workspace("ws-b")], worktreesInProfile: true, profileFiles: files },
    async (h) => {
      const report = await h.service.refresh();
      const a = report.worktrees.find((entry) => entry.workspaceId === "ws-a");
      const category = report.categories.find((entry) => entry.id === "worktrees");
      assert.equal(a?.bytes, category?.bytes, "the category is the worktree, not twice it");
      assert.equal(a?.bytesComplete, true);
    },
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-storage-budget-"));
  try {
    for (const [relativePath, bytes] of Object.entries(files)) {
      const target = path.join(root, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.alloc(bytes, 0x61));
    }
    const inProfile = (id: string): Workspace =>
      workspace(id, {
        managedWorktree: { ...workspace(id).managedWorktree!, worktreePath: path.join(root, "worktrees", "repo", id) },
      });
    const service = createStorageUsageService({
      profileRoot: () => root,
      listWorkspaces: async () => [inProfile("ws-a"), inProfile("ws-b")],
      listChats: async () => [],
      isChatBusy: () => false,
      isWorkspaceChanging: () => false,
      hasOpenTerminal: () => false,
      pinnedChatIds: async () => new Set<string>(),
      scheduledTaskWorkspaceIds: async () => [],
      removeWorktree: async () => undefined,
      removeChat: async () => undefined,
      worktreeGitState: async () => ({ uncommitted: 0, unpushed: 0 }),
      readTranscript: async () => undefined,
      clearLogs: async () => undefined,
      clearBrowserCache: async () => undefined,
      now: () => NOW,
      limits: { maxEntries: 10, maxDurationMs: 60_000 },
    });
    const report = await service.refresh();
    assert.equal(report.scan.truncated, true);
    assert.deepEqual(
      report.worktrees.map((entry) => entry.workspaceId).sort(),
      ["ws-a", "ws-b"],
      "a worktree the walk never reached is still listed, so it can be reviewed",
    );
    assert.ok(report.worktrees.some((entry) => entry.bytesComplete === false));
    service.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a folder the walk had to skip makes that category and its cleanup a minimum", async () => {
  const deep = `logs/${Array.from({ length: 30 }, (_, index) => `d${index}`).join("/")}/old.log`;
  await withHarness(
    { profileFiles: { [deep]: 5_000, "logs/today.log": 2_000, "workspace-artifacts/a.bin": 3_000 } },
    async (h) => {
      const report = await h.service.refresh();
      assert.equal(report.scan.status, "ready");
      assert.equal(report.scan.truncated, true, "a skipped folder is not reported as an exact total");
      const logs = report.categories.find((entry) => entry.id === "logs");
      assert.equal(logs?.complete, false);
      assert.equal(logs?.bytes, await allocated(h.root, "logs/today.log"), "the rest of the folder is still counted");
      assert.notEqual(
        report.categories.find((entry) => entry.id === "artifacts")?.complete,
        false,
        "other categories are measured in full",
      );
      const preview = await h.service.preview({ action: "clear-logs", inactiveDays: 14 });
      assert.equal(preview.totalComplete, false, "clearing it can free more than it promises, never less");
    },
  );
});

test("browser data counts the whole profile, and Clear cache frees only its cache folders", async () => {
  await withHarness(
    {
      onClearBrowserCache: async (root) => {
        await fs.rm(path.join(root, "Cache"), { recursive: true });
        await fs.rm(path.join(root, "Partitions/aiden-browser-profile-abc/Cache"), { recursive: true });
        await fs.rm(path.join(root, "Partitions/aiden-bot-bot~3a1/Code Cache"), { recursive: true });
      },
      profileFiles: {
        "Partitions/aiden-browser-profile-abc/Cookies": 50_000,
        "Partitions/aiden-browser-profile-abc/Cache/Cache_Data/data_1": 400_000,
        "Partitions/aiden-bot-bot~3a1/Code Cache/js/index": 100_000,
        // A partition Aiden did not create: counted, but Clear cache never touches it.
        "Partitions/someone-else/Cache/Cache_Data/data_2": 70_000,
        "Cache/Cache_Data/data_0": 20_000,
        "Preferences": 3_000,
      },
    },
    async (h) => {
      const report = await h.service.refresh();
      assert.equal(
        report.categories.find((entry) => entry.id === "browser")?.bytes,
        await allocated(
          h.root,
          "Partitions/aiden-browser-profile-abc/Cookies",
          "Partitions/aiden-browser-profile-abc/Cache/Cache_Data/data_1",
          "Partitions/aiden-bot-bot~3a1/Code Cache/js/index",
          "Partitions/someone-else/Cache/Cache_Data/data_2",
          "Cache/Cache_Data/data_0",
        ),
        "the app's own cache shows under Browser data, where Clear cache is",
      );
      assert.equal(
        report.browserCacheBytes,
        await allocated(
          h.root,
          "Partitions/aiden-browser-profile-abc/Cache/Cache_Data/data_1",
          "Partitions/aiden-bot-bot~3a1/Code Cache/js/index",
          "Cache/Cache_Data/data_0",
        ),
        "cookies and other apps' partitions are not part of what Clear cache frees",
      );
      // Anything the layout does not name still counts toward the total.
      assert.equal(
        report.categories.find((entry) => entry.id === "other")?.bytes,
        await allocated(h.root, "Preferences"),
      );
      const result = await h.service.cleanup({ action: "clear-browser-cache", inactiveDays: 14 });
      assert.equal(h.browserCleared, 1);
      assert.equal(result.freedBytes, report.browserCacheBytes);
    },
  );
});

test("clearing logs calls the diagnostics owner once and frees what was measured", async () => {
  await withHarness(
    {
      profileFiles: { "logs/aiden.log": 4_000, "Crashpad/x.dmp": 1_000 },
      onClearLogs: async (root) => {
        await fs.rm(path.join(root, "logs/aiden.log"));
        await fs.rm(path.join(root, "Crashpad/x.dmp"));
      },
    },
    async (h) => {
      await h.service.refresh();
      const expected = await allocated(h.root, "logs/aiden.log", "Crashpad/x.dmp");
      const result = await h.service.cleanup({ action: "clear-logs", inactiveDays: 14 });
      assert.equal(h.cleared, 1);
      assert.equal(result.freedBytes, expected);
      assert.equal(result.removed.length, 1);
    },
  );
});

test("a clear reports what really left the disk, not what the plan measured", async () => {
  // Today's log and a dump Crashpad keeps are still there after the clear.
  await withHarness(
    {
      profileFiles: { "logs/old.log": 40_000, "Crashpad/completed/x.dmp": 90_000 },
      onClearLogs: async (root) => {
        await fs.rm(path.join(root, "logs/old.log"));
      },
    },
    async (h) => {
      await h.service.refresh();
      const went = await allocated(h.root, "logs/old.log");
      const result = await h.service.cleanup({ action: "clear-logs", inactiveDays: 14 });
      assert.equal(result.freedBytes, went);
    },
  );
  // A cache a live session kept hold of frees nothing, and says so.
  await withHarness(
    { profileFiles: { "Cache/Cache_Data/data_0": 20_000 } },
    async (h) => {
      await h.service.refresh();
      const result = await h.service.cleanup({ action: "clear-browser-cache", inactiveDays: 14 });
      assert.equal(result.freedBytes, 0);
    },
  );
});

test("a clear that fails partway still counts what it deleted and reports the failure", async () => {
  await withHarness(
    {
      profileFiles: { "logs/old.log": 40_000, "logs/locked.log": 8_000 },
      onClearLogs: async (root) => {
        await fs.rm(path.join(root, "logs/old.log"));
        throw new Error("EBUSY");
      },
    },
    async (h) => {
      await h.service.refresh();
      const went = await allocated(h.root, "logs/old.log");
      const result = await h.service.cleanup({ action: "clear-logs", inactiveDays: 14 });
      assert.equal(result.failed.length, 1);
      assert.equal(result.removed.length, 0);
      assert.equal(result.freedBytes, went);
    },
  );
});

test("a rescan that raced a removal never brings the removed worktree back", async () => {
  const removal = deferred();
  let removing = false;
  let live: Harness | undefined;
  await withHarness(
    {
      workspaces: [workspace("ws-a")],
      onRemoveWorktree: async () => {
        removing = true;
        await removal.promise;
        live!.workspaces.length = 0;
      },
    },
    async (h) => {
      live = h;
      await h.service.refresh();
      const cleanup = h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-a"] });
      await until(() => removing);

      // The person presses Measure again while the removal runs: this walk has
      // already read the workspace list when the removal commits.
      const releaseGit = h.holdGit();
      const racing = h.service.refresh();
      await until(() => h.heldGitReads() > 0);
      removal.release();
      await cleanup;
      releaseGit();
      await racing;

      assert.deepEqual((await h.service.report()).worktrees, [], "the walk that saw it is thrown away");
    },
  );
});

test("something already gone is reported as gone, never as protected", async () => {
  const chats = [chat("chat-old")];
  await withHarness({ chats, workspaces: [workspace("ws-a")] }, async (h) => {
    await h.service.refresh();
    chats.length = 0;
    h.workspaces.length = 0;

    const thread = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-old"] });
    assert.deepEqual(thread.skipped, []);
    assert.match(thread.failed[0]?.reason ?? "", /already gone/u);

    // The rescan after that cleanup no longer lists the worktree at all.
    const worktree = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-a"] });
    assert.deepEqual(worktree.skipped, []);
    assert.match(worktree.failed[0]?.reason ?? "", /already gone/u);
    assert.deepEqual(h.removed, { worktrees: [], chats: [] });
  });
  await withHarness({ workspaces: [workspace("ws-a")] }, async (h) => {
    await h.service.refresh();
    h.workspaces.length = 0;
    const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-a"] });
    assert.deepEqual(result.skipped, [], "listed in a report that is now out of date");
    assert.match(result.failed[0]?.reason ?? "", /already gone/u);
  });
});

test("work that starts between the last check and the deletion keeps the item", async () => {
  let live: Harness | undefined;
  await withHarness(
    {
      chats: [chat("chat-old")],
      onRemoveChat: async (chatId, assertStillSafe) => {
        live!.setBusy(chatId);
        assertStillSafe();
      },
    },
    async (h) => {
      live = h;
      await h.service.refresh();
      const result = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-old"] });
      assert.deepEqual(h.removed.chats, []);
      assert.deepEqual(result.failed, [], "keeping it is not a failure");
      assert.equal(result.skipped[0]?.reason, "active");
    },
  );
  await withHarness(
    {
      workspaces: [workspace("ws-a")],
      chats: [chat("chat-a", { workspaceId: "ws-a" })],
      onRemoveWorktree: async (_workspaceId, assertStillSafe) => {
        live!.setBusy("chat-a");
        assertStillSafe();
      },
    },
    async (h) => {
      live = h;
      await h.service.refresh();
      const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-a"] });
      assert.deepEqual(h.removed.worktrees, []);
      assert.equal(result.skipped[0]?.reason, "active");
    },
  );
  await withHarness(
    {
      workspaces: [workspace("ws-a")],
      onRemoveWorktree: async (workspaceId, assertStillSafe) => {
        live!.setTerminalOpen(workspaceId);
        assertStillSafe();
      },
    },
    async (h) => {
      live = h;
      await h.service.refresh();
      const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-a"] });
      assert.deepEqual(h.removed.worktrees, []);
      assert.equal(result.skipped[0]?.reason, "terminal");
    },
  );
});

test("a worktree with a terminal open is kept, because removal would kill that shell", async () => {
  await withHarness({ workspaces: [workspace("ws-a"), workspace("ws-b")] }, async (h) => {
    h.setTerminalOpen("ws-a");
    const report = await h.service.refresh();
    assert.equal(report.worktrees.find((entry) => entry.workspaceId === "ws-a")?.protectionReason, "terminal");
    const preview = await h.service.preview({ action: "remove-worktrees", inactiveDays: 14 });
    assert.deepEqual(preview.items.map((item) => item.id), ["ws-b"]);

    // Opened after the review, still kept.
    h.setTerminalOpen("ws-b");
    const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-b"] });
    assert.deepEqual(h.removed.worktrees, []);
    assert.equal(result.skipped[0]?.reason, "terminal");
  });
});

test("a worktree path that resolves outside the profile is never walked", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-storage-outside-"));
  try {
    await fs.mkdir(path.join(outside, "ws-a"));
    await fs.writeFile(path.join(outside, "ws-a", "big.bin"), Buffer.alloc(200_000, 0x61));
    await withHarness(
      { workspaces: [workspace("ws-a")], worktreesInProfile: true, profileFiles: { "chats/index.json": 10 } },
      async (h) => {
        // The lexical path sits under worktrees/, but a parent folder is a link out.
        await fs.mkdir(path.join(h.root, "worktrees"));
        await fs.symlink(outside, path.join(h.root, "worktrees", "repo"));
        const report = await h.service.refresh();
        assert.equal(report.worktrees[0]?.bytes, 0);
        assert.equal(report.categories.find((entry) => entry.id === "worktrees")?.bytes ?? 0, 0);
      },
    );
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("a worktree sweep deletes only ids the person reviewed", async () => {
  await withHarness({ workspaces: [workspace("ws-a"), workspace("ws-b")] }, async (h) => {
    await h.service.refresh();
    await assert.rejects(
      h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14 }),
      /reviewed/u,
      "a request that names nothing does not fall back to everything idle",
    );
    assert.deepEqual(h.removed.worktrees, []);
    // Reviewing is still how the list is built.
    const preview = await h.service.preview({ action: "remove-worktrees", inactiveDays: 14 });
    assert.equal(preview.items.length, 2);

    await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-a"] });
    assert.deepEqual(h.removed.worktrees, ["ws-a"]);
  });
});

test("quitting stops a sweep at the next item and waits for the one in progress", async () => {
  const first = deferred();
  let started = 0;
  await withHarness(
    {
      workspaces: [workspace("ws-a"), workspace("ws-b"), workspace("ws-c")],
      onRemoveWorktree: async () => {
        started += 1;
        await first.promise;
      },
    },
    async (h) => {
      await h.service.refresh();
      const cleanup = h.service.cleanup({
        action: "remove-worktrees",
        inactiveDays: 14,
        targetIds: ["ws-a", "ws-b", "ws-c"],
      });
      await until(() => started === 1);

      let shutDown = false;
      const shutdown = h.service.shutdown().then(() => {
        shutDown = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(shutDown, false, "the removal in progress finishes before quit goes on");

      first.release();
      await shutdown;
      const result = await cleanup;
      assert.deepEqual(h.removed.worktrees, ["ws-a"]);
      assert.equal(result.removed.length, 1);
      assert.deepEqual(result.failed.map((entry) => entry.id), ["ws-b", "ws-c"]);
      assert.match(result.failed[0]?.reason ?? "", /quit/u);
    },
  );
});

test("overlapping deletes run one after another", async () => {
  let running = 0;
  let peak = 0;
  await withHarness(
    {
      chats: [chat("chat-a"), chat("chat-b"), chat("chat-c")],
      onRemoveChat: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
      },
    },
    async (h) => {
      await h.service.refresh();
      const runs = ["chat-a", "chat-b", "chat-c"].map((id) =>
        h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: [id] }),
      );
      await Promise.all(runs);
      assert.equal(peak, 1);
      assert.deepEqual(h.removed.chats.sort(), ["chat-a", "chat-b", "chat-c"]);
    },
  );
});

test("a worktree whose Git state becomes unreadable after the preview is kept", async () => {
  await withHarness({ workspaces: [workspace("ws-clean")] }, async (h) => {
    await h.service.refresh();
    const preview = await h.service.preview({ action: "remove-worktrees", inactiveDays: 14 });
    assert.equal(preview.items.length, 1);
    h.setGitState({ fail: true });
    const result = await h.service.cleanup({
      action: "remove-worktrees",
      inactiveDays: 14,
      targetIds: preview.items.map((item) => item.id),
    });
    assert.deepEqual(h.removed.worktrees, []);
    assert.equal(result.skipped[0]?.reason, "unknown-git-state");
  });
});

test("a chat that starts generating after the preview is kept", async () => {
  await withHarness(
    { chats: [chat("chat-old", { updatedAt: NOW - 200 * DAY })] },
    async (h) => {
      await h.service.refresh();
      const preview = await h.service.preview({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-old"] });
      assert.equal(preview.items.length, 1);
      h.setBusy("chat-old");
      const result = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-old"] });
      assert.deepEqual(h.removed.chats, []);
      assert.equal(result.skipped[0]?.reason, "active");
    },
  );
});

test("an unreadable Inbox pin state protects every thread instead of unpinning them", async () => {
  // Losing a pinned chat to a transient triage read is not recoverable, so an
  // unknown pin state must fail closed: nothing is planned and nothing deleted.
  const h = await harness({
    chats: [chat("chat-old", { updatedAt: NOW - 200 * DAY })],
    pinnedReadFails: true,
  });
  try {
    const report = await h.service.refresh();
    assert.equal(report.threads[0]?.protectionReason, "pinned");
    const preview = await h.service.preview({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-old"] });
    assert.equal(preview.items.length, 0);
    const result = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30, targetIds: ["chat-old"] });
    assert.deepEqual(h.removed.chats, [], "no chat is deleted while pins are unknown");
    assert.equal(result.removed.length, 0);
    assert.equal(result.skipped[0]?.reason, "pinned");
  } finally {
    h.service.dispose();
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test("a failed scan reports failure without losing the last good numbers", async () => {
  await withHarness({ profileFiles: { "chats/index.json": 900 } }, async (h) => {
    await h.service.refresh();
    const first = await h.service.report();
    assert.equal(first.scan.status, "ready");
    assert.equal(first.totalBytes, await allocated(h.root, "chats/index.json"));
  });
});

test("picture hashes are read once per transcript", () => {
  const hash = "b".repeat(64);
  assert.deepEqual([...imageHashes(`"sha256": "${hash}" "sha256": "${hash}"`)], [hash]);
  assert.equal(imageHashes(`"sha256": "short"`).size, 0);
});
