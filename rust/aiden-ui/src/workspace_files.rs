//! Bounded, workspace-confined file operations for the Files workbench.
//!
//! Paths are resolved against a canonical workspace root. Existing symlinks
//! may be read or written only when their canonical target remains inside that
//! root. Writes are optimistic, version checked, and preserve a displaced inode
//! whenever another process may still be using it.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt as _;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
#[cfg(unix)]
use std::os::unix::io::AsRawFd as _;

const MAX_INDEX_ENTRIES: usize = 4_000;
const MAX_INDEX_DEPTH: usize = 20;
const MAX_EDITOR_BYTES: usize = 1_500_000;
const MAX_EDITOR_LINES: usize = 50_000;
const SKIP_DIRECTORIES: &[&str] = &[
    ".git",
    ".cache",
    ".build",
    ".next",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "release",
];

static UNIQUE_PATH_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
const O_NOFOLLOW: i32 = 0x0000_0100;
#[cfg(target_os = "macos")]
const O_DIRECTORY: i32 = 0x0010_0000;
#[cfg(target_os = "linux")]
const O_NOFOLLOW: i32 = 0x0002_0000;

/// A cheap, thread-safe cancellation handle for off-thread workspace I/O.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceFileCancellation(Arc<AtomicBool>);

impl WorkspaceFileCancellation {
    /// Request cancellation. In-flight operations stop at their next safe checkpoint.
    pub fn cancel(&self) {
        self.0.store(true, AtomicOrdering::Release);
    }

    fn check(&self) -> Result<(), WorkspaceFilesError> {
        if self.0.load(AtomicOrdering::Acquire) {
            Err(WorkspaceFilesError::message(
                "The workspace operation was cancelled.",
            ))
        } else {
            Ok(())
        }
    }
}

/// The kind of node shown in the workspace file hierarchy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceFileKind {
    Directory,
    File,
    Symlink,
}

/// One portable, workspace-relative entry in the file hierarchy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub path: String,
    pub name: String,
    pub parent_path: String,
    pub depth: usize,
    pub kind: WorkspaceFileKind,
    #[serde(default, skip_serializing_if = "is_false")]
    pub symbolic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
}

/// A bounded snapshot of a workspace hierarchy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileIndex {
    pub entries: Vec<WorkspaceFileEntry>,
    pub truncated: bool,
    pub skipped_directories: usize,
}

/// A durable artifact left for conservative startup reconciliation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecoveryArtifact {
    pub path: String,
    pub kind: WorkspaceRecoveryKind,
}

/// Whether a startup artifact is a retained original or an uncommitted draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRecoveryKind {
    RetainedOriginal,
    StagedDraft,
}

/// UTF-8 text opened by the workspace editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileDocument {
    pub path: String,
    pub content: String,
    pub size: usize,
    pub modified_at: u64,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Stable error categories consumed by the future Files workbench.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceFileErrorCode {
    ChangedOnDisk,
    IoError,
}

/// A workspace file operation failure with a UI-safe category and message.
#[derive(Debug, Error)]
pub enum WorkspaceFilesError {
    #[error("{0}")]
    ChangedOnDisk(String),
    #[error("{message}")]
    Io {
        message: String,
        #[source]
        source: Option<io::Error>,
    },
}

impl WorkspaceFilesError {
    /// Return the stable category used by the Files workbench.
    pub fn code(&self) -> WorkspaceFileErrorCode {
        match self {
            Self::ChangedOnDisk(_) => WorkspaceFileErrorCode::ChangedOnDisk,
            Self::Io { .. } => WorkspaceFileErrorCode::IoError,
        }
    }

    fn io(message: impl Into<String>, source: io::Error) -> Self {
        Self::Io {
            message: message.into(),
            source: Some(source),
        }
    }

    fn message(message: impl Into<String>) -> Self {
        Self::Io {
            message: message.into(),
            source: None,
        }
    }
}

struct ResolvedPath {
    full_path: PathBuf,
    relative_path: String,
    parent: VerifiedDirectory,
    file_name: std::ffi::OsString,
    metadata: fs::Metadata,
}

struct VerifiedDirectory {
    _file: File,
    canonical_path: PathBuf,
}

