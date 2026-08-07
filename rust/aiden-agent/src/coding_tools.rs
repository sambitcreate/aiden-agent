//! Port of `main/services/coding-tools.ts` — workspace-confined filesystem and
//! shell tools plus the safe-execution core.
//!
//! Every path is resolved against — and confined to — the workspace root, so
//! the agent cannot read or write outside the folder the user opened.
//! `run_command` executes with the root as its working directory, through a
//! shell spawned with `tokio::process` and gated behind the
//! [`ApprovalPolicy`](crate::approval::ApprovalPolicy) (the crate default
//! denies all mutating tools; the UI wires a real approval flow later).
//!
//! Two builders mirror the TS split:
//! - [`parent_coding_tool_defs`] / [`build_coding_tool_executor`] — the main
//!   agent's folder-scoped tools (parent semantics: hidden-metadata reads, no
//!   credential exclusion beyond `.env`, plain reads).
//! - [`subagent_coding_tool_defs`] / [`build_subagent_coding_tool_executor`] —
//!   the positive child allowlist (read-only), pinning the workspace root
//!   (device+inode) and excluding credential-bearing paths from every
//!   model-visible result.
//!
//! Regex engine note: the TS uses `re2-wasm` (subagent) and JS `RegExp`
//! (parent). Rust uses the `regex` crate — RE2-style, linear-time — for both.
//! JS-only features (lookbehind, backreferences) surface as "invalid regular
//! expression" errors instead of matching; that is a deliberate, safer
//! deviation. NFKC normalization in the credential-family matcher is also
//! skipped (the punctuation-collapse class still handles wide separators).

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aiden_core::subagent_safe_text::contains_high_confidence_secret_including_encodings;
use aiden_core::{ToolCall, ToolDef};
use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use crate::approval::{ApprovalPolicy, ApprovalVerdict, DenyAllApprovalPolicy};
use crate::runner::{ToolExecutionError, ToolExecutor, ToolOutput};

// ===========================================================================
// Limits (mirror coding-tools.ts)
// ===========================================================================

pub const MAX_READ_BYTES: usize = 200_000;
pub const MAX_OUTPUT_CHARS: usize = 20_000;
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
pub const COMMAND_TIMEOUT_MS: u64 = 120_000;
pub const MAX_LIST_ENTRIES: usize = 500;
pub const MAX_LIST_SCAN_ENTRIES: usize = 10_000;
pub const MAX_GLOB_MATCHES: usize = 500;
pub const MAX_GLOB_ENTRIES: usize = 10_000;
pub const MAX_GREP_MATCHES: usize = 200;
pub const MAX_GREP_ENTRIES: usize = 10_000;
pub const MAX_GREP_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_GREP_DURATION_MS: u64 = 5_000;
pub const MAX_SEARCH_PATTERN_CHARS: usize = 1_000;
pub const SKIP_DIRS: &[&str] = &[".git", "node_modules", "dist", "build", ".next", ".cache"];

// ===========================================================================
// Tool definitions
// ===========================================================================

/// A folder-scoped coding tool definition: identity, JSON-schema parameters
/// (replacing typebox), and whether it is part of the mutating approval set.
#[derive(Debug, Clone)]
pub struct CodingTool {
    pub name: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub parameters: Value,
    pub requires_approval: bool,
}

impl CodingTool {
    pub fn to_def(&self) -> ToolDef {
        ToolDef {
            name: self.name.to_string(),
            description: self.description.to_string(),
            parameters: self.parameters.clone(),
        }
    }
}

fn string_prop(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn string_prop_limited(description: &str, max_length: usize) -> Value {
    json!({ "type": "string", "description": description, "maxLength": max_length })
}

/// typebox `Type.Object(...)` shape: `properties` + `required` +
/// `additionalProperties: false`.
fn schema_object(properties: Vec<(&str, Value, bool)>) -> Value {
    let mut props = serde_json::Map::new();
    let mut required: Vec<String> = Vec::new();
    for (key, schema, is_required) in properties {
        props.insert(key.to_string(), schema);
        if is_required {
            required.push(key.to_string());
        }
    }
    let mut object = serde_json::Map::new();
    object.insert("type".to_string(), Value::String("object".to_string()));
    object.insert("properties".to_string(), Value::Object(props));
    object.insert("additionalProperties".to_string(), Value::Bool(false));
    if !required.is_empty() {
        object.insert(
            "required".to_string(),
            Value::Array(required.into_iter().map(Value::String).collect()),
        );
    }
    Value::Object(object)
}

/// The parent (main agent) coding tool set, in `buildCodingTools` order.
pub fn parent_coding_tool_defs() -> Vec<CodingTool> {
    vec![
        CodingTool {
            name: "read_file",
            label: "Read File",
            description:
                "Read a UTF-8 text file from the workspace folder. Paths are relative to the folder root.",
            parameters: schema_object(vec![(
                "path",
                string_prop("File path relative to the workspace folder."),
                true,
            )]),
            requires_approval: false,
        },
        CodingTool {
            name: "list_dir",
            label: "List Directory",
            description: "List the entries of a directory in the workspace folder.",
            parameters: schema_object(vec![(
                "path",
                string_prop("Directory relative to the workspace folder (default root)."),
                false,
            )]),
            requires_approval: false,
        },
        CodingTool {
            name: "glob",
            label: "Find Files",
            description: r#"Find files in the workspace folder matching a glob pattern, e.g. "src/**/*.ts"."#,
            parameters: schema_object(vec![(
                "pattern",
                string_prop("Glob pattern relative to the workspace folder."),
                true,
            )]),
            requires_approval: false,
        },
        CodingTool {
            name: "grep",
            label: "Search Files",
            description:
                "Search the workspace folder for lines matching a regular expression. Returns file:line: match, capped at 200 hits.",
            parameters: schema_object(vec![
                (
                    "pattern",
                    string_prop("JavaScript regular expression to search for."),
                    true,
                ),
                (
                    "path",
                    string_prop("Subdirectory to limit the search to (default root)."),
                    false,
                ),
            ]),
            requires_approval: false,
        },
        CodingTool {
            name: "edit_file",
            label: "Edit File",
            description: "Replace an exact substring in an existing file. old_string must appear exactly once; use enough surrounding context to make it unique.",
            parameters: schema_object(vec![
                ("path", string_prop("File path relative to the workspace folder."), true),
                (
                    "old_string",
                    string_prop("Exact text to replace (must be unique in the file)."),
                    true,
                ),
                ("new_string", string_prop("Replacement text."), true),
            ]),
            requires_approval: true,
        },
        CodingTool {
            name: "write_file",
            label: "Write File",
            description: "Create or overwrite a text file in the workspace folder with the given content. Creates parent directories as needed.",
            parameters: schema_object(vec![
                ("path", string_prop("File path relative to the workspace folder."), true),
                ("content", string_prop("Full file content to write."), true),
            ]),
            requires_approval: true,
        },
        CodingTool {
            name: "run_command",
            label: "Run Command",
            description: "Run a shell command with the workspace folder as the working directory. Returns combined stdout/stderr (capped). Use for builds, tests, git, package managers, etc.",
            parameters: schema_object(vec![
                ("command", string_prop("The shell command to run."), true),
                (
                    "description",
                    string_prop(
                        "A short present-tense description of what the command does, in 5-10 words, e.g. \"Run the unit test suite\".",
                    ),
                    false,
                ),
            ]),
            requires_approval: true,
        },
    ]
}

/// The positive V1 child coding-tool set: only known read/search factories are
/// reachable (`read_file`, `list_dir`, `glob`, `grep`).
pub fn subagent_coding_tool_defs(allowed: &[&str]) -> Vec<CodingTool> {
    let permitted: HashSet<&str> = allowed.iter().copied().collect();
    let mut tools: Vec<CodingTool> = Vec::new();
    if permitted.contains("read_file") {
        tools.push(CodingTool {
            name: "read_file",
            label: "Read File",
            description:
                "Read a UTF-8 text file from the workspace folder. Paths are relative to the folder root.",
            parameters: schema_object(vec![(
                "path",
                string_prop("File path relative to the workspace folder."),
                true,
            )]),
            requires_approval: false,
        });
    }
    if permitted.contains("list_dir") {
        tools.push(CodingTool {
            name: "list_dir",
            label: "List Directory",
            description: "List the entries of a directory in the workspace folder.",
            parameters: schema_object(vec![(
                "path",
                string_prop("Directory relative to the workspace folder (default root)."),
                false,
            )]),
            requires_approval: false,
        });
    }
    if permitted.contains("glob") {
        tools.push(CodingTool {
            name: "glob",
            label: "Find Files",
            description: r#"Find files in the workspace folder matching a glob pattern, e.g. "src/**/*.ts"."#,
            parameters: schema_object(vec![(
                "pattern",
                string_prop_limited(
                    "Glob pattern relative to the workspace folder.",
                    MAX_SEARCH_PATTERN_CHARS,
                ),
                true,
            )]),
            requires_approval: false,
        });
    }
    if permitted.contains("grep") {
        tools.push(CodingTool {
            name: "grep",
            label: "Search Files",
            description:
                "Search the workspace folder for lines matching a regular expression. Returns file:line: match, capped at 200 hits.",
            parameters: schema_object(vec![
                (
                    "pattern",
                    string_prop_limited(
                        "RE2 regular expression to search for.",
                        MAX_SEARCH_PATTERN_CHARS,
                    ),
                    true,
                ),
                (
                    "path",
                    string_prop("Subdirectory to limit the search to (default root)."),
                    false,
                ),
            ]),
            requires_approval: false,
        });
    }
    tools
}

/// Build a short human summary of a mutating tool call for the approval prompt
/// (mirrors `summarizeToolCall`).
pub fn summarize_tool_call(tool_name: &str, args: &Value) -> String {
    let path = args.get("path").and_then(Value::as_str).unwrap_or("?");
    match tool_name {
        "write_file" => format!("Create or replace file: {path}"),
        "edit_file" => format!("Edit file: {path}"),
        "run_command" => format!(
            "Run command: {}",
            args.get("command").and_then(Value::as_str).unwrap_or("?")
        ),
        _ => tool_name.to_string(),
    }
}

// ===========================================================================
// Workspace root guard (path sandboxing core)
// ===========================================================================

/// The authorized workspace root. The *parent* variant is lexical-only; the
/// *subagent* variant pins canonical path + device/inode identity so the root
/// cannot be swapped mid-generation.
#[derive(Debug, Clone)]
pub struct WorkspaceRoot {
    pub lexical: PathBuf,
    canonical: Option<PathBuf>,
    identity: Option<std::fs::Metadata>,
}

impl WorkspaceRoot {
    /// `createParentWorkspaceRoot` — lexical root, no pinning.
    pub fn new(root: PathBuf) -> Self {
        Self {
            lexical: root,
            canonical: None,
            identity: None,
        }
    }

    /// `pinWorkspaceRoot` — canonicalize + stat, requiring a real directory.
    pub fn pin(root: PathBuf) -> Result<Self, ToolExecutionError> {
        let canonical = std::fs::canonicalize(&root).map_err(|_| {
            ToolExecutionError::Message("The workspace root could not be resolved.".into())
        })?;
        let identity = std::fs::metadata(&canonical).map_err(|_| {
            ToolExecutionError::Message("The workspace root could not be inspected.".into())
        })?;
        if !identity.is_dir() {
            return Err(ToolExecutionError::Message(
                "The workspace root is not a directory.".into(),
            ));
        }
        Ok(Self {
            lexical: root,
            canonical: Some(canonical),
            identity: Some(identity),
        })
    }

    pub fn is_pinned(&self) -> bool {
        self.canonical.is_some()
    }

    pub fn canonical(&self) -> Option<&Path> {
        self.canonical.as_deref()
    }
}

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

/// `sameFile` — device + inode equality.
#[cfg(unix)]
fn same_metadata(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_metadata(_left: &std::fs::Metadata, _right: &std::fs::Metadata) -> bool {
    false
}

/// Lexically normalize a path (`path.resolve` semantics: collapse `.`/`..`).
fn normalized(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    result.push(component);
                }
            }
            other => result.push(other),
        }
    }
    result
}

