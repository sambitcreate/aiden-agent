//! The Computer Use host (port of `main/services/computer-use/host.ts`).
//!
//! macOS-only: spawns the signed broker (via `open` or a test invocation),
//! spawns the bridge with Node-compatible stdio (fd 3 = IPC socketpair, fd 4 =
//! readiness pipe), reads the exact `{"type":"ready","protocolVersion":2}`
//! readiness frame, and owns session cleanup.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::binary::verify_cua_driver_bridge_process;
use crate::contract::{
    build_cua_driver_environment, CuaDriverError, CuaDriverInvocation, CuaDriverManifest,
    CUA_DRIVER_TOOL_SCHEMA, CUA_DRIVER_VERSION,
};
const READINESS_FRAME_NO_NEWLINE: &[u8] = b"{\"type\":\"ready\",\"protocolVersion\":2}";
use crate::process::{run_command, BoundedProcessResult, ChildHandle, CuaDriverCommandInvocation};
use crate::session::{CuaDriverSession, CuaDriverSessionOptions, SessionTransportConfig};
use crate::socket::create_session_directory;

const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 10_000;
const MAX_READY_BYTES: u64 = 64 * 1024;

/// How the broker is launched for one session.
#[derive(Debug, Clone)]
pub struct BrokerOptions {
    /// The helper app bundle (`CuaDriver.app`).
    pub app_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CuaDriverHostOptions {
    pub invocation: CuaDriverInvocation,
    pub base_env: Option<HashMap<String, String>>,
    pub temp_root: Option<PathBuf>,
    pub startup_timeout_ms: Option<u64>,
    pub broker: BrokerOptions,
    /// Test-only direct broker argv (spawned instead of `/usr/bin/open`).
    pub direct_broker: Option<CuaDriverInvocation>,
}

/// A live session runtime owned by the host.
pub struct SessionRuntime {
    pub bridge: Arc<ChildHandle>,
    /// The parent end of the fd-3 IPC socketpair. The bridge exits when this
    /// closes (it monitors Aiden's liveness), so keeping it alive is what ties
    /// the bridge to this session.
    pub ipc_peer: std::sync::Mutex<Option<std::os::unix::net::UnixStream>>,
    pub broker_launcher: Option<Arc<ChildHandle>>,
    pub temp_directory: PathBuf,
    pub session: std::sync::Mutex<Option<Arc<CuaDriverSession>>>,
    pub diagnostic: std::sync::Mutex<String>,
    pub stopping: AtomicBool,
}

fn startup_timeout_error() -> CuaDriverError {
    CuaDriverError::retryable(
        "startup_timeout",
        "Aiden Computer Use did not finish starting in time.",
    )
}

fn cancelled_error(message: &str) -> CuaDriverError {
    CuaDriverError::cancelled(message)
}

fn remaining_milliseconds(deadline: Instant) -> u64 {
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis();
    if remaining == 0 {
        1
    } else {
        remaining as u64
    }
}

type VerifyBridgeFn = Box<
    dyn Fn(
            u32,
            &Path,
            Option<&CancellationToken>,
        ) -> std::pin::Pin<
            Box<dyn futures::future::Future<Output = Result<(), CuaDriverError>> + Send>,
        > + Send
        + Sync,
>;

/// The production host. Bridge verification is a seam the test harness
/// overrides; production always validates the exact live bridge process.
pub struct CuaDriverHost {
    options: CuaDriverHostOptions,
    environment: HashMap<String, String>,
    manifest: std::sync::Mutex<Option<CuaDriverManifest>>,
    sessions: Arc<std::sync::Mutex<Vec<Arc<CuaDriverSession>>>>,
    runtimes: Arc<std::sync::Mutex<Vec<Arc<SessionRuntime>>>>,
    shutdown_controller: CancellationToken,
    shutdown_promise: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    verify_spawned_bridge: Option<VerifyBridgeFn>,
}

impl CuaDriverHost {
    pub fn new(options: CuaDriverHostOptions) -> Self {
        let environment = build_cua_driver_environment(
            options.base_env.as_ref().unwrap_or(&HashMap::new()),
            crate::contract::CUA_DRIVER_TCC_HOST_BUNDLE_ID,
        );
        Self {
            options,
            environment,
            manifest: std::sync::Mutex::new(None),
            sessions: Arc::new(std::sync::Mutex::new(Vec::new())),
            runtimes: Arc::new(std::sync::Mutex::new(Vec::new())),
            shutdown_controller: CancellationToken::new(),
            shutdown_promise: tokio::sync::Mutex::new(None),
            verify_spawned_bridge: None,
        }
    }