#[derive(Debug, Clone)]
struct PendingDirectory {
    relative_path: PathBuf,
    depth: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct DirectoryChild {
    name: std::ffi::OsString,
    kind: DirectoryChildKind,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum DirectoryChildKind {
    Directory,
    File,
    Symlink,
    Unknown,
}

impl Ord for DirectoryChild {
    fn cmp(&self, other: &Self) -> Ordering {
        compare_directory_children(self, other)
    }
}

impl PartialOrd for DirectoryChild {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

type BeforeDisplaceHook<'a> = &'a mut dyn FnMut() -> io::Result<()>;
type BeforeRecoveryCleanupHook<'a> = &'a mut dyn FnMut(&Path) -> io::Result<()>;
type BeforeExchangeHook<'a> = &'a mut dyn FnMut() -> io::Result<()>;
type AfterExchangeHook<'a> = &'a mut dyn FnMut(&Path) -> io::Result<()>;

#[derive(Default)]
struct WriteHooks<'a> {
    before_displace: Option<BeforeDisplaceHook<'a>>,
    before_recovery_cleanup: Option<BeforeRecoveryCleanupHook<'a>>,
    before_exchange: Option<BeforeExchangeHook<'a>>,
    after_exchange: Option<AfterExchangeHook<'a>>,
}

/// Build a deterministic, directory-first file hierarchy without leaving the
/// canonical workspace root.
///
/// Generated directories are omitted. The result contains at most 4,000
/// entries and descends at most 20 levels; `truncated` reports either limit.
pub fn list_workspace_files(root: &Path) -> Result<WorkspaceFileIndex, WorkspaceFilesError> {
    list_workspace_files_cancellable(root, &WorkspaceFileCancellation::default())
}

/// Discover bounded save artifacts that a startup surface should reconcile.
///
/// The scan uses the same 4,000-entry and depth-20 bounds as the Files panel.
/// Artifacts are never deleted automatically because open descriptors can
/// mutate a retained inode after any process-level liveness probe.
pub fn list_workspace_recovery_artifacts(
    root: &Path,
) -> Result<Vec<WorkspaceRecoveryArtifact>, WorkspaceFilesError> {
    let index = list_workspace_files(root)?;
    Ok(index
        .entries
        .into_iter()
        .filter_map(|entry| {
            let name = Path::new(&entry.path).file_name()?.to_string_lossy();
            let kind = if name.contains(".aiden-recovery-") {
                WorkspaceRecoveryKind::RetainedOriginal
            } else if name.contains(".aiden-") && name.ends_with(".tmp") {
                WorkspaceRecoveryKind::StagedDraft
            } else {
                return None;
            };
            Some(WorkspaceRecoveryArtifact {
                path: entry.path,
                kind,
            })
        })
        .collect())
}

/// Build the workspace hierarchy while observing an off-thread cancellation handle.
pub fn list_workspace_files_cancellable(
    root: &Path,
    cancellation: &WorkspaceFileCancellation,
) -> Result<WorkspaceFileIndex, WorkspaceFilesError> {
    let root = canonical_root(root)?;
    let mut entries = Vec::new();
    let mut directories = VecDeque::from([PendingDirectory {
        relative_path: PathBuf::new(),
        depth: 0,
    }]);
    let mut truncated = false;
    let mut skipped_directories = 0;

    'directories: while let Some(directory) = directories.pop_front() {
        cancellation.check()?;
        if directory.depth > MAX_INDEX_DEPTH {
            truncated = true;
            break;
        }

        let remaining = MAX_INDEX_ENTRIES.saturating_sub(entries.len());
        if remaining == 0 {
            truncated = true;
            break;
        }
        let directory_path = root.join(&directory.relative_path);
        let verified_directory = open_verified_directory(&root, &directory_path)?;
        let (children, directory_overflow, directory_skips) =
            read_directory_children(&verified_directory, remaining, cancellation)?;
        truncated |= directory_overflow;
        skipped_directories += directory_skips;

        for child in children {
            cancellation.check()?;
            if entries.len() >= MAX_INDEX_ENTRIES {
                truncated = true;
                break 'directories;
            }

            let name = child.name.to_string_lossy().into_owned();
            if child.kind == DirectoryChildKind::Directory
                && SKIP_DIRECTORIES.contains(&name.as_str())
            {
                skipped_directories += 1;
                continue;
            }

            let relative_path = directory.relative_path.join(&name);
            let entry_path = portable_path(&relative_path);
            let parent_path = portable_path(&directory.relative_path);
            if child.kind == DirectoryChildKind::Symlink {
                entries.push(WorkspaceFileEntry {
                    path: entry_path,
                    name,
                    parent_path,
                    depth: directory.depth,
                    kind: WorkspaceFileKind::Symlink,
                    symbolic: true,
                    size: None,
                    modified_at: None,
                });
                continue;
            }
            let child_file =
                open_child_no_follow(&verified_directory, &child.name).map_err(|error| {
                    WorkspaceFilesError::io(
                        format!("Aiden could not inspect {name} without following links."),
                        error,
                    )
                })?;
            let child_metadata = child_file.metadata().map_err(|error| {
                WorkspaceFilesError::io(format!("Aiden could not inspect {name}."), error)
            })?;
            if child_metadata.is_dir() {
                entries.push(WorkspaceFileEntry {
                    path: entry_path,
                    name,
                    parent_path,
                    depth: directory.depth,
                    kind: WorkspaceFileKind::Directory,
                    symbolic: false,
                    size: None,
                    modified_at: None,
                });
                directories.push_back(PendingDirectory {
                    relative_path,
                    depth: directory.depth + 1,
                });
            } else if child_metadata.is_file() {
                entries.push(WorkspaceFileEntry {
                    path: entry_path,
                    name,
                    parent_path,
                    depth: directory.depth,
                    kind: WorkspaceFileKind::File,
                    symbolic: false,
                    size: Some(child_metadata.len()),
                    modified_at: Some(modified_millis(&child_metadata)),
                });
            }
        }
    }

    sort_workspace_entries(&mut entries);
    Ok(WorkspaceFileIndex {
        entries,
        truncated,
        skipped_directories,
    })
}

/// Open a bounded UTF-8 text document from inside the workspace.
pub fn read_workspace_file(
    root: &Path,
    supplied_path: &str,
) -> Result<WorkspaceFileDocument, WorkspaceFilesError> {
    read_workspace_file_cancellable(root, supplied_path, &WorkspaceFileCancellation::default())
}

/// Open a text document while observing an off-thread cancellation handle.
pub fn read_workspace_file_cancellable(
    root: &Path,
    supplied_path: &str,
    cancellation: &WorkspaceFileCancellation,
) -> Result<WorkspaceFileDocument, WorkspaceFilesError> {
    cancellation.check()?;
    let resolved = resolve_existing_path(root, supplied_path)?;
    let metadata = &resolved.metadata;
    if !metadata.is_file() {
        return Err(WorkspaceFilesError::message(format!(
            "{} is not a file.",
            resolved.relative_path
        )));
    }
    if metadata.len() > MAX_EDITOR_BYTES as u64 {
        return Err(WorkspaceFilesError::message(format!(
            "{} is too large to edit in Aiden ({} MB).",
            resolved.relative_path,
            metadata.len().div_ceil(1_000_000)
        )));
    }

    let bytes = read_bounded(
        open_verified_file(&resolved)?,
        MAX_EDITOR_BYTES,
        &format!("Aiden could not read {}.", resolved.relative_path),
    )?;
    cancellation.check()?;
    if bytes.len() > MAX_EDITOR_BYTES {
        return Err(WorkspaceFilesError::message(format!(
            "{} is too large to edit in Aiden.",
            resolved.relative_path
        )));
    }
    let content = decode_text(&bytes, &resolved.relative_path)?.to_owned();
    Ok(WorkspaceFileDocument {
        path: resolved.relative_path,
        content,
        size: bytes.len(),
        modified_at: modified_millis(metadata),
        version: content_version(&bytes),
        warning: None,
    })
}

/// Save UTF-8 text only when the current file still matches `expected_version`.
///
/// The replacement is staged and synced in the file's verified directory. A
/// recovery hard link is made durable before a gap-free replacement. On macOS
/// the staged and destination names are atomically exchanged, allowing a safe
/// rollback if the displaced inode does not match the opened version.
pub fn write_workspace_file(
    root: &Path,
    supplied_path: &str,
    content: &str,
    expected_version: &str,
) -> Result<WorkspaceFileDocument, WorkspaceFilesError> {
    write_workspace_file_cancellable(
        root,
        supplied_path,
        content,
        expected_version,
        &WorkspaceFileCancellation::default(),
    )
}

/// Save a document while observing cancellation until the replacement begins.
pub fn write_workspace_file_cancellable(
    root: &Path,
    supplied_path: &str,
    content: &str,
    expected_version: &str,
    cancellation: &WorkspaceFileCancellation,
) -> Result<WorkspaceFileDocument, WorkspaceFilesError> {
    write_workspace_file_with_hooks(
        root,
        supplied_path,
        content,
        expected_version,
        cancellation,
        &mut WriteHooks::default(),
    )
}

fn write_workspace_file_with_hooks(
    root: &Path,
    supplied_path: &str,
    content: &str,
    expected_version: &str,
    cancellation: &WorkspaceFileCancellation,
    hooks: &mut WriteHooks<'_>,
) -> Result<WorkspaceFileDocument, WorkspaceFilesError> {
    cancellation.check()?;
    validate_write_content(content, supplied_path)?;
    let resolved = resolve_existing_path(root, supplied_path)?;
    if !resolved.metadata.is_file() {
        return Err(WorkspaceFilesError::message(format!(
            "{} is not a file.",
            resolved.relative_path
        )));
    }

    let current = read_bounded(
        open_verified_file(&resolved)?,
        MAX_EDITOR_BYTES,
        &format!(
            "Aiden could not read {} before saving.",
            resolved.relative_path
        ),
    )?;
    if content_version(&current) != expected_version {
        return Err(changed_on_disk(format!(
            "{} changed on disk. Reload it before saving so newer work is not overwritten.",
            resolved.relative_path
        )));
    }

    if let Some(before_displace) = hooks.before_displace.as_deref_mut() {
        before_displace().map_err(|error| {
            WorkspaceFilesError::io("The test save interleaving failed.", error)
        })?;
    }
    cancellation.check()?;

    let refreshed = resolve_existing_path(root, supplied_path)?;
    let refreshed_bytes = read_bounded(
        open_verified_file(&refreshed)?,
        MAX_EDITOR_BYTES,
        "Aiden could not revalidate the file before saving.",
    )?;
    if !same_file(&resolved.metadata, &refreshed.metadata)
        || content_version(&refreshed_bytes) != expected_version
    {
        return Err(changed_on_disk(format!(
            "{} changed while Aiden prepared the save. The newer on-disk file was not overwritten.",
            resolved.relative_path
        )));
    }

    let destination_name = refreshed
        .full_path
        .file_name()
        .ok_or_else(|| WorkspaceFilesError::message("The workspace file name is unavailable."))?;
    let temporary_name = unused_sibling_name(destination_name, "aiden", ".tmp");
    let recovery_name = unused_sibling_name(destination_name, "aiden-recovery", "");
    let destination_path = refreshed.parent.canonical_path.join(&refreshed.file_name);
    let temporary_path = refreshed.parent.canonical_path.join(&temporary_name);
    let recovery_path = refreshed.parent.canonical_path.join(&recovery_name);

    create_staged_file(
        &refreshed.parent,
        &temporary_name,
        content.as_bytes(),
        &refreshed.metadata,
    )?;
    let mut replacement_started = false;
    let result = (|| -> Result<Option<String>, WorkspaceFilesError> {
        hard_link_child(&refreshed.parent, &refreshed.file_name, &recovery_name).map_err(
            |error| {
                WorkspaceFilesError::io(
                    "Aiden could not retain the original file for recovery.",
                    error,
                )
            },
        )?;
        refreshed.parent.sync()?;

        if let Some(before_exchange) = hooks.before_exchange.as_deref_mut() {
            before_exchange().map_err(|error| {
                WorkspaceFilesError::io("The test pre-replacement checkpoint failed.", error)
            })?;
        }
        cancellation.check()?;
        verify_destination_identity(&refreshed)?;
        let current_permissions = open_child_no_follow(&refreshed.parent, &refreshed.file_name)
            .and_then(|file| file.metadata())
            .map_err(|error| {
                WorkspaceFilesError::io("Aiden could not recheck the file mode.", error)
            })?
            .permissions();
        let staged_file =
            open_child_no_follow(&refreshed.parent, &temporary_name).map_err(|error| {
                WorkspaceFilesError::io("Aiden could not reopen the staged file.", error)
            })?;
        staged_file
            .set_permissions(current_permissions)
            .map_err(|error| {
                WorkspaceFilesError::io("Aiden could not preserve the current file mode.", error)
            })?;
        staged_file.sync_all().map_err(|error| {
            WorkspaceFilesError::io("Aiden could not sync the staged mode.", error)
        })?;
        let original_guard = open_child_no_follow(&refreshed.parent, &refreshed.file_name)
            .map_err(|error| {
                WorkspaceFilesError::io("Aiden could not hold the original file open.", error)
            })?;
        let original_identity = original_guard.metadata().map_err(|error| {
            WorkspaceFilesError::io("Aiden could not identify the original file.", error)
        })?;
        let staged_identity = staged_file.metadata().map_err(|error| {
            WorkspaceFilesError::io("Aiden could not identify the staged file.", error)
        })?;
        let staged_name_identity = open_child_no_follow(&refreshed.parent, &temporary_name)
            .and_then(|file| file.metadata())
            .map_err(|error| {
                WorkspaceFilesError::io("Aiden could not revalidate the staged name.", error)
            })?;
        if !same_file(&original_identity, &refreshed.metadata)
            || !same_file(&staged_identity, &staged_name_identity)
        {
            return Err(changed_on_disk(
                "A file identity changed before the atomic exchange. Aiden preserved all artifacts and did not replace the destination."
                    .to_string(),
            ));
        }
        atomic_replace(&refreshed.parent, &temporary_name, &refreshed.file_name)?;
        replacement_started = true;
        let unknown_exchange_outcome = |detail: &str| {
            changed_on_disk(format!(
                "{} changed during the atomic exchange ({detail}). Aiden preserved the destination, displaced name, and recovery artifact without attempting an unsafe pathname rollback; the outcome is unknown.",
                refreshed.relative_path
            ))
        };
        if let Some(after_exchange) = hooks.after_exchange.as_deref_mut() {
            after_exchange(&temporary_path)
                .map_err(|_| unknown_exchange_outcome("post-exchange checkpoint failed"))?;
        }
        validate_swapped_names(
            &refreshed.parent,
            &temporary_name,
            &refreshed.file_name,
            &original_identity,
            &staged_identity,
        )?;

        let displaced_permissions = original_guard
            .metadata()
            .map_err(|_| unknown_exchange_outcome("displaced metadata was unavailable"))?
            .permissions();
        staged_file
            .set_permissions(displaced_permissions)
            .map_err(|_| unknown_exchange_outcome("installed mode could not be preserved"))?;
        staged_file
            .sync_all()
            .map_err(|_| unknown_exchange_outcome("installed mode could not be synced"))?;
        let displaced = read_bounded_from_start(
            original_guard
                .try_clone()
                .map_err(|_| unknown_exchange_outcome("displaced descriptor was unavailable"))?,
            MAX_EDITOR_BYTES,
            "Aiden could not verify the displaced file.",
        )
        .map_err(|_| unknown_exchange_outcome("displaced content could not be verified"))?;
        let saved = read_bounded_from_start(
            staged_file
                .try_clone()
                .map_err(|_| unknown_exchange_outcome("installed descriptor was unavailable"))?,
            MAX_EDITOR_BYTES,
            "Aiden could not verify the saved file.",
        )
        .map_err(|_| unknown_exchange_outcome("installed content could not be verified"))?;
        validate_swapped_names(
            &refreshed.parent,
            &temporary_name,
            &refreshed.file_name,
            &original_identity,
            &staged_identity,
        )?;
        if content_version(&displaced) != expected_version
            || content_version(&saved) != content_version(content.as_bytes())
        {
            return Err(unknown_exchange_outcome("content identity did not match"));
        }

        if let Some(before_cleanup) = hooks.before_recovery_cleanup.as_deref_mut() {
            before_cleanup(&recovery_path).map_err(|error| {
                WorkspaceFilesError::io("The test recovery interleaving failed.", error)
            })?;
        }
        let latest_displaced_permissions = original_guard
            .metadata()
            .map_err(|_| unknown_exchange_outcome("latest displaced metadata was unavailable"))?
            .permissions();
        staged_file
            .set_permissions(latest_displaced_permissions)
            .map_err(|_| unknown_exchange_outcome("latest mode could not be preserved"))?;
        staged_file
            .sync_all()
            .map_err(|_| unknown_exchange_outcome("latest mode could not be synced"))?;
        validate_swapped_names(
            &refreshed.parent,
            &temporary_name,
            &refreshed.file_name,
            &original_identity,
            &staged_identity,
        )?;
        let recovery_matches = original_guard
            .try_clone()
            .ok()
            .and_then(|file| read_bounded_from_start(file, MAX_EDITOR_BYTES, "recovery read").ok())
            .map(|bytes| content_version(&bytes) == expected_version);
        let _ = unlink_child(&refreshed.parent, &temporary_name);
        open_child_no_follow(&refreshed.parent, &refreshed.file_name)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                WorkspaceFilesError::io("Aiden could not sync the saved file.", error)
            })?;
        refreshed.parent.sync()?;

        Ok(Some(if recovery_matches == Some(false) {
            format!(
                "Another app wrote to the previous file during Aiden's save. Your draft was saved, and that app's version remains at {}.",
                recovery_name.to_string_lossy()
            )
        } else {
            format!(
                "Aiden saved your draft and retained the previous version at {} for conservative recovery.",
                recovery_name.to_string_lossy()
            )
        }))
    })();

    if result.is_err() && !replacement_started {
        let _ = unlink_child(&refreshed.parent, &temporary_name);
        if fs::metadata(&destination_path).is_ok() {
            let _ = unlink_child(&refreshed.parent, &recovery_name);
        }
        let _ = refreshed.parent.sync();
    }
    let warning = result?;
    let saved_metadata = fs::metadata(&destination_path).map_err(|error| {
        WorkspaceFilesError::io(
            format!(
                "Aiden could not inspect the saved {}.",
                refreshed.relative_path
            ),
            error,
        )
    })?;
    Ok(WorkspaceFileDocument {
        path: refreshed.relative_path,
        content: content.to_owned(),
        size: content.len(),
        modified_at: modified_millis(&saved_metadata),
        version: content_version(content.as_bytes()),
        warning,
    })
}

