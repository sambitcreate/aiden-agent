use crate::darwin::AuditToken;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

const CONTROL_SOCKET_NAME: &str = "control.sock";
const LAUNCH_LEASE_SOCKET_NAME: &str = "lease.sock";
const DARWIN_UNIX_PATH_MAX: usize = 103;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

impl FileIdentity {
    fn from(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

fn secure_parent(path: &Path, expected_name: &str) -> Result<(PathBuf, FileIdentity), String> {
    if !path.is_absolute() {
        return Err("control socket must be absolute".to_owned());
    }
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name) {
        return Err(format!("socket must use the fixed {expected_name} name"));
    }
    if path.as_os_str().as_bytes().len() > DARWIN_UNIX_PATH_MAX {
        return Err("control socket path is too long".to_owned());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "control socket has no parent".to_owned())?;
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| format!("could not inspect control directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("control directory must be a real directory".to_owned());
    }
    if metadata.uid() != current_uid() || metadata.mode() & 0o777 != 0o700 {
        return Err("control directory must be current-user owned with mode 0700".to_owned());
    }
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("could not resolve control directory: {error}"))?;
    let canonical_temp = fs::canonicalize("/tmp")
        .map_err(|error| format!("could not resolve system temporary directory: {error}"))?;
    if canonical_parent.parent() != Some(canonical_temp.as_path())
        || !canonical_parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("acu-") && name.len() > 4)
    {
        return Err("control directory is outside Aiden's confined temporary namespace".to_owned());
    }
    Ok((canonical_parent, FileIdentity::from(&metadata)))
}

fn ensure_absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err("control socket path already exists".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not inspect control socket path: {error}")),
    }
}

fn verify_bound_socket_descriptor(descriptor: RawFd) -> Result<(), String> {
    // SAFETY: zeroed stat is a valid output buffer for fstat.
    let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: descriptor is the live UnixListener fd and metadata is writable.
    if unsafe { libc::fstat(descriptor, &mut metadata) } != 0 {
        return Err(format!(
            "could not inspect bound control socket: {}",
            io::Error::last_os_error()
        ));
    }
    if metadata.st_mode & libc::S_IFMT != libc::S_IFSOCK {
        return Err("bound control descriptor is not a Unix socket".to_owned());
    }
    Ok(())
}

fn bind_socket(path: &Path, expected_name: &str) -> Result<UnixListener, String> {
    let (_, parent_identity) = secure_parent(path, expected_name)?;
    ensure_absent(path)?;
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("could not bind control socket: {error}"))?;
    // Darwin's fstat for an AF_UNIX descriptor reports an internal socket
    // object rather than the filesystem vnode (st_dev is -1), so it cannot be
    // compared with lstat(path). Verify the descriptor type, then capture the
    // pathname inode immediately; every later pathname action is conditional
    // on that inode and the unchanged parent inode.
    verify_bound_socket_descriptor(listener.as_raw_fd())?;
    let bound_socket = fs::symlink_metadata(path)
        .map_err(|error| format!("control socket disappeared during bind: {error}"))?;
    let bound_identity = FileIdentity::from(&bound_socket);
    let parent = path.parent().expect("secure_parent checked the parent");
    let validation = (|| -> Result<(), String> {
        let parent_after = fs::symlink_metadata(parent)
            .map_err(|error| format!("control directory changed during bind: {error}"))?;
        let socket = fs::symlink_metadata(path)
            .map_err(|error| format!("control socket disappeared during bind: {error}"))?;
        if FileIdentity::from(&parent_after) != parent_identity
            || !socket.file_type().is_socket()
            || socket.uid() != current_uid()
            || FileIdentity::from(&socket) != bound_identity
        {
            return Err("control socket changed during bind".to_owned());
        }
        Ok(())
    })();
    if let Err(error) = validation {
        drop(listener);
        return Err(error);
    }
    // Deliberately never unlink the pathname here. Darwin does not expose a
    // filesystem vnode identity through fstat(AF_UNIX), so no native cleanup
    // can prove a path still names the bound socket. Aiden removes only its
    // private mkdtemp directory after every child has exited.
    Ok(listener)
}

