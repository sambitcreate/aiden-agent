//! Aiden persistence layer: a durable JSON `DataStore`, config-dir resolution,
//! and the file stores built on top of it (portable config, chat history,
//! schedules, encrypted secrets, MCP OAuth sessions).
//!
//! The `DataStore` is a synchronous port of `main/services/data-store.ts` and
//! replicates its crash-durability semantics, not just its happy path:
//!
//! - **Atomic writes**: stage a sibling temp file (`.name.<uid>.tmp`) → `fsync`
//!   the file → rename over the destination → `fsync` the parent directory. An
//!   in-place write could leave the file truncated on crash / full disk, which
//!   would destroy a hand-edited config.
//! - **Protected publication** (used for hand-edited portable files): instead of
//!   rename, the old inode is *held* under `.name.<hash>.<uid>.held`, the staged
//!   file is published with a no-overwrite hard link, then the held inode is
//!   renamed to `.name.<hash>.<uid>.previous` for the process lifetime. Content
//!   hashes (sha256) encoded in the names let a later startup reconcile any
//!   inode an external editor wrote through.
//! - **Crash recovery on load**: every `.held` / `.previous` sibling is
//!   reconciled — a held file with a missing destination is restored (hard link
//!   for regular files, symlink, or recursive dir copy), unchanged predecessors
//!   are swept, edited ones are preserved as `.conflict-<uid>`.
//! - **Serialized mutations**: all writes queue behind a single lock tail so a
//!   reloaded hand-edit can never be clobbered by an in-flight write.
//!
//! Additional modules port the higher-level stores: `config_dir`
//! (aiden-config-dir.ts), `portable_config` + `config_store`
//! (portable-config-core.ts + config-store-core.ts), `chat_store`
//! (chat-store-core.ts), `schedule_store` (schedule-store.ts), `secret_map` +
//! `pi_credential_store` (secret-map-core.ts + pi-credential-store-core.ts),
//! `mcp_oauth` (mcp-oauth-store-core.ts), `portable_watch`
//! (portable-config-watch-core.ts), `usage_store` (usage-store-core.ts +
//! usage-store.ts), `profile` (profile.ts + profile-core.ts +
//! profile-share-core.ts + profile-share-files.ts), and `external_editors`
//! (external-editors.ts).
//!
//! The TS modules being ported inject closures everywhere (`SecretsPort`,
//! durability seams, test hooks); `Box<dyn Fn>` field types are the norm, so
//! the `type_complexity` lint is disabled crate-wide.
#![allow(clippy::type_complexity)]

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::fs::{symlink, OpenOptionsExt};

pub mod attachments;
pub mod chat_store;
pub mod config_dir;
pub mod config_store;
pub mod dev_log;
pub mod external_editors;
pub mod mcp_oauth;
pub mod pi_credential_store;
pub mod portable_config;
pub mod portable_watch;
pub mod profile;
pub mod schedule_store;
pub mod secret_map;
pub mod skill_discovery;
pub mod usage_store;

pub use attachments::{
    read_attachments, read_attachments_with_cancellation, AttachmentReadCancellation,
    AttachmentReadError, MAX_TEXT_READ_BYTES,
};
pub use config_dir::{aiden_config_dir, ConfigDirError, AIDEN_CONFIG_DIR_ENV, AIDEN_DIR_NAME};

// ===========================================================================
// base64 (dependency-free helpers used by the encrypted secret stores)
// ===========================================================================

