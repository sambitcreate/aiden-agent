//! Worktrees (port of `parseGitWorktrees`, `inspectWorktrees`,
//! `createWorktree`, and the managed-worktree admission helpers in
//! `main/services/git.ts`).
//!
//! The subagent system depends on Aiden-owned ("managed") worktrees: each one
//! carries an `aiden-owner` marker file (a v4-shaped ownership token) inside
//! its git administrative directory plus the checkout's device/inode identity,
//! so a persisted workspace can later prove it still owns the exact directory
//! it created. Removal verifies ownership + registration + a clean tree before
//! `git worktree remove`, then deletes the branch with a CAS `update-ref`.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{GitError, GitErrorCode};
use crate::status::{parse_git_status, validate_branch_name};
use crate::types::{GitCreatedWorktree, GitDeleteWorktreeResult, GitWorktree};
use crate::{random_v4_uuid, AbortSignal, GitRepo, GitService, RunOptions};

/// The marker file that makes a worktree Aiden-owned (`WORKTREE_OWNER_MARKER`).
pub const WORKTREE_OWNER_MARKER: &str = "aiden-owner";
const WORKTREE_OWNER_TOKEN_REGEX: &str =
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/// Parse `git worktree list --porcelain -z` (git.ts `parseGitWorktrees`).
pub fn parse_git_worktrees(raw: &str, current_path: &str) -> Vec<GitWorktree> {
    let current = std::fs::canonicalize(current_path).unwrap_or_else(|_| current_path.into());
    let mut worktrees: Vec<GitWorktree> = Vec::new();
    let mut next: Option<GitWorktree> = None;
    let finish = |next: &mut Option<GitWorktree>, worktrees: &mut Vec<GitWorktree>| {
        if let Some(worktree) = next.take() {
            if worktree.path.is_empty() || worktree.head.is_empty() {
                return;
            }
            let is_current = std::fs::canonicalize(&worktree.path)
                .map(|path| path == current)
                .unwrap_or(false);
            worktrees.push(GitWorktree {
                current: is_current,
                ..worktree
            });
        }
    };
    for record in raw.split('\u{0000}') {
        if record.is_empty() {
            finish(&mut next, &mut worktrees);
            continue;
        }
        let (key, value) = match record.split_once(' ') {
            Some((key, value)) => (key, value),
            None => (record, ""),
        };
        let entry = next.get_or_insert(GitWorktree {
            path: String::new(),
            head: String::new(),
            branch: None,
            bare: false,
            detached: false,
            current: false,
        });
        match key {
            "worktree" => entry.path = value.to_string(),
            "HEAD" => entry.head = value.to_string(),
            "branch" => {
                entry.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_string(),
                )
            }
            "bare" => entry.bare = true,
            "detached" => entry.detached = true,
            _ => {}
        }
    }
    finish(&mut next, &mut worktrees);
    worktrees
}

/// `gitService.worktrees(cwd)`.
pub async fn worktrees(
    service: &GitService,
    cwd: &Path,
    signal: Option<&AbortSignal>,
) -> Result<Vec<GitWorktree>, GitError> {
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let result = service
        .run(
            &repo.cwd,
            &["worktree", "list", "--porcelain", "-z"],
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    Ok(parse_git_worktrees(
        &result.stdout,
        &repo.top_level.display().to_string(),
    ))
}

/// Validate the git administrative dir of a managed worktree (git.ts
/// `validatedWorktreeGitDir`): a direct child of `<commonDir>/worktrees`.
pub fn validated_worktree_git_dir(repo: &GitRepo, value: &str) -> Result<PathBuf, GitError> {
    let candidate = std::fs::canonicalize(value).unwrap_or_else(|_| PathBuf::from(value));
    let registrations_root = repo.common_dir.join("worktrees");
    let valid = candidate.parent() == Some(registrations_root.as_path())
        && candidate
            .file_name()
            .map(|name| !name.is_empty())
            .unwrap_or(false);
    if !valid {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "The managed worktree identity is invalid.",
        ));
    }
    Ok(candidate)
}

