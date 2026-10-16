// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import * as React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GitBranchPicker } from "./git-branch-picker";
import type { GitBranchPickerDraft } from "./draft-work-in";
import { TooltipProvider } from "./ui";
import {
  createChatDraft,
  discardChatDraft,
  getChatDraft,
  setChatDraftGitMode,
  subscribeChatDrafts,
  updateChatDraft,
  updateChatDraftWorktree,
} from "../lib/chat-draft";
import { draftWorkInOptions } from "../lib/draft-git-menu";
import type { GitBranches, Workspace } from "../lib/types";

// The real branch menu over the real draft store, with Git reads faked.
// Boolean oracles: a failing assert on a happy-dom node would print the DOM.

let queryClient: QueryClient;
let calls: BotTestIpcCall[];
let branches: GitBranches;
let draftId: string;

const REPO: Workspace = {
  id: "ws-repo",
  name: "app",
  folderPath: "/projects/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

const WORKTREE_BRANCHES: Record<string, string> = {
  "wt-old": "aiden/old-idea",
  "wt-new": "aiden/new-idea",
  "wt-1": "aiden/fix",
};

function worktreeWorkspace(id: string, branch: string, updatedAt: number): Workspace {
  return {
    id,
    name: branch,
    folderPath: `/worktrees/${id}`,
    permission: "full",
    managedWorktree: {
      repositoryPath: "/projects/app",
      worktreePath: `/worktrees/${id}`,
      branch,
      createdFromHead: "abc",
    },
    createdAt: 1,
    updatedAt,
  };
}

beforeEach(() => {
  localStorage.clear();
  branches = {
    isRepo: true,
    current: "main",
    branches: ["main", "develop"],
    remoteBranches: ["origin/main"],
    uncommitted: 0,
    defaultBranch: "main",
    hasRemote: true,
  };
  calls = installBotTestIpc({
    // A managed worktree has its own branch checked out.
    "git:branches": (workspaceId) =>
      String(workspaceId).startsWith("wt-")
        ? { ...branches, current: WORKTREE_BRANCHES[String(workspaceId)] }
        : branches,
    "git:worktrees": () => [],
    "git:checkout": () => null,
    "settings:get": () => null,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  draftId = createChatDraft(REPO.id).chat.id;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  discardChatDraft(draftId);
});

/** The composer's wiring in miniature: the menu edits the real draft. */
function DraftHarness({ workspaces, uncommitted = 0 }: { workspaces: Workspace[]; uncommitted?: number }) {
  const draft = React.useSyncExternalStore(subscribeChatDrafts, () => getChatDraft(draftId));
  if (!draft) return null;
  const workspaceId = draft.chat.workspaceId!;
  const workIn = draftWorkInOptions(workspaces, workspaceId);
  const props: GitBranchPickerDraft = {
    gitMode: workIn.selectedWorktreeId ? "checkout" : draft.gitMode,
    ...(draft.worktree ? { worktree: draft.worktree } : {}),
    workIn,
    onSelectCheckout: () => {
      if (workIn.source && workIn.source.id !== workspaceId) updateChatDraft(draftId, { workspaceId: workIn.source.id });
      setChatDraftGitMode(draftId, "checkout");
    },
    onSelectNewWorktree: () => {
      if (workIn.source && workIn.source.id !== workspaceId) updateChatDraft(draftId, { workspaceId: workIn.source.id });
      setChatDraftGitMode(draftId, "worktree");
    },
    onSelectWorktree: (id) => updateChatDraft(draftId, { workspaceId: id }),
    onUpdateWorktree: (update) => updateChatDraftWorktree(draftId, update),
  };
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  return (
    <GitBranchPicker
      workspaceId={workspaceId}
      branch={current?.managedWorktree?.branch ?? "main"}
      worktreeDescription="Creates a worktree."
      onCreateWorktree={async () => undefined}
      uncommitted={uncommitted}
      managedWorktree={Boolean(current?.managedWorktree)}
      draft={props}
    />
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(element: React.ReactElement) {
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{element}</TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function openMenu(trigger: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  await settle();
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
  await settle();
}

function radio(name: string | RegExp): HTMLElement | null {
  return screen.queryByRole("radio", { name });
}

test("a started chat keeps today's menu: branches and the create-now worktree, no Work in", async () => {
  await mount(
    <GitBranchPicker
      workspaceId={REPO.id}
      branch="main"
      worktreeDescription="Creates a worktree."
      onCreateWorktree={async () => undefined}
    />,
  );
  await openMenu(screen.getByRole("button", { name: "main" }));
  assert.ok(screen.queryByRole("radiogroup", { name: "Work in" }) === null);
  assert.ok(screen.queryByText("New isolated worktree…") !== null);
  assert.ok(screen.queryByText("develop") !== null, "the branch list is shown");
});

test("a draft chooses where to run; existing worktrees are listed only when the repo has some", async () => {
  await mount(<DraftHarness workspaces={[REPO]} />);
  await openMenu(screen.getByRole("button", { name: "main" }));
  assert.ok(screen.queryByRole("radiogroup", { name: "Work in" }) !== null);
  assert.ok(radio(/^This checkout/u)?.getAttribute("aria-checked") === "true");
  assert.ok(radio(/^New worktree/u)?.getAttribute("aria-checked") === "false");
  assert.equal(document.querySelectorAll('[data-work-in-row^="worktree:"]').length, 0);
  assert.ok(screen.queryByText("New isolated worktree…") === null, "a draft creates its worktree on send");
  cleanup();

  const older = worktreeWorkspace("wt-old", "aiden/old-idea", 10);
  const newer = worktreeWorkspace("wt-new", "aiden/new-idea", 20);
  await mount(<DraftHarness workspaces={[REPO, older, newer]} />);
  await openMenu(screen.getByRole("button", { name: "main" }));
  const rows = [...document.querySelectorAll('[data-work-in-row^="worktree:"]')].map(
    (row) => row.getAttribute("data-work-in-row"),
  );
  assert.deepEqual(rows, ["worktree:wt-new", "worktree:wt-old"], "most recent first");

  await click(radio(/^aiden\/old-idea/u)!);
  assert.equal(getChatDraft(draftId)?.chat.workspaceId, "wt-old", "the draft moved to that worktree");
  const chip = screen.getByRole("button", { name: "aiden/old-idea, worktree" });
  await openMenu(chip);
  assert.ok(radio(/^aiden\/old-idea/u)?.getAttribute("aria-checked") === "true");
  assert.ok(screen.queryByText(/Runs in the worktree for aiden\/old-idea/u) !== null);
});

test("uncommitted changes keep this checkout on its branch, and the escape hatch picks New worktree", async () => {
  branches = { ...branches, uncommitted: 2 };
  await mount(<DraftHarness workspaces={[REPO]} uncommitted={2} />);
  await openMenu(screen.getByRole("button", { name: "main, 2 uncommitted changes" }));
  const develop = document.querySelector('[cmdk-item][data-value="develop"]');
  assert.ok(develop?.getAttribute("aria-disabled") === "true", "other branches are disabled");
  await click(develop!);
  assert.ok(!calls.some((call) => call.channel === "git:checkout"), "no checkout ran");

  await click(screen.getByRole("button", { name: "Use a new worktree instead" }));
  assert.equal(getChatDraft(draftId)?.gitMode, "worktree");
  assert.ok(radio(/^New worktree/u)?.getAttribute("aria-checked") === "true");
  assert.ok(screen.queryByRole("radiogroup", { name: "Start from" }) !== null);
  // The chip names the new worktree's base and drops this checkout's change count.
  assert.ok(
    screen.queryByRole("button", { name: "Branch: new worktree from main", hidden: true }) !== null,
  );
  assert.ok(document.querySelector("[data-changes-badge]") === null);
});

test("New worktree offers Start from, the origin toggle only with a remote, and an editable name", async () => {
  setChatDraftGitMode(draftId, "worktree");
  await mount(<DraftHarness workspaces={[REPO]} />);
  // The base resolves to the default branch while the menu is still closed.
  const chip = screen.getByRole("button", { name: "Branch: new worktree from main" });
  assert.deepEqual(getChatDraft(draftId)?.worktree, { baseRef: "main", fromOrigin: true });
  await openMenu(chip);

  await click(radio("develop")!);
  assert.equal(getChatDraft(draftId)?.worktree?.baseRef, "develop");
  const origin = screen.getByRole("switch", { name: "Start from origin/develop" });
  await click(origin);
  assert.equal(getChatDraft(draftId)?.worktree?.fromOrigin, false);

  const nameRow = document.querySelector<HTMLElement>("[data-branch-name-row]")!;
  assert.ok(nameRow.textContent?.includes("Auto (from first message)"));
  await click(nameRow);
  const input = screen.getByRole("textbox", { name: /Branch name/u });
  await act(async () => {
    fireEvent.change(input, { target: { value: "bad..name" } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
  assert.ok(screen.queryByText("Enter a valid Git branch name.") !== null);
  assert.equal(getChatDraft(draftId)?.worktree?.branchName, undefined);
  await act(async () => {
    fireEvent.change(input, { target: { value: "feature/login" } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
  await settle();
  assert.equal(getChatDraft(draftId)?.worktree?.branchName, "feature/login");
  assert.ok(document.querySelector("[data-branch-name-row]")?.textContent?.includes("feature/login"));
  cleanup();

  // Without a remote there is nothing to start from.
  branches = { ...branches, remoteBranches: [], hasRemote: false };
  queryClient.clear();
  await mount(<DraftHarness workspaces={[REPO]} />);
  await openMenu(screen.getByRole("button", { name: "Branch: new worktree from develop" }));
  assert.ok(screen.queryByRole("radiogroup", { name: "Start from" }) !== null);
  assert.ok(screen.queryByRole("switch") === null);
});

test("This checkout from an existing worktree moves the draft back to the repository", async () => {
  const worktree = worktreeWorkspace("wt-1", "aiden/fix", 5);
  updateChatDraft(draftId, { workspaceId: worktree.id });
  await mount(<DraftHarness workspaces={[REPO, worktree]} />);
  await openMenu(screen.getByRole("button", { name: "aiden/fix, worktree" }));
  await click(radio(/^This checkout/u)!);
  assert.equal(getChatDraft(draftId)?.chat.workspaceId, REPO.id);
  assert.equal(getChatDraft(draftId)?.gitMode, "checkout");
});
