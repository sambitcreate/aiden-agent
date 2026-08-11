//! Agent Skill discovery across Aiden, Agents, and Claude skill folders.
//!
//! Discovery is synchronous so callers can place it on their existing
//! background executor. Unreadable roots, entries, and files are skipped;
//! resolving Aiden's configured portable directory remains an explicit error.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Seek as _, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use thiserror::Error;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::fs::OpenOptions;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::fd::{AsRawFd as _, FromRawFd as _, IntoRawFd as _};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt as _;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::fs::OpenOptionsExt as _;

use crate::config_dir::{aiden_config_dir, home_dir, ConfigDirError, AIDEN_DIR_NAME};
use crate::portable_config::{MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_NAME_LENGTH};

const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(5);
const DISCOVERY_CACHE_LIMIT: usize = 50;
const MAX_SCAN_DEPTH: usize = 20;
const MAX_VISITED_ENTRIES: usize = 10_000;
const MAX_DISCOVERED_SKILLS: usize = 1_000;
const MAX_SKILL_BYTES: usize = 1024 * 1024;
const MAX_DISCOVERY_SCAN_BYTES: usize = 32 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_SUPPORTING_FILE_BYTES: usize = 1024 * 1024;
pub const MAX_SUPPORTING_FILE_ENTRIES: usize = 1_000;
pub const MAX_SUPPORTING_FILE_SAMPLE: usize = 10;

#[cfg(target_os = "macos")]
const O_NOFOLLOW: i32 = 0x0000_0100;
#[cfg(target_os = "macos")]
const O_DIRECTORY: i32 = 0x0010_0000;
#[cfg(target_os = "macos")]
const O_CLOEXEC: i32 = 0x0100_0000;
#[cfg(target_os = "macos")]
const O_NONBLOCK: i32 = 0x0000_0004;
#[cfg(target_os = "linux")]
const O_NOFOLLOW: i32 = 0x0002_0000;
#[cfg(target_os = "linux")]
const O_DIRECTORY: i32 = 0x0001_0000;
#[cfg(target_os = "linux")]
const O_CLOEXEC: i32 = 0x0008_0000;
#[cfg(target_os = "linux")]
const O_NONBLOCK: i32 = 0x0000_0800;

static DISCOVERY_CACHE: LazyLock<Mutex<DiscoveryCache>> =
    LazyLock::new(|| Mutex::new(DiscoveryCache::default()));

/// Whether a filesystem skill came from the active workspace or user profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiscoveredSkillSource {
    Global,
    Workspace,
}

impl DiscoveredSkillSource {
    fn id_prefix(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Workspace => "workspace",
        }
    }
}

/// One read-only `SKILL.md` discovered on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    /// Stable source-qualified absolute path identifier.
    pub id: String,
    pub name: String,
    pub description: String,
    /// The Markdown body loaded when the skill is invoked.
    pub instructions: String,
    pub source: DiscoveredSkillSource,
    /// Absolute path beneath the canonical allowed root at scan time.
    pub path: PathBuf,
    /// Discovery-time identity checked before every supporting-file access.
    pub version: SkillFileVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileVersion {
    pub device: u64,
    pub inode: u64,
    pub byte_length: u64,
    pub sha256: String,
}

