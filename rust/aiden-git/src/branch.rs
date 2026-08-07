//! Branch operations (port of `gitService.checkout` / `gitService.createBranch`
//! in `main/services/git.ts`). Listing lives in [`crate::status`] (`branches()`).

use std::path::Path;

use crate::error::{GitError, GitErrorCode};
use crate::status::{require_head, validate_branch_name};
use crate::{AbortSignal, GitRepo, GitService, RunOptions};

/// `gitService.checkout(cwd, name)`: switch to an existing local branch.
/// Refuses remote-only branches (`--no-guess`) — the branch must already exist
/// locally.
pub async fn checkout(
    service: &GitService,
    cwd: &Path,
    name: &str,
    signal: Option<&AbortSignal>,
) -> Result<(), GitError> {
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    validate_branch_name(service, &repo, name).await?;
    let lock = service.mutation_lock(&repo.common_dir).await;
    let _guard = lock.lock().await;

    let exists = service
        .run(
            &repo.cwd,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
            RunOptions {
                allow_exit_codes: &[1],
                ..RunOptions::default()
            },
        )
        .await?;
    if exists.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            format!("Local branch “{name}” no longer exists."),
        ));
    }
    service
        .run(
            &repo.cwd,
            &["switch", "--no-guess", "--", name],
            RunOptions {
                mutation: true,
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    service.invalidate();
    Ok(())
}

/// `gitService.createBranch(cwd, name)`: create and switch to a new local
/// branch (unborn repos refuse — there is no HEAD to branch from).
pub async fn create_branch(
    service: &GitService,
    cwd: &Path,
    name: &str,
    signal: Option<&AbortSignal>,
) -> Result<(), GitError> {
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    validate_branch_name(service, &repo, name).await?;
    let lock = service.mutation_lock(&repo.common_dir).await;
    let _guard = lock.lock().await;

    require_head(service, &repo).await?;
    service
        .run(
            &repo.cwd,
            &["switch", "-c", name, "--"],
            RunOptions {
                mutation: true,
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    service.invalidate();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GitServiceOptions;
    use std::fs;

    /// Create a real repository at `dir/repository` (mirrors the TS
    /// `createRepository` helper).
    async fn create_repository(dir: &Path) -> Result<std::path::PathBuf, GitError> {
        let repository = dir.join("repository");
        fs::create_dir(&repository)
            .map_err(|err| GitError::new(GitErrorCode::CommandFailed, err.to_string()))?;
        let service = GitService::new(GitServiceOptions {
            cache_ttl_ms: Some(0),
            ..GitServiceOptions::default()
        });
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

    fn service() -> GitService {
        GitService::new(GitServiceOptions {
            cache_ttl_ms: Some(0),
            ..GitServiceOptions::default()
        })
    }

    #[tokio::test]
    async fn creates_checks_out_and_refuses_remote_only_branches() -> Result<(), GitError> {
        let dir = tempfile::tempdir()
            .map_err(|err| GitError::new(GitErrorCode::CommandFailed, err.to_string()))?;
        let repository = create_repository(dir.path()).await?;
        let service = service();

        create_branch(&service, &repository, "feature/safe", None).await?;
        let current = service
            .run(
                &repository,
                &["branch", "--show-current"],
                RunOptions::default(),
            )
            .await?;
        assert_eq!(current.stdout.trim(), "feature/safe");

        checkout(&service, &repository, "main", None).await?;
        let current = service
            .run(
                &repository,
                &["branch", "--show-current"],
                RunOptions::default(),
            )
            .await?;
        assert_eq!(current.stdout.trim(), "main");

        // A remote-only ref must not be checkable out locally.
        service
            .run(
                &repository,
                &["update-ref", "refs/remotes/origin/remote-only", "HEAD"],
                RunOptions::default(),
            )
            .await?;
        let err = checkout(&service, &repository, "remote-only", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::InvalidRef);

        let err = create_branch(&service, &repository, "-invalid", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::InvalidRef);
        Ok(())
    }

    #[tokio::test]
    async fn not_a_repository_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let service = service();
        let err = create_branch(&service, dir.path(), "main", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::NotRepo);
    }

    #[tokio::test]
    async fn unborn_repository_refuses_branch_creation() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().join("unborn");
        fs::create_dir(&repository).unwrap();
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
        let err = create_branch(&service, &repository, "feature", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::Unborn);
        Ok(())
    }
}