/// Resolve a user/agent-supplied path within the root, rejecting lexical
/// escapes (`resolveInRoot`).
pub fn resolve_in_root(root: &Path, p: &str) -> Result<PathBuf, ToolExecutionError> {
    let joined = root.join(if p.is_empty() { "." } else { p });
    let resolved = normalized(&joined);
    let root_norm = normalized(root);
    let rel = resolved.strip_prefix(&root_norm).map_err(|_| {
        ToolExecutionError::Message(format!("Path \"{p}\" is outside the workspace folder."))
    })?;
    if rel.as_os_str().is_empty() {
        return Ok(root_norm);
    }
    if rel.components().next() == Some(Component::ParentDir) {
        return Err(ToolExecutionError::Message(format!(
            "Path \"{p}\" is outside the workspace folder."
        )));
    }
    Ok(resolved)
}

/// `assertRealPathInRoot` — a resolved (real) path must stay under the root.
pub fn assert_real_path_in_root(
    root: &Path,
    resolved: &Path,
    supplied: &str,
) -> Result<(), ToolExecutionError> {
    match resolved.strip_prefix(root) {
        Ok(rel) if rel.as_os_str().is_empty() => Ok(()),
        Ok(rel) if rel.components().next() != Some(Component::ParentDir) => Ok(()),
        _ => Err(ToolExecutionError::Message(format!(
            "Path \"{supplied}\" resolves outside the workspace folder."
        ))),
    }
}

/// `verifyWorkspaceRoot` — re-resolve + re-stat the root, requiring the pinned
/// canonical path and device/inode identity to be unchanged.
async fn verify_workspace_root(workspace: &WorkspaceRoot) -> Result<PathBuf, ToolExecutionError> {
    let canonical = tokio::fs::canonicalize(&workspace.lexical)
        .await
        .map_err(|_| {
            ToolExecutionError::Message(
                "The authorized workspace root could not be resolved.".into(),
            )
        })?;
    let identity = tokio::fs::metadata(&workspace.lexical).await.map_err(|_| {
        ToolExecutionError::Message("The authorized workspace root could not be inspected.".into())
    })?;
    match (&workspace.canonical, &workspace.identity) {
        (Some(expected_canonical), Some(expected_identity)) => {
            if &canonical != expected_canonical
                || !identity.is_dir()
                || !same_metadata(&identity, expected_identity)
            {
                return Err(ToolExecutionError::Message(
                    "The authorized workspace root changed during this generation.".into(),
                ));
            }
            Ok(expected_canonical.clone())
        }
        _ => {
            if !identity.is_dir() {
                return Err(ToolExecutionError::Message(
                    "The workspace root is not a directory.".into(),
                ));
            }
            Ok(canonical)
        }
    }
}