/// Failure to resolve the configured global skill root.
#[derive(Debug, Error)]
pub enum SkillsDiscoveryError {
    #[error(transparent)]
    ConfigDirectory(#[from] ConfigDirError),
    #[error("skill discovery was cancelled")]
    Cancelled,
}

/// A supporting-file request was invalid, escaped the authorized skill root,
/// or could not be read within the runtime bounds.
#[derive(Debug, Error)]
pub enum SkillSupportingFileError {
    #[error("the skill path is outside its authorized root")]
    UnauthorizedSkill,
    #[error("supporting-file paths must be non-empty relative paths without parent components")]
    InvalidPath,
    #[error("the supporting file is not a regular UTF-8 file within the size limit")]
    InvalidFile,
    #[error("the skill changed after discovery; retry with a fresh skill registry")]
    Changed,
    #[error("the skill operation was cancelled")]
    Cancelled,
    #[error("supporting-file access is not supported on this platform")]
    Unsupported,
    #[error("supporting-file I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error(transparent)]
    ConfigDirectory(#[from] ConfigDirError),
}

/// List a deterministic bounded sample of regular files bundled beside a
/// discovered skill. Returned paths are relative to the skill directory.
/// Every component is reopened descriptor-relatively with symlinks rejected.
pub fn list_skill_supporting_files(
    skill: &DiscoveredSkill,
    workspace_root: Option<&Path>,
) -> Result<Vec<PathBuf>, SkillSupportingFileError> {
    list_skill_supporting_files_cancellable(skill, workspace_root, &AtomicBool::new(false))
}

pub fn list_skill_supporting_files_cancellable(
    skill: &DiscoveredSkill,
    workspace_root: Option<&Path>,
    cancel: &AtomicBool,
) -> Result<Vec<PathBuf>, SkillSupportingFileError> {
    check_support_cancel(cancel)?;
    let directory = reopen_authorized_skill_directory(skill, workspace_root, cancel)?;
    let mut budget = ScanBudget {
        visited_limit: MAX_SUPPORTING_FILE_ENTRIES,
        accepted_limit: MAX_SUPPORTING_FILE_SAMPLE,
        ..ScanBudget::default()
    };
    let mut files = Vec::new();
    collect_supporting_files(&directory, Path::new(""), &mut budget, &mut files, cancel)?;
    files.sort();
    files.truncate(MAX_SUPPORTING_FILE_SAMPLE);
    Ok(files)
}

/// Read one UTF-8 supporting file relative to a discovered skill directory.
/// Absolute paths, parent traversal, directories, symlinks, special files,
/// and files over one MiB are rejected.
pub fn read_skill_supporting_file(
    skill: &DiscoveredSkill,
    workspace_root: Option<&Path>,
    relative_path: &Path,
) -> Result<String, SkillSupportingFileError> {
    read_skill_supporting_file_cancellable(
        skill,
        workspace_root,
        relative_path,
        &AtomicBool::new(false),
    )
}

pub fn read_skill_supporting_file_cancellable(
    skill: &DiscoveredSkill,
    workspace_root: Option<&Path>,
    relative_path: &Path,
    cancel: &AtomicBool,
) -> Result<String, SkillSupportingFileError> {
    check_support_cancel(cancel)?;
    let components = validated_relative_components(relative_path)?;
    if components.last().is_some_and(|name| name == "SKILL.md") {
        return Err(SkillSupportingFileError::InvalidPath);
    }
    let mut directory = reopen_authorized_skill_directory(skill, workspace_root, cancel)?;
    for component in &components[..components.len() - 1] {
        check_support_cancel(cancel)?;
        directory = directory
            .open_directory(component)
            .map_err(|_| SkillSupportingFileError::InvalidFile)?;
    }
    let mut file = open_child_file_no_follow(&directory.file, &components[components.len() - 1])
        .map_err(|_| SkillSupportingFileError::InvalidFile)?;
    let metadata = file
        .metadata()
        .map_err(|_| SkillSupportingFileError::InvalidFile)?;
    if !metadata.is_file() || metadata.len() > MAX_SUPPORTING_FILE_BYTES as u64 {
        return Err(SkillSupportingFileError::InvalidFile);
    }
    let bytes = read_supporting_file_stably(&mut file, &metadata, cancel, || {})?;
    if bytes.contains(&0) {
        return Err(SkillSupportingFileError::InvalidFile);
    }
    let _ = reopen_authorized_skill_directory(skill, workspace_root, cancel)?;
    String::from_utf8(bytes).map_err(|_| SkillSupportingFileError::InvalidFile)
}

/// Discover global skills and optional active-workspace skills.
///
/// Results are cached for five seconds by global roots and workspace root.
/// Workspace skills override global skills with the same case-insensitive name.
/// Individual filesystem failures are skipped so one damaged skill cannot hide
/// the remaining catalog.
///
/// # Errors
///
/// Returns [`SkillsDiscoveryError`] when `AIDEN_CONFIG_DIR` is invalid.
pub fn discover_skills(
    workspace_root: Option<&Path>,
) -> Result<Vec<DiscoveredSkill>, SkillsDiscoveryError> {
    discover_skills_cancellable(workspace_root, &AtomicBool::new(false))
}

pub fn discover_skills_cancellable(
    workspace_root: Option<&Path>,
    cancel: &AtomicBool,
) -> Result<Vec<DiscoveredSkill>, SkillsDiscoveryError> {
    let home = home_dir();
    let aiden_dir = aiden_config_dir()?;
    discover_skills_cached_cancellable(workspace_root, &home, &aiden_dir, Instant::now(), cancel)
}

pub fn discover_skills_fresh_cancellable(
    workspace_root: Option<&Path>,
    cancel: &AtomicBool,
) -> Result<Vec<DiscoveredSkill>, SkillsDiscoveryError> {
    let home = home_dir();
    let aiden_dir = aiden_config_dir()?;
    scan_all_skills(workspace_root, &home, &aiden_dir, cancel)
}

pub fn invalidate_skills_discovery_cache(workspace_root: Option<&Path>) {
    let Ok(aiden_dir) = aiden_config_dir() else {
        return;
    };
    let key = DiscoveryCacheKey {
        home: absolute_lexical(&home_dir()),
        aiden_dir: absolute_lexical(&aiden_dir),
        workspace_root: workspace_root.map(absolute_lexical),
    };
    DISCOVERY_CACHE.lock().entries.remove(&key);
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DiscoveryCacheKey {
    home: PathBuf,
    aiden_dir: PathBuf,
    workspace_root: Option<PathBuf>,
}

struct DiscoveryCacheEntry {
    state: Mutex<DiscoveryCacheState>,
    ready: Condvar,
}

enum DiscoveryCacheState {
    Scanning,
    Retry,
    Ready {
        expires_at: Instant,
        skills: Vec<DiscoveredSkill>,
        roots: DiscoveryRootIdentity,
    },
}

/// Identity of the roots used to produce a cached catalog. Paths are not
/// enough here: a workspace can be removed and recreated at the same path
/// while an older five-second catalog is still live.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct DiscoveryRootIdentity {
    home: RootIdentity,
    aiden_dir: RootIdentity,
    workspace_root: Option<RootIdentity>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct RootIdentity {
    present: bool,
    directory: bool,
    device: u64,
    inode: u64,
}

impl DiscoveryRootIdentity {
    fn for_key(key: &DiscoveryCacheKey) -> Self {
        Self {
            home: root_identity(&key.home),
            aiden_dir: root_identity(&key.aiden_dir),
            workspace_root: key.workspace_root.as_deref().map(root_identity),
        }
    }
}

fn root_identity(path: &Path) -> RootIdentity {
    let Ok(metadata) = fs::metadata(path) else {
        return RootIdentity {
            present: false,
            directory: false,
            device: 0,
            inode: 0,
        };
    };

    #[cfg(unix)]
    let (device, inode) = (metadata.dev(), metadata.ino());
    #[cfg(not(unix))]
    let (device, inode) = (0, 0);

    RootIdentity {
        present: true,
        directory: metadata.is_dir(),
        device,
        inode,
    }
}

#[derive(Default)]
struct DiscoveryCache {
    entries: HashMap<DiscoveryCacheKey, Arc<DiscoveryCacheEntry>>,
}

impl DiscoveryCache {
    fn reserve(&mut self, key: DiscoveryCacheKey) -> (Arc<DiscoveryCacheEntry>, bool) {
        if let Some(entry) = self.entries.get(&key) {
            return (Arc::clone(entry), false);
        }
        if self.entries.len() >= DISCOVERY_CACHE_LIMIT {
            // Never evict an active scan: waiters retain an Arc to that entry,
            // and clearing it here would allow a second scan for the same key
            // while the first one is still publishing. If every entry is
            // active, tolerate the bounded in-flight overflow and evict a
            // completed entry on the next reservation.
            let evict_key = self.entries.iter().find_map(|(entry_key, entry)| {
                let state = entry.state.try_lock()?;
                (!matches!(*state, DiscoveryCacheState::Scanning)).then(|| entry_key.clone())
            });
            if let Some(evict_key) = evict_key {
                self.entries.remove(&evict_key);
            }
        }
        let entry = Arc::new(DiscoveryCacheEntry {
            state: Mutex::new(DiscoveryCacheState::Scanning),
            ready: Condvar::new(),
        });
        self.entries.insert(key, Arc::clone(&entry));
        (entry, true)
    }
}

#[cfg(test)]
fn discover_skills_cached(
    workspace_root: Option<&Path>,
    home: &Path,
    aiden_dir: &Path,
    now: Instant,
) -> Vec<DiscoveredSkill> {
    discover_skills_cached_cancellable(
        workspace_root,
        home,
        aiden_dir,
        now,
        &AtomicBool::new(false),
    )
    .unwrap_or_default()
}

fn discover_skills_cached_cancellable(
    workspace_root: Option<&Path>,
    home: &Path,
    aiden_dir: &Path,
    now: Instant,
    cancel: &AtomicBool,
) -> Result<Vec<DiscoveredSkill>, SkillsDiscoveryError> {
    let key = DiscoveryCacheKey {
        home: absolute_lexical(home),
        aiden_dir: absolute_lexical(aiden_dir),
        workspace_root: workspace_root.map(absolute_lexical),
    };
    discover_skills_cached_with_cancel(key, now, cancel, || {
        scan_all_skills(workspace_root, home, aiden_dir, cancel)
    })
}

fn discover_skills_cached_with_cancel(
    key: DiscoveryCacheKey,
    now: Instant,
    cancel: &AtomicBool,
    scan: impl FnOnce() -> Result<Vec<DiscoveredSkill>, SkillsDiscoveryError>,
) -> Result<Vec<DiscoveredSkill>, SkillsDiscoveryError> {
    check_discovery_cancel(cancel)?;
    let roots = DiscoveryRootIdentity::for_key(&key);
    let (entry, mut owns_scan) = DISCOVERY_CACHE.lock().reserve(key.clone());
    if !owns_scan {
        let mut state = entry.state.lock();
        loop {
            check_discovery_cancel(cancel)?;
            match &*state {
                DiscoveryCacheState::Ready {
                    expires_at,
                    skills,
                    roots: cached_roots,
                } if *expires_at > now && *cached_roots == roots => {
                    return Ok(skills.clone());
                }
                DiscoveryCacheState::Ready { .. } | DiscoveryCacheState::Retry => {
                    *state = DiscoveryCacheState::Scanning;
                    owns_scan = true;
                    break;
                }
                DiscoveryCacheState::Scanning => {
                    entry.ready.wait_for(&mut state, Duration::from_millis(10));
                }
            }
        }
    }
    debug_assert!(owns_scan);
    let skills = match scan() {
        Ok(skills) => skills,
        Err(error) => return fail_cached_scan(&key, &entry, error),
    };
    if let Err(error) = check_discovery_cancel(cancel) {
        return fail_cached_scan(&key, &entry, error);
    }
    *entry.state.lock() = DiscoveryCacheState::Ready {
        expires_at: now + DISCOVERY_CACHE_TTL,
        skills: skills.clone(),
        roots,
    };
    entry.ready.notify_all();
    Ok(skills)
}

fn fail_cached_scan(
    key: &DiscoveryCacheKey,
    entry: &Arc<DiscoveryCacheEntry>,
    error: SkillsDiscoveryError,
) -> Result<Vec<DiscoveredSkill>, SkillsDiscoveryError> {
    *entry.state.lock() = DiscoveryCacheState::Retry;
    entry.ready.notify_all();
    let mut cache = DISCOVERY_CACHE.lock();
    if cache
        .entries
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, entry))
    {
        cache.entries.remove(key);
    }
    Err(error)
}

#[cfg(test)]
fn discover_skills_cached_with(
    key: DiscoveryCacheKey,
    now: Instant,
    scan: impl FnOnce() -> Vec<DiscoveredSkill>,
) -> Vec<DiscoveredSkill> {
    let roots = DiscoveryRootIdentity::for_key(&key);
    let (entry, mut owns_scan) = DISCOVERY_CACHE.lock().reserve(key);
    if !owns_scan {
        let mut state = entry.state.lock();
        loop {
            match &*state {
                DiscoveryCacheState::Ready {
                    expires_at,
                    skills,
                    roots: cached_roots,
                } if *expires_at > now && *cached_roots == roots => {
                    return skills.clone();
                }
                DiscoveryCacheState::Ready { .. } | DiscoveryCacheState::Retry => {
                    *state = DiscoveryCacheState::Scanning;
                    owns_scan = true;
                    break;
                }
                DiscoveryCacheState::Scanning => entry.ready.wait(&mut state),
            }
        }
    }
    debug_assert!(owns_scan);
    let skills = scan();
    *entry.state.lock() = DiscoveryCacheState::Ready {
        expires_at: now + DISCOVERY_CACHE_TTL,
        skills: skills.clone(),
        roots,
    };
    entry.ready.notify_all();
    skills
}

#[derive(Debug, Clone, Copy)]
enum ScanLayout {
    LegacyChildren,
    Recursive(&'static str),
}

struct ScanRoot {
    anchor: PathBuf,
    relative_root: Option<&'static str>,
    layouts: &'static [ScanLayout],
    source: DiscoveredSkillSource,
}

const AGENTS_LAYOUTS: &[ScanLayout] =
    &[ScanLayout::LegacyChildren, ScanLayout::Recursive("skills")];
const CLAUDE_LAYOUTS: &[ScanLayout] = &[ScanLayout::Recursive("skills")];
const AIDEN_LAYOUTS: &[ScanLayout] = &[
    ScanLayout::Recursive("skill"),
    ScanLayout::Recursive("skills"),
];

fn scan_all_skills(
    workspace_root: Option<&Path>,
    home: &Path,
    aiden_dir: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<DiscoveredSkill>, SkillsDiscoveryError> {
    check_discovery_cancel(cancel)?;
    let mut roots = vec![
        ScanRoot {
            anchor: home.to_path_buf(),
            relative_root: Some(".agents"),
            layouts: AGENTS_LAYOUTS,
            source: DiscoveredSkillSource::Global,
        },
        ScanRoot {
            anchor: home.to_path_buf(),
            relative_root: Some(".claude"),
            layouts: CLAUDE_LAYOUTS,
            source: DiscoveredSkillSource::Global,
        },
        ScanRoot {
            anchor: aiden_dir.to_path_buf(),
            relative_root: None,
            layouts: AIDEN_LAYOUTS,
            source: DiscoveredSkillSource::Global,
        },
    ];
    if let Some(workspace_root) = workspace_root {
        roots.extend([
            ScanRoot {
                anchor: workspace_root.to_path_buf(),
                relative_root: Some(".agents"),
                layouts: AGENTS_LAYOUTS,
                source: DiscoveredSkillSource::Workspace,
            },
            ScanRoot {
                anchor: workspace_root.to_path_buf(),
                relative_root: Some(".claude"),
                layouts: CLAUDE_LAYOUTS,
                source: DiscoveredSkillSource::Workspace,
            },
            ScanRoot {
                anchor: workspace_root.to_path_buf(),
                relative_root: Some(AIDEN_DIR_NAME),
                layouts: AIDEN_LAYOUTS,
                source: DiscoveredSkillSource::Workspace,
            },
        ]);
    }

    let mut by_name = BTreeMap::<String, DiscoveredSkill>::new();
    let mut seen_paths = BTreeSet::new();
    let mut budget = ScanBudget::default();
    // Higher-precedence roots are scanned first so bounded discovery never lets
    // a large global tree starve workspace or Aiden-native overrides.
    for root in roots.iter().rev() {
        check_discovery_cancel(cancel)?;
        for skill in scan_root(root, &mut budget, &mut seen_paths, cancel) {
            by_name.entry(skill.name.to_lowercase()).or_insert(skill);
        }
        check_discovery_cancel(cancel)?;
        if budget.is_exhausted() {
            break;
        }
    }
    check_discovery_cancel(cancel)?;
    let mut skills = by_name.into_values().collect::<Vec<_>>();
    skills.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });
    check_discovery_cancel(cancel)?;
    Ok(skills)
}

struct ScanBudget {
    visited: usize,
    accepted: usize,
    visited_limit: usize,
    accepted_limit: usize,
    scanned_bytes: usize,
    byte_limit: usize,
}

impl Default for ScanBudget {
    fn default() -> Self {
        Self {
            visited: 0,
            accepted: 0,
            visited_limit: MAX_VISITED_ENTRIES,
            accepted_limit: MAX_DISCOVERED_SKILLS,
            scanned_bytes: 0,
            byte_limit: MAX_DISCOVERY_SCAN_BYTES,
        }
    }
}

impl ScanBudget {
    fn visit(&mut self) -> bool {
        if self.visited >= self.visited_limit {
            return false;
        }
        self.visited += 1;
        true
    }