fn canonical_root(root: &Path) -> Result<PathBuf, WorkspaceFilesError> {
    let root = fs::canonicalize(root)
        .map_err(|error| WorkspaceFilesError::io("The workspace folder is unavailable.", error))?;
    let metadata = fs::metadata(&root)
        .map_err(|error| WorkspaceFilesError::io("The workspace folder is unavailable.", error))?;
    if !metadata.is_dir() {
        return Err(WorkspaceFilesError::message(
            "The workspace folder is unavailable.",
        ));
    }
    Ok(root)
}

fn resolve_existing_path(
    root: &Path,
    supplied_path: &str,
) -> Result<ResolvedPath, WorkspaceFilesError> {
    let root = canonical_root(root)?;
    let relative = normalize_relative_path(supplied_path)?;
    let lexical_path = root.join(&relative);
    let full_path = fs::canonicalize(&lexical_path).map_err(|error| {
        WorkspaceFilesError::io(format!("Aiden could not open {supplied_path}."), error)
    })?;
    if full_path.strip_prefix(&root).is_err() {
        return Err(WorkspaceFilesError::message(format!(
            "Path \"{supplied_path}\" resolves outside the workspace folder."
        )));
    }
    let parent_path = full_path
        .parent()
        .ok_or_else(|| WorkspaceFilesError::message("The workspace file parent is unavailable."))?;
    let parent = open_verified_directory(&root, parent_path)?;
    let file_name = full_path
        .file_name()
        .ok_or_else(|| WorkspaceFilesError::message("The workspace file name is unavailable."))?
        .to_os_string();
    let metadata = fs::metadata(&full_path).map_err(|error| {
        WorkspaceFilesError::io(format!("Aiden could not inspect {supplied_path}."), error)
    })?;
    let descriptor_metadata = open_child_no_follow(&parent, &file_name)
        .and_then(|file| file.metadata())
        .map_err(|error| {
            WorkspaceFilesError::io(format!("Aiden could not open {supplied_path}."), error)
        })?;
    if !same_file(&metadata, &descriptor_metadata) {
        return Err(changed_on_disk(format!(
            "{supplied_path} changed while Aiden verified its workspace location."
        )));
    }
    Ok(ResolvedPath {
        full_path,
        relative_path: portable_path(&relative),
        parent,
        file_name,
        metadata,
    })
}