/// `nearestExistingAncestor` — walk up until a path exists.
async fn nearest_existing_ancestor(mut current: PathBuf) -> Result<PathBuf, std::io::Error> {
    loop {
        match tokio::fs::symlink_metadata(&current).await {
            Ok(_) => return Ok(current),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let parent = current.parent().map(|p| p.to_path_buf());
                match parent {
                    Some(parent) if parent != current => current = parent,
                    _ => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
}

/// Resolve an existing path, following symlinks only after checking its target
/// (`resolveExistingInRoot`).
async fn resolve_existing_in_root(
    workspace: &WorkspaceRoot,
    supplied: &str,
) -> Result<(PathBuf, PathBuf), ToolExecutionError> {
    let real_root = verify_workspace_root(workspace).await?;
    let lexical = resolve_in_root(&workspace.lexical, supplied)?;
    let real_path = tokio::fs::canonicalize(&lexical)
        .await
        .map_err(|_| ToolExecutionError::Message(format!("Path \"{supplied}\" does not exist.")))?;
    assert_real_path_in_root(&real_root, &real_path, supplied)?;
    Ok((real_root, real_path))
}

/// Resolve a writable path without letting mkdir/write follow a symlink to
/// somewhere outside the workspace. Existing safe symlinks are canonicalized
/// (`resolveWritableInRoot`).
async fn resolve_writable_in_root(
    workspace: &WorkspaceRoot,
    supplied: &str,
) -> Result<PathBuf, ToolExecutionError> {
    let lexical = resolve_in_root(&workspace.lexical, supplied)?;
    let real_root = verify_workspace_root(workspace).await?;
    let parent = lexical
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| lexical.clone());
    let ancestor = nearest_existing_ancestor(parent.clone())
        .await
        .map_err(|_| {
            ToolExecutionError::Message(format!("Path \"{supplied}\" could not be resolved."))
        })?;
    let real_ancestor = tokio::fs::canonicalize(&ancestor).await.map_err(|_| {
        ToolExecutionError::Message(format!("Path \"{supplied}\" could not be resolved."))
    })?;
    assert_real_path_in_root(&real_root, &real_ancestor, supplied)?;
    tokio::fs::create_dir_all(&parent).await.map_err(|_| {
        ToolExecutionError::Message(format!("Path \"{supplied}\" could not be created."))
    })?;
    let real_parent = tokio::fs::canonicalize(&parent).await.map_err(|_| {
        ToolExecutionError::Message(format!("Path \"{supplied}\" could not be resolved."))
    })?;
    assert_real_path_in_root(&real_root, &real_parent, supplied)?;
    match tokio::fs::symlink_metadata(&lexical).await {
        Ok(_) => {
            let real_path = tokio::fs::canonicalize(&lexical).await.map_err(|_| {
                ToolExecutionError::Message(format!(
                    "Path \"{supplied}\" is a dangling symbolic link."
                ))
            })?;
            assert_real_path_in_root(&real_root, &real_path, supplied)?;
            Ok(real_path)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(lexical),
        Err(_) => Err(ToolExecutionError::Message(format!(
            "Path \"{supplied}\" could not be resolved."
        ))),
    }
}

// ===========================================================================
// Bounded verified IO
// ===========================================================================

/// macOS flag values for the no-follow / non-blocking read guard. The port
/// targets macOS (the app's only platform); other platforms degrade to plain
/// opens and rely on the realpath + dev/ino verification instead.
#[cfg(target_os = "macos")]
const O_NOFOLLOW: i32 = 0x0100;
#[cfg(not(target_os = "macos"))]
const O_NOFOLLOW: i32 = 0;
#[cfg(target_os = "macos")]
const O_NONBLOCK: i32 = 0x0004;
#[cfg(not(target_os = "macos"))]
const O_NONBLOCK: i32 = 0;
const O_RDONLY: i32 = 0;

#[cfg(unix)]
fn open_read_nofollow_nonblock(options: &mut tokio::fs::OpenOptions) {
    options.custom_flags(O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
}

/// `readBoundedVerifiedFile` — open with no-follow, verify the opened handle
/// against a re-resolved path, read at most `max_bytes`, and refuse credential
/// material.
async fn read_bounded_verified_file(
    workspace: &WorkspaceRoot,
    real_root: &Path,
    lexical: &Path,
    supplied: &str,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), ToolExecutionError> {
    verify_workspace_root(workspace).await?;
    let initial_real = tokio::fs::canonicalize(lexical).await.map_err(|_| {
        ToolExecutionError::Message(format!("Path \"{supplied}\" could not be resolved."))
    })?;
    assert_real_path_in_root(real_root, &initial_real, supplied)?;
    reject_protected_credential(real_root, &initial_real, supplied, FinalKind::File)?;

    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    open_read_nofollow_nonblock(&mut options);
    let mut handle = options.open(lexical).await.map_err(|_| {
        ToolExecutionError::Message(format!("Path \"{supplied}\" could not be opened."))
    })?;

    let result = async {
        verify_workspace_root(workspace).await?;
        let verified_real = tokio::fs::canonicalize(lexical).await.map_err(|_| {
            ToolExecutionError::Message(format!("Path \"{supplied}\" could not be resolved."))
        })?;
        assert_real_path_in_root(real_root, &verified_real, supplied)?;
        reject_protected_credential(real_root, &verified_real, supplied, FinalKind::File)?;
        let opened_meta = handle.metadata().await.map_err(|_| {
            ToolExecutionError::Message(format!("Path \"{supplied}\" could not be inspected."))
        })?;
        let verified_meta = tokio::fs::metadata(&verified_real).await.map_err(|_| {
            ToolExecutionError::Message(format!("Path \"{supplied}\" could not be inspected."))
        })?;
        if !opened_meta.is_file() || !verified_meta.is_file() {
            return Err(ToolExecutionError::Message(format!(
                "Path \"{supplied}\" is not a regular file."
            )));
        }
        if !same_metadata(&opened_meta, &verified_meta) {
            return Err(ToolExecutionError::Message(format!(
                "Path \"{supplied}\" changed while it was being opened."
            )));
        }
        let mut buffer = vec![0u8; max_bytes + 1];
        let mut read = 0usize;
        loop {
            let n = handle.read(&mut buffer[read..]).await.map_err(|_| {
                ToolExecutionError::Message(format!("Path \"{supplied}\" could not be read."))
            })?;
            if n == 0 || read + n >= buffer.len() {
                read += n;
                break;
            }
            read += n;
        }
        let truncated = read > max_bytes;
        let bounded = buffer[..read.min(max_bytes)].to_vec();
        if contains_private_key_material(&bounded) {
            return Err(ToolExecutionError::Message(
                "Reading credential files is disabled to keep workspace secrets out of model context."
                    .into(),
            ));
        }
        Ok((bounded, truncated))
    }
    .await;
    drop(handle);
    result
}

/// `openVerifiedDirectory` — TOCTOU-checked directory open for the pinned
/// subagent traversal tools.
async fn open_verified_directory(
    workspace: &WorkspaceRoot,
    directory_path: &Path,
) -> Result<tokio::fs::ReadDir, ToolExecutionError> {
    if !workspace.is_pinned() {
        return Err(ToolExecutionError::Message(
            "Verified directory traversal requires a pinned workspace.".into(),
        ));
    }
    verify_workspace_root(workspace).await?;
    let lexical_stat = tokio::fs::symlink_metadata(directory_path)
        .await
        .map_err(|_| {
            ToolExecutionError::Message("The requested path is not a directory.".into())
        })?;
    let is_workspace_root = normalized(directory_path) == normalized(&workspace.lexical);
    if lexical_stat.file_type().is_symlink() && !is_workspace_root {
        return Err(ToolExecutionError::Message(
            "A directory changed to a symbolic link before it could be opened.".into(),
        ));
    }
    let canonical_root = workspace
        .canonical()
        .ok_or_else(|| ToolExecutionError::Message("The workspace root is not pinned.".into()))?;
    let before_real = tokio::fs::canonicalize(directory_path).await.map_err(|_| {
        ToolExecutionError::Message("The requested path could not be resolved.".into())
    })?;
    assert_real_path_in_root(
        canonical_root,
        &before_real,
        directory_path.to_string_lossy().as_ref(),
    )?;
    let before_stat = tokio::fs::metadata(&before_real).await.map_err(|_| {
        ToolExecutionError::Message("The requested path could not be inspected.".into())
    })?;
    if !before_stat.is_dir() {
        return Err(ToolExecutionError::Message(
            "The requested path is not a directory.".into(),
        ));
    }
    let directory = tokio::fs::read_dir(directory_path).await.map_err(|_| {
        ToolExecutionError::Message("The requested path could not be opened.".into())
    })?;
    verify_workspace_root(workspace).await?;
    let after_real = tokio::fs::canonicalize(directory_path).await.map_err(|_| {
        ToolExecutionError::Message("The requested path could not be resolved.".into())
    })?;
    assert_real_path_in_root(
        canonical_root,
        &after_real,
        directory_path.to_string_lossy().as_ref(),
    )?;
    let after_stat = tokio::fs::metadata(&after_real).await.map_err(|_| {
        ToolExecutionError::Message("The requested path could not be inspected.".into())
    })?;
    if before_real != after_real
        || !after_stat.is_dir()
        || !same_metadata(&before_stat, &after_stat)
    {
        return Err(ToolExecutionError::Message(
            "A directory changed while it was being opened.".into(),
        ));
    }
    Ok(directory)
}

// ===========================================================================
// Output shaping
// ===========================================================================

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let marker = "\n… [truncated]";
    let mut limit = max.saturating_sub(marker.len()).min(text.len());
    while !text.is_char_boundary(limit) {
        limit -= 1;
    }
    format!("{}{}", &text[..limit], marker)
}

/// `formatBoundedSearchResult` — bounded body + warning suffix.
fn format_bounded_search_result(lines: &[String], empty_text: &str, warnings: &[String]) -> String {
    let body = if lines.is_empty() {
        empty_text.to_string()
    } else {
        lines.join("\n")
    };
    if warnings.is_empty() {
        return truncate(&body, MAX_OUTPUT_CHARS);
    }
    let suffix = format!("\n{}", warnings.join("\n"));
    if body.len() + suffix.len() <= MAX_OUTPUT_CHARS {
        return format!("{body}{suffix}");
    }
    let marker = "\n… [output truncated]";
    let mut body_limit = MAX_OUTPUT_CHARS
        .saturating_sub(suffix.len() + marker.len())
        .min(body.len());
    while !body.is_char_boundary(body_limit) {
        body_limit -= 1;
    }
    format!("{}{}{}", &body[..body_limit], marker, suffix)
}

// ===========================================================================
// Credential-path protection
// ===========================================================================

const PROTECTED_CREDENTIAL_FILE_NAMES: &[&str] = &[
    "auth.json",
    "credentials",
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "identity",
    "service-account.json",
    "service_account.json",
    ".git-credentials",
    ".gitconfig",
    ".bunfig.toml",
    ".netrc",
    ".npmrc",
    ".pnpmrc",
    ".pypirc",
    ".sentryclirc",
    ".terraformrc",
    ".vault-token",
    ".yarnrc",
    ".yarnrc.yml",
    "_netrc",
];

const PROTECTED_CREDENTIAL_FILE_EXTENSIONS: &[&str] = &[
    ".asc",
    ".der",
    ".jks",
    ".kdbx",
    ".key",
    ".keystore",
    ".p12",
    ".pem",
    ".pfx",
    ".ppk",
];

const PROTECTED_CREDENTIAL_DATA_EXTENSIONS: &[&str] = &[
    ".conf", ".config", ".ini", ".json", ".toml", ".txt", ".xml", ".yaml", ".yml",
];

const SAFE_CREDENTIAL_FAMILY_SOURCE_EXTENSIONS: &[&str] = &[
    ".c", ".cjs", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts", ".md",
    ".mjs", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx",
];

const CREDENTIAL_WRAPPER_EXTENSIONS: &[&str] = &[
    ".conf",
    ".config",
    ".ini",
    ".json",
    ".toml",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
    ".backup",
    ".bak",
    ".bz2",
    ".copy",
    ".gz",
    ".old",
    ".orig",
    ".original",
    ".save",
    ".saved",
    ".swp",
    ".temp",
    ".tar",
    ".tgz",
    ".tmp",
    ".7z",
    ".rar",
    ".xz",
    ".zip",
    ".zst",
];

const PROTECTED_CREDENTIAL_DIRECTORY_NAMES: &[&str] = &[
    ".aws",
    ".azure",
    ".bundle",
    ".cargo",
    ".dbt",
    ".docker",
    ".gem",
    ".git",
    ".gnupg",
    ".gradle",
    ".hex",
    ".kube",
    ".m2",
    ".nuget",
    ".password-store",
    ".ssh",
    ".terraform",
    ".terraform.d",
];

const PROTECTED_CREDENTIAL_PATH_PREFIXES: &[&str] = &[
    ".config/gcloud",
    ".config/composer",
    ".config/doctl",
    ".config/gh",
    ".config/heroku",
    ".config/hub",
    ".config/op",
    ".config/pypoetry",
    ".config/rclone",
    ".config/containers",
    ".local/share/keyrings",
];

const SAFE_HIDDEN_DIRECTORY_NAMES: &[&str] = &[
    ".changeset",
    ".circleci",
    ".devcontainer",
    ".github",
    ".husky",
    ".storybook",
];

const SAFE_HIDDEN_FILE_NAMES: &[&str] = &[
    ".browserslistrc",
    ".commitlintrc",
    ".dockerignore",
    ".editorconfig",
    ".eslintignore",
    ".eslintrc",
    ".gitattributes",
    ".gitignore",
    ".lintstagedrc",
    ".markdownlint",
    ".markdownlintignore",
    ".node-version",
    ".npmignore",
    ".nvmrc",
    ".prettierignore",
    ".prettierrc",
    ".python-version",
    ".ruby-version",
    ".swiftlint.yml",
    ".stylelintrc",
    ".tool-versions",
    ".watchmanconfig",
];

const SAFE_HIDDEN_CONFIG_BASES: &[&str] = &[
    ".commitlintrc",
    ".eslintrc",
    ".lintstagedrc",
    ".markdownlint",
    ".prettierrc",
    ".stylelintrc",
];

const SAFE_HIDDEN_CONFIG_EXTENSIONS: &[&str] = &[".cjs", ".js", ".json", ".mjs", ".yaml", ".yml"];

/// `path.extname`-equivalent (a leading dot is not an extension).
fn extname(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 => &name[index..],
        _ => "",
    }
}

const BACKUP_SUFFIXES: &[&str] = &[
    "backup", "bak", "copy", "old", "orig", "original", "save", "saved", "swp", "temp", "tmp",
];

/// Emulates the TS `/ [._-](?:backup|bak|copy|old|orig|original|save|saved|swp|temp|tmp)(?=[._-]|$)/gu`
/// removal (lookahead is rewritten as an explicit end-or-separator check).
fn strip_backup_suffixes(mut candidate: String) -> String {
    loop {
        let mut changed = false;
        let bytes = candidate.as_bytes();
        let mut index = 0usize;
        while index < bytes.len() {
            if !matches!(bytes[index], b'.' | b'_' | b'-') {
                index += 1;
                continue;
            }
            let rest = &candidate[index + 1..];
            let mut matched: Option<usize> = None;
            for suffix in BACKUP_SUFFIXES {
                if let Some(after) = rest.strip_prefix(suffix) {
                    let at_end = after.is_empty();
                    let followed_by_separator = after.starts_with(['.', '_', '-']);
                    if at_end || followed_by_separator {
                        matched = Some(suffix.len());
                        break;
                    }
                }
            }
            if let Some(len) = matched {
                candidate.replace_range(index..index + 1 + len, "");
                changed = true;
                break;
            }
            index += 1;
        }
        if !changed {
            break;
        }
    }
    candidate
}

/// `\p{Z}\p{Pd}\p{Pc}\u00b7\u2022\u2219+` → `_` (NFKC normalization skipped;
/// the punctuation class still collapses wide separators).
fn collapse_separators(value: &str) -> String {
    separator_re().replace_all(value, "_").into_owned()
}

fn contains_credential_family(value: &str) -> bool {
    let collapsed = collapse_separators(value);
    credential_family_res()
        .iter()
        .any(|re| re.is_match(&collapsed))
}

fn is_safe_hidden_file_name(segment: &str) -> bool {
    if SAFE_HIDDEN_FILE_NAMES.contains(&segment) {
        return true;
    }
    SAFE_HIDDEN_CONFIG_BASES.iter().any(|base| {
        SAFE_HIDDEN_CONFIG_EXTENSIONS
            .iter()
            .any(|extension| segment == format!("{base}{extension}").as_str())
    })
}

/// `isProtectedCredentialFileName` — the wrapper-extension stripping loop.
fn is_protected_credential_file_name(segment: &str) -> bool {
    let stripped = segment.replace('~', "");
    let mut candidate = strip_backup_suffixes(stripped);
    loop {
        if PROTECTED_CREDENTIAL_FILE_NAMES.contains(&candidate.as_str()) {
            return true;
        }
        let extension = extname(&candidate);
        let stem = if extension.is_empty() {
            &candidate
        } else {
            &candidate[..candidate.len() - extension.len()]
        };
        let credential_family =
            contains_credential_family(&candidate) || contains_credential_family(stem);
        if credential_family
            && (extension.is_empty()
                || extension == ".pub"
                || PROTECTED_CREDENTIAL_DATA_EXTENSIONS.contains(&extension)
                || !SAFE_CREDENTIAL_FAMILY_SOURCE_EXTENSIONS.contains(&extension))
        {
            return true;
        }
        if id_public_key_re().is_match(&candidate) {
            return false;
        }
        if PROTECTED_CREDENTIAL_FILE_EXTENSIONS.contains(&extension) {
            return true;
        }
        if extension.is_empty()
            || (!CREDENTIAL_WRAPPER_EXTENSIONS.contains(&extension)
                && !numbered_extension_re().is_match(extension))
        {
            return false;
        }
        candidate = stem.to_string();
    }
}

/// The final path kind used to decide whether hidden segments are safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalKind {
    Directory,
    File,
    Unknown,
}

/// `isProtectedCredentialPath` — keep common credential-bearing paths out of
/// every model-visible filesystem result.
pub fn is_protected_credential_path(relative_path: &str, final_kind: FinalKind) -> bool {
    if contains_high_confidence_secret_including_encodings(relative_path) {
        return true;
    }
    let raw_segments: Vec<&str> = relative_path
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty() && *segment != "." && *segment != "..")
        .collect();
    if raw_segments
        .iter()
        .any(|segment| contains_high_confidence_secret_including_encodings(segment))
    {
        return true;
    }
    let segments: Vec<String> = raw_segments.iter().map(|s| s.to_lowercase()).collect();
    if segments.iter().any(|segment| {
        segment == ".env"
            || segment.starts_with(".env.")
            || segment == ".envrc"
            || segment.starts_with(".envrc.")
            || is_protected_credential_file_name(segment)
            || PROTECTED_CREDENTIAL_DIRECTORY_NAMES.contains(&segment.as_str())
    }) {
        return true;
    }
    let last = segments.len().saturating_sub(1);
    for (index, segment) in segments.iter().enumerate() {
        if !segment.starts_with('.') {
            continue;
        }
        let is_final = index == last;
        if SAFE_HIDDEN_DIRECTORY_NAMES.contains(&segment.as_str())
            && (!is_final || final_kind == FinalKind::Directory)
        {
            continue;
        }
        if is_final && final_kind == FinalKind::File && is_safe_hidden_file_name(segment) {
            continue;
        }
        return true;
    }
    let normalized = segments.join("/");
    PROTECTED_CREDENTIAL_PATH_PREFIXES
        .iter()
        .any(|prefix| format!("/{normalized}/").contains(&format!("/{prefix}/")))
}