/// Validate the ownership token shape (git.ts `validatedWorktreeOwnershipToken`).
pub fn validated_worktree_ownership_token(value: &str) -> Result<&str, GitError> {
    let regex = regex::Regex::new(WORKTREE_OWNER_TOKEN_REGEX).expect("static token regex");
    if !regex.is_match(value) {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "The managed worktree ownership is invalid.",
        ));
    }
    Ok(value)
}

/// Read + verify the `aiden-owner` marker inside a worktree's git dir.
fn read_owner_marker(worktree_git_dir: &Path, expected_token: &str) -> Result<bool, GitError> {
    let owner_path = worktree_git_dir.join(WORKTREE_OWNER_MARKER);
    let contents = match std::fs::read_to_string(&owner_path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err.into()),
    };
    Ok(contents.trim() == expected_token)
}

/// Write the ownership marker (git.ts `persistWorktreeOwnership`).
fn persist_worktree_ownership(
    worktree_git_dir: &Path,
    ownership_token: &str,
) -> Result<(), GitError> {
    validated_worktree_ownership_token(ownership_token)?;
    let marker_path = worktree_git_dir.join(WORKTREE_OWNER_MARKER);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker_path)?;
    use std::io::Write;
    file.write_all(format!("{ownership_token}\n").as_bytes())?;
    file.sync_all()?;
    Ok(())
}

/// Find the registered worktree matching a managed record (git.ts
/// `managedWorktreeRegistration`, marker-verified branch only).
fn managed_worktree_registration(
    repo: &GitRepo,
    worktrees: &[GitWorktree],
    worktree_path: &str,
    branch: &str,
    worktree_git_dir: Option<&str>,
    ownership_token: Option<&str>,
) -> Result<Option<GitWorktree>, GitError> {
    if let (Some(worktree_git_dir), Some(ownership_token)) = (worktree_git_dir, ownership_token) {
        let candidate = validated_worktree_git_dir(repo, worktree_git_dir)?;
        validated_worktree_ownership_token(ownership_token)?;
        if !read_owner_marker(&candidate, ownership_token)? {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                "The managed worktree ownership could not be verified.",
            ));
        }
        return Ok(worktrees
            .iter()
            .find(|worktree| {
                worktree.path == worktree_path
                    && worktree.branch.as_deref() == Some(branch)
                    && !worktree.bare
            })
            .cloned());
    }
    // Legacy records (no marker yet): match by exact path or branch.
    Ok(worktrees
        .iter()
        .find(|worktree| {
            (worktree.path == worktree_path || worktree.branch.as_deref() == Some(branch))
                && !worktree.bare
                && worktree.path != repo.top_level.display().to_string()
        })
        .cloned())
}

/// `gitService.managedWorktreeRegistered` (marker + registration check).
pub async fn managed_worktree_registered(
    service: &GitService,
    cwd: &Path,
    worktree_path: &str,
    branch: &str,
    worktree_git_dir: Option<&str>,
    ownership_token: Option<&str>,
    signal: Option<&AbortSignal>,
) -> Result<bool, GitError> {
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let worktrees = worktrees(service, &repo.cwd, signal).await?;
    let registered = managed_worktree_registration(
        &repo,
        &worktrees,
        worktree_path,
        branch,
        worktree_git_dir,
        ownership_token,
    )?;
    Ok(registered.is_some())
}

/// `gitService.managedWorktreeUsable`: stricter admission — the checkout
/// device/inode must match what Aiden recorded when creating it.
#[allow(clippy::too_many_arguments)]
pub async fn managed_worktree_usable(
    service: &GitService,
    cwd: &Path,
    worktree_path: &str,
    branch: &str,
    worktree_git_dir: Option<&str>,
    ownership_token: Option<&str>,
    worktree_device: Option<u64>,
    worktree_inode: Option<u64>,
    signal: Option<&AbortSignal>,
) -> Result<bool, GitError> {
    let (
        Some(worktree_git_dir),
        Some(ownership_token),
        Some(worktree_device),
        Some(worktree_inode),
    ) = (
        worktree_git_dir,
        ownership_token,
        worktree_device,
        worktree_inode,
    )
    else {
        return Ok(false);
    };
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let worktrees = worktrees(service, &repo.cwd, signal).await?;
    let registered = managed_worktree_registration(
        &repo,
        &worktrees,
        worktree_path,
        branch,
        Some(worktree_git_dir),
        Some(ownership_token),
    )?;
    let Some(registered) = registered else {
        return Ok(false);
    };
    if registered.path != worktree_path || registered.branch.as_deref() != Some(branch) {
        return Ok(false);
    }
    Ok(checkout_identity_matches(
        worktree_path,
        worktree_device,
        worktree_inode,
    ))
}

