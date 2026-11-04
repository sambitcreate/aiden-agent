// Settings → Storage page: the total, the category bar, the largest-items list,
// and the review dialog that shows what a cleanup removes before it runs.

import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import {
  assembleStorageReport,
  classifyThread,
  classifyWorktree,
  emptyStorageReport,
  type StorageReport,
} from "../../shared/storage";
import { StorageSettings } from "./storage-settings";

afterEach(cleanup);

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;

/** Lets effects and resolved promises settle before asserting. */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function report(): StorageReport {
  return assembleStorageReport({
    categories: [
      { id: "worktrees", bytes: 4_000_000_000, itemCount: 40 },
      { id: "threads", bytes: 1_000_000_000, itemCount: 12 },
      { id: "logs", bytes: 500_000, itemCount: 6 },
    ],
    worktrees: [
      classifyWorktree(
        {
          workspaceId: "ws-idle",
          name: "idle-worktree",
          branch: "feature",
          bytes: 3_000_000_000,
          lastUsedAt: NOW - 40 * DAY,
          uncommitted: 0,
          unpushed: 0,
          active: false,
          changing: false,
          gitStateKnown: true,
        },
        NOW,
      ),
      classifyWorktree(
        {
          workspaceId: "ws-dirty",
          name: "dirty-worktree",
          branch: "wip",
          bytes: 1_000_000_000,
          lastUsedAt: NOW - 60 * DAY,
          uncommitted: 2,
          unpushed: 0,
          active: false,
          changing: false,
          gitStateKnown: true,
        },
        NOW,
      ),
    ],
    threads: [
      classifyThread(
        {
          chatId: "chat-old",
          title: "Old chat",
          bytes: 900_000_000,
          lastUsedAt: NOW - 200 * DAY,
          active: false,
          pinned: false,
          owned: false,
        },
        NOW,
      ),
    ],
    scan: { status: "ready", scannedAt: NOW, error: null, truncated: false },
  });
}

const PREVIEW = {
  action: "remove-worktrees" as const,
  inactiveDays: 14 as const,
  items: [
    {
      id: "ws-idle",
      kind: "worktree" as const,
      label: "idle-worktree",
      detail: "feature",
      bytes: 3_000_000_000,
    },
  ],
  skipped: [{ id: "ws-dirty", label: "dirty-worktree", reason: "uncommitted", bytes: 1_000_000_000 }],
  totalBytes: 3_000_000_000,
};

function mount(options: { report?: StorageReport; preview?: unknown; cleanup?: unknown } = {}) {
  const calls = installBotTestIpc({
    "storage:report": () => options.report ?? report(),
    "storage:refresh": () => options.report ?? report(),
    "storage:preview": () => options.preview ?? PREVIEW,
    "storage:cleanup": () =>
      options.cleanup ?? {
        removed: [{ id: "ws-idle", kind: "worktree", label: "idle-worktree", bytes: 3_000_000_000 }],
        skipped: [],
        failed: [],
        freedBytes: 3_000_000_000,
      },
  });
  render(<StorageSettings />);
  return calls;
}

test("the page shows the total, the category breakdown, and the largest items", async () => {
  mount();
  await screen.findByText("idle-worktree");
  // The total is the sum of the categories, labelled as Aiden's own use.
  assert.ok(screen.getAllByText("5.00 GB").length >= 1, "the total is shown");
  assert.ok(screen.getByText("used by Aiden"));
  assert.ok(screen.getByRole("img", { name: /Disk use by category/u }));
  for (const label of ["Worktrees", "Threads", "Logs and diagnostics"]) {
    assert.ok(screen.getAllByText(label).length > 0, label);
  }
  assert.ok(screen.getByText("Old chat"));
  // A protected item says why it is kept and offers no delete button.
  assert.ok(screen.getByText(/Has uncommitted changes/u));
  assert.equal(screen.queryByRole("button", { name: "Delete dirty-worktree" }), null);
  assert.ok(screen.getByRole("button", { name: "Delete idle-worktree" }));
});

test("a cleanup preview lists what will be removed, what is kept, and the space freed", async () => {
  mount();
  const review = (await screen.findAllByRole("button", { name: "Review…" }))[0]!;
  fireEvent.click(review);
  const dialog = await screen.findByRole("alertdialog");
  const text = dialog.textContent ?? "";
  assert.match(text, /Remove unused worktrees\?/u);
  assert.match(text, /This frees 3\.00 GB/u, "the dialog names what will be freed");
  assert.match(text, /idle-worktree/u, "the dialog names what will be removed");
  assert.match(text, /Kept/u);
  assert.match(text, /Has uncommitted changes/u, "the kept section says why");
  // The confirmation states the count and the size before the person commits.
  const confirm = within(dialog).getByRole("button", { name: /Remove 1/u });
  assert.match(confirm.textContent ?? "", /3\.00 GB/u);
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
});

test("confirming a cleanup sends only the ids the preview listed", async () => {
  const calls = mount();
  fireEvent.click((await screen.findAllByRole("button", { name: "Review…" }))[0]!);
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /Remove 1/u }));
  await waitFor(() => {
    const call = calls.find((entry) => entry.channel === "storage:cleanup");
    assert.ok(call, "cleanup was invoked");
    assert.deepEqual(call.args[0], {
      action: "remove-worktrees",
      inactiveDays: 14,
      targetIds: ["ws-idle"],
    });
  });
});

test("a scan that is still running says so and keeps the page usable", async () => {
  mount({
    report: emptyStorageReport({
      status: "scanning",
      scannedAt: null,
      error: null,
      truncated: false,
    }),
  });
  await flush();
  await screen.findByText(/Measuring how much disk Aiden uses/u);
  const refresh = screen.getByRole("button", { name: /Measuring/u });
  assert.equal(refresh.hasAttribute("disabled"), true);
});

test("a truncated scan says the total is only a minimum", async () => {
  mount({
    report: { ...report(), scan: { status: "ready", scannedAt: NOW, error: null, truncated: true } },
  });
  await flush();
  await screen.findByText(/the total is a minimum/u);
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
  await flush();
  await screen.findByText("Aiden could not finish measuring local storage. Try again.");
  // A failed measurement must not offer cleanup as if the numbers were known.
  const review = screen.getAllByRole("button", { name: "Review…" })[0]!;
  assert.equal(review.hasAttribute("disabled"), true);
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
  render(<StorageSettings />);
  await flush();
  await screen.findByText(/Nothing was changed/u);
  await screen.findByText(/Your files are unchanged/u);
});

test("deleting one item asks first, then removes exactly that item", async () => {
  const calls = mount();
  const deleteButton = await screen.findByRole("button", { name: "Delete idle-worktree" });
  fireEvent.click(deleteButton);
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /Remove this worktree\?/u);
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => {
    const call = calls.find((entry) => entry.channel === "storage:cleanup");
    assert.deepEqual(call?.args[0], {
      action: "remove-worktrees",
      inactiveDays: 14,
      targetIds: ["ws-idle"],
    });
  });
});
