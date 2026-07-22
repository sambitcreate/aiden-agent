use crate::darwin::{
    live_code_identity_for_audit_token, live_code_identity_for_pid, signed_bundle_string,
    static_code_identity, AuditToken,
};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Seek;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub(crate) const AIDEN_BUNDLE_ID: &str = "com.sambitcreate.aiden-agent";
pub(crate) const BROKER_BUNDLE_ID: &str = "com.sambitcreate.aiden-agent.cua-driver";
pub(crate) const AIDEN_TEAM_ID: &str = "5WP229CBB8";
pub(crate) const DRIVER_IDENTIFIER: &str = "cua-driver";
pub(crate) const DRIVER_TEAM_ID: &str = "YCK386LBJ7";
pub(crate) const DRIVER_SHA256: &str =
    "c1c015ccceda4880b9e171dc438700a8276af0eeecfdf0bb4b3fb23298ae7305";
#[cfg(target_arch = "aarch64")]
pub(crate) const DRIVER_CDHASH: &str = "7d385fc08996bc3698ef6295aa970d312bc610c5";
#[cfg(target_arch = "x86_64")]
pub(crate) const DRIVER_CDHASH: &str = "92c53b310cee9d8d71c97e760e2920c9c468086d";
#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
compile_error!("the pinned universal cua-driver has no reviewed slice for this architecture");

const HOST_EXECUTABLE_KEY: &str = "CFBundleExecutable";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileSnapshot {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
}

impl FileSnapshot {
    fn from(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.size(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
        }
    }
}

pub(crate) struct PinnedDriver {
    pub(crate) path: PathBuf,
    snapshot: FileSnapshot,
    _open_file: File,
}

fn current_executable() -> Result<PathBuf, String> {
    fs::canonicalize(
        std::env::current_exe().map_err(|error| format!("could not locate broker: {error}"))?,
    )
    .map_err(|error| format!("could not resolve broker: {error}"))
}

fn helper_app_path() -> Result<PathBuf, String> {
    let executable = current_executable()?;
    let macos = executable
        .parent()
        .ok_or_else(|| "broker executable has no MacOS directory".to_owned())?;
    let contents = macos
        .parent()
        .ok_or_else(|| "broker executable has no helper Contents directory".to_owned())?;
    let helper = contents
        .parent()
        .ok_or_else(|| "broker executable has no helper app directory".to_owned())?;
    if macos.file_name() != Some(OsStr::new("MacOS"))
        || contents.file_name() != Some(OsStr::new("Contents"))
        || helper.file_name() != Some(OsStr::new("CuaDriver.app"))
    {
        return Err("broker is not inside Aiden's packaged CuaDriver.app".to_owned());
    }
    Ok(helper.to_path_buf())
}

fn outer_app_path(helper: &Path) -> Result<PathBuf, String> {
    let helpers = helper
        .parent()
        .ok_or_else(|| "Computer Use helper has no Helpers directory".to_owned())?;
    let contents = helpers
        .parent()
        .ok_or_else(|| "Computer Use helper has no outer Contents directory".to_owned())?;
    let app = contents
        .parent()
        .ok_or_else(|| "Computer Use helper has no outer app bundle".to_owned())?;
    if helpers.file_name() != Some(OsStr::new("Helpers"))
        || contents.file_name() != Some(OsStr::new("Contents"))
        || app.extension() != Some(OsStr::new("app"))
    {
        return Err("Computer Use helper is outside Aiden's packaged helper location".to_owned());
    }
    Ok(app.to_path_buf())
}

fn host_executable_path(outer_app: &Path) -> Result<PathBuf, String> {
    let executable = signed_bundle_string(outer_app, HOST_EXECUTABLE_KEY)?;
    if !is_valid_executable_name(&executable) {
        return Err("Aiden's signed executable name is invalid".to_owned());
    }
    fs::canonicalize(outer_app.join("Contents").join("MacOS").join(executable))
        .map_err(|error| format!("could not resolve Aiden's signed executable: {error}"))
}

fn is_valid_executable_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\0')
}

pub(crate) fn verify_helper_peer(audit_token: &AuditToken) -> Result<(), String> {
    let own = live_code_identity_for_pid(std::process::id(), BROKER_BUNDLE_ID, AIDEN_TEAM_ID)?;
    let peer = live_code_identity_for_audit_token(audit_token, BROKER_BUNDLE_ID, AIDEN_TEAM_ID)?;
    if own.cdhash != peer.cdhash {
        return Err("helper peer is not the exact current broker build".to_owned());
    }
    Ok(())
}

pub(crate) fn verify_aiden_peer(audit_token: &AuditToken) -> Result<(), String> {
    let helper = helper_app_path()?;
    // Validate both nested and enclosing resource seals, then anchor the live
    // peer to the exact enclosing Aiden code object. An older team-signed app
    // from another path cannot satisfy this current-bundle CDHash comparison.
    static_code_identity(&helper, BROKER_BUNDLE_ID, AIDEN_TEAM_ID, false)?;
    let outer_app = outer_app_path(&helper)?;
    let expected = static_code_identity(&outer_app, AIDEN_BUNDLE_ID, AIDEN_TEAM_ID, false)?;
    let expected_executable = host_executable_path(&outer_app)?;
    let peer = live_code_identity_for_audit_token(audit_token, AIDEN_BUNDLE_ID, AIDEN_TEAM_ID)?;
    let peer_executable = peer
        .executable
        .as_deref()
        .ok_or_else(|| "Aiden peer omitted its executable path".to_owned())?;
    let peer_executable = fs::canonicalize(peer_executable)
        .map_err(|error| format!("could not resolve the live Aiden executable: {error}"))?;
    if peer.cdhash != expected.cdhash || peer_executable != expected_executable {
        return Err("Aiden peer is not the exact enclosing signed host build".to_owned());
    }
    Ok(())
}

