use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::Duration;

const READY_BYTE: u8 = 0xa5;
const ARM_BYTE: u8 = 0x6d;
const READY_TIMEOUT_MS: libc::c_int = 2_000;
const TERMINATE_GRACE_NANOS: libc::c_long = 500_000_000;

fn pipe_cloexec() -> Result<(OwnedFd, OwnedFd), String> {
    let mut descriptors = [-1; 2];
    // SAFETY: descriptors has two writable c_int slots.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(format!(
            "could not create containment pipe: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: pipe returned two newly owned descriptors.
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: pipe returned two newly owned descriptors.
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    for descriptor in [&read, &write] {
        // SAFETY: descriptor is live and F_SETFD accepts FD_CLOEXEC.
        if unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(format!(
                "could not protect containment pipe: {}",
                io::Error::last_os_error()
            ));
        }
    }
    Ok((read, write))
}

fn waitpid_blocking(pid: libc::pid_t) {
    let mut status = 0;
    loop {
        // SAFETY: pid is the child returned by fork and status is writable.
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

fn close_unrelated_fds(keep: &[RawFd], open_fds: &[RawFd]) {
    for &descriptor in open_fds {
        if !keep.contains(&descriptor) {
            // SAFETY: closing an unopened descriptor is harmless and reports EBADF.
            unsafe { libc::close(descriptor) };
        }
    }
}

fn sleep_grace() {
    let mut remaining = libc::timespec {
        tv_sec: 0,
        tv_nsec: TERMINATE_GRACE_NANOS,
    };
    loop {
        let mut next = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: both timespec pointers are valid.
        if unsafe { libc::nanosleep(&remaining, &mut next) } == 0 {
            return;
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return;
        }
        remaining = next;
    }
}

fn monotonic_milliseconds() -> Option<i64> {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: now is a writable timespec and CLOCK_MONOTONIC has no wall-clock jumps.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) } != 0 {
        return None;
    }
    Some(
        now.tv_sec
            .saturating_mul(1_000)
            .saturating_add(now.tv_nsec / 1_000_000),
    )
}

fn wait_for_authenticated_arm(death_read: RawFd, arm_read: RawFd, timeout_ms: libc::c_int) -> bool {
    let Some(started) = monotonic_milliseconds() else {
        return false;
    };
    let deadline = started.saturating_add(timeout_ms as i64);
    loop {
        let Some(now) = monotonic_milliseconds() else {
            return false;
        };
        let remaining = deadline.saturating_sub(now);
        if remaining <= 0 {
            return false;
        }
        let mut descriptors = [
            libc::pollfd {
                fd: death_read,
                events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                revents: 0,
            },
            libc::pollfd {
                fd: arm_read,
                events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                revents: 0,
            },
        ];
        // SAFETY: descriptors contains two initialized pollfd records.
        let result = unsafe {
            libc::poll(
                descriptors.as_mut_ptr(),
                descriptors.len() as libc::nfds_t,
                remaining.min(libc::c_int::MAX as i64) as libc::c_int,
            )
        };
        if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if result <= 0 || descriptors[0].revents != 0 || descriptors[1].revents == 0 {
            return false;
        }
        let mut arm = 0_u8;
        // SAFETY: arm_read is live and arm is writable.
        return unsafe { libc::read(arm_read, (&mut arm as *mut u8).cast(), 1) } == 1
            && arm == ARM_BYTE;
    }
}

#[derive(Clone, Copy)]
struct GuardChildFds {
    death_read: RawFd,
    death_write: RawFd,
    arm_read: RawFd,
    arm_write: RawFd,
    ready_read: RawFd,
    ready_write: RawFd,
    liveness: RawFd,
}

