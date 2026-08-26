//! The Computer Use host (port of `main/services/computer-use/host.ts`).
//!
//! macOS-only: spawns the signed broker (via `open` or a test invocation),
//! spawns the bridge with Node-compatible stdio (fd 3 = IPC socketpair, fd 4 =
//! readiness pipe), reads the exact `{"type":"ready","protocolVersion":2}`
//! readiness frame, and owns session cleanup.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::binary::verify_cua_driver_bridge_process;
use crate::contract::{
    build_cua_driver_environment, CuaDriverError, CuaDriverInvocation, CuaDriverManifest,
    CUA_DRIVER_TOOL_SCHEMA, CUA_DRIVER_VERSION,
};
const READINESS_FRAME_NO_NEWLINE: &[u8] = b"{\"type\":\"ready\",\"protocolVersion\":2}";
use crate::process::{
    apply_allowlisted_environment, run_command, BoundedProcessResult, ChildHandle,
    CuaDriverCommandInvocation,
};
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
    _temp_directory_guard: SessionDirectoryGuard,
    pub session: std::sync::Mutex<Option<std::sync::Weak<CuaDriverSession>>>,
    pub diagnostic: std::sync::Mutex<String>,
    pub stopping: AtomicBool,
}

struct SessionDirectoryGuard(PathBuf);

impl Drop for SessionDirectoryGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct HostShutdownCompletion {
    finished: std::sync::Mutex<bool>,
    completion: tokio::sync::Notify,
}

impl HostShutdownCompletion {
    async fn wait(&self) {
        loop {
            let mut completed = Box::pin(self.completion.notified());
            completed.as_mut().enable();
            if *self.finished.lock().unwrap() {
                return;
            }
            completed.await;
        }
    }

    fn finish(&self) {
        *self.finished.lock().unwrap() = true;
        self.completion.notify_waiters();
    }
}

#[derive(Default)]
struct HostLaunchCompletion {
    result: std::sync::Mutex<Option<Result<Arc<CuaDriverSession>, CuaDriverError>>>,
    completion: tokio::sync::Notify,
}

impl HostLaunchCompletion {
    async fn wait(&self) -> Result<Arc<CuaDriverSession>, CuaDriverError> {
        loop {
            let mut completed = Box::pin(self.completion.notified());
            completed.as_mut().enable();
            if let Some(result) = self.result.lock().unwrap().clone() {
                return result;
            }
            completed.await;
        }
    }

    fn finish(&self, result: Result<Arc<CuaDriverSession>, CuaDriverError>) {
        *self.result.lock().unwrap() = Some(result);
        self.completion.notify_waiters();
    }
}

struct HostLaunchAdmission {
    token: CancellationToken,
    completion: Arc<HostLaunchCompletion>,
}

#[derive(Default)]
struct HostAdmissionState {
    closed: bool,
    next_launch_id: u64,
    launches: HashMap<u64, HostLaunchAdmission>,
    shutdown: Option<Arc<HostShutdownCompletion>>,
}

struct HostLaunchLease {
    id: u64,
    token: CancellationToken,
    completion: Arc<HostLaunchCompletion>,
    admission: Arc<std::sync::Mutex<HostAdmissionState>>,
    completed: bool,
}

struct AbortTaskOnDrop(Option<tokio::task::JoinHandle<()>>);