    fn accept(&mut self) -> bool {
        if self.accepted >= self.accepted_limit {
            return false;
        }
        self.accepted += 1;
        true
    }

    fn charge_bytes(&mut self, bytes: usize) -> bool {
        let Some(next) = self.scanned_bytes.checked_add(bytes) else {
            return false;
        };
        if next > self.byte_limit {
            return false;
        }
        self.scanned_bytes = next;
        true
    }

    fn is_exhausted(&self) -> bool {
        self.visited >= self.visited_limit
            || self.accepted >= self.accepted_limit
            || self.scanned_bytes >= self.byte_limit
    }
}

struct SecureDirectory {
    file: File,
    display_path: PathBuf,
    depth: usize,
}

impl SecureDirectory {
    fn open_anchor(path: &Path) -> io::Result<Self> {
        let canonical = fs::canonicalize(path)?;
        let expected = fs::metadata(&canonical)?;
        let file = open_absolute_directory_no_follow(&canonical)?;
        if !same_file(&expected, &file.metadata()?) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "skill root changed while it was opened",
            ));
        }
        Ok(Self {
            file,
            display_path: canonical,
            depth: 0,
        })
    }

    fn open_directory(&self, name: &OsStr) -> io::Result<Self> {
        let file = open_child_directory_no_follow(&self.file, name)?;
        Ok(Self {
            file,
            display_path: self.display_path.join(name),
            depth: self.depth + 1,
        })
    }

    fn open_skill(&self) -> io::Result<File> {
        open_child_file_no_follow(&self.file, OsStr::new("SKILL.md"))
    }
}

fn authorized_skill_roots(
    source: DiscoveredSkillSource,
    workspace_root: Option<&Path>,
) -> Result<Vec<PathBuf>, SkillSupportingFileError> {
    let roots = match source {
        DiscoveredSkillSource::Global => {
            let home = home_dir();
            let aiden = aiden_config_dir()?;
            vec![home.join(".agents"), home.join(".claude"), aiden]
        }
        DiscoveredSkillSource::Workspace => {
            let workspace = workspace_root.ok_or(SkillSupportingFileError::UnauthorizedSkill)?;
            vec![
                workspace.join(".agents"),
                workspace.join(".claude"),
                workspace.join(AIDEN_DIR_NAME),
            ]
        }
    };
    Ok(roots)
}

fn reopen_authorized_skill_directory(
    skill: &DiscoveredSkill,
    workspace_root: Option<&Path>,
    cancel: &AtomicBool,
) -> Result<SecureDirectory, SkillSupportingFileError> {
    check_support_cancel(cancel)?;
    let skill_path = absolute_lexical(&skill.path);
    if skill_path.file_name() != Some(OsStr::new("SKILL.md")) {
        return Err(SkillSupportingFileError::UnauthorizedSkill);
    }
    let skill_directory = skill_path
        .parent()
        .ok_or(SkillSupportingFileError::UnauthorizedSkill)?;
    for root_path in authorized_skill_roots(skill.source, workspace_root)? {
        check_support_cancel(cancel)?;
        let Ok(root) = SecureDirectory::open_anchor(&root_path) else {
            continue;
        };
        let Ok(relative) = skill_directory.strip_prefix(&root.display_path) else {
            continue;
        };
        let Ok(components) = validated_relative_components(relative) else {
            continue;
        };
        let mut directory = root;
        let mut valid = true;
        for component in components {
            check_support_cancel(cancel)?;
            match directory.open_directory(&component) {
                Ok(child) => directory = child,
                Err(_) => {
                    valid = false;
                    break;
                }
            }
        }
        if valid {
            verify_skill_version(&directory, skill, cancel)?;
            return Ok(directory);
        }
    }
    Err(SkillSupportingFileError::UnauthorizedSkill)
}

fn validated_relative_components(path: &Path) -> Result<Vec<OsString>, SkillSupportingFileError> {
    if path.as_os_str().is_empty() || path.is_absolute() || path_encoded_len(path) > 1024 {
        return Err(SkillSupportingFileError::InvalidPath);
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) if !name.is_empty() && !os_string_contains_nul(name) => {
                components.push(name.to_os_string());
            }
            _ => return Err(SkillSupportingFileError::InvalidPath),
        }
    }
    if components.is_empty() || components.len() > MAX_SCAN_DEPTH {
        return Err(SkillSupportingFileError::InvalidPath);
    }
    Ok(components)
}

#[cfg(unix)]
fn path_encoded_len(path: &Path) -> usize {
    path.as_os_str().as_bytes().len()
}

#[cfg(not(unix))]
fn path_encoded_len(path: &Path) -> usize {
    path.to_string_lossy().len()
}

#[cfg(unix)]
fn os_string_contains_nul(value: &OsStr) -> bool {
    value.as_bytes().contains(&0)
}

#[cfg(not(unix))]
fn os_string_contains_nul(value: &OsStr) -> bool {
    value.to_string_lossy().contains('\0')
}