fn guard_child(
    containment_pgid: libc::pid_t,
    fds: GuardChildFds,
    authentication_timeout_ms: libc::c_int,
    open_fds: &[RawFd],
) -> ! {
    // This branch runs after a single-threaded fork and deliberately uses only
    // async-signal-safe libc operations before _exit.
    // SAFETY: all descriptors came from pipe; containment_pgid was validated.
    unsafe {
        libc::close(fds.death_write);
        libc::close(fds.arm_write);
        libc::close(fds.ready_read);
        if libc::setpgid(0, containment_pgid) != 0 || libc::getpgrp() != containment_pgid {
            libc::_exit(70);
        }
        let keep = [fds.death_read, fds.arm_read, fds.ready_write, fds.liveness];
        close_unrelated_fds(&keep, open_fds);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        let ready = READY_BYTE;
        if libc::write(fds.ready_write, (&ready as *const u8).cast(), 1) != 1 {
            libc::_exit(71);
        }
        libc::close(fds.ready_write);

        // The guard, not the Security.framework call in the broker, owns this
        // absolute startup deadline. A stalled or hostile signature lookup can
        // therefore never leave an unauthenticated LaunchServices process alive.
        if !wait_for_authenticated_arm(fds.death_read, fds.arm_read, authentication_timeout_ms) {
            libc::close(fds.arm_read);
            libc::close(fds.death_read);
            libc::kill(0, libc::SIGTERM);
            sleep_grace();
            libc::kill(0, libc::SIGKILL);
            libc::_exit(74);
        }
        libc::close(fds.arm_read);

        let mut descriptors = [
            libc::pollfd {
                fd: fds.death_read,
                events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                revents: 0,
            },
            libc::pollfd {
                fd: fds.liveness,
                events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                revents: 0,
            },
        ];
        let descriptor_count = if fds.liveness >= 0 { 2 } else { 1 };
        loop {
            let result = libc::poll(descriptors.as_mut_ptr(), descriptor_count, -1);
            if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            if result <= 0 || descriptors[0].revents != 0 {
                break;
            }
            // The authenticated bridge never sends payload bytes on its lease. Readable
            // data, EOF, or an error all revoke the broker's authority.
            if fds.liveness >= 0 && descriptors[1].revents != 0 {
                break;
            }
        }
        libc::close(fds.death_read);
        libc::kill(0, libc::SIGTERM);
        sleep_grace();
        libc::kill(0, libc::SIGKILL);
        libc::_exit(72);
    }
}

#[derive(Debug)]
pub(crate) struct ContainmentGuard {
    death_writer: Option<OwnedFd>,
    arm_writer: Option<OwnedFd>,
    liveness_writer: Option<OwnedFd>,
    #[cfg(test)]
    pid: libc::pid_t,
}

impl Drop for ContainmentGuard {
    fn drop(&mut self) {
        self.death_writer.take();
        self.arm_writer.take();
        self.liveness_writer.take();
    }
}