pub(crate) mod base64 {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let triple = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
            out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(triple >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[triple as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    pub fn decode(input: &str) -> Option<Vec<u8>> {
        if !input.is_ascii() || !input.len().is_multiple_of(4) {
            return None;
        }
        let mut out = Vec::with_capacity(input.len() / 4 * 3);
        let bytes = input.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            let mut acc = 0u32;
            let mut valid = 0u32;
            for offset in 0..4 {
                let byte = *bytes.get(index + offset)?;
                // Padding still shifts the accumulator so the final byte
                // lands left-aligned in the top bits of `acc`.
                let value = if byte == b'=' {
                    0
                } else {
                    let position = ALPHABET.iter().position(|candidate| *candidate == byte)?;
                    position as u32
                };
                acc = (acc << 6) | value;
                if byte != b'=' {
                    valid += 6;
                }
            }
            index += 4;
            if valid >= 8 {
                out.push((acc >> 16) as u8);
            }
            if valid >= 16 {
                out.push((acc >> 8) as u8);
            }
            if valid >= 24 {
                out.push(acc as u8);
            }
        }
        Some(out)
    }
}

// ===========================================================================
// Errors
// ===========================================================================

#[derive(Debug, thiserror::Error)]
pub enum DataStoreError {
    #[error("cannot overwrite a JSON file that changed outside the app")]
    ExternalChange,
    #[error("cannot overwrite a JSON file that does not parse")]
    CorruptWrite,
    #[error("cannot overwrite a JSON file whose schema is not safe for this app version")]
    UnsafeWrite,
    #[error("cannot write before loading current file contents")]
    NotLoaded,
    #[error("the renderer document is no longer active")]
    DocumentInactive,
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

// ===========================================================================
// Options
// ===========================================================================

/// Mirrors `DataStoreOptions<T>` in data-store.ts.
#[allow(clippy::type_complexity)]
pub struct DataStoreOptions<T> {
    /// Copy an unparseable file aside before a write replaces it. Set for files
    /// the user maintains by hand; left off for regenerable caches.
    pub preserve_corrupt_file: bool,
    /// Normalize valid JSON whose runtime shape does not match the typed store.
    pub normalize: Option<Box<dyn Fn(serde_json::Value) -> T + Send + Sync>>,
    /// Report whether valid JSON is safe to persist after normalization.
    pub is_safe: Option<Box<dyn Fn(&serde_json::Value) -> bool + Send + Sync>>,
    /// Re-read the backing file at the start of every mutation so a cached
    /// healthy value cannot overwrite a newer hand edit.
    pub reload_before_write: bool,
    /// Refuse to replace unparseable JSON even when a rescue copy could be made.
    pub reject_corrupt_write: bool,
    /// Refuse to replace valid JSON that the tolerant reader could not safely
    /// normalize.
    pub reject_unsafe_write: bool,
    /// Abort a save based on a stale snapshot when the backing file changed
    /// (hard-link protected publication).
    pub reject_external_changes: bool,
    /// Test seam for racing a protected publication after the destination is held.
    pub before_protected_publish: Option<Box<dyn Fn() + Send + Sync>>,
    /// Test seam for replacing the destination immediately before it is held.
    pub before_protected_hold: Option<Box<dyn Fn() + Send + Sync>>,
    /// Test seam for an old descriptor writing after the final held-byte check.
    pub after_protected_publish: Option<Box<dyn Fn() + Send + Sync>>,
    /// Test seam for holding a disk read before it becomes the active snapshot.
    pub before_load_commit: Option<Box<dyn Fn() + Send + Sync>>,
    /// Synchronous authority fence immediately before an externally reloaded
    /// value replaces the in-memory cache. Never called for app writes.
    pub before_external_cache_commit: Option<Box<dyn Fn(Option<&T>, &T) + Send + Sync>>,
    /// Synchronous authority fence immediately before an app write is published.
    pub before_write_publish: Option<Box<dyn Fn(Option<&T>, &T) + Send + Sync>>,
}

impl<T> Default for DataStoreOptions<T> {
    fn default() -> Self {
        Self {
            preserve_corrupt_file: false,
            normalize: None,
            is_safe: None,
            reload_before_write: false,
            reject_corrupt_write: false,
            reject_unsafe_write: false,
            reject_external_changes: false,
            before_protected_publish: None,
            before_protected_hold: None,
            after_protected_publish: None,
            before_load_commit: None,
            before_external_cache_commit: None,
            before_write_publish: None,
        }
    }
}

impl<T> DataStoreOptions<T> {
    pub fn new() -> Self {
        Self::default()
    }
}

// ===========================================================================
// DataStore
// ===========================================================================

struct Inner<T> {
    cache: Option<T>,
    file_path: Option<PathBuf>,
    /// Exact bytes observed by the last load. `None` = file absent at load.
    disk_snapshot: Option<Option<Vec<u8>>>,
    corrupt: bool,
    unsafe_file: bool,
    /// Predecessor names created by this process stay live until next startup.
    live_held: HashSet<PathBuf>,
    /// The cache value that a `reload()` replaced; fences fire against it.
    external_reload_previous: Option<T>,
}

/// A JSON file store rooted in a caller-chosen directory.
pub struct DataStore<T> {
    inner: Mutex<Inner<T>>,
    filename: String,
    root: Option<PathBuf>,
    default: T,
    options: DataStoreOptions<T>,
}

impl<T> DataStore<T>
where
    T: Clone + Serialize + DeserializeOwned + PartialEq + 'static,
{
    pub fn new(
        filename: impl Into<String>,
        default: T,
        root: Option<PathBuf>,
        options: DataStoreOptions<T>,
    ) -> Self {
        Self {
            inner: Mutex::new(Inner {
                cache: None,
                file_path: None,
                disk_snapshot: None,
                corrupt: false,
                unsafe_file: false,
                live_held: HashSet::new(),
                external_reload_previous: None,
            }),
            filename: filename.into(),
            root,
            default,
            options,
        }
    }

    /// Absolute path of the backing file, creating the root directory first.
    pub fn path(&self) -> Result<PathBuf, DataStoreError> {
        let mut inner = self.inner.lock();
        self.path_locked(&mut inner)
    }

    /// Path resolution for callers that already hold the inner lock
    /// (parking_lot::Mutex is not reentrant).
    fn path_locked(&self, inner: &mut Inner<T>) -> Result<PathBuf, DataStoreError> {
        if let Some(path) = &inner.file_path {
            return Ok(path.clone());
        }
        let root = self.root.clone().unwrap_or_else(machine_local_data_dir);
        fs::create_dir_all(&root)?;
        let path = root.join(&self.filename);
        inner.file_path = Some(path.clone());
        Ok(path)
    }

    /// Whether the current cached value came from an unparseable on-disk file.
    pub fn loaded_from_corrupt_file(&self) -> Result<bool, DataStoreError> {
        self.load()?;
        Ok(self.inner.lock().corrupt)
    }

    /// Whether valid on-disk JSON was unsafe and only normalized for in-memory
    /// reads.
    pub fn loaded_from_unsafe_file(&self) -> Result<bool, DataStoreError> {
        self.load()?;
        Ok(self.inner.lock().unsafe_file)
    }

    /// Exact bytes observed by the successful cached load, or `None` when the
    /// file was absent. Mirrors `loadedDiskContents()` in data-store.ts.
    pub fn loaded_disk_contents(&self) -> Result<Option<Vec<u8>>, DataStoreError> {
        self.load()?;
        let inner = self.inner.lock();
        Ok(inner.disk_snapshot.clone().flatten())
    }

    /// The cached value, loading from disk on first call (lazy single-load).
    pub fn load(&self) -> Result<T, DataStoreError> {
        let mut inner = self.inner.lock();
        if let Some(cache) = &inner.cache {
            return Ok(cache.clone());
        }
        let file_path = self.path_locked(&mut inner)?;
        let value = self.load_from_disk_locked(&mut inner, &file_path)?;
        Ok(value)
    }

    /// Save a full snapshot. Honors the corrupt/unsafe/external-change guards.
    pub fn save(&self, data: &T) -> Result<(), DataStoreError> {
        self.save_with_current(data, &|| true)
    }

    /// Like [`save`](Self::save), but refuses the write once the caller's
    /// renderer-ownership fence reports the document inactive.
    pub fn save_with_current(
        &self,
        data: &T,
        is_current: &dyn Fn() -> bool,
    ) -> Result<(), DataStoreError> {
        if !is_current() {
            return Err(DataStoreError::DocumentInactive);
        }
        let mut inner = self.inner.lock();
        let had_cache = inner.cache.is_some();
        let changed = if self.options.reload_before_write {
            self.reload_now_locked(&mut inner)?
        } else {
            false
        };
        if self.options.reject_corrupt_write && inner.corrupt {
            return Err(DataStoreError::CorruptWrite);
        }
        if self.options.reject_unsafe_write && inner.unsafe_file {
            return Err(DataStoreError::UnsafeWrite);
        }
        if self.options.reject_external_changes
            && ((had_cache && changed)
                || (!had_cache
                    && inner
                        .disk_snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.is_some())
                        .unwrap_or(true)))
        {
            return Err(DataStoreError::ExternalChange);
        }
        self.write_now_locked(&mut inner, data, is_current)
    }

