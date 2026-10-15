// What the composer's branch chip and branch menu show for a draft: where it
// will run (this checkout, a new worktree created on send, or an existing
// managed worktree), and the words used for each state.

import type { ChatDraftGitMode } from "./chat-draft-git-memory";
import type { Workspace } from "./types";
import type {
  FirstMessageWorktreeInfo,
  FirstMessageWorktreePhase,
} from "../shared/worktree-on-send";

export interface DraftWorktreeChoice {
  workspaceId: string;
  branch: string;
}

export interface DraftWorkInOptions {
  /**
   * The repository checkout that This checkout and New worktree refer to.
   * Undefined when the draft's workspace is a worktree whose repository is
   * not registered as a workspace.
   */
  source?: Workspace;
  /** The managed worktree the draft runs in, when it runs in one. */
  selectedWorktreeId?: string;
  /** The repository's managed worktrees, most recently used first. */
  worktrees: DraftWorktreeChoice[];
}

function insideRepository(folderPath: string, repositoryPath: string): boolean {
  return folderPath === repositoryPath || folderPath.startsWith(`${repositoryPath}/`);
}

/**
 * The Work in choices for a draft in `workspaceId`. A managed worktree's
 * repository is the registered workspace at its `repositoryPath`; a checkout
 * owns the managed worktrees whose repository contains its folder.
 */
export function draftWorkInOptions(
  workspaces: readonly Workspace[],
  workspaceId: string | undefined,
): DraftWorkInOptions {
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!current?.folderPath) return { worktrees: [] };
  const managed = current.managedWorktree;
  const source = managed
    ? workspaces.find(
        (workspace) => !workspace.managedWorktree && workspace.folderPath === managed.repositoryPath,
      )
    : current;
  const belongs = (workspace: Workspace): boolean => {
    const worktree = workspace.managedWorktree;
    if (!worktree || !workspace.folderPath) return false;
    return managed
      ? worktree.repositoryPath === managed.repositoryPath
      : insideRepository(current.folderPath!, worktree.repositoryPath);
  };
  const worktrees = workspaces
    .filter(belongs)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    .map((workspace) => ({ workspaceId: workspace.id, branch: workspace.managedWorktree!.branch }));
  return {
    ...(source ? { source } : {}),
    ...(managed ? { selectedWorktreeId: current.id } : {}),
    worktrees,
  };
}

export type BranchChipKind = "checkout" | "new-worktree" | "worktree";

export interface BranchChipState {
  kind: BranchChipKind;
  /** Visible text. */
  label: string;
  /** Accessible name; undefined when the visible text says it all. */
  ariaLabel?: string;
  /** Uncommitted changes to badge; 0 hides the badge. */
  changes: number;
}

function changesPhrase(count: number): string {
  return `${count} uncommitted change${count === 1 ? "" : "s"}`;
}

/**
 * The branch chip for this checkout, a managed worktree, or a draft that will
 * create a new worktree when it is sent. A new worktree starts clean, so its
 * chip never shows this checkout's change count.
 */
export function branchChipState(input: {
  branch: string;
  uncommitted: number;
  /** The draft's git mode; omitted for a started chat. */
  draftGitMode?: ChatDraftGitMode;
  /** The New worktree base; undefined until it is known. */
  baseRef?: string;
  /** The workspace is an Aiden-managed worktree. */
  managedWorktree?: boolean;
}): BranchChipState {
  if (input.draftGitMode === "worktree") {
    return {
      kind: "new-worktree",
      label: input.baseRef ? `New worktree · from ${input.baseRef}` : "New worktree",
      ariaLabel: input.baseRef
        ? `Branch: new worktree from ${input.baseRef}`
        : "Branch: new worktree",
      changes: 0,
    };
  }
  const changes = Math.max(0, input.uncommitted);
  if (input.managedWorktree) {
    return {
      kind: "worktree",
      label: input.branch,
      ariaLabel: `${input.branch}, worktree${changes > 0 ? `, ${changesPhrase(changes)}` : ""}`,
      changes,
    };
  }
  return {
    kind: "checkout",
    label: input.branch,
    ariaLabel: changes > 0 ? `${input.branch}, ${changesPhrase(changes)}` : undefined,
    changes,
  };
}

/** The headline hint shown under a New worktree draft's title. */
export function draftWorktreeHint(baseRef: string | undefined): string {
  return baseRef
    ? `A new worktree from ${baseRef} will be created when you send`
    : "A new worktree will be created when you send";
}

export interface WorktreeSendProgress {
  phase?: FirstMessageWorktreePhase;
  branch?: string;
  startPoint?: string;
}

/** The progress row's text for the latest worktree-on-send event. */
export function worktreeProgressText(
  progress: WorktreeSendProgress,
  request: { baseRef: string; fromOrigin: boolean },
): string {
  const from = progress.startPoint ?? request.baseRef;
  switch (progress.phase) {
    case "fetching":
      return "Fetching origin…";
    case "creating":
      return progress.branch
        ? `Creating worktree ${progress.branch} from ${from}…`
        : `Creating worktree from ${from}…`;
    case "ready":
      return progress.branch ? `Worktree ${progress.branch} ready` : "Worktree ready";
    default:
      return request.fromOrigin ? "Fetching origin…" : `Creating worktree from ${request.baseRef}…`;
  }
}

/** A quiet note when From origin had no upstream to fetch. */
export function worktreeBaseNote(
  worktree: Pick<FirstMessageWorktreeInfo, "baseSource" | "baseRef">,
): string | undefined {
  return worktree.baseSource === "no-upstream"
    ? `No upstream for ${worktree.baseRef}; started from local ${worktree.baseRef}`
    : undefined;
}
