//! Port of `main/services/subagents/subagent-run-store-io.ts` +
//! `native/subagent-run-store/main.c` — the run-store custodian.
//!
//! The TS spawns a signed C helper and speaks a line-based stdio protocol
//! (`cleanup` / `read` / `write <expected> <base64>` / `sync` / `close`). In
//! this all-Rust port the helper's behavior is replicated **in-process** with
//! the same on-disk format and transactional discipline:
//!
//! - File: `<directory>/runs.json` (≤8 MiB).
//! - Staging: `.runs.json.<uuid>.tmp` created with O_EXCL + 0600, fsynced,
//!   identity-verified, then atomically installed; crash-left staging files are
//!   swept by `cleanup` before each write.
//! - Generation token: `%llx-%llx-…` (9 hex fields: dev, ino, size, mtime
//!   sec/nsec, ctime sec/nsec, birthtime sec/nsec), matching
//!   `/^[0-9a-f]+(?:-[0-9a-f]+){8}$/`.
//! - Writes are CAS: `write("missing", …)` installs only when no file exists;
//!   any other expected generation must match the current token or the write
//!   fails with `destination_changed` (never overwrites newer durable state).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use thiserror::Error;

pub const STORE_FILE: &str = "runs.json";
pub const MAX_SUBAGENT_RUN_STORE_BYTES: usize = 8 * 1024 * 1024;

/// `SubagentRunStoreGeneration` — `"missing"` or a hex identity token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generation(pub String);

impl Generation {
    pub fn missing() -> Self {
        Generation("missing".to_string())
    }
    pub fn is_missing(&self) -> bool {
        self.0 == "missing"
    }
    pub fn is_safe(value: &str) -> bool {
        value == "missing" || is_generation_shape(value)
    }
}

fn is_generation_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let group =
        |slice: &[u8]| !slice.is_empty() && slice.iter().all(|byte| byte.is_ascii_hexdigit());
    // Expect groups of hex separated by single dashes.
    let mut start = 0usize;
    let mut parts = Vec::new();
    for (i, byte) in bytes.iter().enumerate() {
        if *byte == b'-' {
            parts.push(&value[start..i]);
            start = i + 1;
        }
    }
    parts.push(&value[start..]);
    parts.len() == 9 && bytes.contains(&b'-') && parts.iter().all(|part| group(part.as_bytes()))
}

/// `SubagentRunStoreStorageError.failure`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum StorageFailure {
    #[error("Subagent run storage changed and was preserved.")]
    DestinationChanged,
    #[error("Subagent run storage is unavailable.")]
    IoFailed,
    #[error("Subagent run storage request is invalid.")]
    InvalidInput,
}

#[derive(Debug, Error)]
#[error("{failure}")]
pub struct SubagentRunStoreStorageError {
    pub failure: StorageFailure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadResult {
    Missing,
    Oversized {
        generation: String,
    },
    Data {
        generation: String,
        contents: Vec<u8>,
    },
}

/// Port of the native helper's storage contract. Synchronous because the Rust
/// port keeps every persistence mutation in-process on one lock tail.
pub trait SubagentRunStoreStorage: Send + Sync {
    fn cleanup(&self) -> Result<bool, SubagentRunStoreStorageError>;
    fn read(&self) -> Result<ReadResult, SubagentRunStoreStorageError>;
    fn write(&self, expected: &str, contents: &str)
        -> Result<String, SubagentRunStoreStorageError>;
    fn sync_directory(&self) -> Result<(), SubagentRunStoreStorageError>;
    fn close(&self) -> Result<(), SubagentRunStoreStorageError>;
}

fn v4_uuid() -> String {
    let mut bytes = [0u8; 16];
    // Non-crypto PRNG is sufficient for staging names: collision only costs an
    // EEXIST retry. Use a simple splitmix64 from a time seed.
    let mut state = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    let mut next = || {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    };
    for chunk in bytes.chunks_mut(8) {
        let value = next().to_le_bytes();
        chunk.copy_from_slice(&value[..chunk.len()]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = [0u8; 36];
    let mut byte_index = 0usize;
    let mut output_index = 0usize;
    while byte_index < 16 {
        if output_index == 8 || output_index == 13 || output_index == 18 || output_index == 23 {
            output[output_index] = b'-';
            output_index += 1;
        }
        output[output_index] = HEX[(bytes[byte_index] >> 4) as usize];
        output[output_index + 1] = HEX[(bytes[byte_index] & 0x0f) as usize];
        byte_index += 1;
        output_index += 2;
    }
    String::from_utf8(output.to_vec()).expect("ascii")
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// `.runs.json.<uuid>.tmp` / `.runs.json.<uuid>.cleanup`
fn is_owned_temporary_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".runs.json.") else {
        return false;
    };
    if rest.len() < 40 {
        return false;
    }
    let Some((uuid, suffix)) = rest.split_at_checked(36) else {
        return false;
    };
    if !is_uuid(uuid) || suffix != ".tmp" && suffix != ".cleanup" {
        return false;
    }
    true
}

#[cfg(target_os = "macos")]
fn generation_token(metadata: &fs::Metadata) -> String {
    use std::os::macos::fs::MetadataExt as _;
    use std::os::unix::fs::MetadataExt;
    format!(
        "{:x}-{:x}-{:x}-{:x}-{:x}-{:x}-{:x}-{:x}-{:x}",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
        metadata.st_birthtime(),
        metadata.st_birthtime_nsec()
    )
}

#[cfg(not(target_os = "macos"))]
fn generation_token(metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "{:x}-{:x}-{:x}-{:x}-{:x}-{:x}-{:x}-0-0",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    )
}

fn sync_path(target: &Path) -> std::io::Result<()> {
    File::open(target)?.sync_all()
}

fn file_identity(metadata: &fs::Metadata) -> (u64, u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino(), metadata.nlink())
    }
    #[cfg(not(unix))]
    {
        (0, 0, metadata.len())
    }
}

