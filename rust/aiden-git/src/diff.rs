//! Review / diff / compare (port of the review + diff + compare machinery in
//! `main/services/git.ts`). This is what the commit dialog renders: the
//! working-tree review, per-file diffs, and branch comparisons.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{GitError, GitErrorCode};
use crate::status::parse_git_status;
use crate::types::{
    GitCommitCapability, GitComparison, GitComparisonDiffInput, GitDiffInput, GitFileDiff,
    GitReview, GitReviewFile, GitReviewFileStatus, GitReviewSummary,
};
use crate::{
    compare_paths_numeric, count_text_lines, lexical_workspace_path, AbortSignal, GitRepo,
    GitService, RunOptions,
};

const SNAPSHOT_MAX_BYTES: u64 = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Parsers (git.ts parseGitReviewStatus / parseGitNumstat / parseGitNameStatus)
// ---------------------------------------------------------------------------

/// `valueAfterFields`: skip `fieldCount` space-separated fields, return the rest.
fn value_after_fields(record: &str, field_count: usize) -> &str {
    let mut cursor = 0;
    for _ in 0..field_count {
        cursor = record[cursor..]
            .find(' ')
            .map(|at| cursor + at + 1)
            .unwrap_or(record.len());
        if cursor >= record.len() {
            return "";
        }
    }
    &record[cursor..]
}

/// `reviewStatus` in git.ts.
fn review_status(xy: &str, record_type: char) -> GitReviewFileStatus {
    if record_type == 'u' || xy.contains('U') {
        GitReviewFileStatus::Conflicted
    } else if xy.contains('R') {
        GitReviewFileStatus::Renamed
    } else if xy.contains('C') {
        GitReviewFileStatus::Copied
    } else if xy.contains('A') {
        GitReviewFileStatus::Added
    } else if xy.contains('D') {
        GitReviewFileStatus::Deleted
    } else {
        GitReviewFileStatus::Modified
    }
}

/// Parse workspace-relative `git status --porcelain=v2 -z` entries for Review
/// (git.ts `parseGitReviewStatus`).
pub fn parse_git_review_status(raw: &str) -> Vec<GitReviewFile> {
    let records: Vec<&str> = raw.split('\u{0000}').collect();
    let mut files: Vec<GitReviewFile> = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.is_empty() || record.starts_with("# ") || record.starts_with("! ") {
            index += 1;
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            files.push(GitReviewFile {
                path: path.to_string(),
                previous_path: None,
                status: GitReviewFileStatus::Untracked,
                staged: false,
                unstaged: true,
                additions: None,
                deletions: None,
                binary: None,
            });
            index += 1;
            continue;
        }
        let record_type = record.chars().next();
        let Some(record_type) = record_type else {
            index += 1;
            continue;
        };
        if record_type != '1' && record_type != '2' && record_type != 'u' {
            index += 1;
            continue;
        }
        let xy = &record[2..4];
        let path_field_count = match record_type {
            '1' => 8,
            '2' => 9,
            _ => 10,
        };
        let file_path = value_after_fields(record, path_field_count);
        if file_path.is_empty() {
            index += 1;
            continue;
        }
        let previous_path = if record_type == '2' {
            records.get(index + 1).copied().map(str::to_string)
        } else {
            None
        };
        if record_type == '2' {
            index += 1;
        }
        files.push(GitReviewFile {
            path: file_path.to_string(),
            previous_path,
            status: review_status(xy, record_type),
            staged: !xy.starts_with('.'),
            unstaged: !xy.ends_with('.'),
            additions: None,
            deletions: None,
            binary: None,
        });
        index += 1;
    }
    files.sort_by(|left, right| compare_paths_numeric(&left.path, &right.path));
    files
}

/// One `git diff --numstat -z` entry (git.ts `GitNumstat`).
pub struct GitNumstat {
    pub path: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
}

/// Parse `git diff --numstat -z`, including its three-record rename form
/// (git.ts `parseGitNumstat`).
pub fn parse_git_numstat(raw: &str) -> Vec<GitNumstat> {
    let records: Vec<&str> = raw.split('\u{0000}').collect();
    let mut stats: Vec<GitNumstat> = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.is_empty() {
            index += 1;
            continue;
        }
        let Some((first, rest)) = record.split_once('\t') else {
            index += 1;
            continue;
        };
        let Some((second, mut file_path)) = rest.split_once('\t') else {
            index += 1;
            continue;
        };
        if file_path.is_empty() {
            index += 1;
            let previous_path = records.get(index).copied().unwrap_or("");
            index += 1;
            file_path = records.get(index).copied().unwrap_or(previous_path);
        }
        if file_path.is_empty() {
            index += 1;
            continue;
        }
        let binary = first == "-" || second == "-";
        stats.push(GitNumstat {
            path: file_path.to_string(),
            additions: if binary { None } else { first.parse().ok() },
            deletions: if binary { None } else { second.parse().ok() },
            binary,
        });
        index += 1;
    }
    stats
}

