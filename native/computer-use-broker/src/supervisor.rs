use crate::darwin::{self, AuditToken};
use crate::signing::verify_live_driver_audit_token;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::{Duration, Instant};

const FALLBACK_READY: u8 = 0x41;
const WATCHDOG_READY: u8 = 0x42;
const ENTERING_LAUNCH: u8 = 0x51;
const RETURNED_OK: u8 = 0x52;
const RETURNED_ERROR: u8 = 0x53;
const LAUNCHER_JOINED: u8 = 0x54;
const DRIVER_CONTAINED: u8 = 0x61;
const DRIVER_RESUMED: u8 = 0x62;
const SUPERVISION_FAILED: u8 = 0x6f;
const PREPARE_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const RETURNED_CAPTURE_TIMEOUT: Duration = Duration::from_secs(1);
const POLL_INTERVAL_MS: libc::c_int = 10;
const TERMINATE_GRACE: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(crate) enum SupervisionFailure {
    Channel = 1,
    Protocol = 2,
    ProcessGroup = 3,
    Stop = 4,
    Identity = 5,
    StateChanged = 6,
    Enumeration = 7,
    ReturnedProcess = 8,
    CaptureTimeout = 9,
    LauncherState = 10,
    Resume = 11,
    AuditToken = 12,
    ProcessInspection = 13,
}

impl SupervisionFailure {
    pub(crate) fn from_byte(value: u8) -> Self {
        match value {
            1 => Self::Channel,
            2 => Self::Protocol,
            3 => Self::ProcessGroup,
            4 => Self::Stop,
            5 => Self::Identity,
            6 => Self::StateChanged,
            7 => Self::Enumeration,
            8 => Self::ReturnedProcess,
            9 => Self::CaptureTimeout,
            10 => Self::LauncherState,
            11 => Self::Resume,
            12 => Self::AuditToken,
            13 => Self::ProcessInspection,
            _ => Self::Protocol,
        }
    }

    pub(crate) fn description(self) -> &'static str {
        match self {
            Self::Channel => "the private watchdog channel failed",
            Self::Protocol => "the private watchdog protocol was invalid",
            Self::ProcessGroup => "the driver did not establish its required private group",
            Self::Stop => "the exact driver process could not be stopped",
            Self::Identity => "the stopped driver failed its pinned live-code identity",
            Self::StateChanged => "the driver identity changed during containment",
            Self::Enumeration => "the watchdog could not enumerate launcher children",
            Self::ReturnedProcess => "NSTask returned a different driver process",
            Self::CaptureTimeout => "the returned driver could not be captured before timeout",
            Self::LauncherState => "the launcher left the occupied containment group",
            Self::Resume => "the exact constrained driver could not be resumed",
            Self::AuditToken => "the watchdog could not capture the returned process audit token",
            Self::ProcessInspection => "the watchdog could not inspect the returned process",
        }
    }
}

fn set_cloexec(descriptor: RawFd) -> Result<(), String> {
    // SAFETY: descriptor is live and F_GETFD has no third argument.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0
        // SAFETY: descriptor is live and flags came from F_GETFD.
        || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0
    {
        return Err(format!(
            "could not protect supervisor descriptor: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn socket_pair() -> Result<(UnixStream, UnixStream), String> {
    let pair = UnixStream::pair()
        .map_err(|error| format!("could not create driver supervisor channel: {error}"))?;
    set_cloexec(pair.0.as_raw_fd())?;
    set_cloexec(pair.1.as_raw_fd())?;
    Ok(pair)
}

fn descriptor_snapshot() -> Result<Vec<RawFd>, String> {
    let entries = std::fs::read_dir("/dev/fd")
        .map_err(|error| format!("could not enumerate supervisor descriptors: {error}"))?;
    let mut descriptors = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("could not read supervisor descriptor: {error}"))?;
        if let Some(descriptor) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<RawFd>().ok())
        {
            descriptors.push(descriptor);
        }
    }
    descriptors.sort_unstable();
    descriptors.dedup();
    Ok(descriptors)
}

