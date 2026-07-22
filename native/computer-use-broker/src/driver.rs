use crate::darwin;
use crate::signing::{driver_path, verify_live_driver, PinnedDriver, BROKER_BUNDLE_ID};
use crate::supervisor::{LauncherSupervisor, SupervisionFailure};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::time::Duration;

#[cfg(test)]
use std::thread;
#[cfg(test)]
const TERMINATE_GRACE: Duration = Duration::from_millis(500);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
const PREPARE_TIMEOUT: Duration = Duration::from_secs(2);
const DRIVER_ARGUMENTS: &[&str] = &["mcp", "--embedded", "--host-bundle-id", BROKER_BUNDLE_ID];
const LAUNCH_COMMAND: u8 = 0xa6;
const LAUNCHER_READY: u8 = 0xb5;
const LAUNCH_FRAME_BYTES: usize = 12;
const LAUNCH_STATUS_OK: u32 = 0;
const LAUNCH_STATUS_BEGIN_SUPERVISION: u32 = 1;
const LAUNCH_STATUS_KERNEL_REJECTED: u32 = 2;
const LAUNCH_STATUS_SUPERVISION_BASE: u32 = 100;

fn pipe_cloexec() -> Result<(OwnedFd, OwnedFd), String> {
    let mut descriptors = [-1; 2];
    // SAFETY: descriptors has exactly two writable c_int slots.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(format!(
            "could not create driver pipe: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: pipe returned two newly owned descriptors.
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: pipe returned two newly owned descriptors.
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    for descriptor in [&read, &write] {
        set_cloexec(descriptor.as_raw_fd())?;
    }
    Ok((read, write))
}

fn set_cloexec(descriptor: RawFd) -> Result<(), String> {
    // SAFETY: descriptor is live and F_GETFD has no third argument.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0
        // SAFETY: descriptor is live and flags came from F_GETFD.
        || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0
    {
        return Err(format!(
            "could not protect driver descriptor: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn optional_environment(key: &str, fallback: Option<&str>) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .or_else(|| fallback.map(str::to_owned))
        .map(|value| format!("{key}={value}"))
}

fn allowed_driver_environment() -> Vec<String> {
    let mut environment = vec![
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin".to_owned(),
        format!("CUA_DRIVER_HOST_BUNDLE_ID={BROKER_BUNDLE_ID}"),
        "CUA_DRIVER_EMBEDDED=1".to_owned(),
        "CUA_DRIVER_RS_TELEMETRY_ENABLED=0".to_owned(),
        "CUA_TELEMETRY_ENABLED=0".to_owned(),
        "CUA_DRIVER_RS_UPDATE_CHECK=false".to_owned(),
        "NO_COLOR=1".to_owned(),
    ];
    for (key, fallback) in [
        ("HOME", Some("/var/empty")),
        ("TMPDIR", Some("/tmp")),
        ("LANG", None),
        ("LC_ALL", None),
        ("LC_CTYPE", None),
        ("USER", None),
        ("__CF_USER_TEXT_ENCODING", None),
    ] {
        if let Some(value) = optional_environment(key, fallback) {
            environment.push(value);
        }
    }
    environment
}

fn spawn_constrained_driver_with_owned_stdio(
    path: &std::path::Path,
    arguments: &[CString],
    environment: &[CString],
    stdin: OwnedFd,
    stdout: OwnedFd,
    stderr: OwnedFd,
) -> Result<darwin::DarwinTask, String> {
    let result = darwin::spawn_constrained_driver(
        path,
        arguments,
        environment,
        stdin.as_raw_fd(),
        stdout.as_raw_fd(),
        stderr.as_raw_fd(),
    );
    // NSTask has already duplicated these descriptors into the child when
    // launchAndReturnError returns. The dedicated launcher must release its
    // copies now so a crashed/exited driver produces stdin EPIPE and stdout EOF
    // at the broker instead of leaving both relays blocked indefinitely.
    drop((stdin, stdout, stderr));
    result
}

fn open_descriptor_snapshot() -> Result<Vec<RawFd>, String> {
    let entries = std::fs::read_dir("/dev/fd")
        .map_err(|error| format!("could not enumerate launcher descriptors: {error}"))?;
    let mut descriptors = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("could not read launcher descriptor: {error}"))?;
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
            // SAFETY: closing an already-closed snapshot entry only reports EBADF.
            unsafe { libc::close(descriptor) };
        }
    }
}

