// Which chips the composer's context bar shows. The bar is a draft's setup
// strip: workspace, machine and branch. After the first user message the
// window header already names the workspace, so the bar shrinks to a summary
// of the branch and any pull request, or hides for a folder without Git.

import type { GitInfo } from "./types";

export type ComposerContextBarMode = "full" | "summary" | "hidden";

export interface ComposerContextChipsInput {
  /** `started` once the chat has a user message. */
  stage: "draft" | "started";
  /** Appearance → collapse the bar after the first message (default on). */
  autoHide: boolean;
  /** The workspace has a folder on disk. */
  hasFolder: boolean;
  /** Workspace access is off; Git reads then report "not a repository". */
  accessOff: boolean;
  /** The folder is a readable Git repository with a current branch. */
  gitRepo: boolean;
  /** Uncommitted changes in this checkout. */
  uncommitted: number;
  /** A paired Mac can run this chat (the machine picker was offered). */
  machinePicker: boolean;
  /** The repository's remote is on github.com. */
  githubRemote: boolean;
  pullRequest: {
    linked: number;
    pending: number;
    /** GitHub has a PR for the current branch. */
    current: boolean;
    /** The branch has work that a PR could open (see `branchCanOpenPullRequest`). */
    branchCanOpen: boolean;
  };
}

export interface ComposerContextChips {
  workspace: boolean;
  machine: boolean;
  branch: boolean;
  /** Uncommitted-change count shown on the branch chip; 0 shows nothing. */
  changesBadge: number;
  pullRequest: boolean;
  barMode: ComposerContextBarMode;
}

export function composerContextChips(input: ComposerContextChipsInput): ComposerContextChips {
  const branch = input.gitRepo && input.hasFolder && !input.accessOff;
  const { linked, pending, current, branchCanOpen } = input.pullRequest;
  const pullRequest =
    input.stage === "started" &&
    branch &&
    input.githubRemote &&
    (linked > 0 || pending > 0 || current || branchCanOpen);
  const barMode: ComposerContextBarMode =
    input.stage === "draft" || !input.autoHide ? "full" : branch ? "summary" : "hidden";
  const full = barMode === "full";
  return {
    workspace: full,
    machine: full && input.machinePicker,
    branch: branch && barMode !== "hidden",
    changesBadge: branch && barMode !== "hidden" ? Math.max(0, input.uncommitted) : 0,
    pullRequest: pullRequest && barMode !== "hidden",
    barMode,
  };
}

/**
 * A cheap, local "is there something to open as a PR" signal from the Git
 * status read: a named branch other than the default one that is pushed or
 * has unpushed commits. Without a known remote default branch, `main` and
 * `master` are treated as the default.
 */
export function branchCanOpenPullRequest(
  git: Pick<GitInfo, "branch" | "detached" | "unborn" | "defaultBranch" | "upstream" | "ahead"> | undefined,
): boolean {
  if (!git?.branch || git.detached || git.unborn) return false;
  const isDefault = git.defaultBranch
    ? git.branch === git.defaultBranch
    : git.branch === "main" || git.branch === "master";
  if (isDefault) return false;
  return Boolean(git.upstream) || (git.ahead ?? 0) > 0;
}

/**
 * Whether a repository's canonical key (`host/owner/name`) is on a host that
 * always serves GitHub (github.com or GHE.com). GitHub Enterprise Server hosts
 * can only be recognised by the chat's own PR state.
 */
export function isWellKnownGitHubRepository(canonicalKey: string | undefined): boolean {
  const host = canonicalKey?.split("/", 1)[0]?.toLowerCase();
  return host === "github.com" || Boolean(host?.endsWith(".ghe.com"));
}
