//! Broker socket-path protocol and the client-side connect retry policy.
//!
//! The broker confines its sockets to a fixed name inside a current-user-owned
//! `0700` directory directly under `/tmp` named `acu-*`
//! (`native/computer-use-broker/src/socket.rs`). This module replicates the
//! connect-target validation so the client (and tests) can only ever reach a
//! conforming socket, plus the 25 ms-polling connect loop the broker's bridge
//! uses (`connect_confined_socket_until`).

use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio::net::UnixStream;

pub const CONTROL_SOCKET_NAME: &str = "control.sock";
pub const LAUNCH_LEASE_SOCKET_NAME: &str = "lease.sock";
const DARWIN_UNIX_PATH_MAX: usize = 103;

/// Exponential backoff for connection attempts. Mirrors the broker's fixed
/// 25 ms poll plus a bounded cap so a missing broker is never hammered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryBackoff {
    base_ms: u64,
    max_ms: u64,
    attempts: u64,
}

impl RetryBackoff {
    pub fn new(base_ms: u64, max_ms: u64) -> Self {
        Self {
            base_ms,
            max_ms,
            attempts: 0,
        }
    }

    /// The next sleep duration before retrying.
    pub fn next_delay(&mut self) -> Duration {
        self.attempts += 1;
        let exponential = self
            .base_ms
            .saturating_mul(1 << self.attempts.saturating_sub(1).min(16));
        Duration::from_millis(exponential.min(self.max_ms))
    }
}

fn current_uid() -> u32 {
    unsafe { libc::geteuid() }
}

/// Validate a connect target the way the broker validates it before accepting
/// any socket path (`secure_parent` + `validate_socket_target`).
fn validate_socket_target(path: &Path, expected_name: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("socket must be absolute".to_owned());
    }
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name) {
        return Err(format!("socket must use the fixed {expected_name} name"));
    }
    if path.as_os_str().as_bytes().len() > DARWIN_UNIX_PATH_MAX {
        return Err("socket path is too long".to_owned());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "socket has no parent".to_owned())?;
    let metadata = std::fs::symlink_metadata(parent)
        .map_err(|error| format!("could not inspect socket directory: {error}"))?;
    if metadata.uid() != current_uid() || metadata.mode() & 0o777 != 0o700 {
        return Err("socket directory must be current-user owned with mode 0700".to_owned());
    }
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|error| format!("could not resolve socket directory: {error}"))?;
    let canonical_temp = std::fs::canonicalize(Path::new("/tmp"))
        .map_err(|error| format!("could not resolve system temporary directory: {error}"))?;
    if canonical_parent.parent() != Some(canonical_temp.as_path())
        || !canonical_parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("acu-") && name.len() > 4)
    {
        return Err("socket directory is outside Aiden's confined temporary namespace".to_owned());
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect socket: {error}"))?;
    if metadata.file_type().is_symlink() || metadata.uid() != current_uid() {
        return Err("socket target is not Aiden's current-user Unix socket".to_owned());
    }
    Ok(())
}

pub fn validate_control_connect_target(path: &Path) -> Result<(), String> {
    validate_socket_target(path, CONTROL_SOCKET_NAME)
}

pub fn validate_launch_lease_connect_target(path: &Path) -> Result<(), String> {
    validate_socket_target(path, LAUNCH_LEASE_SOCKET_NAME)
}

/// Connect to a confined socket, retrying until `deadline` (mirror of the
/// broker bridge's `connect_confined_socket_until`: 25 ms polls, NotFound and
/// ConnectionRefused retried, everything else fails).
pub async fn connect_socket_with_retry(
    path: &Path,
    deadline: Instant,
    validate: fn(&Path) -> Result<(), String>,
    mut backoff: RetryBackoff,
) -> Result<UnixStream, String> {
    loop {
        if Instant::now() >= deadline {
            return Err("timed out waiting for broker socket".to_owned());
        }
        match tokio::fs::symlink_metadata(path).await {
            Ok(_) => validate(path)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                tokio::time::sleep(
                    backoff
                        .next_delay()
                        .min(deadline.saturating_duration_since(Instant::now())),
                )
                .await;
                continue;
            }
            Err(error) => return Err(format!("could not inspect broker socket: {error}")),
        }
        match UnixStream::connect(path).await {
            Ok(stream) => return Ok(stream),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) =>
            {
                tokio::time::sleep(
                    backoff
                        .next_delay()
                        .min(deadline.saturating_duration_since(Instant::now())),
                )
                .await;
            }
            Err(error) => return Err(format!("could not connect to broker socket: {error}")),
        }
    }
}

