// Electron-free shared IPC contracts for workspaces, GitHub pull requests, Git
// review/commit/push/comparison workflows, and workspace file projections.

import type { ApprovalMode, WorkspaceMacGrants } from "./approval-mode.js";

/**
 * How much the Pi agent is allowed to do inside a workspace folder.
 * - "full": file/shell tools run without prompting.
 * - "ask":  read-only tools run; writes and shell commands require approval.
 * - "none": file/shell tools are withheld entirely (chat + web/skills/MCP only).
 */
export type WorkspacePermission = "full" | "ask" | "none";

export interface ManagedWorktree {
  /** Canonical repository root used to create the worktree. */
  repositoryPath: string;
  /** Canonical checkout root; the workspace may point at a nested path inside it. */
  worktreePath: string;
  branch: string;
  /** Stable Git administrative identity; survives worktree moves and branch changes. */
  worktreeGitDir?: string;
  /** Aiden marker persisted inside the original Git administrative directory. */
  ownershipToken?: string;
  /** Filesystem identity of the original checkout root, used to reject path replacements. */
  worktreeDevice?: number;
  worktreeInode?: number;
  /** HEAD the branch pointed to when Aiden created it; used for safe cleanup. */
  createdFromHead: string;
  /**
   * Worktree-relative ignored paths Aiden provisioned at create time. This is
   * the authoritative allowlist for snapshot/deletion classification; the
   * `.worktreeinclude` file is never re-read for lifecycle decisions.
   */
  provisionedFiles?: string[];
}

/** A named working context: an optional folder + a permission level for its chats. */
export interface Workspace {
  id: string;
  name: string;
  /** Absolute path to the folder Pi operates in (undefined = no folder bound yet). */
  folderPath?: string;
  permission: WorkspacePermission;
  /** Workspace-scoped durable memory. Omitted means enabled. */
  memoryEnabled?: boolean;
  /**
   * Present only when the person chose Customize in Workspace settings: this
   * workspace's own approval mode instead of the global one. Earlier releases
   * ignore it and read `permission`, which is never wider.
   */
  approvalMode?: ApprovalMode;
  /** "Allowed in this workspace" grants from Mac cards; removable in Workspace settings. */
  macGrants?: WorkspaceMacGrants;
  /**
   * Skills (by canonical name) switched off for this workspace's chats. The
   * model can't see or call them here; typing `$skill` still runs one.
   * Omitted means every skill that is on in Settings is on here too.
   */
  disabledSkills?: string[];
  /** Connector (MCP server) ids this workspace's chats can't use. Omitted means none. */
  disabledMcpServerIds?: string[];
  /** Present only for worktrees created and owned by Aiden. */
  managedWorktree?: ManagedWorktree;
  /**
   * Set when the workspace was created by Scratch chat (a generated
   * `~/aiden/<slug>` folder). Device-local; Remote projections leave it out.
   */
  scratch?: true;
  /**
   * Set on the hidden workspace behind a "No workspace" chat: one per chat, in
   * Aiden's app-data `chats/` folder, using global settings. Never listed as a
   * workspace row or choice. Device-local; Remote projections leave it out.
   */
  noWorkspace?: true;
  createdAt: number;
  updatedAt: number;
}

/** GitHub pull request and check status reported for a workspace branch. */
export type GitHubPullRequestCheckStatus =
  | "pending"
  | "action-required"
  | "success"
  | "failure"
  | "skipped"
  | "neutral"
  | "cancelled";

export type GitHubPullRequestChecksState = "passing" | "failing" | "pending";

export type GitHubPullRequestAvailability =
  | "ready"
  | "not-repo"
  | "missing-tool"
  | "unauthenticated"
  | "no-pull-request"
  | "not-github"
  | "unsupported"
  | "rate-limited"
  | "error";

export interface GitHubPullRequestCheck {
  name: string;
  status: GitHubPullRequestCheckStatus;
  description?: string;
  url?: string;
}

export type GitHubPullRequestReviewDecision = "approved" | "changes-requested" | "review-required";

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  isDraft?: boolean;
  headBranch: string;
  baseBranch: string;
  headSha?: string;
  author?: string;
  reviewDecision?: GitHubPullRequestReviewDecision | null;
  mergeable?: boolean | null;
  updatedAt?: number;
  checksState?: GitHubPullRequestChecksState | null;
  checks: GitHubPullRequestCheck[];
}