    /// Serialized read-modify-write transaction.
    pub fn update<R>(&self, mutation: impl FnOnce(&mut T) -> R) -> Result<R, DataStoreError> {
        self.update_with_current(mutation, &|| true)
    }

    /// Like [`update`](Self::update) with a renderer-ownership fence checked at
    /// the start of the transaction and again right before publication.
    pub fn update_with_current<R>(
        &self,
        mutation: impl FnOnce(&mut T) -> R,
        is_current: &dyn Fn() -> bool,
    ) -> Result<R, DataStoreError> {
        if !is_current() {
            return Err(DataStoreError::DocumentInactive);
        }
        let mut inner = self.inner.lock();
        if self.options.reload_before_write {
            self.reload_now_locked(&mut inner)?;
        }
        if self.options.reject_corrupt_write && inner.corrupt {
            return Err(DataStoreError::CorruptWrite);
        }
        if self.options.reject_unsafe_write && inner.unsafe_file {
            return Err(DataStoreError::UnsafeWrite);
        }
        let mut draft = self.load_locked(&mut inner)?;
        let result = mutation(&mut draft);
        self.write_now_locked(&mut inner, &draft, is_current)?;
        Ok(result)
    }

    /// Re-read the file from disk, returning true when the parsed contents
    /// actually changed (byte comparison, not stat).
    pub fn reload(&self) -> Result<bool, DataStoreError> {
        self.reload_now_locked(&mut self.inner.lock())
    }

    // -- internals -----------------------------------------------------------

    fn load_locked(&self, inner: &mut Inner<T>) -> Result<T, DataStoreError> {
        if let Some(cache) = &inner.cache {
            return Ok(cache.clone());
        }
        let file_path = self.path_locked(inner)?;
        self.load_from_disk_locked(inner, &file_path)
    }

    /// The load protocol: recover held/previous siblings, read the regular file
    /// (ENOENT → defaults, unparseable → corrupt + defaults).
    fn load_from_disk_locked(
        &self,
        inner: &mut Inner<T>,
        file_path: &Path,
    ) -> Result<T, DataStoreError> {
        let mut corrupt = false;
        let mut bytes: Option<Vec<u8>> = None;

        self.recover_held_files(inner, file_path)?;

        match read_regular_file(file_path) {
            Ok(read) => {
                let text = String::from_utf8_lossy(&read);
                bytes = Some(read.clone());
                match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(parsed) => {
                        if let Some(hook) = &self.options.before_load_commit {
                            hook();
                        }
                        let unsafe_file = self
                            .options
                            .is_safe
                            .as_ref()
                            .map(|is_safe| !is_safe(&parsed))
                            .unwrap_or(false);
                        let next = match &self.options.normalize {
                            Some(normalize) => normalize(parsed),
                            None => serde_json::from_value(parsed)?,
                        };
                        self.fence_external_commit_locked(inner, &next);
                        inner.disk_snapshot = Some(Some(read));
                        inner.corrupt = false;
                        inner.unsafe_file = unsafe_file;
                        inner.cache = Some(next.clone());
                        return Ok(next);
                    }
                    Err(_) => {
                        // Valid UTF-8 but unparseable JSON: the user's data.
                        corrupt = true;
                    }
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                // Distinguish "ordinary missing file" from a dangling symlink:
                // a dangling symlink is an existing user-owned object and must
                // stay write-protected.
                match fs::symlink_metadata(file_path) {
                    Ok(_) => corrupt = true,
                    Err(symlink_err) if symlink_err.kind() == io::ErrorKind::NotFound => {}
                    Err(_) => corrupt = true,
                }
            }
            Err(_) => corrupt = true,
        }

        // `Some(None)` means "loaded and absent"; `None` still means "never
        // loaded" (protected writes refuse on that state).
        inner.disk_snapshot = if corrupt { bytes.map(Some) } else { Some(None) };
        inner.corrupt = corrupt;
        inner.unsafe_file = false;
        let next = self.default.clone();
        self.fence_external_commit_locked(inner, &next);
        inner.cache = Some(next.clone());
        Ok(next)
    }

