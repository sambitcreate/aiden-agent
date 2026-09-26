use crate::inventory::{Result, ENTRIES};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::MetadataExt,
};

fn name(value: &str) -> Result<CString> {
    Ok(CString::new(value)?)
}
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
const NO_XDEV: u64 = 0x01;
const NO_MAGICLINKS: u64 = 0x02;
const NO_SYMLINKS: u64 = 0x04;
const BENEATH: u64 = 0x08;
/// No compatibility fallback: insufficient kernel path-resolution support fails.
pub fn open_at(parent: &File, path: &str, flags: i32, mode: u32, no_xdev: bool) -> Result<File> {
    let how = OpenHow {
        flags: (flags
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if flags & libc::O_PATH == 0 {
                libc::O_NONBLOCK
            } else {
                0
            }) as u64,
        mode: mode as u64,
        resolve: BENEATH | NO_SYMLINKS | NO_MAGICLINKS | if no_xdev { NO_XDEV } else { 0 },
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent.as_raw_fd(),
            name(path)?.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}
/// Classify without device/FIFO I/O, then reopen ONLY our retained kernel FD.
/// This is the intentional exception to caller-path no-magic-link resolution:
/// the numeric name is generated internally, in verified procfs, never supplied
/// by a caller. The O_PATH descriptor pins the inode across source renames.
pub fn read_at(parent: &File, path: &str) -> Result<File> {
    let pinned = open_at(parent, path, libc::O_PATH, 0, true)?;
    read_pinned(&pinned)
}
pub fn read_pinned(pinned: &File) -> Result<File> {
    let before = pinned.metadata()?;
    if !(before.is_dir() || (before.is_file() && before.nlink() == 1)) {
        return Err("unsupported pinned object type/link count".into());
    }
    let proc = File::open("/proc/self/fd")?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(proc.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    if unsafe { stat.assume_init() }.f_type != libc::PROC_SUPER_MAGIC {
        return Err("own descriptor directory is not procfs".into());
    }
    let numeric = name(&pinned.as_raw_fd().to_string())?;
    let raw = unsafe {
        libc::openat(
            proc.as_raw_fd(),
            numeric.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOCTTY,
        )
    };
    if raw < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let file = unsafe { File::from_raw_fd(raw) };
    let after = file.metadata()?;
    if !crate::stage::same(&before, &after) || !crate::stage::same(&before, &pinned.metadata()?) {
        return Err("pinned object changed during reopen".into());
    }
    Ok(file)
}
pub fn absolute(path: &str, trusted: bool) -> Result<File> {
    if !path.starts_with('/')
        || path.len() > 4096
        || path.chars().any(|c| c < ' ' || c == '\u{7f}')
        || (path != "/"
            && path
                .split('/')
                .skip(1)
                .any(|p| p.is_empty() || p == "." || p == ".."))
    {
        return Err("expected canonical absolute directory".into());
    }
    let mut fd = File::open("/")?;
    if trusted {
        protected(&fd, true)?;
    }
    for part in path.split('/').filter(|p| !p.is_empty()) {
        // Trusted root mounts may differ (e.g. /var). Descendants of the final
        // pinned source/store descriptor may not cross mounts.
        fd = open_at(&fd, part, libc::O_RDONLY | libc::O_DIRECTORY, 0, false)?;
        if trusted {
            protected(&fd, true)?;
        }
    }
    Ok(fd)
}
pub fn xattr(file: &File, key: &str) -> Result<Option<Vec<u8>>> {
    let key = name(key)?;
    let mut bytes = vec![0u8; 65536];
    let n = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            key.as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if n < 0 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ENODATA) {
            return Ok(None);
        }
        return Err(err.into());
    }
    bytes.truncate(n as usize);
    Ok(Some(bytes))
}
pub fn no_acl(file: &File) -> Result<()> {
    for key in ["system.posix_acl_access", "system.posix_acl_default"] {
        if xattr(file, key)?.is_some() {
            return Err("ACL is not supported".into());
        }
    }
    Ok(())
}
pub fn protected(file: &File, directory: bool) -> Result<()> {
    let st = file.metadata()?;
    if st.uid() != 0
        || st.gid() != 0
        || st.mode() & 0o022 != 0
        || (directory && !st.is_dir())
        || (!directory && (!st.is_file() || st.nlink() != 1))
    {
        return Err("untrusted ownership, mode, or object type".into());
    }
    no_acl(file)
}
pub fn payload_metadata(file: &File) -> Result<Vec<u8>> {
    no_acl(file)?;
    if xattr(file, "security.capability")?.is_some() {
        return Err("file capabilities forbidden".into());
    }
    let mut names = vec![0u8; 65536];
    let n = unsafe { libc::flistxattr(file.as_raw_fd(), names.as_mut_ptr().cast(), names.len()) };
    if n < 0 {
        return Err(io::Error::last_os_error().into());
    }
    for key in names[..n as usize]
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
    {
        if key != b"security.selinux" {
            return Err("unsupported extended attribute".into());
        }
    }
    let context = xattr(file, "security.selinux")?.ok_or("missing SELinux staging context")?;
    if context.is_empty() {
        return Err("empty SELinux staging context".into());
    }
    Ok(context)
}
pub fn children(directory: &File) -> Result<Vec<String>> {
    let fd = open_at(directory, ".", libc::O_RDONLY | libc::O_DIRECTORY, 0, true)?;
    use std::os::fd::IntoRawFd;
    let raw = fd.into_raw_fd();
    let dir = unsafe { libc::fdopendir(raw) };
    if dir.is_null() {
        unsafe {
            libc::close(raw);
        }
        return Err(io::Error::last_os_error().into());
    }
    let result = (|| {
        let mut names = Vec::new();
        loop {
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(dir) };
            if entry.is_null() {
                if io::Error::last_os_error().raw_os_error() != Some(0) {
                    return Err(io::Error::last_os_error().into());
                }
                break;
            }
            let value = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str()?;
            if value == "." || value == ".." {
                continue;
            }
            if names.len() >= ENTRIES {
                return Err("too many directory entries".into());
            }
            names.push(value.to_owned());
        }
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Ok(names)
    })();
    unsafe {
        libc::closedir(dir);
    }
    result
}
pub fn mkdir(parent: &File, path: &str) -> Result<File> {
    mkdir_with_reopen(parent, path, |parent, path| {
        open_at(parent, path, libc::O_RDONLY | libc::O_DIRECTORY, 0, true)
    })
}
fn mkdir_with_reopen(
    parent: &File,
    path: &str,
    reopen: impl FnOnce(&File, &str) -> Result<File>,
) -> Result<File> {
    let entry = name(path)?;
    if unsafe { libc::mkdirat(parent.as_raw_fd(), entry.as_ptr(), 0o700) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    // Creation has succeeded, so rollback is armed before the fallible reopen.
    // The parent is our trusted private store/tree; no untrusted writer can
    // replace the newly created directory between these descriptor operations.
    match reopen(parent, path) {
        Ok(file) => Ok(file),
        Err(error) => {
            if unsafe { libc::unlinkat(parent.as_raw_fd(), entry.as_ptr(), libc::AT_REMOVEDIR) }
                != 0
            {
                return Err(format!(
                    "directory reopen failed: {error}; rollback failed for {path:?}: {}",
                    io::Error::last_os_error()
                )
                .into());
            }
            parent.sync_all().map_err(|sync| {
                format!("directory reopen failed: {error}; rollback parent fsync failed: {sync}")
            })?;
            Err(error)
        }
    }
}
#[cfg(test)]
pub fn mkdir_reopen_failure(parent: &File, path: &str) -> Result<File> {
    mkdir_with_reopen(parent, path, |_, _| {
        Err("injected post-mkdir reopen failure".into())
    })
}
pub fn chmod(file: &File, mode: u32) -> Result<()> {
    if unsafe { libc::fchmod(file.as_raw_fd(), mode) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}
pub fn remove_tree(parent: &File, entry: &str) -> Result<()> {
    // Only called for our exclusive private temporary generation. Never follows
    // a link or removes a published generation, and all recursion is fd-relative.
    let fd = open_at(parent, entry, libc::O_RDONLY | libc::O_DIRECTORY, 0, true)?;
    chmod(&fd, 0o700)?;
    for child in children(&fd)? {
        let object = open_at(&fd, &child, libc::O_PATH, 0, true)?;
        if object.metadata()?.is_dir() {
            remove_tree(&fd, &child)?;
        } else if unsafe { libc::unlinkat(fd.as_raw_fd(), name(&child)?.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
    }
    if unsafe {
        libc::unlinkat(
            parent.as_raw_fd(),
            name(entry)?.as_ptr(),
            libc::AT_REMOVEDIR,
        )
    } != 0
    {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}
pub fn publish(store: &File, temporary: &str, generation: &str) -> Result<()> {
    if unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            store.as_raw_fd(),
            name(temporary)?.as_ptr(),
            store.as_raw_fd(),
            name(generation)?.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}

#[link(name = "selinux")]
unsafe extern "C" {
    fn getfscreatecon_raw(context: *mut *mut libc::c_char) -> libc::c_int;
    fn setfscreatecon_raw(context: *const libc::c_char) -> libc::c_int;
    fn freecon(context: *mut libc::c_char);
}
fn creation_context() -> Result<Option<Vec<u8>>> {
    let mut raw = std::ptr::null_mut();
    if unsafe { getfscreatecon_raw(&mut raw) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    if raw.is_null() {
        return Ok(None);
    }
    let value = unsafe { CStr::from_ptr(raw) }.to_bytes_with_nul().to_vec();
    unsafe {
        freecon(raw);
    }
    Ok(Some(value))
}
/// libselinux addresses the current thread's fscreate context. This guard never
/// changes global policy or relabels existing files. Reset failure terminates
/// the process: returning to a caller with a leaked creation context is unsafe.
pub struct CreationContext {
    active: bool,
}
impl CreationContext {
    pub fn enter(context: &[u8]) -> Result<Self> {
        if creation_context()?.is_some() {
            return Err("preexisting fscreate context is unsupported".into());
        }
        let context = CStr::from_bytes_with_nul(context)?;
        let mut guard = Self { active: true };
        if unsafe { setfscreatecon_raw(context.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        if creation_context()?.as_deref() != Some(context.to_bytes_with_nul()) {
            guard.reset()?;
            return Err("fscreate context readback mismatch".into());
        }
        Ok(guard)
    }
    pub fn reset(&mut self) -> Result<()> {
        if !self.active {
            return Ok(());
        }
        if unsafe { setfscreatecon_raw(std::ptr::null()) } != 0 || creation_context()?.is_some() {
            return Err("failed to restore default fscreate context".into());
        }
        self.active = false;
        Ok(())
    }
}
impl Drop for CreationContext {
    fn drop(&mut self) {
        if let Err(error) = self.reset() {
            eprintln!("fatal managed staging context restoration failure: {error}");
            std::process::abort();
        }
    }
}