fn verify_skill_version(
    directory: &SecureDirectory,
    skill: &DiscoveredSkill,
    cancel: &AtomicBool,
) -> Result<(), SkillSupportingFileError> {
    check_support_cancel(cancel)?;
    if skill.version.byte_length > MAX_SKILL_BYTES as u64 {
        return Err(SkillSupportingFileError::Changed);
    }
    let mut file = directory
        .open_skill()
        .map_err(|_| SkillSupportingFileError::Changed)?;
    let metadata = file
        .metadata()
        .map_err(|_| SkillSupportingFileError::Changed)?;
    if !metadata.is_file() || metadata.len() != skill.version.byte_length {
        return Err(SkillSupportingFileError::Changed);
    }
    #[cfg(unix)]
    if metadata.dev() != skill.version.device || metadata.ino() != skill.version.inode {
        return Err(SkillSupportingFileError::Changed);
    }
    let bytes = read_supporting_file_stably(&mut file, &metadata, cancel, || {})?;
    if bytes.len() > MAX_SKILL_BYTES || bytes.len() as u64 != skill.version.byte_length {
        return Err(SkillSupportingFileError::Changed);
    }
    let digest =
        sha256_hex_cancellable(&bytes, cancel).ok_or(SkillSupportingFileError::Cancelled)?;
    if digest != skill.version.sha256 {
        return Err(SkillSupportingFileError::Changed);
    }
    Ok(())
}

fn collect_supporting_files(
    directory: &SecureDirectory,
    relative: &Path,
    budget: &mut ScanBudget,
    files: &mut Vec<PathBuf>,
    cancel: &AtomicBool,
) -> Result<(), SkillSupportingFileError> {
    check_support_cancel(cancel)?;
    if budget.visited >= MAX_SUPPORTING_FILE_ENTRIES
        || files.len() >= MAX_SUPPORTING_FILE_SAMPLE
        || relative.components().count() >= MAX_SCAN_DEPTH
    {
        return Ok(());
    }
    let mut names = read_directory_names(&directory.file, budget, cancel)?;
    names.sort();
    for name in names {
        check_support_cancel(cancel)?;
        if budget.visited >= MAX_SUPPORTING_FILE_ENTRIES
            || files.len() >= MAX_SUPPORTING_FILE_SAMPLE
        {
            break;
        }
        if name == "SKILL.md" {
            continue;
        }
        let child_relative = relative.join(&name);
        if let Ok(child) = directory.open_directory(&name) {
            collect_supporting_files(&child, &child_relative, budget, files, cancel)?;
            continue;
        }
        let Ok(file) = open_child_file_no_follow(&directory.file, &name) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        if metadata.is_file() && metadata.len() <= MAX_SUPPORTING_FILE_BYTES as u64 {
            files.push(child_relative);
        }
    }
    Ok(())
}

fn scan_root(
    config: &ScanRoot,
    budget: &mut ScanBudget,
    seen_paths: &mut BTreeSet<PathBuf>,
    cancel: &AtomicBool,
) -> Vec<DiscoveredSkill> {
    if cancel.load(Ordering::Relaxed) {
        return Vec::new();
    }
    let Ok(anchor) = SecureDirectory::open_anchor(&config.anchor) else {
        return Vec::new();
    };
    let mut root = if let Some(relative_root) = config.relative_root {
        let Ok(root) = anchor.open_directory(OsStr::new(relative_root)) else {
            return Vec::new();
        };
        root
    } else {
        anchor
    };
    root.depth = 0;
    let mut skills = Vec::new();
    for layout in config.layouts.iter().rev() {
        if budget.is_exhausted() {
            break;
        }
        match layout {
            ScanLayout::LegacyChildren => collect_legacy_children(
                &root,
                config.source,
                budget,
                seen_paths,
                &mut skills,
                cancel,
            ),
            ScanLayout::Recursive(directory) => {
                if let Ok(directory) = root.open_directory(OsStr::new(directory)) {
                    collect_recursive(
                        directory,
                        config.source,
                        budget,
                        seen_paths,
                        &mut skills,
                        cancel,
                    );
                }
            }
        }
    }
    skills
}

fn collect_legacy_children(
    root: &SecureDirectory,
    source: DiscoveredSkillSource,
    budget: &mut ScanBudget,
    seen_paths: &mut BTreeSet<PathBuf>,
    output: &mut Vec<DiscoveredSkill>,
    cancel: &AtomicBool,
) {
    let Ok(mut names) = read_directory_names(&root.file, budget, cancel) else {
        return;
    };
    names.sort();
    names.reverse();
    for name in names {
        if budget.is_exhausted() || cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(directory) = root.open_directory(&name) else {
            continue;
        };
        try_add_skill(&directory, source, budget, seen_paths, output, cancel);
    }
}

fn collect_recursive(
    directory: SecureDirectory,
    source: DiscoveredSkillSource,
    budget: &mut ScanBudget,
    seen_paths: &mut BTreeSet<PathBuf>,
    output: &mut Vec<DiscoveredSkill>,
    cancel: &AtomicBool,
) {
    if budget.is_exhausted() || cancel.load(Ordering::Relaxed) {
        return;
    }
    let Ok(mut names) = read_directory_names(&directory.file, budget, cancel) else {
        return;
    };
    names.sort();
    let has_skill = names.binary_search_by(|name| name.as_os_str().cmp(OsStr::new("SKILL.md")));
    if has_skill.is_ok() {
        try_add_skill(&directory, source, budget, seen_paths, output, cancel);
    }
    if directory.depth >= MAX_SCAN_DEPTH {
        return;
    }
    for name in names.into_iter().rev() {
        if budget.is_exhausted() || cancel.load(Ordering::Relaxed) {
            break;
        }
        if name == "SKILL.md" {
            continue;
        }
        if let Ok(child) = directory.open_directory(&name) {
            collect_recursive(child, source, budget, seen_paths, output, cancel);
        }
    }
}

fn try_add_skill(
    directory: &SecureDirectory,
    source: DiscoveredSkillSource,
    budget: &mut ScanBudget,
    seen_paths: &mut BTreeSet<PathBuf>,
    output: &mut Vec<DiscoveredSkill>,
    cancel: &AtomicBool,
) {
    if budget.accepted >= MAX_DISCOVERED_SKILLS || cancel.load(Ordering::Relaxed) {
        return;
    }
    let path = directory.display_path.join("SKILL.md");
    if !seen_paths.insert(path.clone()) {
        return;
    }
    let Ok(file) = directory.open_skill() else {
        return;
    };
    if let Some(skill) = parse_skill_file(file, path, source, budget, cancel) {
        if budget.accept() {
            output.push(skill);
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_absolute_directory_no_follow(path: &Path) -> io::Result<File> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "skill root is not absolute",
        ));
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC);
    let mut directory = options.open(Path::new("/"))?;
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => {
                directory = open_child_directory_no_follow(&directory, name)?;
            }
            Component::ParentDir | Component::Prefix(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "skill root contains an invalid component",
                ));
            }
        }
    }
    Ok(directory)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_absolute_directory_no_follow(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "secure skill discovery is not supported on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_child_directory_no_follow(parent: &File, name: &OsStr) -> io::Result<File> {
    openat_no_follow(parent, name, true)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_child_directory_no_follow(_parent: &File, _name: &OsStr) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "secure skill discovery is not supported on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_child_file_no_follow(parent: &File, name: &OsStr) -> io::Result<File> {
    openat_no_follow(parent, name, false)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_child_file_no_follow(_parent: &File, _name: &OsStr) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "secure skill discovery is not supported on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn openat_no_follow(parent: &File, name: &OsStr, directory: bool) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};

    unsafe extern "C" {
        fn openat(fd: c_int, path: *const c_char, flags: c_int, mode: u32) -> c_int;
    }
    const O_RDONLY: c_int = 0;
    let name = CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains null"))?;
    let mut flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW;
    if directory {
        flags |= O_DIRECTORY;
    } else {
        flags |= O_NONBLOCK;
    }
    // SAFETY: `name` is a live C string, the parent descriptor is borrowed for
    // the call, and a successful return is a newly owned descriptor.
    let descriptor = unsafe { openat(parent.as_raw_fd(), name.as_ptr(), flags, 0) };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: `openat` returned this uniquely owned descriptor.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(unix)]
fn same_metadata_snapshot(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(not(unix))]
fn same_metadata_snapshot(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.file_type() == right.file_type()
}

enum CancellableReadError {
    Io,
    TooLarge,
    Cancelled,
}

fn read_bounded_cancellable(
    reader: &mut impl io::Read,
    limit: usize,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, CancellableReadError> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; READ_CHUNK_BYTES];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CancellableReadError::Cancelled);
        }
        let remaining = limit.saturating_add(1).saturating_sub(bytes.len());
        if remaining == 0 {
            return Err(CancellableReadError::TooLarge);
        }
        let count = reader
            .read(&mut chunk[..remaining.min(READ_CHUNK_BYTES)])
            .map_err(|_| CancellableReadError::Io)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > limit {
            return Err(CancellableReadError::TooLarge);
        }
    }
    Ok(bytes)
}

