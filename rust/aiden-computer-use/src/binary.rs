//! cua-driver installation resolution and code-signing verification (port of
//! `main/services/computer-use/binary.ts`).
//!
//! macOS-only. Security pins are compiled into Aiden: the driver sha-256 and
//! the upstream signing identity. The packaged artifact JSON is release
//! provenance for humans/build tooling, never runtime security authority.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::contract::{
    build_cua_driver_environment, CuaDriverError, CuaDriverInvocation, CUA_DRIVER_BROKER_BUNDLE_ID,
    CUA_DRIVER_BROKER_EXECUTABLE, CUA_DRIVER_HOST_BUNDLE_ID, CUA_DRIVER_VERSION,
};
use crate::process::{run_command, BoundedProcessResult, CuaDriverCommandInvocation};

const CUA_DRIVER_BINARY_SHA256: &str =
    "c1c015ccceda4880b9e171dc438700a8276af0eeecfdf0bb4b3fb23298ae7305";
const CUA_DRIVER_UPSTREAM_SIGNING_IDENTIFIER: &str = "cua-driver";
const CUA_DRIVER_UPSTREAM_SIGNING_TEAM_ID: &str = "YCK386LBJ7";

/// Where Aiden resolves the broker helper bundle.
#[derive(Debug, Clone)]
pub struct CuaDriverPathOptions {
    pub app_path: PathBuf,
    pub is_packaged: bool,
    pub platform: String,
    pub resources_path: PathBuf,
}

/// The resolved installation: the broker app bundle plus the bridge invocation.
#[derive(Debug, Clone)]
pub struct CuaDriverInstallation {
    pub broker_app_path: PathBuf,
    pub invocation: CuaDriverInvocation,
}

#[derive(Debug, Clone, Default)]
struct CodeSigningDescription {
    executable: Option<String>,
    identifier: Option<String>,
    team_identifier: Option<String>,
}

fn throw_if_aborted(signal: Option<&CancellationToken>) -> Result<(), CuaDriverError> {
    if signal.is_some_and(|token| token.is_cancelled()) {
        return Err(CuaDriverError::cancelled(
            "Computer Use verification was cancelled.",
        ));
    }
    Ok(())
}

fn preserve_cancellation(error: CuaDriverError) -> Result<BoundedProcessResult, CuaDriverError> {
    if error.code == "cancelled" {
        return Err(error);
    }
    Err(CuaDriverError::new(
        "identity_verification_failed",
        "A code signature is unavailable.",
    ))
}

async fn hash_file(
    path: &Path,
    signal: Option<&CancellationToken>,
) -> Result<String, CuaDriverError> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.map_err(|_| {
        CuaDriverError::new("driver_missing", "The cua-driver helper is unavailable.")
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        throw_if_aborted(signal)?;
        match file.read(&mut buffer).await {
            Ok(0) => break,
            Ok(count) => {
                hasher.update(&buffer[..count]);
            }
            Err(_) => {
                return Err(CuaDriverError::new(
                    "driver_integrity_failed",
                    "The cua-driver executable could not be read.",
                ))
            }
        }
    }
    throw_if_aborted(signal)?;
    Ok(format!("{:x}", hasher.finalize()))
}

async fn verify_regular_executable(
    candidate: &Path,
    message: &str,
    signal: Option<&CancellationToken>,
) -> Result<(), CuaDriverError> {
    throw_if_aborted(signal)?;
    let metadata = tokio::fs::symlink_metadata(candidate).await;
    match metadata {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(CuaDriverError::new("driver_missing", message));
            }
            throw_if_aborted(signal)?;
            tokio::fs::metadata(candidate)
                .await
                .map_err(|_| CuaDriverError::new("driver_missing", message))?;
            Ok(())
        }
        Err(_) => {
            throw_if_aborted(signal)?;
            Err(CuaDriverError::new("driver_missing", message))
        }
    }
}

fn signing_requirement(identifier: &str, team_identifier: &str) -> String {
    format!(
        "anchor apple generic and identifier \"{identifier}\" and certificate leaf[subject.OU] = \"{team_identifier}\""
    )
}

