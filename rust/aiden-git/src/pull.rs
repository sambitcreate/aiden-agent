//! Pull (fast-forward only).
//!
//! Aiden's git surface never fetches implicitly and never rewinds the local
//! branch: `pull` is only available as a `--ff-only` fast-forward, so a
//! diverged branch is refused instead of creating a merge or a rewind.

use std::path::Path;

use crate::error::{GitError, GitErrorCode};
use crate::{AbortSignal, GitRepo, GitService, RunOptions};

/// Result of a `git pull --ff-only`.
#[derive(Debug, Clone, PartialEq)]
pub struct PullResult {
    /// Trimmed stdout of the pull (the "Updating a..b" / "Fast-forward" text).
    pub output: String,
}

/// `git pull --ff-only` against the branch's configured upstream. The network
/// timeout is the push timeout (120 s), like git.ts's slow operations.
pub async fn pull_ff_only(
    service: &GitService,
    cwd: &Path,
    signal: Option<&AbortSignal>,
) -> Result<PullResult, GitError> {
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let lock = service.mutation_lock(&repo.common_dir).await;
    let _guard = lock.lock().await;

    let pull_timeout = service.timeouts().2;
    let result = service
        .run(
            &repo.cwd,
            &["pull", "--ff-only"],
            RunOptions {
                mutation: true,
                signal,
                timeout: Some(pull_timeout),
                ..RunOptions::default()
            },
        )
        .await?;
    service.invalidate();
    Ok(PullResult {
        output: result.stdout.trim().to_string(),
    })
}

/// Run a `--ff-only` fast-forward without touching the remote: used when the
/// caller has already fetched and wants to fast-forward the current branch to
/// a known ref (e.g. an explicit `remote/branch`).
pub async fn fast_forward_to(
    service: &GitService,
    cwd: &Path,
    target_ref: &str,
    signal: Option<&AbortSignal>,
) -> Result<PullResult, GitError> {
    if target_ref.contains('\u{0000}') || !target_ref.starts_with("refs/remotes/") {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Choose a last-fetched remote branch to fast-forward to.",
        ));
    }
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let lock = service.mutation_lock(&repo.common_dir).await;
    let _guard = lock.lock().await;

    let result = service
        .run(
            &repo.cwd,
            &["merge", "--ff-only", target_ref],
            RunOptions {
                mutation: true,
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    service.invalidate();
    Ok(PullResult {
        output: result.stdout.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GitServiceOptions;
    use std::fs;

    fn service() -> GitService {
        GitService::new(GitServiceOptions {
            cache_ttl_ms: Some(0),
            ..GitServiceOptions::default()
        })
    }

    async fn create_repository(dir: &Path) -> Result<std::path::PathBuf, GitError> {
        let repository = dir.join("repository");
        fs::create_dir(&repository)
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
        fs::write(repository.join("README.md"), "initial\n")
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
    async fn fast_forwards_to_a_fetched_remote_branch() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let remote = dir.path().join("remote.git");
        fs::create_dir(&remote).unwrap();
        let service = service();
        service
            .run(
                &remote,
                &["init", "--bare", "--initial-branch=main"],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &repository,
                &["remote", "add", "origin", remote.to_string_lossy().as_ref()],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &repository,
                &["push", "-u", "origin", "main"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;

        // A peer pushes a new commit.
        let peer = dir.path().join("peer");
        fs::create_dir(&peer).unwrap();
        service
            .run(
                &peer,
                &["clone", remote.to_string_lossy().as_ref(), "."],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &peer,
                &["config", "user.email", "peer@example.test"],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &peer,
                &["config", "user.name", "Peer Test"],
                RunOptions::default(),
            )
            .await?;
        fs::write(peer.join("remote.txt"), "remote\n").unwrap();
        service
            .run(
                &peer,
                &["add", "remote.txt"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &peer,
                &["commit", "-m", "Remote"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &peer,
                &["push", "origin", "main"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;

        // The local repo fetches (an explicit user action) and fast-forwards.
        service
            .run(
                &repository,
                &["fetch", "origin"],
                RunOptions {
                    timeout: Some(std::time::Duration::from_secs(30)),
                    ..RunOptions::default()
                },
            )
            .await?;
        let remote_oid = service
            .run(
                &repository,
                &["rev-parse", "refs/remotes/origin/main"],
                RunOptions::default(),
            )
            .await?
            .stdout
            .trim()
            .to_string();
        let result =
            fast_forward_to(&service, &repository, "refs/remotes/origin/main", None).await?;
        assert!(!result.output.is_empty());
        let local_oid = service
            .run(&repository, &["rev-parse", "HEAD"], RunOptions::default())
            .await?
            .stdout
            .trim()
            .to_string();
        assert_eq!(local_oid, remote_oid);
        Ok(())
    }

    #[tokio::test]
    async fn rejects_diverged_fast_forward() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let remote = dir.path().join("remote.git");
        fs::create_dir(&remote).unwrap();
        let service = service();
        service
            .run(
                &remote,
                &["init", "--bare", "--initial-branch=main"],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &repository,
                &["remote", "add", "origin", remote.to_string_lossy().as_ref()],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &repository,
                &["push", "-u", "origin", "main"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;

        // A peer pushes a divergent commit.
        let peer = dir.path().join("peer");
        fs::create_dir(&peer).unwrap();
        service
            .run(
                &peer,
                &["clone", remote.to_string_lossy().as_ref(), "."],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &peer,
                &["config", "user.email", "peer@example.test"],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &peer,
                &["config", "user.name", "Peer Test"],
                RunOptions::default(),
            )
            .await?;
        fs::write(peer.join("peer.txt"), "peer\n").unwrap();
        service
            .run(
                &peer,
                &["add", "peer.txt"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &peer,
                &["commit", "-m", "Peer"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &peer,
                &["push", "origin", "main"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;

        // Local diverges too.
        fs::write(repository.join("local.txt"), "local\n").unwrap();
        service
            .run(
                &repository,
                &["add", "local.txt"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &repository,
                &["commit", "-m", "Local"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        service
            .run(
                &repository,
                &["fetch", "origin"],
                RunOptions {
                    ..RunOptions::default()
                },
            )
            .await?;

        let err = fast_forward_to(&service, &repository, "refs/remotes/origin/main", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::CommandFailed);
        Ok(())
    }

    #[tokio::test]
    async fn pull_ff_only_works_from_an_upstream_tracking_branch() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let remote = dir.path().join("remote.git");
        fs::create_dir(&remote).unwrap();
        let service = service();
        service
            .run(
                &remote,
                &["init", "--bare", "--initial-branch=main"],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &repository,
                &["remote", "add", "origin", remote.to_string_lossy().as_ref()],
                RunOptions::default(),
            )
            .await?;
        service
            .run(
                &repository,
                &["push", "-u", "origin", "main"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;

        let result = pull_ff_only(&service, &repository, None).await?;
        assert!(result.output.contains("Already up to date") || result.output.contains("Updating"));
        Ok(())
    }
}
