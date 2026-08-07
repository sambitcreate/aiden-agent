//! Wire-contract DTOs (port of the git shapes in `main/services/types.ts`:
//! `GitInfo`, `GitBranches`, `GitWorktree`, plus the `git.ts` result types).
//! All fields are camelCase-serialized for renderer parity.

use serde::{Deserialize, Serialize};

/// Result of inspecting a folder for git status (`GitInfo`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitInfo {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unborn: Option<bool>,
    /// Number of uncommitted (staged + unstaged + untracked) entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncommitted: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_remote: Option<bool>,
    /// Ahead/behind compare local tracking refs; Aiden never fetches implicitly.
    #[serde(rename = "remoteState", skip_serializing_if = "Option::is_none")]
    pub remote_state: Option<String>,
}

impl GitInfo {
    pub fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            detached: None,
            unborn: None,
            uncommitted: None,
            upstream: None,
            ahead: None,
            behind: None,
            default_branch: None,
            has_remote: None,
            remote_state: None,
        }
    }

    pub fn into_branches(self, branches: Vec<String>, remote_branches: Vec<String>) -> GitBranches {
        GitBranches {
            is_repo: self.is_repo,
            current: self.branch.clone(),
            branches,
            remote_branches,
            uncommitted: self.uncommitted.unwrap_or(0),
            detached: self.detached,
            unborn: self.unborn,
            upstream: self.upstream,
            ahead: self.ahead,
            behind: self.behind,
            default_branch: self.default_branch,
            has_remote: self.has_remote,
            remote_state: self.remote_state,
        }
    }
}

/// Branch list for the composer's branch picker (`GitBranches`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitBranches {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub branches: Vec<String>,
    pub remote_branches: Vec<String>,
    /// Uncommitted entry count on the current branch.
    pub uncommitted: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unborn: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_remote: Option<bool>,
    #[serde(rename = "remoteState", skip_serializing_if = "Option::is_none")]
    pub remote_state: Option<String>,
}

/// One checkout reported by `git worktree list --porcelain -z` (`GitWorktree`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub current: bool,
}

/// `GitReviewFileStatus` in git.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitReviewFileStatus {
    Added,
    Conflicted,
    Copied,
    Deleted,
    Modified,
    Renamed,
    Untracked,
}

/// One changed file in a review / comparison (`GitReviewFile`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitReviewFile {
    pub path: String,
    #[serde(rename = "previousPath", skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    pub status: GitReviewFileStatus,
    pub staged: bool,
    pub unstaged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
}

/// `GitReviewSummary` in git.ts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct GitReviewSummary {
    pub file_count: u64,
    pub additions: u64,
    pub deletions: u64,
    pub unavailable_stats: u64,
    pub staged_files: u64,
    pub unstaged_files: u64,
    pub conflicted_files: u64,
}

/// `GitCommitCapability` in git.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitCommitCapability {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    pub snapshot_complete: bool,
    pub repository_root: bool,
}

/// `GitReview` in git.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitReview {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub files: Vec<GitReviewFile>,
    pub summary: GitReviewSummary,
    pub commit: GitCommitCapability,
}

impl GitReview {
    pub fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            files: Vec::new(),
            summary: GitReviewSummary::default(),
            commit: GitCommitCapability {
                allowed: false,
                reason: Some("This workspace is not a Git repository.".to_string()),
                snapshot: None,
                snapshot_complete: false,
                repository_root: false,
            },
        }
    }
}

/// `GitDiffInput` in git.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct GitDiffInput {
    pub expected_snapshot: String,
    pub path: String,
}

/// `GitFileDiff` in git.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitFileDiff {
    pub path: String,
    pub patch: String,
    pub binary: bool,
    pub truncated: bool,
}

/// `GitCommitMode` in git.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitCommitMode {
    Staged,
    All,
}

/// `GitCommitInput` in git.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct GitCommitInput {
    pub expected_snapshot: String,
    pub message: String,
    pub mode: GitCommitMode,
}

/// `GitCommitResult` in git.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitCommitResult {
    pub commit: String,
    pub branch: String,
    #[serde(rename = "remainingChanges", skip_serializing_if = "Option::is_none")]
    pub remaining_changes: Option<u64>,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// `GitPushCapability` in git.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitPushCapability {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_head: Option<String>,
    pub remotes: Vec<String>,
    pub remote_identities: std::collections::BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub repository_root: bool,
    pub remote_state: String,
}

/// `GitPushInput` in git.ts, plus an optional force-with-lease pin.
///
/// Aiden's reviewed push is never forced by default (the TS always passes
/// `--no-force`); pass `force_with_lease` with the remote OID the push must
/// build on to request `--force-with-lease=<ref>:<oid>`.
#[derive(Debug, Clone, PartialEq)]
pub struct GitPushInput {
    pub destination_branch: String,
    pub expected_branch: String,
    pub expected_head: String,
    pub expected_remote_identity: String,
    pub remote: String,
    pub set_upstream: bool,
    /// Remote OID the destination ref must currently point at. `None` = never
    /// force (TS parity).
    pub force_with_lease: Option<String>,
}

/// `GitPushResult` in git.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitPushResult {
    pub branch: String,
    pub commit: String,
    pub destination_branch: String,
    pub remote: String,
    pub upstream_set: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// `GitComparison` in git.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitComparison {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    pub expected_head: String,
    pub expected_target: String,
    pub target_ref: String,
    pub target_label: String,
    pub merge_base: String,
    pub ahead: u64,
    pub behind: u64,
    pub files: Vec<GitReviewFile>,
    pub summary: GitReviewSummary,
    pub snapshot: String,
    pub remote_state: String,
}

/// `GitComparisonDiffInput` in git.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct GitComparisonDiffInput {
    pub expected_head: String,
    pub expected_target: String,
    pub merge_base: String,
    pub path: String,
    pub target_ref: String,
}

/// `GitCreatedWorktree` in git.ts: a managed, Aiden-owned worktree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitCreatedWorktree {
    pub path: String,
    pub head: String,
    pub branch: String,
    /// The path Aiden should authorize; preserves a nested source-workspace scope.
    pub workspace_path: String,
    pub repository_path: String,
    pub worktree_git_dir: String,
    pub ownership_token: String,
    pub worktree_device: u64,
    pub worktree_inode: u64,
    pub created_from_head: String,
}

/// `GitDeleteWorktreeResult` in git.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitDeleteWorktreeResult {
    pub branch_deleted: bool,
}

/// Internal parse result for `git status --porcelain=v2 --branch -z`.
///
/// Extends the TS `ParsedStatus` with granular staged/unstaged/untracked and
/// conflict counts so the UI can show conflict state directly.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub uncommitted: u64,
    pub staged: u64,
    pub unstaged: u64,
    pub untracked: u64,
    pub conflicted: u64,
    pub ignored: u64,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

/// Internal parse result for `git for-each-ref refs/remotes` (`RemoteRefs`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RemoteRefs {
    pub branches: Vec<String>,
    pub default_branch: Option<String>,
}