/// Parse NUL-delimited `git diff --name-status -z --find-renames` (git.ts
/// `parseGitNameStatus`).
pub fn parse_git_name_status(raw: &str) -> Vec<GitReviewFile> {
    let records: Vec<&str> = raw.split('\u{0000}').collect();
    let mut files: Vec<GitReviewFile> = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let status_code = records[index];
        if status_code.is_empty() {
            index += 1;
            continue;
        }
        let kind = status_code.chars().next().unwrap_or('M');
        let Some(first_path) = records.get(index + 1).copied() else {
            break;
        };
        if first_path.is_empty() {
            break;
        }
        index += 1;
        let mut file_path = first_path;
        let mut previous_path: Option<String> = None;
        if kind == 'R' || kind == 'C' {
            previous_path = Some(first_path.to_string());
            file_path = records.get(index + 1).copied().unwrap_or(first_path);
            index += 1;
        }
        let status = match kind {
            'A' => GitReviewFileStatus::Added,
            'D' => GitReviewFileStatus::Deleted,
            'R' => GitReviewFileStatus::Renamed,
            'C' => GitReviewFileStatus::Copied,
            'U' => GitReviewFileStatus::Conflicted,
            _ => GitReviewFileStatus::Modified,
        };
        files.push(GitReviewFile {
            path: file_path.to_string(),
            previous_path,
            status,
            staged: false,
            unstaged: false,
            additions: None,
            deletions: None,
            binary: None,
        });
        index += 1;
    }
    files.sort_by(|left, right| compare_paths_numeric(&left.path, &right.path));
    files
}

/// `workspaceRelativeStatusPath` in git.ts: strip the nested-subfolder prefix
/// so paths in a subfolder workspace are reported relative to the workspace.
fn workspace_relative_status_path(repo: &GitRepo, git_path: &str) -> String {
    let prefix = repo
        .cwd
        .strip_prefix(&repo.top_level)
        .unwrap_or(&repo.cwd)
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if prefix.is_empty() {
        return git_path.to_string();
    }
    if let Some(rest) = git_path.strip_prefix(&format!("{prefix}/")) {
        rest.to_string()
    } else {
        git_path.to_string()
    }
}

/// `gitDiffHeaderPath` in git.ts: C-style quoting for diff headers.
pub(crate) fn git_diff_header_path(prefix: char, value: &str) -> String {
    let full_path = format!("{prefix}/{value}");
    let needs_quotes = full_path.chars().any(|character| {
        character.is_whitespace()
            || character == '"'
            || character == '\\'
            || (character as u32) < 32
    });
    if !needs_quotes {
        return full_path;
    }
    let mut escaped = String::from("\"");
    for character in full_path.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if (character as u32) < 32 => {
                escaped.push_str(&format!("\\{:03o}", character as u32));
            }
            character => escaped.push(character),
        }
    }
    escaped.push('"');
    escaped
}

// ---------------------------------------------------------------------------
// Snapshot & capability helpers
// ---------------------------------------------------------------------------