fn write_launcher_frame(control: RawFd, status: u32, pid: libc::pid_t, pgid: libc::pid_t) {
    let mut frame = [0_u8; LAUNCH_FRAME_BYTES];
    frame[..4].copy_from_slice(&status.to_ne_bytes());
    frame[4..8].copy_from_slice(&pid.to_ne_bytes());
    frame[8..].copy_from_slice(&pgid.to_ne_bytes());
    let mut written = 0;
    while written < frame.len() {
        // SAFETY: control is live and the remaining slice is readable.
        let result = unsafe {
            libc::write(
                control,
                frame[written..].as_ptr().cast(),
                frame.len() - written,
            )
        };
        if result > 0 {
            written += result as usize;
        } else if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        } else {
            break;
        }
    }
}

fn launcher_failure(status: u32) -> String {
    match status {
        LAUNCH_STATUS_BEGIN_SUPERVISION => {
            "the constrained driver watchdog did not enter its launch phase".to_owned()
        }
        LAUNCH_STATUS_KERNEL_REJECTED => {
            "the kernel rejected the constrained cua-driver launch".to_owned()
        }
        value
            if value > LAUNCH_STATUS_SUPERVISION_BASE
                && value <= LAUNCH_STATUS_SUPERVISION_BASE + u8::MAX as u32 =>
        {
            let failure =
                SupervisionFailure::from_byte((value - LAUNCH_STATUS_SUPERVISION_BASE) as u8);
            format!(
                "driver containment failed because {}",
                failure.description()
            )
        }
        _ => "the constrained driver launcher returned an invalid status".to_owned(),
    }
}