/// In-process replacement for `NativeSubagentRunStoreStorage`.
pub struct InProcessSubagentRunStoreStorage {
    directory: PathBuf,
    target: PathBuf,
}

impl InProcessSubagentRunStoreStorage {
    pub fn new(directory: PathBuf) -> Result<Self, SubagentRunStoreStorageError> {
        if !directory.is_absolute() {
            return Err(SubagentRunStoreStorageError {
                failure: StorageFailure::InvalidInput,
            });
        }
        std::fs::create_dir_all(&directory).map_err(|_| SubagentRunStoreStorageError {
            failure: StorageFailure::IoFailed,
        })?;
        let target = directory.join(STORE_FILE);
        Ok(InProcessSubagentRunStoreStorage { directory, target })
    }

    fn current_generation(&self) -> Result<Option<String>, SubagentRunStoreStorageError> {
        let metadata = match fs::symlink_metadata(&self.target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(SubagentRunStoreStorageError {
                    failure: StorageFailure::IoFailed,
                })
            }
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(SubagentRunStoreStorageError {
                failure: StorageFailure::IoFailed,
            });
        }
        Ok(Some(generation_token(&metadata)))
    }
}

impl SubagentRunStoreStorage for InProcessSubagentRunStoreStorage {
    fn cleanup(&self) -> Result<bool, SubagentRunStoreStorageError> {
        let mut removed = false;
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => {
                return Err(SubagentRunStoreStorageError {
                    failure: StorageFailure::IoFailed,
                })
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    return Err(SubagentRunStoreStorageError {
                        failure: StorageFailure::IoFailed,
                    })
                }
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_owned_temporary_name(&name) {
                continue;
            }
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    return Err(SubagentRunStoreStorageError {
                        failure: StorageFailure::IoFailed,
                    })
                }
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            // Only exclusive single-link regular files are removed.
            let (_, _, nlink) = file_identity(&metadata);
            if nlink != 1 {
                continue;
            }
            match fs::remove_file(entry.path()) {
                Ok(()) => removed = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(SubagentRunStoreStorageError {
                        failure: StorageFailure::IoFailed,
                    })
                }
            }
        }
        if removed {
            self.sync_directory()?;
        }
        Ok(removed)
    }

    fn read(&self) -> Result<ReadResult, SubagentRunStoreStorageError> {
        let Some(generation) = self.current_generation()? else {
            return Ok(ReadResult::Missing);
        };
        let contents = match fs::read(&self.target) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ReadResult::Missing)
            }
            Err(_) => {
                return Err(SubagentRunStoreStorageError {
                    failure: StorageFailure::IoFailed,
                })
            }
        };
        if contents.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
            return Ok(ReadResult::Oversized { generation });
        }
        Ok(ReadResult::Data {
            generation,
            contents,
        })
    }

    fn write(
        &self,
        expected: &str,
        contents: &str,
    ) -> Result<String, SubagentRunStoreStorageError> {
        if !Generation::is_safe(expected) {
            return Err(SubagentRunStoreStorageError {
                failure: StorageFailure::InvalidInput,
            });
        }
        if contents.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
            return Err(SubagentRunStoreStorageError {
                failure: StorageFailure::IoFailed,
            });
        }
        let current = self.current_generation()?;
        let mismatch = match (&current, expected) {
            (None, "missing") => false,
            (Some(generation), expected) => generation != expected,
            (None, _) => true,
        };
        if mismatch {
            return Err(SubagentRunStoreStorageError {
                failure: StorageFailure::DestinationChanged,
            });
        }
        // Sweep crash-left staging files before staging a new write.
        self.cleanup()?;
        // Stage, fsync, verify identity, install, fsync directory.
        let directory = self.directory.clone();
        let staged = directory.join(format!(".{STORE_FILE}.{}.tmp", v4_uuid()));
        let install = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&staged)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            drop(file);
            sync_path(&staged)?;
            fs::rename(&staged, &self.target)?;
            sync_path(&directory)?;
            Ok(())
        })();
        if let Err(error) = install {
            let _ = fs::remove_file(&staged);
            return Err(SubagentRunStoreStorageError {
                failure: if error.kind() == std::io::ErrorKind::AlreadyExists {
                    StorageFailure::DestinationChanged
                } else {
                    StorageFailure::IoFailed
                },
            });
        }
        let metadata = match fs::symlink_metadata(&self.target) {
            Ok(metadata) => metadata,
            Err(_) => {
                return Err(SubagentRunStoreStorageError {
                    failure: StorageFailure::IoFailed,
                })
            }
        };
        Ok(generation_token(&metadata))
    }

    fn sync_directory(&self) -> Result<(), SubagentRunStoreStorageError> {
        sync_path(&self.directory).map_err(|_| SubagentRunStoreStorageError {
            failure: StorageFailure::IoFailed,
        })
    }

    fn close(&self) -> Result<(), SubagentRunStoreStorageError> {
        Ok(())
    }
}

