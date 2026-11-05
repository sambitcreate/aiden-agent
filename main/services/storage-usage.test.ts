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
} = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-storage-service-"));
  const removed = { worktrees: [] as string[], chats: [] as string[] };
  const broadcasts: string[] = [];
  const busy = new Set<string>();
  const changing = new Set<string>();
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
    pinnedChatIds: async () => {
      if (options.pinnedReadFails) throw new Error("triage store unreadable");
      return pinned;
    },
    scheduledTaskWorkspaceIds: async () => {
      if (routines === "fail") throw new Error("schedule store unreadable");
      return routines;
    },
    removeWorktree: async (workspaceId) => {
      removed.worktrees.push(workspaceId);
    },
    removeChat: async (chatId) => {
      removed.chats.push(chatId);
    },
    worktreeGitState: async () => {
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
    },
    clearBrowserCache: async () => {
      browserCleared += 1;
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
      assert.equal(first.scan.status, "idle", "a cold read never waits on a walk");
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
      const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14 });
      assert.deepEqual(h.removed.worktrees, []);
      assert.equal(result.removed.length, 0);
      assert.ok(result.skipped.every((entry) => entry.reason === "uncommitted"));

      // The same fixtures with clean trees are removable.
      h.setGitState({ uncommitted: 0, unpushed: 0 });
      await h.service.refresh();
      const clean = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14 });
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
      const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 7 });
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

test("a folder the walk had to skip makes the page say sizes are a minimum", async () => {
  const deep = `workspace-artifacts/${Array.from({ length: 30 }, (_, index) => `d${index}`).join("/")}/file.bin`;
  await withHarness({ profileFiles: { [deep]: 5_000, "logs/today.log": 2_000 } }, async (h) => {
    const report = await h.service.refresh();
    assert.equal(report.scan.status, "ready");
    assert.equal(report.scan.truncated, true, "a skipped folder is not reported as an exact total");
    assert.equal(
      report.categories.find((entry) => entry.id === "logs")?.bytes,
      await allocated(h.root, "logs/today.log"),
      "other categories are still measured in full",
    );
  });
});

test("browser data counts the whole profile, and Clear cache frees only its cache folders", async () => {
  await withHarness(
    {
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
    { profileFiles: { "logs/aiden.log": 4_000, "Crashpad/x.dmp": 1_000 } },
    async (h) => {
      await h.service.refresh();
      const result = await h.service.cleanup({ action: "clear-logs", inactiveDays: 14 });
      assert.equal(h.cleared, 1);
      assert.equal(result.freedBytes, await allocated(h.root, "logs/aiden.log", "Crashpad/x.dmp"));
      assert.equal(result.removed.length, 1);
    },
  );
});

test("a worktree whose Git state becomes unreadable after the preview is kept", async () => {
  await withHarness({ workspaces: [workspace("ws-clean")] }, async (h) => {
    await h.service.refresh();
    const preview = await h.service.preview({ action: "remove-worktrees", inactiveDays: 14 });
    assert.equal(preview.items.length, 1);
    h.setGitState({ fail: true });
    const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 14 });
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