impl ContainmentGuard {
    pub(crate) fn monitor_liveness(&mut self, mut stream: UnixStream) -> Result<(), String> {
        let arm_writer = self
            .arm_writer
            .take()
            .ok_or_else(|| "containment authentication is already armed".to_owned())?;
        let writer = self
            .liveness_writer
            .take()
            .ok_or_else(|| "containment liveness is already armed".to_owned())?;
        thread::Builder::new()
            .name("aiden-cua-liveness".to_owned())
            .spawn(move || {
                let mut byte = 0_u8;
                loop {
                    match stream.read(std::slice::from_mut(&mut byte)) {
                        Ok(0) => break,
                        // The lease is liveness-only. Any payload revokes it.
                        Ok(_) => break,
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                drop(writer);
            })
            .map_err(|error| format!("could not monitor authenticated bridge lease: {error}"))?;
        let arm = ARM_BYTE;
        // SAFETY: arm_writer is the private, live guard pipe and arm is readable.
        let result = unsafe { libc::write(arm_writer.as_raw_fd(), (&arm as *const u8).cast(), 1) };
        drop(arm_writer);
        if result != 1 {
            self.death_writer.take();
            return Err(format!(
                "could not arm authenticated containment: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    fn pid(&self) -> libc::pid_t {
        self.pid
    }
}

pub(crate) fn start(
    containment_pgid: libc::pid_t,
    authentication_timeout: Duration,
) -> Result<ContainmentGuard, String> {
    if containment_pgid <= 1 {
        return Err("invalid containment process group".to_owned());
    }
    let (death_read, death_write) = pipe_cloexec()?;
    let (arm_read, arm_write) = pipe_cloexec()?;
    let (liveness_read, liveness_write) = pipe_cloexec()?;
    let (ready_read, ready_write) = pipe_cloexec()?;
    // Snapshot the exact descriptor table while the broker is still
    // single-threaded. macOS commonly reports a million-entry fd limit, so a
    // numeric close loop would make the two-second arm bound unreliable.
    let mut open_fds: Vec<RawFd> = {
        let entries = std::fs::read_dir("/dev/fd")
            .map_err(|error| format!("could not enumerate broker descriptors: {error}"))?;
        let mut descriptors = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("could not read broker descriptor entry: {error}"))?;
            if let Some(descriptor) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<RawFd>().ok())
            {
                descriptors.push(descriptor);
            }
        }
        descriptors
    };
    open_fds.extend([
        death_read.as_raw_fd(),
        death_write.as_raw_fd(),
        arm_read.as_raw_fd(),
        arm_write.as_raw_fd(),
        liveness_read.as_raw_fd(),
        liveness_write.as_raw_fd(),
        ready_read.as_raw_fd(),
        ready_write.as_raw_fd(),
    ]);
    open_fds.sort_unstable();
    open_fds.dedup();
    // SAFETY: the broker is single-threaded at this point. The child branch
    // calls only libc and ends with _exit.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(format!(
            "could not fork containment guard: {}",
            io::Error::last_os_error()
        ));
    }
    if pid == 0 {
        guard_child(
            containment_pgid,
            GuardChildFds {
                death_read: death_read.as_raw_fd(),
                death_write: death_write.as_raw_fd(),
                arm_read: arm_read.as_raw_fd(),
                arm_write: arm_write.as_raw_fd(),
                ready_read: ready_read.as_raw_fd(),
                ready_write: ready_write.as_raw_fd(),
                liveness: liveness_read.as_raw_fd(),
            },
            authentication_timeout
                .as_millis()
                .clamp(1, libc::c_int::MAX as u128) as libc::c_int,
            &open_fds,
        );
    }

    drop(death_read);
    drop(arm_read);
    drop(liveness_read);
    drop(ready_write);
    let mut poll_descriptor = libc::pollfd {
        fd: ready_read.as_raw_fd(),
        events: libc::POLLIN | libc::POLLHUP,
        revents: 0,
    };
    // SAFETY: poll_descriptor points to one initialized pollfd.
    let poll_result = unsafe { libc::poll(&mut poll_descriptor, 1, READY_TIMEOUT_MS) };
    let mut ready = 0_u8;
    // SAFETY: ready_read is live and ready is writable.
    let read_result = if poll_result > 0 {
        unsafe { libc::read(ready_read.as_raw_fd(), (&mut ready as *mut u8).cast(), 1) }
    } else {
        -1
    };
    drop(ready_read);
    if poll_result <= 0 || read_result != 1 || ready != READY_BYTE {
        // Keep the lease writer open while killing the unarmed child so it
        // cannot enter its EOF-triggered group teardown path.
        // SAFETY: pid is the unreaped child returned by fork.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        waitpid_blocking(pid);
        return Err("containment guard did not arm in time".to_owned());
    }
    Ok(ContainmentGuard {
        death_writer: Some(death_write),
        arm_writer: Some(arm_write),
        liveness_writer: Some(liveness_write),
        #[cfg(test)]
        pid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn guard_holds_group_after_leader_crash_and_kills_term_ignoring_descendant() {
        let pid_file = format!("/tmp/acu-guard-child-{}.pid", std::process::id());
        let _ = fs::remove_file(&pid_file);
        let script = r#"
(
  trap '' TERM
  while :; do /bin/sleep 30; done
) &
printf '%s\n' "$!" > "$1"
while :; do /bin/sleep 30; done
"#;
        let mut broker = Command::new("/bin/sh")
            .args(["-c", script, "aiden-guard-test", &pid_file])
            .process_group(0)
            .spawn()
            .unwrap();
        let guard = start(broker.id() as libc::pid_t, Duration::from_secs(30)).unwrap();
        let guard_pid = guard.pid();
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

        // Simulate an uncatchable broker crash first. The guard remains in the
        // group as its PGID lease; closing the death writer then models the
        // kernel closing the crashed broker's descriptor table.
        // SAFETY: broker is an unreaped child owned by this test.
        assert_eq!(
            unsafe { libc::kill(broker.id() as libc::pid_t, libc::SIGKILL) },
            0
        );
        broker.wait().unwrap();
        drop(guard);
        waitpid_blocking(guard_pid);
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
                "containment guard left a TERM-ignoring descendant alive"
            );
            thread::sleep(Duration::from_millis(20));
        }
        let _ = fs::remove_file(pid_file);
    }

    #[test]
    fn authenticated_bridge_lease_eof_revokes_the_whole_broker_group() {
        let mut broker = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; while :; do /bin/sleep 30; done"])
            .process_group(0)
            .spawn()
            .unwrap();
        let (aiden, broker_lease) = UnixStream::pair().unwrap();
        let mut guard = start(broker.id() as libc::pid_t, Duration::from_secs(30)).unwrap();
        guard.monitor_liveness(broker_lease).unwrap();
        let guard_pid = guard.pid();
        drop(aiden);

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if broker.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "broker survived authenticated bridge lease EOF"
            );
            thread::sleep(Duration::from_millis(20));
        }
        waitpid_blocking(guard_pid);
        drop(guard);
    }

    #[test]
    fn unauthenticated_broker_group_is_killed_by_an_independent_deadline() {
        let mut broker = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; while :; do /bin/sleep 30; done"])
            .process_group(0)
            .spawn()
            .unwrap();
        let guard = start(broker.id() as libc::pid_t, Duration::from_millis(100)).unwrap();
        let guard_pid = guard.pid();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if broker.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "pre-authentication containment deadline did not kill broker"
            );
            thread::sleep(Duration::from_millis(20));
        }
        waitpid_blocking(guard_pid);
        drop(guard);
    }
}
