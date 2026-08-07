//! Bounded subprocess execution and child termination (port of
//! `main/services/computer-use/process.ts`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Child;
use tokio_util::sync::CancellationToken;

use crate::contract::CuaDriverError;

const MAX_STDOUT_BYTES: u64 = 256 * 1024;
const MAX_STDERR_BYTES: u64 = 16 * 1024;
const TERMINATE_GRACE_MS: u64 = 500;
const KILL_GRACE_MS: u64 = 1_000;

/// A fixed platform utility invocation (`open`, `codesign`, `plutil`).
#[derive(Debug, Clone)]
pub struct CuaDriverCommandInvocation {
    pub command: PathBuf,
    pub prefix_args: Vec<String>,
}

impl CuaDriverCommandInvocation {
    pub fn new(command: impl Into<PathBuf>) -> Self {
        Self {
            command: command.into(),
            prefix_args: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct BoundedProcessResult {
    pub stdout: String,
    pub stderr: String,
}

/// Wait until the child is reaped or the timeout elapses.
async fn wait_for_child_reaped(child: &mut Child, timeout_ms: u64) -> bool {
    tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait())
        .await
        .is_ok()
}

/// Terminate a bridge or test broker that intentionally owns no same-process-
/// group descendants. Once the direct child is known reaped, never signal its
/// PID again: it may already have been reused by the OS.
#[cfg(unix)]
pub async fn terminate_direct_child(
    child: &mut Child,
    terminate_grace_ms: Option<u64>,
    kill_grace_ms: Option<u64>,
) {
    let terminate_grace_ms = terminate_grace_ms.unwrap_or(TERMINATE_GRACE_MS);
    let kill_grace_ms = kill_grace_ms.unwrap_or(KILL_GRACE_MS);
    let Some(pid) = child.id() else {
        return;
    };
    // SIGTERM first; escalate to SIGKILL after the grace period.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
    if wait_for_child_reaped(child, terminate_grace_ms).await {
        return;
    }
    let _ = child.start_kill();
    wait_for_child_reaped(child, kill_grace_ms).await;
}

/// A shared handle to a spawned bridge/broker child. The child is terminated
/// (SIGTERM → grace → SIGKILL) when `terminate` is called or when the last
/// handle is dropped, so a dropped session can never orphan the bridge.
pub struct ChildHandle {
    inner: std::sync::Mutex<Option<Child>>,
}

impl ChildHandle {
    pub fn new(child: Child) -> Arc<Self> {
        Arc::new(Self {
            inner: std::sync::Mutex::new(Some(child)),
        })
    }

    pub fn pid(&self) -> u32 {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|child| child.id())
            .unwrap_or(0)
    }

    pub fn terminate(&self) {
        let Some(child) = self.inner.lock().unwrap().take() else {
            return;
        };
        tokio::spawn(async move {
            let mut child = child;
            terminate_direct_child(&mut child, None, None).await;
        });
    }
}

impl Drop for ChildHandle {
    fn drop(&mut self) {
        if let Some(mut child) = self.inner.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

/// Run a fixed platform utility with bounded output and an optional timeout,
/// aborting the child on cancellation (port of `runCuaDriverCommand`).
pub async fn run_command(
    invocation: &CuaDriverCommandInvocation,
    args: &[String],
    env: &HashMap<String, String>,
    signal: Option<&CancellationToken>,
    timeout_ms: u64,
) -> Result<BoundedProcessResult, CuaDriverError> {
    if signal.is_some_and(|token| token.is_cancelled()) {
        return Err(CuaDriverError::cancelled(
            "cua-driver request was cancelled.",
        ));
    }
    use std::process::Stdio;
    let mut command = tokio::process::Command::new(&invocation.command);
    command
        .args(invocation.prefix_args.iter())
        .args(args)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                "driver_missing"
            } else {
                "spawn_failed"
            };
            return Err(CuaDriverError::new(
                code,
                "The pinned cua-driver helper is unavailable.",
            ));
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = stdout
        .map(|stream| tokio::spawn(async move { drain_bounded(stream, MAX_STDOUT_BYTES).await }));
    let stderr_task = stderr
        .map(|stream| tokio::spawn(async move { drain_bounded(stream, MAX_STDERR_BYTES).await }));

    let mut wait = Box::pin(child.wait());
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut stop: Option<CuaDriverError> = None;
    let mut wait_result: Option<Result<std::process::ExitStatus, std::io::Error>> = None;
    loop {
        if signal.is_some_and(|token| token.is_cancelled()) {
            stop = Some(CuaDriverError::cancelled(
                "cua-driver request was cancelled.",
            ));
            break;
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            stop = Some(CuaDriverError::retryable(
                "timeout",
                "cua-driver did not respond in time.",
            ));
            break;
        }
        match tokio::time::timeout(deadline - now, &mut wait).await {
            Ok(result) => {
                wait_result = Some(result);
                break;
            }
            Err(_) => {
                // Deadline elapsed between checks; the loop re-evaluates.
            }
        }
    }
    drop(wait);
    if let Some(error) = stop {
        terminate_direct_child(&mut child, None, None).await;
        return Err(error);
    }
    let status = match wait_result.expect("wait settled") {
        Ok(status) => status,
        Err(_) => {
            return Err(CuaDriverError::new(
                "command_failed",
                "cua-driver command failed.",
            ))
        }
    };
    let stdout = match stdout_task {
        Some(task) => task.await.unwrap_or(Ok(String::new())).unwrap_or_default(),
        None => String::new(),
    };
    let stderr = match stderr_task {
        Some(task) => task.await.unwrap_or(Ok(String::new())).unwrap_or_default(),
        None => String::new(),
    };
    if status.success() {
        return Ok(BoundedProcessResult { stdout, stderr });
    }
    let diagnostic = stderr.trim().chars().take(600).collect::<String>();
    let message = match status.code() {
        Some(code) => format!(
            "cua-driver exited with code {code}{}",
            if diagnostic.is_empty() {
                ".".to_string()
            } else {
                format!(": {diagnostic}")
            }
        ),
        None => "cua-driver was terminated by a signal.".to_string(),
    };
    Err(CuaDriverError::new("command_failed", message))
}

async fn drain_bounded<R>(mut stream: R, maximum: u64) -> Result<String, CuaDriverError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut output = String::new();
    let mut bytes: u64 = 0;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                bytes += count as u64;
                if bytes > maximum {
                    return Err(CuaDriverError::new(
                        "output_too_large",
                        "cua-driver returned too much output.",
                    ));
                }
                output.push_str(&String::from_utf8_lossy(&buffer[..count]));
            }
        }
    }
    Ok(output)
}
