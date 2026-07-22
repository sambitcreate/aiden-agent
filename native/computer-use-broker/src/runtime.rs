use crate::driver::prepare_driver_launcher;
use crate::guard;
use crate::jsonrpc::{
    process_client_message, process_driver_message, ClientMessage, MAX_CLIENT_MESSAGE_BYTES,
    MAX_DRIVER_MESSAGE_BYTES,
};
use crate::lines::{write_line, BoundedLines};
use crate::signing::{
    prepare_pinned_driver, verify_aiden_peer, verify_helper_peer, verify_live_driver,
};
use crate::socket::{
    bind_control, bind_launch_lease, peer_audit_token, validate_control_connect_target,
    validate_launch_lease_connect_target,
};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: u64 = 2;
const MAX_BROKER_ERROR_BYTES: usize = 512;
const MAX_INTERNAL_FRAME_BYTES: usize = 1024;
const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const READINESS: &[u8] = b"{\"type\":\"ready\",\"protocolVersion\":2}\n";
const BROKER_SUPERVISION_ACK: &[u8] =
    b"{\"type\":\"broker-supervision-armed\",\"protocolVersion\":2}\n";
const CONTAINMENT_GUARD_ARMED: &[u8] =
    b"{\"type\":\"containment-guard-armed\",\"protocolVersion\":2}\n";
const SUPERVISION_ACK: &[u8] = b"{\"type\":\"supervision-armed\",\"protocolVersion\":2}\n";
const BROKER_READY: &[u8] = b"{\"type\":\"broker-ready\",\"protocolVersion\":2}\n";

static ACTIVE_CONTROL_FD: AtomicI32 = AtomicI32::new(-1);

extern "C" fn termination_signal(_signal: libc::c_int) {
    let control = ACTIVE_CONTROL_FD.load(Ordering::Relaxed);
    if control >= 0 {
        // SAFETY: shutdown is async-signal-safe. A stale/closed fd can only fail.
        unsafe { libc::shutdown(control, libc::SHUT_RDWR) };
    }
}

fn install_signal_boundary() -> Result<(), String> {
    // SAFETY: zeroed sigaction is filled before registration.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = termination_signal as *const () as libc::sighandler_t;
    action.sa_flags = 0;
    // SAFETY: action owns a writable signal mask.
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM] {
        // SAFETY: action contains a valid one-argument signal handler.
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(format!(
                "could not install lifecycle signal handler: {}",
                io::Error::last_os_error()
            ));
        }
    }
    // SAFETY: ignoring SIGPIPE converts peer closure into ordinary write errors.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
    Ok(())
}