fn reject_protected_credential(
    root: &Path,
    full_path: &Path,
    supplied_path: &str,
    final_kind: FinalKind,
) -> Result<(), ToolExecutionError> {
    let relative = path_relative(root, full_path).to_string_lossy().to_string();
    if is_protected_credential_path(supplied_path, final_kind)
        || is_protected_credential_path(&relative, final_kind)
    {
        return Err(ToolExecutionError::Message(
            "Reading credential files is disabled to keep workspace secrets out of model context."
                .into(),
        ));
    }
    Ok(())
}

/// Node `path.relative`-compatible relative path computation. Unlike
/// `strip_prefix`, divergent absolute paths produce a `..`-climb form (matching
/// what the TS `path.relative(root, fullPath)` yields), so the canonical root
/// (`/private/var/...`) and the lexical path (`/var/...`) still share a
/// meaningful relative view on macOS.
fn path_relative(from: &Path, to: &Path) -> PathBuf {
    use std::path::Component as C;
    let from_components: Vec<C> = from.components().collect();
    let to_components: Vec<C> = to.components().collect();
    let mut common = 0usize;
    while common < from_components.len()
        && common < to_components.len()
        && from_components[common] == to_components[common]
    {
        common += 1;
    }
    let mut result = PathBuf::new();
    for _ in common..from_components.len() {
        result.push("..");
    }
    for component in &to_components[common..] {
        result.push(component.as_os_str());
    }
    result
}

/// `isEnvironmentSecretPath` — the parent agents' narrow `.env*` exclusion.
pub fn is_environment_secret_path(relative_path: &str) -> bool {
    relative_path
        .split(['\\', '/'])
        .any(|segment| segment == ".env" || segment.starts_with(".env."))
}

fn reject_environment_secret(root: &Path, full_path: &Path) -> Result<(), ToolExecutionError> {
    let relative = path_relative(root, full_path).to_string_lossy().to_string();
    if is_environment_secret_path(&relative) {
        return Err(ToolExecutionError::Message(
            "Reading .env files is disabled to keep workspace secrets out of model context.".into(),
        ));
    }
    Ok(())
}

/// `containsPrivateKeyMaterial` — refuse private-key material in reads.
fn contains_private_key_material(buffer: &[u8]) -> bool {
    let sample = String::from_utf8_lossy(buffer);
    private_key_open_re().is_match(&sample)
        || private_key_json_re().is_match(&sample)
        || contains_high_confidence_secret_including_encodings(&sample)
        || private_key_pgp_re().is_match(&sample)
        || private_key_putty_re().is_match(&sample)
        || private_key_ssh2_re().is_match(&sample)
}

fn kind_from_meta(meta: &std::fs::Metadata) -> FinalKind {
    if meta.is_dir() {
        FinalKind::Directory
    } else if meta.is_file() {
        FinalKind::File
    } else {
        FinalKind::Unknown
    }
}

fn kind_from_file_type(file_type: &std::fs::FileType) -> FinalKind {
    if file_type.is_dir() {
        FinalKind::Directory
    } else if file_type.is_file() {
        FinalKind::File
    } else {
        FinalKind::Unknown
    }
}

// ===========================================================================
// Static regexes
// ===========================================================================

// Static regex tables, built once.
static SEPARATOR_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static CREDENTIAL_FAMILY_RES: std::sync::OnceLock<Vec<Regex>> = std::sync::OnceLock::new();
static ID_PUBLIC_KEY_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static NUMBERED_EXTENSION_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static PRIVATE_KEY_OPEN_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static PRIVATE_KEY_JSON_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static PRIVATE_KEY_PGP_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static PRIVATE_KEY_PUTTY_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static PRIVATE_KEY_SSH2_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

fn separator_re() -> &'static Regex {
    SEPARATOR_RE.get_or_init(|| Regex::new(r"[\p{Z}\p{Pd}\p{Pc}\u00b7\u2022\u2219]+").unwrap())
}

fn credential_family_res() -> &'static [Regex] {
    CREDENTIAL_FAMILY_RES.get_or_init(|| {
        [
            r"(?:^|[._-])(?:auth|oauth|credentials?|creds?|passwords?|secrets?|tokens?)(?:[._-]|$)",
            r"(?:^|[._-])(?:htpasswd|passwd|pw|pwd|shadow)(?:[._-]|$)",
            r"(?:^|[._-])(?:(?:key|trust)[._-]?store|keychain|keyring|vault|wallet|logins?|kubeconfig|dockerconfigjson)(?:[._-]|$)",
            r"(?:^|[._-])client[._-]?secret(?:[._-]|$)",
            r"(?:^|[._-])service[._-]?account(?:[._-]|$)",
            r"(?:^|[._-])(?:adc|sp|service[._-]?principal)(?:[._-]|$)",
            r"(?:^|[._-])(?:pat|personal[._-]?access[._-]?tokens?)(?:[._-]|$)",
            r"(?:^|[-_])(?:gpg|pgp|putty)(?:[-_]|$)",
            r"(?:^|[._-])(?:(?:api|access|auth|bearer|consumer|private|refresh|secret)[._-]?)?(?:keys?|tokens?)(?:[._-]|$)",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).unwrap())
        .collect()
    })
}

fn id_public_key_re() -> &'static Regex {
    ID_PUBLIC_KEY_RE
        .get_or_init(|| Regex::new(r"^id_(?:dsa|ecdsa|ed25519|rsa)(?:_sk)?\.pub$").unwrap())
}

fn numbered_extension_re() -> &'static Regex {
    NUMBERED_EXTENSION_RE.get_or_init(|| Regex::new(r"^\.\d{1,14}$").unwrap())
}

fn private_key_open_re() -> &'static Regex {
    PRIVATE_KEY_OPEN_RE
        .get_or_init(|| Regex::new(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----").unwrap())
}

fn private_key_json_re() -> &'static Regex {
    PRIVATE_KEY_JSON_RE.get_or_init(|| Regex::new(r#""private_key"\s*:\s*"-----BEGIN"#).unwrap())
}

fn private_key_pgp_re() -> &'static Regex {
    PRIVATE_KEY_PGP_RE.get_or_init(|| Regex::new(r"-----BEGIN PGP PRIVATE KEY BLOCK-----").unwrap())
}

fn private_key_putty_re() -> &'static Regex {
    PRIVATE_KEY_PUTTY_RE.get_or_init(|| Regex::new(r"(?m)^PuTTY-User-Key-File-[123]:").unwrap())
}

fn private_key_ssh2_re() -> &'static Regex {
    PRIVATE_KEY_SSH2_RE
        .get_or_init(|| Regex::new(r"---- BEGIN SSH2 (?:ENCRYPTED )?PRIVATE KEY ----").unwrap())
}

// ===========================================================================
// Glob → restricted regex
// ===========================================================================

/// `restrictedGlobToRegex` — a bounded, linear-time glob matcher (no
/// backreferences, no catastrophic backtracking).
fn restricted_glob_to_regex(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut source = String::from("^");
    let mut index = 0usize;
    while index < chars.len() {
        let character = chars[index];
        if character == '*' {
            let mut end = index;
            while end + 1 < chars.len() && chars[end + 1] == '*' {
                end += 1;
            }
            let is_globstar = end > index;
            index = end;
            if is_globstar && index + 1 < chars.len() && chars[index + 1] == '/' {
                source.push_str("(?:[^/]+/)*");
                index += 1;
            } else {
                source.push_str(if is_globstar { "[^\\x00]*" } else { "[^/]*" });
            }
            index += 1;
            continue;
        }
        if character == '?' {
            source.push_str("[^/]");
            index += 1;
            continue;
        }
        if matches!(
            character,
            '\\' | '^' | '$' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
        ) {
            source.push('\\');
        }
        source.push(character);
        index += 1;
    }
    source.push('$');
    source
}

// ===========================================================================
// The tool executor
// ===========================================================================