#[cfg(unix)]
fn checkout_identity_matches(worktree_path: &str, device: u64, inode: u64) -> bool {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(worktree_path) {
        Ok(metadata) => metadata.dev() == device && metadata.ino() == inode,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn checkout_identity_matches(_worktree_path: &str, _device: u64, _inode: u64) -> bool {
    false
}

/// `gitService.createWorktree(cwd, root, branch)`: create an Aiden-owned
/// worktree under `root`, register the ownership marker, and return the record
/// the workspace store persists.
pub async fn create_worktree(
    service: &GitService,
    cwd: &Path,
    root: &Path,
    branch: &str,
    signal: Option<&AbortSignal>,
) -> Result<GitCreatedWorktree, GitError> {
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    validate_branch_name(service, &repo, branch).await?;
    let lock = service.mutation_lock(&repo.common_dir).await;
    let _guard = lock.lock().await;

    let created_from_head = crate::status::require_head(service, &repo).await?;
    let exists = service
        .run(
            &repo.cwd,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
            RunOptions {
                allow_exit_codes: &[1],
                ..RunOptions::default()
            },
        )
        .await?;
    if exists.exit_code == 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            format!("Branch “{branch}” already exists."),
        ));
    }

    let mut hasher = Sha256::new();
    hasher.update(repo.common_dir.display().to_string().as_bytes());
    let repository_id = hex(&hasher.finalize())[..12].to_string();
    let repository_name = sanitize_slug(
        &repo
            .top_level
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
    )
    .unwrap_or_else(|| "repository".to_string());
    let branch_slug = sanitize_slug(branch).unwrap_or_else(|| "branch".to_string());

    std::fs::create_dir_all(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
    }
    let managed_root = std::fs::canonicalize(root)?;
    let repository_root = managed_root.join(format!("{repository_name}-{repository_id}"));
    std::fs::create_dir_all(&repository_root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&repository_root, std::fs::Permissions::from_mode(0o700))?;
    }
    let worktree_path = repository_root.join(format!(
        "{branch_slug}-{}",
        &random_v4_uuid().replace('-', "")[..8]
    ));
    let worktree_path_str = worktree_path.to_string_lossy().into_owned();

    let created_by_command = match service
        .run(
            &repo.cwd,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                "--",
                &worktree_path_str,
                "HEAD",
            ],
            RunOptions {
                mutation: true,
                signal,
                ..RunOptions::default()
            },
        )
        .await
    {
        Ok(_) => true,
        Err(error) => {
            let _ = rollback_created_worktree(
                service,
                &repo,
                &worktree_path_str,
                branch,
                &created_from_head,
                created_by_command_attempted(service, &repo).await,
            )
            .await;
            return Err(error);
        }
    };

    let created = worktrees(service, &repo.cwd, signal)
        .await?
        .into_iter()
        .find(|worktree| worktree.branch.as_deref() == Some(branch))
        .ok_or_else(|| {
            GitError::new(
                GitErrorCode::CommandFailed,
                "Git created the worktree but Aiden could not inspect it.",
            )
        })?;
    let git_dir_result = service
        .run(
            &created.path,
            &["rev-parse", "--path-format=absolute", "--git-dir"],
            RunOptions::default(),
        )
        .await?;
    let worktree_git_dir = validated_worktree_git_dir(
        &repo,
        &std::fs::canonicalize(git_dir_result.stdout.trim())?
            .display()
            .to_string(),
    )?;
    let ownership_token = random_v4_uuid();
    if let Err(error) = persist_worktree_ownership(&worktree_git_dir, &ownership_token) {
        let _ = rollback_created_worktree(
            service,
            &repo,
            &worktree_path_str,
            branch,
            &created_from_head,
            created_by_command,
        )
        .await;
        return Err(error);
    }
    #[cfg(unix)]
    let (worktree_device, worktree_inode) = {
        use std::os::unix::fs::MetadataExt;
        match std::fs::metadata(&created.path) {
            Ok(metadata) if metadata.is_dir() => (metadata.dev(), metadata.ino()),
            _ => {
                let _ = rollback_created_worktree(
                    service,
                    &repo,
                    &worktree_path_str,
                    branch,
                    &created_from_head,
                    created_by_command,
                )
                .await;
                return Err(GitError::new(
                    GitErrorCode::CommandFailed,
                    "The managed worktree checkout identity could not be verified.",
                ));
            }
        }
    };
    #[cfg(not(unix))]
    let (worktree_device, worktree_inode) = (0, 0);

    let relative_workspace_path = repo.cwd.strip_prefix(&repo.top_level).unwrap_or(&repo.cwd);
    let workspace_path = PathBuf::from(&created.path).join(relative_workspace_path);
    if !workspace_path.is_dir() {
        let _ = rollback_created_worktree(
            service,
            &repo,
            &worktree_path_str,
            branch,
            &created_from_head,
            created_by_command,
        )
        .await;
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "The workspace subfolder is not present in HEAD, so Aiden did not widen access to the repository root.",
        ));
    }

    service.invalidate();
    Ok(GitCreatedWorktree {
        path: created.path,
        head: created.head,
        branch: branch.to_string(),
        workspace_path: workspace_path.display().to_string(),
        repository_path: repo.top_level.display().to_string(),
        worktree_git_dir: worktree_git_dir.display().to_string(),
        ownership_token,
        worktree_device,
        worktree_inode,
        created_from_head,
    })
}

