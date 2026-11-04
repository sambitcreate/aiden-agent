// Settings → Storage service: the background scan never blocks a read, the
// cache refreshes in the background, and a cleanup never hands a protected
// worktree or an in-use thread to the app's deletion paths.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createStorageUsageService, attributedImageBytes } from "./storage-usage.js";
import type { ChatMeta, Workspace } from "./types.js";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 1_800_000_000_000;

interface Harness {
  service: ReturnType<typeof createStorageUsageService>;
  root: string;
  removed: { worktrees: string[]; chats: string[] };
  cleared: number;
  broadcasts: string[];
  setBusy(chatId: string): void;
  setGitState(input: { uncommitted?: number; unpushed?: number; fail?: boolean }): void;
  setChanging(workspaceId: string): void;
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
  gitState?: { uncommitted?: number; unpushed?: number; fail?: boolean };
  profileFiles?: Record<string, number>;
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
  const service = createStorageUsageService({
    profileRoot: () => root,
    listWorkspaces: async () => options.workspaces ?? [],
    listChats: async () => options.chats ?? [],
    isChatBusy: (chatId) => busy.has(chatId),
    isWorkspaceChanging: (workspaceId) => changing.has(workspaceId),
    pinnedChatIds: async () => pinned,
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
    now: () => NOW,
    broadcast: (event) => broadcasts.push(event.kind),
    limits: { maxEntries: 100_000, maxBytes: 1_000_000_000, maxDurationMs: 10_000 },
  });

  return {
    service,
    root,
    removed,
    get cleared() {
      return cleared;
    },
    broadcasts,
    setBusy: (chatId) => busy.add(chatId),
    setGitState: (next) => {
      gitState = next;
    },
    setChanging: (workspaceId) => changing.add(workspaceId),
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
      assert.equal(threads?.bytes, 1_200);
      assert.equal(worktrees?.bytes, 3_400);
      assert.equal(fresh.totalBytes, 4_600);
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
      const result = await h.service.cleanup({ action: "remove-worktrees", inactiveDays: 0 });
      assert.deepEqual(h.removed.worktrees, []);
      assert.equal(result.freedBytes, 0);
    },
  );
});

test("threads are measured from their transcripts and shared images, and protected ones are never deleted", async () => {
  const imageHash = "a".repeat(64);
  await withHarness(
    {
      chats: [
        chat("chat-old", { title: "Old" }),
        chat("chat-pinned", { title: "Pinned" }),
        chat("chat-owned", { title: "A Bot's", botId: "bot-1" }),
      ],
      pinned: ["chat-pinned"],
      profileFiles: {
        "chats/chat-old.json": 1_000,
        "chats/chat-pinned.json": 1_000,
        "chats/chat-owned.json": 1_000,
        [`chats/images/${imageHash.slice(0, 2)}/${imageHash}`]: 2_000,
      },
    },
    async (h) => {
      // Give one transcript an image reference so attribution is exercised.
      await fs.writeFile(
        path.join(h.root, "chats", "chat-old.json"),
        JSON.stringify({ attachments: [{ kind: "image", sha256: imageHash, size: 2_000 }] }),
      );
      const report = await h.service.refresh();
      const old = report.threads.find((entry) => entry.chatId === "chat-old");
      assert.ok((old?.bytes ?? 0) >= 2_000, "the thread carries its image's bytes");
      assert.equal(
        report.threads.find((entry) => entry.chatId === "chat-owned")?.protectionReason,
        "owned",
      );

      const result = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30 });
      assert.deepEqual(h.removed.chats, ["chat-old"]);
      assert.equal(result.removed.length, 1);
      assert.ok(
        result.skipped.some((entry) => entry.id === "chat-pinned" && entry.reason === "pinned"),
      );
      assert.ok(
        result.skipped.some((entry) => entry.id === "chat-owned" && entry.reason === "owned"),
      );
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
      assert.equal(result.freedBytes, 5_000);
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
      const preview = await h.service.preview({ action: "delete-threads", inactiveDays: 30 });
      assert.equal(preview.items.length, 1);
      h.setBusy("chat-old");
      const result = await h.service.cleanup({ action: "delete-threads", inactiveDays: 30 });
      assert.deepEqual(h.removed.chats, []);
      assert.equal(result.skipped[0]?.reason, "active");
    },
  );
});

test("a failed scan reports failure without losing the last good numbers", async () => {
  await withHarness({ profileFiles: { "chats/index.json": 900 } }, async (h) => {
    await h.service.refresh();
    const first = await h.service.report();
    assert.equal(first.scan.status, "ready");
    assert.equal(first.totalBytes, 900);
  });
});

test("chat images are attributed by content hash once per transcript", () => {
  const hash = "b".repeat(64);
  const sizes = new Map([[hash, 700]]);
  assert.equal(attributedImageBytes(`"sha256": "${hash}"`, sizes), 700);
  assert.equal(attributedImageBytes(`"sha256": "${hash}"`, sizes), 700);
  // The same image twice in one transcript is one file on disk.
  assert.equal(
    attributedImageBytes(`"sha256": "${hash}" "sha256": "${hash}"`, sizes),
    700,
  );
  assert.equal(attributedImageBytes(`"sha256": "${"c".repeat(64)}"`, sizes), 0);
});
