//! Structured Git operations for workspace-backed repositories — a port of
//! `main/services/git.ts` (5,199 LOC) covering the core surface the UI needs:
//! status, branches, review/diff, commit, push/pull, and managed worktrees.
//!
//! Commands always run argv-only (never a shell) through [`GitService::run`],
//! which mirrors the TS runner: env scrubbing (`GIT_DIR` etc. stripped),
//! isolated process groups, bounded output (1 MiB), and timeouts (4 s read /
//! 20 s mutation / 120 s push) with a SIGTERM → SIGKILL grace period. Every
//! operation asserts the working directory is inside a real repository via
//! [`GitRepo::resolve`] (`rev-parse --is-inside-work-tree` + `--show-toplevel`
//! + `--git-common-dir`) before any other git command runs.
//!
//! Mutation serialization is keyed by git's canonical common dir
//! ([`GitService::mutation_lock`]), so `git add`/`commit`/`push`/`checkout`
//! from the same repository serialize exactly like the TS
//! `enqueueMutation`. Reads (info/branches/review) use a 1 s TTL cache
//! invalidated by mutations.
//!
//! Modules:
//! - [`status`] — porcelain v2 parse + `info()`
//! - [`branch`] — list/checkout/create + remote refs
//! - [`diff`] — review, per-file diff, numstat, comparison
//! - [`commit`] — isolated-index commit with snapshot fencing
//! - [`push`] / [`pull`] — reviewed push capability + push, `--ff-only` pull
//! - [`worktree`] — list/add/remove of managed worktrees
//! - [`error`] — typed `GitError` codes + stderr classification
//!
//! ## Known divergences from git.ts (documented, not silently dropped)
//!
//! - **Managed-worktree deletion** (git.ts `deleteManagedWorktree` →
//!   `quarantineAndRemoveManagedWorktree`) delegates the recursive delete to
//!   the signed `aiden-worktree-remover` C binary with phase journals. The Rust
//!   port keeps the ownership/identity/dirty verification and the CAS branch
//!   delete, but performs the removal with `git worktree remove` in-process —
//!   no quarantine dance, no `needs_review` journals. The `aiden-owner` marker
//!   and device/inode pinning are preserved for cross-version compatibility.
//! - **Commit index transaction** (`beginIndexTransaction`/`finalizeIndexForHead`
//!   with HEAD/ref lock guards) is ported in simplified form: the `.git/index.lock`
//!   gate, temp index, write-tree, CAS `update-ref`, and lock→index rename are
//!   kept; the multi-ref race reconciliation is reduced to a CAS + post-check.
//! - **Pre-push proxy** (`prepareReviewedPrePushProxy` + frozen remote alias) is
//!   replaced by a direct push to the real remote with `--porcelain --no-force`,
//!   which keeps the "never fetch, never force, endpoint frozen at review time"
//!   guarantee without the frozen-alias shell proxy.
//! - **Signing**: `commit.gpgSign` is honored by adding `-S` to `commit-tree`,
//!   matching git.ts; LFS/partial clone plumbing is not special-cased.

pub mod branch;
pub mod commit;
pub mod diff;
pub mod error;
pub mod pull;
pub mod push;
pub mod status;
pub mod types;
pub mod worktree;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::process::Command;

use crate::error::GitError;
pub use crate::error::GitErrorCode;
pub use crate::types::*;

// ---------------------------------------------------------------------------
// Constants (DEFAULT_* in git.ts)
// ---------------------------------------------------------------------------

pub const DEFAULT_READ_TIMEOUT_MS: u64 = 4_000;
pub const DEFAULT_MUTATION_TIMEOUT_MS: u64 = 20_000;
pub const DEFAULT_PUSH_TIMEOUT_MS: u64 = 120_000;
pub const DEFAULT_MAX_BUFFER_BYTES: usize = 1024 * 1024;
pub const DEFAULT_CACHE_TTL_MS: u64 = 1_000;
pub const DEFAULT_CACHE_ENTRIES: usize = 64;
pub const KILL_GRACE_MS: u64 = 750;

/// Routing env vars stripped from every child (`GIT_ROUTING_ENV` in git.ts) so
/// an outer `GIT_DIR` can never redirect Aiden's commands into another repo.
const GIT_ROUTING_ENV: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
];

/// A caller-owned cancellation handle (port of `AbortSignal`).
#[derive(Clone, Default)]
pub struct AbortSignal {
    sender: Arc<tokio::sync::watch::Sender<bool>>,
}

