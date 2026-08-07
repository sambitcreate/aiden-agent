//! Reviewed push (port of `gitService.pushCapability` + `gitService.push` in
//! `main/services/git.ts`).
//!
//! A push is a two-step operation: the UI reads a **capability** (branch,
//! expected HEAD, configured remotes, each remote's transport identity hash,
//! suggested remote, destination branch, ahead/behind) and then confirms with
//! that exact snapshot. `push` re-derives the capability, refuses any drift
//! (stale snapshot / changed remote), freezes the push transport, and pushes
//! the exact reviewed commit with `--porcelain --no-force` — never fetching,
//! never forcing, never mirroring. Optionally `--force-with-lease=<ref>:<oid>`
//! when the caller pins the remote OID the destination must still point at.

use std::collections::BTreeMap;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::{GitError, GitErrorCode};
use crate::status::status;
use crate::types::{GitPushCapability, GitPushInput, GitPushResult};
use crate::{AbortSignal, GitRepo, GitService, RunOptions};

/// The frozen push transport (`GitPushTransport` in git.ts).
#[derive(Debug, Clone, PartialEq)]
struct PushTransport {
    endpoint: String,
    proxy: Option<String>,
    proxy_auth_method: Option<String>,
    receive_pack: Option<String>,
}

/// The stable (branch, HEAD) pair for push (`cohesivePushHead` in git.ts).
struct CohesiveHead {
    branch: Option<String>,
    branch_ref: Option<String>,
    expected_head: Option<String>,
    unborn: bool,
    detached: bool,
}

/// `remote.get-url --push --all <remote>` endpoint (git.ts `pushEndpoint`).
async fn push_endpoint(
    service: &GitService,
    repo: &GitRepo,
    remote: &str,
    signal: Option<&AbortSignal>,
) -> Result<Option<String>, GitError> {
    let result = match service
        .run(
            &repo.cwd,
            &["remote", "get-url", "--push", "--all", remote],
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await
    {
        Ok(result) => result,
        Err(error) if error.code == GitErrorCode::Aborted => return Err(error),
        Err(_) => return Ok(None),
    };
    let endpoints: Vec<&str> = result
        .stdout
        .lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.is_empty())
        .collect();
    Ok(
        if endpoints.len() == 1 && !endpoints[0].contains('\u{0000}') {
            Some(endpoints[0].to_string())
        } else {
            None
        },
    )
}

/// `remoteConfigValue` in git.ts.
async fn remote_config_value(
    service: &GitService,
    repo: &GitRepo,
    remote: &str,
    key: &str,
    signal: Option<&AbortSignal>,
) -> Result<Option<String>, GitError> {
    let result = service
        .run(
            &repo.cwd,
            &["config", "--get", &format!("remote.{remote}.{key}")],
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    if result.exit_code != 0 {
        return Ok(None);
    }
    let value = result.stdout.trim_end_matches('\n');
    Ok((!value.contains('\u{0000}')).then(|| value.to_string()))
}

/// `pushTransport` in git.ts.
async fn push_transport(
    service: &GitService,
    repo: &GitRepo,
    remote: &str,
    signal: Option<&AbortSignal>,
) -> Result<Option<PushTransport>, GitError> {
    let Some(endpoint) = push_endpoint(service, repo, remote, signal).await? else {
        return Ok(None);
    };
    let (proxy, proxy_auth_method, receive_pack) = tokio::join!(
        remote_config_value(service, repo, remote, "proxy", signal),
        remote_config_value(service, repo, remote, "proxyAuthMethod", signal),
        remote_config_value(service, repo, remote, "receivepack", signal),
    );
    Ok(Some(PushTransport {
        endpoint,
        proxy: proxy?,
        proxy_auth_method: proxy_auth_method?,
        receive_pack: receive_pack?,
    }))
}

/// `pushTransportIdentity` in git.ts: sha256 over the transport facts so the
/// reviewed push can detect endpoint drift.
fn push_transport_identity(transport: &PushTransport) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-reviewed-push-transport-v2\0");
    hasher.update(
        serde_json::to_string(&[
            transport.endpoint.as_str(),
            transport.proxy.as_deref().unwrap_or(""),
            transport.proxy_auth_method.as_deref().unwrap_or(""),
            transport.receive_pack.as_deref().unwrap_or(""),
        ])
        .unwrap_or_default()
        .as_bytes(),
    );
    hex(&hasher.finalize())
}

