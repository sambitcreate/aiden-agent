//! Commit (port of `gitService.commit` in `main/services/git.ts`).
//!
//! The commit runs on an **isolated index**: the real `.git/index.lock` is
//! taken with `O_EXCL`, the index is copied (or seeded with
//! `read-tree --empty`) into a temp dir, all index-touching commands run with
//! `GIT_INDEX_FILE` pointing at the temp copy, and the finished index is
//! written back through the lock file and renamed into place. Combined with a
//! CAS `update-ref` on the branch, a stale or concurrent git process cannot
//! observe a half-committed index.
//!
//! Flow: validate input → `inspectReview` (snapshot fence) → stage (mode
//! `all`) → `write-tree` → hooks (`pre-commit`, `prepare-commit-msg`,
//! `commit-msg`) → re-verify snapshot → `commit-tree` (with `-S` when
//! `commit.gpgSign`) → CAS `update-ref` → finalize index → `post-commit` →
//! remaining-change count.

use std::path::{Path, PathBuf};

use crate::diff::{inspect_review, repository_git_path};
use crate::error::{GitError, GitErrorCode};
use crate::types::{GitCommitInput, GitCommitMode, GitCommitResult};
use crate::{AbortSignal, GitRepo, GitService, RunOptions};

/// `GIT_EDITOR=:` marker for hook runs (`nonInteractiveCommit`).
const MAX_MESSAGE_LENGTH: usize = 10_000;

/// The commit transaction (git.ts `GitIndexTransaction`).
struct IndexTransaction {
    index_path: PathBuf,
    lock_handle: Option<std::fs::File>,
    lock_path: PathBuf,
    message_path: PathBuf,
    temp_dir: PathBuf,
    temp_index_path: PathBuf,
}

/// Take `.git/index.lock` and stage a temp index (git.ts
/// `beginIndexTransaction`).
async fn begin_index_transaction(
    service: &GitService,
    repo: &GitRepo,
) -> Result<IndexTransaction, GitError> {
    let index_path = repository_git_path(service, repo, "index", None).await?;
    let lock_path = index_path.with_extension("index.lock");
    let lock_handle = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(handle) => handle,
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                "Git's index is busy. Wait for the other Git operation to finish, then refresh Review.",
            ));
        }
        Err(err) => {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                format!("Aiden could not lock Git's index safely: {err}"),
            ));
        }
    };
    let temp_dir =
        std::env::temp_dir().join(format!("aiden-git-index-{}", crate::random_v4_uuid()));
    std::fs::create_dir(&temp_dir)?;
    let temp_index_path = temp_dir.join("index");
    let message_path = temp_dir.join("COMMIT_EDITMSG");
    match std::fs::copy(&index_path, &temp_index_path) {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let temp_index = temp_index_path.to_string_lossy().into_owned();
            service
                .run(
                    &repo.cwd,
                    &["read-tree", "--empty"],
                    RunOptions {
                        git_index_file: Some(&temp_index),
                        mutation: true,
                        ..RunOptions::default()
                    },
                )
                .await?;
        }
        Err(err) => return Err(err.into()),
    }
    Ok(IndexTransaction {
        index_path,
        lock_handle: Some(lock_handle),
        lock_path,
        message_path,
        temp_dir,
        temp_index_path,
    })
}

/// Write the finalized temp index back through the lock and rename it into
/// place (git.ts `finalizeIndexTransaction`).
fn finalize_index_transaction(transaction: &mut IndexTransaction) -> Result<(), GitError> {
    let Some(handle) = transaction.lock_handle.take() else {
        return Ok(());
    };
    let contents = std::fs::read(&transaction.temp_index_path)?;
    use std::io::Write;
    let mut handle = handle;
    handle.set_len(0)?;
    handle.write_all(&contents)?;
    handle.sync_all()?;
    drop(handle);
    std::fs::rename(&transaction.lock_path, &transaction.index_path)?;
    Ok(())
}

/// Best-effort cleanup of the lock + temp dir (git.ts `releaseIndexTransaction`).
fn release_index_transaction(transaction: &mut IndexTransaction) {
    transaction.lock_handle.take();
    let _ = std::fs::remove_file(&transaction.lock_path);
    let _ = std::fs::remove_dir_all(&transaction.temp_dir);
}

