import "../main/bots/test-dom";
import assert from "node:assert/strict";
import * as React from "react";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import {
  ChangesRows,
  EnvironmentRows,
  QuickViewUnavailable,
  useChangesSummary,
  useChangesVisibility,
  useEnvironmentSummary,
  useShowWorkspaceFolder,
} from "./environment-overview";
import { toast } from "./ui";
import type { GitInfo, GitPushCapability, GitReview, Workspace } from "../lib/types";
import type { ChatPullRequestView } from "../shared/chat-pull-requests";

afterEach(cleanup);

// Shared fixtures (Tasks 4–5 extend this file).

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "aiden",
  folderPath: "/Users/test/aiden",
  permission: "full",
  createdAt: 0,
  updatedAt: 0,
};

/** IPC channels behind useGitReview, useGitInfo and useGitPushCapability (renderer/lib/ipc.ts). */
const GIT_CHANNELS = {
  review: "git:review",
  info: "workspaces:gitInfo",
  pushCapability: "git:pushCapability",
} as const;

/** IPC channels behind usePreferredEditor and useShowWorkspaceFolder (renderer/lib/ipc.ts). */
const EDITOR_CHANNELS = {
  list: "workspaces:externalEditors",
  open: "workspaces:openInEditor",
  openFolder: "workspaces:openFolder",
} as const;

function reviewFixture(
  summary: Partial<GitReview["summary"]> = {},
  overrides: Partial<GitReview> = {},
): GitReview {
  return {
    isRepo: true,
    branch: "feature/x",
    files: [],
    summary: {
      fileCount: 0,
      additions: 0,
      deletions: 0,
      unavailableStats: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      conflictedFiles: 0,
      ...summary,
    },
    commit: { allowed: true, snapshotComplete: true, repositoryRoot: true, snapshot: "snap" },
    ...overrides,
  };
}

function gitInfoFixture(overrides: Partial<GitInfo> = {}): GitInfo {
  return { isRepo: true, branch: "feature/x", detached: false, unborn: false, ...overrides };
}

function pushFixture(overrides: Partial<GitPushCapability> = {}): GitPushCapability {
  return {
    allowed: true,
    branch: "feature/x",
    remotes: ["origin"],
    remoteIdentities: { origin: "github.com/example/aiden" },
    suggestedRemote: "origin",
    ahead: 0,
    behind: 0,
    repositoryRoot: true,
    remoteState: "local-ref",
    ...overrides,
  };
}

/** Stubs a Git repository (or not) on the three Git channels plus anything extra. */
function installRepoIpc(
  repo: { review?: GitReview; info?: GitInfo; push?: GitPushCapability },
  extra: Record<string, (...args: unknown[]) => unknown> = {},
) {
  return installBotTestIpc({
    [GIT_CHANNELS.review]: () => repo.review ?? reviewFixture(),
    [GIT_CHANNELS.info]: () => repo.info ?? gitInfoFixture(),
    [GIT_CHANNELS.pushCapability]: () => repo.push ?? pushFixture(),
    // The Folder row discovers installed editors; none by default.
    [EDITOR_CHANNELS.list]: () => [],
    ...extra,
  });
}

function installNonRepoIpc() {
  return installRepoIpc({
    review: reviewFixture({}, { isRepo: false, branch: undefined }),
    info: { isRepo: false },
    push: pushFixture({ allowed: false, reason: "Not a Git repository", remotes: [] }),
  });
}