async fn cohesive_push_head(
    service: &GitService,
    repo: &GitRepo,
    signal: Option<&AbortSignal>,
) -> Result<CohesiveHead, GitError> {
    let symbolic_before = service
        .run(
            &repo.cwd,
            &["symbolic-ref", "--quiet", "HEAD"],
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let head_before = service
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
    let branch_ref =
        (symbolic_before.exit_code == 0).then(|| symbolic_before.stdout.trim().to_string());
    let branch = branch_ref
        .as_ref()
        .filter(|reference| reference.starts_with("refs/heads/"))
        .map(|reference| reference["refs/heads/".len()..].to_string());
    let status_value = status(service, repo, signal).await?;
    let branch_head = if let Some(reference) = &branch_ref {
        let args = ["rev-parse", "--verify", reference];
        service
            .run(
                &repo.cwd,
                &args,
                RunOptions {
                    allow_exit_codes: &[128],
                    signal,
                    ..RunOptions::default()
                },
            )
            .await
            .map(|result| result.exit_code == 0)?
    } else {
        false
    };
    let expected_head = (head_before.exit_code == 0).then(|| head_before.stdout.trim().to_string());
    let unborn_branch = branch_ref.is_some()
        && head_before.exit_code != 0
        && !branch_head
        && status_value.unborn == Some(true)
        && status_value.branch.as_deref() == branch.as_deref();
    Ok(CohesiveHead {
        branch,
        branch_ref,
        expected_head,
        unborn: unborn_branch,
        detached: status_value.detached == Some(true),
    })
}

const fn remote_args() -> [&'static str; 1] {
    ["remote"]
}

const fn push_default_args() -> [&'static str; 3] {
    ["config", "--get", "remote.pushDefault"]
}

const fn head_args() -> [&'static str; 3] {
    ["rev-parse", "--verify", "HEAD"]
}

const fn symbolic_args() -> [&'static str; 3] {
    ["symbolic-ref", "--quiet", "HEAD"]
}

/// `pushStateBlocker` in git.ts.
async fn push_state_blocker(
    service: &GitService,
    repo: &GitRepo,
    signal: Option<&AbortSignal>,
) -> Result<Option<String>, GitError> {
    for (git_path, reason) in [
        (
            "MERGE_HEAD",
            "Finish or abort the merge before pushing from Aiden.",
        ),
        (
            "CHERRY_PICK_HEAD",
            "Finish or abort the cherry-pick before pushing from Aiden.",
        ),
        (
            "REVERT_HEAD",
            "Finish or abort the revert before pushing from Aiden.",
        ),
        (
            "rebase-merge",
            "Finish or abort the rebase before pushing from Aiden.",
        ),
        (
            "rebase-apply",
            "Finish or abort the rebase before pushing from Aiden.",
        ),
    ] {
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
            std::path::PathBuf::from(value)
        } else {
            repo.cwd.join(value)
        };
        match std::fs::metadata(&resolved) {
            Ok(_) => return Ok(Some(reason.to_string())),
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

/// `inspectPushCapability` in git.ts.
async fn inspect_push_capability(
    service: &GitService,
    repo: &GitRepo,
    signal: Option<&AbortSignal>,
) -> Result<GitPushCapability, GitError> {
    let cohesive = cohesive_push_head(service, repo, signal).await?;
    let remotes_result = service
        .run(
            &repo.cwd,
            &remote_args(),
            RunOptions {
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let push_default = service
        .run(
            &repo.cwd,
            &push_default_args(),
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    let (upstream_remote, upstream_ref) = if let Some(branch_ref) = &cohesive.branch_ref {
        let upstream = service
            .run(
                &repo.cwd,
                &[
                    "for-each-ref",
                    "--format=%(upstream:remotename)%00%(upstream:remoteref)%00",
                    branch_ref,
                ],
                RunOptions {
                    signal,
                    ..RunOptions::default()
                },
            )
            .await?;
        let mut parts = upstream.stdout.split('\u{0000}');
        (
            parts
                .next()
                .map(str::to_string)
                .filter(|value| !value.is_empty()),
            parts
                .next()
                .map(str::to_string)
                .filter(|value| !value.is_empty()),
        )
    } else {
        (None, None)
    };

    let configured_remotes: Vec<String> = remotes_result
        .stdout
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();

    let mut transports: BTreeMap<String, PushTransport> = BTreeMap::new();
    for remote in &configured_remotes {
        if let Some(transport) = push_transport(service, repo, remote, signal).await? {
            transports.insert(remote.clone(), transport);
        }
    }
    let remote_identities: BTreeMap<String, String> = transports
        .iter()
        .map(|(remote, transport)| (remote.clone(), push_transport_identity(transport)))
        .collect();
    let remotes: Vec<String> = configured_remotes
        .iter()
        .filter(|remote| remote_identities.contains_key(remote.as_str()))
        .cloned()
        .collect();
    let configured_push_default =
        (push_default.exit_code == 0).then(|| push_default.stdout.trim().to_string());
    let suggested_remote = [
        upstream_remote.as_deref(),
        configured_push_default.as_deref(),
        Some("origin"),
        if remotes.len() == 1 {
            remotes.first().map(String::as_str)
        } else {
            None
        },
        remotes.first().map(String::as_str),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| remotes.iter().any(|remote| remote == candidate))
    .map(str::to_string);

    let destination_branch = upstream_ref
        .as_deref()
        .and_then(|reference| reference.strip_prefix("refs/heads/"))
        .map(str::to_string)
        .or_else(|| cohesive.branch.clone());

    let repository_root = repo.is_root();
    let status_value = status(service, repo, signal).await?;
    let reason: Option<String> = if !repository_root {
        Some(
            "Push from Aiden is available only when the workspace is the repository root."
                .to_string(),
        )
    } else if cohesive.expected_head.is_none() || cohesive.unborn {
        Some("Create the repository's first commit before pushing.".to_string())
    } else if cohesive.branch.is_none() || cohesive.detached {
        Some("Switch to a local branch before pushing from Aiden.".to_string())
    } else if configured_remotes.is_empty() {
        Some("Add a Git remote before pushing from Aiden.".to_string())
    } else if remotes.is_empty() {
        Some("Configure exactly one push URL for a remote before pushing from Aiden.".to_string())
    } else {
        push_state_blocker(service, repo, signal).await?
    };

    Ok(GitPushCapability {
        allowed: reason.is_none(),
        reason,
        branch: cohesive.branch,
        expected_head: cohesive.expected_head,
        remotes,
        remote_identities,
        suggested_remote,
        destination_branch,
        upstream: status_value.upstream,
        ahead: status_value.ahead.unwrap_or(0),
        behind: status_value.behind.unwrap_or(0),
        repository_root,
        remote_state: "local-ref".to_string(),
    })
}

/// `gitService.pushCapability(cwd)`.
pub async fn push_capability(
    service: &GitService,
    cwd: &Path,
    signal: Option<&AbortSignal>,
) -> Result<GitPushCapability, GitError> {
    let Some(repo) = GitRepo::resolve(service, cwd, signal).await? else {
        return Ok(GitPushCapability {
            allowed: false,
            reason: Some("This workspace is not a Git repository.".to_string()),
            branch: None,
            expected_head: None,
            remotes: Vec::new(),
            remote_identities: BTreeMap::new(),
            suggested_remote: None,
            destination_branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            repository_root: false,
            remote_state: "local-ref".to_string(),
        });
    };
    service
        .stable_read(&repo, {
            let repo = repo.clone();
            let service = service.clone();
            Box::pin(async move { inspect_push_capability(&service, &repo, signal).await })
        })
        .await
}

/// `snapshotPushedTrackingRef` in git.ts: validate the tracking ref name and
/// return it (the old value is re-read at record time, after the push itself
/// may have updated it).
async fn snapshot_pushed_tracking_ref(
    service: &GitService,
    repo: &GitRepo,
    remote: &str,
    destination_branch: &str,
    signal: Option<&AbortSignal>,
) -> Result<Option<String>, GitError> {
    let tracking_ref = format!("refs/remotes/{remote}/{destination_branch}");
    let valid = service
        .run(
            &repo.cwd,
            &["check-ref-format", &tracking_ref],
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    if valid.exit_code != 0 {
        return Ok(None);
    }
    Ok(Some(tracking_ref))
}

/// `recordPushedTrackingRef` in git.ts. The push itself may have created or
/// advanced the remote-tracking ref (modern git updates `refs/remotes/*` on
/// push), so the old value is re-read right before the CAS `update-ref` — the
/// CAS still refuses to clobber a tracking ref that another process advanced.
async fn record_pushed_tracking_ref(
    service: &GitService,
    repo: &GitRepo,
    reference: &str,
    expected_head: &str,
) -> bool {
    let current = match service
        .run(
            &repo.cwd,
            &["rev-parse", "--verify", reference],
            RunOptions {
                allow_exit_codes: &[128],
                ..RunOptions::default()
            },
        )
        .await
    {
        Ok(result) if result.exit_code == 0 => result.stdout.trim().to_string(),
        _ => "0".repeat(expected_head.len()),
    };
    let args = [
        "update-ref",
        "-m",
        "aiden: record reviewed push",
        reference,
        expected_head,
        current.as_str(),
    ];
    let result = service
        .run(
            &repo.cwd,
            &args,
            RunOptions {
                mutation: true,
                ..RunOptions::default()
            },
        )
        .await;
    if let Err(error) = &result {
        eprintln!("RECORD-DEBUG update-ref failed: {error:?} args={args:?}");
    }
    result.is_ok()
}

/// `gitService.push(cwd, input)`.
pub async fn push(
    service: &GitService,
    cwd: &Path,
    input: GitPushInput,
    signal: Option<&AbortSignal>,
) -> Result<GitPushResult, GitError> {
    if !(40..=64).contains(&input.expected_head.len())
        || !input
            .expected_head
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(GitError::new(
            GitErrorCode::InvalidInput,
            "Refresh the branch state before pushing.",
        ));
    }
    if input.expected_remote_identity.len() != 64
        || !input
            .expected_remote_identity
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(GitError::new(
            GitErrorCode::InvalidInput,
            "Refresh the remote state before pushing.",
        ));
    }
    if input.remote.is_empty()
        || input.remote != input.remote.trim()
        || input.remote.contains('\u{0000}')
    {
        return Err(GitError::new(
            GitErrorCode::InvalidInput,
            "Choose a configured Git remote.",
        ));
    }
    if input.expected_branch.is_empty()
        || input.expected_branch != input.expected_branch.trim()
        || input.expected_branch.contains('\u{0000}')
    {
        return Err(GitError::new(
            GitErrorCode::InvalidInput,
            "Refresh the branch state before pushing.",
        ));
    }
    if input.destination_branch.is_empty()
        || input.destination_branch != input.destination_branch.trim()
    {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Enter a valid destination branch.",
        ));
    }
    let repo = GitRepo::resolve(service, cwd, signal)
        .await?
        .ok_or_else(GitError::not_repo)?;
    let lock = service.mutation_lock(&repo.common_dir).await;
    let _guard = lock.lock().await;

    let capability = inspect_push_capability(service, &repo, signal).await?;
    if !capability.allowed || capability.branch.is_none() || capability.expected_head.is_none() {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            capability
                .reason
                .clone()
                .unwrap_or_else(|| "This branch cannot be pushed from Aiden.".to_string()),
        ));
    }
    if capability.branch.as_deref() != Some(input.expected_branch.as_str()) {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            "The current branch changed after this push was reviewed. Refresh before pushing.",
        ));
    }
    if capability.expected_head.as_deref() != Some(input.expected_head.as_str()) {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            "The branch moved after this push was reviewed. Refresh before pushing.",
        ));
    }
    if !capability
        .remotes
        .iter()
        .any(|remote| remote == &input.remote)
    {
        return Err(GitError::new(
            GitErrorCode::InvalidInput,
            format!("Remote “{}” is no longer configured.", input.remote),
        ));
    }
    if capability.remote_identities.get(&input.remote) != Some(&input.expected_remote_identity) {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            format!(
                "Remote “{}” changed after this push was reviewed. Refresh before pushing.",
                input.remote
            ),
        ));
    }
    let frozen_transport = push_transport(service, &repo, &input.remote, signal).await?;
    let Some(frozen_transport) = frozen_transport else {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            format!(
                "Remote “{}” changed while Aiden prepared the push. Refresh before pushing.",
                input.remote
            ),
        ));
    };
    if push_transport_identity(&frozen_transport) != input.expected_remote_identity {
        return Err(GitError::new(
            GitErrorCode::StaleSnapshot,
            format!(
                "Remote “{}” changed while Aiden prepared the push. Refresh before pushing.",
                input.remote
            ),
        ));
    }

    let destination_ref = format!("refs/heads/{}", input.destination_branch);
    let valid_destination = service
        .run(
            &repo.cwd,
            &["check-ref-format", &destination_ref],
            RunOptions {
                allow_exit_codes: &[1],
                signal,
                ..RunOptions::default()
            },
        )
        .await?;
    if valid_destination.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Enter a valid destination branch.",
        ));
    }
    let tracking_snapshot = snapshot_pushed_tracking_ref(
        service,
        &repo,
        &input.remote,
        &input.destination_branch,
        signal,
    )
    .await?;

    let mut warning: Option<String> = None;
    // Freeze the endpoint: push to the reviewed remote directly with no force.
    let mut push_args: Vec<String> = vec![
        "push".to_string(),
        "--porcelain".to_string(),
        "--no-mirror".to_string(),
        "--no-prune".to_string(),
        "--no-follow-tags".to_string(),
        "--no-recurse-submodules".to_string(),
    ];
    match &input.force_with_lease {
        Some(remote_oid) => {
            push_args.push(format!("--force-with-lease={destination_ref}:{remote_oid}"));
        }
        None => push_args.push("--no-force".to_string()),
    }
    push_args.push("--".to_string());
    push_args.push(input.remote.clone());
    push_args.push(format!("{}:{}", input.expected_head, destination_ref));
    let push_args: Vec<&str> = push_args.iter().map(String::as_str).collect();
    let push_timeout = service.timeouts().2;
    let push_result = service
        .run(
            &repo.cwd,
            &push_args,
            RunOptions {
                mutation: true,
                signal,
                timeout: Some(push_timeout),
                ..RunOptions::default()
            },
        )
        .await;
    if let Err(error) = &push_result {
        if !error.is_indeterminate() {
            return Err(error.clone());
        }
        warning = Some(match error.code {
            GitErrorCode::OutputLimit => {
                "The push completed, but Git produced more output than Aiden could retain."
                    .to_string()
            }
            _ => {
                "The push completed, but Git stopped responding before Aiden received confirmation."
                    .to_string()
            }
        });
    }

    let mut tracking_recorded = false;
    let remote_still_matches = match push_transport(service, &repo, &input.remote, None).await? {
        Some(transport) => push_transport_identity(&transport) == input.expected_remote_identity,
        None => false,
    };
    if remote_still_matches {
        if let Some(reference) = &tracking_snapshot {
            tracking_recorded =
                record_pushed_tracking_ref(service, &repo, reference, &input.expected_head).await;
        }
    }
    if !tracking_recorded {
        let message = if remote_still_matches {
            "The push completed, but Aiden could not safely update its local tracking ref."
        } else {
            "The push completed, but the remote configuration changed before Aiden could update its local tracking ref."
        };
        warning = push_warning(warning, message);
    }

    let mut upstream_set = capability.upstream.as_deref()
        == Some(format!("{}/{}", input.remote, input.destination_branch).as_str());
    if input.set_upstream && !upstream_set {
        let head_after = service
            .run(
                &repo.cwd,
                &head_args(),
                RunOptions {
                    allow_exit_codes: &[128],
                    ..RunOptions::default()
                },
            )
            .await?;
        let symbolic_after = service
            .run(
                &repo.cwd,
                &symbolic_args(),
                RunOptions {
                    allow_exit_codes: &[1],
                    ..RunOptions::default()
                },
            )
            .await?;
        let head_matches = head_after.exit_code == 0
            && head_after.stdout.trim() == input.expected_head
            && symbolic_after.exit_code == 0
            && symbolic_after.stdout.trim() == format!("refs/heads/{}", input.expected_branch);
        if !remote_still_matches {
            warning = push_warning(
                warning,
                "The push completed, but the remote configuration changed before Aiden could remember its upstream.",
            );
        } else if !head_matches {
            warning = push_warning(
                warning,
                "The push completed, but the local branch moved before Aiden could remember its upstream.",
            );
        } else if !tracking_recorded {
            warning = push_warning(
                warning,
                "The push completed, but Aiden could not safely update its local tracking ref or upstream setting.",
            );
        } else {
            let upstream_args = format!(
                "--set-upstream-to={}/{}",
                input.remote, input.destination_branch
            );
            let branch_args = ["branch", &upstream_args, "--", &input.expected_branch];
            match service
                .run(
                    &repo.cwd,
                    &branch_args,
                    RunOptions {
                        mutation: true,
                        signal,
                        ..RunOptions::default()
                    },
                )
                .await
            {
                Ok(_) => upstream_set = true,
                Err(error) => {
                    warning = push_warning(
                        warning,
                        &format!(
                            "The push completed, but Aiden could not remember its upstream: {}",
                            error.message
                        ),
                    );
                }
            }
        }
    }

    service.invalidate();
    Ok(GitPushResult {
        branch: input.expected_branch.clone(),
        commit: input.expected_head.clone(),
        destination_branch: input.destination_branch.clone(),
        remote: input.remote.clone(),
        upstream_set,
        warning,
    })
}

