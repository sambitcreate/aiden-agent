// Settings → Storage page: the total, the category bar, the largest-items list,
// and the review dialog that shows what a cleanup removes before it runs.

import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
          name: "aiden · feature",
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
          name: "aiden · wip",
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

function mount(options: {
  report?: StorageReport;
  preview?: unknown;
  cleanup?: unknown;
} = {}) {
  const calls = installBotTestIpc({
    "storage:report": () => options.report ?? report(),
    "storage:refresh": () => options.report ?? report(),
    "storage:preview": () => options.preview ?? {
      action: "remove-worktrees",
      inactiveDays: 14,
      items: [
        { id: "ws-idle", kind: "worktree", label: "aiden · feature", detail: "feature", bytes: 3_000_000_000 },
      ],
      skipped: [
        { id: "ws-dirty", label: "aiden · wip", reason: "uncommitted", bytes: 1_000_000_000 },
      ],
      totalBytes: 3_000_000_000,
    },
    "storage:cleanup": () => options.cleanup ?? {
      removed: [{ id: "ws-idle", kind: "worktree", label: "aiden · feature", bytes: 3_000_000_000 }],
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
  await screen.findByText("5.00 GB");
  // The total is the sum of the categories, labelled as Aiden's own use.
  assert.ok(screen.getByText("used by Aiden"));
  assert.ok(screen.getByRole("img", { name: /Disk use by category/u }));
  for (const label of ["Worktrees", "Threads", "Logs and diagnostics"]) {
    assert.ok(screen.getAllByText(label).length > 0, label);
  }
  assert.ok(screen.getByText("aiden · feature"));
  assert.ok(screen.getByText("Old chat"));
  // A protected item reads its reason and offers no delete button.
  assert.ok(screen.getByText(/Has uncommitted changes/u));
  assert.equal(screen.queryByRole("button", { name: "Delete aiden · wip" }), null);
});

test("a cleanup preview lists what will be removed, what is kept, and the space freed", async () => {
  mount();
  const reviewButton = (await screen.findAllByRole("button", { name: "Review…" }))[0]!;
  fireEvent.click(reviewButton);
  const dialog = await screen.findByRole("dialog");
  assert.match(dialog.textContent ?? "", /Remove unused worktrees\?/u);
  assert.match(dialog.textContent ?? "", /3\.00 GB/u, "the dialog names what will be freed");
  assert.match(dialog.textContent ?? "", /aiden · feature/u);
  assert.match(dialog.textContent ?? "", /Kept/u);
  assert.match(dialog.textContent ?? "", /Has uncommitted changes/u);
  // The confirmation states the count and the size before the person commits.
  const confirm = within(dialog).getByRole("button", { name: /Remove 1 · 3\.00 GB/u });
  fireEvent.click(confirm);
  await waitFor(() => assert.doesNotMatch(document.body.textContent ?? "", /Remove unused worktrees\?/u));
});

test("confirming a cleanup sends only the ids the preview listed", async () => {
  const calls = mount();
  fireEvent.click((await screen.findAllByRole("button", { name: "Review…" }))[0]!);
  const dialog = await screen.findByRole("dialog");
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
  const scanning = emptyStorageReport({
    status: "scanning",
    scannedAt: null,
    error: null,
    truncated: false,
  });
  mount({ report: scanning });
  await screen.findByText(/Measuring how much disk Aiden uses/u);
  const refresh = screen.getByRole("button", { name: /Measuring…/u });
  assert.equal(refresh.hasAttribute("disabled"), true);
});

test("a truncated scan says the total is only a minimum", async () => {
  const truncated = {
    ...report(),
    scan: { status: "ready" as const, scannedAt: NOW, error: null, truncated: true },
  };
  mount({ report: truncated });
  await screen.findByText(/the total is a minimum/u);
});

test("a failed scan explains itself without claiming anything was deleted", async () => {
  mount({
    report: emptyStorageReport({
      status: "failed",
      scannedAt: NOW,
      error: "Aiden could not finish measuring local storage. Try again.",
      truncated: false,
    }),
  });
  await screen.findByText("Aiden could not finish measuring local storage. Try again.");
  assert.match(document.body.textContent ?? "", /Nothing was changed|Your files are unchanged/u);
});

test("deleting one item asks first, then removes exactly that item", async () => {
  const calls = mount();
  const deleteButton = await screen.findByRole("button", { name: "Delete aiden · feature" });
  fireEvent.click(deleteButton);
  const dialog = await screen.findByRole("dialog");
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
