// Settings → Storage page: the total, what is using space, the largest
// worktrees and chats, and the review dialog that shows what a cleanup removes
// before it runs.

import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import type * as Storage from "../../shared/storage";
import type {
  StorageCleanupPreview,
  StorageCleanupRequest,
  StorageReport,
  StorageWorktreeFacts,
} from "../../shared/storage";
import type { SettingsSection } from "../../shared/settings-section";
import type { StorageSettings as StorageSettingsView } from "./storage-settings";

// Loaded from the hook so an import failure is the test error, not a file
// that never starts. A static import that throws is reported only as "test failed".
let assembleStorageReport: typeof Storage.assembleStorageReport = () => {
  throw new Error("storage helpers were not loaded");
};
let classifyThread: typeof Storage.classifyThread = () => {
  throw new Error("storage helpers were not loaded");
};
let classifyWorktree: typeof Storage.classifyWorktree = () => {
  throw new Error("storage helpers were not loaded");
};
let emptyStorageReport: typeof Storage.emptyStorageReport = () => {
  throw new Error("storage helpers were not loaded");
};
let StorageSettings: typeof StorageSettingsView = () => {
  throw new Error("storage page was not loaded");
};

before(async () => {
  ({ assembleStorageReport, classifyThread, classifyWorktree, emptyStorageReport } = await import("../../shared/storage"));
  ({ StorageSettings } = await import("./storage-settings"));
});

afterEach(cleanup);

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;

/** Lets effects and resolved promises settle before asserting. */
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const WORKTREE: StorageWorktreeFacts = {
  workspaceId: "ws-idle",
  name: "idle-worktree",
  branch: "feature",
  bytes: 3_000_000_000,
  bytesComplete: true,
  lastUsedAt: NOW - 40 * DAY,
  uncommitted: 0,
  unpushed: 0,
  active: false,
  changing: false,
  gitStateKnown: true,
  routineCount: 0,
};

function report(overrides: { truncated?: boolean; idleComplete?: boolean } = {}): StorageReport {
  return assembleStorageReport({
    categories: [
      { id: "worktrees", bytes: 4_000_000_000, itemCount: 3 },
      { id: "threads", bytes: 1_000_000_000, itemCount: 12 },
      { id: "browser", bytes: 600_000_000, itemCount: 2 },
      { id: "models", bytes: 2_000_000_000, itemCount: 1 },
      { id: "logs", bytes: 500_000, itemCount: 6 },
      { id: "bot-computers", bytes: 0, itemCount: 0 },
    ],
    worktrees: [
      classifyWorktree({ ...WORKTREE, bytesComplete: overrides.idleComplete ?? true }, NOW),
      classifyWorktree(
        { ...WORKTREE, workspaceId: "ws-dirty", name: "dirty-worktree", branch: "wip", bytes: 700_000_000, uncommitted: 2 },
        NOW,
      ),
      classifyWorktree(
        { ...WORKTREE, workspaceId: "ws-routine", name: "nightly-worktree", branch: "nightly", bytes: 300_000_000, routineCount: 1 },
        NOW,
      ),
    ],
    threads: [
      classifyThread(
        {
          chatId: "chat-old",
          title: "Old chat",
          bytes: 900_000_000,
          bytesComplete: true,
          imageCount: 3,
          lastUsedAt: NOW - 200 * DAY,
          active: false,
          pinned: false,
          owned: false,
        },
        NOW,
      ),
      classifyThread(
        {
          chatId: "chat-pinned",
          title: "Pinned chat",
          bytes: 100_000_000,
          bytesComplete: true,
          imageCount: 0,
          lastUsedAt: NOW - 5 * DAY,
          active: false,
          pinned: true,
          owned: false,
        },
        NOW,
      ),
    ],
    browserCacheBytes: 450_000_000,
    scan: { status: "ready", scannedAt: NOW, error: null, truncated: overrides.truncated ?? false },
  });
}

/** What the main process would preview for each request the page sends. */
function previewFor(request: StorageCleanupRequest): StorageCleanupPreview {
  const base = { action: request.action, inactiveDays: request.inactiveDays, totalComplete: true };
  switch (request.action) {
    case "remove-worktrees":
      if (request.targetIds) {
        return {
          ...base,
          items: [{ id: "ws-idle", kind: "worktree", label: "idle-worktree", detail: "feature", bytes: 3_000_000_000 }],
          skipped: [],
          totalBytes: 3_000_000_000,
        };
      }
      return {
        ...base,
        items: [{ id: "ws-idle", kind: "worktree", label: "idle-worktree", detail: "feature", bytes: 3_000_000_000 }],
        skipped: [
          { id: "ws-dirty", label: "dirty-worktree", reason: "uncommitted", bytes: 700_000_000 },
          { id: "ws-routine", label: "nightly-worktree", reason: "routine", bytes: 300_000_000 },
        ],
        totalBytes: 3_000_000_000,
      };
    case "delete-threads":
      return {
        ...base,
        items: [{ id: "chat-old", kind: "thread", label: "Old chat", bytes: 900_000_000 }],
        skipped: [],
        totalBytes: 900_000_000,
      };
    case "clear-browser-cache":
      return {
        ...base,
        items: [{ id: "browser-cache", kind: "browser-cache", label: "Browser cache", bytes: 450_000_000 }],
        skipped: [],
        totalBytes: 450_000_000,
      };
    case "clear-logs":
      return {
        ...base,
        items: [{ id: "logs", kind: "logs", label: "Logs", bytes: 500_000 }],
        skipped: [],
        totalBytes: 500_000,
      };
  }
}