/// Run a hook via `git hook run --ignore-missing` (git.ts `runHook`).
async fn run_hook(
    service: &GitService,
    repo: &GitRepo,
    name: &str,
    args: &[&str],
    git_index_file: Option<&str>,
    signal: Option<&AbortSignal>,
) -> Result<crate::GitCommandResult, GitError> {
    let mut argv: Vec<&str> = vec!["hook", "run", "--ignore-missing", name];
    if !args.is_empty() {
        argv.push("--");
        argv.extend_from_slice(args);
    }
    service
        .run(
            &repo.cwd,
            &argv,
            RunOptions {
                git_index_file,
                mutation: true,
                non_interactive_commit: true,
                signal,
                ..RunOptions::default()
            },
        )
        .await
}

/// `reconcileCommitRef` in git.ts: how the branch ref relates to the candidate.
async fn reconcile_commit_ref(
    service: &GitService,
    repo: &GitRepo,
    branch_ref: &str,
    candidate_commit: &str,
) -> Result<CommitRefReconciliation, GitError> {
    let result = match service
        .run(
            &repo.cwd,
            &["show-ref", "--verify", "--hash", branch_ref],
            RunOptions {
                allow_exit_codes: &[1],
                ..RunOptions::default()
            },
        )
        .await
    {
        Ok(result) => result,
        // "unknown": the reconciliation itself could not complete.
        Err(error) if error.is_indeterminate() => return Ok(CommitRefReconciliation::Unknown),
        Err(error) => return Err(error),
    };
    if result.exit_code != 0 {
        return Ok(CommitRefReconciliation::Absent);
    }
    let current = result.stdout.trim().to_string();
    if current == candidate_commit {
        return Ok(CommitRefReconciliation::Exact);
    }
    let ancestor = match service
        .run(
            &repo.cwd,
            &["merge-base", "--is-ancestor", candidate_commit, &current],
            RunOptions {
                allow_exit_codes: &[1],
                ..RunOptions::default()
            },
        )
        .await
    {
        Ok(result) => result,
        Err(error) if error.is_indeterminate() => return Ok(CommitRefReconciliation::Unknown),
        Err(error) => return Err(error),
    };
    if ancestor.exit_code == 0 {
        return Ok(CommitRefReconciliation::Advanced);
    }
    let reflog = service
        .run(
            &repo.cwd,
            &["reflog", "show", "--format=%H", branch_ref],
            RunOptions {
                allow_exit_codes: &[1],
                ..RunOptions::default()
            },
        )
        .await?;
    let reached = reflog
        .stdout
        .lines()
        .any(|line| line.trim() == candidate_commit);
    Ok(if reached {
        CommitRefReconciliation::Advanced
    } else {
        CommitRefReconciliation::Absent
    })
}

enum CommitRefReconciliation {
    Absent,
    Advanced,
    Exact,
    Unknown,
}