impl AbortSignal {
    pub fn new() -> Self {
        let (sender, _) = tokio::sync::watch::channel(false);
        Self {
            sender: Arc::new(sender),
        }
    }

    pub fn abort(&self) {
        let _ = self.sender.send(true);
    }

    pub fn is_aborted(&self) -> bool {
        *self.sender.borrow()
    }
}

// ---------------------------------------------------------------------------
// GitRepository handle
// ---------------------------------------------------------------------------

/// A workspace-rooted repository handle (`GitRepository` in git.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepo {
    pub cwd: PathBuf,
    pub top_level: PathBuf,
    pub common_dir: PathBuf,
}

impl GitRepo {
    /// Resolve a canonical repository handle for `cwd`, or `None` when the
    /// folder is not inside a git work tree. Mirrors git.ts `repository()`:
    /// realpath the cwd, require `rev-parse --is-inside-work-tree`, then read
    /// `--show-toplevel` and `--git-common-dir` (both realpathed).
    pub async fn resolve(
        service: &GitService,
        cwd: &Path,
        signal: Option<&AbortSignal>,
    ) -> Result<Option<GitRepo>, GitError> {
        if signal.is_some_and(AbortSignal::is_aborted) {
            return Err(GitError::aborted());
        }
        let canonical_cwd = match std::fs::canonicalize(cwd) {
            Ok(path) => path,
            Err(_) => return Ok(None),
        };
        let inside = service
            .run(
                &canonical_cwd,
                &["rev-parse", "--is-inside-work-tree"],
                RunOptions {
                    allow_exit_codes: &[128],
                    ..RunOptions::default()
                },
            )
            .await?;
        if inside.exit_code != 0 || inside.stdout.trim() != "true" {
            return Ok(None);
        }
        let (top_level, common_dir) = tokio::join!(
            service.run(
                &canonical_cwd,
                &["rev-parse", "--show-toplevel"],
                RunOptions::default()
            ),
            service.run(
                &canonical_cwd,
                &["rev-parse", "--git-common-dir"],
                RunOptions::default()
            ),
        );
        let top_level = std::fs::canonicalize(top_level?.stdout.trim_end())?;
        let common_path = common_dir?.stdout.trim_end().to_string();
        let common_dir_path = if Path::new(&common_path).is_absolute() {
            PathBuf::from(common_path)
        } else {
            canonical_cwd.join(common_path)
        };
        let common_dir = std::fs::canonicalize(common_dir_path)?;
        Ok(Some(GitRepo {
            cwd: canonical_cwd,
            top_level,
            common_dir,
        }))
    }

    /// The workspace is the repository root (required for commit/push).
    pub fn is_root(&self) -> bool {
        self.cwd == self.top_level
    }
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

/// A completed command (`GitCommandResult` in git.ts).
#[derive(Debug, Clone)]
pub struct GitCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
}

/// Options for [`GitService::run`] (`GitRunOptions` in git.ts).
#[derive(Default)]
pub struct RunOptions<'a> {
    pub allow_exit_codes: &'a [i32],
    pub allow_truncated_output: bool,
    pub git_index_file: Option<&'a str>,
    pub mutation: bool,
    pub non_interactive_commit: bool,
    pub timeout: Option<Duration>,
    pub signal: Option<&'a AbortSignal>,
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

struct CacheEntry<T> {
    expires_at: Instant,
    value: T,
}

/// The git service (`GitService` in git.ts). Cheap to clone; internal state is
/// shared (caches + mutation locks).
#[derive(Clone)]
pub struct GitService {
    inner: Arc<GitServiceInner>,
}