fn launcher_child(
    control: RawFd,
    watchdog_lease: RawFd,
    stdin_read: RawFd,
    stdout_write: RawFd,
    stderr_write: RawFd,
    open_fds: &[RawFd],
) -> ! {
    close_unrelated_fds(
        open_fds,
        &[
            control,
            watchdog_lease,
            stdin_read,
            stdout_write,
            stderr_write,
        ],
    );
    // Both launcher and watchdog become occupied members of the accepted
    // driver group. They ignore the graceful signal until one of them sends
    // the mandatory current-group KILL itself.
    // SAFETY: signal setup and the initial one-byte read are process-local.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    // SAFETY: prepare_driver_launcher transferred the child endpoint exactly once.
    let watchdog_lease = unsafe { UnixStream::from_raw_fd(watchdog_lease) };
    let mut supervisor = match LauncherSupervisor::start(watchdog_lease) {
        Ok(supervisor) => supervisor,
        // SAFETY: no Foundation/Security API or driver launch has occurred.
        Err(_) => unsafe { libc::_exit(69) },
    };
    let ready = LAUNCHER_READY;
    // SAFETY: control is the private broker/launcher socket and ready is readable.
    if unsafe { libc::write(control, (&ready as *const u8).cast(), 1) } != 1 {
        supervisor.abort();
        // SAFETY: no driver launch can begin before broker readiness.
        unsafe { libc::_exit(68) };
    }
    let mut command = 0_u8;
    loop {
        // SAFETY: control is live and command is writable.
        let result = unsafe { libc::read(control, (&mut command as *mut u8).cast(), 1) };
        if result == 1 {
            break;
        }
        if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        // SAFETY: no privileged child exists before the launch command.
        unsafe { libc::_exit(70) };
    }
    if command != LAUNCH_COMMAND {
        // SAFETY: unknown parent protocol cannot create a driver.
        unsafe { libc::_exit(71) };
    }

    if supervisor.begin_launch().is_err() {
        write_launcher_frame(control, LAUNCH_STATUS_BEGIN_SUPERVISION, -1, -1);
        // SAFETY: the watchdog never accepted driver authority.
        unsafe { libc::_exit(72) };
    }

    // SAFETY: prepare_driver_launcher transferred exactly these three live
    // descriptors to this dedicated launcher process with into_raw_fd.
    let driver_stdin = unsafe { OwnedFd::from_raw_fd(stdin_read) };
    // SAFETY: same transfer contract as driver_stdin.
    let driver_stdout = unsafe { OwnedFd::from_raw_fd(stdout_write) };
    // SAFETY: same transfer contract as driver_stdin.
    let driver_stderr = unsafe { OwnedFd::from_raw_fd(stderr_write) };
    let result = (move || -> Result<darwin::DarwinTask, String> {
        let path = driver_path()?;
        let arguments: Vec<CString> = DRIVER_ARGUMENTS
            .iter()
            .map(|argument| CString::new(*argument).expect("constant contains no NUL"))
            .collect();
        let environment: Vec<CString> = allowed_driver_environment()
            .into_iter()
            .map(|entry| CString::new(entry).expect("filtered environment contains no NUL"))
            .collect();
        spawn_constrained_driver_with_owned_stdio(
            &path,
            &arguments,
            &environment,
            driver_stdin,
            driver_stdout,
            driver_stderr,
        )
    })();
    let mut task = match result {
        Ok(task) => task,
        Err(_) => {
            supervisor.launch_failed();
            write_launcher_frame(control, LAUNCH_STATUS_KERNEL_REJECTED, -1, -1);
            // SAFETY: launcher owns no accepted authority after launch failure.
            unsafe { libc::_exit(72) };
        }
    };
    let pid = task.pid();
    if task
        .capture_exact_identity(std::process::id(), pid as u32)
        .is_err()
    {
        // Tell the watchdog that Foundation returned before using the fresh
        // NSTask handle as a last-resort cleanup path. If the watchdog already
        // captured the child, it owns and terminates that occupied group.
        supervisor.launch_failed();
        task.terminate_before_identity_and_wait();
        write_launcher_frame(
            control,
            LAUNCH_STATUS_SUPERVISION_BASE + SupervisionFailure::AuditToken as u32,
            -1,
            -1,
        );
        // SAFETY: the exact task has terminated and no watchdog authority remains.
        unsafe { libc::_exit(73) };
    }
    if let Err(failure) = supervisor.contain_and_resume(pid as u32) {
        supervisor.abort();
        task.terminate_exact_and_wait();
        write_launcher_frame(
            control,
            LAUNCH_STATUS_SUPERVISION_BASE + failure as u32,
            -1,
            -1,
        );
        // SAFETY: watchdog cleanup rejected all driver authority.
        unsafe { libc::_exit(73) };
    }
    let containment_pgid = supervisor.containment_pgid();
    write_launcher_frame(control, LAUNCH_STATUS_OK, pid, containment_pgid);

    // Foundation retains termination status while it may auto-reap the exact
    // NSTask. Kernel process-group identity stays occupied by this launcher and
    // its watchdog; no cleanup path trusts the cached numeric PID directly.
    let _task = task;
    supervisor.monitor(control);
}

fn waitpid_blocking(pid: libc::pid_t) {
    let mut status = 0;
    loop {
        // SAFETY: pid is the direct launcher child and status is writable.
        let result = unsafe { libc::waitpid(pid, &mut status, 0) };
        if result == pid
            || (result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD))
        {
            return;
        }
        if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return;
    }
}

pub(crate) struct PreparedDriverLauncher {
    pid: libc::pid_t,
    control: Option<UnixStream>,
    watchdog_lease: Option<UnixStream>,
    input: Option<File>,
    output: Option<File>,
    wait_on_drop: bool,
}