fn read_supporting_file_stably(
    file: &mut File,
    initial: &fs::Metadata,
    cancel: &AtomicBool,
    between_reads: impl FnOnce(),
) -> Result<Vec<u8>, SkillSupportingFileError> {
    let first = read_bounded_cancellable(file, MAX_SUPPORTING_FILE_BYTES, cancel)
        .map_err(map_stable_read_error)?;
    let middle = file
        .metadata()
        .map_err(|_| SkillSupportingFileError::Changed)?;
    if !same_metadata_snapshot(initial, &middle) || middle.len() != first.len() as u64 {
        return Err(SkillSupportingFileError::Changed);
    }
    between_reads();
    check_support_cancel(cancel)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| SkillSupportingFileError::Changed)?;
    let second = read_bounded_cancellable(file, MAX_SUPPORTING_FILE_BYTES, cancel)
        .map_err(map_stable_read_error)?;
    let final_metadata = file
        .metadata()
        .map_err(|_| SkillSupportingFileError::Changed)?;
    if first != second
        || !same_metadata_snapshot(initial, &final_metadata)
        || final_metadata.len() != second.len() as u64
    {
        return Err(SkillSupportingFileError::Changed);
    }
    Ok(second)
}

fn read_discovery_file(
    reader: &mut impl io::Read,
    expected_length: usize,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(expected_length);
    let mut chunk = [0_u8; READ_CHUNK_BYTES];
    while bytes.len() < expected_length {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let count = reader
            .read(&mut chunk[..(expected_length - bytes.len()).min(READ_CHUNK_BYTES)])
            .ok()?;
        if count == 0 || !budget.charge_bytes(count) {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Some(bytes)
}

fn sha256_hex_cancellable(bytes: &[u8], cancel: &AtomicBool) -> Option<String> {
    let mut digest = Sha256::new();
    for chunk in bytes.chunks(READ_CHUNK_BYTES) {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        digest.update(chunk);
    }
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    Some(format!("{:x}", digest.finalize()))
}

fn check_discovery_cancel(cancel: &AtomicBool) -> Result<(), SkillsDiscoveryError> {
    if cancel.load(Ordering::Relaxed) {
        Err(SkillsDiscoveryError::Cancelled)
    } else {
        Ok(())
    }
}

fn check_support_cancel(cancel: &AtomicBool) -> Result<(), SkillSupportingFileError> {
    if cancel.load(Ordering::Relaxed) {
        Err(SkillSupportingFileError::Cancelled)
    } else {
        Ok(())
    }
}

fn map_stable_read_error(error: CancellableReadError) -> SkillSupportingFileError {
    match error {
        CancellableReadError::Cancelled => SkillSupportingFileError::Cancelled,
        CancellableReadError::TooLarge | CancellableReadError::Io => {
            SkillSupportingFileError::Changed
        }
    }
}

#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.file_type() == right.file_type()
}

#[cfg(target_os = "macos")]
fn read_directory_names(
    directory: &File,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
) -> io::Result<Vec<OsString>> {
    use std::os::raw::c_char;

    #[repr(C, packed(4))]
    struct NativeDirent {
        d_ino: u64,
        d_seekoff: u64,
        d_reclen: u16,
        d_namlen: u16,
        d_type: u8,
        d_name: [c_char; 1024],
    }
    read_native_directory(directory, budget, cancel, |entry: *mut NativeDirent| {
        // SAFETY: `readdir` returned a live packed dirent. The copied length is
        // clamped to the fixed `d_name` storage before constructing the slice.
        let length = unsafe { std::ptr::addr_of!((*entry).d_namlen).read_unaligned() } as usize;
        // SAFETY: the pointer addresses `d_name` in the live dirent buffer.
        let bytes = unsafe {
            std::slice::from_raw_parts(
                std::ptr::addr_of!((*entry).d_name).cast::<u8>(),
                length.min(1024),
            )
        };
        OsString::from_vec(bytes.to_vec())
    })
}

#[cfg(target_os = "linux")]
fn read_directory_names(
    directory: &File,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
) -> io::Result<Vec<OsString>> {
    use std::os::raw::c_char;

    #[repr(C)]
    struct NativeDirent {
        d_ino: u64,
        d_off: i64,
        d_reclen: u16,
        d_type: u8,
        d_name: [c_char; 256],
    }
    read_native_directory(directory, budget, cancel, |entry: *mut NativeDirent| {
        // SAFETY: `readdir` returned a live dirent with fixed `d_name` storage.
        let bytes = unsafe {
            std::slice::from_raw_parts(std::ptr::addr_of!((*entry).d_name).cast::<u8>(), 256)
        };
        let length = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        OsString::from_vec(bytes[..length].to_vec())
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn read_native_directory<T>(
    directory: &File,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
    decode_name: impl Fn(*mut T) -> OsString,
) -> io::Result<Vec<OsString>> {
    use std::ffi::c_void;
    use std::os::raw::c_int;

    #[repr(C)]
    struct NativeDirectory {
        _private: [u8; 0],
    }
    unsafe extern "C" {
        fn fdopendir(fd: c_int) -> *mut NativeDirectory;
        fn readdir(directory: *mut NativeDirectory) -> *mut c_void;
        fn closedir(directory: *mut NativeDirectory) -> c_int;
    }
    struct DirectoryStream(*mut NativeDirectory);
    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            // SAFETY: `fdopendir` returned the stream and this owner drops once.
            let _ = unsafe { closedir(self.0) };
        }
    }

    let owned = open_child_directory_no_follow(directory, OsStr::new("."))?;
    let descriptor = owned.into_raw_fd();
    // SAFETY: ownership of the fresh descriptor transfers to `fdopendir` on success.
    let stream = unsafe { fdopendir(descriptor) };
    if stream.is_null() {
        // SAFETY: `fdopendir` failed, so ownership did not transfer.
        drop(unsafe { File::from_raw_fd(descriptor) });
        return Err(io::Error::last_os_error());
    }
    let stream = DirectoryStream(stream);
    let mut names = Vec::new();
    while !budget.is_exhausted() && !cancel.load(Ordering::Relaxed) {
        // SAFETY: the stream is live and owns its platform directory buffer.
        let entry = unsafe { readdir(stream.0) }.cast::<T>();
        if entry.is_null() {
            break;
        }
        let name = decode_name(entry);
        if name == "." || name == ".." {
            continue;
        }
        if !budget.visit() {
            break;
        }
        names.push(name);
    }
    Ok(names)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_directory_names(
    _directory: &File,
    _budget: &mut ScanBudget,
    _cancel: &AtomicBool,
) -> io::Result<Vec<OsString>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "secure skill discovery is not supported on this platform",
    ))
}

fn parse_skill_file(
    file: File,
    path: PathBuf,
    source: DiscoveredSkillSource,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
) -> Option<DiscoveredSkill> {
    parse_skill_file_with_hook(file, path, source, budget, cancel, || {})
}

fn parse_skill_file_with_hook(
    mut file: File,
    path: PathBuf,
    source: DiscoveredSkillSource,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
    after_metadata: impl FnOnce(),
) -> Option<DiscoveredSkill> {
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SKILL_BYTES as u64 {
        return None;
    }
    after_metadata();
    let expected_length = usize::try_from(metadata.len()).ok()?;
    if expected_length > budget.byte_limit.saturating_sub(budget.scanned_bytes) {
        return None;
    }
    let bytes = read_discovery_file(&mut file, expected_length, budget, cancel)?;
    let post = file.metadata().ok()?;
    if bytes.len() != expected_length || !same_metadata_snapshot(&metadata, &post) {
        return None;
    }
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let raw = String::from_utf8(bytes).ok()?;
    let (frontmatter, body) = parse_skill_markdown(&raw);
    let fallback_name = path.parent()?.file_name()?.to_string_lossy();
    let name = frontmatter
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback_name.as_ref())
        .to_string();
    let description = frontmatter
        .description
        .unwrap_or_default()
        .trim()
        .to_string();
    let instructions = if body.is_empty() {
        description.clone()
    } else {
        body
    };
    if name.is_empty()
        || name.chars().count() > MAX_SKILL_NAME_LENGTH
        || description.chars().count() > MAX_SKILL_DESCRIPTION_LENGTH
        || instructions.is_empty()
    {
        return None;
    }
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    Some(DiscoveredSkill {
        id: format!("{}:{}", source.id_prefix(), path.to_string_lossy()),
        name,
        description,
        instructions,
        source,
        path,
        version: SkillFileVersion {
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(not(unix))]
            device: 0,
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(not(unix))]
            inode: 0,
            byte_length: post.len(),
            sha256: sha256_hex_cancellable(raw.as_bytes(), cancel)?,
        },
    })
}

#[derive(Default)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
}