async fn created_by_command_attempted(service: &GitService, repo: &GitRepo) -> bool {
    worktrees(service, &repo.cwd, None)
        .await
        .map(|list| !list.is_empty())
        .unwrap_or(false)
}

/// Best-effort rollback of a failed `createWorktree` (simplified
/// `rollbackCreatedWorktree` in git.ts: remove the registration, then delete
/// the branch ref with a CAS).
async fn rollback_created_worktree(
    service: &GitService,
    repo: &GitRepo,
    worktree_path: &str,
    branch: &str,
    created_from_head: &str,
    registration_attempted: bool,
) -> Result<(), GitError> {
    let worktree_path = worktree_path.to_string();
    let remaining = match worktrees(service, &repo.cwd, None).await {
        Ok(list) => list,
        Err(_) => return Ok(()),
    };
    let registered = remaining.iter().any(|worktree| {
        worktree.branch.as_deref() == Some(branch) && worktree.path == worktree_path
    });
    if registered {
        // Only remove when the tree is clean; otherwise leave it for review.
        let status_result = service
            .run(
                &worktree_path,
                &[
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "-z",
                    "--untracked-files=all",
                    "--ignored=matching",
                ],
                RunOptions::default(),
            )
            .await;
        if let Ok(status_result) = status_result {
            let parsed = parse_git_status(&status_result.stdout);
            if parsed.uncommitted == 0 && parsed.ignored == 0 {
                let _ = service
                    .run(
                        &repo.cwd,
                        &["worktree", "remove", "--", &worktree_path],
                        RunOptions {
                            mutation: true,
                            ..RunOptions::default()
                        },
                    )
                    .await;
            }
        }
    }
    if registration_attempted {
        // Delete the branch ref only if it still points at the head we created.
        let _ = service
            .run(
                &repo.cwd,
                &[
                    "update-ref",
                    "-d",
                    &format!("refs/heads/{branch}"),
                    created_from_head,
                ],
                RunOptions {
                    mutation: true,
                    allow_exit_codes: &[1],
                    ..RunOptions::default()
                },
            )
            .await;
    }
    let _ = std::fs::remove_dir(worktree_path);
    Ok(())
}