fn open_verified_directory(
    root: &Path,
    requested_path: &Path,
) -> Result<VerifiedDirectory, WorkspaceFilesError> {
    let canonical_path = fs::canonicalize(requested_path).map_err(|error| {
        WorkspaceFilesError::io(
            format!("Aiden could not open {}.", requested_path.display()),
            error,
        )
    })?;
    if canonical_path.strip_prefix(root).is_err() {
        return Err(WorkspaceFilesError::message(format!(
            "{} resolves outside the workspace folder.",
            requested_path.display()
        )));
    }
    let expected = fs::metadata(&canonical_path).map_err(|error| {
        WorkspaceFilesError::io("Aiden could not inspect a workspace directory.", error)
    })?;
    let recanonicalized = fs::canonicalize(requested_path).map_err(|error| {
        WorkspaceFilesError::io("A workspace directory changed during inspection.", error)
    })?;
    if recanonicalized != canonical_path || recanonicalized.strip_prefix(root).is_err() {
        return Err(changed_on_disk(
            "A workspace directory changed during inspection.".to_string(),
        ));
    }
    let file = open_directory_no_follow(&canonical_path).map_err(|error| {
        WorkspaceFilesError::io("Aiden could not open a workspace directory.", error)
    })?;
    let opened = file.metadata().map_err(|error| {
        WorkspaceFilesError::io("Aiden could not verify a workspace directory.", error)
    })?;
    if !opened.is_dir() || !same_file(&expected, &opened) {
        return Err(changed_on_disk(
            "A workspace directory changed during inspection.".to_string(),
        ));
    }
    let after_open = fs::metadata(&canonical_path).map_err(|error| {
        WorkspaceFilesError::io("A workspace directory changed during inspection.", error)
    })?;
    if !same_file(&opened, &after_open) {
        return Err(changed_on_disk(
            "A workspace directory changed during inspection.".to_string(),
        ));
    }
    Ok(VerifiedDirectory {
        _file: file,
        canonical_path,
    })
}

impl VerifiedDirectory {
    fn verify_identity(&self) -> Result<(), WorkspaceFilesError> {
        let opened = self._file.metadata().map_err(|error| {
            WorkspaceFilesError::io(
                "Aiden could not inspect the open workspace directory.",
                error,
            )
        })?;
        let current = fs::metadata(&self.canonical_path).map_err(|error| {
            WorkspaceFilesError::io("The workspace directory changed during traversal.", error)
        })?;
        if same_file(&opened, &current) {
            Ok(())
        } else {
            Err(changed_on_disk(
                "The workspace directory changed during traversal.".to_string(),
            ))
        }
    }

    fn sync(&self) -> Result<(), WorkspaceFilesError> {
        self._file.sync_all().map_err(|error| {
            WorkspaceFilesError::io("Aiden could not sync the workspace directory.", error)
        })
    }
}

fn open_verified_file(resolved: &ResolvedPath) -> Result<File, WorkspaceFilesError> {
    let file = open_child_no_follow(&resolved.parent, &resolved.file_name).map_err(|error| {
        WorkspaceFilesError::io(
            format!("Aiden could not open {}.", resolved.relative_path),
            error,
        )
    })?;
    let metadata = file.metadata().map_err(|error| {
        WorkspaceFilesError::io(
            format!("Aiden could not inspect {}.", resolved.relative_path),
            error,
        )
    })?;
    if !same_file(&resolved.metadata, &metadata) {
        return Err(changed_on_disk(format!(
            "{} changed during inspection.",
            resolved.relative_path
        )));
    }
    Ok(file)
}

fn open_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    options.custom_flags(O_NOFOLLOW);
    options.open(path)
}

fn open_directory_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    options.custom_flags(O_NOFOLLOW | O_DIRECTORY);
    #[cfg(target_os = "linux")]
    options.custom_flags(O_NOFOLLOW);
    options.open(path)
}