export interface GitHubPullRequestStatus {
  availability: GitHubPullRequestAvailability;
  message?: string;
  /** Epoch ms when a "rate-limited" read may be retried. */
  retryAt?: number;
  pullRequest?: GitHubPullRequestSummary;
}

/** Result of inspecting a folder for git status. */
export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  /** True when HEAD points directly to a commit rather than a local branch. */
  detached?: boolean;
  /** True when the repository has no first commit yet. */
  unborn?: boolean;
  /** Number of uncommitted (staged + unstaged + untracked) entries. */
  uncommitted?: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
  defaultBranch?: string;
  hasRemote?: boolean;
  /** Ahead/behind compare local tracking refs; Aiden never fetches implicitly. */
  remoteState?: "local-ref";
}

/** Branch list for the composer's branch picker. */
export interface GitBranches {
  isRepo: boolean;
  current?: string;
  branches: string[];
  remoteBranches: string[];
  /** Uncommitted entry count on the current branch. */
  uncommitted: number;
  detached?: boolean;
  unborn?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  defaultBranch?: string;
  hasRemote?: boolean;
  remoteState?: "local-ref";
}

/** One checkout reported by `git worktree list --porcelain -z`. */
export interface GitWorktree {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  current: boolean;
}

export type GitReviewFileStatus =
  | "added"
  | "conflicted"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked";

export interface GitReviewFile {
  path: string;
  previousPath?: string;
  status: GitReviewFileStatus;
  staged: boolean;
  unstaged: boolean;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitReviewSummary {
  fileCount: number;
  additions: number;
  deletions: number;
  unavailableStats: number;
  stagedFiles: number;
  unstagedFiles: number;
  conflictedFiles: number;
}

export interface GitCommitCapability {
  allowed: boolean;
  reason?: string;
  snapshot?: string;
  snapshotComplete: boolean;
  repositoryRoot: boolean;
}

export interface GitReview {
  isRepo: boolean;
  branch?: string;
  files: GitReviewFile[];
  summary: GitReviewSummary;
  commit: GitCommitCapability;
}

export interface GitDiffInput {
  expectedSnapshot: string;
  path: string;
}

export type GitCommitMode = "staged" | "all";

export interface GitCommitInput {
  expectedSnapshot: string;
  message: string;
  mode: GitCommitMode;
}

export interface GitCommitResult {
  commit: string;
  branch: string;
  remainingChanges?: number;
  subject: string;
  warning?: string;
}

export interface GitPushCapability {
  allowed: boolean;
  reason?: string;
  branch?: string;
  expectedHead?: string;
  remotes: string[];
  remoteIdentities: Record<string, string>;
  suggestedRemote?: string;
  destinationBranch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  repositoryRoot: boolean;
  remoteState: "local-ref";
}

export interface GitPushInput {
  destinationBranch: string;
  expectedBranch: string;
  expectedHead: string;
  expectedRemoteIdentity: string;
  remote: string;
  setUpstream: boolean;
}

export interface GitPushResult {
  /** Credential-free repository captured from the reviewed push endpoint. */
  pullRequestRepository?: string;
  branch: string;
  commit: string;
  destinationBranch: string;
  remote: string;
  upstreamSet: boolean;
  warning?: string;
}

export interface GitComparison {
  currentBranch?: string;
  expectedHead: string;
  expectedTarget: string;
  targetRef: string;
  targetLabel: string;
  mergeBase: string;
  ahead: number;
  behind: number;
  files: GitReviewFile[];
  summary: GitReviewSummary;
  snapshot: string;
  remoteState: "local-ref";
}

export interface GitComparisonDiffInput {
  expectedHead: string;
  expectedTarget: string;
  mergeBase: string;
  path: string;
  targetRef: string;
}

export interface GitFileDiff {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

export type WorkspaceFileKind = "directory" | "file" | "symlink";

/** Renderer-safe workspace directory entry; filesystem device/inode identities stay in main. */
export interface WorkspaceFileEntry {
  path: string;
  name: string;
  parentPath: string;
  depth: number;
  kind: WorkspaceFileKind;
  symbolic?: boolean;
  size?: number;
  modifiedAt?: number;
}

export interface WorkspaceFileIndex<TEntry extends WorkspaceFileEntry = WorkspaceFileEntry> {
  entries: TEntry[];
  truncated: boolean;
  skippedDirectories: number;
}

export interface WorkspaceFileDocument {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  version: string;
  warning?: string;
}
