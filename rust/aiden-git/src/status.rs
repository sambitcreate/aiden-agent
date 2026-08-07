//! Repository status (port of `parseGitStatus` + the `status()`/`info()`
//! methods of `main/services/git.ts`).
//!
//! `git status --porcelain=v2 --branch -z` records:
//! - `# branch.head <name>` / `# branch.oid <oid>` (oid `(initial)` → unborn)
//! - `# branch.upstream <name>`, `# branch.ab +N -M`
//! - `1 <XY> ...` (normal entry), `2 <XY> ...` (rename, next NUL record is the
//!   previous path), `u <XY> ...` (unmerged/conflicted), `? path` (untracked),
//!   `! path` (ignored)

use std::path::Path;

use crate::error::{GitError, GitErrorCode};
use crate::types::{GitInfo, ParsedStatus, RemoteRefs};
use crate::{AbortSignal, GitRepo, GitService, RunOptions};

/// Parse `git status --porcelain=v2 --branch -z` (git.ts `parseGitStatus`).
/// The TS counts one `uncommitted` per staged/unstaged/untracked record; this
/// port additionally reports granular staged/unstaged/untracked/conflicted
/// counts for the UI.
pub fn parse_git_status(raw: &str) -> ParsedStatus {
    let records = raw.split('\u{0000}');
    let mut status = ParsedStatus::default();
    let mut records = records.peekable();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(head) = record.strip_prefix("# branch.head ") {
            let detached = head == "(detached)";
            status.detached = detached;
            if !detached && head != "(unknown)" {
                status.branch = Some(head.to_string());
            }
            continue;
        }
        if let Some(oid) = record.strip_prefix("# branch.oid ") {
            if status.branch.is_none() {
                let unborn = oid == "(initial)";
                status.unborn = unborn;
                if !unborn {
                    status.branch = Some(oid.chars().take(8).collect());
                }
            }
            continue;
        }
        if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
            status.upstream = (!upstream.is_empty()).then(|| upstream.to_string());
            continue;
        }
        if let Some(ab) = record.strip_prefix("# branch.ab ") {
            if let Some(rest) = ab.strip_prefix('+') {
                if let Some((ahead, behind)) = rest.split_once(" -") {
                    status.ahead = ahead.parse().unwrap_or(0);
                    status.behind = behind.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if let Some(rest) = record.strip_prefix("1 ") {
            status.uncommitted += 1;
            let xy = rest.chars().take(2).collect::<String>();
            if let Some(x) = xy.chars().next() {
                if x != '.' {
                    status.staged += 1;
                }
            }
            if let Some(y) = xy.chars().nth(1) {
                if y != '.' {
                    status.unstaged += 1;
                }
            }
            continue;
        }
        if let Some(rest) = record.strip_prefix("2 ") {
            status.uncommitted += 1;
            let xy = rest.chars().take(2).collect::<String>();
            if xy.chars().next().is_some_and(|x| x != '.') {
                status.staged += 1;
            }
            if xy.chars().nth(1).is_some_and(|y| y != '.') {
                status.unstaged += 1;
            }
            // Rename/copy records carry their original path as the next NUL record.
            records.next();
            continue;
        }
        if let Some(rest) = record.strip_prefix("u ") {
            status.uncommitted += 1;
            status.conflicted += 1;
            let xy = rest.chars().take(2).collect::<String>();
            if xy.chars().next().is_some_and(|x| x != '.') {
                status.staged += 1;
            }
            if xy.chars().nth(1).is_some_and(|y| y != '.') {
                status.unstaged += 1;
            }
            continue;
        }
        if record.starts_with("? ") {
            status.uncommitted += 1;
            status.untracked += 1;
            continue;
        }
        if record.starts_with("! ") {
            status.ignored += 1;
            continue;
        }
    }
    status
}

/// Parse `git for-each-ref --format=%(refname)%00%(symref)%00 refs/remotes`
/// (git.ts `parseRemoteRefs`). `%(symref)` resolves the `refs/remotes/<r>/HEAD`
/// symbolic ref to its default branch. Empty fields are significant: ref/symref
/// pairs must stay aligned (`split('\0')` + `\n`-trim, no filtering).
pub fn parse_remote_refs(raw: &str) -> RemoteRefs {
    let fields: Vec<String> = raw
        .split('\u{0000}')
        .map(|value| value.trim_matches('\n').to_string())
        .collect();
    let mut branches: Vec<String> = Vec::new();
    let mut defaults: Vec<(String, String)> = Vec::new(); // (remote, branch)
    let mut index = 0;
    while index + 1 < fields.len() {
        let ref_name = &fields[index];
        let symbolic_target = &fields[index + 1];
        index += 2;
        if !ref_name.starts_with("refs/remotes/") {
            continue;
        }
        let short = ref_name["refs/remotes/".len()..].to_string();
        if symbolic_target.is_empty() {
            branches.push(short);
            continue;
        }
        if !ref_name.ends_with("/HEAD") {
            continue;
        }
        let prefix = &ref_name[..ref_name.len() - "/HEAD".len()];
        if !symbolic_target.starts_with(&format!("{prefix}/")) {
            continue;
        }
        defaults.push((
            prefix["refs/remotes/".len()..].to_string(),
            symbolic_target[prefix.len() + 1..].to_string(),
        ));
    }
    let preferred = defaults
        .iter()
        .find(|(remote, _)| remote == "origin")
        .or_else(|| defaults.iter().find(|(remote, _)| remote == "upstream"))
        .or_else(|| defaults.first());
    RemoteRefs {
        branches,
        default_branch: preferred.map(|(_, branch)| branch.clone()),
    }
}

/// Parse a `%(refname:short)%00` ref list (git.ts `parseRefList`).
pub fn parse_ref_list(raw: &str) -> Vec<String> {
    raw.split('\u{0000}')
        .map(|value| value.trim_matches('\n'))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

/// Read the remote refs (git.ts `readRemoteRefs`).
pub(crate) async fn read_remote_refs(
    service: &GitService,
    repo: &GitRepo,
    signal: Option<&AbortSignal>,
) -> Result<RemoteRefs, GitError> {
    let result = service
        .run(
            &repo.cwd,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname)%00%(symref)%00",
                "refs/remotes",
            ],
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    Ok(parse_remote_refs(&result.stdout))
}

/// The full status of a repository (git.ts `status()`): porcelain status +
/// remote list + remote refs for the default branch.
pub(crate) async fn status(
    service: &GitService,
    repo: &GitRepo,
    signal: Option<&AbortSignal>,
) -> Result<GitInfo, GitError> {
    let raw = service
        .run(
            &repo.cwd,
            &status_args(),
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let remotes_result = service
        .run(
            &repo.cwd,
            &["remote"],
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let remote_refs = read_remote_refs(service, repo, signal).await?;
    let parsed = parse_git_status(&raw.stdout);
    let has_remote = !remotes_result.stdout.trim().is_empty();
    let upstream = parsed.upstream;
    Ok(GitInfo {
        is_repo: true,
        branch: parsed.branch,
        detached: Some(parsed.detached),
        unborn: Some(parsed.unborn),
        uncommitted: Some(parsed.uncommitted),
        upstream: upstream.clone(),
        ahead: Some(parsed.ahead),
        behind: Some(parsed.behind),
        default_branch: remote_refs.default_branch,
        has_remote: Some(has_remote),
        remote_state: upstream.map(|_| "local-ref".to_string()),
    })
}

const fn status_args() -> [&'static str; 5] {
    [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=normal",
    ]
}

/// `gitService.info(cwd)`: repository status with caching and mutation fencing.
pub async fn info(
    service: &GitService,
    cwd: &Path,
    signal: Option<&AbortSignal>,
) -> Result<GitInfo, GitError> {
    let Some(repo) = GitRepo::resolve(service, cwd, signal).await? else {
        return Ok(GitInfo::not_repo());
    };
    service
        .stable_read(&repo, {
            let repo = repo.clone();
            let service = service.clone();
            async move {
                if let Some(cached) = service.get_cached_info(&repo.cwd) {
                    return Ok(cached);
                }
                let value = status(&service, &repo, signal).await?;
                service.set_cached_info(&repo.cwd, value.clone());
                Ok(value)
            }
        })
        .await
}

/// `gitService.branches(cwd)`: the branch picker data.
pub async fn branches(
    service: &GitService,
    cwd: &Path,
    signal: Option<&AbortSignal>,
) -> Result<crate::types::GitBranches, GitError> {
    let Some(repo) = GitRepo::resolve(service, cwd, signal).await? else {
        return Ok(crate::types::GitBranches {
            is_repo: false,
            current: None,
            branches: Vec::new(),
            remote_branches: Vec::new(),
            uncommitted: 0,
            detached: None,
            unborn: None,
            upstream: None,
            ahead: None,
            behind: None,
            default_branch: None,
            has_remote: None,
            remote_state: None,
        });
    };
    service
        .stable_read(&repo, {
            let repo = repo.clone();
            let service = service.clone();
            async move {
                if let Some(cached) = service.get_cached_branches(&repo.cwd) {
                    return Ok(cached);
                }
                let info = status(&service, &repo, signal).await?;
                let local_result = service
                    .run(
                        &repo.cwd,
                        &local_refs_args(),
                        RunOptions {
                            signal,
                            ..RunOptions::default()
                        },
                    )
                    .await?;
                let remote_refs = read_remote_refs(&service, &repo, signal).await?;
                let mut local = parse_ref_list(&local_result.stdout);
                if info.unborn == Some(true) {
                    if let Some(branch) = &info.branch {
                        if !local.contains(branch) {
                            local.insert(0, branch.clone());
                        }
                    }
                }
                let value = info.into_branches(local, remote_refs.branches);
                service.set_cached_branches(&repo.cwd, value.clone());
                Ok(value)
            }
        })
        .await
}

const fn local_refs_args() -> [&'static str; 4] {
    [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)%00",
        "refs/heads",
    ]
}

/// Validate a branch name via `git check-ref-format --branch` (git.ts
/// `validateBranchName`).
pub(crate) async fn validate_branch_name(
    service: &GitService,
    repo: &GitRepo,
    name: &str,
) -> Result<(), GitError> {
    let result = service
        .run(
            repo.cwd.as_path(),
            &["check-ref-format", "--branch", name],
            RunOptions {
                allow_exit_codes: &[1, 128],
                ..RunOptions::default()
            },
        )
        .await?;
    if result.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Enter a valid Git branch name.",
        ));
    }
    Ok(())
}