/// `gitService.commit(cwd, input)`.
pub async fn commit(
    service: &GitService,
    cwd: &Path,
    input: GitCommitInput,
    signal: Option<&AbortSignal>,
) -> Result<GitCommitResult, GitError> {
    let message = input.message.trim();
    if message.is_empty() || message.contains('\u{0000}') || message.len() > MAX_MESSAGE_LENGTH {
        return Err(GitError::new(
            GitErrorCode::InvalidInput,
            "Enter a commit message between 1 and 10,000 characters.",
        ));
    }
    if !is_hex64(&input.expected_snapshot) {
        return Err(GitError::new(
            GitErrorCode::InvalidInput,
            "Refresh Review before committing these changes.",
        ));
    }
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let lock = service.mutation_lock(&repo.common_dir).await;
    let _guard = lock.lock().await;

    let mut transaction = begin_index_transaction(service, &repo).await?;
    let mut candidate_commit: Option<String> = None;
    let mut branch_ref: Option<String> = None;
    let mut ref_update_attempted = false;
    let mut branch = "current branch".to_string();
    let mut subject = message.lines().next().unwrap_or("").to_string();

    let outcome: Result<GitCommitResult, GitError> = async {
        let review = inspect_review(service, &repo, signal).await?;
        if let Some(review_branch) = &review.branch {
            branch = review_branch.clone();
        }
        if review.commit.snapshot.as_deref() != Some(input.expected_snapshot.as_str()) {
            return Err(GitError::new(
                GitErrorCode::StaleSnapshot,
                "The working tree changed after this review. Refresh the changes before committing.",
            ));
        }
        if !review.commit.allowed {
            let code = if !review.commit.repository_root {
                GitErrorCode::UnsupportedScope
            } else if review.summary.conflicted_files > 0 {
                GitErrorCode::Conflicted
            } else {
                GitErrorCode::CommandFailed
            };
            return Err(GitError::new(
                code,
                review.commit.reason.clone().unwrap_or_else(|| {
                    "These changes cannot be committed from Aiden.".to_string()
                }),
            ));
        }
        if input.mode == GitCommitMode::Staged && review.summary.staged_files == 0 {
            return Err(GitError::new(
                GitErrorCode::InvalidInput,
                "There are no staged changes to commit.",
            ));
        }

        let head_args = ["rev-parse", "--verify", "HEAD"];
        let symbolic_args = ["symbolic-ref", "--quiet", "HEAD"];
        let head = service
            .run(&repo.cwd, &head_args, RunOptions { allow_exit_codes: &[128], signal, ..RunOptions::default() })
            .await?;
        let symbolic_head = service
            .run(&repo.cwd, &symbolic_args, RunOptions { allow_exit_codes: &[1], signal, ..RunOptions::default() })
            .await?;
        if symbolic_head.exit_code != 0 || !symbolic_head.stdout.trim().starts_with("refs/heads/") {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                "Switch to a local branch before committing from Aiden.",
            ));
        }
        let expected_head = (head.exit_code == 0).then(|| head.stdout.trim().to_string());
        let current_branch_ref = symbolic_head.stdout.trim().to_string();
        branch_ref = Some(current_branch_ref.clone());
        branch = current_branch_ref["refs/heads/".len()..].to_string();

        let temp_index = transaction.temp_index_path.to_string_lossy().into_owned();
        if input.mode == GitCommitMode::All {
            service
                .run(
                    &repo.cwd,
                    &["add", "-A", "--", "."],
                    RunOptions {
                        git_index_file: Some(&temp_index),
                        mutation: true,
                        signal,
                        ..RunOptions::default()
                    },
                )
                .await?;
        }
        let intended_tree = service
            .run(
                &repo.cwd,
                &["write-tree"],
                RunOptions {
                    git_index_file: Some(&temp_index),
                    mutation: true,
                    signal,
                    ..RunOptions::default()
                },
            )
            .await?
            .stdout
            .trim()
            .to_string();

        let verified = inspect_review(service, &repo, signal).await?;
        if verified.commit.snapshot.as_deref() != Some(input.expected_snapshot.as_str()) {
            return Err(GitError::new(
                GitErrorCode::StaleSnapshot,
                "The working tree changed while Aiden prepared the commit. Refresh Review before retrying.",
            ));
        }

        // Hooks may rewrite the message; re-validate after each stage.
        std::fs::write(&transaction.message_path, format!("{message}\n"))?;
        run_hook(service, &repo, "pre-commit", &[], Some(&temp_index), signal).await?;
        let message_path = transaction.message_path.to_string_lossy().into_owned();
        run_hook(
            service,
            &repo,
            "prepare-commit-msg",
            &[&message_path, "message"],
            Some(&temp_index),
            signal,
        )
        .await?;
        let mut final_message = read_commit_message(&transaction.message_path)?;
        std::fs::write(&transaction.message_path, format!("{final_message}\n"))?;
        run_hook(
            service,
            &repo,
            "commit-msg",
            &[&message_path],
            Some(&temp_index),
            signal,
        )
        .await?;
        final_message = read_commit_message(&transaction.message_path)?;
        std::fs::write(&transaction.message_path, format!("{final_message}\n"))?;
        subject = final_message
            .lines()
            .next()
            .unwrap_or("")
            .to_string();

        let hook_tree = service
            .run(
                &repo.cwd,
                &["write-tree"],
                RunOptions {
                    git_index_file: Some(&temp_index),
                    mutation: true,
                    signal,
                    ..RunOptions::default()
                },
            )
            .await?
            .stdout
            .trim()
            .to_string();
        if hook_tree != intended_tree {
            return Err(GitError::new(
                GitErrorCode::StaleSnapshot,
                "A Git hook changed the selected index. Review the hook's changes before committing.",
            ));
        }

        let signing = service
            .run(
                &repo.cwd,
                &["config", "--bool", "--get", "commit.gpgSign"],
                RunOptions { allow_exit_codes: &[1], signal, ..RunOptions::default() },
            )
            .await?;
        let mut commit_args: Vec<&str> = vec!["commit-tree", &intended_tree];
        if let Some(expected_head) = &expected_head {
            commit_args.push("-p");
            commit_args.push(expected_head);
        }
        if signing.exit_code == 0 && signing.stdout.trim() == "true" {
            commit_args.push("-S");
        }
        let message_path = transaction.message_path.to_string_lossy().into_owned();
        commit_args.push("-F");
        commit_args.push(&message_path);
        let created = service
            .run(
                &repo.cwd,
                &commit_args,
                RunOptions { mutation: true, signal, ..RunOptions::default() },
            )
            .await?;
        candidate_commit = Some(created.stdout.trim().to_string());
        let candidate = candidate_commit.clone().unwrap();

        // The branch must still be the one we inspected.
        let current_symbolic_head = service
            .run(
                &repo.cwd,
                &["symbolic-ref", "--quiet", "HEAD"],
                RunOptions { allow_exit_codes: &[1], signal, ..RunOptions::default() },
            )
            .await?;
        if current_symbolic_head.exit_code != 0
            || current_symbolic_head.stdout.trim() != current_branch_ref
        {
            return Err(GitError::new(
                GitErrorCode::StaleSnapshot,
                "The current branch changed while Aiden prepared the commit. Refresh Review before retrying.",
            ));
        }

        let mut warnings: Vec<String> = Vec::new();
        ref_update_attempted = true;
        let update = service
            .run(
                &repo.cwd,
                &[
                    "update-ref", "-m", &format!("commit: {}", &subject[..subject.len().min(240)]),
                    &current_branch_ref, &candidate,
                    expected_head.as_deref().unwrap_or(""),
                ],
                RunOptions { mutation: true, signal, ..RunOptions::default() },
            )
            .await;
        match update {
            Ok(_) => {}
            Err(error) => {
                if !error.is_indeterminate() {
                    return Err(error);
                }
                // The ref update outcome is unknown: reconcile it.
                match reconcile_commit_ref(service, &repo, &current_branch_ref, &candidate).await? {
                    CommitRefReconciliation::Absent | CommitRefReconciliation::Unknown => {
                        return Err(error);
                    }
                    _ => {
                        warnings.push(
                            "The commit completed, but Git stopped responding before Aiden received confirmation."
                                .to_string(),
                        );
                    }
                }
            }
        }

        // Finalize the real index while the branch ref is known-good.
        let finalization = finalize_index_transaction(&mut transaction);
        if let Err(error) = &finalization {
            warnings.push(format!(
                "The commit was created, but Aiden could not refresh Git's index: {error}. Refresh Review and restage if needed."
            ));
        }

        // post-commit only when the index finalized cleanly.
        if finalization.is_ok() {
            if let Err(error) = run_hook(service, &repo, "post-commit", &[], None, signal).await {
                warnings.push(format!(
                    "The commit was created, but its post-commit hook did not finish cleanly: {}",
                    error.message
                ));
            }
        } else {
            warnings.push(
                "Aiden did not run the post-commit hook because the branch and index could not be finalized together."
                    .to_string(),
            );
        }

        let remaining_changes = match crate::status::status(service, &repo, signal).await {
            Ok(status) => status.uncommitted,
            Err(_) => {
                warnings.push(
                    "Aiden could not refresh the remaining-change count. Refresh Review to reconcile it."
                        .to_string(),
                );
                None
            }
        };

        service.invalidate();
        Ok(GitCommitResult {
            commit: candidate,
            branch: branch.clone(),
            remaining_changes,
            subject: subject.clone(),
            warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
        })
    }
    .await;

    // If the outcome is uncertain but the ref now points at the candidate, the
    // commit exists even though this call failed — report it instead of lying.
    let result = match outcome {
        Ok(result) => Ok(result),
        Err(error) => {
            if let (Some(candidate), Some(branch_ref)) = (&candidate_commit, &branch_ref) {
                if ref_update_attempted {
                    if let Ok(CommitRefReconciliation::Exact) =
                        reconcile_commit_ref(service, &repo, branch_ref, candidate).await
                    {
                        let _ = finalize_index_transaction(&mut transaction);
                        return Ok(GitCommitResult {
                            commit: candidate.clone(),
                            branch,
                            remaining_changes: None,
                            subject,
                            warning: Some(format!(
                                "{} The commit was created, but Aiden could not finish reconciling its result. Refresh Review before continuing.",
                                error.message
                            )),
                        });
                    }
                }
            }
            Err(error)
        }
    };
    release_index_transaction(&mut transaction);
    result
}