impl AbortTaskOnDrop {
    async fn abort_and_wait(mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for AbortTaskOnDrop {
    fn drop(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
        }
    }
}

impl Drop for HostLaunchLease {
    fn drop(&mut self) {
        let mut admission = self.admission.lock().unwrap();
        if !self.completed {
            self.completion.finish(Err(CuaDriverError::retryable(
                "host_launch_failed",
                "Computer Use startup ended unexpectedly.",
            )));
        }
        admission.launches.remove(&self.id);
    }
}

impl HostLaunchLease {
    fn finish(mut self, result: Result<Arc<CuaDriverSession>, CuaDriverError>) {
        let mut admission = self.admission.lock().unwrap();
        self.completion.finish(result);
        admission.launches.remove(&self.id);
        self.completed = true;
    }
}

#[cfg(test)]
struct HostTestBarrier {
    release: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    reached: tokio::sync::Semaphore,
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

type VerifyBridgeFn = dyn Fn(
        u32,
        &Path,
        Option<&CancellationToken>,
    ) -> std::pin::Pin<
        Box<dyn futures::future::Future<Output = Result<(), CuaDriverError>> + Send>,
    > + Send
    + Sync;

/// The production host. Bridge verification is a seam the test harness
/// overrides; production always validates the exact live bridge process.
#[derive(Clone)]
pub struct CuaDriverHost {
    options: CuaDriverHostOptions,
    environment: HashMap<String, String>,
    manifest: Arc<std::sync::Mutex<Option<CuaDriverManifest>>>,
    sessions: Arc<std::sync::Mutex<Vec<Arc<CuaDriverSession>>>>,
    runtimes: Arc<std::sync::Mutex<Vec<Arc<SessionRuntime>>>>,
    admission: Arc<std::sync::Mutex<HostAdmissionState>>,
    verify_spawned_bridge: Option<Arc<VerifyBridgeFn>>,
    #[cfg(test)]
    after_initial_open_barrier: Arc<std::sync::Mutex<Option<Arc<HostTestBarrier>>>>,
    #[cfg(test)]
    after_spawn_before_connect_barrier: Arc<std::sync::Mutex<Option<Arc<HostTestBarrier>>>>,
    #[cfg(test)]
    connect_pending_barrier: Arc<std::sync::Mutex<Option<Arc<HostTestBarrier>>>>,
    #[cfg(test)]
    before_launch_publication_barrier: Arc<std::sync::Mutex<Option<Arc<HostTestBarrier>>>>,
    #[cfg(test)]
    before_registration_barrier: Arc<std::sync::Mutex<Option<Arc<HostTestBarrier>>>>,
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
            manifest: Arc::new(std::sync::Mutex::new(None)),
            sessions: Arc::new(std::sync::Mutex::new(Vec::new())),
            runtimes: Arc::new(std::sync::Mutex::new(Vec::new())),
            admission: Arc::new(std::sync::Mutex::new(HostAdmissionState::default())),
            verify_spawned_bridge: None,
            #[cfg(test)]
            after_initial_open_barrier: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            after_spawn_before_connect_barrier: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            connect_pending_barrier: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            before_launch_publication_barrier: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            before_registration_barrier: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Override bridge verification (tests only).
    pub fn set_verify_spawned_bridge(&mut self, verify: Box<VerifyBridgeFn>) {
        self.verify_spawned_bridge = Some(Arc::from(verify));
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
        let admission = self.admission.lock().unwrap();
        if admission.closed {
            return Err(CuaDriverError::new(
                "host_closed",
                "The Computer Use host has shut down.",
            ));
        }
        *self.manifest.lock().unwrap() = Some(CuaDriverManifest {
            schema_version: CUA_DRIVER_TOOL_SCHEMA.into(),
            binary_version: CUA_DRIVER_VERSION.into(),
        });
        drop(admission);
        Ok(())
    }