fn close_unrelated_fds(open_fds: &[RawFd], keep: &[RawFd]) {
    for &descriptor in open_fds {
        if !keep.contains(&descriptor) {
            // SAFETY: closing a stale snapshot entry only reports EBADF.
            unsafe { libc::close(descriptor) };
        }
    }
}

fn write_byte(stream: &mut UnixStream, value: u8) -> Result<(), String> {
    stream
        .write_all(&[value])
        .map_err(|error| format!("could not write driver supervision state: {error}"))
}

fn write_pid_frame(stream: &mut UnixStream, kind: u8, pid: u32) -> Result<(), String> {
    let mut frame = [0_u8; 5];
    frame[0] = kind;
    frame[1..].copy_from_slice(&pid.to_ne_bytes());
    stream
        .write_all(&frame)
        .map_err(|error| format!("could not write driver supervision frame: {error}"))
}

fn write_failure(stream: &mut UnixStream, failure: SupervisionFailure) -> Result<(), String> {
    stream
        .write_all(&[SUPERVISION_FAILED, failure as u8])
        .map_err(|error| format!("could not write driver supervision failure: {error}"))
}

fn read_byte(stream: &mut UnixStream) -> Result<u8, String> {
    let mut value = 0_u8;
    stream
        .read_exact(std::slice::from_mut(&mut value))
        .map_err(|error| format!("could not read driver supervision state: {error}"))?;
    Ok(value)
}

fn read_pid(stream: &mut UnixStream) -> Result<u32, String> {
    let mut bytes = [0_u8; 4];
    stream
        .read_exact(&mut bytes)
        .map_err(|error| format!("could not read driver supervision process id: {error}"))?;
    let pid = u32::from_ne_bytes(bytes);
    if pid <= 1 || pid > libc::pid_t::MAX as u32 {
        return Err("driver supervisor reported an invalid process id".to_owned());
    }
    Ok(pid)
}

fn read_failure(stream: &mut UnixStream) -> Result<SupervisionFailure, SupervisionFailure> {
    read_byte(stream)
        .map(SupervisionFailure::from_byte)
        .map_err(|_| SupervisionFailure::Channel)
}

fn fallback_child(control: RawFd, open_fds: &[RawFd]) -> ! {
    close_unrelated_fds(open_fds, &[control]);
    // SAFETY: the fallback is a dedicated, single-threaded process with one private socket.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        if libc::setpgid(0, 0) != 0 || libc::getpgrp() != libc::getpid() {
            libc::_exit(70);
        }
        let ready = FALLBACK_READY;
        if libc::write(control, (&ready as *const u8).cast(), 1) != 1 {
            libc::_exit(71);
        }
        let mut byte = 0_u8;
        loop {
            let count = libc::read(control, (&mut byte as *mut u8).cast(), 1);
            if count == 0 {
                break;
            }
            if count < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            if count < 0 {
                break;
            }
        }
        libc::_exit(0);
    }
}

fn wait_ready(stream: &mut UnixStream, expected: u8, label: &str) -> Result<(), String> {
    stream
        .set_read_timeout(Some(PREPARE_TIMEOUT))
        .map_err(|error| format!("could not bound {label} readiness: {error}"))?;
    let result = read_byte(stream);
    let _ = stream.set_read_timeout(None);
    let value = result?;
    if value != expected {
        return Err(format!("{label} returned an invalid readiness frame"));
    }
    Ok(())
}

fn poll_events(state: RawFd, lease: RawFd, timeout: libc::c_int) -> io::Result<(bool, bool)> {
    let mut descriptors = [
        libc::pollfd {
            fd: state,
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        },
        libc::pollfd {
            fd: lease,
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        },
    ];
    loop {
        // SAFETY: descriptors contains two initialized pollfd entries.
        let count = unsafe { libc::poll(descriptors.as_mut_ptr(), 2, timeout) };
        if count < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok((descriptors[0].revents != 0, descriptors[1].revents != 0));
    }
}

fn occupied_group_terminate() -> ! {
    // The sentinel, watchdog, launcher, and driver share this group. Addressing
    // group zero cannot race a numeric PGID reuse because the caller occupies it.
    // SAFETY: signals target the caller's current occupied process group.
    unsafe { libc::kill(0, libc::SIGTERM) };
    thread::sleep(TERMINATE_GRACE);
    // SAFETY: the TERM-ignoring caller still occupies this same group.
    unsafe {
        libc::kill(0, libc::SIGKILL);
        libc::_exit(72);
    }
}

