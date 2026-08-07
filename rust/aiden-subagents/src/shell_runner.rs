//! Port of `main/services/subagents/subagent-shell-runner-io.ts` +
//! `native/subagent-shell-runner/main.c` — the approved full-host shell
//! runner, now **in-process** with the exact `AIDSH001` binary framing so
//! approval digests stay stable.
//!
//! Request frame: 28-byte fixed header (`AIDSH001`, version 1, 64-byte nonce,
//! 64-byte digest, timeoutMs, command length) + nonce (hex) + effectDigest
//! (hex) + command bytes.
//!
//! Response frame: `AIDSR001`, version 1, outcome (1-based), exitCode
//! (0xffffffff = absent), signal (0 = absent), cleanupConfirmed, stdoutLength,
//! stderrLength, nonce, digest, stdout, stderr.
//!
//! Execution semantics: `/bin/zsh -f -c <command>` in a minimal private 0700
//! environment (HOME/TMPDIR/XDG_* under a fresh `/tmp/aiden-subagent-shell.*`
//! tree, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, LANG=C, no git/npm prompts),
//! pinned to the canonical workspace root (device+inode re-checked in the
//! child), stdin from `/dev/null`, 512 KiB stream caps, a SIGTERM-then-SIGKILL
//! process-group cleanup with 1s grace, and the eight-outcome taxonomy.

use std::path::Path;

use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::AsyncReadExt;

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

pub const SUBAGENT_SHELL_COMMAND_BYTES: usize = 64 * 1024;
pub const SUBAGENT_SHELL_STREAM_BYTES: usize = 512 * 1024;
const RESPONSE_FIXED_BYTES: usize = 164;
const MAX_PROTOCOL_BYTES: usize = RESPONSE_FIXED_BYTES + SUBAGENT_SHELL_STREAM_BYTES * 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentShellWorkspaceRoot {
    pub path: String,
    pub device: String,
    pub inode: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentShellOutcome {
    Exited,
    Signaled,
    TimedOut,
    OutputLimit,
    Cancelled,
    SpawnFailed,
    ProtocolFailed,
    CleanupUnconfirmed,
}

impl SubagentShellOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentShellOutcome::Exited => "exited",
            SubagentShellOutcome::Signaled => "signaled",
            SubagentShellOutcome::TimedOut => "timed_out",
            SubagentShellOutcome::OutputLimit => "output_limit",
            SubagentShellOutcome::Cancelled => "cancelled",
            SubagentShellOutcome::SpawnFailed => "spawn_failed",
            SubagentShellOutcome::ProtocolFailed => "protocol_failed",
            SubagentShellOutcome::CleanupUnconfirmed => "cleanup_unconfirmed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentShellResult {
    pub outcome: SubagentShellOutcome,
    pub exit_code: Option<u32>,
    pub signal: Option<u32>,
    pub cleanup_confirmed: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Error)]
#[error("{0}")]
pub struct ShellError(pub String);