    fn assert_open(&self, signal: Option<&CancellationToken>) -> Result<(), CuaDriverError> {
        if self.admission.lock().unwrap().closed {
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

    fn admit_launch(
        &self,
        caller_signal: Option<&CancellationToken>,
    ) -> Result<HostLaunchLease, CuaDriverError> {
        let mut admission = self.admission.lock().unwrap();
        if admission.closed {
            return Err(CuaDriverError::new(
                "host_closed",
                "The Computer Use host has shut down.",
            ));
        }
        if caller_signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(cancelled_error("Computer Use startup was cancelled."));
        }
        admission.next_launch_id = admission.next_launch_id.wrapping_add(1).max(1);
        let id = admission.next_launch_id;
        let token = CancellationToken::new();
        let completion = Arc::new(HostLaunchCompletion::default());
        admission.launches.insert(
            id,
            HostLaunchAdmission {
                token: token.clone(),
                completion: Arc::clone(&completion),
            },
        );
        Ok(HostLaunchLease {
            id,
            token,
            completion,
            admission: Arc::clone(&self.admission),
            completed: false,
        })
    }

    #[cfg(test)]
    async fn wait_at_barrier(slot: &std::sync::Mutex<Option<Arc<HostTestBarrier>>>) {
        let barrier = slot.lock().unwrap().clone();
        if let Some(barrier) = barrier {
            barrier.reached.add_permits(1);
            if let Some(release) = barrier.release.lock().await.take() {
                let _ = release.await;
            }
        }
    }

    pub async fn create_session(
        &self,
        signal: Option<&CancellationToken>,
    ) -> Result<Arc<CuaDriverSession>, CuaDriverError> {
        let launch = self.admit_launch(signal)?;
        let completion = Arc::clone(&launch.completion);
        let host = self.clone();
        let caller_signal = signal.cloned();
        tokio::spawn(async move {
            let caller_forwarder = caller_signal.map(|caller| {
                let launch_token = launch.token.clone();
                AbortTaskOnDrop(Some(tokio::spawn(async move {
                    caller.cancelled().await;
                    launch_token.cancel();
                })))
            });
            let result = AssertUnwindSafe(host.create_session_admitted(&launch.token))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(CuaDriverError::retryable(
                        "host_launch_failed",
                        "Computer Use startup ended unexpectedly.",
                    ))
                });
            if let Some(caller_forwarder) = caller_forwarder {
                caller_forwarder.abort_and_wait().await;
            }
            #[cfg(test)]
            Self::wait_at_barrier(&host.before_launch_publication_barrier).await;
            launch.finish(result);
        });
        completion.wait().await
    }

