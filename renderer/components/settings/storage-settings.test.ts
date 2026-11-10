// Settings → Storage page: the total, what is using space, the largest
// worktrees and chats, and the review dialog that shows what a cleanup removes
// before it runs.

import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, before, mock, test } from "node:test";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import type * as Storage from "../../shared/storage";
import type {
  StorageCleanupPreview,
  StorageCleanupRequest,
  StorageReport,
  StorageWorktreeFacts,
} from "../../shared/storage";
import type { SettingsSection } from "../../shared/settings-section";
import type { toast as Toast } from "../ui";
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

let toast: typeof Toast;

before(async () => {
  ({ assembleStorageReport, classifyThread, classifyWorktree, emptyStorageReport } = await import("../../shared/storage"));
  ({ StorageSettings } = await import("./storage-settings"));
  ({ toast } = await import("../ui"));
});

afterEach(() => {
  mock.restoreAll();
  cleanup();
});

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
  // A scan that stopped early leaves the worktrees and logs walks partial.
  const complete = !overrides.truncated;
  return assembleStorageReport({
    categories: [
      { id: "worktrees", bytes: 4_000_000_000, itemCount: 3, complete },
      { id: "threads", bytes: 1_000_000_000, itemCount: 12 },
      { id: "browser", bytes: 600_000_000, itemCount: 2 },
      { id: "models", bytes: 2_000_000_000, itemCount: 1 },
      { id: "logs", bytes: 500_000, itemCount: 6, complete },
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

/** A row's own actions, leaving out the hint that explains it. */
function rowActions(row: HTMLElement) {
  return within(row)
    .queryAllByRole("button")
    .filter((button) => !button.getAttribute("aria-label")?.startsWith("About "));
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
  assert.equal(rowActions(screen.getByRole("group", { name: "Chats" })).length, 0);
  assert.ok(screen.getByRole("button", { name: "About Browser data" }), "what a category holds is one hint away");
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
  assert.match(dialog.textContent ?? "", /frees up to 450 MB/u, "a file in use stays, so the size is a ceiling");
  fireEvent.click(within(dialog).getByRole("button", { name: "Clear cache" }));
  await waitFor(() => assert.ok(cleanupCall(calls)));
  assert.equal((cleanupCall(calls) as StorageCleanupRequest).action, "clear-browser-cache");
});

test("a cleanup amount that was only partly measured is promised as a minimum", async () => {
  installBotTestIpc({
    "storage:report": () => report(),
    "storage:refresh": () => report(),
    "storage:preview": (request: unknown) => ({
      ...previewFor(request as StorageCleanupRequest),
      totalComplete: false,
    }),
  });
  render(createElement(StorageSettings, {}));
  const row = await screen.findByRole("group", { name: "Logs and diagnostics" });
  fireEvent.click(within(row).getByRole("button", { name: "Clear…" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /at least 500 KB/u);
  cleanup();

  installBotTestIpc({
    "storage:report": () => report(),
    "storage:refresh": () => report(),
    "storage:preview": (request: unknown) => ({
      ...previewFor(request as StorageCleanupRequest),
      totalComplete: false,
    }),
  });
  render(createElement(StorageSettings, {}));
  fireEvent.click(await screen.findByRole("button", { name: "Remove idle-worktree" }));
  const worktree = await screen.findByRole("alertdialog");
  assert.ok(
    within(worktree).getByRole("button", { name: "Remove 1 · at least 3.00 GB" }),
    "the button that deletes must not promise more than the description",
  );
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
  assert.equal(rowActions(hidden).length, 0);
});

test("a scan that is still running says so and keeps cleanup off", async () => {
  mount({
    report: emptyStorageReport({ status: "scanning", scannedAt: null, error: null, truncated: false }),
  });
  await flush();
  await screen.findByText(/Measuring how much disk Aiden uses/u);
  assert.equal(screen.getByRole("button", { name: /Measuring/u }).hasAttribute("disabled"), true);
  assert.equal(screen.queryAllByText("0 KB").length, 0, "nothing measured yet is not the same as nothing used");
});

test("a scan that stopped early says sizes are a minimum", async () => {
  mount({ report: report({ truncated: true, idleComplete: false }) });
  await screen.findByText(/some sizes are a minimum/u);
  // Every partly measured category and worktree reads "At least"; a fully measured one does not.
  assert.ok(within(screen.getByRole("group", { name: "Worktrees" })).getByText("At least 4.00 GB"));
  assert.ok(within(screen.getByRole("group", { name: "Logs and diagnostics" })).getByText("At least 500 KB"));
  assert.ok(within(screen.getByRole("group", { name: "Chats" })).getByText("1.00 GB"));
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
  assert.equal(screen.queryAllByText("0 KB").length, 0, "a failed measurement knows no total");
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
  assert.equal(await screen.findAllByText(/Nothing was changed/u).then((found) => found.length), 1);
  assert.equal(screen.queryAllByText(/Checking how much disk/u).length, 0, "the page has stopped checking");
});

/** Opens the worktree review and answers cleanup with `result`, or by throwing it. */
async function reviewAndConfirm(result: unknown, handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls = installBotTestIpc({
    "storage:report": () => report(),
    "storage:refresh": () => report(),
    "storage:preview": (request: unknown) => previewFor(request as StorageCleanupRequest),
    "storage:cleanup": () => {
      if (result instanceof Error) throw result;
      return result;
    },
    ...handlers,
  });
  render(createElement(StorageSettings, {}));
  const row = await screen.findByRole("group", { name: "Worktrees" });
  fireEvent.click(within(row).getByRole("button", { name: "Review…" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove 1 · 3.00 GB" }));
  return calls;
}

test("a scan that starts behind the page turns cleanup off straight away", async () => {
  let current = report();
  installBotTestIpc({
    "storage:report": () => current,
    "storage:refresh": () => current,
  });
  render(createElement(StorageSettings, {}));
  const remove = await screen.findByRole("button", { name: "Remove idle-worktree" });
  assert.equal(remove.hasAttribute("disabled"), false);

  current = { ...current, scan: { ...current.scan, status: "scanning" } };
  emitBotTestNotification("storage:changed", { kind: "scan-started" });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: /Measuring/u })));
  assert.equal(screen.getByRole("button", { name: "Remove idle-worktree" }).hasAttribute("disabled"), true);
});

test("every worktree a review will remove is on the list, however long it is", async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    id: `ws-${index}`,
    kind: "worktree" as const,
    label: `worktree-${index}`,
    bytes: 1_000,
  }));
  const calls = installBotTestIpc({
    "storage:report": () => report(),
    "storage:refresh": () => report(),
    "storage:preview": (request: unknown) => ({
      ...previewFor(request as StorageCleanupRequest),
      items,
      skipped: [],
      totalBytes: 60_000,
    }),
    "storage:cleanup": () => ({ removed: [], skipped: [], failed: [], freedBytes: 0 }),
  });
  render(createElement(StorageSettings, {}));
  const row = await screen.findByRole("group", { name: "Worktrees" });
  fireEvent.click(within(row).getByRole("button", { name: "Review…" }));
  const dialog = await screen.findByRole("alertdialog");
  const listed = within(within(dialog).getByRole("list", { name: "Worktrees to remove" })).getAllByRole("listitem");
  assert.equal(listed.length, 60);

  fireEvent.click(within(dialog).getByRole("button", { name: /Remove 60/u }));
  await waitFor(() => assert.ok(calls.some((entry) => entry.channel === "storage:cleanup")));
  const sent = calls.find((entry) => entry.channel === "storage:cleanup")?.args[0] as StorageCleanupRequest;
  assert.equal(sent.targetIds?.length, listed.length, "nothing goes that the person was not shown");
});