fn required_str(args: &Value, key: &str) -> Result<String, ToolExecutionError> {
    match args.get(key).and_then(Value::as_str) {
        Some(value) => Ok(value.to_string()),
        None => Err(ToolExecutionError::Message(format!(
            "Missing string argument \"{key}\"."
        ))),
    }
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

/// The folder-scoped executor: real `tokio::fs` implementations for every
/// tool, with the shell tool gated behind the approval policy.
pub struct CodingToolExecutor {
    workspace: WorkspaceRoot,
    defs: Vec<CodingTool>,
    subagent: bool,
    policy: Arc<dyn ApprovalPolicy>,
}

/// `buildCodingTools` — parent (main agent) executor. `policy` gates the
/// mutating tools; pass [`AllowAllApprovalPolicy`](crate::approval::AllowAllApprovalPolicy)
/// for tests or an explicit opt-in.
pub fn build_coding_tool_executor(
    root: PathBuf,
    policy: Arc<dyn ApprovalPolicy>,
) -> CodingToolExecutor {
    CodingToolExecutor {
        workspace: WorkspaceRoot::new(root),
        defs: parent_coding_tool_defs(),
        subagent: false,
        policy,
    }
}

/// `buildSubagentCodingTools` — pinned read-only child executor.
pub fn build_subagent_coding_tool_executor(
    root: PathBuf,
    allowed: &[&str],
) -> Result<CodingToolExecutor, ToolExecutionError> {
    Ok(CodingToolExecutor {
        workspace: WorkspaceRoot::pin(root)?,
        defs: subagent_coding_tool_defs(allowed),
        subagent: true,
        policy: Arc::new(DenyAllApprovalPolicy::new()),
    })
}

impl CodingToolExecutor {
    fn root(&self) -> &Path {
        &self.workspace.lexical
    }

    async fn verify_root_async(&self) -> Result<PathBuf, ToolExecutionError> {
        verify_workspace_root(&self.workspace).await
    }

    async fn read_file(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let supplied = required_str(&call.arguments, "path")?;
        if self.subagent {
            let lexical = resolve_in_root(self.root(), &supplied)?;
            let real_root = self.verify_root_async().await?;
            reject_protected_credential(&real_root, &lexical, &supplied, FinalKind::File)?;
            let (buffer, truncated) = read_bounded_verified_file(
                &self.workspace,
                &real_root,
                &lexical,
                &supplied,
                MAX_READ_BYTES,
            )
            .await?;
            let text = String::from_utf8_lossy(&buffer);
            let result = if truncated {
                format!("{text}\n… [truncated]")
            } else if text.is_empty() {
                "[empty file]".to_string()
            } else {
                text.to_string()
            };
            Ok(ToolOutput::text(result))
        } else {
            let (real_root, full) = resolve_existing_in_root(&self.workspace, &supplied).await?;
            reject_environment_secret(&real_root, &full)?;
            let buffer = tokio::fs::read(&full).await.map_err(|_| {
                ToolExecutionError::Message(format!("Path \"{supplied}\" could not be read."))
            })?;
            let text = String::from_utf8_lossy(&buffer[..buffer.len().min(MAX_READ_BYTES)]);
            let result = if buffer.len() > MAX_READ_BYTES {
                format!("{text}\n… [truncated]")
            } else if text.is_empty() {
                "[empty file]".to_string()
            } else {
                text.to_string()
            };
            Ok(ToolOutput::text(result))
        }
    }

    async fn list_dir(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let supplied = optional_str(&call.arguments, "path").unwrap_or_else(|| ".".to_string());
        if self.subagent {
            let (real_root, full) = resolve_existing_in_root(&self.workspace, &supplied).await?;
            reject_protected_credential(&real_root, &full, &supplied, FinalKind::Directory)?;
            let mut directory = self.open_verified_dir(&full).await.map_err(|_| {
                ToolExecutionError::Message(format!("Path \"{supplied}\" could not be listed."))
            })?;
            let mut names: Vec<String> = Vec::new();
            let mut truncated = false;
            let mut scan_truncated = false;
            let mut scanned = 0usize;
            loop {
                match directory.next_entry().await {
                    Ok(Some(entry)) => {
                        scanned += 1;
                        if scanned > MAX_LIST_SCAN_ENTRIES {
                            scan_truncated = true;
                            break;
                        }
                        if scanned > MAX_LIST_ENTRIES {
                            truncated = true;
                        }
                        retain_lexicographically_smallest(
                            &mut names,
                            entry.file_name().to_string_lossy().to_string(),
                            MAX_LIST_ENTRIES,
                        );
                    }
                    Ok(None) => break,
                    Err(_) => {
                        return Err(ToolExecutionError::Message(format!(
                            "Path \"{supplied}\" could not be listed."
                        )));
                    }
                }
            }
            let mut lines: Vec<String> = Vec::new();
            let mut skipped_inputs = false;
            for name in &names {
                let entry_path = full.join(name);
                let supplied_entry = format!("{supplied}/{name}");
                let entry_kind = tokio::fs::symlink_metadata(&entry_path)
                    .await
                    .map(|meta| kind_from_meta(&meta))
                    .unwrap_or(FinalKind::Unknown);
                if is_protected_credential_path(&supplied_entry, entry_kind) {
                    skipped_inputs = true;
                    continue;
                }
                let is_symlink = tokio::fs::symlink_metadata(&entry_path)
                    .await
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false);
                if is_symlink {
                    skipped_inputs = true;
                    continue;
                }
                let verified = async {
                    verify_workspace_root(&self.workspace).await?;
                    let first_real = tokio::fs::canonicalize(&entry_path).await.map_err(|_| {
                        ToolExecutionError::Message(format!(
                            "Path \"{supplied_entry}\" could not be resolved."
                        ))
                    })?;
                    assert_real_path_in_root(&real_root, &first_real, &supplied_entry)?;
                    let first_stat = tokio::fs::metadata(&first_real).await.map_err(|_| {
                        ToolExecutionError::Message(format!(
                            "Path \"{supplied_entry}\" could not be inspected."
                        ))
                    })?;
                    let second_real = tokio::fs::canonicalize(&entry_path).await.map_err(|_| {
                        ToolExecutionError::Message(format!(
                            "Path \"{supplied_entry}\" could not be resolved."
                        ))
                    })?;
                    assert_real_path_in_root(&real_root, &second_real, &supplied_entry)?;
                    let second_stat = tokio::fs::metadata(&second_real).await.map_err(|_| {
                        ToolExecutionError::Message(format!(
                            "Path \"{supplied_entry}\" could not be inspected."
                        ))
                    })?;
                    verify_workspace_root(&self.workspace).await?;
                    Ok::<_, ToolExecutionError>((first_real, first_stat, second_real, second_stat))
                }
                .await;
                match verified {
                    Ok((first_real, first_stat, second_real, second_stat)) => {
                        if first_real != second_real
                            || !same_metadata(&first_stat, &second_stat)
                            || (!second_stat.is_dir() && !second_stat.is_file())
                        {
                            skipped_inputs = true;
                            continue;
                        }
                        let second_kind = kind_from_meta(&second_stat);
                        if reject_protected_credential(
                            &real_root,
                            &second_real,
                            &supplied_entry,
                            second_kind,
                        )
                        .is_err()
                        {
                            skipped_inputs = true;
                            continue;
                        }
                        let label = if second_stat.is_dir() { "dir" } else { "file" };
                        lines.push(format!("{label}  {name}"));
                    }
                    Err(_) => {
                        skipped_inputs = true;
                    }
                }
            }
            lines.sort();
            let mut warnings: Vec<String> = Vec::new();
            if truncated {
                warnings.push(format!("… [truncated at {MAX_LIST_ENTRIES} entries]"));
            }
            if scan_truncated {
                warnings.push(format!(
                    "… [listing scan stopped after {MAX_LIST_SCAN_ENTRIES} entries]"
                ));
            }
            if skipped_inputs {
                warnings.push(
                    "… [listing incomplete: linked, changed, unreadable, or non-regular entries skipped]"
                        .to_string(),
                );
            }
            Ok(ToolOutput::text(format_bounded_search_result(
                &lines,
                "[empty directory]",
                &warnings,
            )))
        } else {
            let (_, full) = resolve_existing_in_root(&self.workspace, &supplied).await?;
            let mut entries = tokio::fs::read_dir(&full).await.map_err(|_| {
                ToolExecutionError::Message(format!("Path \"{supplied}\" could not be listed."))
            })?;
            let mut lines: Vec<String> = Vec::new();
            loop {
                match entries.next_entry().await {
                    Ok(Some(entry)) => {
                        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                        let label = if is_dir { "dir" } else { "file" };
                        lines.push(format!("{label}  {}", entry.file_name().to_string_lossy()));
                    }
                    Ok(None) => break,
                    Err(_) => {
                        return Err(ToolExecutionError::Message(format!(
                            "Path \"{supplied}\" could not be listed."
                        )));
                    }
                }
            }
            lines.sort();
            Ok(ToolOutput::text(if lines.is_empty() {
                "[empty directory]".to_string()
            } else {
                lines.join("\n")
            }))
        }
    }

    async fn open_verified_dir(
        &self,
        dir: &Path,
    ) -> Result<tokio::fs::ReadDir, ToolExecutionError> {
        open_verified_directory(&self.workspace, dir).await
    }

    async fn glob(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let pattern = required_str(&call.arguments, "pattern")?;
        if pattern.len() > MAX_SEARCH_PATTERN_CHARS {
            return Err(ToolExecutionError::Message(format!(
                "Glob pattern must be at most {MAX_SEARCH_PATTERN_CHARS} characters."
            )));
        }
        let matcher = Regex::new(&restricted_glob_to_regex(&pattern))
            .map_err(|e| ToolExecutionError::Message(format!("Invalid glob expression: {e}")))?;
        if self.subagent {
            self.glob_subagent(&matcher).await
        } else {
            self.glob_parent(&matcher).await
        }
    }

    async fn glob_subagent(&self, matcher: &Regex) -> Result<ToolOutput, ToolExecutionError> {
        let real_root = verify_workspace_root(&self.workspace).await?;
        let mut matches: Vec<String> = Vec::new();
        let mut match_truncated = false;
        let mut traversal_truncated = false;
        let mut skipped_inputs = false;
        let mut visited = 0usize;
        let mut pending: Vec<String> = vec![String::new()];
        let mut index = 0usize;

        'traversal: while index < pending.len() {
            let relative_directory = pending[index].clone();
            index += 1;
            let directory_path = self.root().join(&relative_directory);
            let mut directory =
                match open_verified_directory(&self.workspace, &directory_path).await {
                    Ok(dir) => dir,
                    Err(_) => {
                        skipped_inputs = true;
                        continue;
                    }
                };
            let mut entries: Vec<tokio::fs::DirEntry> = Vec::new();
            let remaining_entry_budget = MAX_GLOB_ENTRIES.saturating_sub(visited);
            loop {
                match directory.next_entry().await {
                    Ok(Some(entry)) => {
                        entries.push(entry);
                        if entries.len() > remaining_entry_budget {
                            entries.clear();
                            traversal_truncated = true;
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        skipped_inputs = true;
                        break;
                    }
                }
            }
            if traversal_truncated {
                break;
            }
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                visited += 1;
                let is_symlink = entry
                    .file_type()
                    .await
                    .map(|t| t.is_symlink())
                    .unwrap_or(true);
                if is_symlink {
                    skipped_inputs = true;
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let relative_path = if relative_directory.is_empty() {
                    name.clone()
                } else {
                    format!("{relative_directory}/{name}")
                };
                let glob_path = relative_path.replace('\\', "/");
                let entry_kind = entry
                    .file_type()
                    .await
                    .map(|ft| kind_from_file_type(&ft))
                    .unwrap_or(FinalKind::Unknown);
                if is_protected_credential_path(&relative_path, entry_kind) {
                    skipped_inputs = true;
                    continue;
                }
                let lexical = resolve_in_root(self.root(), &relative_path)?;
                let stat = match self
                    .verified_entry_access(&lexical, &real_root, &relative_path)
                    .await
                {
                    Ok(stat) => stat,
                    Err(_) => {
                        skipped_inputs = true;
                        continue;
                    }
                };
                if matcher.is_match(&glob_path) {
                    matches.push(glob_path);
                    if matches.len() > MAX_GLOB_MATCHES {
                        matches.pop();
                        match_truncated = true;
                        break 'traversal;
                    }
                }
                if stat.is_dir() {
                    if SKIP_DIRS.contains(&name.as_str()) {
                        skipped_inputs = true;
                    } else {
                        pending.push(relative_path.clone());
                    }
                }
            }
        }
        matches.sort();
        let mut warnings: Vec<String> = Vec::new();
        if match_truncated {
            warnings.push(format!("… [truncated at {MAX_GLOB_MATCHES} matches]"));
        }
        if traversal_truncated {
            warnings.push(format!("… [truncated after {MAX_GLOB_ENTRIES} entries]"));
        }
        if skipped_inputs {
            warnings.push(
                "… [search incomplete: linked, protected, ignored, unreadable, or non-regular paths skipped]"
                    .to_string(),
            );
        }
        Ok(ToolOutput::text(format_bounded_search_result(
            &matches,
            "[no matches]",
            &warnings,
        )))
    }

    async fn glob_parent(&self, matcher: &Regex) -> Result<ToolOutput, ToolExecutionError> {
        let (real_root, _) = resolve_existing_in_root(&self.workspace, ".").await?;
        let mut matches: Vec<String> = Vec::new();
        let mut skipped_inputs = false;
        let mut visited = 0usize;
        let mut pending: Vec<PathBuf> = vec![self.root().to_path_buf()];
        let mut index = 0usize;

        'traversal: while index < pending.len() {
            let dir = pending[index].clone();
            index += 1;
            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(entries) => entries,
                Err(_) => {
                    skipped_inputs = true;
                    continue;
                }
            };
            loop {
                match entries.next_entry().await {
                    Ok(Some(entry)) => {
                        visited += 1;
                        // Safety bound replacing Node's unbounded fs.glob.
                        if visited > MAX_GLOB_ENTRIES {
                            skipped_inputs = true;
                            break 'traversal;
                        }
                        let is_symlink = entry
                            .file_type()
                            .await
                            .map(|t| t.is_symlink())
                            .unwrap_or(true);
                        if is_symlink {
                            skipped_inputs = true;
                            continue;
                        }
                        let name = entry.file_name().to_string_lossy().to_string();
                        let rel = dir
                            .strip_prefix(self.root())
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let relative_path = if rel.is_empty() {
                            name.clone()
                        } else {
                            format!("{rel}/{name}")
                        };
                        if is_environment_secret_path(&relative_path) {
                            continue;
                        }
                        let lexical = resolve_in_root(self.root(), &relative_path)?;
                        let real = match tokio::fs::canonicalize(&lexical).await {
                            Ok(real) => real,
                            Err(_) => {
                                skipped_inputs = true;
                                continue;
                            }
                        };
                        if assert_real_path_in_root(&real_root, &real, &relative_path).is_err() {
                            skipped_inputs = true;
                            continue;
                        }
                        let real_rel = real
                            .strip_prefix(&real_root)
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();
                        if is_environment_secret_path(&real_rel) {
                            continue;
                        }
                        if matcher.is_match(&relative_path) {
                            matches.push(relative_path.clone());
                            if matches.len() >= MAX_GLOB_MATCHES {
                                break 'traversal;
                            }
                        }
                        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                        if is_dir {
                            pending.push(entry.path());
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        skipped_inputs = true;
                        break;
                    }
                }
            }
        }
        matches.sort();
        let warnings: Vec<String> = if skipped_inputs {
            vec![
                "… [search incomplete: linked, protected, ignored, unreadable, or non-regular paths skipped]"
                    .to_string(),
            ]
        } else {
            Vec::new()
        };
        Ok(ToolOutput::text(format_bounded_search_result(
            &matches,
            "[no matches]",
            &warnings,
        )))
    }

    /// Verify one entry access: realpath + stat, double-checked, credential
    /// guarded, staying inside the pinned root.
    async fn verified_entry_access(
        &self,
        lexical: &Path,
        real_root: &Path,
        supplied: &str,
    ) -> Result<std::fs::Metadata, ToolExecutionError> {
        verify_workspace_root(&self.workspace).await?;
        let real_path = tokio::fs::canonicalize(lexical).await.map_err(|_| {
            ToolExecutionError::Message(format!("Path \"{supplied}\" could not be resolved."))
        })?;
        assert_real_path_in_root(real_root, &real_path, supplied)?;
        let stat = tokio::fs::metadata(&real_path).await.map_err(|_| {
            ToolExecutionError::Message(format!("Path \"{supplied}\" could not be inspected."))
        })?;
        let verified_kind = kind_from_meta(&stat);
        reject_protected_credential(real_root, &real_path, supplied, verified_kind)?;
        verify_workspace_root(&self.workspace).await?;
        if !stat.is_dir() && !stat.is_file() {
            return Err(ToolExecutionError::Message(
                "The requested path is not a regular file or directory.".into(),
            ));
        }
        Ok(stat)
    }

    async fn grep(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let pattern = required_str(&call.arguments, "pattern")?;
        if pattern.len() > MAX_SEARCH_PATTERN_CHARS {
            return Err(ToolExecutionError::Message(format!(
                "Search pattern must be at most {MAX_SEARCH_PATTERN_CHARS} characters."
            )));
        }
        let re = match Regex::new(&pattern) {
            Ok(re) => re,
            Err(e) => {
                return Err(ToolExecutionError::Message(format!(
                    "Invalid RE2 regular expression: {e}"
                )));
            }
        };
        let supplied_dir = optional_str(&call.arguments, "path").unwrap_or_else(|| ".".to_string());
        if self.subagent {
            let (real_root, start) =
                resolve_existing_in_root(&self.workspace, &supplied_dir).await?;
            reject_protected_credential(&real_root, &start, &supplied_dir, FinalKind::Directory)?;
            let mut out: Vec<String> = Vec::new();
            let mut budget = GrepBudget::new();
            self.grep_subagent_dir(&start, &real_root, &re, &mut out, &mut budget)
                .await?;
            let mut warnings: Vec<String> = Vec::new();
            if budget.match_truncated {
                warnings.push(format!("… [truncated at {MAX_GREP_MATCHES} matches]"));
            }
            if budget.exhausted {
                warnings.push(format!("… [truncated after {MAX_GREP_ENTRIES} entries]"));
            }
            if budget.bytes_exhausted {
                warnings.push(format!("… [truncated after {MAX_GREP_BYTES} bytes]"));
            }
            if budget.timed_out {
                warnings.push(format!("… [truncated after {MAX_GREP_DURATION_MS} ms]"));
            }
            if budget.skipped_inputs {
                warnings.push(
                    "… [search incomplete: hidden, linked, oversized, unreadable, or non-regular paths skipped]"
                        .to_string(),
                );
            }
            Ok(ToolOutput::text(format_bounded_search_result(
                &out,
                "[no matches]",
                &warnings,
            )))
        } else {
            let (real_root, start) =
                resolve_existing_in_root(&self.workspace, &supplied_dir).await?;
            let mut out: Vec<String> = Vec::new();
            self.grep_parent_dir(&start, &real_root, &re, &mut out)
                .await?;
            Ok(ToolOutput::text(if out.is_empty() {
                "[no matches]".to_string()
            } else {
                out.join("\n")
            }))
        }
    }

    async fn grep_parent_dir(
        &self,
        dir: &Path,
        root: &Path,
        regex: &Regex,
        out: &mut Vec<String>,
    ) -> Result<(), ToolExecutionError> {
        if out.len() >= MAX_GREP_MATCHES {
            return Ok(());
        }
        let mut entries = tokio::fs::read_dir(dir).await.map_err(|_| {
            ToolExecutionError::Message("A directory could not be read during the search.".into())
        })?;
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => {
                    if out.len() >= MAX_GREP_MATCHES {
                        return Ok(());
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') {
                        continue;
                    }
                    let is_symlink = entry
                        .file_type()
                        .await
                        .map(|t| t.is_symlink())
                        .unwrap_or(true);
                    if is_symlink {
                        continue;
                    }
                    let full = entry.path();
                    let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                    if is_dir {
                        if SKIP_DIRS.contains(&name.as_str()) {
                            continue;
                        }
                        Box::pin(self.grep_parent_dir(&full, root, regex, out)).await?;
                        continue;
                    }
                    let is_file = entry
                        .file_type()
                        .await
                        .map(|t| t.is_file())
                        .unwrap_or(false);
                    if !is_file {
                        continue;
                    }
                    let stat = match tokio::fs::metadata(&full).await {
                        Ok(stat) => stat,
                        Err(_) => continue,
                    };
                    if stat.len() > 512_000 {
                        continue;
                    }
                    let content = match tokio::fs::read_to_string(&full).await {
                        Ok(content) => content,
                        Err(_) => continue,
                    };
                    let relative_path = full
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| full.to_string_lossy().to_string());
                    for (line_index, line) in content.split('\n').enumerate() {
                        if regex.is_match(line) {
                            out.push(format!(
                                "{}:{}: {}",
                                relative_path,
                                line_index + 1,
                                line.trim().chars().take(200).collect::<String>()
                            ));
                            if out.len() >= MAX_GREP_MATCHES {
                                return Ok(());
                            }
                        }
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    return Err(ToolExecutionError::Message(
                        "A directory could not be read during the search.".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    async fn grep_subagent_dir(
        &self,
        dir: &Path,
        root: &Path,
        re: &Regex,
        out: &mut Vec<String>,
        budget: &mut GrepBudget,
    ) -> Result<(), ToolExecutionError> {
        if budget.match_truncated || budget.exhausted || budget.bytes_exhausted || budget.timed_out
        {
            return Ok(());
        }
        let mut directory = match open_verified_directory(&self.workspace, dir).await {
            Ok(dir) => dir,
            Err(_) => {
                budget.skipped_inputs = true;
                return Ok(());
            }
        };
        let mut entries: Vec<tokio::fs::DirEntry> = Vec::new();
        let remaining_entry_budget = MAX_GREP_ENTRIES.saturating_sub(budget.visited);
        loop {
            if budget.deadline_reached() {
                budget.timed_out = true;
                break;
            }
            match directory.next_entry().await {
                Ok(Some(entry)) => {
                    entries.push(entry);
                    if entries.len() > remaining_entry_budget {
                        entries.clear();
                        budget.exhausted = true;
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    budget.skipped_inputs = true;
                    return Ok(());
                }
            }
        }
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if budget.deadline_reached() {
                budget.timed_out = true;
                return Ok(());
            }
            if budget.match_truncated || budget.bytes_exhausted {
                return Ok(());
            }
            budget.visited += 1;
            let is_symlink = entry
                .file_type()
                .await
                .map(|t| t.is_symlink())
                .unwrap_or(true);
            if is_symlink {
                budget.skipped_inputs = true;
                continue;
            }
            let full = entry.path();
            let rel = full
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| full.to_string_lossy().to_string());
            let entry_kind = entry
                .file_type()
                .await
                .map(|ft| kind_from_file_type(&ft))
                .unwrap_or(FinalKind::Unknown);
            if is_protected_credential_path(&rel, entry_kind) {
                budget.skipped_inputs = true;
                continue;
            }
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                let name = entry.file_name().to_string_lossy().to_string();
                if SKIP_DIRS.contains(&name.as_str()) {
                    budget.skipped_inputs = true;
                    continue;
                }
                Box::pin(self.grep_subagent_dir(&full, root, re, out, budget)).await?;
                continue;
            }
            let is_file = entry
                .file_type()
                .await
                .map(|t| t.is_file())
                .unwrap_or(false);
            if !is_file {
                budget.skipped_inputs = true;
                continue;
            }
            let remaining_bytes = MAX_GREP_BYTES.saturating_sub(budget.bytes_read);
            if remaining_bytes == 0 {
                budget.bytes_exhausted = true;
                return Ok(());
            }
            let per_file_limit = remaining_bytes.min(512_000);
            let (buffer, truncated) = match read_bounded_verified_file(
                &self.workspace,
                root,
                &full,
                &rel,
                per_file_limit,
            )
            .await
            {
                Ok(read) => read,
                Err(_) => {
                    budget.skipped_inputs = true;
                    continue;
                }
            };
            budget.bytes_read += buffer.len();
            if truncated {
                if per_file_limit < 512_000 {
                    budget.bytes_exhausted = true;
                } else {
                    budget.skipped_inputs = true;
                }
                continue;
            }
            let content = String::from_utf8_lossy(&buffer);
            for (i, line) in content.split('\n').enumerate() {
                if i % 128 == 0 && budget.deadline_reached() {
                    budget.timed_out = true;
                    return Ok(());
                }
                if re.is_match(line) {
                    if out.len() >= MAX_GREP_MATCHES {
                        budget.match_truncated = true;
                        return Ok(());
                    }
                    let result_line = format!(
                        "{rel}:{}: {}",
                        i + 1,
                        line.trim().chars().take(200).collect::<String>()
                    );
                    if contains_high_confidence_secret_including_encodings(&result_line) {
                        budget.skipped_inputs = true;
                        continue;
                    }
                    out.push(result_line);
                }
            }
        }
        Ok(())
    }

    async fn write_file(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let supplied = required_str(&call.arguments, "path")?;
        let content = required_str(&call.arguments, "content")?;
        let full = resolve_writable_in_root(&self.workspace, &supplied).await?;
        tokio::fs::write(&full, content.as_bytes())
            .await
            .map_err(|_| {
                ToolExecutionError::Message(format!("Path \"{supplied}\" could not be written."))
            })?;
        Ok(ToolOutput::text(format!(
            "Wrote {} chars to {supplied}.",
            content.chars().count()
        )))
    }

    async fn edit_file(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let supplied = required_str(&call.arguments, "path")?;
        let old_string = required_str(&call.arguments, "old_string")?;
        let new_string = required_str(&call.arguments, "new_string")?;
        let (_, full) = resolve_existing_in_root(&self.workspace, &supplied).await?;
        let original = tokio::fs::read_to_string(&full).await.map_err(|_| {
            ToolExecutionError::Message(format!("Path \"{supplied}\" could not be read."))
        })?;
        let count = original.split(&old_string).count() - 1;
        if count == 0 {
            return Err(ToolExecutionError::Message(format!(
                "old_string not found in {supplied}."
            )));
        }
        if count > 1 {
            return Err(ToolExecutionError::Message(format!(
                "old_string is not unique in {supplied} ({count} matches). Add more context."
            )));
        }
        let replaced = original.replace(&old_string, &new_string);
        tokio::fs::write(&full, replaced.as_bytes())
            .await
            .map_err(|_| {
                ToolExecutionError::Message(format!("Path \"{supplied}\" could not be written."))
            })?;
        Ok(ToolOutput::text(format!("Edited {supplied}.")))
    }

    async fn run_command(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let command = required_str(&call.arguments, "command")?;
        // The shell tool is gated behind the approval policy (default deny-all
        // in this crate; the UI wires real approval later). This is defense in
        // depth on top of the runner-level gate.
        match self.policy.evaluate(call) {
            ApprovalVerdict::Allow => {}
            ApprovalVerdict::Ask(request) => {
                if self.policy.resolve(&request.approval_id).await.is_err() {
                    return Err(ToolExecutionError::Message(
                        "Command execution was denied by the approval policy.".into(),
                    ));
                }
            }
            ApprovalVerdict::Deny { .. } => {
                return Err(ToolExecutionError::Message(
                    "Command execution was denied by the approval policy.".into(),
                ));
            }
        }
        verify_workspace_root(&self.workspace).await?;
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(&command)
            .current_dir(self.root())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().map_err(|e| {
            ToolExecutionError::Message(format!("Command could not be started: {e}"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ToolExecutionError::Message("Command stdout was not captured.".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ToolExecutionError::Message("Command stderr was not captured.".into())
        })?;

        let capture = Arc::new(OutputCapture::new());
        let out_task = tokio::spawn(read_capped(stdout, capture.clone(), false));
        let err_task = tokio::spawn(read_capped(stderr, capture.clone(), true));

        let timeout = tokio::time::sleep(Duration::from_millis(COMMAND_TIMEOUT_MS));
        tokio::pin!(timeout);
        let mut timed_out = false;
        let mut exit_code: Option<i32> = None;
        loop {
            tokio::select! {
                result = child.wait() => {
                    exit_code = result.ok().and_then(|status| status.code());
                    break;
                }
                _ = &mut timeout => {
                    timed_out = true;
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    break;
                }
                _ = capture.exceeded_notified() => {
                    // Output cap reached: kill the process group so a
                    // never-ending producer cannot block the loop.
                    let _ = child.start_kill();
                }
            }
        }
        let _ = out_task.await;
        let _ = err_task.await;
        let output_exceeded = capture.exceeded();
        let (stdout_bytes, stderr_bytes) = capture.take_parts().await;

        let stdout_text = String::from_utf8_lossy(&stdout_bytes).to_string();
        let stderr_text = String::from_utf8_lossy(&stderr_bytes).to_string();
        let combined = [stdout_text.as_str(), stderr_text.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();

        if exit_code == Some(0) && !timed_out && !output_exceeded {
            let body = if combined.is_empty() {
                "[no output]".to_string()
            } else {
                combined
            };
            return Ok(ToolOutput::text(truncate(&body, MAX_OUTPUT_CHARS)));
        }
        let reason = if timed_out {
            "Command timed out.".to_string()
        } else if output_exceeded {
            "Command exceeded the output limit.".to_string()
        } else {
            format!(
                "Command exited with error (code {}).",
                exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "?".to_string())
            )
        };
        let body = if combined.is_empty() {
            String::new()
        } else {
            format!("\n{combined}")
        };
        Ok(ToolOutput::text(truncate(
            &format!("{reason}{body}"),
            MAX_OUTPUT_CHARS,
        )))
    }
}

/// `retainLexicographicallySmallest` — keep the smallest `limit` names in a
/// sorted vec (deterministic subset when a directory exceeds the cap).
fn retain_lexicographically_smallest(entries: &mut Vec<String>, name: String, limit: usize) {
    let mut low = 0usize;
    let mut high = entries.len();
    while low < high {
        let middle = (low + high) / 2;
        if entries[middle] <= name {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if low >= limit {
        return;
    }
    entries.insert(low, name);
    if entries.len() > limit {
        entries.pop();
    }
}

struct OutputCapture {
    data: tokio::sync::Mutex<Captured>,
    streamed: AtomicU64,
    exceeded: AtomicBool,
    exceeded_notify: tokio::sync::Notify,
}

struct Captured {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stored: usize,
}

impl OutputCapture {
    fn new() -> Self {
        Self {
            data: tokio::sync::Mutex::new(Captured {
                stdout: Vec::new(),
                stderr: Vec::new(),
                stored: 0,
            }),
            streamed: AtomicU64::new(0),
            exceeded: AtomicBool::new(false),
            exceeded_notify: tokio::sync::Notify::new(),
        }
    }

    /// A future that completes once the output cap is exceeded.
    fn exceeded_notified(&self) -> tokio::sync::futures::Notified<'_> {
        self.exceeded_notify.notified()
    }

    /// Append a chunk (prefix-truncated at the shared cap). Returns false once
    /// the cumulative streamed bytes exceed the cap.
    async fn push(&self, is_stderr: bool, chunk: &[u8]) -> bool {
        let streamed = self
            .streamed
            .fetch_add(chunk.len() as u64, Ordering::SeqCst)
            + chunk.len() as u64;
        let mut data = self.data.lock().await;
        let remaining =
            MAX_COMMAND_OUTPUT_BYTES.saturating_sub(data.stored.min(MAX_COMMAND_OUTPUT_BYTES));
        let take = chunk.len().min(remaining);
        if take > 0 {
            let target = if is_stderr {
                &mut data.stderr
            } else {
                &mut data.stdout
            };
            target.extend_from_slice(&chunk[..take]);
            data.stored += take;
        }
        if streamed > MAX_COMMAND_OUTPUT_BYTES as u64 {
            self.exceeded.store(true, Ordering::SeqCst);
            self.exceeded_notify.notify_one();
        }
        !self.exceeded.load(Ordering::SeqCst)
    }

    fn exceeded(&self) -> bool {
        self.exceeded.load(Ordering::SeqCst)
    }

    async fn take_parts(&self) -> (Vec<u8>, Vec<u8>) {
        let mut data = self.data.lock().await;
        (
            std::mem::take(&mut data.stdout),
            std::mem::take(&mut data.stderr),
        )
    }
}

async fn read_capped<R: AsyncReadExt + Unpin>(
    mut reader: R,
    capture: Arc<OutputCapture>,
    is_stderr: bool,
) {
    let mut buffer = vec![0u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                if !capture.push(is_stderr, &buffer[..n]).await {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

struct GrepBudget {
    visited: usize,
    bytes_read: usize,
    deadline: Instant,
    exhausted: bool,
    match_truncated: bool,
    bytes_exhausted: bool,
    timed_out: bool,
    skipped_inputs: bool,
}

impl GrepBudget {
    fn new() -> Self {
        Self {
            visited: 0,
            bytes_read: 0,
            deadline: Instant::now() + Duration::from_millis(MAX_GREP_DURATION_MS),
            exhausted: false,
            match_truncated: false,
            bytes_exhausted: false,
            timed_out: false,
            skipped_inputs: false,
        }
    }

    fn deadline_reached(&self) -> bool {
        Instant::now() >= self.deadline
    }
}

#[async_trait]
impl ToolExecutor for CodingToolExecutor {
    fn tool_defs(&self) -> Vec<ToolDef> {
        self.defs.iter().map(CodingTool::to_def).collect()
    }

    fn requires_approval(&self, name: &str) -> bool {
        self.defs
            .iter()
            .any(|tool| tool.name == name && tool.requires_approval)
    }

    async fn execute(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        if !self.defs.iter().any(|tool| tool.name == call.name) {
            return Err(ToolExecutionError::NotFound(call.name.clone()));
        }
        match call.name.as_str() {
            "read_file" => self.read_file(call).await,
            "list_dir" => self.list_dir(call).await,
            "glob" => self.glob(call).await,
            "grep" => self.grep(call).await,
            "write_file" => self.write_file(call).await,
            "edit_file" => self.edit_file(call).await,
            "run_command" => self.run_command(call).await,
            other => Err(ToolExecutionError::NotFound(other.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::AllowAllApprovalPolicy;
    use tempfile::TempDir;

    fn tool_call(name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: "call-1".to_string(),
            name: name.to_string(),
            arguments: args,
            thought_signature: None,
        }
    }

    fn parent_executor(root: &Path) -> CodingToolExecutor {
        build_coding_tool_executor(root.to_path_buf(), Arc::new(AllowAllApprovalPolicy::new()))
    }

    fn subagent_executor(root: &Path) -> Result<CodingToolExecutor, ToolExecutionError> {
        build_subagent_coding_tool_executor(
            root.to_path_buf(),
            &["read_file", "list_dir", "glob", "grep"],
        )
    }

    fn tmp_root() -> (TempDir, PathBuf) {
        // Non-dot tempdir names: the credential-path guard treats dot-directory
        // segments as protected, and macOS resolves /var → /private/var, so a
        // dot-prefixed temp dir would trip the guard the way Node's mkdtemp
        // prefixes (`aiden-*`) do not.
        let dir = tempfile::Builder::new()
            .prefix("aiden-ws-")
            .tempdir()
            .unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        (dir, root)
    }

    #[tokio::test]
    async fn approval_summaries_describe_the_consequence_of_mutating_tools() {
        assert_eq!(
            summarize_tool_call("write_file", &json!({ "path": "src/app.ts" })),
            "Create or replace file: src/app.ts"
        );
        assert_eq!(
            summarize_tool_call("edit_file", &json!({ "path": "src/app.ts" })),
            "Edit file: src/app.ts"
        );
        assert_eq!(
            summarize_tool_call("run_command", &json!({ "command": "npm test" })),
            "Run command: npm test"
        );
    }

    #[tokio::test]
    async fn parent_read_and_grep_handle_hidden_metadata_and_source_files() {
        let (_dir, root) = tmp_root();
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::write(root.join(".claude/settings.json"), "{\"safe\":true}\n").unwrap();
        std::fs::write(root.join("source.ts"), "const value = 'foobar';\n").unwrap();
        let tools = parent_executor(&root);

        let read = tools
            .execute(&tool_call(
                "read_file",
                json!({ "path": ".claude/settings.json" }),
            ))
            .await
            .unwrap();
        assert_eq!(read.text, "{\"safe\":true}\n");

        let grep = tools
            .execute(&tool_call("grep", json!({ "pattern": "foobar" })))
            .await
            .unwrap();
        assert!(grep.text.contains("source.ts:1: const value = 'foobar';"));
    }

    #[tokio::test]
    async fn subagent_read_and_search_tools_exclude_credential_paths() {
        let (_dir, root) = tmp_root();
        std::fs::write(root.join(".env"), "SECRET_TOKEN=do-not-expose\n").unwrap();
        std::fs::write(
            root.join(".npmrc"),
            "//registry/:_authToken=do-not-expose\n",
        )
        .unwrap();
        std::fs::write(root.join("auth.json"), "{\"http-basic\":{}}\n").unwrap();
        std::fs::write(root.join("id_rsa"), "OPENSSH_PRIVATE_KEY_SECRET\n").unwrap();
        std::fs::write(root.join("server.key"), "TLS_PRIVATE_KEY_SECRET\n").unwrap();
        std::fs::write(root.join("id_rsa.pub"), "ssh-rsa PUBLIC_KEY_SAFE\n").unwrap();
        std::fs::write(root.join("source.ts"), "const x = 1;\n").unwrap();
        let tools = subagent_executor(&root).unwrap();

        for protected in [".env", ".npmrc", "auth.json", "id_rsa", "server.key"] {
            let result = tools
                .execute(&tool_call("read_file", json!({ "path": protected })))
                .await;
            assert!(result.is_err(), "{protected} must be rejected");
            assert!(
                result.unwrap_err().to_string().contains("credential"),
                "{protected}"
            );
        }

        // The public key file is readable.
        let read = tools
            .execute(&tool_call("read_file", json!({ "path": "id_rsa.pub" })))
            .await
            .unwrap();
        assert!(read.text.contains("PUBLIC_KEY_SAFE"));

        // list_dir hides the credential entries but shows safe ones.
        let list = tools
            .execute(&tool_call("list_dir", json!({})))
            .await
            .unwrap();
        for name in [".env", ".npmrc", "auth.json", "id_rsa", "server.key"] {
            assert!(
                !list.text.lines().any(|line| line.ends_with(name)),
                "list_dir must hide {name}: {}",
                list.text
            );
        }
        assert!(list.text.contains("id_rsa.pub"));
        assert!(list.text.contains("source.ts"));

        // glob excludes them too.
        let glob = tools
            .execute(&tool_call("glob", json!({ "pattern": "**/*" })))
            .await
            .unwrap();
        assert!(glob.text.contains("id_rsa.pub"));
        assert!(glob.text.contains("source.ts"));
        for name in [".env", ".npmrc", "auth.json", "id_rsa", "server.key"] {
            assert!(
                !glob.text.lines().any(|line| line == name),
                "glob must hide {name}: {}",
                glob.text
            );
        }
    }

    #[tokio::test]
    async fn paths_outside_the_workspace_are_rejected() {
        let dir = tempfile::Builder::new()
            .prefix("aiden-ws-")
            .tempdir()
            .unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "outside").unwrap();
        let tools = subagent_executor(&root).unwrap();

        for bad in ["../secret.txt", "/etc/hosts", "sub/../../secret.txt"] {
            let result = tools
                .execute(&tool_call("read_file", json!({ "path": bad })))
                .await;
            assert!(result.is_err(), "{bad} must be rejected");
        }
    }

    #[tokio::test]
    async fn symlinks_inside_the_root_cannot_escape_it() {
        let dir = tempfile::Builder::new()
            .prefix("aiden-ws-")
            .tempdir()
            .unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("outside.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(dir.path().join("outside.txt"), root.join("link.txt")).unwrap();
        let tools = subagent_executor(&root).unwrap();

        let result = tools
            .execute(&tool_call("read_file", json!({ "path": "link.txt" })))
            .await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("outside the workspace folder"));
    }

    #[tokio::test]
    async fn write_file_creates_parent_directories_and_reports_char_count() {
        let (_dir, root) = tmp_root();
        let tools = parent_executor(&root);
        let result = tools
            .execute(&tool_call(
                "write_file",
                json!({ "path": "nested/deep/file.txt", "content": "hello" }),
            ))
            .await
            .unwrap();
        assert_eq!(result.text, "Wrote 5 chars to nested/deep/file.txt.");
        assert_eq!(
            std::fs::read_to_string(root.join("nested/deep/file.txt")).unwrap(),
            "hello"
        );
    }

    #[tokio::test]
    async fn edit_file_requires_a_unique_old_string() {
        let (_dir, root) = tmp_root();
        std::fs::write(root.join("a.txt"), "one two two\n").unwrap();
        let tools = parent_executor(&root);

        let missing = tools
            .execute(&tool_call(
                "edit_file",
                json!({ "path": "a.txt", "old_string": "zzz", "new_string": "x" }),
            ))
            .await;
        assert!(missing
            .unwrap_err()
            .to_string()
            .contains("old_string not found in a.txt."));

        let ambiguous = tools
            .execute(&tool_call(
                "edit_file",
                json!({ "path": "a.txt", "old_string": "two", "new_string": "three" }),
            ))
            .await;
        assert!(ambiguous
            .unwrap_err()
            .to_string()
            .contains("old_string is not unique in a.txt (2 matches)"));

        let edited = tools
            .execute(&tool_call(
                "edit_file",
                json!({ "path": "a.txt", "old_string": "one", "new_string": "uno" }),
            ))
            .await
            .unwrap();
        assert_eq!(edited.text, "Edited a.txt.");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "uno two two\n"
        );
    }

    #[tokio::test]
    async fn list_dir_sorts_entries_and_reports_empty_directories() {
        let (_dir, root) = tmp_root();
        let tools = parent_executor(&root);
        let empty = tools
            .execute(&tool_call("list_dir", json!({})))
            .await
            .unwrap();
        assert_eq!(empty.text, "[empty directory]");

        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join("README.md"), "# hi\n").unwrap();
        let listed = tools
            .execute(&tool_call("list_dir", json!({ "path": "." })))
            .await
            .unwrap();
        assert_eq!(listed.text, "dir  src\nfile  README.md");
    }

    #[tokio::test]
    async fn glob_matches_patterns_and_reports_no_matches() {
        let (_dir, root) = tmp_root();
        std::fs::create_dir_all(root.join("src/lib")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join("src/lib/util.rs"), "pub fn util() {}\n").unwrap();
        let tools = parent_executor(&root);

        let matches = tools
            .execute(&tool_call("glob", json!({ "pattern": "src/**/*.rs" })))
            .await
            .unwrap();
        let files: Vec<&str> = matches.text.lines().collect();
        assert_eq!(files, ["src/lib/util.rs", "src/main.rs"]);

        let none = tools
            .execute(&tool_call("glob", json!({ "pattern": "*.ts" })))
            .await
            .unwrap();
        assert_eq!(none.text, "[no matches]");
    }

    #[tokio::test]
    async fn run_command_runs_in_the_workspace_root_and_reports_outputs() {
        let (_dir, root) = tmp_root();
        let tools = parent_executor(&root);

        let echo = tools
            .execute(&tool_call(
                "run_command",
                json!({ "command": "printf 'hello'" }),
            ))
            .await
            .unwrap();
        assert_eq!(echo.text, "hello");

        // cwd is the workspace root (resolved: macOS /var -> /private/var).
        let pwd = tools
            .execute(&tool_call("run_command", json!({ "command": "pwd" })))
            .await
            .unwrap();
        let resolved_root = std::fs::canonicalize(&root).unwrap();
        assert_eq!(pwd.text.trim(), resolved_root.to_string_lossy());

        // Combined stdout + stderr.
        let combined = tools
            .execute(&tool_call(
                "run_command",
                json!({ "command": "printf 'out'; printf 'err' >&2" }),
            ))
            .await
            .unwrap();
        assert_eq!(combined.text, "out\nerr");

        // Non-zero exit with reason.
        let failed = tools
            .execute(&tool_call("run_command", json!({ "command": "exit 3" })))
            .await
            .unwrap();
        assert!(failed.text.contains("Command exited with error (code 3)."));

        // No output on success → "[no output]".
        let silent = tools
            .execute(&tool_call("run_command", json!({ "command": "true" })))
            .await
            .unwrap();
        assert_eq!(silent.text, "[no output]");
    }

    #[tokio::test]
    async fn run_command_is_denied_by_the_default_approval_policy() {
        let (_dir, root) = tmp_root();
        let tools =
            build_coding_tool_executor(root.clone(), Arc::new(DenyAllApprovalPolicy::new()));
        let result = tools
            .execute(&tool_call("run_command", json!({ "command": "echo hi" })))
            .await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("denied by the approval policy"));
    }

    #[tokio::test]
    async fn read_file_rejects_a_fifo_without_waiting() {
        let (_dir, root) = tmp_root();
        let fifo = root.join("pipe");
        let status = std::process::Command::new("mkfifo").arg(&fifo).status();
        if !status.map(|s| s.success()).unwrap_or(false) {
            return; // platform without mkfifo
        }
        let tools = subagent_executor(&root).unwrap();
        let result = tools
            .execute(&tool_call("read_file", json!({ "path": "pipe" })))
            .await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("not a regular file"));
    }

    #[tokio::test]
    async fn subagent_tools_are_exactly_the_allowed_read_set() {
        let (_dir, root) = tmp_root();
        let executor =
            build_subagent_coding_tool_executor(root.clone(), &["read_file", "glob"]).unwrap();
        let defs = executor.tool_defs();
        let names: Vec<&str> = defs.iter().map(|def| def.name.as_str()).collect();
        assert_eq!(names, ["read_file", "glob"]);
        // Denied tools are not reachable.
        let result = executor
            .execute(&tool_call(
                "write_file",
                json!({ "path": "x", "content": "y" }),
            ))
            .await;
        assert!(matches!(result, Err(ToolExecutionError::NotFound(_))));
    }

    #[test]
    fn tool_schemas_match_the_typebox_shape() {
        let defs = parent_coding_tool_defs();
        let names: Vec<&str> = defs.iter().map(|tool| tool.name).collect();
        assert_eq!(
            names,
            [
                "read_file",
                "list_dir",
                "glob",
                "grep",
                "edit_file",
                "write_file",
                "run_command"
            ]
        );
        for tool in &defs {
            let schema = &tool.parameters;
            assert_eq!(schema["type"], "object");
            assert_eq!(schema["additionalProperties"], false);
            assert!(schema.get("properties").is_some());
        }
        let read = &defs[0];
        assert_eq!(read.label, "Read File");
        assert_eq!(read.parameters["required"], json!(["path"]));
        assert_eq!(read.parameters["properties"]["path"]["type"], "string");

        let list_dir = &defs[1];
        assert!(list_dir.parameters.get("required").is_none());
        assert!(list_dir.parameters["properties"]["path"]
            .get("maxLength")
            .is_none());

        let grep = &defs[3];
        assert_eq!(grep.parameters["properties"]["pattern"]["type"], "string");

        // Mutating tools are marked for approval.
        let mutating: Vec<&str> = defs
            .iter()
            .filter(|tool| tool.requires_approval)
            .map(|tool| tool.name)
            .collect();
        assert_eq!(mutating, ["edit_file", "write_file", "run_command"]);
    }

    #[tokio::test]
    async fn grep_reports_no_matches_and_search_subdirectory() {
        let (_dir, root) = tmp_root();
        std::fs::write(root.join("a.txt"), "alpha\nbeta\n").unwrap();
        std::fs::write(root.join("b.txt"), "alphabet\n").unwrap();
        let tools = parent_executor(&root);

        let none = tools
            .execute(&tool_call("grep", json!({ "pattern": "gamma" })))
            .await
            .unwrap();
        assert_eq!(none.text, "[no matches]");

        let matches = tools
            .execute(&tool_call("grep", json!({ "pattern": "alpha" })))
            .await
            .unwrap();
        assert!(matches.text.contains("a.txt:1: alpha"));
        assert!(matches.text.contains("b.txt:1: alphabet"));
    }
}