fn set_cloexec(descriptor: RawFd) -> Result<(), String> {
    // SAFETY: descriptor is live; F_GETFD has no third argument.
    let current = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if current < 0 {
        return Err(format!(
            "required inherited descriptor is unavailable: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: descriptor is live and flags came from F_GETFD.
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, current | libc::FD_CLOEXEC) } != 0 {
        return Err(format!(
            "could not protect inherited descriptor: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn write_readiness(mut writer: impl Write) -> Result<(), String> {
    writer
        .write_all(READINESS)
        .and_then(|()| writer.flush())
        .map_err(|error| format!("could not report bridge readiness: {error}"))
}

fn exact_frame(input: &[u8], expected_type: &str) -> Result<(), String> {
    let value: Value =
        serde_json::from_slice(input).map_err(|_| "malformed internal broker frame".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "internal broker frame is not an object".to_owned())?;
    if object.len() != 2
        || object.get("type") != Some(&Value::String(expected_type.to_owned()))
        || object.get("protocolVersion") != Some(&Value::from(PROTOCOL_VERSION))
    {
        return Err("unexpected internal broker frame".to_owned());
    }
    Ok(())
}

fn constrained_frame(pid: u32, containment_pgid: u32) -> Result<Vec<u8>, String> {
    let mut output = serde_json::to_vec(&serde_json::json!({
        "type": "driver-constrained",
        "protocolVersion": PROTOCOL_VERSION,
        "driverPid": pid,
        "containmentPgid": containment_pgid,
    }))
    .map_err(|_| "could not serialize supervision frame".to_owned())?;
    output.push(b'\n');
    Ok(output)
}

fn bounded_broker_error(error: &str) -> String {
    let mut output = String::new();
    for character in error.chars() {
        if output.len() + character.len_utf8() > MAX_BROKER_ERROR_BYTES {
            break;
        }
        output.push(character);
    }
    if output.is_empty() {
        "privileged broker startup failed".to_owned()
    } else {
        output
    }
}

fn broker_error_frame(error: &str) -> Result<Vec<u8>, String> {
    let mut output = serde_json::to_vec(&serde_json::json!({
        "type": "broker-error",
        "protocolVersion": PROTOCOL_VERSION,
        "message": bounded_broker_error(error),
    }))
    .map_err(|_| "could not serialize broker error frame".to_owned())?;
    output.push(b'\n');
    Ok(output)
}

fn parse_broker_error(input: &[u8]) -> Result<Option<String>, String> {
    let value: Value = serde_json::from_slice(input)
        .map_err(|_| "malformed internal broker response".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "internal broker response is not an object".to_owned())?;
    if object.get("type") != Some(&Value::String("broker-error".to_owned())) {
        return Ok(None);
    }
    if object.len() != 3 || object.get("protocolVersion") != Some(&Value::from(PROTOCOL_VERSION)) {
        return Err("unexpected broker error frame".to_owned());
    }
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty() && message.len() <= MAX_BROKER_ERROR_BYTES)
        .ok_or_else(|| "invalid broker error message".to_owned())?;
    Ok(Some(message.to_owned()))
}

fn parse_constrained_frame(input: &[u8]) -> Result<(u32, u32), String> {
    let value: Value = serde_json::from_slice(input)
        .map_err(|_| "malformed driver supervision frame".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "driver supervision frame is not an object".to_owned())?;
    if object.len() != 4
        || object.get("type") != Some(&Value::String("driver-constrained".to_owned()))
        || object.get("protocolVersion") != Some(&Value::from(PROTOCOL_VERSION))
    {
        return Err("unexpected driver supervision frame".to_owned());
    }
    let pid = object
        .get("driverPid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
        .ok_or_else(|| "invalid supervised driver process group".to_owned())?;
    let containment_pgid = object
        .get("containmentPgid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
        .ok_or_else(|| "invalid broker containment process group".to_owned())?;
    Ok((pid, containment_pgid))
}

fn become_containment_group_leader() -> Result<libc::pid_t, String> {
    // SAFETY: getpid/getpgrp have no preconditions.
    let pid = unsafe { libc::getpid() };
    let mut group = unsafe { libc::getpgrp() };
    if group != pid {
        // SAFETY: pid zero targets this process and pgid zero requests its PID.
        if unsafe { libc::setpgid(0, 0) } != 0 {
            return Err(format!(
                "could not isolate broker process group: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: getpgrp has no preconditions.
        group = unsafe { libc::getpgrp() };
    }
    if pid <= 1 || group != pid {
        return Err("broker is not its containment process-group leader".to_owned());
    }
    Ok(pid)
}

fn assert_containment_group(pid: u32) -> Result<(), String> {
    if pid <= 1 {
        return Err("invalid broker containment PID".to_owned());
    }
    // SAFETY: pid was derived from a validated LOCAL_PEERTOKEN and getpgid is read-only.
    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
    if group == pid as libc::pid_t {
        Ok(())
    } else if group < 0 {
        Err(format!(
            "could not inspect broker process group: {}",
            io::Error::last_os_error()
        ))
    } else {
        Err("authenticated broker is not its containment group leader".to_owned())
    }
}

fn assert_aiden_is_direct_parent(aiden_pid: u32) -> Result<(), String> {
    // SAFETY: getppid has no preconditions and returns the bridge's current
    // kernel parent. The already-validated audit token pins aiden_pid to one
    // exact process incarnation rather than a reusable numeric identity.
    let parent = unsafe { libc::getppid() };
    if parent == aiden_pid as libc::pid_t {
        Ok(())
    } else {
        Err("authenticated Aiden peer is not the bridge's direct parent".to_owned())
    }
}

fn assert_process_in_group(pid: u32, expected_pgid: u32) -> Result<(), String> {
    if pid <= 1 || expected_pgid <= 1 {
        return Err("invalid process-group assertion".to_owned());
    }
    // SAFETY: pid is dynamically authenticated and getpgid is read-only.
    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
    if group == expected_pgid as libc::pid_t {
        Ok(())
    } else if group < 0 {
        Err(format!(
            "could not inspect authenticated process group: {}",
            io::Error::last_os_error()
        ))
    } else {
        Err("authenticated process is outside the containment group".to_owned())
    }
}

fn accept_peer_with<F>(
    listener: &UnixListener,
    timeout: Duration,
    description: &str,
    mut authenticate: F,
) -> Result<UnixStream, String>
where
    F: FnMut(&UnixStream) -> bool,
{
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("could not configure control listener: {error}"))?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, _)) => {
                if authenticate(&stream) {
                    stream.set_nonblocking(false).map_err(|error| {
                        format!("could not configure authenticated peer: {error}")
                    })?;
                    return Ok(stream);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("control accept failed: {error}")),
        }
    }
    Err(format!("timed out waiting for {description}"))
}

fn connect_confined_socket_until(
    path: &Path,
    deadline: Instant,
    description: &str,
    validate: fn(&Path) -> Result<(), String>,
) -> Result<UnixStream, String> {
    while Instant::now() < deadline {
        match fs::symlink_metadata(path) {
            Ok(_) => validate(path)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(error) => return Err(format!("could not inspect {description}: {error}")),
        }
        match UnixStream::connect(path) {
            Ok(stream) => return Ok(stream),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) =>
            {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("could not connect to {description}: {error}")),
        }
    }
    Err(format!("timed out waiting for {description}"))
}

fn accept_authenticated_bridge(listener: &UnixListener) -> Result<UnixStream, String> {
    accept_peer_with(
        listener,
        AUTHENTICATION_TIMEOUT,
        "Aiden's authenticated bridge",
        |stream| {
            peer_audit_token(stream)
                .map_err(|error| error.to_string())
                .and_then(|token| verify_helper_peer(&token))
                .is_ok()
        },
    )
}

fn accept_authenticated_bridge_lease(listener: &UnixListener) -> Result<UnixStream, String> {
    accept_peer_with(
        listener,
        AUTHENTICATION_TIMEOUT,
        "authenticated bridge launch lease",
        |stream| {
            peer_audit_token(stream)
                .map_err(|error| error.to_string())
                .and_then(|token| verify_helper_peer(&token))
                .is_ok()
        },
    )
}

fn lock_writer(
    writer: &Arc<Mutex<UnixStream>>,
) -> Result<std::sync::MutexGuard<'_, UnixStream>, String> {
    writer
        .lock()
        .map_err(|_| "control writer lock was poisoned".to_owned())
}

fn relay_client_to_driver(
    mut reader: BoundedLines<UnixStream>,
    mut driver_input: File,
    control_writer: Arc<Mutex<UnixStream>>,
    pending_tool_lists: Arc<Mutex<HashSet<String>>>,
) -> Result<(), String> {
    while let Some(line) = reader
        .next(MAX_CLIENT_MESSAGE_BYTES)
        .map_err(|error| format!("invalid client MCP framing: {error}"))?
    {
        let message = {
            let mut pending = pending_tool_lists
                .lock()
                .map_err(|_| "pending request state was poisoned".to_owned())?;
            process_client_message(&line, &mut pending)?
        };
        match message {
            ClientMessage::Forward(bytes) => write_line(&mut driver_input, &bytes)
                .map_err(|error| format!("could not relay MCP request: {error}"))?,
            ClientMessage::Respond(bytes) => {
                let mut writer = lock_writer(&control_writer)?;
                write_line(&mut *writer, &bytes)
                    .map_err(|error| format!("could not send local MCP denial: {error}"))?;
            }
            ClientMessage::Drop => {}
        }
    }
    Ok(())
}

fn relay_driver_to_bridge(
    driver_output: File,
    control_writer: Arc<Mutex<UnixStream>>,
    pending_tool_lists: Arc<Mutex<HashSet<String>>>,
) -> Result<(), String> {
    let mut reader = BoundedLines::new(driver_output);
    while let Some(line) = reader
        .next(MAX_DRIVER_MESSAGE_BYTES)
        .map_err(|error| format!("invalid cua-driver MCP framing: {error}"))?
    {
        let canonical = {
            let mut pending = pending_tool_lists
                .lock()
                .map_err(|_| "pending request state was poisoned".to_owned())?;
            process_driver_message(&line, &mut pending)?
        };
        let mut writer = lock_writer(&control_writer)?;
        write_line(&mut *writer, &canonical)
            .map_err(|error| format!("could not relay cua-driver response: {error}"))?;
    }
    Ok(())
}

pub(crate) fn run_broker(control_path: &Path, launch_lease_path: &Path) -> Result<(), String> {
    let broker_pgid = become_containment_group_leader()?;
    // Fork the dormant launcher before any Foundation/Security API or thread.
    // Its watchdog later occupies the exact constrained driver's private group.
    let launcher = prepare_driver_launcher()?;
    // Fork the occupied broker guard before Security.framework is first used.
    // Its private liveness pipe is armed only after the exact signed bridge
    // connects to the broker-owned one-shot lease listener.
    let mut containment_guard = guard::start(broker_pgid, AUTHENTICATION_TIMEOUT)?;
    let launch_lease_listener = bind_launch_lease(launch_lease_path)?;
    let launch_lease = accept_authenticated_bridge_lease(&launch_lease_listener)?;
    let lease_bridge_token = peer_audit_token(&launch_lease)
        .map_err(|error| format!("could not retain bridge lease identity: {error}"))?;
    verify_helper_peer(&lease_bridge_token)?;
    drop(launch_lease_listener);
    set_cloexec(launch_lease.as_raw_fd())?;
    containment_guard.monitor_liveness(launch_lease)?;
    let listener = bind_control(control_path)?;
    let mut control = match accept_authenticated_bridge(&listener) {
        Ok(stream) => stream,
        Err(error) => {
            drop(listener);
            return Err(error);
        }
    };
    let control_bridge_token = peer_audit_token(&control)
        .map_err(|error| format!("could not retain control bridge identity: {error}"))?;
    verify_helper_peer(&control_bridge_token)?;
    if control_bridge_token != lease_bridge_token {
        return Err(
            "launch lease and control sockets belong to different bridge instances".to_owned(),
        );
    }
    drop(listener);
    ACTIVE_CONTROL_FD.store(control.as_raw_fd(), Ordering::SeqCst);
    install_signal_boundary()?;
    let mut startup_error_control = control
        .try_clone()
        .map_err(|error| format!("could not clone startup error channel: {error}"))?;
    let mut broker_ready_sent = false;
    let result = (|| -> Result<(), String> {
        control
            .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
            .and_then(|()| control.set_write_timeout(Some(HANDSHAKE_TIMEOUT)))
            .map_err(|error| format!("could not bound broker handshake: {error}"))?;
        let reader_stream = control
            .try_clone()
            .map_err(|error| format!("could not clone control socket: {error}"))?;
        let mut control_reader = BoundedLines::new(reader_stream);
        let broker_acknowledgement = control_reader
            .next(MAX_INTERNAL_FRAME_BYTES)
            .map_err(|error| format!("could not read broker supervision acknowledgement: {error}"))?
            .ok_or_else(|| "bridge closed before arming broker supervision".to_owned())?;
        exact_frame(&broker_acknowledgement, "broker-supervision-armed")?;
        write_line(&mut control, CONTAINMENT_GUARD_ARMED)
            .map_err(|error| format!("could not confirm containment guard: {error}"))?;

        let pinned = prepare_pinned_driver()?;
        let mut driver = launcher.launch(&pinned)?;

        write_line(
            &mut control,
            &constrained_frame(driver.pid(), driver.pgid())?,
        )
        .map_err(|error| format!("could not send supervision frame: {error}"))?;
        let acknowledgement = control_reader
            .next(MAX_INTERNAL_FRAME_BYTES)
            .map_err(|error| format!("could not read supervision acknowledgement: {error}"))?
            .ok_or_else(|| "bridge closed before arming driver supervision".to_owned())?;
        exact_frame(&acknowledgement, "supervision-armed")?;

        write_line(&mut control, BROKER_READY)
            .map_err(|error| format!("could not send broker readiness: {error}"))?;
        broker_ready_sent = true;
        control
            .set_read_timeout(None)
            .and_then(|()| control.set_write_timeout(None))
            .map_err(|error| format!("could not configure broker relay: {error}"))?;

        let writer = Arc::new(Mutex::new(control));
        let pending = Arc::new(Mutex::new(HashSet::new()));
        let driver_input = driver
            .input
            .take()
            .ok_or_else(|| "driver input pipe is unavailable".to_owned())?;
        let driver_output = driver
            .output
            .take()
            .ok_or_else(|| "driver output pipe is unavailable".to_owned())?;
        let input_writer = Arc::clone(&writer);
        let input_pending = Arc::clone(&pending);
        let input_thread = thread::spawn(move || {
            let result = relay_client_to_driver(
                control_reader,
                driver_input,
                Arc::clone(&input_writer),
                input_pending,
            );
            if let Ok(stream) = input_writer.lock() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            result
        });

        let output_result = relay_driver_to_bridge(driver_output, Arc::clone(&writer), pending);
        if let Ok(stream) = writer.lock() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        let input_result = input_thread
            .join()
            .map_err(|_| "client relay thread panicked".to_owned())?;
        driver.terminate_and_reap();
        output_result.and(input_result)
    })();
    ACTIVE_CONTROL_FD.store(-1, Ordering::SeqCst);
    if let Err(error) = &result {
        if !broker_ready_sent {
            if let Ok(frame) = broker_error_frame(error) {
                let _ = startup_error_control.write_all(&frame);
                let _ = startup_error_control.flush();
                let _ = startup_error_control.shutdown(std::net::Shutdown::Write);
            }
        }
    }
    // Closing the only death-pipe writer arms the private guard's safe group
    // TERM→KILL path. The guard remains an occupied group lease throughout;
    // this broker never reuses a delayed numeric PGID itself.
    drop(containment_guard);
    let _ = result;
    thread::sleep(Duration::from_secs(2));
    // SAFETY: reached only if the occupied containment guard unexpectedly
    // failed to terminate this broker group.
    unsafe { libc::_exit(1) };
}

struct BridgeSupervisor {
    _verified_driver_pid: Option<u32>,
    control: UnixStream,
    launch_lease: UnixStream,
}

impl Drop for BridgeSupervisor {
    fn drop(&mut self) {
        // Socket closure is the only bridge teardown authority. The broker's
        // private guard owns its group, and the launcher's independent
        // watchdog plus launcher occupy the driver's containment group; the bridge never
        // retains a recyclable numeric PID or PGID.
        let _ = self.control.shutdown(std::net::Shutdown::Both);
        let _ = self.launch_lease.shutdown(std::net::Shutdown::Both);
        ACTIVE_CONTROL_FD.store(-1, Ordering::SeqCst);
    }
}

fn inherited_ipc() -> Result<UnixStream, String> {
    set_cloexec(3)?;
    // SAFETY: fd 3 is exclusively assigned to this child by Node's `ipc` stdio slot.
    Ok(unsafe { UnixStream::from_raw_fd(3) })
}

fn inherited_readiness() -> Result<File, String> {
    set_cloexec(4)?;
    // SAFETY: fd 4 is exclusively assigned to this child as the readiness pipe.
    Ok(unsafe { File::from_raw_fd(4) })
}

fn relay_bridge_input(mut control: UnixStream) -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = BoundedLines::new(stdin.lock());
    while let Some(line) = reader
        .next(MAX_CLIENT_MESSAGE_BYTES)
        .map_err(|error| format!("invalid Aiden MCP framing: {error}"))?
    {
        control
            .write_all(&line)
            .and_then(|()| control.write_all(b"\n"))
            .and_then(|()| control.flush())
            .map_err(|error| format!("could not relay Aiden MCP request: {error}"))?;
    }
    let _ = control.shutdown(std::net::Shutdown::Write);
    Ok(())
}

fn relay_bridge_output(mut reader: BoundedLines<UnixStream>) -> Result<(), String> {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    let mut no_pending = HashSet::new();
    while let Some(line) = reader
        .next(MAX_DRIVER_MESSAGE_BYTES)
        .map_err(|error| format!("invalid broker MCP framing: {error}"))?
    {
        let canonical = process_driver_message(&line, &mut no_pending)?;
        write_line(&mut stdout, &canonical)
            .map_err(|error| format!("could not relay MCP response to Aiden: {error}"))?;
    }
    Ok(())
}

fn wait_for_aiden_eof(mut ipc: UnixStream) {
    let mut buffer = [0_u8; 256];
    loop {
        match ipc.read(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn monitor_aiden_liveness(ipc: UnixStream) -> ! {
    wait_for_aiden_eof(ipc);
    // fd 3 is the kernel-authenticated direct-parent channel. Exiting the
    // complete bridge process immediately closes any broker lease/control
    // sockets already acquired, including while Security.framework is stalled.
    // SAFETY: _exit terminates the process without running thread-unsafe cleanup.
    unsafe { libc::_exit(80) }
}

pub(crate) fn run_bridge(control_path: &Path, launch_lease_path: &Path) -> Result<(), String> {
    let ipc = inherited_ipc()?;
    let readiness = inherited_readiness()?;
    let aiden_token =
        peer_audit_token(&ipc).map_err(|error| format!("could not authenticate Aiden: {error}"))?;
    let aiden_pid = aiden_token.pid()?;
    assert_aiden_is_direct_parent(aiden_pid)?;
    thread::spawn(move || monitor_aiden_liveness(ipc));
    verify_aiden_peer(&aiden_token)?;

    let broker_deadline = Instant::now() + AUTHENTICATION_TIMEOUT;
    let launch_lease = connect_confined_socket_until(
        launch_lease_path,
        broker_deadline,
        "privileged broker lease",
        validate_launch_lease_connect_target,
    )?;
    let lease_broker_token = peer_audit_token(&launch_lease)
        .map_err(|error| format!("could not authenticate lease broker: {error}"))?;
    verify_helper_peer(&lease_broker_token)?;
    let broker_pid = lease_broker_token.pid()?;
    assert_containment_group(broker_pid)?;

    let mut control = connect_confined_socket_until(
        control_path,
        broker_deadline,
        "privileged broker control socket",
        validate_control_connect_target,
    )?;
    let control_broker_token = peer_audit_token(&control)
        .map_err(|error| format!("could not authenticate broker: {error}"))?;
    verify_helper_peer(&control_broker_token)?;
    if control_broker_token != lease_broker_token {
        return Err(
            "launch lease and control sockets belong to different broker instances".to_owned(),
        );
    }
    assert_containment_group(broker_pid)?;

    ACTIVE_CONTROL_FD.store(control.as_raw_fd(), Ordering::SeqCst);
    install_signal_boundary()?;
    let supervisor_control = control
        .try_clone()
        .map_err(|error| format!("could not clone supervised control socket: {error}"))?;
    let mut supervisor = BridgeSupervisor {
        _verified_driver_pid: None,
        control: supervisor_control,
        launch_lease,
    };

    control
        .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .and_then(|()| control.set_write_timeout(Some(HANDSHAKE_TIMEOUT)))
        .map_err(|error| format!("could not bound bridge handshake: {error}"))?;
    let reader_stream = control
        .try_clone()
        .map_err(|error| format!("could not clone bridge control socket: {error}"))?;
    let mut control_reader = BoundedLines::new(reader_stream);
    write_line(&mut control, BROKER_SUPERVISION_ACK)
        .map_err(|error| format!("could not arm broker supervision: {error}"))?;
    let guard_ready = control_reader
        .next(MAX_INTERNAL_FRAME_BYTES)
        .map_err(|error| format!("could not read containment guard readiness: {error}"))?
        .ok_or_else(|| "broker closed before arming its containment guard".to_owned())?;
    exact_frame(&guard_ready, "containment-guard-armed")?;
    let constrained = control_reader
        .next(MAX_INTERNAL_FRAME_BYTES)
        .map_err(|error| format!("could not read driver supervision frame: {error}"))?
        .ok_or_else(|| "broker closed before driver supervision".to_owned())?;
    if let Some(error) = parse_broker_error(&constrained)? {
        return Err(format!("privileged broker startup failed: {error}"));
    }
    let (driver_pid, containment_pgid) = parse_constrained_frame(&constrained)?;
    if containment_pgid != driver_pid || containment_pgid == broker_pid {
        return Err("driver does not own its independently leased process group".to_owned());
    }
    verify_live_driver(driver_pid)?;
    assert_process_in_group(driver_pid, containment_pgid)?;
    supervisor._verified_driver_pid = Some(driver_pid);
    write_line(&mut control, SUPERVISION_ACK)
        .map_err(|error| format!("could not acknowledge driver supervision: {error}"))?;
    let ready = control_reader
        .next(MAX_INTERNAL_FRAME_BYTES)
        .map_err(|error| format!("could not read broker readiness: {error}"))?
        .ok_or_else(|| "broker closed before readiness".to_owned())?;
    exact_frame(&ready, "broker-ready")?;
    control
        .set_read_timeout(None)
        .and_then(|()| control.set_write_timeout(None))
        .map_err(|error| format!("could not configure bridge relay: {error}"))?;

    // This exact two-field line is the only non-MCP output on fd 4, and fd 4
    // is closed immediately afterward. It never appears on stdout.
    write_readiness(readiness)?;

    let input_control = control
        .try_clone()
        .map_err(|error| format!("could not clone bridge input socket: {error}"))?;
    thread::spawn(move || {
        if relay_bridge_input(input_control).is_err() {
            let fd = ACTIVE_CONTROL_FD.load(Ordering::Relaxed);
            if fd >= 0 {
                // SAFETY: fd is the active authenticated control socket.
                unsafe { libc::shutdown(fd, libc::SHUT_RDWR) };
            }
        }
    });

    let result = relay_bridge_output(control_reader);
    let _ = control.shutdown(std::net::Shutdown::Both);
    drop(supervisor);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::DirBuilderExt;

    #[test]
    fn authenticated_aiden_channel_eof_is_observed_without_broker_state() {
        let (monitor, owner) = UnixStream::pair().unwrap();
        let waiter = thread::spawn(move || wait_for_aiden_eof(monitor));
        drop(owner);
        waiter.join().unwrap();
    }

    #[test]
    fn readiness_is_exact_and_contains_no_process_or_secret_data() {
        let mut output = Vec::new();
        write_readiness(&mut output).unwrap();
        assert_eq!(output, b"{\"type\":\"ready\",\"protocolVersion\":2}\n");
        assert!(!String::from_utf8(output).unwrap().contains("driver"));
    }

    #[test]
    fn supervision_frame_is_internal_strict_and_round_trips_only_a_pgid() {
        let frame = constrained_frame(4242, 4242).unwrap();
        assert_eq!(parse_constrained_frame(&frame).unwrap(), (4242, 4242));
        assert!(parse_constrained_frame(
            br#"{"driverPid":4242,"containmentPgid":4242,"protocolVersion":2,"type":"driver-constrained","token":"bad"}"#
        )
        .is_err());
        assert!(parse_constrained_frame(
            br#"{"driverPid":1,"containmentPgid":1,"protocolVersion":2,"type":"driver-constrained"}"#
        )
        .is_err());
    }

    #[test]
    fn broker_startup_errors_are_bounded_and_strict() {
        let oversized = "é".repeat(MAX_BROKER_ERROR_BYTES);
        let frame = broker_error_frame(&oversized).unwrap();
        let message = parse_broker_error(&frame).unwrap().unwrap();
        assert!(message.len() <= MAX_BROKER_ERROR_BYTES);
        assert!(message.is_char_boundary(message.len()));
        assert!(parse_broker_error(
            br#"{"message":"no","protocolVersion":2,"type":"broker-error","detail":"bad"}"#
        )
        .is_err());
        assert_eq!(
            parse_broker_error(&constrained_frame(4, 3).unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn internal_ack_and_ready_frames_accept_no_extra_authority() {
        exact_frame(BROKER_SUPERVISION_ACK, "broker-supervision-armed").unwrap();
        exact_frame(CONTAINMENT_GUARD_ARMED, "containment-guard-armed").unwrap();
        exact_frame(SUPERVISION_ACK, "supervision-armed").unwrap();
        exact_frame(BROKER_READY, "broker-ready").unwrap();
        assert!(exact_frame(
            br#"{"type":"broker-ready","protocolVersion":2,"driverPid":9}"#,
            "broker-ready",
        )
        .is_err());
    }

    #[test]
    fn authentication_rejects_more_than_eight_peers_until_deadline() {
        let directory = format!("/tmp/acu-accept-{}", std::process::id());
        let _ = fs::remove_dir_all(&directory);
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(&directory).unwrap();
        let path = Path::new(&directory).join("control.sock");
        let listener = bind_control(&path).unwrap();
        let clients: Vec<UnixStream> = (0..10)
            .map(|_| UnixStream::connect(&path).unwrap())
            .collect();
        let mut attempts = 0;
        let accepted = accept_peer_with(&listener, Duration::from_secs(1), "test peer", |_| {
            attempts += 1;
            attempts == 10
        })
        .unwrap();
        assert_eq!(attempts, 10);
        drop(accepted);
        drop(clients);
        drop(listener);
        fs::remove_dir_all(directory).unwrap();
    }
}