test("an item kept at the last moment is reported, even when the review already kept others", async () => {
  const success = mock.method(toast, "success", () => "");
  const failure = mock.method(toast, "error", () => "");
  // The review kept two; the removal kept one more it had listed.
  await reviewAndConfirm({
    removed: [{ id: "ws-idle", label: "idle-worktree" }],
    skipped: [{ id: "ws-other", label: "other-worktree", reason: "active", bytes: 1 }],
    failed: [],
    freedBytes: 3_000_000_000,
  });
  await waitFor(() => assert.equal(failure.mock.callCount(), 1));
  assert.equal(success.mock.callCount(), 0);
  assert.match(String(failure.mock.calls[0]!.arguments[0]), /Freed 3\.00 GB\. 1 item was kept/u);
  assert.ok(await screen.findByRole("status"), "the outcome stays on the page after the toast fades");
});

test("a clear that freed nothing measurable does not claim a number", async () => {
  const success = mock.method(toast, "success", () => "");
  installBotTestIpc({
    "storage:report": () => report(),
    "storage:refresh": () => report(),
    "storage:preview": (request: unknown) => previewFor(request as StorageCleanupRequest),
    "storage:cleanup": () => ({
      removed: [{ id: "logs", label: "Logs" }],
      skipped: [],
      failed: [],
      freedBytes: 0,
    }),
  });
  render(createElement(StorageSettings, {}));
  const row = await screen.findByRole("group", { name: "Logs and diagnostics" });
  fireEvent.click(within(row).getByRole("button", { name: "Clear…" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Clear logs" }));
  await waitFor(() => assert.equal(success.mock.callCount(), 1));
  assert.doesNotMatch(String(success.mock.calls[0]!.arguments[0]), /Freed/u);
});

test("a cleanup that fails closes the stale review and measures again", async () => {
  const failure = mock.method(toast, "error", () => "");
  const calls = await reviewAndConfirm(new Error("Aiden is quitting."));
  await waitFor(() => assert.equal(failure.mock.callCount(), 1));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog"), "its list may name what is already gone"));
  await waitFor(() => assert.ok(calls.some((entry) => entry.channel === "storage:refresh")));
  assert.match((await screen.findByRole("status")).textContent ?? "", /could not finish/u);
});

test("a review someone cancelled does not come back when a slower preview lands", async () => {
  let release: (value: StorageCleanupPreview) => void = () => {};
  const calls = installBotTestIpc({
    "storage:report": () => report(),
    "storage:refresh": () => report(),
    "storage:preview": (request: unknown) => {
      const asked = request as StorageCleanupRequest;
      if (asked.inactiveDays === 14) return previewFor(asked);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  render(createElement(StorageSettings, {}));
  const row = await screen.findByRole("group", { name: "Worktrees" });
  fireEvent.click(within(row).getByRole("button", { name: "Review…" }));
  const dialog = await screen.findByRole("alertdialog");

  const select = within(dialog).getByRole("combobox", { name: "Unused for" });
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole("option", { name: "30 days" }));
  await waitFor(() => assert.equal(calls.filter((entry) => entry.channel === "storage:preview").length, 2));

  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));
  release(previewFor({ action: "remove-worktrees", inactiveDays: 30 }));
  await flush();
  assert.ok(!screen.queryByRole("alertdialog"));
});