#[cfg(target_os = "macos")]
fn open_child_no_follow(parent: &VerifiedDirectory, name: &std::ffi::OsStr) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::FromRawFd as _;
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt as _;

    unsafe extern "C" {
        fn openat(fd: c_int, path: *const c_char, flags: c_int, mode: u32) -> c_int;
    }
    const O_RDONLY: c_int = 0;
    const O_CLOEXEC: c_int = 0x0100_0000;
    let name = CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains null"))?;
    // SAFETY: `name` is a valid C string and the returned descriptor is uniquely owned.
    let fd = unsafe {
        openat(
            parent._file.as_raw_fd(),
            name.as_ptr(),
            O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
            0,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: `openat` returned a new owned descriptor on success.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

#[cfg(target_os = "macos")]
fn create_child_exclusive(parent: &VerifiedDirectory, name: &std::ffi::OsStr) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::FromRawFd as _;
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt as _;

    unsafe extern "C" {
        fn openat(fd: c_int, path: *const c_char, flags: c_int, mode: u32) -> c_int;
    }
    const O_WRONLY: c_int = 1;
    const O_CREAT: c_int = 0x0000_0200;
    const O_EXCL: c_int = 0x0000_0800;
    const O_CLOEXEC: c_int = 0x0100_0000;
    let name = CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name contains null"))?;
    // SAFETY: `name` is a valid C string and the returned descriptor is uniquely owned.
    let fd = unsafe {
        openat(
            parent._file.as_raw_fd(),
            name.as_ptr(),
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: `openat` returned a new owned descriptor on success.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

#[cfg(not(target_os = "macos"))]
fn create_child_exclusive(parent: &VerifiedDirectory, name: &std::ffi::OsStr) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(parent.canonical_path.join(name))
}

#[cfg(not(target_os = "macos"))]
fn open_child_no_follow(parent: &VerifiedDirectory, name: &std::ffi::OsStr) -> io::Result<File> {
    open_no_follow(&parent.canonical_path.join(name))
}

fn verify_destination_identity(resolved: &ResolvedPath) -> Result<(), WorkspaceFilesError> {
    let metadata = open_child_no_follow(&resolved.parent, &resolved.file_name)
        .and_then(|file| file.metadata())
        .map_err(|error| {
            WorkspaceFilesError::io("The workspace file changed before replacement.", error)
        })?;
    if same_file(&resolved.metadata, &metadata) {
        Ok(())
    } else {
        Err(changed_on_disk(format!(
            "{} changed before replacement.",
            resolved.relative_path
        )))
    }
}

fn validate_swapped_names(
    parent: &VerifiedDirectory,
    displaced_name: &std::ffi::OsStr,
    installed_name: &std::ffi::OsStr,
    expected_displaced: &fs::Metadata,
    expected_installed: &fs::Metadata,
) -> Result<(), WorkspaceFilesError> {
    let displaced = open_child_no_follow(parent, displaced_name)
        .and_then(|file| file.metadata())
        .map_err(|_| {
            changed_on_disk(
                "The displaced name became unavailable after the atomic exchange. Aiden preserved every recovery artifact and did not attempt rollback because the outcome is unknown."
                    .to_string(),
            )
        })?;
    let installed = open_child_no_follow(parent, installed_name)
        .and_then(|file| file.metadata())
        .map_err(|_| {
            changed_on_disk(
                "The destination name became unavailable after the atomic exchange. Aiden preserved every recovery artifact and did not attempt rollback because the outcome is unknown."
                    .to_string(),
            )
        })?;
    if same_file(&displaced, expected_displaced) && same_file(&installed, expected_installed) {
        Ok(())
    } else {
        Err(changed_on_disk(
            "A file name changed after the atomic exchange. Aiden preserved every recovery artifact and did not attempt rollback because the outcome is unknown."
                .to_string(),
        ))
    }
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.file_type() == right.file_type()
}

fn normalize_relative_path(supplied_path: &str) -> Result<PathBuf, WorkspaceFilesError> {
    if supplied_path.is_empty() || supplied_path.contains('\0') {
        return Err(WorkspaceFilesError::message(
            "Choose a file inside the workspace.",
        ));
    }
    let supplied = Path::new(supplied_path);
    if supplied.is_absolute() {
        return Err(WorkspaceFilesError::message(
            "Choose a file inside the workspace.",
        ));
    }

    let mut normalized = PathBuf::new();
    for component in supplied.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(WorkspaceFilesError::message(format!(
                        "Path \"{supplied_path}\" is outside the workspace folder."
                    )));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceFilesError::message(
                    "Choose a file inside the workspace.",
                ));
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(WorkspaceFilesError::message(
            "Choose a file inside the workspace.",
        ));
    }
    Ok(normalized)
}

fn compare_directory_children(left: &DirectoryChild, right: &DirectoryChild) -> Ordering {
    let left_directory = left.kind == DirectoryChildKind::Directory;
    let right_directory = right.kind == DirectoryChildKind::Directory;
    right_directory
        .cmp(&left_directory)
        .then_with(|| natural_cmp(&left.name.to_string_lossy(), &right.name.to_string_lossy()))
}

fn retain_bounded_child(
    heap: &mut BinaryHeap<DirectoryChild>,
    child: DirectoryChild,
    maximum: usize,
) -> bool {
    if maximum == 0 {
        return true;
    }
    if heap.len() < maximum {
        heap.push(child);
        return false;
    }
    if heap.peek().is_some_and(|largest| child < *largest) {
        let _ = heap.pop();
        heap.push(child);
    }
    true
}

#[cfg(target_os = "macos")]
fn read_directory_children(
    directory: &VerifiedDirectory,
    maximum: usize,
    cancellation: &WorkspaceFileCancellation,
) -> Result<(Vec<DirectoryChild>, bool, usize), WorkspaceFilesError> {
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStringExt as _;

    #[repr(C, packed(4))]
    struct MacDirent {
        d_ino: u64,
        d_seekoff: u64,
        d_reclen: u16,
        d_namlen: u16,
        d_type: u8,
        d_name: [c_char; 1024],
    }
    #[repr(C)]
    struct MacDir {
        _private: [u8; 0],
    }
    unsafe extern "C" {
        fn dup(fd: c_int) -> c_int;
        fn fdopendir(fd: c_int) -> *mut MacDir;
        fn readdir(dir: *mut MacDir) -> *mut MacDirent;
        fn closedir(dir: *mut MacDir) -> c_int;
        fn __error() -> *mut c_int;
    }
    struct Stream(*mut MacDir);
    impl Drop for Stream {
        fn drop(&mut self) {
            // SAFETY: `fdopendir` returned this stream and Drop runs once.
            let _ = unsafe { closedir(self.0) };
        }
    }

    // SAFETY: dup receives a live verified directory descriptor.
    let duplicated = unsafe { dup(directory._file.as_raw_fd()) };
    if duplicated < 0 {
        return Err(WorkspaceFilesError::io(
            "Aiden could not duplicate the workspace directory handle.",
            io::Error::last_os_error(),
        ));
    }
    // SAFETY: ownership of `duplicated` transfers to fdopendir on success.
    let raw_stream = unsafe { fdopendir(duplicated) };
    if raw_stream.is_null() {
        // SAFETY: fdopendir failed and did not take ownership.
        unsafe extern "C" {
            fn close(fd: c_int) -> c_int;
        }
        let _ = unsafe { close(duplicated) };
        return Err(WorkspaceFilesError::io(
            "Aiden could not enumerate the workspace directory handle.",
            io::Error::last_os_error(),
        ));
    }
    let stream = Stream(raw_stream);
    let mut heap = BinaryHeap::with_capacity(maximum);
    let mut overflow = false;
    let mut skipped_directories = 0;
    loop {
        cancellation.check()?;
        // SAFETY: macOS exposes thread-local errno through __error.
        unsafe { *__error() = 0 };
        // SAFETY: stream remains live for this loop and readdir owns its buffer.
        let entry = unsafe { readdir(stream.0) };
        if entry.is_null() {
            // SAFETY: reading the thread-local errno value is valid.
            let error = unsafe { *__error() };
            if error == 0 {
                break;
            }
            return Err(WorkspaceFilesError::io(
                "Aiden could not continue workspace directory enumeration.",
                io::Error::from_raw_os_error(error),
            ));
        }
        // SAFETY: fields are copied with unaligned reads from the packed dirent.
        let name_length =
            unsafe { std::ptr::addr_of!((*entry).d_namlen).read_unaligned() } as usize;
        let kind = unsafe { std::ptr::addr_of!((*entry).d_type).read_unaligned() };
        // SAFETY: d_namlen is bounded by the 1024-byte d_name field on macOS.
        let name_bytes = unsafe {
            std::slice::from_raw_parts(
                std::ptr::addr_of!((*entry).d_name).cast::<u8>(),
                name_length.min(1024),
            )
        };
        if name_bytes == b"." || name_bytes == b".." {
            continue;
        }
        let child = DirectoryChild {
            name: std::ffi::OsString::from_vec(name_bytes.to_vec()),
            kind: match kind {
                4 => DirectoryChildKind::Directory,
                8 => DirectoryChildKind::File,
                10 => DirectoryChildKind::Symlink,
                _ => DirectoryChildKind::Unknown,
            },
        };
        if child.kind == DirectoryChildKind::Directory
            && SKIP_DIRECTORIES.contains(&child.name.to_string_lossy().as_ref())
        {
            skipped_directories += 1;
            continue;
        }
        overflow |= retain_bounded_child(&mut heap, child, maximum);
    }
    directory.verify_identity()?;
    let mut children = heap.into_vec();
    children.sort_by(compare_directory_children);
    Ok((children, overflow, skipped_directories))
}

#[cfg(not(target_os = "macos"))]
fn read_directory_children(
    directory: &VerifiedDirectory,
    maximum: usize,
    cancellation: &WorkspaceFileCancellation,
) -> Result<(Vec<DirectoryChild>, bool, usize), WorkspaceFilesError> {
    let mut heap = BinaryHeap::with_capacity(maximum);
    let mut overflow = false;
    let mut skipped_directories = 0;
    for entry in fs::read_dir(&directory.canonical_path).map_err(|error| {
        WorkspaceFilesError::io("Aiden could not enumerate the workspace directory.", error)
    })? {
        cancellation.check()?;
        let entry = entry.map_err(|error| {
            WorkspaceFilesError::io("Aiden could not read a workspace directory entry.", error)
        })?;
        let file_type = entry.file_type().map_err(|error| {
            WorkspaceFilesError::io(
                "Aiden could not identify a workspace directory entry.",
                error,
            )
        })?;
        let child = DirectoryChild {
            name: entry.file_name(),
            kind: if file_type.is_dir() {
                DirectoryChildKind::Directory
            } else if file_type.is_file() {
                DirectoryChildKind::File
            } else if file_type.is_symlink() {
                DirectoryChildKind::Symlink
            } else {
                DirectoryChildKind::Unknown
            },
        };
        if child.kind == DirectoryChildKind::Directory
            && SKIP_DIRECTORIES.contains(&child.name.to_string_lossy().as_ref())
        {
            skipped_directories += 1;
            continue;
        }
        overflow |= retain_bounded_child(&mut heap, child, maximum);
    }
    directory.verify_identity()?;
    let mut children = heap.into_vec();
    children.sort_by(compare_directory_children);
    Ok((children, overflow, skipped_directories))
}

fn sort_workspace_entries(entries: &mut [WorkspaceFileEntry]) {
    let directory_by_path: HashMap<String, bool> = entries
        .iter()
        .map(|entry| {
            (
                entry.path.clone(),
                entry.kind == WorkspaceFileKind::Directory,
            )
        })
        .collect();
    entries.sort_by(|left, right| compare_workspace_paths(left, right, &directory_by_path));
}

fn compare_workspace_paths(
    left: &WorkspaceFileEntry,
    right: &WorkspaceFileEntry,
    directory_by_path: &HashMap<String, bool>,
) -> Ordering {
    let left_parts: Vec<_> = left.path.split('/').collect();
    let right_parts: Vec<_> = right.path.split('/').collect();
    for index in 0..left_parts.len().min(right_parts.len()) {
        if left_parts[index] == right_parts[index] {
            continue;
        }
        let left_prefix = left_parts[..=index].join("/");
        let right_prefix = right_parts[..=index].join("/");
        let left_directory = directory_by_path
            .get(&left_prefix)
            .copied()
            .unwrap_or(false);
        let right_directory = directory_by_path
            .get(&right_prefix)
            .copied()
            .unwrap_or(false);
        return right_directory
            .cmp(&left_directory)
            .then_with(|| natural_cmp(left_parts[index], right_parts[index]));
    }
    left_parts.len().cmp(&right_parts.len())
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut left_index = 0;
    let mut right_index = 0;
    while left_index < left.len() && right_index < right.len() {
        if left[left_index].is_ascii_digit() && right[right_index].is_ascii_digit() {
            let left_end = digit_run_end(left, left_index);
            let right_end = digit_run_end(right, right_index);
            let left_number = trim_numeric_zeros(&left[left_index..left_end]);
            let right_number = trim_numeric_zeros(&right[right_index..right_end]);
            let number_order = left_number
                .len()
                .cmp(&right_number.len())
                .then_with(|| left_number.cmp(right_number));
            if number_order != Ordering::Equal {
                return number_order;
            }
            let run_order = (left_end - left_index).cmp(&(right_end - right_index));
            if run_order != Ordering::Equal {
                return run_order;
            }
            left_index = left_end;
            right_index = right_end;
            continue;
        }
        let byte_order = left[left_index]
            .to_ascii_lowercase()
            .cmp(&right[right_index].to_ascii_lowercase())
            .then_with(|| left[left_index].cmp(&right[right_index]));
        if byte_order != Ordering::Equal {
            return byte_order;
        }
        left_index += 1;
        right_index += 1;
    }
    left.len().cmp(&right.len())
}

fn digit_run_end(bytes: &[u8], start: usize) -> usize {
    bytes[start..]
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .map_or(bytes.len(), |offset| start + offset)
}

fn trim_numeric_zeros(bytes: &[u8]) -> &[u8] {
    let first_nonzero = bytes
        .iter()
        .position(|byte| *byte != b'0')
        .unwrap_or(bytes.len().saturating_sub(1));
    &bytes[first_nonzero..]
}

fn validate_write_content(content: &str, supplied_path: &str) -> Result<(), WorkspaceFilesError> {
    if content.len() > MAX_EDITOR_BYTES {
        return Err(WorkspaceFilesError::message(format!(
            "{supplied_path} is too large to save in Aiden."
        )));
    }
    if line_count(content.as_bytes()) > MAX_EDITOR_LINES {
        return Err(WorkspaceFilesError::message(format!(
            "{supplied_path} has too many lines to save safely in Aiden."
        )));
    }
    Ok(())
}

fn decode_text<'a>(bytes: &'a [u8], supplied_path: &str) -> Result<&'a str, WorkspaceFilesError> {
    if bytes.contains(&0) {
        return Err(WorkspaceFilesError::message(format!(
            "{supplied_path} is binary and cannot be edited as text."
        )));
    }
    if line_count(bytes) > MAX_EDITOR_LINES {
        return Err(WorkspaceFilesError::message(format!(
            "{supplied_path} has too many lines to edit safely in Aiden."
        )));
    }
    std::str::from_utf8(bytes).map_err(|_| {
        WorkspaceFilesError::message(format!("{supplied_path} is not valid UTF-8 text."))
    })
}