function mount(
  options: {
    report?: StorageReport;
    canOpenSection?: (section: SettingsSection) => boolean;
    onOpenSection?: (section: SettingsSection) => void;
  } = {},
) {
  const calls = installBotTestIpc({
    "storage:report": () => options.report ?? report(),
    "storage:refresh": () => options.report ?? report(),
    "storage:preview": (request: unknown) => previewFor(request as StorageCleanupRequest),
    "storage:cleanup": (request: unknown) => {
      const { targetIds = [] } = request as StorageCleanupRequest;
      return { removed: [], skipped: [], failed: [], freedBytes: targetIds.length };
    },
  });
  render(
    createElement(StorageSettings, {
      canOpenSection: options.canOpenSection,
      onOpenSection: options.onOpenSection,
    }),
  );
  return calls;
}

function cleanupCall(calls: ReturnType<typeof mount>) {
  return calls.find((entry) => entry.channel === "storage:cleanup")?.args[0];
}

test("the page shows the total and what is using space, with an action on each row", async () => {
  mount({ onOpenSection: () => {} });
  await screen.findByText("idle-worktree");
  // The total is the sum of every category.
  assert.ok(screen.getByText("7.60 GB"));
  assert.ok(screen.getByText("used by Aiden"));
  assert.ok(screen.getByRole("img", { name: /Disk use by category/u }));

  const worktrees = screen.getByRole("group", { name: "Worktrees" });
  assert.ok(within(worktrees).getByText("4.00 GB"));
  assert.ok(within(worktrees).getByRole("button", { name: "Review…" }));
  assert.ok(within(screen.getByRole("group", { name: "Browser data" })).getByRole("button", { name: "Clear cache…" }));
  assert.ok(within(screen.getByRole("group", { name: "Logs and diagnostics" })).getByRole("button", { name: "Clear…" }));
  assert.ok(within(screen.getByRole("group", { name: "Voice and helper models" })).getByRole("button", { name: /Manage/u }));
  // Chats are deleted one at a time from their own rows, so the category has no sweep.
  assert.equal(within(screen.getByRole("group", { name: "Chats" })).queryAllByRole("button").length, 0);
  // A category with nothing on disk is not listed.
  assert.ok(!screen.queryByRole("group", { name: "Bot computers" }));
});

test("kept worktrees and chats say why and offer no remove button", async () => {
  mount();
  await screen.findByText("idle-worktree");
  assert.ok(screen.getByText(/Has changes not committed to Git/u));
  assert.ok(screen.getByText(/A scheduled task runs here/u));
  assert.ok(screen.getByText(/Pinned in your Inbox/u));
  assert.ok(!screen.queryByRole("button", { name: "Remove dirty-worktree" }));
  assert.ok(!screen.queryByRole("button", { name: "Remove nightly-worktree" }));
  assert.ok(!screen.queryByRole("button", { name: "Delete Pinned chat" }));
  assert.ok(screen.getByRole("button", { name: "Remove idle-worktree" }));
  assert.ok(screen.getByRole("button", { name: "Delete Old chat" }));
  assert.ok(screen.getByText(/3 pictures/u), "a chat row counts its pictures");
});