fn read_commit_message(path: &Path) -> Result<String, GitError> {
    let value = std::fs::read_to_string(path)?;
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('\u{0000}') || trimmed.len() > MAX_MESSAGE_LENGTH {
        return Err(GitError::new(
            GitErrorCode::InvalidInput,
            "The prepared commit message must be between 1 and 10,000 characters.",
        ));
    }
    Ok(trimmed.to_string())
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::review;
    use crate::types::GitCommitMode;
    use crate::{status, GitServiceOptions};

    fn service() -> GitService {
        GitService::new(GitServiceOptions {
            cache_ttl_ms: Some(0),
            ..GitServiceOptions::default()
        })
    }

    async fn create_repository(dir: &Path) -> Result<std::path::PathBuf, GitError> {
        let repository = dir.join("repository");
        std::fs::create_dir(&repository)
            .map_err(|err| GitError::new(GitErrorCode::CommandFailed, err.to_string()))?;
        let service = service();
        service
            .run(
                &repository,
                &["init", "--initial-branch=main"],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &repository,
                &["config", "user.email", "aiden@example.test"],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &repository,
                &["config", "user.name", "Aiden Test"],
                RunOptions::default(),
            )
            .await?;
        std::fs::write(repository.join("README.md"), "initial\n")
            .map_err(|err| GitError::new(GitErrorCode::CommandFailed, err.to_string()))?;
        service
            .run(
                &repository,
                &["add", "README.md"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &repository,
                &["commit", "-m", "Initial commit"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        Ok(repository)
    }

    #[tokio::test]
    async fn commits_all_changes_with_snapshot_fencing() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let service = service();
        std::fs::write(repository.join("feature.txt"), "feature\n").unwrap();

        let review_result = review(&service, &repository, None).await?;
        assert!(review_result.commit.allowed);
        let snapshot = review_result.commit.snapshot.clone().unwrap();
        let result = commit(
            &service,
            &repository,
            GitCommitInput {
                expected_snapshot: snapshot,
                message: "Add feature".to_string(),
                mode: GitCommitMode::All,
            },
            None,
        )
        .await?;
        assert_eq!(result.subject, "Add feature");
        assert_eq!(result.branch, "main");
        assert!(result.commit.len() == 40 || result.commit.len() == 64);

        let head = service
            .run(&repository, &["rev-parse", "HEAD"], RunOptions::default())
            .await?;
        assert_eq!(head.stdout.trim(), result.commit);
        // The tree is now clean.
        let info = status::info(&service, &repository, None).await?;
        assert_eq!(info.uncommitted, Some(0));
        Ok(())
    }

    #[tokio::test]
    async fn refuses_stale_snapshots_and_clean_staged_commits() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let service = service();
        std::fs::write(repository.join("a.txt"), "a\n").unwrap();
        let review_result = review(&service, &repository, None).await?;

        // Stale snapshot: change a file after the review.
        std::fs::write(repository.join("a.txt"), "a2\n").unwrap();
        let err = commit(
            &service,
            &repository,
            GitCommitInput {
                expected_snapshot: review_result.commit.snapshot.clone().unwrap(),
                message: "Stale".to_string(),
                mode: GitCommitMode::All,
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, GitErrorCode::StaleSnapshot);

        // A "staged" commit with no staged changes is invalid input (there are
        // unstaged changes, so the tree is not clean).
        std::fs::write(repository.join("a.txt"), "a3\n").unwrap();
        let review_result = review(&service, &repository, None).await?;
        assert!(review_result.commit.allowed);
        assert_eq!(review_result.summary.staged_files, 0);
        let err = commit(
            &service,
            &repository,
            GitCommitInput {
                expected_snapshot: review_result.commit.snapshot.unwrap(),
                message: "No staged".to_string(),
                mode: GitCommitMode::Staged,
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, GitErrorCode::InvalidInput);
        Ok(())
    }

    #[tokio::test]
    async fn conflicted_review_blockers_commit() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let service = service();
        // Simulate a conflicted file: write two branches and merge with conflict.
        service
            .run(
                &repository,
                &["switch", "-c", "other"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        std::fs::write(repository.join("README.md"), "other\n").unwrap();
        service
            .run(
                &repository,
                &["add", "README.md"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &repository,
                &["commit", "-m", "Other"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &repository,
                &["switch", "main"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        std::fs::write(repository.join("README.md"), "main\n").unwrap();
        service
            .run(
                &repository,
                &["add", "README.md"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &repository,
                &["commit", "-m", "Main"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        // A merge conflict leaves MERGE_HEAD + conflicted files.
        let merged = service
            .run(
                &repository,
                &["merge", "other"],
                RunOptions {
                    allow_exit_codes: &[1],
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        assert_ne!(merged.exit_code, 0, "merge should conflict");

        let review_result = review(&service, &repository, None).await?;
        assert!(!review_result.commit.allowed);
        assert!(review_result.summary.conflicted_files > 0);
        let err = commit(
            &service,
            &repository,
            GitCommitInput {
                expected_snapshot: review_result.commit.snapshot.clone().unwrap_or_default(),
                message: "Conflict".to_string(),
                mode: GitCommitMode::All,
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, GitErrorCode::Conflicted);
        Ok(())
    }
}