fn line_count(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == b'\n').count() + 1
}

fn read_bounded(file: File, maximum: usize, message: &str) -> Result<Vec<u8>, WorkspaceFilesError> {
    let mut bytes = Vec::with_capacity(maximum.min(64 * 1024));
    file.take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| WorkspaceFilesError::io(message, error))?;
    if bytes.len() > maximum {
        return Err(WorkspaceFilesError::message(
            "The workspace file grew beyond the safe editor limit.",
        ));
    }
    Ok(bytes)
}

fn read_bounded_from_start(
    mut file: File,
    maximum: usize,
    message: &str,
) -> Result<Vec<u8>, WorkspaceFilesError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| WorkspaceFilesError::io(message, error))?;
    read_bounded(file, maximum, message)
}

fn content_version(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    let mut version = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(version, "{byte:02x}");
    }
    version
}

fn create_staged_file(
    parent: &VerifiedDirectory,
    name: &std::ffi::OsStr,
    content: &[u8],
    source_metadata: &fs::Metadata,
) -> Result<(), WorkspaceFilesError> {
    let mut file = create_child_exclusive(parent, name).map_err(|error| {
        WorkspaceFilesError::io(
            "Aiden could not create a staged file beside the original.",
            error,
        )
    })?;
    let staged = file
        .write_all(content)
        .map_err(|error| WorkspaceFilesError::io("Aiden could not stage the file save.", error))
        .and_then(|()| {
            file.set_permissions(source_metadata.permissions())
                .map_err(|error| {
                    WorkspaceFilesError::io("Aiden could not preserve the file permissions.", error)
                })
                .and_then(|()| {
                    file.sync_all().map_err(|error| {
                        WorkspaceFilesError::io("Aiden could not sync the staged file.", error)
                    })
                })
        });
    if let Err(error) = staged {
        drop(file);
        let _ = unlink_child(parent, name);
        return Err(error);
    }
    Ok(())
}

fn unused_sibling_name(name: &std::ffi::OsStr, label: &str, suffix: &str) -> std::ffi::OsString {
    let name = name.to_string_lossy();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let counter = UNIQUE_PATH_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
    let token = content_version(format!("{}:{timestamp}:{counter}", std::process::id()).as_bytes());
    format!(".{name}.{label}-{}{suffix}", &token[..24]).into()
}