/// `gitService.deleteManagedWorktree` (ownership-verified removal). The Rust
/// port keeps the registration/ownership/identity/dirty verification and the
/// CAS branch delete; the git.ts quarantine-journal dance with the native
/// `aiden-worktree-remover` binary is not reproduced.
#[allow(clippy::too_many_arguments)]
pub async fn delete_managed_worktree(
    service: &GitService,
    cwd: &Path,
    worktree_path: &str,
    branch: &str,
    created_from_head: &str,
    worktree_git_dir: Option<&str>,
    ownership_token: Option<&str>,
    worktree_device: Option<u64>,
    worktree_inode: Option<u64>,
    signal: Option<&AbortSignal>,
) -> Result<GitDeleteWorktreeResult, GitError> {
    let (Some(worktree_git_dir), Some(ownership_token)) = (worktree_git_dir, ownership_token)
    else {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "This legacy managed worktree has no verifiable Aiden ownership marker and cannot be deleted automatically.",
        ));
    };
    let (Some(worktree_device), Some(worktree_inode)) = (worktree_device, worktree_inode) else {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "This legacy managed worktree has no verifiable checkout identity and cannot be deleted automatically.",
        ));
    };
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let lock = service.mutation_lock(&repo.common_dir).await;
    let _guard = lock.lock().await;

    let worktree_git_dir = validated_worktree_git_dir(&repo, worktree_git_dir)?;
    validated_worktree_ownership_token(ownership_token)?;
    if !read_owner_marker(&worktree_git_dir, ownership_token)? {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "The managed worktree ownership could not be verified.",
        ));
    }

    let current_worktrees = worktrees(service, &repo.cwd, signal).await?;
    let registered = managed_worktree_registration(
        &repo,
        &current_worktrees,
        worktree_path,
        branch,
        Some(worktree_git_dir.display().to_string().as_str()),
        Some(ownership_token),
    )?;
    let Some(registered) = registered else {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "This managed worktree is no longer registered.",
        ));
    };
    if registered.path != worktree_path {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "This managed worktree moved or changed identity outside Aiden. Restore its original path and branch before deleting it from Aiden.",
        ));
    }
    if registered.branch.as_deref() != Some(branch) {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "This managed worktree changed branches or became detached. Restore its original branch before deleting it from Aiden.",
        ));
    }

    // Dirty check against the exact checkout.
    let status_result = service
        .run(
            worktree_path,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
                "--ignored=matching",
            ],
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let parsed = parse_git_status(&status_result.stdout);
    if parsed.uncommitted > 0 || parsed.ignored > 0 {
        return Err(GitError::new(
            GitErrorCode::DirtyWorktree,
            "Remove, commit, stash, or discard every uncommitted, untracked, and ignored file before deleting this worktree.",
        ));
    }
    if !checkout_identity_matches(worktree_path, worktree_device, worktree_inode) {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "This managed worktree moved or changed identity outside Aiden. Restore its original path and branch before deleting it from Aiden.",
        ));
    }

    // The checkout is verified clean and owned: let git remove the
    // registration (git itself refuses a dirty worktree here too).
    service
        .run(
            &repo.cwd,
            &["worktree", "remove", "--", worktree_path],
            RunOptions {
                mutation: true,
                signal,
                ..RunOptions::default()
            },
        )
        .await?;

    let still_registered = worktrees(service, &repo.cwd, signal)
        .await?
        .iter()
        .any(|worktree| {
            worktree.path == worktree_path || worktree.branch.as_deref() == Some(branch)
        });
    if still_registered {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "The managed worktree remained registered after removal. Refresh and try again.",
        ));
    }

    // CAS delete of the branch: only when it still points at createdFromHead.
    let branch_deleted = service
        .run(
            &repo.cwd,
            &[
                "update-ref",
                "-d",
                &format!("refs/heads/{branch}"),
                created_from_head,
            ],
            RunOptions {
                mutation: true,
                signal,
                ..RunOptions::default()
            },
        )
        .await
        .is_ok();
    service.invalidate();
    Ok(GitDeleteWorktreeResult { branch_deleted })
}