    /// Fires `before_external_cache_commit` when this load was initiated by a
    /// `reload()` (never for ordinary app writes).
    fn fence_external_commit_locked(&self, inner: &Inner<T>, next: &T) {
        if inner.external_reload_previous.is_none() {
            return;
        }
        if let Some(fence) = &self.options.before_external_cache_commit {
            fence(inner.external_reload_previous.as_ref(), next);
        }
    }

    /// Re-read the backing file, invalidating the cached load. Runs inside the
    /// mutation lock so it can never land between a load() and its write.
    fn reload_now_locked(&self, inner: &mut Inner<T>) -> Result<bool, DataStoreError> {
        let previous = inner.cache.clone();
        let before = previous.as_ref().map(serialize_json);
        inner.cache = None;
        inner.file_path = None;
        inner.disk_snapshot = None;
        inner.external_reload_previous = previous;
        let file_path = self.path_locked(inner)?;
        let result = self.load_from_disk_locked(inner, &file_path);
        inner.external_reload_previous = None;
        let next = result?;
        Ok(before != Some(serialize_json(&next)))
    }

    /// Write a snapshot: stage → fsync → publish (rename or protected) → dir
    /// fsync. Mirrors `writeNow` in data-store.ts.
    fn write_now_locked(
        &self,
        inner: &mut Inner<T>,
        data: &T,
        is_current: &dyn Fn() -> bool,
    ) -> Result<(), DataStoreError> {
        if !is_current() {
            return Err(DataStoreError::DocumentInactive);
        }
        let destination = self.path_locked(inner)?;

        if self.options.preserve_corrupt_file {
            // `corrupt` is only assessed by load(); a bare save() need not have
            // loaded, so assess before replacing unreadable user data.
            if inner.cache.is_none() {
                self.load_from_disk_locked(inner, &destination)?;
            }
            if inner.corrupt {
                preserve_corrupt_file(&destination);
            }
        }

        let directory = destination
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent dir"))?
            .to_path_buf();
        let staged = directory.join(format!(".{}.{}.tmp", file_name(&destination), unique_id()));

        let serialized = serialize_json(data);
        let bytes = serialized.as_bytes();

        let result = (|| -> Result<(), DataStoreError> {
            write_staged(&staged, bytes)?;
            if let Some(fence) = &self.options.before_write_publish {
                fence(inner.cache.as_ref(), data);
            }
            if self.options.reject_external_changes {
                self.publish_protected_locked(inner, &staged, &destination, is_current)?;
            } else {
                if !is_current() {
                    return Err(DataStoreError::DocumentInactive);
                }
                fs::rename(&staged, &destination)?;
                sync_directory(&directory)?;
            }
            Ok(())
        })();

        // Best-effort sweep of the staging file on any failure path.
        let _ = fs::remove_file(&staged);

        result?;

        inner.cache = Some(data.clone());
        inner.disk_snapshot = Some(Some(serialized.into_bytes()));
        inner.corrupt = false;
        inner.unsafe_file = false;
        Ok(())
    }