test("reviewing worktrees lists what goes, what stays and why, then removes only the listed ids", async () => {
  const calls = mount();
  const row = await screen.findByRole("group", { name: "Worktrees" });
  fireEvent.click(within(row).getByRole("button", { name: "Review…" }));
  const dialog = await screen.findByRole("alertdialog");
  const text = dialog.textContent ?? "";
  assert.match(text, /Remove unused worktrees\?/u);
  assert.match(text, /frees 3\.00 GB/u);
  assert.match(text, /idle-worktree/u);
  assert.match(text, /Kept \(2\)/u);
  assert.match(text, /Has changes not committed to Git/u);
  assert.match(text, /A scheduled task runs here/u);
  assert.match(text, /Branches with commits stay in your repository/u);
  assert.ok(within(dialog).getByRole("combobox", { name: "Unused for" }));

  fireEvent.click(within(dialog).getByRole("button", { name: "Remove 1 · 3.00 GB" }));
  await waitFor(() => assert.ok(cleanupCall(calls)));
  assert.deepEqual(cleanupCall(calls), { action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-idle"] });
});

test("a worktree row's Remove asks first, then removes exactly that worktree", async () => {
  const calls = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Remove idle-worktree" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /Remove this worktree\?/u);
  assert.ok(!within(dialog).queryByRole("combobox", { name: "Unused for" }), "a single item has no time window");
  assert.equal(
    calls.filter((entry) => entry.channel === "storage:cleanup").length,
    0,
    "nothing is removed before the person confirms",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove 1 · 3.00 GB" }));
  await waitFor(() => assert.ok(cleanupCall(calls)));
  assert.deepEqual(cleanupCall(calls), { action: "remove-worktrees", inactiveDays: 14, targetIds: ["ws-idle"] });
});

test("a chat is deleted only from its own row, one at a time", async () => {
  const calls = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Delete Old chat" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /Delete this chat\?/u);
  assert.match(dialog.textContent ?? "", /“Old chat” and its pictures are deleted for good/u);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete · 900 MB" }));
  await waitFor(() => assert.ok(cleanupCall(calls)));
  assert.deepEqual(cleanupCall(calls), { action: "delete-threads", inactiveDays: 14, targetIds: ["chat-old"] });
});

test("clearing the browser cache says sign-ins are kept", async () => {
  const calls = mount();
  const row = await screen.findByRole("group", { name: "Browser data" });
  fireEvent.click(within(row).getByRole("button", { name: "Clear cache…" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /Clear browser cache\?/u);
  assert.match(dialog.textContent ?? "", /You stay signed in to websites/u);
  fireEvent.click(within(dialog).getByRole("button", { name: "Clear 450 MB" }));
  await waitFor(() => assert.ok(cleanupCall(calls)));
  assert.equal((cleanupCall(calls) as StorageCleanupRequest).action, "clear-browser-cache");
});

test("Clear cache is off when the browser has nothing cached", async () => {
  mount({ report: { ...report(), browserCacheBytes: 0 } });
  const row = await screen.findByRole("group", { name: "Browser data" });
  assert.equal(within(row).getByRole("button", { name: "Clear cache…" }).hasAttribute("disabled"), true);
});

test("Manage opens the settings page that owns the data, and is hidden when that page is not available", async () => {
  const opened: SettingsSection[] = [];
  mount({ onOpenSection: (section) => opened.push(section), canOpenSection: (section) => section === "voice" });
  const row = await screen.findByRole("group", { name: "Voice and helper models" });
  fireEvent.click(within(row).getByRole("button", { name: /Manage/u }));
  assert.deepEqual(opened, ["voice"]);
  cleanup();

  mount({ onOpenSection: () => {}, canOpenSection: () => false });
  const hidden = await screen.findByRole("group", { name: "Voice and helper models" });
  assert.equal(within(hidden).queryAllByRole("button").length, 0);
});

test("a scan that is still running says so and keeps cleanup off", async () => {
  mount({
    report: emptyStorageReport({ status: "scanning", scannedAt: null, error: null, truncated: false }),
  });
  await flush();
  await screen.findByText(/Measuring how much disk Aiden uses/u);
  assert.equal(screen.getByRole("button", { name: /Measuring/u }).hasAttribute("disabled"), true);
});

test("a scan that stopped early says sizes are a minimum", async () => {
  mount({ report: report({ truncated: true, idleComplete: false }) });
  await screen.findByText(/some sizes are a minimum/u);
  // The worktree category and a worktree measured only in part read "At least".
  assert.ok(within(screen.getByRole("group", { name: "Worktrees" })).getByText("At least 4.00 GB"));
  assert.ok(screen.getByText("At least 3.00 GB"));
});

test("a scan that failed explains itself and offers no cleanup", async () => {
  mount({
    report: emptyStorageReport({
      status: "failed",
      scannedAt: NOW,
      error: "Aiden could not finish measuring local storage. Try again.",
      truncated: false,
    }),
  });
  await screen.findByText("Aiden could not finish measuring local storage. Try again.");
  // A failed measurement must not offer cleanup as if the numbers were known.
  for (const name of ["Review…", "Clear cache…", "Clear…"]) {
    assert.equal(screen.queryAllByRole("button", { name, hidden: true }).length, 0, name);
  }
  assert.equal(screen.getByRole("button", { name: /Measure again/u }).hasAttribute("disabled"), false);
});

test("a read that throws says the files are unchanged", async () => {
  installBotTestIpc({
    "storage:report": () => {
      throw new Error("unreachable");
    },
    "storage:refresh": () => {
      throw new Error("unreachable");
    },
  });
  render(createElement(StorageSettings));
  await flush();
  await screen.findByText(/Nothing was changed/u);
  await screen.findByText(/Your files are unchanged/u);
});