pub(crate) fn bind_control(path: &Path) -> Result<UnixListener, String> {
    bind_socket(path, CONTROL_SOCKET_NAME)
}

pub(crate) fn bind_launch_lease(path: &Path) -> Result<UnixListener, String> {
    bind_socket(path, LAUNCH_LEASE_SOCKET_NAME)
}

pub(crate) fn validate_control_connect_target(path: &Path) -> Result<(), String> {
    validate_socket_target(path, CONTROL_SOCKET_NAME)
}

pub(crate) fn validate_launch_lease_connect_target(path: &Path) -> Result<(), String> {
    validate_socket_target(path, LAUNCH_LEASE_SOCKET_NAME)
}

fn validate_socket_target(path: &Path, expected_name: &str) -> Result<(), String> {
    secure_parent(path, expected_name)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect control socket: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_socket()
        || metadata.uid() != current_uid()
    {
        return Err("control target is not Aiden's current-user Unix socket".to_owned());
    }
    Ok(())
}

pub(crate) fn peer_audit_token(stream: &UnixStream) -> io::Result<AuditToken> {
    let mut token = AuditToken::zeroed();
    let mut length = std::mem::size_of::<AuditToken>() as libc::socklen_t;
    // SAFETY: token and length point to writable objects of the advertised size,
    // and stream owns a live Unix-domain socket descriptor.
    let result = unsafe {
        libc::getsockopt(
            std::os::fd::AsRawFd::as_raw_fd(stream),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERTOKEN,
            (&mut token as *mut AuditToken).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize != std::mem::size_of::<AuditToken>() || token.pid().is_err() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid Unix peer audit token",
        ));
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn test_directory() -> PathBuf {
        let path = Path::new("/tmp").join(format!(
            "acu-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(&path).unwrap();
        path
    }

    #[test]
    fn confines_socket_to_fixed_name_in_owned_0700_temp_directory() {
        let directory = test_directory();
        let socket = directory.join(CONTROL_SOCKET_NAME);
        let listener = bind_control(&socket).unwrap();
        drop(listener);
        fs::remove_file(&socket).unwrap();
        assert!(bind_control(&directory.join("other.sock")).is_err());
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(secure_parent(&socket, CONTROL_SOCKET_NAME).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn refuses_preexisting_files_and_symlinks() {
        let directory = test_directory();
        let socket = directory.join(CONTROL_SOCKET_NAME);
        fs::write(&socket, b"occupied").unwrap();
        assert!(bind_control(&socket).is_err());
        fs::remove_file(&socket).unwrap();
        symlink("/tmp", &socket).unwrap();
        assert!(bind_control(&socket).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn broker_never_unlinks_a_socket_path_or_replacement() {
        let directory = test_directory();
        let socket = directory.join(CONTROL_SOCKET_NAME);
        let listener = bind_control(&socket).unwrap();
        let original = directory.join("original.sock");
        fs::rename(&socket, &original).unwrap();
        fs::write(&socket, b"replacement").unwrap();
        drop(listener);
        assert_eq!(fs::read(&socket).unwrap(), b"replacement");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_peer_audit_token_comes_from_the_kernel_socket() {
        let (left, right) = UnixStream::pair().unwrap();
        let left = peer_audit_token(&left).unwrap();
        let right = peer_audit_token(&right).unwrap();
        assert_eq!(left.pid().unwrap(), std::process::id());
        assert_eq!(right.pid().unwrap(), std::process::id());
        assert_eq!(left, right);
        assert_eq!(std::mem::size_of::<AuditToken>(), 32);
    }

    #[test]
    fn launch_lease_requires_the_short_fixed_name_and_same_private_parent() {
        let directory = test_directory();
        let lease = directory.join(LAUNCH_LEASE_SOCKET_NAME);
        let listener = bind_launch_lease(&lease).unwrap();
        assert!(bind_launch_lease(&directory.join("verbose-lease.sock")).is_err());
        drop(listener);
        fs::remove_dir_all(directory).unwrap();
    }
}