/// `coreFileMode` in git.ts: whether file-mode changes are tracked.
async fn core_file_mode(
    service: &GitService,
    repo: &GitRepo,
    signal: Option<&AbortSignal>,
) -> Result<bool, GitError> {
    let result = service
        .run(
            &repo.cwd,
            &["config", "--bool", "--get", "core.fileMode"],
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    Ok(result.exit_code != 0 || result.stdout.trim() != "false")
}

/// `reviewSnapshot` in git.ts: a sha256 digest over the raw status + the
/// content of every changed file, so a later commit/diff can detect that the
/// working tree moved on. Returns `Ok(None)` when the tree is too large or
/// contains an unsupported path (snapshot incomplete).
async fn review_snapshot(
    repo: &GitRepo,
    raw_status: &str,
    files: &[GitReviewFile],
    file_mode: bool,
    signal: Option<&AbortSignal>,
) -> Result<Option<String>, GitError> {
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-git-review-v1\0");
    hasher.update(raw_status.as_bytes());
    hasher.update(format!("\0core.fileMode:{file_mode}\0").as_bytes());
    let mut total_bytes = raw_status.len() as u64;
    for file in files {
        if signal.is_some_and(AbortSignal::is_aborted) {
            return Err(GitError::aborted());
        }
        hasher.update(b"\0path\0");
        hasher.update(file.path.as_bytes());
        let lexical_path = lexical_workspace_path(&repo.cwd, &file.path)?;
        let metadata = match std::fs::symlink_metadata(&lexical_path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                hasher.update(b"missing\0");
                continue;
            }
            Err(err) => return Err(err.into()),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            hasher.update(format!("\0mode:{:o}\0", metadata.mode()).as_bytes());
        }
        if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(&lexical_path)?;
            let target = target.to_string_lossy();
            total_bytes += target.len() as u64;
            if total_bytes > SNAPSHOT_MAX_BYTES {
                return Ok(None);
            }
            hasher.update(b"symlink\0");
            hasher.update(target.as_bytes());
            continue;
        }
        if !metadata.is_file() {
            return Ok(None);
        }
        if total_bytes + metadata.len() > SNAPSHOT_MAX_BYTES {
            return Ok(None);
        }
        total_bytes += metadata.len();
        let contents = std::fs::read(&lexical_path)?;
        if contents.len() as u64 != metadata.len()
            || total_bytes - metadata.len() + contents.len() as u64 > SNAPSHOT_MAX_BYTES
        {
            return Ok(None);
        }
        hasher.update(b"file\0");
        hasher.update(Sha256::digest(&contents));
    }
    Ok(Some(hex(&hasher.finalize())))
}

const fn review_status_args() -> [&'static str; 9] {
    [
        "-c",
        "status.relativePaths=true",
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--",
        ".",
    ]
}

/// `commitStateBlocker` in git.ts: refuse commits while a merge, cherry-pick,
/// revert, or rebase is in progress.
pub(crate) async fn commit_state_blocker(
    service: &GitService,
    repo: &GitRepo,
    signal: Option<&AbortSignal>,
) -> Result<Option<String>, GitError> {
    let in_progress: &[(&str, &str)] = &[
        (
            "MERGE_HEAD",
            "Finish or abort the merge before committing from Aiden.",
        ),
        (
            "CHERRY_PICK_HEAD",
            "Finish or abort the cherry-pick before committing from Aiden.",
        ),
        (
            "REVERT_HEAD",
            "Finish or abort the revert before committing from Aiden.",
        ),
        (
            "rebase-merge",
            "Finish or abort the rebase before committing from Aiden.",
        ),
        (
            "rebase-apply",
            "Finish or abort the rebase before committing from Aiden.",
        ),
    ];
    for (git_path, reason) in in_progress {
        let result = service
            .run(
                &repo.cwd,
                &["rev-parse", "--git-path", git_path],
                RunOptions {
                    signal,
                    ..RunOptions::default()
                },
            )
            .await?;
        let value = result.stdout.trim_end();
        let resolved = if Path::new(value).is_absolute() {
            PathBuf::from(value)
        } else {
            repo.cwd.join(value)
        };
        match std::fs::metadata(&resolved) {
            Ok(_) => return Ok(Some((*reason).to_string())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Ok(Some(
                    "Aiden could not verify whether another Git operation is in progress."
                        .to_string(),
                ));
            }
        }
    }
    Ok(None)
}

/// `repositoryGitPath` in git.ts.
pub(crate) async fn repository_git_path(
    service: &GitService,
    repo: &GitRepo,
    name: &str,
    signal: Option<&AbortSignal>,
) -> Result<PathBuf, GitError> {
    let result = service
        .run(
            &repo.cwd,
            &["rev-parse", "--git-path", name],
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let value = result.stdout.trim_end();
    if value.is_empty() {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            format!("Git did not return its {name} path."),
        ));
    }
    Ok(if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        repo.cwd.join(value)
    })
}