    /// Override bridge verification (tests only).
    pub fn set_verify_spawned_bridge(&mut self, verify: VerifyBridgeFn) {
        self.verify_spawned_bridge = Some(verify);
    }

    pub fn driver_manifest(&self) -> Option<CuaDriverManifest> {
        self.manifest.lock().unwrap().clone()
    }

    pub fn running(&self) -> bool {
        self.runtimes
            .lock()
            .unwrap()
            .iter()
            .any(|runtime| !runtime.stopping.load(Ordering::SeqCst))
    }

    pub async fn start(&self) -> Result<(), CuaDriverError> {
        if self.shutdown_controller.is_cancelled() {
            return Err(CuaDriverError::new(
                "host_closed",
                "The Computer Use host has shut down.",
            ));
        }
        *self.manifest.lock().unwrap() = Some(CuaDriverManifest {
            schema_version: CUA_DRIVER_TOOL_SCHEMA.into(),
            binary_version: CUA_DRIVER_VERSION.into(),
        });
        Ok(())
    }

    fn assert_open(&self, signal: Option<&CancellationToken>) -> Result<(), CuaDriverError> {
        if self.shutdown_controller.is_cancelled() {
            return Err(CuaDriverError::new(
                "host_closed",
                "The Computer Use host has shut down.",
            ));
        }
        if signal.is_some_and(|token| token.is_cancelled()) {
            return Err(cancelled_error("Computer Use startup was cancelled."));
        }
        Ok(())
    }

    pub async fn create_session(
        &self,
        signal: Option<&CancellationToken>,
    ) -> Result<Arc<CuaDriverSession>, CuaDriverError> {
        self.start().await?;
        self.assert_open(signal)?;
        let timeout_ms = self
            .options
            .startup_timeout_ms
            .unwrap_or(DEFAULT_STARTUP_TIMEOUT_MS)
            .max(1);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);

        let (temp_directory, control_path, launch_lease_path) = create_session_directory(
            self.options
                .temp_root
                .as_deref()
                .unwrap_or(Path::new("/tmp")),
        )
        .map_err(|error| CuaDriverError::new("bridge_failed", error))?;
        let mut broker_launcher: Option<Arc<ChildHandle>> = None;

        let bridge = match self
            .create_session_internal(
                &control_path,
                &launch_lease_path,
                &mut broker_launcher,
                signal,
                deadline,
            )
            .await
        {
            Ok(bridge) => bridge,
            Err(error) => {
                if let Some(launcher) = broker_launcher.as_ref() {
                    launcher.terminate();
                }
                let _ = std::fs::remove_dir_all(&temp_directory);
                return Err(error);
            }
        };

        let runtime = Arc::new(SessionRuntime {
            bridge: bridge.bridge,
            ipc_peer: std::sync::Mutex::new(Some(bridge.ipc_peer)),
            broker_launcher,
            temp_directory: temp_directory.clone(),
            session: std::sync::Mutex::new(None),
            diagnostic: std::sync::Mutex::new(String::new()),
            stopping: AtomicBool::new(false),
        });

        let runtime_for_diagnostic = Arc::clone(&runtime);
        let session = CuaDriverSession::new(CuaDriverSessionOptions {
            transport: SessionTransportConfig {
                read_half: Box::new(bridge.stdout),
                write_half: Box::new(bridge.stdin),
                terminate: Some(Box::new({
                    let handle = Arc::clone(&runtime.bridge);
                    move || handle.terminate()
                })),
            },
            diagnostic: Some(Arc::new(move || {
                runtime_for_diagnostic.diagnostic.lock().unwrap().clone()
            })),
            on_closed: Some(Box::new({
                let runtime = Arc::clone(&runtime);
                let sessions = Arc::clone(&self.sessions);
                move || {
                    runtime.stopping.store(true, Ordering::SeqCst);
                    let session = runtime.session.lock().unwrap().clone();
                    if let Some(session) = session {
                        sessions
                            .lock()
                            .unwrap()
                            .retain(|candidate| !Arc::ptr_eq(candidate, &session));
                    }
                }
            })),
        });
        let session = Arc::new(session);
        *runtime.session.lock().unwrap() = Some(Arc::clone(&session));
        self.sessions.lock().unwrap().push(Arc::clone(&session));
        self.runtimes.lock().unwrap().push(Arc::clone(&runtime));