struct GitServiceInner {
    git_binary: String,
    max_buffer_bytes: usize,
    read_timeout: Duration,
    mutation_timeout: Duration,
    push_timeout: Duration,
    cache_ttl: Duration,
    cache_entries: usize,
    info_cache: Mutex<HashMap<PathBuf, CacheEntry<types::GitInfo>>>,
    branch_cache: Mutex<HashMap<PathBuf, CacheEntry<types::GitBranches>>>,
    mutations: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

/// `GitServiceOptions` in git.ts.
#[derive(Clone, Default)]
pub struct GitServiceOptions {
    pub git_binary: Option<String>,
    pub max_buffer_bytes: Option<usize>,
    pub read_timeout_ms: Option<u64>,
    pub mutation_timeout_ms: Option<u64>,
    pub push_timeout_ms: Option<u64>,
    pub cache_ttl_ms: Option<u64>,
    pub cache_entries: Option<usize>,
}

impl GitService {
    pub fn new(options: GitServiceOptions) -> Self {
        Self {
            inner: Arc::new(GitServiceInner {
                git_binary: options.git_binary.unwrap_or_else(|| "git".to_string()),
                max_buffer_bytes: options.max_buffer_bytes.unwrap_or(DEFAULT_MAX_BUFFER_BYTES),
                read_timeout: Duration::from_millis(
                    options.read_timeout_ms.unwrap_or(DEFAULT_READ_TIMEOUT_MS),
                ),
                mutation_timeout: Duration::from_millis(
                    options
                        .mutation_timeout_ms
                        .unwrap_or(DEFAULT_MUTATION_TIMEOUT_MS),
                ),
                push_timeout: Duration::from_millis(
                    options.push_timeout_ms.unwrap_or(DEFAULT_PUSH_TIMEOUT_MS),
                ),
                cache_ttl: Duration::from_millis(
                    options.cache_ttl_ms.unwrap_or(DEFAULT_CACHE_TTL_MS),
                ),
                cache_entries: options.cache_entries.unwrap_or(DEFAULT_CACHE_ENTRIES),
                info_cache: Mutex::new(HashMap::new()),
                branch_cache: Mutex::new(HashMap::new()),
                mutations: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn timeouts(&self) -> (Duration, Duration, Duration) {
        (
            self.inner.read_timeout,
            self.inner.mutation_timeout,
            self.inner.push_timeout,
        )
    }

    /// The bounded stdout/stderr buffer (`maxBufferBytes`).
    pub fn max_buffer_bytes(&self) -> usize {
        self.inner.max_buffer_bytes
    }

    /// Serialize mutations per common dir (git.ts `enqueueMutation`). Reads are
    /// stable because they go through `stable_read`, which waits for any active
    /// mutation and drops cache values from stale epochs.
    pub async fn mutation_lock(&self, common_dir: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.inner.mutations.lock();
        map.entry(common_dir.to_path_buf())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// The `gitEnvironment` scrub: strip routing vars + `GIT_CONFIG_*`, then
    /// pin locale, terminal prompts off, and optional locks.
    fn environment(
        &self,
        mutation: bool,
        git_index_file: Option<&str>,
        non_interactive: bool,
    ) -> Command {
        let mut command = Command::new(&self.inner.git_binary);
        command.env_clear();
        // Start from a pristine base: PATH plus a minimal set of standard vars,
        // mirroring git.ts's copy-then-scrub (we keep the common ones).
        for (key, value) in std::env::vars() {
            if GIT_ROUTING_ENV.contains(&key.as_str())
                || key == "GIT_CONFIG_COUNT"
                || key == "GIT_CONFIG_PARAMETERS"
                || is_git_config_pair(&key)
            {
                continue;
            }
            command.env(key, value);
        }
        command
            .env("GIT_OPTIONAL_LOCKS", if mutation { "1" } else { "0" })
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LANG", "C")
            .env("LC_ALL", "C");
        if let Some(index) = git_index_file {
            command.env("GIT_INDEX_FILE", index);
        }
        if non_interactive {
            command.env("GIT_EDITOR", ":");
        }
        command
    }

    /// Run one argv-only git command (`GitService.run` in git.ts). The working
    /// directory and argument slice must outlive the returned future; bind
    /// arrays to locals when passing them through `tokio::join!`.
    pub async fn run(
        &self,
        cwd: impl AsRef<Path>,
        args: &[&str],
        options: RunOptions<'_>,
    ) -> Result<GitCommandResult, GitError> {
        let cwd = cwd.as_ref();
        if options.signal.is_some_and(AbortSignal::is_aborted) {
            return Err(GitError::aborted());
        }
        let timeout = options
            .timeout
            .unwrap_or_else(|| {
                if options.mutation {
                    self.inner.mutation_timeout
                } else {
                    self.inner.read_timeout
                }
            })
            .max(Duration::from_millis(10));

        let mut command = self.environment(
            options.mutation,
            options.git_index_file,
            options.non_interactive_commit,
        );
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                return Err(GitError::with_stderr(
                    GitErrorCode::CommandFailed,
                    error::public_git_message(
                        &err.to_string(),
                        &cwd.display().to_string(),
                        &home_dir(),
                    ),
                    err.to_string(),
                ));
            }
        };

        let pid = child.id().unwrap_or(0) as i32;
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let max_buffer = self.inner.max_buffer_bytes;

        // Stream output with a hard cap (mirrors the TS append/terminate logic).
        let stdout_task = tokio::spawn(drain_capped(stdout, max_buffer));
        let stderr_task = tokio::spawn(drain_capped(stderr, max_buffer));

        // Termination channel: `wait`, `timeout`, or caller abort.
        let abort_rx = options.signal.cloned();
        let mut abort_rx = abort_rx.map(|signal| signal.sender.subscribe());
        let wait = child.wait();
        tokio::pin!(wait);

        let termination: Termination = if let Some(rx) = abort_rx.as_mut() {
            let mut rx = rx.clone();
            tokio::select! {
                result = &mut wait => match result {
                    Ok(status) => Termination::Exited(status.code().unwrap_or(1)),
                    Err(_) => Termination::Exited(1),
                },
                _ = tokio::time::sleep(timeout) => Termination::Timeout,
                changed = rx.changed() => {
                    let _ = changed;
                    Termination::Aborted
                }
            }
        } else {
            tokio::select! {
                result = &mut wait => match result {
                    Ok(status) => Termination::Exited(status.code().unwrap_or(1)),
                    Err(_) => Termination::Exited(1),
                },
                _ = tokio::time::sleep(timeout) => Termination::Timeout,
            }
        };

        if !matches!(termination, Termination::Exited(_)) {
            kill_process_group(pid);
            // Grace period, then SIGKILL.
            let grace = tokio::time::sleep(Duration::from_millis(KILL_GRACE_MS));
            tokio::select! {
                _ = &mut wait => {}
                _ = grace => {
                    kill_process_group_force(pid);
                    let _ = (&mut wait).await;
                }
            }
        }

        let stdout_buf = stdout_task.await.unwrap_or_default();
        let stderr_buf = stderr_task.await.unwrap_or_default();
        let (stdout_bytes, output_limit_reached) = stdout_buf;
        let (stderr_bytes, _) = stderr_buf;
        let stdout_text = String::from_utf8_lossy(&stdout_bytes).into_owned();
        let stderr_text = String::from_utf8_lossy(&stderr_bytes).into_owned();

        match termination {
            Termination::Aborted => Err(GitError::aborted()),
            Termination::Timeout => Err(GitError::timeout(timeout.as_secs().max(1))),
            Termination::Exited(_) if output_limit_reached => {
                if options.allow_truncated_output {
                    Ok(GitCommandResult {
                        stdout: stdout_text,
                        stderr: stderr_text,
                        exit_code: 0,
                        truncated: true,
                    })
                } else {
                    Err(GitError::output_limit())
                }
            }
            Termination::Exited(exit_code) => {
                if exit_code == 0 || options.allow_exit_codes.contains(&exit_code) {
                    Ok(GitCommandResult {
                        stdout: stdout_text,
                        stderr: stderr_text,
                        exit_code,
                        truncated: false,
                    })
                } else {
                    let detail = if !stderr_text.trim().is_empty() {
                        stderr_text.clone()
                    } else if !stdout_text.trim().is_empty() {
                        stdout_text.clone()
                    } else {
                        format!("Git exited with code {exit_code}.")
                    };
                    let classified = error::classify_exit(&stderr_text, &stdout_text);
                    Err(GitError::with_stderr(
                        classified,
                        error::public_git_message(&detail, &cwd.display().to_string(), &home_dir()),
                        stderr_text,
                    ))
                }
            }
        }
    }

    // -- read caches (git.ts infoCache / branchCache) ----------------------

    fn get_cached<T>(cache: &Mutex<HashMap<PathBuf, CacheEntry<T>>>, key: &Path) -> Option<T>
    where
        T: Clone,
    {
        let mut cache = cache.lock();
        let entry = cache.get(key)?;
        if entry.expires_at <= Instant::now() {
            cache.remove(key);
            return None;
        }
        Some(entry.value.clone())
    }

    fn set_cached<T>(&self, cache: &Mutex<HashMap<PathBuf, CacheEntry<T>>>, key: &Path, value: T)
    where
        T: Clone,
    {
        let mut cache = cache.lock();
        cache.insert(
            key.to_path_buf(),
            CacheEntry {
                expires_at: Instant::now() + self.inner.cache_ttl,
                value,
            },
        );
        while cache.len() > self.inner.cache_entries {
            // Remove the oldest entry by expiry.
            let oldest = cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                cache.remove(&oldest);
            } else {
                break;
            }
        }
    }

    pub(crate) fn get_cached_info(&self, key: &Path) -> Option<types::GitInfo> {
        Self::get_cached(&self.inner.info_cache, key)
    }

    pub(crate) fn set_cached_info(&self, key: &Path, value: types::GitInfo) {
        self.set_cached(&self.inner.info_cache, key, value);
    }

    pub(crate) fn get_cached_branches(&self, key: &Path) -> Option<types::GitBranches> {
        Self::get_cached(&self.inner.branch_cache, key)
    }

    pub(crate) fn set_cached_branches(&self, key: &Path, value: types::GitBranches) {
        self.set_cached(&self.inner.branch_cache, key, value);
    }

    /// Drop all read caches after a mutation (git.ts `invalidate(commonDir)`).
    /// The caches are short-lived (1 s), so clearing the whole map is a safe
    /// approximation of per-common-dir invalidation.
    pub(crate) fn invalidate(&self) {
        self.inner.info_cache.lock().clear();
        self.inner.branch_cache.lock().clear();
    }

    /// Run a read against a stable snapshot: serialize behind any in-flight
    /// mutation on the repository, then run the operation once (git.ts
    /// `stableRead` — reads that land during a mutation simply wait for it, so
    /// a post-mutation value cannot populate a stale cache).
    pub async fn stable_read<T, F>(&self, repo: &GitRepo, operation: F) -> Result<T, GitError>
    where
        F: std::future::Future<Output = Result<T, GitError>> + Send,
    {
        let lock = self.mutation_lock(&repo.common_dir).await;
        let _guard = lock.lock().await;
        operation.await
    }
}

fn is_git_config_pair(key: &str) -> bool {
    if let Some(rest) = key.strip_prefix("GIT_CONFIG_KEY_") {
        return rest.bytes().all(|byte| byte.is_ascii_digit());
    }
    if let Some(rest) = key.strip_prefix("GIT_CONFIG_VALUE_") {
        return rest.bytes().all(|byte| byte.is_ascii_digit());
    }
    false
}

#[cfg(unix)]
fn kill_process_group(pid: i32) {
    if pid <= 0 {
        return;
    }
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
}

#[cfg(unix)]
fn kill_process_group_force(pid: i32) {
    if pid <= 0 {
        return;
    }
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(pid: i32) {
    // Fallback: no process groups on this platform; nothing to do beyond the
    // child kill handled by tokio's drop.
    let _ = pid;
}

#[cfg(not(unix))]
fn kill_process_group_force(pid: i32) {
    let _ = pid;
}

enum Termination {
    Exited(i32),
    Timeout,
    Aborted,
}

/// Read a pipe into a byte buffer capped at `max_buffer`, reporting whether the
/// cap was hit (the TS append/terminate output-limit logic).
async fn drain_capped(
    mut stream: impl tokio::io::AsyncRead + Unpin,
    max_buffer: usize,
) -> (Vec<u8>, bool) {
    use tokio::io::AsyncReadExt;
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 8192];
    let mut capped = false;
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if buffer.len() >= max_buffer {
                    continue;
                }
                let remaining = max_buffer - buffer.len();
                let take = remaining.min(n);
                buffer.extend_from_slice(&chunk[..take]);
                if take < n {
                    capped = true;
                }
            }
            Err(_) => break,
        }
    }
    (buffer, capped)
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Path confinement (git.ts `lexicalWorkspacePath`)
// ---------------------------------------------------------------------------

/// Resolve a workspace-relative path and refuse anything that escapes the
/// workspace (git.ts `lexicalWorkspacePath`).
pub fn lexical_workspace_path(root: &Path, relative_path: &str) -> Result<PathBuf, GitError> {
    if relative_path.is_empty()
        || relative_path.contains('\u{0000}')
        || Path::new(relative_path).is_absolute()
    {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "Choose a changed file inside the workspace.",
        ));
    }
    let full_path = root.join(relative_path);
    let relative = match full_path.strip_prefix(root) {
        Ok(relative) => relative,
        Err(_) => {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                "Choose a changed file inside the workspace.",
            ));
        }
    };
    if relative.starts_with("..") || relative.as_os_str().is_empty() && relative_path.is_empty() {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "Choose a changed file inside the workspace.",
        ));
    }
    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(GitError::new(
            GitErrorCode::CommandFailed,
            "Choose a changed file inside the workspace.",
        ));
    }
    Ok(full_path)
}