pub(crate) fn driver_path() -> Result<PathBuf, String> {
    let executable = current_executable()?;
    let macos = executable
        .parent()
        .ok_or_else(|| "broker executable has no parent".to_owned())?;
    if macos.file_name() != Some(OsStr::new("MacOS"))
        || macos.parent().and_then(Path::file_name) != Some(OsStr::new("Contents"))
        || macos
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            != Some(OsStr::new("CuaDriver.app"))
    {
        return Err("broker must run from CuaDriver.app".to_owned());
    }
    Ok(macos.join("cua-driver"))
}

fn file_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect pinned cua-driver: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.mode() & 0o111 == 0
    {
        return Err("pinned cua-driver must be a real executable file".to_owned());
    }
    Ok(FileSnapshot::from(&metadata))
}

pub(crate) fn prepare_pinned_driver() -> Result<PinnedDriver, String> {
    let path = driver_path()?;
    let before = file_snapshot(&path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|error| format!("could not open pinned cua-driver: {error}"))?;
    if FileSnapshot::from(
        &file
            .metadata()
            .map_err(|error| format!("could not inspect open cua-driver: {error}"))?,
    ) != before
    {
        return Err("cua-driver changed while it was opened".to_owned());
    }
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .map_err(|error| format!("could not hash pinned cua-driver: {error}"))?;
    let digest = format!("{:x}", hasher.finalize());
    if digest != DRIVER_SHA256 {
        return Err("pinned cua-driver SHA-256 does not match the reviewed release".to_owned());
    }
    file.rewind()
        .map_err(|error| format!("could not rewind pinned cua-driver: {error}"))?;
    let identity = static_code_identity(&path, DRIVER_IDENTIFIER, DRIVER_TEAM_ID, true)?;
    if identity.cdhash != DRIVER_CDHASH {
        return Err("pinned cua-driver CDHash does not match the reviewed release".to_owned());
    }
    if file_snapshot(&path)? != before {
        return Err("cua-driver changed during signature verification".to_owned());
    }
    Ok(PinnedDriver {
        path,
        snapshot: before,
        _open_file: file,
    })
}

impl PinnedDriver {
    pub(crate) fn verify_path_unchanged(&self) -> Result<(), String> {
        if file_snapshot(&self.path)? != self.snapshot {
            return Err("cua-driver changed while the constrained process was created".to_owned());
        }
        Ok(())
    }
}

pub(crate) fn verify_live_driver(pid: u32) -> Result<(), String> {
    let identity = live_code_identity_for_pid(pid, DRIVER_IDENTIFIER, DRIVER_TEAM_ID)?;
    if identity.cdhash != DRIVER_CDHASH {
        return Err("live cua-driver CDHash does not match the pinned release".to_owned());
    }
    verify_live_driver_path(&identity)
}

pub(crate) fn verify_live_driver_audit_token(audit_token: &AuditToken) -> Result<(), String> {
    let identity =
        live_code_identity_for_audit_token(audit_token, DRIVER_IDENTIFIER, DRIVER_TEAM_ID)?;
    if identity.cdhash != DRIVER_CDHASH {
        return Err("live cua-driver CDHash does not match the pinned release".to_owned());
    }
    verify_live_driver_path(&identity)
}

fn verify_live_driver_path(identity: &crate::darwin::CodeIdentity) -> Result<(), String> {
    let executable = identity
        .executable
        .as_deref()
        .ok_or_else(|| "live cua-driver omitted its executable path".to_owned())?;
    let executable = fs::canonicalize(executable)
        .map_err(|error| format!("could not resolve live cua-driver: {error}"))?;
    let expected = fs::canonicalize(driver_path()?)
        .map_err(|error| format!("could not resolve pinned cua-driver: {error}"))?;
    if executable != expected {
        return Err("live cua-driver executable path does not match the pinned helper".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_all_three_release_identity_dimensions() {
        assert_eq!(DRIVER_IDENTIFIER, "cua-driver");
        assert_eq!(DRIVER_TEAM_ID, "YCK386LBJ7");
        assert_eq!(DRIVER_SHA256.len(), 64);
        assert_eq!(DRIVER_CDHASH.len(), 40);
    }

    #[test]
    fn pins_the_current_universal_slice_cdhash() {
        #[cfg(target_arch = "aarch64")]
        assert_eq!(DRIVER_CDHASH, "7d385fc08996bc3698ef6295aa970d312bc610c5");
        #[cfg(target_arch = "x86_64")]
        assert_eq!(DRIVER_CDHASH, "92c53b310cee9d8d71c97e760e2920c9c468086d");
    }

    #[test]
    fn host_executable_name_rejects_path_authority() {
        assert!(is_valid_executable_name("Aiden Agent"));
        assert!(is_valid_executable_name("Aiden Agent.exe"));
        for invalid in ["", ".", "..", "../Aiden Agent", "MacOS/Aiden Agent"] {
            assert!(!is_valid_executable_name(invalid));
        }
    }
}