/// `inspectReview` in git.ts.
pub(crate) async fn inspect_review(
    service: &GitService,
    repo: &GitRepo,
    signal: Option<&AbortSignal>,
) -> Result<GitReview, GitError> {
    let status_result = service
        .run(
            &repo.cwd,
            &review_status_args(),
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let file_mode = core_file_mode(service, repo, signal).await?;
    let parsed_status = parse_git_status(&status_result.stdout);
    let mut files: Vec<GitReviewFile> = parse_git_review_status(&status_result.stdout)
        .into_iter()
        .map(|mut file| {
            file.path = workspace_relative_status_path(repo, &file.path);
            if let Some(previous) = &file.previous_path {
                file.previous_path = Some(workspace_relative_status_path(repo, previous));
            }
            file
        })
        .collect();

    let head_args = ["rev-parse", "--verify", "HEAD"];
    let head = service
        .run(
            &repo.cwd,
            &head_args,
            RunOptions {
                allow_exit_codes: &[128],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let snapshot = review_snapshot(repo, &status_result.stdout, &files, file_mode, signal).await?;
    let has_head = head.exit_code == 0;
    let numstat = if has_head {
        Some(
            service
                .run(
                    &repo.cwd,
                    &[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--numstat",
                        "-z",
                        "--relative",
                        "HEAD",
                        "--",
                        ".",
                    ],
                    RunOptions {
                        signal,
                        ..RunOptions::default()
                    },
                )
                .await?,
        )
    } else {
        None
    };
    let stats: std::collections::HashMap<String, GitNumstat> = parse_git_numstat(
        numstat
            .as_ref()
            .map(|result| result.stdout.as_str())
            .unwrap_or(""),
    )
    .into_iter()
    .map(|entry| (entry.path.clone(), entry))
    .collect();

    for file in files.iter_mut() {
        if let Some(stat) = stats.get(&file.path) {
            file.additions = stat.additions;
            file.deletions = stat.deletions;
            file.binary = Some(stat.binary);
            continue;
        }
        if has_head && file.status != GitReviewFileStatus::Untracked {
            continue;
        }
        // No HEAD, or an untracked file: count lines of the working copy.
        if let Ok(lexical_path) = lexical_workspace_path(&repo.cwd, &file.path) {
            if let Ok(metadata) = std::fs::symlink_metadata(&lexical_path) {
                if metadata.file_type().is_symlink() {
                    if let Ok(target) = std::fs::read_link(&lexical_path) {
                        file.additions = Some(count_text_lines(&target.to_string_lossy()));
                        file.deletions = Some(0);
                        file.binary = Some(false);
                    }
                    continue;
                }
                if let Ok(canonical) = std::fs::canonicalize(&lexical_path) {
                    let confined = canonical.starts_with(&repo.cwd)
                        && repo.cwd.components().count() <= canonical.components().count();
                    if !confined {
                        continue;
                    }
                    if let Ok(file_stats) = std::fs::metadata(&canonical) {
                        if file_stats.is_file() && file_stats.len() <= 1024 * 1024 {
                            if let Ok(contents) = std::fs::read(&canonical) {
                                if contents.get(..8192).is_some_and(|head| head.contains(&0)) {
                                    file.binary = Some(true);
                                    continue;
                                }
                                file.additions =
                                    Some(count_text_lines(&String::from_utf8_lossy(&contents)));
                                file.deletions = Some(0);
                            }
                        }
                    }
                }
            }
        }
    }

    let summary = summarize(&files);
    let repository_root = repo.is_root();
    let reason: Option<String> = if !repository_root {
        Some(
            "Commit from Aiden is available only when the workspace is the repository root."
                .to_string(),
        )
    } else if parsed_status.detached {
        Some("Switch to a local branch before committing from Aiden.".to_string())
    } else if summary.conflicted_files > 0 {
        Some("Resolve conflicted files before committing.".to_string())
    } else if summary.file_count == 0 {
        Some("The working tree is clean.".to_string())
    } else if snapshot.is_none() {
        Some(
            "These changes are too large or contain an unsupported path for a safe Aiden commit."
                .to_string(),
        )
    } else if parsed_status.branch.is_none() {
        Some("Aiden could not determine the current branch.".to_string())
    } else {
        match commit_state_blocker(service, repo, signal).await? {
            Some(reason) => Some(reason),
            None => {
                let identity = service
                    .run(
                        &repo.cwd,
                        &["var", "GIT_AUTHOR_IDENT"],
                        RunOptions {
                            allow_exit_codes: &[1, 128],
                            signal,
                            ..RunOptions::default()
                        },
                    )
                    .await?;
                if identity.exit_code != 0 {
                    Some("Configure Git user.name and user.email before committing.".to_string())
                } else {
                    None
                }
            }
        }
    };

    Ok(GitReview {
        is_repo: true,
        branch: parsed_status.branch,
        files,
        summary,
        commit: GitCommitCapability {
            allowed: reason.is_none(),
            reason,
            snapshot,
            snapshot_complete: true,
            repository_root,
        },
    })
}

fn summarize(files: &[GitReviewFile]) -> GitReviewSummary {
    let mut summary = GitReviewSummary {
        file_count: files.len() as u64,
        ..GitReviewSummary::default()
    };
    for file in files {
        summary.additions += file.additions.unwrap_or(0);
        summary.deletions += file.deletions.unwrap_or(0);
        if file.additions.is_none() || file.deletions.is_none() {
            summary.unavailable_stats += 1;
        }
        if file.staged {
            summary.staged_files += 1;
        }
        if file.unstaged {
            summary.unstaged_files += 1;
        }
        if file.status == GitReviewFileStatus::Conflicted {
            summary.conflicted_files += 1;
        }
    }
    summary
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// `gitService.review(cwd)`.
pub async fn review(
    service: &GitService,
    cwd: &Path,
    signal: Option<&AbortSignal>,
) -> Result<GitReview, GitError> {
    let Some(repo) = GitRepo::resolve(service, cwd, signal).await? else {
        return Ok(GitReview::not_repo());
    };
    service
        .stable_read(&repo, {
            let repo = repo.clone();
            let service = service.clone();
            async move { inspect_review(&service, &repo, signal).await }
        })
        .await
}

/// `currentFilePatch` in git.ts: synthesize an untracked/new-file diff patch.
async fn current_file_patch(
    service: &GitService,
    repo: &GitRepo,
    relative_path: &str,
    signal: Option<&AbortSignal>,
) -> Result<GitFileDiff, GitError> {
    let lexical_path = lexical_workspace_path(&repo.cwd, relative_path)?;
    let lexical_stats = std::fs::symlink_metadata(&lexical_path)?;
    let symbolic = lexical_stats.file_type().is_symlink();
    #[cfg(unix)]
    let executable = !symbolic && {
        use std::os::unix::fs::MetadataExt;
        (lexical_stats.mode() & 0o111) != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    let file_mode = core_file_mode(service, repo, signal).await?;
    let git_mode = if symbolic {
        "120000"
    } else if executable && file_mode {
        "100755"
    } else {
        "100644"
    };
    let buffer: Vec<u8> = if symbolic {
        std::fs::read_link(&lexical_path)?
            .to_string_lossy()
            .into_owned()
            .into_bytes()
    } else {
        let canonical = std::fs::canonicalize(&lexical_path)?;
        if !canonical.starts_with(&repo.cwd) {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                "The changed file resolves outside the workspace.",
            ));
        }
        let stats = std::fs::metadata(&canonical)?;
        if !stats.is_file() {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                "The changed path is not a file.",
            ));
        }
        std::fs::read(&canonical)?
    };
    if signal.is_some_and(AbortSignal::is_aborted) {
        return Err(GitError::aborted());
    }
    let max_buffer = service.max_buffer_bytes();
    let limited = &buffer[..buffer.len().min(max_buffer)];
    let from_path = git_diff_header_path('a', relative_path);
    let to_path = git_diff_header_path('b', relative_path);
    let binary = !symbolic && limited.get(..8192).is_some_and(|head| head.contains(&0));
    if binary {
        return Ok(GitFileDiff {
            path: relative_path.to_string(),
            patch: format!(
                "diff --git {from_path} {to_path}\nnew file mode {git_mode}\nBinary file {to_path} is not shown.\n"
            ),
            binary: true,
            truncated: buffer.len() > limited.len(),
        });
    }
    let text = String::from_utf8_lossy(limited).into_owned();
    let lines: Vec<&str> = text.split('\n').collect();
    let line_count = if lines.last() == Some(&"") {
        lines.len().saturating_sub(1)
    } else {
        lines.len()
    };
    let mut patch = String::new();
    patch.push_str(&format!("diff --git {from_path} {to_path}\n"));
    patch.push_str(&format!("new file mode {git_mode}\n"));
    patch.push_str("--- /dev/null\n");
    patch.push_str(&format!("+++ {to_path}\n"));
    patch.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
    for line in lines.iter().take(line_count) {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if buffer.len() == limited.len() && !text.is_empty() && !text.ends_with('\n') {
        patch.push_str("\\ No newline at end of file\n");
    }
    if buffer.len() > limited.len() {
        patch.push_str("+… [diff truncated by Aiden]\n");
    }
    Ok(GitFileDiff {
        path: relative_path.to_string(),
        patch,
        binary: false,
        truncated: buffer.len() > limited.len(),
    })
}

/// `gitService.diff(cwd, input)`: the per-file diff behind the commit dialog,
/// fenced against the review snapshot.
pub async fn diff(
    service: &GitService,
    cwd: &Path,
    input: GitDiffInput,
    signal: Option<&AbortSignal>,
) -> Result<GitFileDiff, GitError> {
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let relative_path = input.path.clone();
    lexical_workspace_path(&repo.cwd, &relative_path)?;
    let review = inspect_review(service, &repo, signal).await?;
    if review.commit.snapshot.as_deref() != Some(input.expected_snapshot.as_str()) {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            "The working tree changed after this review. Refresh changes before opening the diff.",
        ));
    }
    let Some(file) = review
        .files
        .iter()
        .find(|candidate| candidate.path == relative_path)
    else {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            "That file is no longer part of this review.",
        ));
    };
    let head = service
        .run(
            &repo.cwd,
            &["rev-parse", "--verify", "HEAD"],
            RunOptions {
                allow_exit_codes: &[128],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let result: GitFileDiff =
        if file.status == GitReviewFileStatus::Untracked || head.exit_code != 0 {
            current_file_patch(service, &repo, &relative_path, signal).await?
        } else {
            let mut pathspecs: Vec<String> = Vec::new();
            if let Some(previous) = &file.previous_path {
                lexical_workspace_path(&repo.cwd, previous)?;
                pathspecs.push(previous.clone());
            }
            lexical_workspace_path(&repo.cwd, &relative_path)?;
            pathspecs.push(relative_path.clone());
            let args: Vec<&str> = [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--find-renames",
                "--unified=3",
                "--relative",
                "HEAD",
                "--",
            ]
            .into_iter()
            .chain(pathspecs.iter().map(|path| path.as_str()))
            .collect();
            let result = service
                .run(
                    &repo.cwd,
                    &args,
                    RunOptions {
                        allow_truncated_output: true,
                        signal,
                        ..RunOptions::default()
                    },
                )
                .await?;
            let binary = result
                .stdout
                .lines()
                .any(|line| line.starts_with("Binary files ") || line == "GIT binary patch");
            GitFileDiff {
                path: relative_path.clone(),
                patch: result.stdout.clone(),
                binary,
                truncated: result.truncated,
            }
        };
    // Verify the tree did not move while preparing the diff.
    let verified = inspect_review(service, &repo, signal).await?;
    if verified.commit.snapshot.as_deref() != Some(input.expected_snapshot.as_str()) {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            "The working tree changed while Aiden prepared this diff. Refresh changes and try again.",
        ));
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Comparison (git.ts compare / comparisonDiff)
// ---------------------------------------------------------------------------

fn validate_comparison_target(target_ref: &str) -> Result<(), GitError> {
    if target_ref.contains('\u{0000}')
        || (!target_ref.starts_with("refs/heads/") && !target_ref.starts_with("refs/remotes/"))
    {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Choose a local or last-fetched branch to compare.",
        ));
    }
    Ok(())
}