fn parse_code_signing_description(output: &str) -> CodeSigningDescription {
    let mut result = CodeSigningDescription::default();
    for line in output.lines() {
        if let Some(value) = line.strip_prefix("Executable=") {
            result.executable = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("Identifier=") {
            result.identifier = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("TeamIdentifier=") {
            if value != "not set" {
                result.team_identifier = Some(value.to_string());
            }
        }
    }
    result
}

async fn describe_code(
    target: &str,
    signal: Option<&CancellationToken>,
) -> Result<CodeSigningDescription, CuaDriverError> {
    let environment = build_cua_driver_environment(&HashMap::new(), CUA_DRIVER_HOST_BUNDLE_ID);
    let invocation = CuaDriverCommandInvocation::new("/usr/bin/codesign");
    let result = run_command(
        &invocation,
        &["--display".into(), "--verbose=4".into(), target.into()],
        &environment,
        signal,
        6_000,
    )
    .await
    .or_else(preserve_cancellation)?;
    Ok(parse_code_signing_description(&format!(
        "{}\n{}",
        result.stdout, result.stderr
    )))
}

/// Build `codesign --verify` argv. macOS 27 rejects `--strict`/`--verbose` and
/// explicit requirements for live process disk representations (targets like
/// `+<pid>`); callers separately compare the displayed identity before
/// requesting dynamic validity.
pub fn codesign_verify_arguments(target: &str, requirement: Option<&str>) -> Vec<String> {
    if target.starts_with('+') && target[1..].chars().all(|c| c.is_ascii_digit()) {
        return vec!["--verify".into(), target.into()];
    }
    let mut args = vec!["--verify".into(), "--strict".into(), "--verbose=2".into()];
    if let Some(requirement) = requirement {
        args.push(format!("-R={requirement}"));
    }
    args.push(target.into());
    args
}

async fn verify_code(
    target: &str,
    requirement: Option<&str>,
    signal: Option<&CancellationToken>,
) -> Result<(), CuaDriverError> {
    let environment = build_cua_driver_environment(&HashMap::new(), CUA_DRIVER_HOST_BUNDLE_ID);
    let invocation = CuaDriverCommandInvocation::new("/usr/bin/codesign");
    run_command(
        &invocation,
        &codesign_verify_arguments(target, requirement),
        &environment,
        signal,
        6_000,
    )
    .await
    .map(|_| ())
}

async fn current_aiden_signing_team(
    signal: Option<&CancellationToken>,
) -> Result<String, CuaDriverError> {
    let target = format!("+{}", std::process::id());
    let description = describe_code(&target, signal).await?;
    if description.identifier.as_deref() != Some(CUA_DRIVER_HOST_BUNDLE_ID)
        || description.team_identifier.as_ref().is_none_or(|value| {
            !(value.len() == 10
                && value
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
        })
    {
        return Err(CuaDriverError::new(
            "host_identity_invalid",
            "Computer Use requires a signed packaged build of Aiden.",
        ));
    }
    verify_code(&target, None, signal).await.map_err(|error| {
        if error.code == "cancelled" {
            error
        } else {
            CuaDriverError::new(
                "host_identity_invalid",
                "Aiden's running code signature could not be verified.",
            )
        }
    })?;
    Ok(description.team_identifier.expect("checked"))
}

/// Verify the exact, already-spawned bridge process before accepting readiness.
pub async fn verify_cua_driver_bridge_process(
    pid: u32,
    expected_executable: &Path,
    signal: Option<&CancellationToken>,
) -> Result<(), CuaDriverError> {
    throw_if_aborted(signal)?;
    if pid <= 1 {
        return Err(CuaDriverError::new(
            "bridge_identity_invalid",
            "Computer Use started an invalid bridge.",
        ));
    }
    let expected_path = tokio::fs::canonicalize(expected_executable)
        .await
        .map_err(|_| {
            CuaDriverError::new(
                "bridge_identity_invalid",
                "The Computer Use bridge disappeared.",
            )
        })?;
    throw_if_aborted(signal)?;
    let team_identifier = current_aiden_signing_team(signal).await?;
    let target = format!("+{pid}");
    let description = describe_code(&target, signal).await?;
    let actual_path = match description.executable {
        Some(executable) => tokio::fs::canonicalize(&executable)
            .await
            .unwrap_or_default(),
        None => PathBuf::new(),
    };
    throw_if_aborted(signal)?;
    if actual_path != expected_path
        || description.identifier.as_deref() != Some(CUA_DRIVER_BROKER_BUNDLE_ID)
        || description.team_identifier.as_deref() != Some(team_identifier.as_str())
    {
        return Err(CuaDriverError::new(
            "bridge_identity_invalid",
            "The running Computer Use bridge did not match Aiden's signed helper.",
        ));
    }
    verify_code(&target, None, signal).await.map_err(|error| {
        if error.code == "cancelled" {
            error
        } else {
            CuaDriverError::new(
                "bridge_identity_invalid",
                "The running Computer Use bridge signature could not be verified.",
            )
        }
    })
}

/// Resolve and verify the pinned broker app + cua-driver installation.
pub async fn resolve_cua_driver_installation(
    options: &CuaDriverPathOptions,
    signal: Option<&CancellationToken>,
) -> Result<CuaDriverInstallation, CuaDriverError> {
    throw_if_aborted(signal)?;
    if options.platform != "darwin" {
        return Err(CuaDriverError::new(
            "unsupported_platform",
            "Aiden Computer Use currently supports macOS only.",
        ));
    }
    let broker_app_path = if options.is_packaged {
        options
            .resources_path
            .join("..")
            .join("Helpers")
            .join("CuaDriver.app")
    } else {
        options
            .app_path
            .join("build")
            .join("computer-use")
            .join("CuaDriver.app")
    };
    let executable_directory = broker_app_path.join("Contents").join("MacOS");
    let driver_path = executable_directory.join("cua-driver");
    let broker_path = executable_directory.join(CUA_DRIVER_BROKER_EXECUTABLE);
    let info_plist_path = broker_app_path.join("Contents").join("Info.plist");

    let app_info = tokio::fs::symlink_metadata(&broker_app_path).await;
    match app_info {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(CuaDriverError::new(
                    "driver_missing",
                    if options.is_packaged {
                        "The packaged Aiden Computer Use helper is missing or invalid."
                    } else {
                        "The pinned Computer Use helper has not been built. Run npm run computer-use:vendor."
                    },
                ));
            }
        }
        Err(_) => {
            throw_if_aborted(signal)?;
            return Err(CuaDriverError::new(
                "driver_missing",
                if options.is_packaged {
                    "The packaged Aiden Computer Use helper is missing or invalid."
                } else {
                    "The pinned Computer Use helper has not been built. Run npm run computer-use:vendor."
                },
            ));
        }
    }
    verify_regular_executable(
        &broker_path,
        "The Aiden Computer Use broker executable is missing or invalid.",
        signal,
    )
    .await?;
    verify_regular_executable(
        &driver_path,
        "The pinned cua-driver executable is missing or invalid.",
        signal,
    )
    .await?;

    let resolved_app = tokio::fs::canonicalize(&broker_app_path)
        .await
        .map_err(|_| {
            CuaDriverError::new(
                "invalid_driver_path",
                "The Computer Use helper bundle is invalid.",
            )
        })?;
    let resolved_driver = tokio::fs::canonicalize(&driver_path).await.map_err(|_| {
        CuaDriverError::new(
            "invalid_driver_path",
            "The Computer Use helper bundle is invalid.",
        )
    })?;
    let resolved_broker = tokio::fs::canonicalize(&broker_path).await.map_err(|_| {
        CuaDriverError::new(
            "invalid_driver_path",
            "The Computer Use helper bundle is invalid.",
        )
    })?;
    throw_if_aborted(signal)?;
    let contents = format!(
        "{}Contents{}MacOS{}",
        resolved_app.display(),
        std::path::MAIN_SEPARATOR,
        std::path::MAIN_SEPARATOR
    );
    for executable in [&resolved_driver, &resolved_broker] {
        if !executable.to_string_lossy().starts_with(&contents) {
            return Err(CuaDriverError::new(
                "invalid_driver_path",
                "The Computer Use executable escaped its signed helper bundle.",
            ));
        }
    }

    // Bundle identity must match the broker bundle id.
    let environment = build_cua_driver_environment(&HashMap::new(), CUA_DRIVER_HOST_BUNDLE_ID);
    let invocation = CuaDriverCommandInvocation::new("/usr/bin/plutil");
    let plist = run_command(
        &invocation,
        &[
            "-extract".into(),
            "CFBundleIdentifier".into(),
            "raw".into(),
            "-o".into(),
            "-".into(),
            info_plist_path.to_string_lossy().into_owned(),
        ],
        &environment,
        signal,
        6_000,
    )
    .await
    .map_err(|error| {
        if error.code == "cancelled" {
            error
        } else {
            CuaDriverError::new(
                "driver_integrity_failed",
                "The helper bundle metadata is invalid.",
            )
        }
    })?;
    if plist.stdout.trim() != CUA_DRIVER_BROKER_BUNDLE_ID {
        return Err(CuaDriverError::new(
            "driver_integrity_failed",
            "The Computer Use helper has an unexpected bundle identity.",
        ));
    }

    if hash_file(&resolved_driver, signal).await? != CUA_DRIVER_BINARY_SHA256 {
        return Err(CuaDriverError::new(
            "driver_integrity_failed",
            format!(
                "The cua-driver executable does not match Aiden's pinned {CUA_DRIVER_VERSION} release."
            ),
        ));
    }
    let resolved_driver_string = resolved_driver.to_string_lossy().into_owned();
    verify_code(
        &resolved_driver_string,
        Some(&signing_requirement(
            CUA_DRIVER_UPSTREAM_SIGNING_IDENTIFIER,
            CUA_DRIVER_UPSTREAM_SIGNING_TEAM_ID,
        )),
        signal,
    )
    .await
    .map_err(|error| {
        if error.code == "cancelled" {
            error
        } else {
            CuaDriverError::new(
                "driver_integrity_failed",
                "The cua-driver executable failed its pinned signing requirement.",
            )
        }
    })?;

    if options.is_packaged {
        let team_identifier = current_aiden_signing_team(signal).await?;
        let helper_requirement = signing_requirement(CUA_DRIVER_BROKER_BUNDLE_ID, &team_identifier);
        let app = resolved_app.to_string_lossy().into_owned();
        let broker = resolved_broker.to_string_lossy().into_owned();
        let app_verify = verify_code(&app, Some(&helper_requirement), signal);
        let broker_verify = verify_code(&broker, Some(&helper_requirement), signal);
        let (first, second) = tokio::join!(app_verify, broker_verify);
        if first.is_err() || second.is_err() {
            throw_if_aborted(signal)?;
            return Err(CuaDriverError::new(
                "driver_integrity_failed",
                "The Aiden Computer Use helper did not match Aiden's signing identity.",
            ));
        }
    } else {
        let app = resolved_app.to_string_lossy().into_owned();
        let broker = resolved_broker.to_string_lossy().into_owned();
        let app_verify = verify_code(&app, None, signal);
        let broker_verify = verify_code(&broker, None, signal);
        let (first, second) = tokio::join!(app_verify, broker_verify);
        if first.is_err() || second.is_err() {
            throw_if_aborted(signal)?;
            return Err(CuaDriverError::new(
                "driver_integrity_failed",
                "The Aiden Computer Use helper signature is invalid.",
            ));
        }
    }

    Ok(CuaDriverInstallation {
        broker_app_path: resolved_app,
        invocation: CuaDriverInvocation::new(resolved_broker),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codesign_verify_arguments_skip_strict_for_live_process_targets() {
        assert_eq!(
            codesign_verify_arguments("+4242", None),
            vec!["--verify".to_string(), "+4242".to_string()]
        );
        assert_eq!(
            codesign_verify_arguments("/Applications/Aiden.app", Some("anchor apple generic"),),
            vec![
                "--verify".to_string(),
                "--strict".to_string(),
                "--verbose=2".to_string(),
                "-R=anchor apple generic".to_string(),
                "/Applications/Aiden.app".to_string(),
            ]
        );
    }

    #[test]
    fn parses_codesign_descriptions() {
        let description = parse_code_signing_description(
            "Executable=/a/b\nIdentifier=com.example.app\nTeamIdentifier=YCK386LBJ7\n",
        );
        assert_eq!(description.executable.as_deref(), Some("/a/b"));
        assert_eq!(description.identifier.as_deref(), Some("com.example.app"));
        assert_eq!(description.team_identifier.as_deref(), Some("YCK386LBJ7"));
        let unset = parse_code_signing_description("TeamIdentifier=not set\n");
        assert_eq!(unset.team_identifier, None);
    }

    #[test]
    fn signing_requirement_is_the_exact_reviewed_string() {
        assert_eq!(
            signing_requirement("cua-driver", "YCK386LBJ7"),
            "anchor apple generic and identifier \"cua-driver\" and certificate leaf[subject.OU] = \"YCK386LBJ7\""
        );
    }
}