function renderWithClient(ui: React.ReactElement) {
  const client = createBotTestQueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function wrapperWithClient() {
  const client = createBotTestQueryClient();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function renderChangesRows(props: Partial<React.ComponentProps<typeof ChangesRows>> = {}) {
  return renderWithClient(
    <ChangesRows
      workspace={WORKSPACE}
      active
      mutationBlockedReason={null}
      onGitOperationBusyChange={() => {}}
      onOpenReview={() => {}}
      {...props}
    />,
  );
}

function renderEnvironmentRows(props: Partial<React.ComponentProps<typeof EnvironmentRows>> = {}) {
  return renderWithClient(
    <EnvironmentRows
      workspace={WORKSPACE}
      active
      mutationBlockedReason={null}
      onGitOperationBusyChange={() => {}}
      onBrowseFiles={() => {}}
      {...props}
    />,
  );
}

test("Changes rows show line totals, commit/push and compare for a repository", async () => {
  installRepoIpc({
    review: reviewFixture({ fileCount: 2, additions: 12, deletions: 3 }),
    push: pushFixture({ ahead: 1 }),
  });
  renderChangesRows();
  assert.ok(await screen.findByRole("button", { name: /Changes, 2 files, 12 known additions, 3 known deletions/ }));
  assert.ok(await screen.findByRole("button", { name: /Commit or push, 2 changed files, 1 commits ahead/ }));
  assert.ok(screen.getByRole("button", { name: /Compare branch/ }));
});

test("Changes rows render nothing outside a Git repository", async () => {
  const calls = installNonRepoIpc();
  const { container } = renderChangesRows();
  await waitFor(() => assert.ok(calls.some((call) => call.channel === GIT_CHANNELS.review)));
  // Compare counts, not nodes: a failing assert would inspect the whole DOM graph.
  await waitFor(() => assert.equal(container.querySelectorAll("button").length, 0));
});

test("Changes and Compare rows open the matching review mode", async () => {
  installRepoIpc({ review: reviewFixture({ fileCount: 1, additions: 1, deletions: 0 }) });
  const opened: string[] = [];
  renderChangesRows({ onOpenReview: (mode) => opened.push(mode) });
  (await screen.findByRole("button", { name: /^Changes, 1 file/ })).click();
  screen.getByRole("button", { name: /Compare branch/ }).click();
  assert.deepEqual(opened, ["changes", "compare"]);
});

/** IPC channel behind useChatCurrentPullRequest (renderer/lib/ipc.ts pullRequestsApi.current). */
const PULL_REQUEST_CURRENT_CHANNEL = "pullRequests:current";

const PR_VIEW: ChatPullRequestView = {
  host: "github.com",
  repository: "example/aiden",
  number: 42,
  url: "https://github.com/example/aiden/pull/42",
  linked: true,
  title: "Quick View cards",
  state: "open",
  isDraft: false,
  headBranch: "feature/x",
};

test("the Pull request row appears once the chat has a PR and opens it on GitHub", async () => {
  const calls = installRepoIpc({}, {
    [PULL_REQUEST_CURRENT_CHANNEL]: () => ({ pullRequest: PR_VIEW, reason: "created" }),
  });
  const opened: unknown[][] = [];
  const open = mock.method(window, "open", (...args: unknown[]) => {
    opened.push(args);
    return null;
  });
  try {
    renderChangesRows({ chatId: "chat-1" });
    const row = await screen.findByRole("button", {
      name: "Pull request #42, Open. Opens on GitHub",
    });
    assert.ok(row.textContent?.includes("#42 Quick View cards"));
    fireEvent.click(row);
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.[0], PR_VIEW.url);
    assert.ok(calls.some((call) => call.channel === PULL_REQUEST_CURRENT_CHANNEL && call.args[0] === "chat-1"));
  } finally {
    open.mock.restore();
  }
});

test("a merged PR without a title, or with an empty one, is named by its branch", async () => {
  for (const title of [undefined, ""]) {
    installRepoIpc({}, {
      [PULL_REQUEST_CURRENT_CHANNEL]: () => ({
        pullRequest: { ...PR_VIEW, title, state: "merged" },
        reason: "recent-linked",
      }),
    });
    const { unmount } = renderChangesRows({ chatId: "chat-1" });
    const row = await screen.findByRole("button", { name: "Pull request #42, Merged. Opens on GitHub" });
    assert.equal(row.textContent?.includes("#42 feature/x"), true, `title ${JSON.stringify(title)}`);
    unmount();
  }
});

test("no Pull request row until the chat has a PR, and never one without a chat", async () => {
  const calls = installRepoIpc({}, {
    [PULL_REQUEST_CURRENT_CHANNEL]: () => ({ pullRequest: undefined, reason: "none" }),
  });
  renderChangesRows({ chatId: "chat-1" });
  await screen.findByRole("button", { name: /Compare branch/ });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === PULL_REQUEST_CURRENT_CHANNEL)));
  // Let the resolved query render before asserting the row stays absent.
  await act(async () => {});
  assert.equal(screen.queryAllByRole("button", { name: /Pull request/ }).length, 0);
  cleanup();

  const noChatCalls = installRepoIpc({}, {
    [PULL_REQUEST_CURRENT_CHANNEL]: () => ({ pullRequest: PR_VIEW, reason: "created" }),
  });
  renderChangesRows();
  await screen.findByRole("button", { name: /Compare branch/ });
  assert.equal(noChatCalls.some((call) => call.channel === PULL_REQUEST_CURRENT_CHANNEL), false);
  assert.equal(screen.queryAllByRole("button", { name: /Pull request/ }).length, 0);
});