fn parse_skill_markdown(input: &str) -> (SkillFrontmatter, String) {
    let raw = input.strip_prefix('\u{feff}').unwrap_or(input);
    let Some(first_newline) = raw.find('\n') else {
        return (SkillFrontmatter::default(), raw.trim().to_string());
    };
    if raw[..first_newline].trim_end_matches('\r') != "---" {
        return (SkillFrontmatter::default(), raw.trim().to_string());
    }

    let header_start = first_newline + 1;
    let mut offset = header_start;
    for line in raw[header_start..].split_inclusive('\n') {
        let scalar = line.trim_end_matches(['\r', '\n']);
        if scalar == "---" {
            let header = &raw[header_start..offset];
            let body = raw[offset + line.len()..].trim().to_string();
            return (parse_frontmatter(header), body);
        }
        offset += line.len();
    }
    let trailing = &raw[offset..];
    if trailing.trim_end_matches('\r') == "---" {
        let header = &raw[header_start..offset];
        return (parse_frontmatter(header), String::new());
    }
    (SkillFrontmatter::default(), raw.trim().to_string())
}

fn parse_frontmatter(block: &str) -> SkillFrontmatter {
    let mut frontmatter = SkillFrontmatter::default();
    for line in block.lines() {
        let Some((key, raw_value)) = line.split_once(':') else {
            continue;
        };
        let value = strip_matching_quotes(raw_value.trim());
        match key.trim().to_lowercase().as_str() {
            "name" => frontmatter.name = Some(value.to_string()),
            "description" => frontmatter.description = Some(value.to_string()),
            _ => {}
        }
    }
    frontmatter
}