async fn comparison_refs(
    service: &GitService,
    repo: &GitRepo,
    target_ref: &str,
    signal: Option<&AbortSignal>,
) -> Result<(String, String, Option<String>), GitError> {
    let head_args = ["rev-parse", "--verify", "HEAD"];
    let show_args = ["show-ref", "--verify", "--hash", target_ref];
    let sym_args = ["symbolic-ref", "--quiet", "--short", "HEAD"];
    let head = service
        .run(
            &repo.cwd,
            &head_args,
            RunOptions {
                allow_exit_codes: &[128],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let target = service
        .run(
            &repo.cwd,
            &show_args,
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let symbolic_head = service
        .run(
            &repo.cwd,
            &sym_args,
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    if head.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::Unborn,
            "Create the first commit before comparing branches.",
        ));
    }
    if target.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "That comparison branch no longer exists locally.",
        ));
    }
    Ok((
        head.stdout.trim().to_string(),
        target.stdout.trim().to_string(),
        (symbolic_head.exit_code == 0).then(|| symbolic_head.stdout.trim().to_string()),
    ))
}

async fn inspect_comparison(
    service: &GitService,
    repo: &GitRepo,
    target_ref: &str,
    signal: Option<&AbortSignal>,
) -> Result<GitComparison, GitError> {
    validate_comparison_target(target_ref)?;
    let (before_head, before_target, branch) =
        comparison_refs(service, repo, target_ref, signal).await?;
    let merge_base_result = service
        .run(
            &repo.cwd,
            &["merge-base", &before_target, &before_head],
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    if merge_base_result.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "These branches do not share a common commit.",
        ));
    }
    let merge_base = merge_base_result.stdout.trim().to_string();
    let range_count = format!("{before_target}...{before_head}");
    let range_diff = format!("{merge_base}..{before_head}");
    let counts_args = ["rev-list", "--left-right", "--count", &range_count];
    let names_args = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "-z",
        "--find-renames",
        "--relative",
        &range_diff,
        "--",
        ".",
    ];
    let numstat_args = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        "--find-renames",
        "--relative",
        &range_diff,
        "--",
        ".",
    ];
    let counts = service
        .run(
            &repo.cwd,
            &counts_args,
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let names = service
        .run(
            &repo.cwd,
            &names_args,
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let numstat = service
        .run(
            &repo.cwd,
            &numstat_args,
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    // Re-read refs; if they moved, the caller retries (git.ts loops twice).
    let (after_head, after_target, _) = comparison_refs(service, repo, target_ref, signal).await?;
    if before_head != after_head || before_target != after_target {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            "The branch moved while Aiden prepared this comparison. Refresh and try again.",
        ));
    }

    let mut files = parse_git_name_status(&names.stdout);
    let stats: std::collections::HashMap<String, GitNumstat> = parse_git_numstat(&numstat.stdout)
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();
    for file in files.iter_mut() {
        if let Some(stat) = stats.get(&file.path) {
            file.additions = stat.additions;
            file.deletions = stat.deletions;
            file.binary = Some(stat.binary);
        }
    }
    let counts_parts: Vec<&str> = counts.stdout.split_whitespace().collect();
    let behind = counts_parts.first().unwrap_or(&"0").parse().unwrap_or(0);
    let ahead = counts_parts.get(1).unwrap_or(&"0").parse().unwrap_or(0);
    let mut summary = summarize(&files);
    summary.staged_files = 0;
    summary.unstaged_files = 0;
    summary.conflicted_files = 0;

    let target_label = target_ref
        .strip_prefix("refs/heads/")
        .or_else(|| target_ref.strip_prefix("refs/remotes/"))
        .unwrap_or(target_ref)
        .to_string();
    let mut hasher = Sha256::new();
    hasher.update(
        format!(
            "{before_head}\u{0000}{before_target}\u{0000}{target_ref}\u{0000}{merge_base}\u{0000}{}",
            serde_json::to_string(&files).unwrap_or_default()
        )
        .as_bytes(),
    );
    Ok(GitComparison {
        current_branch: branch,
        expected_head: before_head,
        expected_target: before_target,
        target_ref: target_ref.to_string(),
        target_label,
        merge_base,
        ahead,
        behind,
        files,
        summary,
        snapshot: hex(&hasher.finalize()),
        remote_state: "local-ref".to_string(),
    })
}