test("a closed Quick View does not ask for the chat's pull request", async () => {
  const calls = installRepoIpc({}, {
    [PULL_REQUEST_CURRENT_CHANNEL]: () => ({ pullRequest: PR_VIEW, reason: "created" }),
  });
  renderChangesRows({ chatId: "chat-1", active: false });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === GIT_CHANNELS.info)));
  await act(async () => {});
  assert.equal(calls.some((call) => call.channel === PULL_REQUEST_CURRENT_CHANNEL), false);
});

test("a blocked mutation disables Commit or push and explains why", async () => {
  installRepoIpc({ review: reviewFixture({ fileCount: 1, additions: 1, deletions: 0 }) });
  renderChangesRows({ mutationBlockedReason: "Aiden is still working in this workspace." });
  const commit = await screen.findByRole("button", { name: /Commit or push/ });
  assert.equal((commit as HTMLButtonElement).disabled, true);
  assert.equal(screen.getByRole("status").textContent, "Aiden is still working in this workspace.");
});

test("Environment rows show the local runtime and the current branch", async () => {
  installRepoIpc({});
  renderEnvironmentRows();
  assert.ok(screen.getByText("Local"));
  assert.ok(screen.getByText("Runs on this device"));
  assert.ok(await screen.findByRole("button", { name: /^Branch feature\/x/ }));
});

test("Environment rows describe a managed worktree and a folder outside Git", async () => {
  installNonRepoIpc();
  renderEnvironmentRows({
    workspace: {
      ...WORKSPACE,
      managedWorktree: {
        repositoryPath: "/Users/test/aiden",
        worktreePath: "/Users/test/.aiden/worktrees/feature-x",
        branch: "feature/x",
        createdFromHead: "abc123",
      },
    },
  });
  assert.ok(screen.getByText("Isolated worktree"));
  assert.ok(await screen.findByText("Not a Git repository"));
  assert.equal(screen.queryAllByRole("button", { name: /^Branch / }).length, 0);
});

test("the Changes summary reports line totals, a clean tree, or nothing outside Git", async () => {
  installRepoIpc({ review: reviewFixture({ fileCount: 2, additions: 12, deletions: 3 }) });
  const dirty = renderHook(() => useChangesSummary(WORKSPACE.id, true), { wrapper: wrapperWithClient() });
  await waitFor(() => assert.match(dirty.result.current?.label ?? "", /2 files, 12 known additions, 3 known deletions/));
  dirty.unmount();

  installRepoIpc({ review: reviewFixture() });
  const clean = renderHook(() => useChangesSummary(WORKSPACE.id, true), { wrapper: wrapperWithClient() });
  await waitFor(() => assert.match(clean.result.current?.label ?? "", /clean/i));
  clean.unmount();

  const calls = installNonRepoIpc();
  const outside = renderHook(() => useChangesSummary(WORKSPACE.id, true), { wrapper: wrapperWithClient() });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === GIT_CHANNELS.review)));
  await waitFor(() => assert.equal(outside.result.current, null));
});

