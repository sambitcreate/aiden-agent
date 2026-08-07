//! Typed Git errors (port of `GitServiceError` / `GitErrorCode` in
//! `main/services/git.ts`, plus a stderr classifier).
//!
//! Every git operation funnels its failures through [`GitError`]; the code
//! mirrors the TS `GitErrorCode` union so callers can branch on
//! `not_repo` / `stale_snapshot` / `conflicted` / `dirty_worktree` etc.
//! [`GitError::from_stderr`] additionally classifies git's stderr output into
//! specific codes (authentication, conflicts, identity, worktree dirt) the way
//! the TS side does with its reason strings.

use std::fmt;

/// `GitErrorCode` in git.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitErrorCode {
    Aborted,
    CommandFailed,
    Conflicted,
    DirtyWorktree,
    InvalidInput,
    InvalidRef,
    NotRepo,
    OutputLimit,
    StaleSnapshot,
    Timeout,
    UnsupportedScope,
    Unborn,
    /// Stderr that git reports as an authentication/credential failure.
    AuthFailed,
}

impl GitErrorCode {
    /// The snake_case string used by the TS `GitErrorCode` union.
    pub fn as_str(self) -> &'static str {
        match self {
            GitErrorCode::Aborted => "aborted",
            GitErrorCode::CommandFailed => "command_failed",
            GitErrorCode::Conflicted => "conflicted",
            GitErrorCode::DirtyWorktree => "dirty_worktree",
            GitErrorCode::InvalidInput => "invalid_input",
            GitErrorCode::InvalidRef => "invalid_ref",
            GitErrorCode::NotRepo => "not_repo",
            GitErrorCode::OutputLimit => "output_limit",
            GitErrorCode::StaleSnapshot => "stale_snapshot",
            GitErrorCode::Timeout => "timeout",
            GitErrorCode::UnsupportedScope => "unsupported_scope",
            GitErrorCode::Unborn => "unborn",
            GitErrorCode::AuthFailed => "auth_failed",
        }
    }
}

impl fmt::Display for GitErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The git error mapped to a stable code plus a public, redacted message.
/// Mirrors `GitServiceError` (code + message + cause).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct GitError {
    pub code: GitErrorCode,
    pub message: String,
    /// Raw stderr of the failed command (kept for tests/logging; the message
    /// is the public, path-redacted text).
    pub stderr: Option<String>,
}

impl GitError {
    pub fn new(code: GitErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            stderr: None,
        }
    }

    pub fn with_stderr(code: GitErrorCode, message: impl Into<String>, stderr: String) -> Self {
        Self {
            code,
            message: message.into(),
            stderr: Some(stderr),
        }
    }

    pub fn aborted() -> Self {
        Self::new(GitErrorCode::Aborted, "Git operation was cancelled.")
    }

    pub fn timeout(seconds: u64) -> Self {
        Self::new(
            GitErrorCode::Timeout,
            format!("Git did not finish within {seconds} seconds."),
        )
    }

    pub fn output_limit() -> Self {
        Self::new(
            GitErrorCode::OutputLimit,
            "Git produced more output than Aiden can safely process.",
        )
    }

    pub fn not_repo() -> Self {
        Self::new(
            GitErrorCode::NotRepo,
            "This workspace is not a Git repository.",
        )
    }

    /// True for the terminal codes that mean the process was stopped before a
    /// definite result (used by push reconciliation in push.rs).
    pub fn is_indeterminate(&self) -> bool {
        matches!(
            self.code,
            GitErrorCode::Timeout | GitErrorCode::Aborted | GitErrorCode::OutputLimit
        )
    }
}

impl From<std::io::Error> for GitError {
    fn from(err: std::io::Error) -> Self {
        Self {
            code: GitErrorCode::CommandFailed,
            message: err.to_string(),
            stderr: None,
        }
    }
}

/// Message hygiene from git.ts (`publicGitMessage`): drop NULs, trim, replace
/// the workspace path and home dir with placeholders, and redact credentials.
pub fn public_git_message(value: &str, cwd: &str, home: &str) -> String {
    let raw = value.replace('\u{0000}', "").trim().to_string();
    let without_workspace = raw.replace(cwd, "the workspace");
    let without_home = without_workspace.replace(home, "~");
    let redacted = redact_git_text(&without_home);
    if redacted.is_empty() {
        "Git command failed.".to_string()
    } else {
        let mut limited: String = redacted.chars().take(1_200).collect();
        if limited.len() < redacted.len() {
            limited.push('\u{2026}');
        }
        limited
    }
}