        if let Err(error) = session.connect(signal, Some(deadline)).await {
            session.close().await;
            let _ = std::fs::remove_dir_all(&temp_directory);
            return Err(error);
        }
        self.assert_open(signal)?;
        Ok(session)
    }

    async fn create_session_internal(
        &self,
        control_path: &Path,
        launch_lease_path: &Path,
        broker_launcher: &mut Option<Arc<ChildHandle>>,
        signal: Option<&CancellationToken>,
        deadline: Instant,
    ) -> Result<SpawnedBridge, CuaDriverError> {
        self.assert_open(signal)?;

        // Launch the broker: either a direct invocation (test seam) or the
        // signed helper app via `/usr/bin/open -n -g`.
        if let Some(direct) = self.options.direct_broker.as_ref() {
            let child =
                spawn_direct_broker(direct, control_path, launch_lease_path, &self.environment)?;
            *broker_launcher = Some(child);
        } else {
            launch_broker_via_open(
                &self.options.broker.app_path,
                control_path,
                launch_lease_path,
                &self.environment,
                signal,
                remaining_milliseconds(deadline),
            )
            .await?;
        }

        // Spawn the bridge with fd 3 (IPC socketpair) and fd 4 (readiness pipe).
        let (spawned, readiness) = spawn_bridge(
            &self.options.invocation,
            control_path,
            launch_lease_path,
            &self.environment,
        )
        .map_err(|error| CuaDriverError::new("bridge_failed", error))?;
        let bridge_pid = spawned.bridge.pid();
        if bridge_pid == 0 {
            return Err(CuaDriverError::new(
                "bridge_failed",
                "Aiden could not start Computer Use.",
            ));
        }
        if let Some(verify) = &self.verify_spawned_bridge {
            verify(bridge_pid, &self.options.invocation.command, signal).await?;
        } else {
            verify_cua_driver_bridge_process(bridge_pid, &self.options.invocation.command, signal)
                .await?;
        }
        read_bridge_ready(readiness, remaining_milliseconds(deadline), signal).await?;
        self.assert_open(signal)?;
        Ok(spawned)
    }

    pub async fn shutdown(&self) {
        let mut shutdown_promise = self.shutdown_promise.lock().await;
        if let Some(handle) = shutdown_promise.as_mut() {
            let _ = handle.await;
            return;
        }
        self.shutdown_controller.cancel();
        let sessions: Vec<Arc<CuaDriverSession>> = self.sessions.lock().unwrap().clone();
        let runtimes: Vec<Arc<SessionRuntime>> = self.runtimes.lock().unwrap().clone();
        let promise = tokio::spawn(async move {
            for session in sessions {
                let _ = session.close().await;
            }
            for runtime in runtimes {
                runtime.ipc_peer.lock().unwrap().take();
                runtime.bridge.terminate();
                let _ = std::fs::remove_dir_all(&runtime.temp_directory);
            }
        });
        *shutdown_promise = Some(promise);
        let _ = shutdown_promise.as_mut().unwrap().await;
    }
}

struct SpawnedBridge {
    bridge: Arc<ChildHandle>,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    /// fd 3 parent end; keep alive for the session lifetime.
    ipc_peer: std::os::unix::net::UnixStream,
}