/// `gitService.compare(cwd, targetRef)`.
pub async fn compare(
    service: &GitService,
    cwd: &Path,
    target_ref: &str,
    signal: Option<&AbortSignal>,
) -> Result<GitComparison, GitError> {
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    service
        .stable_read(&repo, {
            let repo = repo.clone();
            let service = service.clone();
            let target_ref = target_ref.to_string();
            async move { inspect_comparison(&service, &repo, &target_ref, signal).await }
        })
        .await
}

/// `gitService.comparisonDiff(cwd, input)`.
pub async fn comparison_diff(
    service: &GitService,
    cwd: &Path,
    input: GitComparisonDiffInput,
    signal: Option<&AbortSignal>,
) -> Result<GitFileDiff, GitError> {
    for value in [
        &input.expected_head,
        &input.expected_target,
        &input.merge_base,
    ] {
        if !is_hex_oid(value) {
            return Err(GitError::new(
                GitErrorCode::InvalidInput,
                "Refresh the branch comparison before opening this diff.",
            ));
        }
    }
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    lexical_workspace_path(&repo.cwd, &input.path)?;
    let comparison = inspect_comparison(service, &repo, &input.target_ref, signal).await?;
    if comparison.expected_head != input.expected_head
        || comparison.expected_target != input.expected_target
        || comparison.merge_base != input.merge_base
    {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            "The comparison changed. Refresh before opening this diff.",
        ));
    }
    let Some(file) = comparison
        .files
        .iter()
        .find(|candidate| candidate.path == input.path)
    else {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            "That file is no longer part of this comparison.",
        ));
    };
    let pathspecs: Vec<String> = if let Some(previous) = &file.previous_path {
        lexical_workspace_path(&repo.cwd, previous)?;
        vec![previous.clone(), input.path.clone()]
    } else {
        lexical_workspace_path(&repo.cwd, &input.path)?;
        vec![input.path.clone()]
    };
    let range = format!("{}..{}", input.merge_base, input.expected_head);
    let pathspec_refs: Vec<&str> = pathspecs.iter().map(String::as_str).collect();
    let mut args: Vec<&str> = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--unified=3",
        "--relative",
        &range,
        "--",
    ];
    args.extend(pathspec_refs.iter().copied());
    let result = service
        .run(
            &repo.cwd,
            &args,
            RunOptions {
                allow_truncated_output: true,
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let binary = result
        .stdout
        .lines()
        .any(|line| line.starts_with("Binary files ") || line == "GIT binary patch");
    Ok(GitFileDiff {
        path: input.path,
        patch: result.stdout.clone(),
        binary,
        truncated: result.truncated,
    })
}

fn is_hex_oid(value: &str) -> bool {
    (40..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_parsers_preserve_unusual_paths_staged_state_and_rename_stats() {
        // Mirrors the TS "review parsers preserve unusual paths..." test.
        let status = [
            "# branch.head main",
            "1 MM N... 100644 100644 100644 a b tab\tname.txt",
            "2 R. N... 100644 100644 100644 a b R100 new\nname.txt",
            "old\nname.txt",
            "? untracked.txt",
            "",
        ]
        .join("\u{0000}");
        let parsed = parse_git_review_status(&status);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].path, "new\nname.txt");
        assert_eq!(parsed[0].previous_path.as_deref(), Some("old\nname.txt"));
        assert_eq!(parsed[0].status, GitReviewFileStatus::Renamed);
        assert!(parsed[0].staged);
        assert!(!parsed[0].unstaged);
        assert_eq!(parsed[1].path, "tab\tname.txt");
        assert_eq!(parsed[1].status, GitReviewFileStatus::Modified);
        assert!(parsed[1].staged);
        assert!(parsed[1].unstaged);
        assert_eq!(parsed[2].path, "untracked.txt");
        assert_eq!(parsed[2].status, GitReviewFileStatus::Untracked);
        assert!(!parsed[2].staged);
        assert!(parsed[2].unstaged);

        let stats = parse_git_numstat("2\t1\tplain.txt\u{0}3\t0\t\u{0}old.txt\u{0}new.txt\u{0}");
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].path, "plain.txt");
        assert_eq!(stats[0].additions, Some(2));
        assert_eq!(stats[0].deletions, Some(1));
        assert!(!stats[0].binary);
        assert_eq!(stats[1].path, "new.txt");
        assert_eq!(stats[1].additions, Some(3));

        let names = parse_git_name_status(
            "M\u{0}plain.txt\u{0}R100\u{0}old name.txt\u{0}new name.txt\u{0}D\u{0}gone.txt\u{0}",
        );
        assert_eq!(names.len(), 3);
        assert_eq!(names[0].path, "gone.txt");
        assert_eq!(names[0].status, GitReviewFileStatus::Deleted);
        assert_eq!(names[1].path, "new name.txt");
        assert_eq!(names[1].previous_path.as_deref(), Some("old name.txt"));
        assert_eq!(names[1].status, GitReviewFileStatus::Renamed);
        assert_eq!(names[2].path, "plain.txt");
        assert_eq!(names[2].status, GitReviewFileStatus::Modified);
    }

    #[test]
    fn diff_header_paths_quote_weird_names() {
        assert_eq!(git_diff_header_path('a', "plain.txt"), "a/plain.txt");
        assert_eq!(
            git_diff_header_path('b', "tab\tname.txt"),
            "\"b/tab\\tname.txt\""
        );
        assert_eq!(
            git_diff_header_path('a', "line\nbreak.txt"),
            "\"a/line\\nbreak.txt\""
        );
        assert_eq!(
            git_diff_header_path('b', "quote\"name"),
            "\"b/quote\\\"name\""
        );
    }
}
