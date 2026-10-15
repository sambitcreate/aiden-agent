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
  /**
   * The repository has a remote whose host may serve GitHub pull requests: any
   * host except a known non-GitHub forge (see `remoteCanHostPullRequests`).
   */
  pullRequestRemote: boolean;
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
    input.pullRequestRemote &&
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
 * A cheap, local "could this branch open a PR" signal from the Git status
 * read: a named branch with commits that is not the default branch. There is
 * no cheap ahead-of-base count, so a non-default branch counts whether or not
 * it has been pushed. Without a known remote default branch, `main` and
 * `master` are treated as the default.
 */
export function branchCanOpenPullRequest(
  git: Pick<GitInfo, "branch" | "detached" | "unborn" | "defaultBranch"> | undefined,
): boolean {
  if (!git?.branch || git.detached || git.unborn) return false;
  return git.defaultBranch
    ? git.branch !== git.defaultBranch
    : git.branch !== "main" && git.branch !== "master";
}

/** Hosts that never serve GitHub pull requests; their subdomains are excluded too. */
const NON_GITHUB_FORGES = [
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "dev.azure.com",
  "visualstudio.com",
  "sr.ht",
  "gitea.com",
  "gitee.com",
  "sourceforge.net",
];

/**
 * Whether a repository's canonical key (`host/owner/name`) may host GitHub
 * pull requests. github.com, GHE.com and unknown or self-hosted hosts (which
 * may be GitHub Enterprise Server) qualify; known non-GitHub forges do not.
 * A missing key (identity not recorded) is unknown, so it qualifies.
 */
export function remoteCanHostPullRequests(canonicalKey: string | null | undefined): boolean {
  const host = canonicalKey?.split("/", 1)[0]?.toLowerCase();
  if (!host) return true;
  return !NON_GITHUB_FORGES.some((forge) => host === forge || host.endsWith(`.${forge}`));
}