fn strip_matching_quotes(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn absolute_lexical(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::os::unix::fs::symlink;

    use tempfile::TempDir;

    use super::*;

    fn write_skill(root: &Path, name: &str, body: &str) -> io::Result<PathBuf> {
        let directory = root.join(name);
        fs::create_dir_all(&directory)?;
        let path = directory.join("SKILL.md");
        fs::write(&path, body)?;
        Ok(path)
    }

    fn discover(home: &Path, workspace: Option<&Path>) -> Vec<DiscoveredSkill> {
        discover_skills_cached(workspace, home, &home.join(AIDEN_DIR_NAME), Instant::now())
    }

    #[test]
    fn discovers_legacy_global_agents_skills() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents"),
            "legacy-global",
            "---\nname: legacy-global\ndescription: Legacy layout skill.\n---\n# Instructions\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "legacy-global");
        assert_eq!(skills[0].source, DiscoveredSkillSource::Global);
    }

    #[test]
    fn discovers_nested_global_agents_skills() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents/skills"),
            "nested-global",
            "---\nname: nested-global\ndescription: Nested layout skill.\n---\n# Instructions\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "nested-global");
    }

    #[test]
    fn discovers_global_claude_skills() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".claude/skills"),
            "claude-skill",
            "---\nname: claude-skill\ndescription: Claude layout skill.\n---\n# Instructions\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "claude-skill");
    }

    #[test]
    fn discovers_global_aiden_skill_and_skills_layouts() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".aiden/skill"),
            "aiden-skill-one",
            "---\nname: aiden-skill-one\ndescription: One.\n---\n# Instructions\n",
        )
        .unwrap();
        write_skill(
            &home.path().join(".aiden/skills"),
            "aiden-skill-two",
            "---\nname: aiden-skill-two\ndescription: Two.\n---\n# Instructions\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            ["aiden-skill-one", "aiden-skill-two"]
        );
    }

    #[test]
    fn discovers_workspace_skills() {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        write_skill(
            &workspace.path().join(".agents/skills"),
            "workspace-skill",
            "---\nname: workspace-skill\ndescription: Workspace skill.\n---\n# Instructions\n",
        )
        .unwrap();

        let skills = discover(home.path(), Some(workspace.path()));

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].source, DiscoveredSkillSource::Workspace);
        assert_eq!(skills[0].name, "workspace-skill");
    }

    #[test]
    fn workspace_skills_override_global_skills_by_name() {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents/skills"),
            "shared",
            "---\nname: shared\ndescription: Global version.\n---\nGlobal instructions\n",
        )
        .unwrap();
        write_skill(
            &workspace.path().join(".agents/skills"),
            "shared",
            "---\nname: shared\ndescription: Workspace version.\n---\nWorkspace instructions\n",
        )
        .unwrap();

        let skills = discover(home.path(), Some(workspace.path()));

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].description, "Workspace version.");
        assert_eq!(skills[0].source, DiscoveredSkillSource::Workspace);
    }

    #[test]
    fn later_global_roots_override_earlier_roots_case_insensitively() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents/skills"),
            "shared-agents",
            "---\nname: Shared\ndescription: Agents version.\n---\nAgents instructions.\n",
        )
        .unwrap();
        write_skill(
            &home.path().join(".claude/skills"),
            "shared-claude",
            "---\nname: shared\ndescription: Claude version.\n---\nClaude instructions.\n",
        )
        .unwrap();
        write_skill(
            &home.path().join(".aiden/skills"),
            "shared-aiden",
            "---\nname: SHARED\ndescription: Aiden version.\n---\nAiden instructions.\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "SHARED");
        assert_eq!(skills[0].description, "Aiden version.");
        assert_eq!(skills[0].instructions, "Aiden instructions.");
    }

    #[test]
    fn falls_back_to_directory_name_and_description_when_body_is_empty() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents/skills"),
            "directory-name",
            "---\ndescription: Description instructions.\n---\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "directory-name");
        assert_eq!(skills[0].description, "Description instructions.");
        assert_eq!(skills[0].instructions, "Description instructions.");
    }

    #[test]
    fn empty_quoted_name_falls_back_to_directory_name() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents/skills"),
            "directory-name",
            "---\nname: \"\"\ndescription: Description instructions.\n---\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "directory-name");
    }

    #[test]
    fn skips_skills_without_instructions() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents/skills"),
            "empty",
            "---\nname: empty\n---\n",
        )
        .unwrap();

        assert!(discover(home.path(), None).is_empty());
    }

    #[test]
    fn caches_repeated_discovery_for_the_same_roots() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents/skills"),
            "first",
            "---\nname: first\ndescription: First.\n---\n# Instructions\n",
        )
        .unwrap();
        assert_eq!(discover(home.path(), None).len(), 1);
        write_skill(
            &home.path().join(".agents/skills"),
            "second",
            "---\nname: second\ndescription: Second.\n---\n# Instructions\n",
        )
        .unwrap();

        let cached = discover(home.path(), None);

        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].name, "first");
    }

    #[test]
    fn replacing_a_root_invalidates_its_cached_catalog() {
        let parent = TempDir::new().unwrap();
        let home = parent.path().join("home");
        fs::create_dir(&home).unwrap();
        write_skill(
            &home.join(".agents/skills"),
            "before-replacement",
            "---\nname: before-replacement\ndescription: Before.\n---\n# Instructions\n",
        )
        .unwrap();
        let first = discover(&home, None);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].name, "before-replacement");

        let moved = parent.path().join("moved-home");
        fs::rename(&home, &moved).unwrap();
        fs::create_dir(&home).unwrap();
        write_skill(
            &home.join(".agents/skills"),
            "after-replacement",
            "---\nname: after-replacement\ndescription: After.\n---\n# Instructions\n",
        )
        .unwrap();

        let refreshed = discover(&home, None);
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].name, "after-replacement");
    }

    #[test]
    fn returns_empty_when_no_skill_directories_exist() {
        let home = TempDir::new().unwrap();

        assert!(discover(home.path(), None).is_empty());
    }

    #[test]
    fn parses_bom_and_flat_quoted_frontmatter() {
        let home = TempDir::new().unwrap();
        let path = write_skill(
            &home.path().join(".agents/skills"),
            "fallback",
            "\u{feff}---\r\nname: \"Quoted Skill\"\r\ndescription: 'Quoted description.'\r\nignored: value\r\n---\r\nDetailed instructions.\r\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Quoted Skill");
        assert_eq!(skills[0].description, "Quoted description.");
        assert_eq!(skills[0].instructions, "Detailed instructions.");
        let canonical_path = fs::canonicalize(&path).unwrap();
        assert_eq!(skills[0].path, canonical_path);
        assert_eq!(
            skills[0].id,
            format!("global:{}", canonical_path.to_string_lossy())
        );
    }

    #[test]
    fn deduplicates_a_path_matched_by_legacy_and_nested_layouts() {
        let home = TempDir::new().unwrap();
        fs::create_dir_all(home.path().join(".agents/skills")).unwrap();
        fs::write(
            home.path().join(".agents/skills/SKILL.md"),
            "Root nested instructions.\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "skills");
    }

    #[test]
    fn returns_a_deterministic_case_insensitive_name_order() {
        let home = TempDir::new().unwrap();
        for name in ["zeta", "Alpha", "middle"] {
            write_skill(
                &home.path().join(".agents/skills"),
                name,
                &format!("---\nname: {name}\n---\nInstructions for {name}.\n"),
            )
            .unwrap();
        }

        let skills = discover(home.path(), None);

        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            ["Alpha", "middle", "zeta"]
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn final_skill_symlink_to_outside_file_is_never_read() {
        let home = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let skill_directory = home.path().join(".agents/skills/linked");
        fs::create_dir_all(&skill_directory).unwrap();
        let outside_file = outside.path().join("SKILL.md");
        fs::write(&outside_file, "Outside instructions.").unwrap();
        symlink(&outside_file, skill_directory.join("SKILL.md")).unwrap();

        assert!(discover(home.path(), None).is_empty());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn nested_layout_symlink_to_outside_tree_is_never_traversed() {
        let home = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        write_skill(outside.path(), "escaped", "Outside instructions.").unwrap();
        fs::create_dir_all(home.path().join(".agents")).unwrap();
        symlink(outside.path(), home.path().join(".agents/skills")).unwrap();

        assert!(discover(home.path(), None).is_empty());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn held_directory_descriptor_resists_ancestor_swap() {
        let home = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let victim_path = home.path().join(".agents/skills/victim");
        write_skill(
            &home.path().join(".agents/skills"),
            "victim",
            "Inside instructions.",
        )
        .unwrap();
        fs::write(outside.path().join("SKILL.md"), "Outside instructions.").unwrap();

        let anchor = SecureDirectory::open_anchor(home.path()).unwrap();
        let agents = anchor.open_directory(OsStr::new(".agents")).unwrap();
        let skills = agents.open_directory(OsStr::new("skills")).unwrap();
        let victim = skills.open_directory(OsStr::new("victim")).unwrap();
        fs::rename(&victim_path, victim_path.with_extension("held")).unwrap();
        symlink(outside.path(), &victim_path).unwrap();

        let parsed = parse_skill_file(
            victim.open_skill().unwrap(),
            victim.display_path.join("SKILL.md"),
            DiscoveredSkillSource::Global,
            &mut ScanBudget::default(),
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(parsed.instructions, "Inside instructions.");
    }

    #[test]
    fn skill_files_larger_than_one_mebibyte_are_skipped() {
        let home = TempDir::new().unwrap();
        write_skill(
            &home.path().join(".agents/skills"),
            "oversized",
            &"x".repeat(MAX_SKILL_BYTES + 1),
        )
        .unwrap();

        assert!(discover(home.path(), None).is_empty());
    }

    #[test]
    fn recursive_discovery_stops_after_depth_twenty() {
        let home = TempDir::new().unwrap();
        let root = home.path().join(".agents/skills");
        let mut at_limit = root.clone();
        for index in 1..MAX_SCAN_DEPTH {
            at_limit.push(format!("limit-{index:02}"));
        }
        fs::create_dir_all(&at_limit).unwrap();
        fs::write(
            at_limit.join("SKILL.md"),
            "---\nname: at-limit\n---\nAt limit.\n",
        )
        .unwrap();

        let mut too_deep = root.join("too-deep");
        for index in 2..=MAX_SCAN_DEPTH {
            too_deep.push(format!("deep-{index:02}"));
        }
        fs::create_dir_all(&too_deep).unwrap();
        fs::write(
            too_deep.join("SKILL.md"),
            "---\nname: too-deep\n---\nToo deep.\n",
        )
        .unwrap();

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "at-limit");
    }

    #[test]
    fn accepted_skill_count_is_capped_at_one_thousand() {
        let home = TempDir::new().unwrap();
        for index in 0..=MAX_DISCOVERED_SKILLS {
            write_skill(
                &home.path().join(".agents/skills"),
                &format!("skill-{index:04}"),
                &format!("Instructions {index}."),
            )
            .unwrap();
        }

        let skills = discover(home.path(), None);

        assert_eq!(skills.len(), MAX_DISCOVERED_SKILLS);
    }

    #[test]
    fn visited_entry_budget_stops_at_ten_thousand() {
        let mut budget = ScanBudget::default();

        let accepted = (0..=MAX_VISITED_ENTRIES).filter(|_| budget.visit()).count();

        assert_eq!(accepted, MAX_VISITED_ENTRIES);
        assert_eq!(budget.visited, MAX_VISITED_ENTRIES);
    }

    fn cache_key(root: &Path) -> DiscoveryCacheKey {
        DiscoveryCacheKey {
            home: root.to_path_buf(),
            aiden_dir: root.join(".aiden"),
            workspace_root: None,
        }
    }

    #[test]
    fn distinct_cache_keys_scan_concurrently() {
        let first_root = TempDir::new().unwrap();
        let second_root = TempDir::new().unwrap();
        let release = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = mpsc::channel();
        let now = Instant::now();
        let mut handles = Vec::new();
        for key in [cache_key(first_root.path()), cache_key(second_root.path())] {
            let release = Arc::clone(&release);
            let entered_tx = entered_tx.clone();
            handles.push(thread::spawn(move || {
                discover_skills_cached_with(key, now, || {
                    entered_tx.send(()).unwrap();
                    while !release.load(Ordering::Acquire) {
                        thread::yield_now();
                    }
                    Vec::new()
                })
            }));
        }
        drop(entered_tx);

        let first_entered = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let second_entered = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        release.store(true, Ordering::Release);
        for handle in handles {
            handle.join().unwrap();
        }

        assert!(first_entered && second_entered);
    }

    #[test]
    fn same_cache_key_collapses_concurrent_scans() {
        let root = TempDir::new().unwrap();
        let key = cache_key(root.path());
        let scans = Arc::new(AtomicUsize::new(0));
        let now = Instant::now();
        let mut handles = Vec::new();
        for _ in 0..8 {
            let key = key.clone();
            let scans = Arc::clone(&scans);
            handles.push(thread::spawn(move || {
                discover_skills_cached_with(key, now, || {
                    scans.fetch_add(1, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(25));
                    Vec::new()
                })
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(scans.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cache_evicts_completed_entries_before_inserting_the_fifty_first_key() {
        let mut cache = DiscoveryCache::default();
        for index in 0..DISCOVERY_CACHE_LIMIT {
            let key = DiscoveryCacheKey {
                home: PathBuf::from(format!("/home/{index}")),
                aiden_dir: PathBuf::from(format!("/home/{index}/.aiden")),
                workspace_root: None,
            };
            let (entry, owns_scan) = cache.reserve(key);
            assert!(owns_scan);
            *entry.state.lock() = DiscoveryCacheState::Ready {
                expires_at: Instant::now() + DISCOVERY_CACHE_TTL,
                skills: Vec::new(),
                roots: DiscoveryRootIdentity::default(),
            };
        }
        assert_eq!(cache.entries.len(), DISCOVERY_CACHE_LIMIT);

        let _ = cache.reserve(DiscoveryCacheKey {
            home: PathBuf::from("/overflow"),
            aiden_dir: PathBuf::from("/overflow/.aiden"),
            workspace_root: None,
        });

        assert_eq!(cache.entries.len(), DISCOVERY_CACHE_LIMIT);
    }

    #[test]
    fn cache_entries_expire_after_five_seconds() {
        let root = TempDir::new().unwrap();
        let now = Instant::now();
        let key = DiscoveryCacheKey {
            home: root.path().to_path_buf(),
            aiden_dir: root.path().join(".aiden"),
            workspace_root: None,
        };
        let scans = AtomicUsize::new(0);

        let _ = discover_skills_cached_with(key.clone(), now, || {
            scans.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        });
        let _ = discover_skills_cached_with(
            key.clone(),
            now + DISCOVERY_CACHE_TTL - Duration::from_nanos(1),
            || {
                scans.fetch_add(1, Ordering::SeqCst);
                Vec::new()
            },
        );
        let _ = discover_skills_cached_with(key, now + DISCOVERY_CACHE_TTL, || {
            scans.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        });

        assert_eq!(scans.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn resolved_paths_normalize_parent_components_without_resolving_symlinks() {
        let root = TempDir::new().unwrap();
        let resolved = absolute_lexical(&root.path().join("nested/../skill/SKILL.md"));

        assert_eq!(resolved, root.path().join("skill/SKILL.md"));
    }

    #[test]
    fn supporting_files_are_relative_bounded_and_read_securely() {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let skill_path = write_skill(
            &workspace.path().join(".agents/skills"),
            "bundle",
            "---\nname: bundle\n---\nInstructions.\n",
        )
        .unwrap();
        let directory = skill_path.parent().unwrap();
        fs::create_dir_all(directory.join("references")).unwrap();
        fs::write(directory.join("references/guide.md"), "Guide text").unwrap();
        fs::write(directory.join("script.sh"), "echo safe").unwrap();
        let skill = discover(home.path(), Some(workspace.path()))
            .into_iter()
            .find(|skill| skill.name == "bundle")
            .unwrap();

        let files = list_skill_supporting_files(&skill, Some(workspace.path())).unwrap();
        assert_eq!(
            files,
            vec![
                PathBuf::from("references/guide.md"),
                PathBuf::from("script.sh")
            ]
        );
        assert_eq!(
            read_skill_supporting_file(
                &skill,
                Some(workspace.path()),
                Path::new("references/guide.md")
            )
            .unwrap(),
            "Guide text"
        );
    }

    #[test]
    fn supporting_file_paths_reject_absolute_parent_nul_and_oversized_inputs() {
        for path in [
            PathBuf::from("/absolute"),
            PathBuf::from("../escape"),
            PathBuf::from("nul\0byte"),
            PathBuf::from("x".repeat(1_025)),
        ] {
            assert!(matches!(
                validated_relative_components(&path),
                Err(SkillSupportingFileError::InvalidPath)
            ));
        }
    }

    #[test]
    fn supporting_file_access_rejects_skill_replacement_and_nul_content() {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let skill_path = write_skill(
            &workspace.path().join(".agents/skills"),
            "bundle",
            "Instructions.\n",
        )
        .unwrap();
        let directory = skill_path.parent().unwrap();
        fs::write(directory.join("binary.txt"), b"left\0right").unwrap();
        let skill = discover(home.path(), Some(workspace.path()))
            .into_iter()
            .find(|skill| skill.name == "bundle")
            .unwrap();
        assert!(matches!(
            read_skill_supporting_file(&skill, Some(workspace.path()), Path::new("binary.txt")),
            Err(SkillSupportingFileError::InvalidFile)
        ));

        fs::remove_file(&skill_path).unwrap();
        fs::write(&skill_path, "Replacement instructions.\n").unwrap();
        assert!(matches!(
            list_skill_supporting_files(&skill, Some(workspace.path())),
            Err(SkillSupportingFileError::Changed)
        ));
    }

    #[test]
    fn cancellation_stops_chunked_reads_inside_the_worker() {
        struct CancellingReader {
            cancel: Arc<AtomicBool>,
            reads: Arc<AtomicUsize>,
        }
        impl io::Read for CancellingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                self.reads.fetch_add(1, Ordering::SeqCst);
                buffer.fill(b'x');
                self.cancel.store(true, Ordering::SeqCst);
                Ok(buffer.len())
            }
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let reads = Arc::new(AtomicUsize::new(0));
        let mut reader = CancellingReader {
            cancel: Arc::clone(&cancel),
            reads: Arc::clone(&reads),
        };
        assert!(matches!(
            read_bounded_cancellable(&mut reader, MAX_SKILL_BYTES, &cancel),
            Err(CancellableReadError::Cancelled)
        ));
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn discovery_rejects_growth_after_metadata_without_overreading_budget() {
        use std::io::Write as _;

        let root = TempDir::new().unwrap();
        let path = root.path().join("SKILL.md");
        let original = b"---\nname: bounded\n---\nInstructions.";
        fs::write(&path, original).unwrap();
        let file = File::open(&path).unwrap();
        let mut budget = ScanBudget::default();
        let parsed = parse_skill_file_with_hook(
            file,
            path.clone(),
            DiscoveredSkillSource::Global,
            &mut budget,
            &AtomicBool::new(false),
            || {
                let mut writer = fs::OpenOptions::new().append(true).open(&path).unwrap();
                writer.write_all(&vec![b'x'; MAX_SKILL_BYTES]).unwrap();
            },
        );
        assert!(parsed.is_none());
        assert_eq!(budget.scanned_bytes, original.len());
    }

    #[test]
    fn supporting_read_rejects_same_length_in_place_rewrite_between_reads() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("guide.md");
        fs::write(&path, "first value").unwrap();
        let mut file = File::open(&path).unwrap();
        let metadata = file.metadata().unwrap();

        let result =
            read_supporting_file_stably(&mut file, &metadata, &AtomicBool::new(false), || {
                fs::write(&path, "other value").unwrap()
            });
        assert!(matches!(result, Err(SkillSupportingFileError::Changed)));
    }

    #[test]
    fn cancelled_discovery_and_supporting_reads_fail_closed() {
        let cancel = AtomicBool::new(true);
        assert!(matches!(
            scan_all_skills(None, Path::new("/unused"), Path::new("/unused"), &cancel),
            Err(SkillsDiscoveryError::Cancelled)
        ));

        let skill = DiscoveredSkill {
            id: "global:test".into(),
            name: "test".into(),
            description: String::new(),
            instructions: "instructions".into(),
            source: DiscoveredSkillSource::Global,
            path: PathBuf::from("/unused/SKILL.md"),
            version: SkillFileVersion {
                device: 0,
                inode: 0,
                byte_length: 0,
                sha256: String::new(),
            },
        };
        assert!(matches!(
            list_skill_supporting_files_cancellable(&skill, None, &cancel),
            Err(SkillSupportingFileError::Cancelled)
        ));
    }

    #[test]
    fn cancellation_interrupts_a_same_key_cache_wait() {
        let root = TempDir::new().unwrap();
        let key = cache_key(root.path());
        let (_entry, owns_scan) = DISCOVERY_CACHE.lock().reserve(key.clone());
        assert!(owns_scan);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let worker_key = key.clone();
        let worker = thread::spawn(move || {
            discover_skills_cached_with_cancel(worker_key, Instant::now(), &worker_cancel, || {
                panic!("a waiter must not start the owned scan")
            })
        });
        thread::sleep(Duration::from_millis(30));
        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(
            worker.join().unwrap(),
            Err(SkillsDiscoveryError::Cancelled)
        ));
        DISCOVERY_CACHE.lock().entries.remove(&key);
    }

    #[test]
    fn cancellation_during_scan_never_publishes_partial_cache_results() {
        let root = TempDir::new().unwrap();
        let key = cache_key(root.path());
        let cancel = AtomicBool::new(false);
        let scans = AtomicUsize::new(0);
        let skill = DiscoveredSkill {
            id: "global:complete".into(),
            name: "Complete".into(),
            description: String::new(),
            instructions: "instructions".into(),
            source: DiscoveredSkillSource::Global,
            path: root.path().join("SKILL.md"),
            version: SkillFileVersion {
                device: 0,
                inode: 0,
                byte_length: 1,
                sha256: "00".repeat(32),
            },
        };

        let first =
            discover_skills_cached_with_cancel(key.clone(), Instant::now(), &cancel, || {
                scans.fetch_add(1, Ordering::SeqCst);
                cancel.store(true, Ordering::SeqCst);
                Ok(vec![skill.clone()])
            });
        assert!(matches!(first, Err(SkillsDiscoveryError::Cancelled)));
        assert!(!DISCOVERY_CACHE.lock().entries.contains_key(&key));

        cancel.store(false, Ordering::SeqCst);
        let complete =
            discover_skills_cached_with_cancel(key.clone(), Instant::now(), &cancel, || {
                scans.fetch_add(1, Ordering::SeqCst);
                Ok(vec![skill.clone()])
            })
            .unwrap();
        assert_eq!(complete, vec![skill]);
        assert_eq!(scans.load(Ordering::SeqCst), 2);
        DISCOVERY_CACHE.lock().entries.remove(&key);
    }

    #[test]
    fn discovered_name_and_description_limits_are_enforced_before_retention() {
        let root = TempDir::new().unwrap();
        for (file_name, name, description) in [
            (
                "long-name.md",
                "n".repeat(MAX_SKILL_NAME_LENGTH + 1),
                "ok".into(),
            ),
            (
                "long-description.md",
                "ok".into(),
                "d".repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1),
            ),
        ] {
            let path = root.path().join(file_name);
            fs::write(
                &path,
                format!("---\nname: {name}\ndescription: {description}\n---\nInstructions."),
            )
            .unwrap();
            assert!(parse_skill_file(
                File::open(&path).unwrap(),
                path,
                DiscoveredSkillSource::Global,
                &mut ScanBudget::default(),
                &AtomicBool::new(false),
            )
            .is_none());
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn supporting_file_symlinks_are_never_listed_or_read() {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let skill_path = write_skill(
            &workspace.path().join(".agents/skills"),
            "bundle",
            "Instructions.\n",
        )
        .unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            skill_path.parent().unwrap().join("linked.txt"),
        )
        .unwrap();
        let skill = discover(home.path(), Some(workspace.path()))
            .into_iter()
            .find(|skill| skill.name == "bundle")
            .unwrap();

        assert!(list_skill_supporting_files(&skill, Some(workspace.path()))
            .unwrap()
            .is_empty());
        assert!(read_skill_supporting_file(
            &skill,
            Some(workspace.path()),
            Path::new("linked.txt")
        )
        .is_err());
    }
}