    async fn create_session_admitted(
        &self,
        signal: &CancellationToken,
    ) -> Result<Arc<CuaDriverSession>, CuaDriverError> {
        self.start().await?;
        self.assert_open(Some(signal))?;
        #[cfg(test)]
        Self::wait_at_barrier(&self.after_initial_open_barrier).await;
        self.assert_open(Some(signal))?;
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
        // Own cleanup immediately: bridge verification and every later async
        // stage may panic or be cancelled before SessionRuntime exists.
        let temp_directory_guard = SessionDirectoryGuard(temp_directory.clone());
        let mut broker_launcher: Option<Arc<ChildHandle>> = None;

        let bridge = match self
            .create_session_internal(
                &control_path,
                &launch_lease_path,
                &mut broker_launcher,
                Some(signal),
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
            _temp_directory_guard: temp_directory_guard,
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
                    let session = runtime
                        .session
                        .lock()
                        .unwrap()
                        .as_ref()
                        .and_then(std::sync::Weak::upgrade);
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
        *runtime.session.lock().unwrap() = Some(Arc::downgrade(&session));

        #[cfg(test)]
        Self::wait_at_barrier(&self.after_spawn_before_connect_barrier).await;
        let connect_result = self.connect_session(&session, signal, deadline).await;
        if let Err(error) = connect_result {
            Self::cleanup_unregistered(&session, &runtime).await;
            return Err(error);
        }
        #[cfg(test)]
        Self::wait_at_barrier(&self.before_registration_barrier).await;
        // Registration is serialized against shutdown sealing/snapshotting.
        let rejection = {
            let admission = self.admission.lock().unwrap();
            if admission.closed {
                Some(CuaDriverError::new(
                    "host_closed",
                    "The Computer Use host has shut down.",
                ))
            } else if signal.is_cancelled() {
                Some(cancelled_error("Computer Use startup was cancelled."))
            } else {
                self.sessions.lock().unwrap().push(Arc::clone(&session));
                self.runtimes.lock().unwrap().push(Arc::clone(&runtime));
                None
            }
        };
        if let Some(error) = rejection {
            Self::cleanup_unregistered(&session, &runtime).await;
            return Err(error);
        }
        Ok(session)
    }

    async fn cleanup_unregistered(session: &Arc<CuaDriverSession>, runtime: &Arc<SessionRuntime>) {
        runtime.stopping.store(true, Ordering::SeqCst);
        session.close().await;
        runtime.session.lock().unwrap().take();
        runtime.ipc_peer.lock().unwrap().take();
        runtime.bridge.terminate();
        if let Some(launcher) = runtime.broker_launcher.as_ref() {
            launcher.terminate();
        }
        let _ = std::fs::remove_dir_all(&runtime.temp_directory);
    }

    async fn connect_session(
        &self,
        session: &Arc<CuaDriverSession>,
        signal: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), CuaDriverError> {
        let connect = session.connect(Some(signal), Some(deadline));
        #[cfg(test)]
        {
            use std::future::Future;
            use std::task::Poll;

            let mut connect = Box::pin(connect);
            let barrier = { self.connect_pending_barrier.lock().unwrap().clone() };
            if let Some(barrier) = barrier {
                let first = futures::future::poll_fn(|context| {
                    Poll::Ready(match connect.as_mut().poll(context) {
                        Poll::Ready(result) => Some(result),
                        Poll::Pending => None,
                    })
                })
                .await;
                if let Some(result) = first {
                    return result;
                }
                barrier.reached.add_permits(1);
                if let Some(release) = barrier.release.lock().await.take() {
                    let _ = release.await;
                }
            }
            return connect.await;
        }
        #[cfg(not(test))]
        connect.await
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
        let completion = {
            let mut admission = self.admission.lock().unwrap();
            if let Some(existing) = admission.shutdown.as_ref() {
                Arc::clone(existing)
            } else {
                admission.closed = true;
                let launches: Vec<Arc<HostLaunchCompletion>> = admission
                    .launches
                    .values()
                    .map(|launch| {
                        launch.token.cancel();
                        Arc::clone(&launch.completion)
                    })
                    .collect();
                let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
                let runtimes = std::mem::take(&mut *self.runtimes.lock().unwrap());
                *self.manifest.lock().unwrap() = None;
                let completion = Arc::new(HostShutdownCompletion::default());
                let completion_for_task = Arc::clone(&completion);
                tokio::spawn(async move {
                    let _ = AssertUnwindSafe(async move {
                        for launch in launches {
                            let _ = launch.wait().await;
                        }
                        for session in sessions {
                            session.close().await;
                        }
                        for runtime in runtimes {
                            runtime.stopping.store(true, Ordering::SeqCst);
                            runtime.session.lock().unwrap().take();
                            runtime.ipc_peer.lock().unwrap().take();
                            runtime.bridge.terminate();
                            if let Some(launcher) = runtime.broker_launcher.as_ref() {
                                launcher.terminate();
                            }
                            let _ = std::fs::remove_dir_all(&runtime.temp_directory);
                        }
                    })
                    .catch_unwind()
                    .await;
                    completion_for_task.finish();
                });
                admission.shutdown = Some(Arc::clone(&completion));
                completion
            }
        };
        completion.wait().await;
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
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_allowlisted_environment(&mut command, environment);
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
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    apply_allowlisted_environment(&mut command, environment);
    // Node's `ipc` stdio slot sets these fixed protocol variables in addition
    // to placing the channel at fd 3. They are not inherited caller input.
    command
        .env("NODE_CHANNEL_FD", "3")
        .env("NODE_CHANNEL_SERIALIZATION_MODE", "json");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn inert_options(temp_root: &Path) -> CuaDriverHostOptions {
        CuaDriverHostOptions {
            invocation: CuaDriverInvocation::new("/definitely/not/a/driver"),
            base_env: None,
            temp_root: Some(temp_root.to_path_buf()),
            startup_timeout_ms: Some(3_000),
            broker: BrokerOptions {
                app_path: PathBuf::from("/definitely/not/a/helper.app"),
            },
            direct_broker: None,
        }
    }

    fn install_barrier(
        slot: &std::sync::Mutex<Option<Arc<HostTestBarrier>>>,
    ) -> (tokio::sync::oneshot::Sender<()>, Arc<HostTestBarrier>) {
        let (release, receiver) = tokio::sync::oneshot::channel();
        let barrier = Arc::new(HostTestBarrier {
            release: tokio::sync::Mutex::new(Some(receiver)),
            reached: tokio::sync::Semaphore::new(0),
        });
        *slot.lock().unwrap() = Some(Arc::clone(&barrier));
        (release, barrier)
    }

    fn assert_host_resources_drained(host: &CuaDriverHost, root: &Path) {
        assert!(host.sessions.lock().unwrap().is_empty());
        assert!(host.runtimes.lock().unwrap().is_empty());
        assert!(host.admission.lock().unwrap().launches.is_empty());
        assert!(!host.running());
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn sequential_shutdowns_share_completed_state_without_repolling() {
        let root = tempfile::TempDir::new().unwrap();
        let host = CuaDriverHost::new(inert_options(root.path()));

        host.shutdown().await;
        let first = host
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");
        host.shutdown().await;
        let second = host
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");

        assert!(Arc::ptr_eq(&first, &second));
        assert!(*first.finished.lock().unwrap());
    }

    #[tokio::test]
    async fn concurrent_shutdowns_share_one_completion() {
        let root = tempfile::TempDir::new().unwrap();
        let host = Arc::new(CuaDriverHost::new(inert_options(root.path())));
        let first = Arc::clone(&host);
        let second = Arc::clone(&host);

        tokio::time::timeout(Duration::from_secs(1), async move {
            tokio::join!(first.shutdown(), second.shutdown());
        })
        .await
        .expect("concurrent shutdowns must complete");

        let admission = host.admission.lock().unwrap();
        assert!(admission.closed);
        assert_eq!(admission.launches.len(), 0);
        assert!(*admission
            .shutdown
            .as_ref()
            .expect("shutdown completion")
            .finished
            .lock()
            .unwrap());
    }

    #[tokio::test]
    async fn shutdown_seals_a_launch_paused_after_initial_open() {
        let root = tempfile::TempDir::new().unwrap();
        let host = Arc::new(CuaDriverHost::new(inert_options(root.path())));
        let (release, barrier) = install_barrier(&host.after_initial_open_barrier);
        let launch_host = Arc::clone(&host);
        let launch = tokio::spawn(async move { launch_host.create_session(None).await });
        barrier.reached.acquire().await.unwrap().forget();

        let shutdown_host = Arc::clone(&host);
        let shutdown = tokio::spawn(async move { shutdown_host.shutdown().await });
        while !host.admission.lock().unwrap().closed {
            tokio::task::yield_now().await;
        }
        release.send(()).unwrap();
        let error = match launch.await.unwrap() {
            Ok(_) => panic!("sealed launch must fail"),
            Err(error) => error,
        };
        assert_eq!(error.code, "host_closed");
        tokio::time::timeout(Duration::from_secs(1), shutdown)
            .await
            .expect("shutdown must drain the reserved launch")
            .unwrap();

        assert!(host.sessions.lock().unwrap().is_empty());
        assert!(host.runtimes.lock().unwrap().is_empty());
        assert!(host.admission.lock().unwrap().launches.is_empty());
    }

    fn fake_driver_host(temp_root: &Path) -> Option<CuaDriverHost> {
        let node = std::process::Command::new("/usr/bin/which")
            .arg("node")
            .output()
            .ok()?;
        if !node.status.success() {
            return None;
        }
        let node = String::from_utf8(node.stdout).ok()?.trim().to_string();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../main/services/computer-use/fixtures/fake-cua-driver.mjs");
        let invocation = CuaDriverInvocation {
            command: PathBuf::from(node),
            prefix_args: vec![fixture.to_string_lossy().into_owned()],
        };
        let mut host = CuaDriverHost::new(CuaDriverHostOptions {
            invocation: invocation.clone(),
            base_env: None,
            temp_root: Some(temp_root.to_path_buf()),
            startup_timeout_ms: Some(5_000),
            broker: BrokerOptions {
                app_path: PathBuf::from("/test/CuaDriver.app"),
            },
            direct_broker: Some(invocation),
        });
        host.set_verify_spawned_bridge(Box::new(|_, _, _| Box::pin(async { Ok(()) })));
        Some(host)
    }

    #[tokio::test]
    async fn shutdown_between_connect_and_registration_cleans_unregistered_resources() {
        let root = tempfile::TempDir::new().unwrap();
        let Some(host) = fake_driver_host(root.path()) else {
            return;
        };
        let host = Arc::new(host);
        let (release, barrier) = install_barrier(&host.before_registration_barrier);
        let launch_host = Arc::clone(&host);
        let mut launch = tokio::spawn(async move { launch_host.create_session(None).await });
        tokio::select! {
            permit = barrier.reached.acquire() => permit.unwrap().forget(),
            result = &mut launch => match result.unwrap() {
                Ok(_) => panic!("session returned before registration barrier"),
                Err(error) => panic!("session failed before registration barrier: {}", error.code),
            },
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                panic!("fake driver did not reach registration barrier")
            }
        }
        assert!(host.sessions.lock().unwrap().is_empty());
        assert!(host.runtimes.lock().unwrap().is_empty());

        let shutdown_host = Arc::clone(&host);
        let shutdown = tokio::spawn(async move { shutdown_host.shutdown().await });
        while !host.admission.lock().unwrap().closed {
            tokio::task::yield_now().await;
        }
        release.send(()).unwrap();
        let error = match launch.await.unwrap() {
            Ok(_) => panic!("sealed registration must fail"),
            Err(error) => error,
        };
        assert_eq!(error.code, "host_closed");
        tokio::time::timeout(Duration::from_secs(5), shutdown)
            .await
            .expect("shutdown must await unregistered cleanup")
            .unwrap();

        assert!(host.sessions.lock().unwrap().is_empty());
        assert!(host.runtimes.lock().unwrap().is_empty());
        assert!(host.admission.lock().unwrap().launches.is_empty());
        assert!(!host.running());
    }

    #[tokio::test]
    async fn aborting_caller_after_spawn_cannot_escape_shutdown_drain() {
        let root = tempfile::TempDir::new().unwrap();
        let Some(host) = fake_driver_host(root.path()) else {
            return;
        };
        let host = Arc::new(host);
        let (release, barrier) = install_barrier(&host.after_spawn_before_connect_barrier);
        let launch_host = Arc::clone(&host);
        let launch = tokio::spawn(async move { launch_host.create_session(None).await });
        tokio::time::timeout(Duration::from_secs(5), barrier.reached.acquire())
            .await
            .expect("launch must spawn bridge before caller abort")
            .unwrap()
            .forget();

        launch.abort();
        let _ = launch.await;
        assert_eq!(host.admission.lock().unwrap().launches.len(), 1);

        let shutdown_host = Arc::clone(&host);
        let shutdown = tokio::spawn(async move { shutdown_host.shutdown().await });
        while !host.admission.lock().unwrap().closed {
            tokio::task::yield_now().await;
        }
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), shutdown)
            .await
            .expect("shutdown must drain caller-abandoned spawned resources")
            .unwrap();
        let first = host
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");
        host.shutdown().await;
        let second = host
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");

        assert!(Arc::ptr_eq(&first, &second));
        assert_host_resources_drained(&host, root.path());
    }