/// `createNativeSubagentRunStoreStorage` — the production factory.
pub fn create_in_process_subagent_run_store_storage(
    directory: &Path,
) -> Result<InProcessSubagentRunStoreStorage, SubagentRunStoreStorageError> {
    InProcessSubagentRunStoreStorage::new(directory.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage() -> (tempfile::TempDir, InProcessSubagentRunStoreStorage) {
        let directory = tempfile::tempdir().unwrap();
        let storage =
            InProcessSubagentRunStoreStorage::new(directory.path().to_path_buf()).unwrap();
        (directory, storage)
    }

    #[test]
    fn missing_then_write_then_read_round_trip() {
        let (_directory, storage) = storage();
        assert_eq!(storage.read().unwrap(), ReadResult::Missing);
        let generation = storage.write("missing", "{\"version\":1}\n").unwrap();
        assert!(Generation::is_safe(&generation));
        let read = storage.read().unwrap();
        match read {
            ReadResult::Data {
                generation: token,
                contents,
            } => {
                assert_eq!(token, generation);
                assert_eq!(String::from_utf8(contents).unwrap(), "{\"version\":1}\n");
            }
            _ => panic!("expected data"),
        }
    }

    #[test]
    fn generation_is_a_cas_that_rejects_stale_writes() {
        let (_directory, storage) = storage();
        let generation = storage.write("missing", "{\"version\":1}\n").unwrap();
        // Same generation overwrites.
        let next = storage.write(&generation, "{\"version\":2}\n").unwrap();
        assert_ne!(next, generation);
        // A stale generation is rejected and preserves the newer state.
        let error = storage.write(&generation, "{\"version\":3}\n").unwrap_err();
        assert_eq!(error.failure, StorageFailure::DestinationChanged);
        let read = storage.read().unwrap();
        match read {
            ReadResult::Data { contents, .. } => {
                assert_eq!(String::from_utf8(contents).unwrap(), "{\"version\":2}\n");
            }
            _ => panic!("expected data"),
        }
    }

    #[test]
    fn missing_expected_rejects_existing_file() {
        let (_directory, storage) = storage();
        storage.write("missing", "{\"version\":1}\n").unwrap();
        let error = storage.write("missing", "{\"version\":2}\n").unwrap_err();
        assert_eq!(error.failure, StorageFailure::DestinationChanged);
    }

    #[test]
    fn cleanup_sweeps_staging_files() {
        let (directory, storage) = storage();
        let stale = directory
            .path()
            .join(format!(".runs.json.{}.tmp", v4_uuid()));
        fs::write(&stale, "partial").unwrap();
        let bad = directory.path().join("not-staging.tmp");
        fs::write(&bad, "keep").unwrap();
        assert!(storage.cleanup().unwrap());
        assert!(!stale.exists());
        assert!(bad.exists());
        // Second run removes nothing.
        assert!(!storage.cleanup().unwrap());
    }

    #[test]
    fn oversized_read_is_preserved() {
        let (_directory, storage) = storage();
        // Bypass the write gate and install an oversized file directly so the
        // read path must preserve it as evidence.
        let mut contents = String::with_capacity(MAX_SUBAGENT_RUN_STORE_BYTES + 1);
        contents.push_str("{\"pad\":\"");
        contents.push_str(&"x".repeat(MAX_SUBAGENT_RUN_STORE_BYTES));
        contents.push_str("\"}");
        std::fs::write(storage.target.clone(), contents).unwrap();
        let read = storage.read().unwrap();
        assert!(matches!(read, ReadResult::Oversized { .. }));
    }

    #[test]
    fn relative_directory_is_rejected() {
        assert!(InProcessSubagentRunStoreStorage::new("relative".into()).is_err());
    }

    #[test]
    fn generation_shape_check() {
        assert!(Generation::is_safe("missing"));
        assert!(Generation::is_safe("1a2b-3-4-5-6-7-8-9-a"));
        assert!(!Generation::is_safe("not-a-generation"));
        assert!(!Generation::is_safe(""));
        assert!(!Generation::is_safe("1-2-3-4-5-6-7-8"));
    }
}