/// Helper kept for parity with the TS upstream detection: whether the current
/// branch already tracks `<remote>/<destinationBranch>`.
pub fn upstream_matches(
    capability: &GitPushCapability,
    remote: &str,
    destination_branch: &str,
) -> bool {
    capability.upstream.as_deref() == Some(format!("{remote}/{destination_branch}").as_str())
}

/// Append a warning, matching git.ts's `.filter(Boolean).join(" ")`.
fn push_warning(existing: Option<String>, message: &str) -> Option<String> {
    match existing {
        Some(current) => Some(format!("{current} {message}")),
        None => Some(message.to_string()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::review;
    use crate::types::GitCommitInput;
    use crate::GitServiceOptions;

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
    async fn pushes_a_reviewed_head_with_upstream_detection() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let remote = dir.path().join("remote.git");
        std::fs::create_dir(&remote).unwrap();
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

        let capability = push_capability(&service, &repository, None).await?;
        assert!(capability.allowed, "{:?}", capability.reason);
        assert_eq!(capability.suggested_remote.as_deref(), Some("origin"));
        assert_eq!(capability.destination_branch.as_deref(), Some("main"));
        let identity = capability.remote_identities.get("origin").cloned().unwrap();

        let result = push(
            &service,
            &repository,
            GitPushInput {
                destination_branch: "main".to_string(),
                expected_branch: capability.branch.clone().unwrap(),
                expected_head: capability.expected_head.clone().unwrap(),
                expected_remote_identity: identity.clone(),
                remote: "origin".to_string(),
                set_upstream: true,
                force_with_lease: None,
            },
            None,
        )
        .await?;
        assert!(result.upstream_set);
        let remote_head = service
            .run(
                &remote,
                &["rev-parse", "refs/heads/main"],
                RunOptions::default(),
            )
            .await?;
        assert_eq!(remote_head.stdout.trim(), capability.expected_head.unwrap());

        // After a second commit, push again and confirm ahead/behind reset.
        std::fs::write(repository.join("second.txt"), "second\n").unwrap();
        let review = review(&service, &repository, None).await?;
        let next = crate::commit::commit(
            &service,
            &repository,
            GitCommitInput {
                expected_snapshot: review.commit.snapshot.clone().unwrap(),
                message: "Second".to_string(),
                mode: crate::types::GitCommitMode::All,
            },
            None,
        )
        .await?;
        let head_after = service
            .run(&repository, &["rev-parse", "HEAD"], RunOptions::default())
            .await?
            .stdout
            .trim()
            .to_string();
        assert_eq!(next.commit, head_after);
        let capability = push_capability(&service, &repository, None).await?;
        assert_eq!(capability.ahead, 1);
        let identity = capability.remote_identities.get("origin").cloned().unwrap();
        let result = push(
            &service,
            &repository,
            GitPushInput {
                destination_branch: "main".to_string(),
                expected_branch: capability.branch.clone().unwrap(),
                expected_head: capability.expected_head.clone().unwrap(),
                expected_remote_identity: identity.clone(),
                remote: "origin".to_string(),
                set_upstream: false,
                force_with_lease: None,
            },
            None,
        )
        .await?;
        assert!(result.warning.is_none());
        let refreshed = push_capability(&service, &repository, None).await?;
        assert_eq!(refreshed.ahead, 0);
        assert_eq!(refreshed.behind, 0);
        Ok(())
    }

    #[tokio::test]
    async fn refuses_stale_and_unknown_remote_pushes() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let service = service();
        let err = push(
            &service,
            &repository,
            GitPushInput {
                destination_branch: "main".to_string(),
                expected_branch: "main".to_string(),
                expected_head: "0".repeat(40),
                expected_remote_identity: "0".repeat(64),
                remote: "origin".to_string(),
                set_upstream: false,
                force_with_lease: None,
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, GitErrorCode::CommandFailed); // no remotes configured

        let remote = dir.path().join("remote.git");
        std::fs::create_dir(&remote).unwrap();
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
        let capability = push_capability(&service, &repository, None).await?;
        // A stale expectedHead is refused.
        let err = push(
            &service,
            &repository,
            GitPushInput {
                destination_branch: "main".to_string(),
                expected_branch: capability.branch.clone().unwrap(),
                expected_head: "0".repeat(40),
                expected_remote_identity: capability
                    .remote_identities
                    .get("origin")
                    .cloned()
                    .unwrap(),
                remote: "origin".to_string(),
                set_upstream: false,
                force_with_lease: None,
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, GitErrorCode::StaleSnapshot);
        Ok(())
    }

    #[tokio::test]
    async fn push_capability_explains_blocked_states() -> Result<(), GitError> {
        let dir = tempfile::tempdir().unwrap();
        let repository = create_repository(dir.path()).await?;
        let service = service();
        let no_remote = push_capability(&service, &repository, None).await?;
        assert!(!no_remote.allowed);
        assert!(no_remote
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("Add a Git remote"));

        // Detached HEAD is blocked.
        service
            .run(
                &repository,
                &["switch", "--detach"],
                RunOptions {
                    mutation: true,
                    ..RunOptions::default()
                },
            )
            .await?;
        let detached = push_capability(&service, &repository, None).await?;
        assert!(!detached.allowed);
        assert!(detached
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("local branch"));
        Ok(())
    }
}