fn create_pipe_cloexec() -> Result<(OwnedFd, OwnedFd), String> {
    let mut descriptors = [-1; 2];
    let result = unsafe { libc::pipe(descriptors.as_mut_ptr()) };
    if result != 0 {
        return Err(format!(
            "could not create bridge pipe: {}",
            std::io::Error::last_os_error()
        ));
    }
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    for descriptor in [&read, &write] {
        unsafe {
            libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    Ok((read, write))
}

fn spawn_direct_broker(
    invocation: &CuaDriverInvocation,
    control_path: &Path,
    launch_lease_path: &Path,
    environment: &HashMap<String, String>,
) -> Result<Arc<ChildHandle>, CuaDriverError> {
    use std::process::Stdio;
    let mut command = Command::new(&invocation.command);
    command
        .args(invocation.prefix_args.iter())
        .arg("--control-socket")
        .arg(control_path)
        .arg("--launch-lease-socket")
        .arg(launch_lease_path)
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|error| CuaDriverError::new("bridge_failed", format!("{error}")))?;
    Ok(ChildHandle::new(child))
}

async fn launch_broker_via_open(
    app_path: &Path,
    control_path: &Path,
    launch_lease_path: &Path,
    environment: &HashMap<String, String>,
    signal: Option<&CancellationToken>,
    timeout_ms: u64,
) -> Result<BoundedProcessResult, CuaDriverError> {
    let invocation = CuaDriverCommandInvocation::new("/usr/bin/open");
    let args: Vec<String> = vec![
        "-n".into(),
        "-g".into(),
        app_path.to_string_lossy().into_owned(),
        "--args".into(),
        "--control-socket".into(),
        control_path.to_string_lossy().into_owned(),
        "--launch-lease-socket".into(),
        launch_lease_path.to_string_lossy().into_owned(),
    ];
    run_command(&invocation, &args, environment, signal, timeout_ms).await
}

fn spawn_bridge(
    invocation: &CuaDriverInvocation,
    control_path: &Path,
    launch_lease_path: &Path,
    environment: &HashMap<String, String>,
) -> Result<(SpawnedBridge, tokio::fs::File), String> {
    use std::process::Stdio;
    // fd 3: IPC socketpair (Node's `ipc` stdio slot).
    let (ipc_peer, ipc_child) = std::os::unix::net::UnixStream::pair()
        .map_err(|error| format!("could not create bridge IPC socket: {error}"))?;
    // fd 4: readiness pipe.
    let (readiness_read, readiness_write) = create_pipe_cloexec()?;
    let readiness_read_file = unsafe { std::fs::File::from_raw_fd(readiness_read.into_raw_fd()) };

    let ipc_child_fd = ipc_child.as_raw_fd();
    let readiness_write_fd = readiness_write.as_raw_fd();
    let mut command = Command::new(&invocation.command);
    command
        .args(invocation.prefix_args.iter())
        .arg("--bridge")
        .arg("--control-socket")
        .arg(control_path)
        .arg("--launch-lease-socket")
        .arg(launch_lease_path)
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    // SAFETY: pre_exec runs after fork before exec; dup2 clears CLOEXEC on the
    // target descriptors so the bridge finds fd 3 and fd 4 exactly where Node
    // would have placed them.
    unsafe {
        command.pre_exec(move || {
            libc::dup2(ipc_child_fd, 3);
            libc::dup2(readiness_write_fd, 4);
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not spawn the Computer Use bridge: {error}"))?;
    drop(ipc_child);
    drop(readiness_write);

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "bridge stdin is unavailable".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "bridge stdout is unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "bridge stderr is unavailable".to_owned())?;
    let _ = stderr;
    Ok((
        SpawnedBridge {
            bridge: ChildHandle::new(child),
            stdin,
            stdout,
            ipc_peer,
        },
        tokio::fs::File::from_std(readiness_read_file),
    ))
}

/// Read the exact readiness frame from fd 4 (`{"type":"ready","protocolVersion":2}\n`),
/// bounded by the startup deadline and a 64 KiB byte cap.
async fn read_bridge_ready(
    readiness: tokio::fs::File,
    timeout_ms: u64,
    signal: Option<&CancellationToken>,
) -> Result<(), CuaDriverError> {
    if signal.is_some_and(|token| token.is_cancelled()) {
        return Err(cancelled_error("Computer Use startup was cancelled."));
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut reader = tokio::io::BufReader::new(readiness);
    let mut input: Vec<u8> = Vec::new();
    loop {
        if signal.is_some_and(|token| token.is_cancelled()) {
            return Err(cancelled_error("Computer Use startup was cancelled."));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(startup_timeout_error());
        }
        let mut chunk = [0_u8; 4096];
        let count = tokio::time::timeout(remaining, reader.read(&mut chunk))
            .await
            .map_err(|_| startup_timeout_error())?
            .map_err(|_| {
                CuaDriverError::new(
                    "bridge_invalid",
                    "Computer Use returned invalid startup data.",
                )
            })?;
        if count == 0 {
            return Err(CuaDriverError::retryable(
                "bridge_closed",
                "Aiden Computer Use closed its readiness channel before startup.",
            ));
        }
        input.extend_from_slice(&chunk[..count]);
        if input.len() as u64 > MAX_READY_BYTES {
            return Err(CuaDriverError::new(
                "bridge_invalid",
                "Computer Use returned too much startup data.",
            ));
        }
        if let Some(newline) = input.iter().position(|byte| *byte == b'\n') {
            let mut frame = &input[..newline];
            if frame.last() == Some(&b'\r') {
                frame = &frame[..frame.len() - 1];
            }
            if frame != READINESS_FRAME_NO_NEWLINE {
                return Err(CuaDriverError::new(
                    "bridge_invalid",
                    "Computer Use returned invalid startup data.",
                ));
            }
            return Ok(());
        }
    }
}