test("the Changes card shows for working changes, unpushed commits, or the chat's PR, never for a clean repo", async () => {
  const visibility = (
    repo: Parameters<typeof installRepoIpc>[0],
    pullRequest: ChatPullRequestView | undefined = undefined,
  ) => {
    const calls = installRepoIpc(repo, {
      [PULL_REQUEST_CURRENT_CHANNEL]: () => ({ pullRequest, reason: pullRequest ? "created" : "none" }),
    });
    const hook = renderHook(() => useChangesVisibility(WORKSPACE.id, "chat-1", true), {
      wrapper: wrapperWithClient(),
    });
    return { calls, hook };
  };
  const settled = async ({ calls }: { calls: { channel: string }[] }) => {
    for (const channel of [GIT_CHANNELS.review, GIT_CHANNELS.pushCapability, PULL_REQUEST_CURRENT_CHANNEL]) {
      await waitFor(() => assert.ok(calls.some((call) => call.channel === channel)));
    }
    await act(async () => {});
  };

  const dirty = visibility({ review: reviewFixture({ fileCount: 1, additions: 2 }) });
  await waitFor(() => assert.equal(dirty.hook.result.current, true));
  dirty.hook.unmount();

  const ahead = visibility({ push: pushFixture({ ahead: 2 }) });
  await waitFor(() => assert.equal(ahead.hook.result.current, true));
  ahead.hook.unmount();

  const withPullRequest = visibility({}, PR_VIEW);
  await waitFor(() => assert.equal(withPullRequest.hook.result.current, true));
  withPullRequest.hook.unmount();

  const clean = visibility({});
  await settled(clean);
  assert.equal(clean.hook.result.current, false);
  clean.hook.unmount();

  const calls = installNonRepoIpc();
  const outside = renderHook(() => useChangesVisibility(WORKSPACE.id, "chat-1", true), {
    wrapper: wrapperWithClient(),
  });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === GIT_CHANNELS.review)));
  await act(async () => {});
  assert.equal(outside.result.current, false);
});

test("an inactive Changes visibility check asks Git nothing", async () => {
  const calls = installRepoIpc({ review: reviewFixture({ fileCount: 1 }) });
  const hook = renderHook(() => useChangesVisibility(WORKSPACE.id, "chat-1", false), {
    wrapper: wrapperWithClient(),
  });
  await act(async () => {});
  assert.equal(hook.result.current, false);
  assert.deepEqual(calls, []);
});

test("the Environment summary names the branch, or Local outside Git", async () => {
  installRepoIpc({});
  const repo = renderHook(() => useEnvironmentSummary(WORKSPACE), { wrapper: wrapperWithClient() });
  await waitFor(() => assert.equal(repo.result.current?.label, "feature/x"));
  repo.unmount();

  installNonRepoIpc();
  const local = renderHook(() => useEnvironmentSummary(WORKSPACE), { wrapper: wrapperWithClient() });
  await waitFor(() => assert.equal(local.result.current?.label, "Local"));
  local.unmount();

  const none = renderHook(() => useEnvironmentSummary(undefined), { wrapper: wrapperWithClient() });
  assert.equal(none.result.current, null);
});

test("Quick View explains a missing folder or disabled file access, and nothing otherwise", () => {
  const missing = render(<QuickViewUnavailable workspace={{ ...WORKSPACE, folderPath: undefined }} />);
  assert.ok(screen.getByText("No workspace folder"));
  missing.unmount();

  const noAccess = render(<QuickViewUnavailable workspace={{ ...WORKSPACE, permission: "none" }} />);
  assert.ok(screen.getByText("File access is off"));
  noAccess.unmount();

  const { container } = render(<QuickViewUnavailable workspace={WORKSPACE} />);
  assert.equal(container.textContent, "");
});

test("the folder row browses files and offers the preferred editor", async () => {
  const calls = installRepoIpc({}, {
    [EDITOR_CHANNELS.openFolder]: () => undefined,
    [EDITOR_CHANNELS.list]: () => [{ id: "vscode", label: "VS Code" }],
    [EDITOR_CHANNELS.open]: () => undefined,
  });
  const browsed: string[] = [];
  renderEnvironmentRows({ onBrowseFiles: () => browsed.push("files") });
  const browse = await screen.findByRole("button", { name: `Browse files in ${WORKSPACE.name}` });
  assert.equal(browse.getAttribute("title"), WORKSPACE.folderPath);
  // The parent folder follows the name, with the home folder shortened to ~.
  assert.equal(browse.textContent, "aiden · ~");
  fireEvent.click(browse);
  assert.deepEqual(browsed, ["files"]);
  // Show in Finder lives in the Environment card header, not on the row.
  assert.equal(screen.queryAllByRole("button", { name: /^Show .* in (Finder|Files)$/ }).length, 0);
  fireEvent.click(await screen.findByRole("button", { name: "Open in VS Code" }));
  await waitFor(() => {
    const opened = calls.filter((call) => call.channel === EDITOR_CHANNELS.open);
    assert.deepEqual(opened.map((call) => call.args), [[WORKSPACE.id, "vscode"]]);
  });
});