/// `requireHead` in git.ts: the current HEAD oid or an `unborn` error.
pub(crate) async fn require_head(service: &GitService, repo: &GitRepo) -> Result<String, GitError> {
    let head = service
        .run(
            repo.cwd.as_path(),
            &["rev-parse", "--verify", "HEAD"],
            RunOptions {
                allow_exit_codes: &[128],
                ..RunOptions::default()
            },
        )
        .await?;
    if head.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::Unborn,
            "Create the repository's first commit before creating another branch or worktree.",
        ));
    }
    Ok(head.stdout.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_handles_nul_delimited_paths_and_rename_pairs() {
        // Mirrors the TS parseGitStatus test exactly.
        let raw = [
            "# branch.oid 1234567890abcdef",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -3",
            "1 .M N... 100644 100644 100644 a a tab\tname.txt",
            "2 R. N... 100644 100644 100644 a b R100 new\nname.txt",
            "old\nname.txt",
            "? untracked\nfile.txt",
            "! ignored\nfile.txt",
            "",
        ]
        .join("\u{0000}");
        let parsed = parse_git_status(&raw);
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert!(!parsed.detached);
        assert!(!parsed.unborn);
        assert_eq!(parsed.uncommitted, 3);
        assert_eq!(parsed.ignored, 1);
        assert_eq!(parsed.upstream.as_deref(), Some("origin/main"));
        assert_eq!(parsed.ahead, 2);
        assert_eq!(parsed.behind, 3);
        // Granular counts: 1 rename staged (R.), 1 unstaged (.M), 1 untracked.
        assert_eq!(parsed.staged, 1);
        assert_eq!(parsed.unstaged, 1);
        assert_eq!(parsed.untracked, 1);
        assert_eq!(parsed.conflicted, 0);
    }

    #[test]
    fn parse_status_detects_unborn_and_detached_heads() {
        let raw = ["# branch.oid (initial)", "# branch.head main", ""].join("\u{0000}");
        let parsed = parse_git_status(&raw);
        assert!(parsed.unborn);
        assert_eq!(parsed.branch.as_deref(), Some("main"));

        let raw = [
            "# branch.oid 1234567890abcdef",
            "# branch.head (detached)",
            "",
        ]
        .join("\u{0000}");
        let parsed = parse_git_status(&raw);
        assert!(parsed.detached);
        // Matches the TS parser: `branch.oid` arrives before `branch.head`, so
        // the detached head still carries the oid prefix as `branch`.
        assert_eq!(parsed.branch.as_deref(), Some("12345678"));
        assert!(!parsed.unborn);
    }

    #[test]
    fn parse_status_counts_conflicted_records() {
        let raw = [
            "# branch.head main",
            "u UU N... 100644 100644 100644 a a conflict.txt",
            "",
        ]
        .join("\u{0000}");
        let parsed = parse_git_status(&raw);
        assert_eq!(parsed.conflicted, 1);
        assert_eq!(parsed.uncommitted, 1);
        assert_eq!(parsed.staged, 1);
        assert_eq!(parsed.unstaged, 1);
    }

    #[test]
    fn parse_remote_refs_resolves_a_non_origin_default_and_omits_symbolic_heads() {
        // Mirrors the TS parseRemoteRefs test exactly.
        let raw = [
            "refs/remotes/upstream/HEAD",
            "refs/remotes/upstream/main",
            "\nrefs/remotes/upstream/main",
            "",
            "\nrefs/remotes/upstream/topic",
            "",
            "\n",
        ]
        .join("\u{0000}");
        let parsed = parse_remote_refs(&raw);
        assert_eq!(parsed.branches, vec!["upstream/main", "upstream/topic"]);
        assert_eq!(parsed.default_branch.as_deref(), Some("main"));
    }

    #[test]
    fn parse_remote_refs_prefers_origin() {
        let raw = [
            "refs/remotes/upstream/HEAD",
            "refs/remotes/upstream/main",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/master",
            "",
        ]
        .join("\u{0000}");
        let parsed = parse_remote_refs(&raw);
        assert_eq!(parsed.default_branch.as_deref(), Some("master"));
    }
}