/// Count text lines (`countTextLines` in git.ts).
pub fn count_text_lines(value: &str) -> u64 {
    if value.is_empty() {
        return 0;
    }
    let lines = value.split('\n').count();
    if value.ends_with('\n') {
        (lines - 1) as u64
    } else {
        lines as u64
    }
}

/// A dependency-free v4-shaped UUID for ownership tokens (git.ts uses
/// `randomUUID`; the marker regex requires the v4 shape).
pub fn random_v4_uuid() -> String {
    let mut bytes = [0u8; 16];
    // Read exactly 16 bytes: `fs::read` on /dev/urandom would never reach EOF.
    if let Ok(mut urandom) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        if urandom.read_exact(&mut bytes).is_err() {
            bytes = [0u8; 16];
        }
    }
    // Fall back to a hash of clock + pid + a per-process counter.
    if bytes.iter().all(|byte| *byte == 0) {
        use sha2::{Digest, Sha256};
        let counter = {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            COUNTER.fetch_add(1, Ordering::Relaxed)
        };
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let mut hasher = Sha256::new();
        hasher.update(format!("{}-{nanos}-{counter}", std::process::id()));
        let digest = hasher.finalize();
        bytes.copy_from_slice(&digest[..16]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8],
        bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

/// Natural (numeric-aware) path comparison matching V8's
/// `localeCompare(path, undefined, { numeric: true })`: digit runs compare
/// numerically, everything else char-by-char.
pub fn compare_paths_numeric(left: &str, right: &str) -> std::cmp::Ordering {
    let mut left_chars = left.chars();
    let mut right_chars = right.chars();
    loop {
        let left_next = left_chars.clone().next();
        let right_next = right_chars.clone().next();
        match (left_next, right_next) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(lc), Some(rc)) if lc.is_ascii_digit() && rc.is_ascii_digit() => {
                let mut left_run = String::new();
                while let Some(candidate) = left_chars.clone().next() {
                    if !candidate.is_ascii_digit() {
                        break;
                    }
                    left_run.push(left_chars.next().unwrap());
                }
                let mut right_run = String::new();
                while let Some(candidate) = right_chars.clone().next() {
                    if !candidate.is_ascii_digit() {
                        break;
                    }
                    right_run.push(right_chars.next().unwrap());
                }
                let left_trim = left_run.trim_start_matches('0');
                let right_trim = right_run.trim_start_matches('0');
                let by_length = left_trim.len().cmp(&right_trim.len());
                if by_length != std::cmp::Ordering::Equal {
                    return by_length;
                }
                let by_value = left_trim.cmp(right_trim);
                if by_value != std::cmp::Ordering::Equal {
                    return by_value;
                }
                // Numerically equal: more leading zeros sorts first.
                let by_zeros = right_run.len().cmp(&left_run.len());
                if by_zeros != std::cmp::Ordering::Equal {
                    return by_zeros;
                }
            }
            (Some(lc), Some(rc)) => {
                let ordering = lc.cmp(&rc);
                if ordering != std::cmp::Ordering::Equal {
                    return ordering;
                }
                left_chars.next();
                right_chars.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_paths_refuse_escape() {
        let root = PathBuf::from("/workspace");
        assert!(lexical_workspace_path(&root, "src/lib.rs").is_ok());
        assert!(lexical_workspace_path(&root, "../outside").is_err());
        assert!(lexical_workspace_path(&root, "a/../../outside").is_err());
        assert!(lexical_workspace_path(&root, "/absolute").is_err());
        assert!(lexical_workspace_path(&root, "").is_err());
        assert!(lexical_workspace_path(&root, "a\0b").is_err());
    }

    #[test]
    fn count_lines_matches_ts() {
        assert_eq!(count_text_lines(""), 0);
        assert_eq!(count_text_lines("a\nb\n"), 2);
        assert_eq!(count_text_lines("a\nb"), 2);
        assert_eq!(count_text_lines("single"), 1);
    }

    #[test]
    fn uuid_matches_v4_marker_shape() {
        let uuid = random_v4_uuid();
        let bytes = uuid.as_bytes();
        assert_eq!(bytes.len(), 36);
        assert_eq!(bytes[14], b'4');
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
        assert!(uuid
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'));
    }

    #[test]
    fn numeric_path_sort_matches_localecompare_numeric() {
        let mut paths = vec!["file10.txt", "file2.txt", "file1.txt", "file.txt"];
        paths.sort_by(|left, right| compare_paths_numeric(left, right));
        assert_eq!(
            paths,
            vec!["file.txt", "file1.txt", "file2.txt", "file10.txt"]
        );
    }
}