    /// The `publishProtected` dance: hold the old inode, publish the staged
    /// file with a no-overwrite hard link, then keep the old inode as a
    /// `.previous` predecessor until next startup.
    fn publish_protected_locked(
        &self,
        inner: &mut Inner<T>,
        staged: &Path,
        destination: &Path,
        is_current: &dyn Fn() -> bool,
    ) -> Result<(), DataStoreError> {
        let directory = destination
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent dir"))?;
        let snapshot = match inner.disk_snapshot {
            Some(ref snap) => snap.clone(),
            None => return Err(DataStoreError::NotLoaded),
        };
        let expected_hash = snapshot
            .as_ref()
            .map(|bytes| sha256_hex(bytes))
            .unwrap_or_else(|| "absent".to_string());
        let held = directory.join(format!(
            ".{}.{}.{}.held",
            file_name(destination),
            expected_hash,
            unique_id()
        ));
        inner.live_held.insert(held.clone());

        let mut destination_held = false;
        let mut held_matches = false;

        if let Some(ref snapshot_bytes) = snapshot {
            // Hold the old inode; a missing destination here is an external
            // deletion and a conflict.
            if let Some(hook) = &self.options.before_protected_hold {
                hook();
            }
            match fs::rename(destination, &held) {
                Ok(()) => destination_held = true,
                Err(err) => {
                    inner.live_held.remove(&held);
                    if err.kind() == io::ErrorKind::NotFound {
                        return Err(DataStoreError::ExternalChange);
                    }
                    return Err(err.into());
                }
            }
            // Verify the held bytes match what we loaded.
            held_matches = match read_regular_file(&held) {
                Ok(read) => read == *snapshot_bytes,
                Err(_) => false,
            };
            if !held_matches {
                let _ = self.restore_held_file(&held, destination, true);
                inner.live_held.remove(&held);
                return Err(DataStoreError::ExternalChange);
            }
        }

        let mut published = false;
        let result = (|| -> Result<(), DataStoreError> {
            // The destination is absent only inside this protected publication.
            // A concurrent editor that creates it wins: hard-link publication is
            // the no-overwrite primitive that rename lacks.
            if let Some(hook) = &self.options.before_protected_publish {
                hook();
            }
            if !is_current() {
                return Err(DataStoreError::DocumentInactive);
            }
            if destination_held {
                // A writer that already held the old inode can still modify it
                // after the held-byte comparison. Re-verify before publishing.
                match read_regular_file(&held) {
                    Ok(read) if read == *snapshot.as_ref().unwrap() => {}
                    _ => {
                        held_matches = false;
                        let _ = self.restore_held_file(&held, destination, true);
                        inner.live_held.remove(&held);
                        return Err(DataStoreError::ExternalChange);
                    }
                }
            }
            if !is_current() {
                return Err(DataStoreError::DocumentInactive);
            }
            // Publish with a hard link: if an external editor created the
            // destination in the gap, link fails with EEXIST and nobody's data is
            // overwritten.
            match fs::hard_link(staged, destination) {
                Ok(()) => published = true,
                Err(err) => {
                    if err.kind() == io::ErrorKind::AlreadyExists {
                        return Err(DataStoreError::ExternalChange);
                    }
                    return Err(err.into());
                }
            }
            sync_directory(directory)?;
            Ok(())
        })();

        if result.is_ok() {
            // Publication is already committed at this point, so preserve a late
            // old-descriptor edit as a conflict instead of reporting a rejected
            // save while leaving the app's new document canonical.
            if let Some(hook) = &self.options.after_protected_publish {
                hook();
            }
        }

        if let Err(err) = result {
            if destination_held && !published {
                let _ = self.restore_held_file(&held, destination, true);
                let _ = sync_directory(directory);
            }
            return Err(err);
        }

        // Keep the old inode as a predecessor for this process lifetime so an
        // editor that opened it before publication can be reconciled next
        // startup.
        if destination_held && held_matches {
            let previous = held.with_extension("previous");
            let _ = fs::rename(&held, &previous);
            inner.live_held.remove(&held);
            inner.live_held.insert(previous);
            let _ = sync_directory(directory);
        }
        Ok(())
    }

    /// `recoverHeldFiles`: reconcile every `.basename.*.held` / `.previous`
    /// sibling before the first read of the destination.
    fn recover_held_files(
        &self,
        inner: &mut Inner<T>,
        destination: &Path,
    ) -> Result<(), DataStoreError> {
        let directory = destination
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent dir"))?;
        let prefix = format!(".{}.", file_name(destination));

        let names = match fs::read_dir(directory) {
            Ok(entries) => entries
                .filter_map(|entry| {
                    entry
                        .ok()
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                })
                .filter(|name| {
                    name.starts_with(&prefix)
                        && (name.ends_with(".held") || name.ends_with(".previous"))
                })
                .collect::<Vec<_>>(),
            Err(_) => return Ok(()),
        };

        for name in sorted(names) {
            let held = directory.join(&name);
            if inner.live_held.contains(&held) {
                continue;
            }
            let is_predecessor = name.ends_with(".previous");
            let info = match fs::symlink_metadata(&held) {
                Ok(info) => info,
                Err(_) => continue,
            };

            if !is_predecessor {
                let destination_exists = match fs::symlink_metadata(destination) {
                    Ok(_) => true,
                    Err(err) if err.kind() == io::ErrorKind::NotFound => false,
                    Err(_) => return Err(io::Error::other("destination stat failed").into()),
                };
                if !destination_exists {
                    // Any failure propagates into load(), keeping protected
                    // stores read-only instead of seeding defaults over the
                    // parked source.
                    self.restore_held_file(&held, destination, true)?;
                    sync_directory(directory)?;
                    continue;
                }
                if !info.is_file() || info.file_type().is_symlink() {
                    self.restore_held_file(&held, destination, true)?;
                    sync_directory(directory)?;
                    continue;
                }
            }

            if !info.is_file() || info.file_type().is_symlink() {
                continue;
            }

            let suffix = if is_predecessor { ".previous" } else { ".held" };
            let encoded_hash = name[prefix.len()..name.len() - suffix.len()]
                .split('.')
                .next()
                .unwrap_or("");
            match read_regular_file(&held) {
                Ok(contents) if is_hex64(encoded_hash) && sha256_hex(&contents) == encoded_hash => {
                    // Unchanged predecessor: sweep.
                    let _ = fs::remove_file(&held);
                }
                Ok(_) => {
                    // Edited externally through an old descriptor: preserve.
                    let conflict = directory.join(format!(
                        "{}.conflict-{}",
                        destination.display(),
                        unique_id()
                    ));
                    let _ = fs::rename(&held, conflict);
                }
                Err(_) => continue, // leave unreadable candidates for manual review
            }
            let _ = sync_directory(directory);
        }
        Ok(())
    }