impl PreparedDriverLauncher {
    pub(crate) fn launch(mut self, driver: &PinnedDriver) -> Result<DriverProcess, String> {
        let mut control = self
            .control
            .take()
            .ok_or_else(|| "driver launcher control is unavailable".to_owned())?;
        control
            .set_read_timeout(Some(LAUNCH_TIMEOUT))
            .and_then(|()| control.set_write_timeout(Some(LAUNCH_TIMEOUT)))
            .map_err(|error| format!("could not bound driver launch: {error}"))?;
        control
            .write_all(&[LAUNCH_COMMAND])
            .map_err(|error| format!("could not request constrained driver launch: {error}"))?;
        // If NSTask never resolves, closing the anonymous watchdog lease leaves
        // an inert janitor to catch any late-born constrained child. Waiting
        // here would turn the client-facing launch bound into an unbounded one.
        self.wait_on_drop = false;
        let mut frame = [0_u8; LAUNCH_FRAME_BYTES];
        control
            .read_exact(&mut frame)
            .map_err(|error| format!("constrained driver launcher failed: {error}"))?;
        self.wait_on_drop = true;
        let status = u32::from_ne_bytes(frame[..4].try_into().expect("exact frame"));
        let pid = libc::pid_t::from_ne_bytes(frame[4..8].try_into().expect("exact frame"));
        let pgid = libc::pid_t::from_ne_bytes(frame[8..].try_into().expect("exact frame"));
        if status != LAUNCH_STATUS_OK {
            return Err(launcher_failure(status));
        }
        if pid <= 1 || pgid <= 1 {
            return Err("constrained cua-driver returned invalid process identities".to_owned());
        }
        if let Err(error) = driver
            .verify_path_unchanged()
            .and_then(|()| verify_live_driver(pid as u32))
        {
            drop(control);
            self.watchdog_lease.take();
            waitpid_blocking(self.pid);
            return Err(error);
        }
        // SAFETY: the launcher acknowledged that it joined this exact group.
        if unsafe { libc::getpgid(self.pid) } != pgid {
            drop(control);
            self.watchdog_lease.take();
            waitpid_blocking(self.pid);
            return Err(
                "driver launcher did not retain its authenticated process-group lease".to_owned(),
            );
        }
        let launcher_pid = self.pid;
        self.pid = -1;
        Ok(DriverProcess {
            pid,
            pgid,
            launcher_pid,
            control: Some(control),
            watchdog_lease: self.watchdog_lease.take(),
            input: self.input.take(),
            output: self.output.take(),
        })
    }

    fn shutdown(&mut self) {
        self.control.take();
        self.watchdog_lease.take();
        if self.pid > 1 {
            if self.wait_on_drop {
                waitpid_blocking(self.pid);
            }
            self.pid = -1;
        }
    }
}

impl Drop for PreparedDriverLauncher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(crate) fn prepare_driver_launcher() -> Result<PreparedDriverLauncher, String> {
    let (stdin_read, stdin_write) = pipe_cloexec()?;
    let (stdout_read, stdout_write) = pipe_cloexec()?;
    let dev_null = OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_CLOEXEC)
        .open("/dev/null")
        .map_err(|error| format!("could not open driver diagnostics sink: {error}"))?;
    let (parent_control, child_control) = UnixStream::pair()
        .map_err(|error| format!("could not create driver launcher control: {error}"))?;
    let (parent_watchdog_lease, child_watchdog_lease) = UnixStream::pair()
        .map_err(|error| format!("could not create driver watchdog lease: {error}"))?;
    set_cloexec(parent_control.as_raw_fd())?;
    set_cloexec(child_control.as_raw_fd())?;
    set_cloexec(parent_watchdog_lease.as_raw_fd())?;
    set_cloexec(child_watchdog_lease.as_raw_fd())?;
    let open_fds = open_descriptor_snapshot()?;
    // SAFETY: this is called before any Foundation/Security API or thread. The
    // child closes the snapshot and becomes a dedicated launcher process.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(format!(
            "could not fork constrained driver launcher: {}",
            io::Error::last_os_error()
        ));
    }
    if pid == 0 {
        let control = child_control.into_raw_fd();
        let watchdog = child_watchdog_lease.into_raw_fd();
        let input = stdin_read.into_raw_fd();
        let output = stdout_write.into_raw_fd();
        let diagnostics = dev_null.into_raw_fd();
        launcher_child(control, watchdog, input, output, diagnostics, &open_fds);
    }
    drop(child_control);
    drop(child_watchdog_lease);
    drop(stdin_read);
    drop(stdout_write);
    drop(dev_null);
    let mut parent_control = parent_control;
    parent_control
        .set_read_timeout(Some(PREPARE_TIMEOUT))
        .map_err(|error| format!("could not bound driver launcher preparation: {error}"))?;
    let mut ready = 0_u8;
    parent_control
        .read_exact(std::slice::from_mut(&mut ready))
        .map_err(|error| format!("driver launcher preparation failed: {error}"))?;
    parent_control
        .set_read_timeout(None)
        .map_err(|error| format!("could not reset driver launcher timeout: {error}"))?;
    if ready != LAUNCHER_READY {
        return Err("driver launcher returned invalid readiness".to_owned());
    }
    Ok(PreparedDriverLauncher {
        pid,
        control: Some(parent_control),
        watchdog_lease: Some(parent_watchdog_lease),
        input: Some(File::from(stdin_write)),
        output: Some(File::from(stdout_read)),
        wait_on_drop: true,
    })
}