/// Create the canonical session directory layout under the system temp dir:
/// a unique `acu-*` directory with mode `0700` (port of the host's
/// `mkdtemp(path.join(tempRoot ?? "/tmp", "acu-"))` + `chmod(0o700)`), plus
/// the fixed `control.sock` and `lease.sock` paths inside it.
pub fn create_session_directory(temp_root: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let mut random = [0_u8; 6];
    getrandom::getrandom(&mut random)
        .map_err(|error| format!("could not generate session identity: {error}"))?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let directory =
        temp_root.join(format!("acu-{}", std::process::id()).to_string() + "-" + &suffix);
    std::fs::create_dir(&directory)
        .map_err(|error| format!("could not create session directory: {error}"))?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("could not secure session directory: {error}"))?;
    let control_path = directory.join(CONTROL_SOCKET_NAME);
    let lease_path = directory.join(LAUNCH_LEASE_SOCKET_NAME);
    Ok((directory, control_path, lease_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::DirBuilderExt;

    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    fn test_directory() -> PathBuf {
        // The broker confines its namespace to real directories directly under
        // `/tmp` (canonicalized), so tests use `/tmp` explicitly rather than
        // the symlinked `$TMPDIR` macOS usually points at.
        let path = PathBuf::from("/tmp").join(format!(
            "acu-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700).create(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn connects_with_retry_once_the_socket_appears() {
        let directory = test_directory();
        let socket = directory.join(CONTROL_SOCKET_NAME);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let backoff = RetryBackoff::new(1, 10);
        let stream =
            connect_socket_with_retry(&socket, deadline, validate_control_connect_target, backoff)
                .await
                .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        drop(stream);
        drop(server);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn retry_times_out_when_the_socket_never_appears() {
        let directory = test_directory();
        let socket = directory.join(CONTROL_SOCKET_NAME);
        let deadline = Instant::now() + Duration::from_millis(150);
        let backoff = RetryBackoff::new(5, 25);
        let error =
            connect_socket_with_retry(&socket, deadline, validate_control_connect_target, backoff)
                .await
                .unwrap_err();
        assert!(error.contains("timed out"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn validates_the_exact_confined_namespace() {
        let directory = test_directory();
        let socket = directory.join(CONTROL_SOCKET_NAME);
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        assert!(validate_control_connect_target(&socket).is_ok());
        assert!(validate_control_connect_target(&directory.join("other.sock")).is_err());
        assert!(
            validate_launch_lease_connect_target(&directory.join(LAUNCH_LEASE_SOCKET_NAME))
                .is_err()
        );
        drop(listener);
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(validate_control_connect_target(&socket).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backoff_is_exponential_and_bounded() {
        let mut backoff = RetryBackoff::new(25, 400);
        assert_eq!(backoff.next_delay(), Duration::from_millis(25));
        assert_eq!(backoff.next_delay(), Duration::from_millis(50));
        assert_eq!(backoff.next_delay(), Duration::from_millis(100));
        let mut bounded = RetryBackoff::new(1000, 5000);
        for _ in 0..10 {
            assert!(bounded.next_delay().as_millis() <= 5000);
        }
    }

    #[test]
    fn creates_unique_0700_session_directories() {
        let temp_root = PathBuf::from("/tmp");
        let (first, control, lease) = create_session_directory(&temp_root).unwrap();
        let (second, _, _) = create_session_directory(&temp_root).unwrap();
        assert_ne!(first, second);
        let metadata = std::fs::symlink_metadata(&first).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o700);
        assert_eq!(control.file_name().unwrap(), CONTROL_SOCKET_NAME);
        assert_eq!(lease.file_name().unwrap(), LAUNCH_LEASE_SOCKET_NAME);
        let listener = std::os::unix::net::UnixListener::bind(&control).unwrap();
        assert!(validate_control_connect_target(&control).is_ok());
        drop(listener);
        std::fs::remove_dir_all(first).unwrap();
        std::fs::remove_dir_all(second).unwrap();
    }
}