    /// Restore a held file to the destination (hard link / symlink / recursive
    /// dir copy), then remove the held path. On conflict, park the held file.
    fn restore_held_file(
        &self,
        held: &Path,
        destination: &Path,
        preserve_conflict: bool,
    ) -> Result<(), DataStoreError> {
        let result = (|| -> Result<(), DataStoreError> {
            let info = fs::symlink_metadata(held)?;
            if info.file_type().is_symlink() {
                symlink(fs::read_link(held)?, destination)?;
            } else if info.is_dir() {
                copy_dir_all(held, destination)?;
            } else {
                fs::hard_link(held, destination)?;
            }
            if info.is_dir() {
                fs::remove_dir_all(held)?;
            } else {
                fs::remove_file(held)?;
            }
            Ok(())
        })();
        if result.is_ok() {
            return Ok(());
        }
        // Destination appeared under us (or restore failed): park or drop.
        match fs::symlink_metadata(destination) {
            Ok(_) => {
                if preserve_conflict {
                    let conflict = destination.with_file_name(format!(
                        "{}.conflict-{}",
                        file_name(destination),
                        unique_id()
                    ));
                    let _ = fs::rename(held, conflict);
                } else {
                    let _ = fs::remove_file(held);
                }
            }
            Err(_) => return result,
        }
        Ok(())
    }
}

// ===========================================================================
// Helpers
// ===========================================================================

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn serialize_json<T: Serialize>(value: &T) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

/// Write the staged file (0600), fsync it, and return.
fn write_staged(staged: &Path, bytes: &[u8]) -> Result<(), DataStoreError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(staged)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// `syncDirectory`: fsync an opened directory handle so the rename is durable.
pub fn sync_directory(directory: &Path) -> Result<(), DataStoreError> {
    let handle = File::open(directory)?;
    handle.sync_all()?;
    Ok(())
}

/// Best effort: park an unparseable file beside itself before replacing it.
fn preserve_corrupt_file(destination: &Path) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| unique_id());
    let result = read_regular_file(destination).and_then(|contents| {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(format!("{}.invalid-{}", destination.display(), stamp))
            .and_then(|mut file| {
                file.write_all(&contents)?;
                file.sync_all()
            })
    });
    if let Err(err) = result {
        tracing::warn!(path = %destination.display(), %err, "could not preserve corrupt file");
    }
}