test("the folder row shows a nested parent folder relative to home", async () => {
  installRepoIpc({});
  renderEnvironmentRows({ workspace: { ...WORKSPACE, folderPath: "/home/test/code/aiden" } });
  const browse = await screen.findByRole("button", { name: `Browse files in ${WORKSPACE.name}` });
  assert.equal(browse.textContent, "aiden · ~/code");
});

test("the folder row hides the editor action when no editor is installed", async () => {
  const calls = installRepoIpc({});
  renderEnvironmentRows();
  assert.ok(await screen.findByRole("button", { name: `Browse files in ${WORKSPACE.name}` }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === EDITOR_CHANNELS.list)));
  assert.equal(screen.queryAllByRole("button", { name: /^Open in / }).length, 0);
});

test("the folder row leaves editor discovery failures to the toolbar picker", async () => {
  const toastError = mock.method(toast, "error", () => "toast-id");
  try {
    const calls = installRepoIpc({}, {
      [EDITOR_CHANNELS.list]: () => {
        throw new Error("Couldn't list editors");
      },
    });
    renderEnvironmentRows();
    assert.ok(await screen.findByRole("button", { name: `Browse files in ${WORKSPACE.name}` }));
    await waitFor(() => assert.ok(calls.some((call) => call.channel === EDITOR_CHANNELS.list)));
    // Let the rejected discovery settle before checking that it stayed quiet.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(toastError.mock.callCount(), 0);
    assert.equal(screen.queryAllByRole("button", { name: /^Open in / }).length, 0);
  } finally {
    toastError.mock.restore();
  }
});

test("the folder row is absent for a workspace without a folder and disabled without access", async () => {
  installRepoIpc({}, { [EDITOR_CHANNELS.list]: () => [{ id: "vscode", label: "VS Code" }] });
  const { unmount } = renderEnvironmentRows({ workspace: { ...WORKSPACE, folderPath: undefined } });
  assert.equal(screen.queryAllByRole("button", { name: /^Browse files in / }).length, 0);
  unmount();

  renderEnvironmentRows({ workspace: { ...WORKSPACE, permission: "none" } });
  const browse = await screen.findByRole("button", { name: `Browse files in ${WORKSPACE.name}` });
  assert.equal((browse as HTMLButtonElement).disabled, true);
  const editor = await screen.findByRole("button", { name: "Open in VS Code" });
  assert.equal((editor as HTMLButtonElement).disabled, true);
});

test("useShowWorkspaceFolder names the workspace and opens its folder", async () => {
  const calls = installBotTestIpc({ [EDITOR_CHANNELS.openFolder]: () => undefined });
  const { result } = renderHook(() => useShowWorkspaceFolder(WORKSPACE));
  assert.match(result.current.label, /^Show aiden in (Finder|Files)$/);
  act(() => result.current.show());
  await waitFor(() => {
    const opened = calls.filter((call) => call.channel === EDITOR_CHANNELS.openFolder);
    assert.deepEqual(opened.map((call) => call.args), [[WORKSPACE.id]]);
  });
});

test("useShowWorkspaceFolder reports an open failure in a toast instead of throwing", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const toastError = mock.method(toast, "error", () => "toast-id");
  try {
    const calls = installBotTestIpc({
      [EDITOR_CHANNELS.openFolder]: () => {
        throw new Error("Folder is gone");
      },
    });
    const { result } = renderHook(() => useShowWorkspaceFolder(WORKSPACE));
    assert.doesNotThrow(() => result.current.show());
    await waitFor(() => assert.ok(calls.some((call) => call.channel === EDITOR_CHANNELS.openFolder)));
    await waitFor(() =>
      assert.deepEqual(toastError.mock.calls.map((call) => call.arguments[0]), ["Folder is gone"]),
    );
    assert.equal(unhandled.length, 0);
  } finally {
    toastError.mock.restore();
    process.off("unhandledRejection", onUnhandled);
  }
});
