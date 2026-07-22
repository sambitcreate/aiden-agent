use std::ffi::{CStr, CString, OsStr};
use std::os::fd::RawFd;
use std::os::raw::{c_char, c_int};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;

const ERROR_CAPACITY: usize = 1_024;
const CDHASH_CAPACITY: usize = 41;
const PATH_CAPACITY: usize = 4_096;

unsafe extern "C" {
    fn aiden_request_computer_use_permissions();
    fn aiden_copy_live_code_identity(
        pid: c_int,
        identifier: *const c_char,
        team: *const c_char,
        cdhash: *mut c_char,
        cdhash_capacity: usize,
        executable: *mut c_char,
        executable_capacity: usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn aiden_copy_live_code_identity_for_audit_token(
        audit_token: *const AuditToken,
        identifier: *const c_char,
        team: *const c_char,
        cdhash: *mut c_char,
        cdhash_capacity: usize,
        executable: *mut c_char,
        executable_capacity: usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn aiden_audit_token_pid(audit_token: *const AuditToken) -> c_int;
    fn aiden_copy_process_audit_token(
        pid: c_int,
        audit_token_output: *mut AuditToken,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn aiden_copy_static_code_identity(
        path: *const c_char,
        identifier: *const c_char,
        team: *const c_char,
        check_all_architectures: bool,
        cdhash: *mut c_char,
        cdhash_capacity: usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn aiden_copy_bundle_info_string(
        bundle_path: *const c_char,
        key: *const c_char,
        output: *mut c_char,
        output_capacity: usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn aiden_spawn_constrained_driver(
        path: *const c_char,
        arguments: *const *const c_char,
        environment: *const *const c_char,
        stdin_fd: c_int,
        stdout_fd: c_int,
        stderr_fd: c_int,
        pid_output: *mut c_int,
        task_output: *mut *mut std::ffi::c_void,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn aiden_task_wait(
        task_handle: *mut std::ffi::c_void,
        status_output: *mut c_int,
        reason_output: *mut c_int,
    ) -> c_int;
    #[cfg(test)]
    fn aiden_task_is_running(task_handle: *mut std::ffi::c_void) -> bool;
    fn aiden_task_terminate(task_handle: *mut std::ffi::c_void);
    fn aiden_task_release(task_handle: *mut std::ffi::c_void);
    fn proc_signal_with_audittoken(audit_token: *mut AuditToken, signal: c_int) -> c_int;
    #[cfg(test)]
    fn aiden_cua_launch_requirement_bytes(length: *mut usize) -> *const u8;
}

/// Raise macOS's Accessibility and Screen Recording prompts from the exact
/// LaunchServices-owned helper that is responsible for the embedded driver.
pub(crate) fn request_computer_use_permissions() {
    // SAFETY: the Objective-C shim takes no pointers and owns its autorelease
    // pool. Invocation is reachable only after the bridge has authenticated
    // Aiden and the broker has authenticated that exact bridge incarnation.
    unsafe { aiden_request_computer_use_permissions() };
}

/// Kernel-issued identity for one exact process incarnation. Unlike a numeric
/// PID, the token's PID-version component cannot silently name a recycled
/// process after an authenticated Unix socket endpoint is transferred.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AuditToken {
    values: [libc::c_uint; 8],
}

impl AuditToken {
    pub(crate) fn zeroed() -> Self {
        Self { values: [0; 8] }
    }

    pub(crate) fn pid(&self) -> Result<u32, String> {
        // SAFETY: self has the exact audit_token_t layout consumed by the shim.
        let pid = unsafe { aiden_audit_token_pid(self) };
        if pid <= 1 {
            Err("invalid peer audit token process id".to_owned())
        } else {
            Ok(pid as u32)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProcessInfo {
    pub(crate) pid: u32,
    pub(crate) parent_pid: u32,
    pub(crate) process_group: u32,
    pub(crate) stopped: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CodeIdentity {
    pub(crate) cdhash: String,
    pub(crate) executable: Option<PathBuf>,
}

pub(crate) struct DarwinTask {
    pid: libc::pid_t,
    handle: *mut std::ffi::c_void,
    audit_token: Option<AuditToken>,
}

impl DarwinTask {
    pub(crate) fn pid(&self) -> libc::pid_t {
        self.pid
    }

    pub(crate) fn wait(&self) -> Result<(i32, i32), String> {
        let mut status = 0;
        let mut reason = 0;
        // SAFETY: handle is retained by the native launch shim until Drop.
        let result = unsafe { aiden_task_wait(self.handle, &mut status, &mut reason) };
        if result == 0 {
            Ok((status, reason))
        } else {
            Err(format!(
                "could not wait for constrained task (status {result})"
            ))
        }
    }

    pub(crate) fn capture_exact_identity(
        &mut self,
        expected_parent: u32,
        expected_group: u32,
    ) -> Result<(), String> {
        self.audit_token = Some(capture_exact_child_audit_token(
            self.pid as u32,
            expected_parent,
            expected_group,
        )?);
        Ok(())
    }

    pub(crate) fn terminate_exact_and_wait(&self) {
        if let Some(token) = self.audit_token.as_ref() {
            let _ = signal_process(token, libc::SIGKILL);
        }
        let _ = self.wait();
    }

    pub(crate) fn terminate_before_identity_and_wait(&self) {
        debug_assert!(self.audit_token.is_none());
        // This fallback is used only immediately after launch returns and exact
        // identity capture fails, before any cached PID can become cleanup
        // authority. The independent watchdog is already scanning in parallel.
        // SAFETY: handle is the freshly retained NSTask returned by this launch.
        unsafe { aiden_task_terminate(self.handle) };
        let _ = self.wait();
    }

    #[cfg(test)]
    pub(crate) fn is_running(&self) -> bool {
        // SAFETY: handle remains retained until Drop.
        unsafe { aiden_task_is_running(self.handle) }
    }
}

impl Drop for DarwinTask {
    fn drop(&mut self) {
        // SAFETY: the retained native task is released exactly once here.
        unsafe { aiden_task_release(self.handle) };
    }
}

fn cstring(value: &OsStr, label: &str) -> Result<CString, String> {
    CString::new(value.as_bytes()).map_err(|_| format!("{label} contains a NUL byte"))
}

fn string_buffer<const N: usize>() -> [c_char; N] {
    [0; N]
}

fn read_buffer(buffer: &[c_char]) -> Result<String, String> {
    // SAFETY: every native writer receives the buffer capacity and always NUL terminates.
    let value = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    value
        .to_str()
        .map(str::to_owned)
        .map_err(|_| "Darwin security returned invalid UTF-8".to_owned())
}

fn native_error(status: c_int, buffer: &[c_char], operation: &str) -> String {
    let detail = read_buffer(buffer).unwrap_or_else(|_| "unknown error".to_owned());
    format!("{operation}: {detail} (status {status})")
}

pub(crate) fn process_audit_token(pid: u32) -> Result<AuditToken, String> {
    if pid <= 1 || pid > c_int::MAX as u32 {
        return Err("refusing invalid process identity target".to_owned());
    }
    let mut token = AuditToken::zeroed();
    let mut error = string_buffer::<ERROR_CAPACITY>();
    // SAFETY: token and error point to writable storage with the supplied exact layout/capacity.
    let status = unsafe {
        aiden_copy_process_audit_token(pid as c_int, &mut token, error.as_mut_ptr(), error.len())
    };
    if status != 0 {
        return Err(native_error(
            status,
            &error,
            "process identity capture failed",
        ));
    }
    if token.pid()? != pid {
        return Err("process identity changed during capture".to_owned());
    }
    Ok(token)
}

pub(crate) fn capture_exact_child_audit_token(
    pid: u32,
    expected_parent: u32,
    expected_group: u32,
) -> Result<AuditToken, String> {
    let token = process_audit_token(pid)?;
    let info = process_info(&token)?;
    if info.pid != pid || info.parent_pid != expected_parent || info.process_group != expected_group
    {
        return Err("constrained task identity changed before it could be retained".to_owned());
    }
    Ok(token)
}

pub(crate) fn signal_process(
    audit_token: &AuditToken,
    signal: c_int,
) -> Result<(), std::io::Error> {
    // proc_signal_with_audittoken validates both PID and PID-version in the
    // kernel, so an exited process cannot redirect this signal to a recycled PID.
    let mut token = *audit_token;
    // SAFETY: token has audit_token_t layout and remains live for the call.
    let status = unsafe { proc_signal_with_audittoken(&mut token, signal) };
    if status == 0 {
        return Ok(());
    }
    if status == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Err(std::io::Error::from_raw_os_error(status))
}

pub(crate) fn process_info(audit_token: &AuditToken) -> Result<ProcessInfo, String> {
    let pid = audit_token.pid()?;
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: info points to writable proc_bsdinfo storage of the exact supplied size.
    let count = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as c_int,
        )
    };
    if count != std::mem::size_of::<libc::proc_bsdinfo>() as c_int {
        return Err(format!(
            "could not inspect exact process identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: proc_pidinfo filled the complete structure as proven by count.
    let info = unsafe { info.assume_init() };
    let current = process_audit_token(pid)
        .map_err(|error| format!("process identity is no longer live: {error}"))?;
    if current != *audit_token {
        return Err("process identity changed during inspection".to_owned());
    }
    if info.pbi_pid != pid {
        return Err("process identity changed during inspection".to_owned());
    }
    Ok(ProcessInfo {
        pid,
        parent_pid: info.pbi_ppid,
        process_group: info.pbi_pgid,
        stopped: info.pbi_status == libc::SSTOP,
    })
}

pub(crate) fn child_processes(parent_pid: u32) -> Result<Vec<u32>, String> {
    if parent_pid <= 1 || parent_pid > c_int::MAX as u32 {
        return Err("refusing invalid child-process parent".to_owned());
    }
    // The dedicated launcher has only two known supervisor children plus one
    // NSTask child. A generous fixed bound avoids an allocation-sizing race.
    let mut children = [0 as libc::pid_t; 64];
    // SAFETY: children is writable and buffersize is its exact byte capacity.
    let count = unsafe {
        libc::proc_listchildpids(
            parent_pid as c_int,
            children.as_mut_ptr().cast(),
            std::mem::size_of_val(&children) as c_int,
        )
    };
    if count < 0 {
        return Err(format!(
            "could not enumerate constrained launcher children: {}",
            std::io::Error::last_os_error()
        ));
    }
    if count as usize >= children.len() {
        return Err("constrained launcher created too many children".to_owned());
    }
    Ok(children[..count as usize]
        .iter()
        .copied()
        .filter(|pid| *pid > 1)
        .map(|pid| pid as u32)
        .collect())
}

pub(crate) fn live_code_identity_for_pid(
    pid: u32,
    identifier: &str,
    team: &str,
) -> Result<CodeIdentity, String> {
    if pid <= 1 || pid > c_int::MAX as u32 {
        return Err("refusing invalid live process id".to_owned());
    }
    let identifier = CString::new(identifier).map_err(|_| "invalid code identifier".to_owned())?;
    let team = CString::new(team).map_err(|_| "invalid signing team".to_owned())?;
    let mut cdhash = string_buffer::<CDHASH_CAPACITY>();
    let mut executable = string_buffer::<PATH_CAPACITY>();
    let mut error = string_buffer::<ERROR_CAPACITY>();
    // SAFETY: every pointer references writable or immutable storage of the supplied capacity.
    let status = unsafe {
        aiden_copy_live_code_identity(
            pid as c_int,
            identifier.as_ptr(),
            team.as_ptr(),
            cdhash.as_mut_ptr(),
            cdhash.len(),
            executable.as_mut_ptr(),
            executable.len(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(native_error(status, &error, "live code validation failed"));
    }
    Ok(CodeIdentity {
        cdhash: read_buffer(&cdhash)?,
        executable: Some(PathBuf::from(read_buffer(&executable)?)),
    })
}

pub(crate) fn live_code_identity_for_audit_token(
    audit_token: &AuditToken,
    identifier: &str,
    team: &str,
) -> Result<CodeIdentity, String> {
    audit_token.pid()?;
    let identifier = CString::new(identifier).map_err(|_| "invalid code identifier".to_owned())?;
    let team = CString::new(team).map_err(|_| "invalid signing team".to_owned())?;
    let mut cdhash = string_buffer::<CDHASH_CAPACITY>();
    let mut executable = string_buffer::<PATH_CAPACITY>();
    let mut error = string_buffer::<ERROR_CAPACITY>();
    // SAFETY: the audit token and every output pointer reference storage with
    // the supplied exact layout/capacity for the duration of this call.
    let status = unsafe {
        aiden_copy_live_code_identity_for_audit_token(
            audit_token,
            identifier.as_ptr(),
            team.as_ptr(),
            cdhash.as_mut_ptr(),
            cdhash.len(),
            executable.as_mut_ptr(),
            executable.len(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(native_error(
            status,
            &error,
            "audit-token code validation failed",
        ));
    }
    Ok(CodeIdentity {
        cdhash: read_buffer(&cdhash)?,
        executable: Some(PathBuf::from(read_buffer(&executable)?)),
    })
}

pub(crate) fn static_code_identity(
    path: &Path,
    identifier: &str,
    team: &str,
    check_all_architectures: bool,
) -> Result<CodeIdentity, String> {
    let path = cstring(path.as_os_str(), "code path")?;
    let identifier = CString::new(identifier).map_err(|_| "invalid code identifier".to_owned())?;
    let team = CString::new(team).map_err(|_| "invalid signing team".to_owned())?;
    let mut cdhash = string_buffer::<CDHASH_CAPACITY>();
    let mut error = string_buffer::<ERROR_CAPACITY>();
    // SAFETY: every pointer references writable or immutable storage of the supplied capacity.
    let status = unsafe {
        aiden_copy_static_code_identity(
            path.as_ptr(),
            identifier.as_ptr(),
            team.as_ptr(),
            check_all_architectures,
            cdhash.as_mut_ptr(),
            cdhash.len(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(native_error(
            status,
            &error,
            "static code validation failed",
        ));
    }
    Ok(CodeIdentity {
        cdhash: read_buffer(&cdhash)?,
        executable: None,
    })
}

pub(crate) fn signed_bundle_string(bundle: &Path, key: &str) -> Result<String, String> {
    let bundle = cstring(bundle.as_os_str(), "bundle path")?;
    let key = CString::new(key).map_err(|_| "invalid bundle metadata key".to_owned())?;
    let mut output = string_buffer::<PATH_CAPACITY>();
    let mut error = string_buffer::<ERROR_CAPACITY>();
    // SAFETY: every pointer references writable or immutable storage of the supplied capacity.
    let status = unsafe {
        aiden_copy_bundle_info_string(
            bundle.as_ptr(),
            key.as_ptr(),
            output.as_mut_ptr(),
            output.len(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(native_error(
            status,
            &error,
            "signed helper metadata failed",
        ));
    }
    read_buffer(&output)
}

pub(crate) fn spawn_constrained_driver(
    path: &Path,
    arguments: &[CString],
    environment: &[CString],
    stdin_fd: RawFd,
    stdout_fd: RawFd,
    stderr_fd: RawFd,
) -> Result<DarwinTask, String> {
    let path = cstring(path.as_os_str(), "cua-driver path")?;
    let mut argument_pointers: Vec<*const c_char> =
        arguments.iter().map(|value| value.as_ptr()).collect();
    argument_pointers.push(ptr::null());
    let mut environment_pointers: Vec<*const c_char> =
        environment.iter().map(|value| value.as_ptr()).collect();
    environment_pointers.push(ptr::null());
    let mut pid = 0;
    let mut task = ptr::null_mut();
    let mut error = string_buffer::<ERROR_CAPACITY>();
    // SAFETY: arrays are NUL terminated and every descriptor remains live for the launch call.
    let status = unsafe {
        aiden_spawn_constrained_driver(
            path.as_ptr(),
            argument_pointers.as_ptr(),
            environment_pointers.as_ptr(),
            stdin_fd,
            stdout_fd,
            stderr_fd,
            &mut pid,
            &mut task,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 || pid <= 1 || task.is_null() {
        return Err(native_error(
            status,
            &error,
            "kernel-constrained cua-driver launch failed",
        ));
    }
    Ok(DarwinTask {
        pid,
        handle: task,
        audit_token: None,
    })
}

#[cfg(test)]
pub(crate) fn launch_requirement_bytes() -> &'static [u8] {
    let mut length = 0;
    // SAFETY: the shim returns a process-lifetime pointer to its static byte array.
    let bytes = unsafe { aiden_cua_launch_requirement_bytes(&mut length) };
    // SAFETY: the returned array is static and the companion length is exact.
    unsafe { std::slice::from_raw_parts(bytes, length) }
}