#[cfg(target_os = "macos")]
fn atomic_replace(
    parent: &VerifiedDirectory,
    staged: &std::ffi::OsStr,
    destination: &std::ffi::OsStr,
) -> Result<(), WorkspaceFilesError> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt as _;

    unsafe extern "C" {
        fn renameatx_np(
            from_fd: c_int,
            from: *const c_char,
            to_fd: c_int,
            to: *const c_char,
            flags: u32,
        ) -> c_int;
    }
    const RENAME_SWAP: u32 = 0x0000_0002;
    let staged = CString::new(staged.as_bytes()).map_err(|_| {
        WorkspaceFilesError::message("The staged file name contains an invalid null byte.")
    })?;
    let destination = CString::new(destination.as_bytes()).map_err(|_| {
        WorkspaceFilesError::message("The destination name contains an invalid null byte.")
    })?;
    let directory_fd = parent._file.as_raw_fd();
    // SAFETY: both pointers remain valid for the call and are terminated C strings.
    let result = unsafe {
        renameatx_np(
            directory_fd,
            staged.as_ptr(),
            directory_fd,
            destination.as_ptr(),
            RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(WorkspaceFilesError::io(
            "Aiden could not atomically exchange the staged and current files.",
            io::Error::last_os_error(),
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn atomic_replace(
    _parent: &VerifiedDirectory,
    _staged: &std::ffi::OsStr,
    _destination: &std::ffi::OsStr,
) -> Result<(), WorkspaceFilesError> {
    Err(WorkspaceFilesError::message(
        "Safe atomic workspace-file replacement is unavailable on this platform.",
    ))
}

#[cfg(target_os = "macos")]
fn hard_link_child(
    parent: &VerifiedDirectory,
    source: &std::ffi::OsStr,
    destination: &std::ffi::OsStr,
) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt as _;
    unsafe extern "C" {
        fn linkat(
            from_fd: c_int,
            from: *const c_char,
            to_fd: c_int,
            to: *const c_char,
            flags: c_int,
        ) -> c_int;
    }
    let source = CString::new(source.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source contains null"))?;
    let destination = CString::new(destination.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "destination contains null"))?;
    let fd = parent._file.as_raw_fd();
    // SAFETY: both C strings and the verified directory descriptor are valid for the call.
    let result = unsafe { linkat(fd, source.as_ptr(), fd, destination.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn hard_link_child(
    parent: &VerifiedDirectory,
    source: &std::ffi::OsStr,
    destination: &std::ffi::OsStr,
) -> io::Result<()> {
    fs::hard_link(
        parent.canonical_path.join(source),
        parent.canonical_path.join(destination),
    )
}

#[cfg(target_os = "macos")]
fn unlink_child(parent: &VerifiedDirectory, name: &std::ffi::OsStr) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt as _;
    unsafe extern "C" {
        fn unlinkat(fd: c_int, path: *const c_char, flags: c_int) -> c_int;
    }
    let name = CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains null"))?;
    // SAFETY: the C string and verified directory descriptor are valid for the call.
    let result = unsafe { unlinkat(parent._file.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn unlink_child(parent: &VerifiedDirectory, name: &std::ffi::OsStr) -> io::Result<()> {
    fs::remove_file(parent.canonical_path.join(name))
}

fn changed_on_disk(message: String) -> WorkspaceFilesError {
    WorkspaceFilesError::ChangedOnDisk(message)
}

fn portable_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

fn is_false(value: &bool) -> bool {
    !value
}

/// Human-readable file size used by workspace file surfaces.
pub fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, SeekFrom, Write};

    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt as _};

    fn recovery_files(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().contains("aiden-recovery"))
            .collect()
    }

    #[test]
    #[cfg(unix)]
    fn index_stays_in_workspace_and_skips_generated_directories() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join("src/index.ts"), "export {};\n").unwrap();
        fs::write(root.path().join("node_modules/ignored.js"), "ignored\n").unwrap();
        fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("escape.txt"),
        )
        .unwrap();

        let index = list_workspace_files(root.path()).unwrap();
        let escape = index
            .entries
            .iter()
            .find(|entry| entry.path == "escape.txt")
            .unwrap();

        assert_eq!(escape.kind, WorkspaceFileKind::Symlink);
        assert!(!index
            .entries
            .iter()
            .any(|entry| entry.path.contains("node_modules")));
        assert!(index
            .entries
            .iter()
            .any(|entry| entry.path == "src/index.ts"));
    }

    #[test]
    #[cfg(unix)]
    fn outside_symlink_cannot_be_read() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("escape.txt"),
        )
        .unwrap();

        let error = read_workspace_file(root.path(), "escape.txt").unwrap_err();

        assert!(error.to_string().contains("outside the workspace"));
    }

    #[test]
    #[cfg(unix)]
    fn swapped_directory_path_is_rejected_after_descriptor_enumeration() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("safe.txt"), "safe\n").unwrap();
        fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
        let canonical_root = canonical_root(root.path()).unwrap();
        let verified = open_verified_directory(&canonical_root, &nested).unwrap();
        fs::rename(&nested, root.path().join("moved")).unwrap();
        symlink(outside.path(), &nested).unwrap();

        let error = read_directory_children(
            &verified,
            MAX_INDEX_ENTRIES,
            &WorkspaceFileCancellation::default(),
        )
        .unwrap_err();

        assert_eq!(error.code(), WorkspaceFileErrorCode::ChangedOnDisk);
        assert!(!error.to_string().contains("secret.txt"));
    }

    #[test]
    fn index_does_not_starve_root_files_behind_a_large_directory() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join(".archive");
        fs::create_dir(&archive).unwrap();
        fs::create_dir(root.path().join(".build")).unwrap();
        fs::write(
            root.path().join(".build/ignored.swiftmodule"),
            "generated\n",
        )
        .unwrap();
        fs::write(root.path().join("package.json"), "{}\n").unwrap();
        for index in 0..4_100 {
            fs::write(archive.join(format!("entry-{index:04}.txt")), []).unwrap();
        }

        let index = list_workspace_files(root.path()).unwrap();

        assert!(index.truncated);
        assert_eq!(index.entries.len(), MAX_INDEX_ENTRIES);
        assert!(index
            .entries
            .iter()
            .any(|entry| entry.path == "package.json"));
        assert!(!index
            .entries
            .iter()
            .any(|entry| entry.path.starts_with(".build/")));
    }

    #[test]
    fn skipped_generated_directory_does_not_consume_the_root_entry_cap() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), "ignored\n").unwrap();
        for index in 0..MAX_INDEX_ENTRIES {
            fs::write(root.path().join(format!("file-{index:04}.txt")), []).unwrap();
        }

        let index = list_workspace_files(root.path()).unwrap();

        assert_eq!(index.entries.len(), MAX_INDEX_ENTRIES);
        assert!(!index.truncated);
        assert_eq!(index.skipped_directories, 1);
        assert!(!index.entries.iter().any(|entry| entry.path == ".git"));
    }

    #[test]
    fn queued_directory_at_the_entry_cap_marks_the_index_truncated() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("a")).unwrap();
        fs::write(root.path().join("a/queued.txt"), "queued\n").unwrap();
        for index in 0..(MAX_INDEX_ENTRIES - 1) {
            fs::write(root.path().join(format!("file-{index:04}.txt")), []).unwrap();
        }

        let index = list_workspace_files(root.path()).unwrap();

        assert_eq!(index.entries.len(), MAX_INDEX_ENTRIES);
        assert!(index.truncated);
        assert!(index.entries.iter().any(|entry| entry.path == "a"));
        assert!(!index
            .entries
            .iter()
            .any(|entry| entry.path == "a/queued.txt"));
    }

    #[test]
    fn editor_saves_only_the_version_that_was_opened() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        fs::write(&path, "first\n").unwrap();
        let opened = read_workspace_file(root.path(), "notes.txt").unwrap();

        let saved =
            write_workspace_file(root.path(), "notes.txt", "second\n", &opened.version).unwrap();
        fs::write(&path, "external\n").unwrap();
        let error =
            write_workspace_file(root.path(), "notes.txt", "stale\n", &saved.version).unwrap_err();

        assert_eq!(error.code(), WorkspaceFileErrorCode::ChangedOnDisk);
        assert_eq!(fs::read_to_string(path).unwrap(), "external\n");
    }

    #[test]
    fn successful_save_exposes_retained_original_for_startup_reconciliation() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("notes.txt"), "opened\n").unwrap();
        let opened = read_workspace_file(root.path(), "notes.txt").unwrap();

        write_workspace_file(root.path(), "notes.txt", "saved\n", &opened.version).unwrap();
        let artifacts = list_workspace_recovery_artifacts(root.path()).unwrap();

        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].kind, WorkspaceRecoveryKind::RetainedOriginal);
        assert_eq!(
            fs::read_to_string(root.path().join(&artifacts[0].path)).unwrap(),
            "opened\n"
        );
    }

    #[test]
    #[cfg(unix)]
    fn editor_preserves_permission_bits_across_replacement() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("shared.txt");
        fs::write(&path, "opened\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o664)).unwrap();
        let opened = read_workspace_file(root.path(), "shared.txt").unwrap();

        write_workspace_file_with_hooks(
            root.path(),
            "shared.txt",
            "saved\n",
            &opened.version,
            &WorkspaceFileCancellation::default(),
            &mut WriteHooks::default(),
        )
        .unwrap();

        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o7777,
            0o664
        );
    }

    #[test]
    fn editor_preserves_an_external_save_that_races_replacement() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        fs::write(&path, "opened\n").unwrap();
        let opened = read_workspace_file(root.path(), "notes.txt").unwrap();
        let mut race = || fs::write(&path, "external save\n");
        let mut hooks = WriteHooks {
            before_displace: Some(&mut race),
            ..WriteHooks::default()
        };

        let error = write_workspace_file_with_hooks(
            root.path(),
            "notes.txt",
            "aiden draft\n",
            &opened.version,
            &WorkspaceFileCancellation::default(),
            &mut hooks,
        )
        .unwrap_err();

        assert_eq!(error.code(), WorkspaceFileErrorCode::ChangedOnDisk);
        assert_eq!(fs::read_to_string(path).unwrap(), "external save\n");
        assert!(recovery_files(root.path()).is_empty());
    }

    #[test]
    fn editor_retains_an_inode_still_open_in_another_process() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        fs::write(&path, "opened\n").unwrap();
        let opened = read_workspace_file(root.path(), "notes.txt").unwrap();
        let mut external = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let saved = write_workspace_file_with_hooks(
            root.path(),
            "notes.txt",
            "aiden draft\n",
            &opened.version,
            &WorkspaceFileCancellation::default(),
            &mut WriteHooks::default(),
        )
        .unwrap();
        let recovery = recovery_files(root.path()).pop().unwrap();
        external.set_len(0).unwrap();
        external.seek(SeekFrom::Start(0)).unwrap();
        external.write_all(b"external descriptor write\n").unwrap();

        assert!(saved
            .warning
            .unwrap()
            .contains("retained the previous version"));
        assert_eq!(fs::read_to_string(path).unwrap(), "aiden draft\n");
        assert_eq!(
            fs::read_to_string(recovery).unwrap(),
            "external descriptor write\n"
        );
    }

    #[test]
    fn editor_retains_a_displaced_inode_modified_before_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        fs::write(&path, "opened\n").unwrap();
        let opened = read_workspace_file(root.path(), "notes.txt").unwrap();
        let external = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let mut external = Some(external);
        let mut mutate = |_recovery: &Path| {
            let mut file = external.take().unwrap();
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            file.write_all(b"external closed write\n")
        };
        let mut hooks = WriteHooks {
            before_recovery_cleanup: Some(&mut mutate),
            ..WriteHooks::default()
        };

        let saved = write_workspace_file_with_hooks(
            root.path(),
            "notes.txt",
            "aiden draft\n",
            &opened.version,
            &WorkspaceFileCancellation::default(),
            &mut hooks,
        )
        .unwrap();
        let recovery = recovery_files(root.path()).pop().unwrap();

        assert!(saved
            .warning
            .unwrap()
            .contains("wrote to the previous file"));
        assert_eq!(
            fs::read_to_string(recovery).unwrap(),
            "external closed write\n"
        );
    }

    #[test]
    fn editor_rejects_parent_traversal() {
        let root = tempfile::tempdir().unwrap();

        let error = read_workspace_file(root.path(), "../outside.txt").unwrap_err();

        assert!(error.to_string().contains("outside the workspace"));
    }

    #[test]
    fn editor_rejects_binary_files() {
        let root = tempfile::tempdir().unwrap();
        let mut binary = vec![b'a'; 9_000];
        binary.push(0);
        fs::write(root.path().join("binary.dat"), binary).unwrap();

        let error = read_workspace_file(root.path(), "binary.dat").unwrap_err();

        assert!(error.to_string().contains("binary"));
    }

    #[test]
    fn cancelled_index_stops_before_traversal() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("file.txt"), "text\n").unwrap();
        let cancellation = WorkspaceFileCancellation::default();
        cancellation.cancel();

        let error = list_workspace_files_cancellable(root.path(), &cancellation).unwrap_err();

        assert!(error.to_string().contains("cancelled"));
    }

    #[test]
    fn pre_exchange_failure_keeps_original_and_cleans_staged_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        fs::write(&path, "opened\n").unwrap();
        let opened = read_workspace_file(root.path(), "notes.txt").unwrap();
        let mut fail = || Err(io::Error::other("injected stop"));
        let mut hooks = WriteHooks {
            before_exchange: Some(&mut fail),
            ..WriteHooks::default()
        };

        let error = write_workspace_file_with_hooks(
            root.path(),
            "notes.txt",
            "draft\n",
            &opened.version,
            &WorkspaceFileCancellation::default(),
            &mut hooks,
        )
        .unwrap_err();
        let artifacts: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".aiden-") || name.contains("aiden-recovery"))
            .collect();

        assert_eq!(error.code(), WorkspaceFileErrorCode::IoError);
        assert_eq!(fs::read_to_string(path).unwrap(), "opened\n");
        assert!(artifacts.is_empty());
    }

    #[test]
    fn replaced_displaced_name_is_never_swapped_back_into_destination() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        fs::write(&path, "opened\n").unwrap();
        let opened = read_workspace_file(root.path(), "notes.txt").unwrap();
        let mut replace = |temporary: &Path| {
            fs::remove_file(temporary)?;
            fs::write(temporary, "unrelated replacement\n")
        };
        let mut hooks = WriteHooks {
            after_exchange: Some(&mut replace),
            ..WriteHooks::default()
        };

        let error = write_workspace_file_with_hooks(
            root.path(),
            "notes.txt",
            "draft\n",
            &opened.version,
            &WorkspaceFileCancellation::default(),
            &mut hooks,
        )
        .unwrap_err();

        assert_eq!(error.code(), WorkspaceFileErrorCode::ChangedOnDisk);
        assert_eq!(fs::read_to_string(path).unwrap(), "draft\n");
        assert!(fs::read_dir(root.path()).unwrap().any(|entry| {
            entry.is_ok_and(|entry| {
                fs::read_to_string(entry.path()).is_ok_and(|text| text == "unrelated replacement\n")
            })
        }));
    }

    #[test]
    fn changed_installed_content_is_preserved_without_pathname_rollback() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        fs::write(&path, "opened\n").unwrap();
        let opened = read_workspace_file(root.path(), "notes.txt").unwrap();
        let mut replace_destination =
            |_temporary: &Path| fs::write(&path, "attacker destination\n");
        let mut hooks = WriteHooks {
            after_exchange: Some(&mut replace_destination),
            ..WriteHooks::default()
        };

        let error = write_workspace_file_with_hooks(
            root.path(),
            "notes.txt",
            "draft\n",
            &opened.version,
            &WorkspaceFileCancellation::default(),
            &mut hooks,
        )
        .unwrap_err();

        assert_eq!(error.code(), WorkspaceFileErrorCode::ChangedOnDisk);
        assert!(error.to_string().contains("outcome is unknown"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "attacker destination\n");
        assert!(fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.path() != path
                && fs::read_to_string(entry.path()).is_ok_and(|text| text == "opened\n")));
    }

    #[test]
    #[cfg(unix)]
    fn editor_revalidates_concurrent_mode_changes_before_staging() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("script.sh");
        fs::write(&path, "echo opened\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let opened = read_workspace_file(root.path(), "script.sh").unwrap();
        let mut change_mode = || fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
        let mut hooks = WriteHooks {
            before_displace: Some(&mut change_mode),
            ..WriteHooks::default()
        };

        write_workspace_file_with_hooks(
            root.path(),
            "script.sh",
            "echo saved\n",
            &opened.version,
            &WorkspaceFileCancellation::default(),
            &mut hooks,
        )
        .unwrap();

        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o7777,
            0o755
        );
    }

    #[test]
    fn editor_rejects_invalid_utf8() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("invalid.txt"), [0xff, 0xfe]).unwrap();

        let error = read_workspace_file(root.path(), "invalid.txt").unwrap_err();

        assert!(error.to_string().contains("not valid UTF-8"));
    }

    #[test]
    fn editor_rejects_documents_beyond_the_line_limit() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("long.txt"),
            "line\n".repeat(MAX_EDITOR_LINES),
        )
        .unwrap();

        let error = read_workspace_file(root.path(), "long.txt").unwrap_err();

        assert!(error.to_string().contains("too many lines"));
    }

    #[test]
    fn editor_rejects_documents_beyond_the_byte_limit() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("large.txt"),
            vec![b'a'; MAX_EDITOR_BYTES + 1],
        )
        .unwrap();

        let error = read_workspace_file(root.path(), "large.txt").unwrap_err();

        assert!(error.to_string().contains("too large"));
    }

    #[test]
    fn index_stops_descending_after_depth_twenty() {
        let root = tempfile::tempdir().unwrap();
        let mut directory = root.path().to_path_buf();
        for depth in 0..=MAX_INDEX_DEPTH + 1 {
            directory.push(format!("depth-{depth}"));
            fs::create_dir(&directory).unwrap();
        }
        fs::write(directory.join("hidden.txt"), []).unwrap();

        let index = list_workspace_files(root.path()).unwrap();

        assert!(index.truncated);
        assert!(index
            .entries
            .iter()
            .all(|entry| entry.depth <= MAX_INDEX_DEPTH));
        assert!(!index
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("hidden.txt")));
    }

    #[test]
    fn index_orders_directories_and_numeric_names_deterministically() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("file10.txt"), []).unwrap();
        fs::write(root.path().join("file2.txt"), []).unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/lib.rs"), []).unwrap();

        let index = list_workspace_files(root.path()).unwrap();
        let paths: Vec<_> = index
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();

        assert_eq!(paths, ["src", "src/lib.rs", "file2.txt", "file10.txt"]);
    }

    #[test]
    fn format_size_uses_human_readable_binary_units() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(2_048), "2.0 KB");
        assert_eq!(format_size(1_048_576), "1.0 MB");
    }
}