    #[tokio::test]
    async fn aborting_caller_during_connect_cannot_escape_shutdown_drain() {
        let root = tempfile::TempDir::new().unwrap();
        let Some(host) = fake_driver_host(root.path()) else {
            return;
        };
        let host = Arc::new(host);
        let (release, barrier) = install_barrier(&host.connect_pending_barrier);
        let launch_host = Arc::clone(&host);
        let launch = tokio::spawn(async move { launch_host.create_session(None).await });
        tokio::time::timeout(Duration::from_secs(5), barrier.reached.acquire())
            .await
            .expect("session connect must be observably pending")
            .unwrap()
            .forget();

        launch.abort();
        let _ = launch.await;
        assert_eq!(host.admission.lock().unwrap().launches.len(), 1);

        let shutdown_host = Arc::clone(&host);
        let shutdown = tokio::spawn(async move { shutdown_host.shutdown().await });
        while !host.admission.lock().unwrap().closed {
            tokio::task::yield_now().await;
        }
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), shutdown)
            .await
            .expect("shutdown must drain caller-abandoned pending connect")
            .unwrap();
        let first = host
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");
        host.shutdown().await;
        let second = host
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");

        assert!(Arc::ptr_eq(&first, &second));
        assert_host_resources_drained(&host, root.path());
    }

    #[tokio::test]
    async fn shutdown_cannot_finish_while_launch_result_publication_is_paused() {
        let root = tempfile::TempDir::new().unwrap();
        let host = Arc::new(CuaDriverHost::new(inert_options(root.path())));
        let (release, barrier) = install_barrier(&host.before_launch_publication_barrier);
        let launch_host = Arc::clone(&host);
        let launch = tokio::spawn(async move { launch_host.create_session(None).await });
        barrier.reached.acquire().await.unwrap().forget();

        let launch_completion = host
            .admission
            .lock()
            .unwrap()
            .launches
            .values()
            .next()
            .map(|launch| Arc::clone(&launch.completion))
            .expect("launch remains admitted until its result is published");
        assert!(launch_completion.result.lock().unwrap().is_none());

        let shutdown_host = Arc::clone(&host);
        let shutdown = tokio::spawn(async move { shutdown_host.shutdown().await });
        while !host.admission.lock().unwrap().closed {
            tokio::task::yield_now().await;
        }
        let shutdown_completion = host
            .admission
            .lock()
            .unwrap()
            .shutdown
            .clone()
            .expect("shutdown completion");
        assert!(!*shutdown_completion.finished.lock().unwrap());
        assert!(launch_completion.result.lock().unwrap().is_none());

        release.send(()).unwrap();
        let error = match launch.await.unwrap() {
            Ok(_) => panic!("missing driver launch must fail"),
            Err(error) => error,
        };
        assert_ne!(error.code, "host_launch_failed");
        tokio::time::timeout(Duration::from_secs(1), shutdown)
            .await
            .expect("shutdown must join publication")
            .unwrap();
        assert!(launch_completion.result.lock().unwrap().is_some());
        assert_host_resources_drained(&host, root.path());
    }

    #[tokio::test]
    async fn panicking_bridge_verifier_cannot_leak_pre_runtime_temp_resources() {
        let root = tempfile::TempDir::new().unwrap();
        let Some(mut host) = fake_driver_host(root.path()) else {
            return;
        };
        host.set_verify_spawned_bridge(Box::new(|_, _, _| {
            Box::pin(async { panic!("injected bridge verifier panic") })
        }));
        let host = Arc::new(host);

        let error = match host.create_session(None).await {
            Ok(_) => panic!("panicking verification must reject startup"),
            Err(error) => error,
        };
        assert_eq!(error.code, "host_launch_failed");
        host.shutdown().await;

        assert_host_resources_drained(&host, root.path());
    }
}