#[derive(Clone, Copy)]
struct Candidate {
    pid: u32,
    token: AuditToken,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CandidateTerminalEvent {
    LaunchReturnedError,
    LeaseRevoked,
    ReturnedPidMismatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CandidateTerminalDisposition {
    Continue,
    ExitUnprivileged,
    TerminateOccupiedGroup,
}

fn candidate_terminal_disposition(
    event: CandidateTerminalEvent,
    candidate_is_held: bool,
) -> CandidateTerminalDisposition {
    match (event, candidate_is_held) {
        (CandidateTerminalEvent::LaunchReturnedError, false) => {
            CandidateTerminalDisposition::ExitUnprivileged
        }
        (CandidateTerminalEvent::LeaseRevoked, false) => CandidateTerminalDisposition::Continue,
        _ => CandidateTerminalDisposition::TerminateOccupiedGroup,
    }
}

fn wait_until_stopped(token: &AuditToken) -> Result<(), String> {
    let deadline = Instant::now() + STOP_TIMEOUT;
    loop {
        let info = darwin::process_info(token)?;
        if info.stopped {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("constrained driver did not stop before containment".to_owned());
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn try_contain_candidate(
    pid: u32,
    launcher_pid: u32,
    containment_pgid: libc::pid_t,
    enforce_returned_identity: bool,
) -> Result<Option<Candidate>, SupervisionFailure> {
    let token = match darwin::process_audit_token(pid) {
        Ok(token) => token,
        Err(_) if enforce_returned_identity => return Err(SupervisionFailure::AuditToken),
        Err(_) => return Ok(None),
    };
    let before = match darwin::process_info(&token) {
        Ok(info) => info,
        Err(_) if enforce_returned_identity => {
            return Err(SupervisionFailure::ProcessInspection);
        }
        Err(_) => return Ok(None),
    };
    if before.parent_pid != launcher_pid || before.process_group != pid {
        if enforce_returned_identity {
            let _ = darwin::signal_process(&token, libc::SIGKILL);
            return Err(SupervisionFailure::ProcessGroup);
        }
        return Ok(None);
    }

    // Stop the exact direct child before Security.framework validation. The
    // kernel launch requirement already constrains its first instruction, and
    // the audit token prevents a PID-reuse signal.
    if darwin::signal_process(&token, libc::SIGSTOP).is_err() {
        return if enforce_returned_identity {
            Err(SupervisionFailure::Stop)
        } else {
            Ok(None)
        };
    }
    if wait_until_stopped(&token).is_err() {
        let _ = darwin::signal_process(&token, libc::SIGKILL);
        return Err(SupervisionFailure::Stop);
    }
    if verify_live_driver_audit_token(&token).is_err() {
        if enforce_returned_identity {
            let _ = darwin::signal_process(&token, libc::SIGKILL);
            return Err(SupervisionFailure::Identity);
        }
        // A child may become visible while posix_spawn is still committing its
        // exec. It is kernel-constrained but not yet inspectable as cua-driver;
        // resume that exact incarnation and retry rather than killing a valid
        // launch before launchAndReturnError can return.
        let _ = darwin::signal_process(&token, libc::SIGCONT);
        return Ok(None);
    }

    // The exact stopped child is the leader of this group in the same session.
    // Joining it gives the watchdog a kernel-held lease before the launcher
    // relies on the numeric identifier returned by Foundation.
    // SAFETY: the watchdog changes only its own process-group membership.
    if unsafe { libc::setpgid(0, pid as libc::pid_t) } != 0 {
        let _ = darwin::signal_process(&token, libc::SIGKILL);
        return Err(SupervisionFailure::ProcessGroup);
    }
    let post = darwin::process_info(&token);
    let valid = post.is_ok_and(|info| {
        info.parent_pid == launcher_pid
            && info.process_group == pid
            && info.stopped
            // SAFETY: getpgrp has no preconditions.
            && unsafe { libc::getpgrp() } == pid as libc::pid_t
    }) && verify_live_driver_audit_token(&token).is_ok();
    if !valid {
        // Retreat to the sentinel-occupied fallback group before using only
        // the exact audit token for cleanup. Never group-signal after failed
        // post-validation.
        // SAFETY: containment_pgid is occupied by the pre-forked sentinel.
        unsafe { libc::setpgid(0, containment_pgid) };
        let _ = darwin::signal_process(&token, libc::SIGKILL);
        return Err(SupervisionFailure::StateChanged);
    }
    Ok(Some(Candidate { pid, token }))
}

fn scan_for_candidate(
    launcher_pid: u32,
    fallback_pid: u32,
    watchdog_pid: u32,
    reported_pid: Option<u32>,
    containment_pgid: libc::pid_t,
) -> Result<Option<Candidate>, SupervisionFailure> {
    let enforce_returned_identity = reported_pid.is_some();
    let candidates = if let Some(pid) = reported_pid {
        vec![pid]
    } else {
        darwin::child_processes(launcher_pid).map_err(|_| SupervisionFailure::Enumeration)?
    };
    for pid in candidates {
        if pid == fallback_pid || pid == watchdog_pid {
            continue;
        }
        if let Some(candidate) = try_contain_candidate(
            pid,
            launcher_pid,
            containment_pgid,
            enforce_returned_identity,
        )? {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn fail_watchdog(state: &mut UnixStream, failure: SupervisionFailure) -> ! {
    let _ = write_failure(state, failure);
    // SAFETY: this dedicated watchdog owns no accepted group authority here.
    unsafe { libc::_exit(74) }
}

fn fail_occupied_watchdog(state: &mut UnixStream, failure: SupervisionFailure) -> ! {
    let _ = write_failure(state, failure);
    occupied_group_terminate();
}

fn wait_for_launcher_join(
    state: &mut UnixStream,
    lease: &UnixStream,
    launcher: &AuditToken,
    candidate: Candidate,
) -> ! {
    let driver_pgid = candidate.pid as libc::pid_t;
    if write_pid_frame(state, DRIVER_CONTAINED, candidate.pid).is_err() {
        occupied_group_terminate();
    }
    loop {
        match poll_events(state.as_raw_fd(), lease.as_raw_fd(), -1) {
            Ok((_, true)) | Err(_) => occupied_group_terminate(),
            Ok((true, false)) => {
                if read_byte(state).ok() != Some(LAUNCHER_JOINED) {
                    occupied_group_terminate();
                }
                let launcher_info = darwin::process_info(launcher);
                let driver_info = darwin::process_info(&candidate.token);
                let valid = launcher_info
                    .is_ok_and(|info| info.process_group == driver_pgid as u32)
                    && driver_info.is_ok_and(|info| {
                        info.process_group == driver_pgid as u32 && info.stopped
                    })
                    // SAFETY: getpgrp has no preconditions.
                    && unsafe { libc::getpgrp() } == driver_pgid;
                if !valid {
                    let _ = write_failure(state, SupervisionFailure::LauncherState);
                    occupied_group_terminate();
                }
                if darwin::signal_process(&candidate.token, libc::SIGCONT).is_err() {
                    let _ = write_failure(state, SupervisionFailure::Resume);
                    occupied_group_terminate();
                }
                if write_byte(state, DRIVER_RESUMED).is_err() {
                    occupied_group_terminate();
                }
                loop {
                    match poll_events(state.as_raw_fd(), lease.as_raw_fd(), -1) {
                        Ok((false, false)) => continue,
                        Ok(_) | Err(_) => occupied_group_terminate(),
                    }
                }
            }
            Ok((false, false)) => continue,
        }
    }
}

fn watchdog_child(
    state_fd: RawFd,
    lease_fd: RawFd,
    launcher_pid: u32,
    fallback_pid: u32,
    open_fds: &[RawFd],
) -> ! {
    close_unrelated_fds(open_fds, &[state_fd, lease_fd]);
    // SAFETY: both descriptors were transferred exclusively to this child.
    let mut state = unsafe { UnixStream::from_raw_fd(state_fd) };
    // SAFETY: same transfer contract as state.
    let lease = unsafe { UnixStream::from_raw_fd(lease_fd) };
    // SAFETY: signal disposition is process-local and established before containment.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let launcher = match darwin::process_audit_token(launcher_pid) {
        Ok(token) => token,
        // SAFETY: no driver launch can begin before watchdog readiness.
        Err(_) => unsafe { libc::_exit(75) },
    };
    if write_byte(&mut state, WATCHDOG_READY).is_err() {
        // SAFETY: no driver launch can begin before watchdog readiness.
        unsafe { libc::_exit(76) }
    }

    let watchdog_pid = std::process::id();
    let containment_pgid = fallback_pid as libc::pid_t;
    // SAFETY: the watchdog inherited the launcher's already-established group.
    if unsafe { libc::getpgrp() } != containment_pgid {
        // SAFETY: no driver launch can begin before watchdog readiness.
        unsafe { libc::_exit(79) }
    }
    let mut entering = false;
    let mut returned_pid = None;
    let mut returned_at = None;
    let mut candidate = None;
    let mut revoked = false;
    loop {
        let timeout = if entering { POLL_INTERVAL_MS } else { -1 };
        let events = poll_events(state.as_raw_fd(), lease.as_raw_fd(), timeout);
        let (state_event, lease_event) = events.unwrap_or((false, true));
        if lease_event {
            revoked = true;
            if candidate_terminal_disposition(
                CandidateTerminalEvent::LeaseRevoked,
                candidate.is_some(),
            ) == CandidateTerminalDisposition::TerminateOccupiedGroup
            {
                occupied_group_terminate();
            }
            if !entering {
                let _ = darwin::signal_process(&launcher, libc::SIGKILL);
                // SAFETY: no launch is in flight in the dormant phase.
                unsafe { libc::_exit(77) }
            }
        }
        if state_event {
            let kind = match read_byte(&mut state) {
                Ok(kind) => kind,
                Err(_) if candidate.is_some() => occupied_group_terminate(),
                Err(_) if entering => {
                    revoked = true;
                    continue;
                }
                // SAFETY: no driver launch is active.
                Err(_) => unsafe { libc::_exit(78) },
            };
            match kind {
                ENTERING_LAUNCH if !entering => entering = true,
                RETURNED_OK if entering && returned_pid.is_none() => {
                    returned_pid = read_pid(&mut state).ok();
                    returned_at = Some(Instant::now());
                }
                RETURNED_ERROR if entering && returned_pid.is_none() => {
                    if candidate_terminal_disposition(
                        CandidateTerminalEvent::LaunchReturnedError,
                        candidate.is_some(),
                    ) == CandidateTerminalDisposition::TerminateOccupiedGroup
                    {
                        fail_occupied_watchdog(&mut state, SupervisionFailure::ReturnedProcess);
                    }
                    let _ = write_byte(&mut state, SUPERVISION_FAILED);
                    // SAFETY: NSTask reported that no accepted driver was launched.
                    unsafe { libc::_exit(0) }
                }
                _ => {
                    if candidate.is_some() {
                        occupied_group_terminate();
                    }
                    fail_watchdog(&mut state, SupervisionFailure::Protocol);
                }
            }
        }

        if entering && candidate.is_none() {
            match scan_for_candidate(
                launcher_pid,
                fallback_pid,
                watchdog_pid,
                returned_pid,
                containment_pgid,
            ) {
                Ok(found) => candidate = found,
                Err(error) if returned_pid.is_some() => fail_watchdog(&mut state, error),
                Err(_) => {}
            }
        }
        if revoked
            && candidate_terminal_disposition(
                CandidateTerminalEvent::LeaseRevoked,
                candidate.is_some(),
            ) == CandidateTerminalDisposition::TerminateOccupiedGroup
        {
            occupied_group_terminate();
        }
        if let (Some(found), Some(reported)) = (candidate, returned_pid) {
            if found.pid != reported {
                debug_assert_eq!(
                    candidate_terminal_disposition(
                        CandidateTerminalEvent::ReturnedPidMismatch,
                        true,
                    ),
                    CandidateTerminalDisposition::TerminateOccupiedGroup,
                );
                fail_occupied_watchdog(&mut state, SupervisionFailure::ReturnedProcess);
            }
            if revoked {
                occupied_group_terminate();
            }
            wait_for_launcher_join(&mut state, &lease, &launcher, found);
        }
        if let Some(started) = returned_at {
            if candidate.is_none() && started.elapsed() >= RETURNED_CAPTURE_TIMEOUT {
                fail_watchdog(&mut state, SupervisionFailure::CaptureTimeout);
            }
        }
    }
}

pub(crate) struct LauncherSupervisor {
    state: Option<UnixStream>,
    fallback_lease: Option<UnixStream>,
    containment_pgid: libc::pid_t,
}

impl LauncherSupervisor {
    pub(crate) fn start(watchdog_lease: UnixStream) -> Result<Self, String> {
        let (mut fallback_parent, fallback_child_stream) = socket_pair()?;
        let open_fds = descriptor_snapshot()?;
        // SAFETY: the launcher is single-threaded and has not entered Foundation/Security.
        let fallback_pid = unsafe { libc::fork() };
        if fallback_pid < 0 {
            return Err(format!(
                "could not fork driver fallback sentinel: {}",
                io::Error::last_os_error()
            ));
        }
        if fallback_pid == 0 {
            let control = fallback_child_stream.into_raw_fd();
            fallback_child(control, &open_fds);
        }
        drop(fallback_child_stream);
        // SAFETY: fallback_pid is the direct, pre-exec child in this session.
        if unsafe { libc::setpgid(fallback_pid, fallback_pid) } != 0 {
            return Err(format!(
                "could not establish driver fallback group: {}",
                io::Error::last_os_error()
            ));
        }
        wait_ready(&mut fallback_parent, FALLBACK_READY, "driver fallback")?;
        // SAFETY: the occupied fallback group exists in this session.
        if unsafe { libc::setpgid(0, fallback_pid) } != 0
            // SAFETY: getpgrp has no preconditions.
            || unsafe { libc::getpgrp() } != fallback_pid
        {
            return Err(format!(
                "could not enter driver fallback group: {}",
                io::Error::last_os_error()
            ));
        }

        let (mut state_parent, state_child) = socket_pair()?;
        let open_fds = descriptor_snapshot()?;
        let launcher_pid = std::process::id();
        // SAFETY: still single-threaded and no Foundation/Security API has run.
        let watchdog_pid = unsafe { libc::fork() };
        if watchdog_pid < 0 {
            return Err(format!(
                "could not fork constrained driver watchdog: {}",
                io::Error::last_os_error()
            ));
        }
        if watchdog_pid == 0 {
            let state = state_child.into_raw_fd();
            let lease = watchdog_lease.into_raw_fd();
            watchdog_child(state, lease, launcher_pid, fallback_pid as u32, &open_fds);
        }
        drop(state_child);
        drop(watchdog_lease);
        wait_ready(&mut state_parent, WATCHDOG_READY, "driver watchdog")?;
        Ok(Self {
            state: Some(state_parent),
            fallback_lease: Some(fallback_parent),
            containment_pgid: fallback_pid,
        })
    }

    pub(crate) fn begin_launch(&mut self) -> Result<(), String> {
        write_byte(
            self.state
                .as_mut()
                .ok_or_else(|| "driver watchdog is unavailable".to_owned())?,
            ENTERING_LAUNCH,
        )
    }

    pub(crate) fn launch_failed(&mut self) {
        if let Some(state) = self.state.as_mut() {
            let _ = write_byte(state, RETURNED_ERROR);
            let _ = read_byte(state);
        }
        self.state.take();
        self.fallback_lease.take();
    }

    pub(crate) fn contain_and_resume(&mut self, pid: u32) -> Result<(), SupervisionFailure> {
        let state = self.state.as_mut().ok_or(SupervisionFailure::Channel)?;
        write_pid_frame(state, RETURNED_OK, pid).map_err(|_| SupervisionFailure::Channel)?;
        let response = read_byte(state).map_err(|_| SupervisionFailure::Channel)?;
        if response == SUPERVISION_FAILED {
            return Err(read_failure(state)?);
        }
        if response != DRIVER_CONTAINED
            || read_pid(state).map_err(|_| SupervisionFailure::Channel)? != pid
        {
            return Err(SupervisionFailure::Protocol);
        }
        // The watchdog already occupies and post-validated this stopped group,
        // so its numeric identifier cannot disappear or be recycled here.
        // SAFETY: pid names the watchdog-occupied group in this session.
        if unsafe { libc::setpgid(0, pid as libc::pid_t) } != 0
            // SAFETY: getpgrp has no preconditions.
            || unsafe { libc::getpgrp() } != pid as libc::pid_t
        {
            return Err(SupervisionFailure::LauncherState);
        }
        self.containment_pgid = pid as libc::pid_t;
        self.fallback_lease.take();
        write_byte(state, LAUNCHER_JOINED).map_err(|_| SupervisionFailure::Channel)?;
        let response = read_byte(state).map_err(|_| SupervisionFailure::Channel)?;
        if response == SUPERVISION_FAILED {
            return Err(read_failure(state)?);
        }
        if response != DRIVER_RESUMED {
            return Err(SupervisionFailure::Protocol);
        }
        Ok(())
    }

    pub(crate) fn containment_pgid(&self) -> libc::pid_t {
        self.containment_pgid
    }

    pub(crate) fn monitor(mut self, control: RawFd) -> ! {
        let state = self
            .state
            .take()
            .expect("driver watchdog state exists after containment");
        self.fallback_lease.take();
        let mut descriptors = [
            libc::pollfd {
                fd: control,
                events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                revents: 0,
            },
            libc::pollfd {
                fd: state.as_raw_fd(),
                events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                revents: 0,
            },
        ];
        loop {
            // SAFETY: descriptors contains two initialized pollfd records.
            let count = unsafe { libc::poll(descriptors.as_mut_ptr(), 2, -1) };
            if count < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            if count <= 0 || descriptors.iter().any(|descriptor| descriptor.revents != 0) {
                occupied_group_terminate();
            }
        }
    }

    pub(crate) fn abort(&mut self) {
        self.state.take();
        self.fallback_lease.take();
    }
}

impl Drop for LauncherSupervisor {
    fn drop(&mut self) {
        self.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    #[test]
    fn retained_child_audit_token_is_exact_after_child_reap() {
        let mut command = Command::new("/bin/sleep");
        command
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let token =
            darwin::capture_exact_child_audit_token(child.id(), std::process::id(), child.id())
                .unwrap();
        darwin::signal_process(&token, libc::SIGKILL).unwrap();
        child.wait().unwrap();
        let error = darwin::signal_process(&token, libc::SIGKILL).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ESRCH));
    }

    #[test]
    fn candidate_owning_terminal_transitions_always_kill_the_occupied_group() {
        for event in [
            CandidateTerminalEvent::LaunchReturnedError,
            CandidateTerminalEvent::LeaseRevoked,
            CandidateTerminalEvent::ReturnedPidMismatch,
        ] {
            assert_eq!(
                candidate_terminal_disposition(event, true),
                CandidateTerminalDisposition::TerminateOccupiedGroup,
            );
        }
        assert_eq!(
            candidate_terminal_disposition(CandidateTerminalEvent::LaunchReturnedError, false,),
            CandidateTerminalDisposition::ExitUnprivileged,
        );
        assert_eq!(
            candidate_terminal_disposition(CandidateTerminalEvent::LeaseRevoked, false),
            CandidateTerminalDisposition::Continue,
        );
    }

    #[test]
    fn exact_process_info_uses_pid_version_without_a_signal_zero_probe() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let token = darwin::process_audit_token(child.id()).unwrap();
        let info = darwin::process_info(&token).unwrap();
        assert_eq!(info.pid, child.id());
        assert_eq!(info.parent_pid, std::process::id());
        darwin::signal_process(&token, libc::SIGKILL).unwrap();
        child.wait().unwrap();
        assert!(darwin::process_info(&token).is_err());
    }

    #[test]
    fn launch_phase_never_treats_entering_as_safe_to_kill() {
        assert_ne!(ENTERING_LAUNCH, RETURNED_OK);
        assert_ne!(ENTERING_LAUNCH, RETURNED_ERROR);
        assert_eq!(TERMINATE_GRACE, Duration::from_millis(500));
    }
}