/// Read a regular file (no specials) as bytes.
fn read_regular_file(path: &Path) -> io::Result<Vec<u8>> {
    fs::read(path)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

/// Current wall-clock time in milliseconds since the Unix epoch (`Date.now()`).
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// The reserved workspace id keeping assistant threads out of the main sidebar
/// (renderer/shared/assistant.ts `ASSISTANT_WORKSPACE_ID`).
pub fn aiden_core_assistant_workspace_id() -> &'static str {
    aiden_core::ASSISTANT_WORKSPACE_ID
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn copy_dir_all(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if file_type.is_symlink() {
            #[cfg(unix)]
            symlink(fs::read_link(entry.path())?, &target)?;
            #[cfg(not(unix))]
            fs::copy(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values
}

static UID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A process-local unique suffix: pid + monotonic counter. Sufficient for
/// staging/holding names (the TS side used a v4 uuid).
pub fn unique_id() -> String {
    let counter = UID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}-{nanos:x}", process::id(), counter)
}

// ===========================================================================
// Config directories (port of main/services/aiden-config-dir.ts + platform.ts)
// ===========================================================================
//
// `aiden_config_dir()` (the portable root) lives in `config_dir`; see its
// module docs. The machine-local root and the chats subdirectory stay here.

/// Whether dev mode is active (`AIDEN_DEV=1`). In dev mode the machine-local
/// data directory and app identity use an `aiden-rs-dev` suffix so local
/// testing never clobbers production state.
pub fn is_dev_mode() -> bool {
    matches!(
        std::env::var("AIDEN_DEV").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

/// The product name used for app identity and data-directory resolution.
/// `Aiden-RS-DEV` in dev mode, `aiden-agent` otherwise.
pub fn product_name() -> &'static str {
    if is_dev_mode() {
        "aiden-rs-dev"
    } else {
        "aiden-agent"
    }
}

/// The machine-local root: Electron's `app.getPath("userData")`, which on
/// macOS is `~/Library/Application Support/aiden-agent` (product name from
/// package.json). Machine-bound state, secrets, and caches live here.
/// In dev mode (`AIDEN_DEV=1`) this resolves to `aiden-rs-dev` so dev testing
/// is fully isolated from production state.
pub fn machine_local_data_dir() -> PathBuf {
    let name = product_name();
    if let Some(dirs) = directories::ProjectDirs::from("", "", name) {
        dirs.data_dir().to_path_buf()
    } else {
        home_dir().join(format!("Library/Application Support/{name}"))
    }
}

/// The user's home directory (`$HOME` on Unix).
pub fn home_dir() -> PathBuf {
    config_dir::home_dir()
}

/// The `chats/` subdirectory of the machine-local root (created if missing).
pub fn chats_dir() -> Result<PathBuf, DataStoreError> {
    let dir = machine_local_data_dir().join("chats");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

// ===========================================================================
// Keychain-backed secrets (keyring 4, apple-native)
// ===========================================================================

/// A minimal keychain secret store mapping service/account pairs to passwords.
/// The Electron app encrypted these via safeStorage (the macOS Keychain); the
/// `keyring` crate with `apple-native` is the direct replacement.
#[derive(Debug, Clone)]
pub struct KeychainSecretStore {
    service: String,
}

impl KeychainSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    pub fn set(&self, account: &str, secret: &str) -> Result<(), DataStoreError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| DataStoreError::Io(io::Error::other(format!("keyring: {err}"))))?;
        entry
            .set_password(secret)
            .map_err(|err| DataStoreError::Io(io::Error::other(format!("keyring: {err}"))))
    }

    pub fn get(&self, account: &str) -> Result<Option<String>, DataStoreError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| DataStoreError::Io(io::Error::other(format!("keyring: {err}"))))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(DataStoreError::Io(io::Error::other(format!(
                "keyring: {err}"
            )))),
        }
    }

    pub fn delete(&self, account: &str) -> Result<(), DataStoreError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| DataStoreError::Io(io::Error::other(format!("keyring: {err}"))))?;
        entry
            .delete_credential()
            .map_err(|err| DataStoreError::Io(io::Error::other(format!("keyring: {err}"))))
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in<T>(dir: &Path, filename: &str, default: T) -> DataStore<T>
    where
        T: Clone + Serialize + DeserializeOwned + PartialEq + 'static,
    {
        DataStore::new(
            filename,
            default,
            Some(dir.to_path_buf()),
            DataStoreOptions::new(),
        )
    }

    #[test]
    fn load_missing_file_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path(), "config.json", serde_json::json!({"a": 1}));
        assert_eq!(store.load().unwrap(), serde_json::json!({"a": 1}));
        assert!(!store.loaded_from_corrupt_file().unwrap());
        assert!(!dir.path().join("config.json").exists());
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path(), "config.json", serde_json::Value::Null);
        let value = serde_json::json!({"providers": [{"id": "anthropic"}]});
        store.save(&value).unwrap();
        let path = dir.path().join("config.json");
        assert!(path.exists());
        // Pretty-printed with a trailing newline, like JSON.stringify(data, null, 2) + "\n".
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.starts_with("{\n  \"providers\": ["));
        assert!(raw.ends_with('\n'));
        // No staging litter.
        assert_eq!(read_dir_count(dir.path()), 1);
        assert_eq!(store.load().unwrap(), value);
    }

    #[test]
    fn corrupt_file_is_read_as_default_and_writes_preserve_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{ not json").unwrap();
        let store = store_in(dir.path(), "config.json", serde_json::Value::Null);
        assert_eq!(store.load().unwrap(), serde_json::Value::Null);
        assert!(store.loaded_from_corrupt_file().unwrap());
        assert!(!store.loaded_from_unsafe_file().unwrap());

        // Without preserveCorruptFile a write replaces the corrupt file.
        store.save(&serde_json::json!({"ok": true})).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\n  \"ok\": true\n}\n");
    }

    #[test]
    fn reject_corrupt_write_guards_hand_edited_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{ nope").unwrap();
        let mut options = DataStoreOptions::new();
        options.reject_corrupt_write = true;
        let store = DataStore::new(
            "config.json",
            serde_json::Value::Null,
            Some(dir.path().to_path_buf()),
            options,
        );
        // The guard only fires after the store has assessed the file (a bare
        // save() before any load cannot know the file is corrupt — matching
        // the TS `corrupt` flag lifecycle).
        assert_eq!(store.load().unwrap(), serde_json::Value::Null);
        assert!(store.loaded_from_corrupt_file().unwrap());
        let err = store.save(&serde_json::json!({"x": 1})).unwrap_err();
        assert!(matches!(err, DataStoreError::CorruptWrite));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ nope");
    }

    #[test]
    fn preserve_corrupt_file_parks_the_bad_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{ nope").unwrap();
        let mut options = DataStoreOptions::new();
        options.preserve_corrupt_file = true;
        let store = DataStore::new(
            "config.json",
            serde_json::Value::Null,
            Some(dir.path().to_path_buf()),
            options,
        );
        store.save(&serde_json::json!({"ok": true})).unwrap();
        // The corrupt original is parked as `.invalid-<stamp>`.
        let parks: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".invalid-"))
            .collect();
        assert_eq!(
            parks.len(),
            1,
            "expected one parked corrupt file, got {parks:?}"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(&parks[0])).unwrap(),
            "{ nope"
        );
    }

    #[test]
    fn update_runs_atomic_read_modify_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path(), "count.json", serde_json::json!({"n": 0}));
        for _ in 0..10 {
            store
                .update(|draft| {
                    draft["n"] = serde_json::json!(draft["n"].as_u64().unwrap() + 1);
                })
                .unwrap();
        }
        assert_eq!(store.load().unwrap()["n"], 10);
    }

    #[test]
    fn reload_picks_up_external_edits_and_reports_change() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path(), "config.json", serde_json::Value::Null);
        store
            .save(&serde_json::json!({"provider": "anthropic"}))
            .unwrap();
        fs::write(
            dir.path().join("config.json"),
            "{\n  \"provider\": \"google\"\n}\n",
        )
        .unwrap();
        assert!(store.reload().unwrap());
        assert_eq!(store.load().unwrap()["provider"], "google");
        // Unchanged reload reports false.
        assert!(!store.reload().unwrap());
    }

    #[test]
    fn reload_before_write_preserves_hand_edits_through_update() {
        let dir = tempfile::tempdir().unwrap();
        let mut options = DataStoreOptions::new();
        options.reload_before_write = true;
        let store = DataStore::new(
            "config.json",
            serde_json::Value::Null,
            Some(dir.path().to_path_buf()),
            options,
        );
        store.save(&serde_json::json!({"seed": true})).unwrap();
        // Hand edit after the cached load.
        fs::write(
            dir.path().join("config.json"),
            "{\n  \"handEdited\": true\n}\n",
        )
        .unwrap();
        // update() re-reads the file first, so the hand edit survives into the
        // mutated draft.
        store
            .update(|draft| {
                draft["seed"] = serde_json::json!(false);
            })
            .unwrap();
        let value = store.load().unwrap();
        assert_eq!(value["handEdited"], true);
        assert_eq!(value["seed"], false);
    }

    #[test]
    fn plain_save_without_load_rejects_when_protected() {
        // With rejectExternalChanges, a bare save() before any load is refused
        // (the store has no snapshot to protect) — mirroring the TS guard
        // `!hadCache && this.diskSnapshot !== null`.
        let dir = tempfile::tempdir().unwrap();
        let mut options = DataStoreOptions::new();
        options.reject_external_changes = true;
        let store = DataStore::new(
            "config.json",
            serde_json::Value::Null,
            Some(dir.path().to_path_buf()),
            options,
        );
        let err = store.save(&serde_json::json!({"v": 1})).unwrap_err();
        assert!(matches!(err, DataStoreError::ExternalChange));
        assert!(!dir.path().join("config.json").exists());
    }

    #[test]
    fn reject_external_changes_detects_out_of_band_edits() {
        let dir = tempfile::tempdir().unwrap();
        let mut options = DataStoreOptions::new();
        options.reject_external_changes = true;
        let store = DataStore::new(
            "config.json",
            serde_json::Value::Null,
            Some(dir.path().to_path_buf()),
            options,
        );
        // Load first so the store snapshots the (absent) file and a first
        // save may create it.
        store.load().unwrap();
        store.save(&serde_json::json!({"v": 1})).unwrap();
        // Simulate an editor that wrote through an old descriptor: same path,
        // different bytes than the last snapshot.
        fs::write(dir.path().join("config.json"), "{\n  \"v\": 2\n}\n").unwrap();
        let err = store.save(&serde_json::json!({"v": 3})).unwrap_err();
        assert!(matches!(err, DataStoreError::ExternalChange));
        // The external value is untouched on disk (the app's cached snapshot
        // still holds v:1, which is why the write was refused).
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("config.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk["v"], 2);
    }

    #[test]
    fn recover_held_file_restores_missing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("config.json");
        fs::write(&destination, "{\n  \"v\": 1\n}\n").unwrap();
        let bytes = fs::read(&destination).unwrap();
        let held = dir
            .path()
            .join(format!(".config.json.{}.1.held", sha256_hex(&bytes)));
        // Move the destination aside (as publishProtected would), leaving only
        // the held file — simulating a crash between hold and publish.
        fs::rename(&destination, &held).unwrap();
        assert!(!destination.exists());

        let store = store_in(dir.path(), "config.json", serde_json::json!({"v": 0}));
        assert_eq!(store.load().unwrap()["v"], 1);
        assert!(destination.exists());
        assert!(!held.exists(), "held file should have been consumed");
    }

    #[test]
    fn recover_previous_sweeps_unchanged_and_preserves_edited() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("config.json");
        fs::write(&destination, "{\n  \"v\": 1\n}\n").unwrap();

        // Unchanged predecessor: hash matches → swept.
        let bytes = fs::read(&destination).unwrap();
        let unchanged = dir
            .path()
            .join(format!(".config.json.{}.9.previous", sha256_hex(&bytes)));
        fs::copy(&destination, &unchanged).unwrap();
        // Edited predecessor: hash mismatch → parked as a conflict.
        let edited = dir.path().join(format!(
            ".config.json.{}.9.previous",
            sha256_hex(b"different bytes!")
        ));
        fs::write(&edited, "{\n  \"v\": 99\n}\n").unwrap();

        let store = store_in(dir.path(), "config.json", serde_json::json!({"v": 0}));
        assert_eq!(store.load().unwrap()["v"], 1);
        assert!(!unchanged.exists(), "unchanged predecessor should be swept");
        assert!(!edited.exists(), "edited predecessor should be parked away");

        let conflicts: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".conflict-"))
            .collect();
        assert_eq!(
            conflicts.len(),
            1,
            "expected one conflict park: {conflicts:?}"
        );
    }

    #[test]
    fn machine_local_dir_is_app_support_style() {
        let dir = machine_local_data_dir();
        assert!(dir.to_string_lossy().contains("Application Support"));
        assert!(dir.to_string_lossy().ends_with("aiden-agent"));
    }

    #[test]
    fn data_store_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<DataStore<serde_json::Value>>();
    }

    fn read_dir_count(path: &Path) -> usize {
        fs::read_dir(path).unwrap().count()
    }
}