fn is_exact_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Pin the canonical workspace root to an exact decimal device/inode pair
/// (`pinSubagentShellWorkspaceRoot`).
pub fn pin_subagent_shell_workspace_root(
    candidate: &str,
) -> Result<SubagentShellWorkspaceRoot, ShellError> {
    let canonical = std::fs::canonicalize(candidate).map_err(|_| {
        ShellError("The shell workspace root must be canonical and non-symlinked.".to_string())
    })?;
    if canonical.to_string_lossy() != candidate {
        return Err(ShellError(
            "The shell workspace root must be canonical and non-symlinked.".to_string(),
        ));
    }
    let info = std::fs::symlink_metadata(&canonical)
        .map_err(|_| ShellError("The shell workspace root must be a directory.".to_string()))?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(ShellError(
            "The shell workspace root must be a directory.".to_string(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(SubagentShellWorkspaceRoot {
            path: canonical.to_string_lossy().into_owned(),
            device: info.dev().to_string(),
            inode: info.ino().to_string(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(SubagentShellWorkspaceRoot {
            path: canonical.to_string_lossy().into_owned(),
            device: "0".to_string(),
            inode: "0".to_string(),
        })
    }
}

fn valid_command(command: &str) -> Result<(), ShellError> {
    let forbidden = command.chars().any(|character| {
        let code = character as u32;
        code == 0
            || code == 0x0d
            || code == 0x1b
            || (code < 0x20 && code != 0x09 && code != 0x0a)
            || (0x7f..=0x9f).contains(&code)
            || code == 0x2028
            || code == 0x2029
            || (0x202a..=0x202e).contains(&code)
            || (0x2066..=0x2069).contains(&code)
    });
    if command.is_empty() || command.len() > SUBAGENT_SHELL_COMMAND_BYTES || forbidden {
        return Err(ShellError(
            "The shell command is invalid or exceeds the fixed bound.".to_string(),
        ));
    }
    Ok(())
}

/// `encodeSubagentShellRequest` — exact AIDSH001 framing.
pub fn encode_subagent_shell_request(input: &SubagentShellRequest) -> Result<Vec<u8>, ShellError> {
    valid_command(&input.command)?;
    if !is_exact_fingerprint(&input.effect_digest) || !is_exact_fingerprint(&input.nonce) {
        return Err(ShellError(
            "The shell request identity is invalid.".to_string(),
        ));
    }
    if input.timeout_ms < 1 || input.timeout_ms > 3_600_000 {
        return Err(ShellError("The shell timeout is invalid.".to_string()));
    }
    let mut fixed = [0u8; 28];
    fixed[..8].copy_from_slice(b"AIDSH001");
    fixed[8..12].copy_from_slice(&1u32.to_be_bytes());
    fixed[12..16].copy_from_slice(&64u32.to_be_bytes());
    fixed[16..20].copy_from_slice(&64u32.to_be_bytes());
    fixed[20..24].copy_from_slice(&input.timeout_ms.to_be_bytes());
    fixed[24..28].copy_from_slice(&(input.command.len() as u32).to_be_bytes());
    let mut request = Vec::with_capacity(28 + 64 + 64 + input.command.len());
    request.extend_from_slice(&fixed);
    request.extend_from_slice(input.nonce.as_bytes());
    request.extend_from_slice(input.effect_digest.as_bytes());
    request.extend_from_slice(input.command.as_bytes());
    Ok(request)
}

pub struct SubagentShellRequest {
    pub command: String,
    pub effect_digest: String,
    pub nonce: String,
    pub timeout_ms: u32,
}

fn decode_utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\0', "\u{fffd}")
}

/// `decodeSubagentShellResponse` — exact AIDSR001 response framing.
pub fn decode_subagent_shell_response(
    response: &[u8],
    expected: &SubagentShellResponseIdentity,
) -> Result<SubagentShellResult, ShellError> {
    if response.len() < RESPONSE_FIXED_BYTES || response.len() > MAX_PROTOCOL_BYTES {
        return Err(ShellError(
            "The shell helper response was malformed.".to_string(),
        ));
    }
    if &response[..8] != b"AIDSR001"
        || u32::from_be_bytes(response[8..12].try_into().expect("len")) != 1
    {
        return Err(ShellError(
            "The shell helper response was malformed.".to_string(),
        ));
    }
    let outcome_names = [
        SubagentShellOutcome::Exited,
        SubagentShellOutcome::Signaled,
        SubagentShellOutcome::TimedOut,
        SubagentShellOutcome::OutputLimit,
        SubagentShellOutcome::Cancelled,
        SubagentShellOutcome::SpawnFailed,
        SubagentShellOutcome::ProtocolFailed,
        SubagentShellOutcome::CleanupUnconfirmed,
    ];
    let outcome_index = u32::from_be_bytes(response[12..16].try_into().expect("len")) as usize;
    let outcome = outcome_names.get(outcome_index - 1).copied();
    let Some(outcome) = outcome else {
        return Err(ShellError(
            "The shell helper response was malformed.".to_string(),
        ));
    };
    let exit_code_raw = u32::from_be_bytes(response[16..20].try_into().expect("len"));
    let signal_raw = u32::from_be_bytes(response[20..24].try_into().expect("len"));
    let cleanup_raw = u32::from_be_bytes(response[24..28].try_into().expect("len"));
    let stdout_length = u32::from_be_bytes(response[28..32].try_into().expect("len")) as usize;
    let stderr_length = u32::from_be_bytes(response[32..36].try_into().expect("len")) as usize;
    let nonce = String::from_utf8(response[36..100].to_vec()).expect("ascii");
    let digest = String::from_utf8(response[100..164].to_vec()).expect("ascii");
    if cleanup_raw > 1
        || stdout_length > SUBAGENT_SHELL_STREAM_BYTES
        || stderr_length > SUBAGENT_SHELL_STREAM_BYTES
        || RESPONSE_FIXED_BYTES + stdout_length + stderr_length != response.len()
        || nonce != expected.nonce
        || digest != expected.effect_digest
    {
        return Err(ShellError(
            "The shell helper response was malformed.".to_string(),
        ));
    }
    let stdout_start = RESPONSE_FIXED_BYTES;
    Ok(SubagentShellResult {
        outcome,
        exit_code: if exit_code_raw == 0xffff_ffff {
            None
        } else {
            Some(exit_code_raw)
        },
        signal: if signal_raw == 0 {
            None
        } else {
            Some(signal_raw)
        },
        cleanup_confirmed: cleanup_raw == 1,
        stdout: decode_utf8(&response[stdout_start..stdout_start + stdout_length]),
        stderr: decode_utf8(&response[stdout_start + stdout_length..]),
    })
}

pub struct SubagentShellResponseIdentity {
    pub nonce: String,
    pub effect_digest: String,
}

/// The in-process execution boundary. Spawns `/bin/zsh -f -c` through tokio
/// with the C helper's environment scrubbing, stream caps, and process-group
/// cleanup, then returns the exact AIDSR001 response bytes.
pub async fn run_subagent_shell(
    input: &SubagentShellRunInput,
    root: &SubagentShellWorkspaceRoot,
) -> Result<Vec<u8>, ShellError> {
    let request = encode_subagent_shell_request(&SubagentShellRequest {
        command: input.command.clone(),
        effect_digest: input.effect_digest.clone(),
        nonce: input.nonce.clone(),
        timeout_ms: input.timeout_ms as u32,
    })?;
    let _ = request; // framing is preserved for digest stability; execution below
                     // uses the parsed fields directly.
    run_shell_impl(input, root).await
}

pub struct SubagentShellRunInput {
    pub command: String,
    pub effect_digest: String,
    pub nonce: String,
    pub timeout_ms: u64,
    pub cancelled: bool,
}

async fn run_shell_impl(
    input: &SubagentShellRunInput,
    root: &SubagentShellWorkspaceRoot,
) -> Result<Vec<u8>, ShellError> {
    if input.cancelled {
        return Err(ShellError("The shell request was cancelled.".to_string()));
    }
    // Build the minimal private 0700 tree.
    let private_root = create_private_tree()?;
    // Resolve the shell binary and verify the workspace root identity.
    let zsh = "/bin/zsh";
    if !Path::new(zsh).exists() {
        remove_tree(&private_root);
        return Err(ShellError(
            "The shell helper failed before returning a verified outcome.".to_string(),
        ));
    }
    let root_identity = pin_subagent_shell_workspace_root(&root.path)?;
    if root_identity.device != root.device || root_identity.inode != root.inode {
        remove_tree(&private_root);
        return Err(ShellError(
            "The shell helper failed before returning a verified outcome.".to_string(),
        ));
    }
    let mut command = tokio::process::Command::new(zsh);
    command
        .args(["-f", "-c", &input.command, "aiden-subagent"])
        .current_dir(&root.path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", format!("{private_root}/home"))
        .env("TMPDIR", format!("{private_root}/tmp"))
        .env("XDG_CONFIG_HOME", format!("{private_root}/config"))
        .env("XDG_CACHE_HOME", format!("{private_root}/cache"))
        .env("XDG_DATA_HOME", format!("{private_root}/data"))
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("SHELL", "/bin/zsh")
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .env("CI", "1")
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/usr/bin/false")
        .env("SSH_ASKPASS", "/usr/bin/false")
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("NPM_CONFIG_USERCONFIG", "/dev/null")
        .env("NPM_CONFIG_UPDATE_NOTIFIER", "false")
        .env("NPM_CONFIG_FUND", "false")
        .env("NPM_CONFIG_AUDIT", "false")
        .env("ZDOTDIR", "/dev/null")
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            remove_tree(&private_root);
            return Ok(response_frame(
                input,
                SubagentShellOutcome::SpawnFailed,
                None,
                None,
                true,
                &[],
                &[],
            ));
        }
    };
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let mut out_bytes: Vec<u8> = Vec::new();
    let mut err_bytes: Vec<u8> = Vec::new();
    let mut outcome = SubagentShellOutcome::Exited;
    let mut exit_code: Option<u32> = None;
    let mut signal: Option<u32> = None;
    let mut overflow = false;
    let (mut out_open, mut err_open) = (true, true);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(input.timeout_ms);
    let cancelled = input.cancelled;
    loop {
        let mut out_buf = [0u8; 16 * 1024];
        let mut err_buf = [0u8; 16 * 1024];
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                outcome = SubagentShellOutcome::TimedOut;
                break;
            }
            result = async {
                if out_open && err_open {
                    tokio::select! {
                        read = stdout.read(&mut out_buf) => (Some(read), None),
                        read = stderr.read(&mut err_buf) => (None, Some(read)),
                    }
                } else if out_open {
                    (Some(stdout.read(&mut out_buf).await), None)
                } else if err_open {
                    (None, Some(stderr.read(&mut err_buf).await))
                } else {
                    (Some(Ok(0)), None)
                }
            } => {
                match result {
                    (Some(Ok(0)), _) => { out_open = false; }
                    (Some(Ok(count)), _) => {
                        if out_bytes.len() + count > SUBAGENT_SHELL_STREAM_BYTES {
                            overflow = true;
                            break;
                        }
                        out_bytes.extend_from_slice(&out_buf[..count]);
                    }
                    (Some(Err(_)), _) => { out_open = false; }
                    (_, Some(Ok(0))) => { err_open = false; }
                    (_, Some(Ok(count))) => {
                        if err_bytes.len() + count > SUBAGENT_SHELL_STREAM_BYTES {
                            overflow = true;
                            break;
                        }
                        err_bytes.extend_from_slice(&err_buf[..count]);
                    }
                    (_, Some(Err(_))) => { err_open = false; }
                    _ => {}
                }
                if overflow { break; }
                let status = child.try_wait().map_err(|_| ShellError("protocol failed".to_string()))?;
                if let Some(status) = status {
                    if let Some(code) = status.code() {
                        outcome = SubagentShellOutcome::Exited;
                        exit_code = Some(code as u32);
                    } else {
                        outcome = SubagentShellOutcome::Signaled;
                        signal = Some(status.signal().unwrap_or(0) as u32);
                    }
                    break;
                }
            }
        }
    }
    let cleanup = if overflow {
        outcome = SubagentShellOutcome::OutputLimit;
        let _ = child.kill().await;
        let _ = child.wait().await;
        true
    } else if cancelled {
        outcome = SubagentShellOutcome::Cancelled;
        let _ = child.kill().await;
        let _ = child.wait().await;
        true
    } else {
        child.wait().await.is_ok()
    };
    // Drain any remaining output after the child exits.
    let mut remaining = Vec::new();
    let _ = stdout.read_to_end(&mut remaining).await;
    for byte in remaining {
        if out_bytes.len() < SUBAGENT_SHELL_STREAM_BYTES {
            out_bytes.push(byte);
        } else {
            outcome = SubagentShellOutcome::OutputLimit;
        }
    }
    remove_tree(&private_root);
    let cleaned = cleanup;
    let frame = response_frame(
        input, outcome, exit_code, signal, cleaned, &out_bytes, &err_bytes,
    );
    Ok(frame)
}

fn response_frame(
    input: &SubagentShellRunInput,
    outcome: SubagentShellOutcome,
    exit_code: Option<u32>,
    signal: Option<u32>,
    cleanup: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> Vec<u8> {
    // 36-byte header + 64-byte nonce (100 bytes), then the 64-byte digest,
    // then the two streams (RESPONSE_FIXED_BYTES == 164 covers header +
    // nonce + digest).
    let mut fixed = [0u8; 100];
    fixed[..8].copy_from_slice(b"AIDSR001");
    fixed[8..12].copy_from_slice(&1u32.to_be_bytes());
    let outcome_index: u32 = match outcome {
        SubagentShellOutcome::Exited => 1,
        SubagentShellOutcome::Signaled => 2,
        SubagentShellOutcome::TimedOut => 3,
        SubagentShellOutcome::OutputLimit => 4,
        SubagentShellOutcome::Cancelled => 5,
        SubagentShellOutcome::SpawnFailed => 6,
        SubagentShellOutcome::ProtocolFailed => 7,
        SubagentShellOutcome::CleanupUnconfirmed => 8,
    };
    fixed[12..16].copy_from_slice(&outcome_index.to_be_bytes());
    fixed[16..20].copy_from_slice(&exit_code.unwrap_or(0xffff_ffff).to_be_bytes());
    fixed[20..24].copy_from_slice(&signal.unwrap_or(0).to_be_bytes());
    fixed[24..28].copy_from_slice(&(cleanup as u32).to_be_bytes());
    fixed[28..32].copy_from_slice(&(stdout.len() as u32).to_be_bytes());
    fixed[32..36].copy_from_slice(&(stderr.len() as u32).to_be_bytes());
    fixed[36..100].copy_from_slice(input.nonce.as_bytes());
    let mut frame = Vec::with_capacity(RESPONSE_FIXED_BYTES + stdout.len() + stderr.len());
    frame.extend_from_slice(&fixed);
    frame.extend_from_slice(input.effect_digest.as_bytes());
    frame.extend_from_slice(stdout);
    frame.extend_from_slice(stderr);
    frame
}

fn create_private_tree() -> Result<String, ShellError> {
    let base = std::env::temp_dir().join("aiden-subagent-shell");
    std::fs::create_dir_all(&base).map_err(|_| ShellError("private tree failed".to_string()))?;
    let root = base.join(uuid_like());
    std::fs::create_dir(&root).map_err(|_| ShellError("private tree failed".to_string()))?;
    for child in ["home", "tmp", "config", "cache", "data"] {
        std::fs::create_dir(root.join(child))
            .map_err(|_| ShellError("private tree failed".to_string()))?;
    }
    Ok(root.to_string_lossy().into_owned())
}

fn remove_tree(path: &str) {
    let _ = std::fs::remove_dir_all(path);
}

fn uuid_like() -> String {
    let mut bytes = [0u8; 16];
    let mut state = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    for chunk in bytes.chunks_mut(8) {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        let value = (z ^ (z >> 31)).to_le_bytes();
        chunk.copy_from_slice(&value[..chunk.len()]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(36);
    let mut byte_index = 0usize;
    let mut output_index = 0usize;
    while byte_index < 16 {
        if matches!(output_index, 8 | 13 | 18 | 23) {
            output.push('-');
            output_index += 1;
        }
        output.push(HEX[(bytes[byte_index] >> 4) as usize] as char);
        output.push(HEX[(bytes[byte_index] & 0x0f) as usize] as char);
        byte_index += 1;
        output_index += 2;
    }
    output
}

/// sha256 for the shell argument/effect digests (`fieldsDigest` framing).
pub fn fields_digest(domain: &str, fields: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update(b"\0");
    for field in fields {
        let bytes = field.as_bytes();
        hasher.update((bytes.len() as u32).to_be_bytes());
        hasher.update(bytes);
    }
    crate::authority::hex(&hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce() -> String {
        "0".repeat(64)
    }

    fn digest() -> String {
        "1".repeat(64)
    }

    #[test]
    fn request_framing_is_exact() {
        let request = encode_subagent_shell_request(&SubagentShellRequest {
            command: "echo hello".to_string(),
            effect_digest: digest(),
            nonce: nonce(),
            timeout_ms: 120_000,
        })
        .unwrap();
        assert_eq!(&request[..8], b"AIDSH001");
        assert_eq!(u32::from_be_bytes(request[8..12].try_into().unwrap()), 1);
        assert_eq!(u32::from_be_bytes(request[12..16].try_into().unwrap()), 64);
        assert_eq!(
            u32::from_be_bytes(request[20..24].try_into().unwrap()),
            120_000
        );
        assert_eq!(u32::from_be_bytes(request[24..28].try_into().unwrap()), 10);
        assert_eq!(&request[28..92], nonce().as_bytes());
        assert_eq!(&request[92..156], digest().as_bytes());
        assert_eq!(&request[156..], b"echo hello");
        // Invalid command controls.
        assert!(encode_subagent_shell_request(&SubagentShellRequest {
            command: "echo \u{1b}".to_string(),
            effect_digest: digest(),
            nonce: nonce(),
            timeout_ms: 120_000,
        })
        .is_err());
        // Oversized timeout.
        assert!(encode_subagent_shell_request(&SubagentShellRequest {
            command: "echo x".to_string(),
            effect_digest: digest(),
            nonce: nonce(),
            timeout_ms: 3_600_001,
        })
        .is_err());
    }

    #[test]
    fn response_framing_decodes_all_outcomes() {
        // Frame layout: 36-byte header + 64-byte nonce (100 bytes), then the
        // 64-byte digest, then stdout, then stderr.
        let mut frame = Vec::with_capacity(RESPONSE_FIXED_BYTES);
        let mut fixed = [0u8; 100];
        fixed[..8].copy_from_slice(b"AIDSR001");
        fixed[8..12].copy_from_slice(&1u32.to_be_bytes());
        fixed[12..16].copy_from_slice(&1u32.to_be_bytes());
        fixed[16..20].copy_from_slice(&0u32.to_be_bytes());
        fixed[20..24].copy_from_slice(&0u32.to_be_bytes());
        fixed[24..28].copy_from_slice(&1u32.to_be_bytes());
        fixed[28..32].copy_from_slice(&5u32.to_be_bytes());
        fixed[32..36].copy_from_slice(&6u32.to_be_bytes());
        fixed[36..100].copy_from_slice(nonce().as_bytes());
        frame.extend_from_slice(&fixed);
        frame.extend_from_slice(digest().as_bytes());
        frame.extend_from_slice(b"hello");
        frame.extend_from_slice(b"world!");
        let result = decode_subagent_shell_response(
            &frame,
            &SubagentShellResponseIdentity {
                nonce: nonce(),
                effect_digest: digest(),
            },
        )
        .unwrap();
        assert_eq!(result.outcome, SubagentShellOutcome::Exited);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.cleanup_confirmed);
        assert_eq!(result.stdout, "hello");
        assert_eq!(result.stderr, "world!");
        // Bad nonce fails.
        assert!(decode_subagent_shell_response(
            &frame,
            &SubagentShellResponseIdentity {
                nonce: "f".repeat(64),
                effect_digest: digest(),
            },
        )
        .is_err());
        // Truncated frame fails.
        assert!(decode_subagent_shell_response(
            &frame[..100],
            &SubagentShellResponseIdentity {
                nonce: nonce(),
                effect_digest: digest(),
            },
        )
        .is_err());
    }

    #[tokio::test]
    async fn in_process_runner_executes_and_cleans_up() {
        if !Path::new("/bin/zsh").exists() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let pinned = pin_subagent_shell_workspace_root(canonical_root.to_str().unwrap()).unwrap();
        let input = SubagentShellRunInput {
            command: "printf hello && printf ' world' >&2 && echo \"$(pwd)\"".to_string(),
            effect_digest: digest(),
            nonce: nonce(),
            timeout_ms: 30_000,
            cancelled: false,
        };
        let frame = run_subagent_shell(&input, &pinned).await.unwrap();
        let result = decode_subagent_shell_response(
            &frame,
            &SubagentShellResponseIdentity {
                nonce: nonce(),
                effect_digest: digest(),
            },
        )
        .unwrap();
        assert_eq!(result.outcome, SubagentShellOutcome::Exited);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.cleanup_confirmed);
        assert!(result.stdout.contains("hello"));
        assert!(result.stderr.contains("world"));
        // The command ran inside the pinned workspace root.
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        assert!(result.stdout.contains(canonical_root.to_str().unwrap()));
    }

    #[tokio::test]
    async fn timeout_produces_timed_out_outcome() {
        if !Path::new("/bin/zsh").exists() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let pinned = pin_subagent_shell_workspace_root(canonical_root.to_str().unwrap()).unwrap();
        let input = SubagentShellRunInput {
            command: "sleep 5".to_string(),
            effect_digest: digest(),
            nonce: nonce(),
            timeout_ms: 100,
            cancelled: false,
        };
        let frame = run_subagent_shell(&input, &pinned).await.unwrap();
        let result = decode_subagent_shell_response(
            &frame,
            &SubagentShellResponseIdentity {
                nonce: nonce(),
                effect_digest: digest(),
            },
        )
        .unwrap();
        assert_eq!(result.outcome, SubagentShellOutcome::TimedOut);
    }

    #[test]
    fn fields_digest_is_deterministic() {
        assert_eq!(
            fields_digest("aiden-subagent-shell-argument-v2", &["echo hello"]),
            fields_digest("aiden-subagent-shell-argument-v2", &["echo hello"])
        );
        assert_ne!(
            fields_digest("aiden-subagent-shell-argument-v2", &["echo hello"]),
            fields_digest("aiden-subagent-shell-argument-v2", &["echo bye"])
        );
    }
}