/// `redactGitText`: mask userinfo in URLs and common credential query params.
fn redact_git_text(value: &str) -> String {
    // URL userinfo: scheme://user@host → scheme://***@host
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("://") {
        result.push_str(&rest[..start]);
        let after_scheme = &rest[start + 3..];
        // Find the @ that terminates userinfo before the next /?# or whitespace.
        let authority_end = after_scheme
            .find(|character: char| {
                character == '/'
                    || character == '?'
                    || character == '#'
                    || character.is_whitespace()
            })
            .unwrap_or(after_scheme.len());
        let authority = &after_scheme[..authority_end];
        if let Some(at) = authority.rfind('@') {
            result.push_str("://***@");
            result.push_str(&authority[at + 1..]);
        } else {
            result.push_str("://");
            result.push_str(authority);
        }
        rest = &after_scheme[authority_end..];
    }
    result.push_str(rest);

    // Query params: mask values of sensitive keys (`token=`, `key=`, …).
    let sensitive = [
        "access_token",
        "auth",
        "key",
        "password",
        "signature",
        "token",
    ];
    for name in sensitive {
        let needle = format!("{name}=");
        let mut masked = String::with_capacity(result.len());
        let mut rest = result.as_str();
        while let Some(position) = rest.find(&needle) {
            masked.push_str(&rest[..position + needle.len()]);
            let value_start = position + needle.len();
            let value_end = rest[value_start..]
                .find('&')
                .map(|offset| value_start + offset)
                .unwrap_or(rest.len());
            masked.push_str("***");
            if value_end < rest.len() {
                masked.push('&');
                rest = &rest[value_end + 1..];
            } else {
                rest = "";
            }
        }
        masked.push_str(rest);
        result = masked;
    }
    result
}

/// Classify git stderr for exit codes the command layer did not already turn
/// into a specific error. Used when an operation allows a nonzero exit code.
pub fn classify_exit(stderr: &str, stdout: &str) -> GitErrorCode {
    let combined = format!("{stdout}\n{stderr}").to_lowercase();
    if contains_any(
        &combined,
        &[
            "authentication failed",
            "could not read username",
            "could not read password",
            "permission denied (publickey",
            "invalid username or password",
            "remote: invalid username",
            "remote: authentication",
            "access denied",
            "not authorized",
            "the requested url returned error: 401",
            "the requested url returned error: 403",
            "error: failed to push some refs",
            "no anonymous access",
        ],
    ) {
        GitErrorCode::AuthFailed
    } else if contains_any(
        &combined,
        &[
            "not a git repository",
            "not a git repository (or any of the parent directories)",
            "is not a git repository",
        ],
    ) {
        GitErrorCode::NotRepo
    } else if contains_any(
        &combined,
        &[
            "unable to auto-detect email address",
            "please tell me who you are",
            "no identity available",
        ],
    ) {
        GitErrorCode::CommandFailed
    } else if contains_any(
        &combined,
        &[
            "cannot rebase: you have unstaged changes",
            "your local changes would be overwritten",
        ],
    ) {
        GitErrorCode::DirtyWorktree
    } else {
        GitErrorCode::CommandFailed
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_messages_redact_credentials_and_paths() {
        let message = public_git_message(
            "fatal: https://user:secret@example.com/repo.git\n/Users/test/projects/repo/private\n",
            "/Users/test/projects/repo",
            "/Users/test",
        );
        assert!(!message.contains("secret"));
        assert!(!message.contains("/Users/test"));
        assert!(message.contains("https://***@example.com/repo.git"));
        assert!(message.contains("the workspace"));
    }

    #[test]
    fn public_messages_redact_query_credentials() {
        let message = public_git_message(
            "error: URL https://host/x?token=abc123&ref=main&key=xyz",
            "/tmp/repo",
            "/home/user",
        );
        assert!(!message.contains("abc123"));
        assert!(!message.contains("xyz"));
        assert!(message.contains("token=***&ref=main&key=***"));
    }

    #[test]
    fn classifies_authentication_failures() {
        assert_eq!(
            classify_exit(
                "fatal: Authentication failed for 'https://github.com/'\n",
                ""
            ),
            GitErrorCode::AuthFailed
        );
        assert_eq!(
            classify_exit("remote: Invalid username or password.", ""),
            GitErrorCode::AuthFailed
        );
        assert_eq!(
            classify_exit("Permission denied (publickey).", ""),
            GitErrorCode::AuthFailed
        );
    }

    #[test]
    fn classifies_repository_and_identity_failures() {
        assert_eq!(
            classify_exit(
                "fatal: not a git repository (or any of the parent directories): .git",
                ""
            ),
            GitErrorCode::NotRepo
        );
        assert_eq!(
            classify_exit(
                "Author identity unknown\n*** Please tell me who you are.\nRun git config --global user.email",
                ""
            ),
            GitErrorCode::CommandFailed
        );
        assert_eq!(
            classify_exit("unrelated failure", ""),
            GitErrorCode::CommandFailed
        );
    }

    #[test]
    fn codes_match_ts_strings() {
        assert_eq!(GitErrorCode::StaleSnapshot.as_str(), "stale_snapshot");
        assert_eq!(GitErrorCode::DirtyWorktree.as_str(), "dirty_worktree");
        assert_eq!(GitErrorCode::Unborn.as_str(), "unborn");
        assert_eq!(GitErrorCode::NotRepo.as_str(), "not_repo");
        assert_eq!(GitErrorCode::AuthFailed.as_str(), "auth_failed");
    }
}