pub(crate) struct DriverProcess {
    pid: libc::pid_t,
    pgid: libc::pid_t,
    launcher_pid: libc::pid_t,
    control: Option<UnixStream>,
    watchdog_lease: Option<UnixStream>,
    pub(crate) input: Option<File>,
    pub(crate) output: Option<File>,
}

impl DriverProcess {
    pub(crate) fn pid(&self) -> u32 {
        self.pid as u32
    }

    pub(crate) fn pgid(&self) -> u32 {
        self.pgid as u32
    }

    pub(crate) fn terminate_and_reap(&mut self) {
        self.input.take();
        self.output.take();
        self.control.take();
        self.watchdog_lease.take();
        waitpid_blocking(self.launcher_pid);
    }
}

impl Drop for DriverProcess {
    fn drop(&mut self) {
        self.terminate_and_reap();
    }
}

#[cfg(test)]
pub(crate) fn signal_group(pgid: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
    if pgid <= 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid process group",
        ));
    }
    // SAFETY: negative pgid deliberately addresses exactly that process group.
    if unsafe { libc::kill(-pgid, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(test)]
pub(crate) fn terminate_group_with_escalation(pgid: libc::pid_t) {
    let _ = signal_group(pgid, libc::SIGTERM);
    thread::sleep(TERMINATE_GRACE);
    // Callers retain an occupied group member throughout this delay.
    let _ = signal_group(pgid, libc::SIGKILL);
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::time::Instant;

    #[test]
    fn launch_requirement_is_the_exact_reviewed_cross_architecture_constraint() {
        let bytes = darwin::launch_requirement_bytes();
        assert_eq!(bytes.len(), 272);
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            "ad026fbd60b3d23a310f4dcd73ae7c7eeeb3d6f0db09e98e28f0be0420853637"
        );
        assert_eq!(
            DRIVER_ARGUMENTS,
            ["mcp", "--embedded", "--host-bundle-id", BROKER_BUNDLE_ID]
        );
    }

    #[test]
    fn kernel_launch_requirement_kills_unrelated_code_before_it_runs() {
        let root = format!("/tmp/acu-launch-constraint-{}", std::process::id());
        let _ = fs::remove_file(&root);
        let input = File::open("/dev/null").unwrap();
        let output = OpenOptions::new().write(true).open("/dev/null").unwrap();
        let arguments = vec![CString::new(root.as_str()).unwrap()];
        let environment = vec![CString::new("PATH=/usr/bin:/bin").unwrap()];
        let task = darwin::spawn_constrained_driver(
            std::path::Path::new("/usr/bin/touch"),
            &arguments,
            &environment,
            input.as_raw_fd(),
            output.as_raw_fd(),
            output.as_raw_fd(),
        )
        .unwrap();
        let (status, reason) = task.wait().unwrap();
        assert_eq!(status, libc::SIGKILL);
        assert_eq!(reason, 2, "NSTaskTerminationReasonUncaughtSignal");
        assert!(!std::path::Path::new(&root).exists());
    }

    #[test]
    fn retained_nstask_does_not_retain_a_waitable_numeric_pid() {
        let input = File::open("/dev/null").unwrap();
        let output = OpenOptions::new().write(true).open("/dev/null").unwrap();
        let environment = vec![CString::new("PATH=/usr/bin:/bin").unwrap()];
        let task = darwin::spawn_constrained_driver(
            std::path::Path::new("/usr/bin/true"),
            &[],
            &environment,
            input.as_raw_fd(),
            output.as_raw_fd(),
            output.as_raw_fd(),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while task.is_running() {
            assert!(
                Instant::now() < deadline,
                "kernel-rejected NSTask did not terminate"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let mut status = 0;
        // SAFETY: this deliberately characterizes Foundation's ownership of its child.
        let result = unsafe { libc::waitpid(task.pid(), &mut status, libc::WNOHANG) };
        assert_eq!(result, -1);
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        assert_eq!(task.wait().unwrap().1, 2);
    }

    #[test]
    fn constrained_launch_releases_launcher_pipe_ends_after_spawn() {
        let (stdin_read, stdin_write) = pipe_cloexec().unwrap();
        let (stdout_read, stdout_write) = pipe_cloexec().unwrap();
        let stderr: OwnedFd = OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .unwrap()
            .into();
        let arguments = Vec::new();
        let environment = vec![CString::new("PATH=/usr/bin:/bin").unwrap()];
        let task = spawn_constrained_driver_with_owned_stdio(
            std::path::Path::new("/usr/bin/true"),
            &arguments,
            &environment,
            stdin_read,
            stdout_write,
            stderr,
        )
        .unwrap();
        drop(stdin_write);
        task.wait().unwrap();

        let flags = unsafe { libc::fcntl(stdout_read.as_raw_fd(), libc::F_GETFL) };
        assert!(flags >= 0);
        // SAFETY: stdout_read is live and flags came from F_GETFL.
        assert_eq!(
            unsafe {
                libc::fcntl(
                    stdout_read.as_raw_fd(),
                    libc::F_SETFL,
                    flags | libc::O_NONBLOCK,
                )
            },
            0,
        );
        let mut byte = 0_u8;
        // SAFETY: stdout_read is live and byte is writable.
        let count =
            unsafe { libc::read(stdout_read.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
        assert_eq!(
            count,
            0,
            "launcher retained the driver's stdout writer: {}",
            io::Error::last_os_error(),
        );
    }

    #[test]
    fn driver_environment_is_an_explicit_secret_free_allowlist() {
        let environment = allowed_driver_environment();
        let keys: Vec<&str> = environment
            .iter()
            .map(|entry| entry.split_once('=').unwrap().0)
            .collect();
        for forbidden in [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "NODE_OPTIONS",
            "DYLD_INSERT_LIBRARIES",
            "HTTPS_PROXY",
            "CUA_DRIVER_POLICY_FILE",
        ] {
            assert!(!keys.contains(&forbidden));
        }
        assert!(environment.contains(&"CUA_DRIVER_EMBEDDED=1".to_owned()));
        assert!(environment.contains(&format!("CUA_DRIVER_HOST_BUNDLE_ID={BROKER_BUNDLE_ID}")));
    }

    #[test]
    fn process_group_signal_reaches_an_isolated_child() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        signal_group(child.id() as libc::pid_t, libc::SIGTERM).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "isolated child survived SIGTERM");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn rejects_invalid_group_ids() {
        assert!(signal_group(0, libc::SIGTERM).is_err());
        assert!(signal_group(1, libc::SIGTERM).is_err());
    }

    #[test]
    fn escalation_kills_descendant_while_group_lease_is_occupied() {
        let pid_file = format!("/tmp/acu-group-child-{}.pid", std::process::id());
        let _ = fs::remove_file(&pid_file);
        let script = r#"
(
  trap '' TERM
  while :; do /bin/sleep 30; done
) &
printf '%s\n' "$!" > "$1"
while :; do /bin/sleep 30; done
"#;
        let mut leader = Command::new("/bin/sh")
            .args(["-c", script, "aiden-group-test", &pid_file])
            .process_group(0)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let descendant = loop {
            if let Ok(value) = fs::read_to_string(&pid_file) {
                break value.trim().parse::<libc::pid_t>().unwrap();
            }
            assert!(
                Instant::now() < deadline,
                "descendant pid was not published"
            );
            thread::sleep(Duration::from_millis(20));
        };
        terminate_group_with_escalation(leader.id() as libc::pid_t);
        leader.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            // SAFETY: signal zero only probes the recorded descendant pid.
            if unsafe { libc::kill(descendant, 0) } != 0
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "SIGTERM-ignoring descendant survived SIGKILL escalation"
            );
            thread::sleep(Duration::from_millis(20));
        }
        let _ = fs::remove_file(pid_file);
    }
}