fn sanitize_slug(value: &str) -> Option<String> {
    let slug: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GitServiceOptions;
    use std::path::Path;

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

    #[test]
    fn parses_porcelain_worktree_list() {
        let current = std::env::temp_dir();
        let current_path = current.display().to_string();
        let other = current.join("other");
        let other_worktree = format!("worktree {}", other.display());
        let raw = [
            "worktree /main/repo",
            "HEAD 1111111111111111111111111111111111111111",
            "branch refs/heads/main",
            "",
            other_worktree.as_str(),
            "HEAD 2222222222222222222222222222222222222222",
            "branch refs/heads/feature",
            "",
            "",
        ]
        .join("\u{0000}");
        let parsed = parse_git_worktrees(&raw, &current_path);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].path, "/main/repo");
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert!(!parsed[0].bare);
        assert!(!parsed[0].detached);
        assert_eq!(parsed[1].branch.as_deref(), Some("feature"));
        assert!(!parsed[1].current);
    }

    #[tokio::test]
    async fn creates_and_deletes_a_managed_worktree() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let managed_root = dir.path().join("managed");
        let service = service();

        let created =
            create_worktree(&service, &repository, &managed_root, "codex/task-1", None).await?;
        assert_eq!(created.branch, "codex/task-1");
        let canonical_root = std::fs::canonicalize(&managed_root).unwrap();
        assert!(Path::new(&created.path).starts_with(canonical_root));
        assert!(Path::new(&created.workspace_path).is_dir());
        // The worktree checkout is on the new branch.
        let branch = service
            .run(
                &created.path,
                &["branch", "--show-current"],
                RunOptions::default(),
            )
            .await?
            .stdout
            .trim()
            .to_string();
        assert_eq!(branch, "codex/task-1");

        // Registered + usable with the recorded identity.
        let registered = managed_worktree_registered(
            &service,
            &repository,
            &created.path,
            &created.branch,
            Some(&created.worktree_git_dir),
            Some(&created.ownership_token),
            None,
        )
        .await?;
        assert!(registered);
        let usable = managed_worktree_usable(
            &service,
            &repository,
            &created.path,
            &created.branch,
            Some(&created.worktree_git_dir),
            Some(&created.ownership_token),
            Some(created.worktree_device),
            Some(created.worktree_inode),
            None,
        )
        .await?;
        assert!(usable);

        // Deleting a dirty worktree is refused.
        std::fs::write(Path::new(&created.path).join("dirty.txt"), "dirty\n").unwrap();
        let err = delete_managed_worktree(
            &service,
            &repository,
            &created.path,
            &created.branch,
            &created.created_from_head,
            Some(&created.worktree_git_dir),
            Some(&created.ownership_token),
            Some(created.worktree_device),
            Some(created.worktree_inode),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, GitErrorCode::DirtyWorktree);

        std::fs::remove_file(Path::new(&created.path).join("dirty.txt")).unwrap();
        let deleted = delete_managed_worktree(
            &service,
            &repository,
            &created.path,
            &created.branch,
            &created.created_from_head,
            Some(&created.worktree_git_dir),
            Some(&created.ownership_token),
            Some(created.worktree_device),
            Some(created.worktree_inode),
            None,
        )
        .await?;
        assert!(deleted.branch_deleted);
        assert!(!Path::new(&created.path).exists());
        let remaining = worktrees(&service, &repository, None).await?;
        assert_eq!(remaining.len(), 1); // only the main checkout
                                        // The branch ref is gone.
        let show_ref = service
            .run(
                &repository,
                &["show-ref", "--verify", "--quiet", "refs/heads/codex/task-1"],
                RunOptions {
                    allow_exit_codes: &[1],
                    ..RunOptions::default()
                },
            )
            .await?;
        assert_ne!(show_ref.exit_code, 0);
        Ok(())
    }

    #[tokio::test]
    async fn refuses_duplicate_branches_and_reports_not_repo() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let managed_root = dir.path().join("managed");
        let service = service();
        create_worktree(&service, &repository, &managed_root, "feature/one", None).await?;
        let err = create_worktree(&service, &repository, &managed_root, "feature/one", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::InvalidRef);

        let err = create_worktree(&service, dir.path(), &managed_root, "feature/two", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, GitErrorCode::NotRepo);
        Ok(())
    }

    #[tokio::test]
    async fn worktree_dirty_guard_uses_status_counts() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let managed_root = dir.path().join("managed");
        let service = service();
        let created =
            create_worktree(&service, &repository, &managed_root, "codex/dirty", None).await?;
        std::fs::write(Path::new(&created.path).join("new.txt"), "x\n").unwrap();
        let err = delete_managed_worktree(
            &service,
            &repository,
            &created.path,
            &created.branch,
            &created.created_from_head,
            Some(&created.worktree_git_dir),
            Some(&created.ownership_token),
            Some(created.worktree_device),
            Some(created.worktree_inode),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, GitErrorCode::DirtyWorktree);
        Ok(())
    }
}
