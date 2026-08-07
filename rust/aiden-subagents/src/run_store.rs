//! Port of `main/services/subagents/subagent-run-store-core.ts` — private,
//! renderer-safe child-run persistence (V1).
//!
//! The TS serializes every mutation through one promise tail and persists via
//! the native run-store helper. In Rust the store keeps the same serialized
//! semantics behind one `parking_lot::Mutex` tail and the same on-disk layout:
//! `{version: 1, runs: SubagentRunSnapshotV1[] (≤512, ≤8 MiB),
//! pendingChatDeletions: string[] (≤512)}` at `<userData>/subagent-runs/runs.json`,
//! pretty-printed with a trailing newline.
//!
//! Trust boundaries preserved: strict snapshot revalidation
//! (`strictSnapshot`), stable-identity dedup, monotonic revisions + lifecycle
//! progression, active-run interruption on restart, and fail-closed chat
//! deletion tombstones that refuse to resurrect deleted history.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;

use aiden_core::subagent_runs::{
    is_safe_subagent_identifier, parse_subagent_run_snapshot_v1, SubagentRunSnapshotV1,
    SubagentRunState, SUBAGENT_ACTIVE_STATES,
};
use aiden_core::subagent_safe_text::sanitize_subagent_snapshot_text;
use serde_json::Value;

use crate::run_store_storage::{
    Generation, ReadResult, StorageFailure, SubagentRunStoreStorage, SubagentRunStoreStorageError,
    MAX_SUBAGENT_RUN_STORE_BYTES,
};

pub const MAX_STORED_SUBAGENT_RUNS: usize = 512;
pub const MAX_SUBAGENT_CHAT_TOMBSTONES: usize = 512;
const MAX_JSON_NESTING_DEPTH: usize = 128;
const MAX_JSON_OBJECT_KEYS: usize = MAX_STORED_SUBAGENT_RUNS * 128 + 16;
const MAX_NATIVE_GENERATION_CONFLICT_RETRIES: usize = 1;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunDatabaseV1 {
    pub version: u8,
    pub runs: Vec<SubagentRunSnapshotV1>,
    pub pending_chat_deletions: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RunStoreError {
    #[error("{0}")]
    Message(String),
    #[error("Subagent history is no longer available for this chat.")]
    ChatDeleted,
    #[error("Subagent run identity cannot change.")]
    IdentityChanged,
    #[error("Subagent run revisions must increase monotonically.")]
    RevisionNotMonotonic,
    #[error("Subagent run lifecycle cannot move backward.")]
    LifecycleMovedBackward,
    #[error("{0}")]
    Storage(#[from] SubagentRunStoreStorageError),
    #[error("Subagent run storage changed and requires a fresh merge.")]
    GenerationConflict,
    #[error("Subagent run storage contains unreadable evidence and was preserved.")]
    EvidenceUnreadable,
}

impl RunStoreError {
    pub(crate) fn message(value: impl Into<String>) -> Self {
        RunStoreError::Message(value.into())
    }
}

/// Strict snapshot replay: shared parser + independent text-field
/// revalidation (quotes/separators in the container cannot mask a bad field).
pub fn strict_snapshot(value: &Value) -> Result<SubagentRunSnapshotV1, RunStoreError> {
    let snapshot = parse_subagent_run_snapshot_v1(value)
        .ok_or_else(|| RunStoreError::message("Invalid subagent run snapshot."))?;
    let mut text_fields: Vec<String> = Vec::new();
    for field in [
        Some(&snapshot.label),
        Some(&snapshot.task_preview),
        Some(&snapshot.model_id),
        snapshot.activity.as_ref(),
        snapshot.latest_text.as_ref(),
        snapshot.terminal_markdown.as_ref(),
        snapshot.error.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        text_fields.push(field.clone());
    }
    text_fields.extend(snapshot.warnings.iter().cloned());
    if text_fields
        .iter()
        .any(|field| sanitize_subagent_snapshot_text(field) != *field)
    {
        return Err(RunStoreError::message("Unsafe subagent run snapshot."));
    }
    Ok(snapshot)
}

pub fn database_json(database: &SubagentRunDatabaseV1) -> String {
    // Struct serialization preserves the TS field insertion order
    // (version, runs, pendingChatDeletions) for byte-format parity.
    format!(
        "{}\n",
        serde_json::to_string_pretty(database).expect("database is serializable")
    )
}

fn ordered_newest_first(runs: &[SubagentRunSnapshotV1]) -> Vec<SubagentRunSnapshotV1> {
    let mut runs = runs.to_vec();
    runs.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.revision.cmp(&left.revision))
            .then_with(|| left.run_id.cmp(&right.run_id))
    });
    runs
}

fn bounded_runs(
    runs: &[SubagentRunSnapshotV1],
    max_runs: usize,
    pending_chat_deletions: &[String],
    pinned_run_id: Option<&str>,
) -> Result<Vec<SubagentRunSnapshotV1>, RunStoreError> {
    let ordered = ordered_newest_first(runs);
    let mut newest: Vec<SubagentRunSnapshotV1> = ordered.iter().take(max_runs).cloned().collect();
    let pinned = pinned_run_id
        .and_then(|id| ordered.iter().find(|run| run.run_id == id))
        .cloned();
    if let Some(pinned) = &pinned {
        if !newest.iter().any(|run| run.run_id == pinned.run_id) {
            newest = ordered_newest_first(&{
                let mut combined: Vec<SubagentRunSnapshotV1> = newest
                    .iter()
                    .take(max_runs.saturating_sub(1))
                    .cloned()
                    .collect();
                combined.push(pinned.clone());
                combined
            });
        }
    }
    while newest.len() > 1
        && database_json(&SubagentRunDatabaseV1 {
            version: 1,
            runs: newest.clone(),
            pending_chat_deletions: pending_chat_deletions.to_vec(),
        })
        .len()
            > MAX_SUBAGENT_RUN_STORE_BYTES
    {
        let mut removable = newest.len() - 1;
        while removable > 0 && newest[removable].run_id == pinned_run_id.unwrap_or("") {
            removable -= 1;
        }
        if removable == 0 && newest[0].run_id == pinned_run_id.unwrap_or("") {
            break;
        }
        newest.remove(removable);
    }
    if database_json(&SubagentRunDatabaseV1 {
        version: 1,
        runs: newest.clone(),
        pending_chat_deletions: pending_chat_deletions.to_vec(),
    })
    .len()
        > MAX_SUBAGENT_RUN_STORE_BYTES
    {
        return Err(RunStoreError::message(
            "Subagent run snapshot exceeds the private store limit.",
        ));
    }
    Ok(newest)
}

fn retained_runs(
    runs: &[SubagentRunSnapshotV1],
    max_runs: usize,
    pending_chat_deletions: &[String],
) -> Result<Vec<SubagentRunSnapshotV1>, RunStoreError> {
    let retained = ordered_newest_first(runs);
    if retained.len() > max_runs {
        return Err(RunStoreError::message(
            "Subagent run history is at capacity. Delete an older chat before starting more delegated work.",
        ));
    }
    if database_json(&SubagentRunDatabaseV1 {
        version: 1,
        runs: retained.clone(),
        pending_chat_deletions: pending_chat_deletions.to_vec(),
    })
    .len()
        > MAX_SUBAGENT_RUN_STORE_BYTES
    {
        return Err(RunStoreError::message(
            "Subagent run history is at capacity. Delete an older chat before starting more delegated work.",
        ));
    }
    Ok(retained)
}

fn normalized_pending_chat_deletions(value: &Value) -> Result<Vec<String>, RunStoreError> {
    let Some(values) = value.as_array() else {
        return Err(RunStoreError::message(
            "Invalid pending subagent chat deletion state.",
        ));
    };
    let mut normalized = Vec::new();
    for chat_id in values {
        let Some(chat_id) = chat_id.as_str() else {
            continue;
        };
        if !is_safe_subagent_identifier(&Value::String(chat_id.to_string())) {
            continue;
        }
        if !normalized.contains(&chat_id.to_string()) {
            normalized.push(chat_id.to_string());
        }
        if normalized.len() > MAX_SUBAGENT_CHAT_TOMBSTONES {
            return Err(RunStoreError::message(
                "Too many subagent chat deletions require recovery.",
            ));
        }
    }
    Ok(normalized)
}

// ===========================================================================
// Duplicate-key scanner (`assertUniqueJsonObjectKeys`)
// ===========================================================================

/// Duplicate-object-key scanner failure (private; callers map it to evidence
/// errors).
#[derive(Debug)]
pub struct JsonStructureError;

/// Scan the bounded persisted document so no duplicate object key can hide
/// recovery authority before normalization sees it.
pub fn assert_unique_json_object_keys(serialized: &str) -> Result<(), JsonStructureError> {
    let bytes = serialized.as_bytes();
    let mut offset = 0usize;
    let mut object_keys = 0usize;

    fn fail<T>() -> Result<T, JsonStructureError> {
        Err(JsonStructureError)
    }

    fn skip_whitespace(bytes: &[u8], offset: &mut usize) {
        while *offset < bytes.len() && matches!(bytes[*offset], b' ' | b'\t' | b'\n' | b'\r') {
            *offset += 1;
        }
    }

    fn read_string(
        bytes: &[u8],
        offset: &mut usize,
        decode: bool,
    ) -> Result<Option<String>, JsonStructureError> {
        if bytes.get(*offset) != Some(&b'"') {
            return fail();
        }
        *offset += 1;
        let mut segment_start = *offset;
        let mut decoded = String::new();
        while *offset < bytes.len() {
            let character = bytes[*offset];
            if character == b'"' {
                if decode {
                    decoded.push_str(&serialized_slice(bytes, segment_start, *offset));
                }
                *offset += 1;
                return Ok(if decode { Some(decoded) } else { None });
            }
            if character == b'\\' {
                if decode {
                    decoded.push_str(&serialized_slice(bytes, segment_start, *offset));
                }
                *offset += 1;
                let escaped = bytes.get(*offset).copied();
                let Some(escaped) = escaped else {
                    return fail();
                };
                if escaped == b'u' {
                    let hexadecimal = serialized_slice(bytes, *offset + 1, *offset + 5);
                    if hexadecimal.len() != 4
                        || !hexadecimal.bytes().all(|byte| byte.is_ascii_hexdigit())
                    {
                        return fail();
                    }
                    if decode {
                        let code = u16::from_str_radix(&hexadecimal, 16)
                            .map_err(|_| JsonStructureError)?;
                        decoded.push(char::from_u32(code as u32).unwrap_or('\u{fffd}'));
                    }
                    *offset += 5;
                    segment_start = *offset;
                    continue;
                }
                let replacement = match escaped {
                    b'"' => Some('"'),
                    b'\\' => Some('\\'),
                    b'/' => Some('/'),
                    b'b' => Some('\u{8}'),
                    b'f' => Some('\u{c}'),
                    b'n' => Some('\n'),
                    b'r' => Some('\r'),
                    b't' => Some('\t'),
                    _ => None,
                };
                let Some(replacement) = replacement else {
                    return fail();
                };
                if decode {
                    decoded.push(replacement);
                }
                *offset += 1;
                segment_start = *offset;
                continue;
            }
            if character < 0x20 {
                return fail();
            }
            *offset += 1;
        }
        fail()
    }

    fn serialized_slice(bytes: &[u8], start: usize, end: usize) -> String {
        String::from_utf8_lossy(&bytes[start..end.min(bytes.len())]).into_owned()
    }

    fn read_number(bytes: &[u8], offset: &mut usize) -> Result<(), JsonStructureError> {
        if bytes.get(*offset) == Some(&b'-') {
            *offset += 1;
        }
        if bytes.get(*offset) == Some(&b'0') {
            *offset += 1;
        } else {
            let first = bytes.get(*offset).copied();
            let Some(first) = first else { return fail() };
            if !(b'1'..=b'9').contains(&first) {
                return fail();
            }
            *offset += 1;
            while matches!(bytes.get(*offset), Some(byte) if byte.is_ascii_digit()) {
                *offset += 1;
            }
        }
        if bytes.get(*offset) == Some(&b'.') {
            *offset += 1;
            let first = bytes.get(*offset).copied();
            if !matches!(first, Some(byte) if byte.is_ascii_digit()) {
                return fail();
            }
            *offset += 1;
            while matches!(bytes.get(*offset), Some(byte) if byte.is_ascii_digit()) {
                *offset += 1;
            }
        }
        if matches!(bytes.get(*offset), Some(b'e' | b'E')) {
            *offset += 1;
            if matches!(bytes.get(*offset), Some(b'+' | b'-')) {
                *offset += 1;
            }
            let first = bytes.get(*offset).copied();
            if !matches!(first, Some(byte) if byte.is_ascii_digit()) {
                return fail();
            }
            *offset += 1;
            while matches!(bytes.get(*offset), Some(byte) if byte.is_ascii_digit()) {
                *offset += 1;
            }
        }
        Ok(())
    }

    fn read_value(
        bytes: &[u8],
        offset: &mut usize,
        depth: usize,
        object_keys: &mut usize,
    ) -> Result<(), JsonStructureError> {
        if depth > MAX_JSON_NESTING_DEPTH {
            return fail();
        }
        skip_whitespace(bytes, offset);
        let character = bytes.get(*offset).copied();
        let Some(character) = character else {
            return fail();
        };
        match character {
            b'{' => {
                *offset += 1;
                skip_whitespace(bytes, offset);
                if bytes.get(*offset) == Some(&b'}') {
                    *offset += 1;
                    return Ok(());
                }
                let mut keys = HashSet::new();
                loop {
                    let key = read_string(bytes, offset, true)?;
                    *object_keys += 1;
                    if *object_keys > MAX_JSON_OBJECT_KEYS {
                        return fail();
                    }
                    let Some(key) = key else { return fail() };
                    if !keys.insert(key) {
                        return fail();
                    }
                    skip_whitespace(bytes, offset);
                    if bytes.get(*offset) != Some(&b':') {
                        return fail();
                    }
                    *offset += 1;
                    read_value(bytes, offset, depth + 1, object_keys)?;
                    skip_whitespace(bytes, offset);
                    match bytes.get(*offset) {
                        Some(b'}') => {
                            *offset += 1;
                            return Ok(());
                        }
                        Some(b',') => {
                            *offset += 1;
                            skip_whitespace(bytes, offset);
                        }
                        _ => return fail(),
                    }
                }
            }
            b'[' => {
                *offset += 1;
                skip_whitespace(bytes, offset);
                if bytes.get(*offset) == Some(&b']') {
                    *offset += 1;
                    return Ok(());
                }
                loop {
                    read_value(bytes, offset, depth + 1, object_keys)?;
                    skip_whitespace(bytes, offset);
                    match bytes.get(*offset) {
                        Some(b']') => {
                            *offset += 1;
                            return Ok(());
                        }
                        Some(b',') => {
                            *offset += 1;
                        }
                        _ => return fail(),
                    }
                }
            }
            b'"' => {
                read_string(bytes, offset, false)?;
                Ok(())
            }
            b'-' => read_number(bytes, offset),
            b'0'..=b'9' => read_number(bytes, offset),
            b't' => {
                if serialized_slice(bytes, *offset, *offset + 4) == "true" {
                    *offset += 4;
                    Ok(())
                } else {
                    fail()
                }
            }
            b'f' => {
                if serialized_slice(bytes, *offset, *offset + 5) == "false" {
                    *offset += 5;
                    Ok(())
                } else {
                    fail()
                }
            }
            b'n' => {
                if serialized_slice(bytes, *offset, *offset + 4) == "null" {
                    *offset += 4;
                    Ok(())
                } else {
                    fail()
                }
            }
            _ => fail(),
        }
    }

    read_value(bytes, &mut offset, 0, &mut object_keys)?;
    skip_whitespace(bytes, &mut offset);
    if offset != bytes.len() {
        return fail();
    }
    Ok(())
}

// ===========================================================================
// Database parse
// ===========================================================================

fn has_stable_identity(existing: &SubagentRunSnapshotV1, next: &SubagentRunSnapshotV1) -> bool {
    existing.run_id == next.run_id
        && existing.group_id == next.group_id
        && existing.generation_id == next.generation_id
        && existing.child_id == next.child_id
        && existing.chat_id == next.chat_id
        && existing.workspace_id == next.workspace_id
        && existing.role == next.role
        && existing.label == next.label
        && existing.task_preview == next.task_preview
        && existing.started_at == next.started_at
        && existing.model_id == next.model_id
}

fn is_valid_progression(existing: &SubagentRunSnapshotV1, next: &SubagentRunSnapshotV1) -> bool {
    let existing_milestones = existing.milestones.as_deref().unwrap_or(&[]);
    let next_milestones = next.milestones.as_deref().unwrap_or(&[]);
    if !SUBAGENT_ACTIVE_STATES.contains(&existing.state)
        || next.updated_at < existing.updated_at
        || next.turns < existing.turns
        || next.tools < existing.tools
        || next.tokens < existing.tokens
        || next_milestones.len() < existing_milestones.len()
        || existing_milestones
            .iter()
            .zip(next_milestones.iter())
            .any(|(left, right)| left != right)
    {
        return false;
    }
    match existing.state {
        SubagentRunState::Queued => true,
        SubagentRunState::Starting => next.state != SubagentRunState::Queued,
        _ => next.state != SubagentRunState::Queued && next.state != SubagentRunState::Starting,
    }
}

fn parse_database(
    value: Option<&Value>,
    max_runs: usize,
) -> Result<SubagentRunDatabaseV1, RunStoreError> {
    let Some(value) = value else {
        return Ok(SubagentRunDatabaseV1 {
            version: 1,
            runs: Vec::new(),
            pending_chat_deletions: Vec::new(),
        });
    };
    let Some(object) = value.as_object() else {
        return Err(RunStoreError::message("Invalid subagent run database."));
    };
    let keys: Vec<&String> = object.keys().collect();
    let current_schema = keys.len() == 3
        && keys.iter().any(|key| key.as_str() == "version")
        && keys.iter().any(|key| key.as_str() == "runs")
        && keys
            .iter()
            .any(|key| key.as_str() == "pendingChatDeletions");
    let legacy_schema = keys.len() == 2
        && keys.iter().any(|key| key.as_str() == "version")
        && keys.iter().any(|key| key.as_str() == "runs");
    if (!current_schema && !legacy_schema)
        || object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("runs").and_then(Value::as_array).is_none()
    {
        return Err(RunStoreError::message("Invalid subagent run database."));
    }
    let pending_chat_deletions = if current_schema {
        normalized_pending_chat_deletions(object.get("pendingChatDeletions").expect("key"))?
    } else {
        Vec::new()
    };
    let pending_set: HashSet<String> = pending_chat_deletions.iter().cloned().collect();
    let run_values = object
        .get("runs")
        .expect("key")
        .as_array()
        .expect("checked");
    let mut by_run_id: HashMap<String, SubagentRunSnapshotV1> = HashMap::new();
    let mut conflicted_run_ids = HashSet::new();
    for raw in run_values.iter().take(MAX_STORED_SUBAGENT_RUNS * 2) {
        let Ok(run) = strict_snapshot(raw) else {
            continue;
        };
        if pending_set.contains(&run.chat_id) {
            continue;
        }
        if conflicted_run_ids.contains(&run.run_id) {
            continue;
        }
        let replace = match by_run_id.get(&run.run_id) {
            None => true,
            Some(existing) => {
                if !has_stable_identity(existing, &run) {
                    by_run_id.remove(&run.run_id);
                    conflicted_run_ids.insert(run.run_id.clone());
                    false
                } else {
                    run.revision > existing.revision
                        || (run.revision == existing.revision
                            && run.updated_at > existing.updated_at)
                }
            }
        };
        if replace {
            by_run_id.insert(run.run_id.clone(), run);
        }
    }
    let runs = bounded_runs(
        &by_run_id.into_values().collect::<Vec<_>>(),
        max_runs,
        &pending_chat_deletions,
        None,
    )?;
    Ok(SubagentRunDatabaseV1 {
        version: 1,
        runs,
        pending_chat_deletions,
    })
}

/// Strict, lossless V1 reader for parallel V2 migration. Never drops,
/// deduplicates, reorders, reconciles, or normalizes evidence.
pub fn parse_subagent_run_database_v1_for_migration(
    serialized: &str,
) -> Result<SubagentRunDatabaseV1, RunStoreError> {
    if serialized.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
        return Err(RunStoreError::message(
            "Subagent V1 migration source is oversized.",
        ));
    }
    assert_unique_json_object_keys(serialized).map_err(|_| {
        RunStoreError::message("Subagent V1 migration source contains duplicate object keys.")
    })?;
    let parsed: Value = serde_json::from_str(serialized)
        .map_err(|_| RunStoreError::message("Invalid subagent V1 migration source."))?;
    let Some(object) = parsed.as_object() else {
        return Err(RunStoreError::message(
            "Invalid subagent V1 migration source.",
        ));
    };
    let keys: Vec<&String> = object.keys().collect();
    let current_schema = keys.len() == 3
        && keys.iter().any(|key| key.as_str() == "version")
        && keys.iter().any(|key| key.as_str() == "runs")
        && keys
            .iter()
            .any(|key| key.as_str() == "pendingChatDeletions");
    let legacy_schema = keys.len() == 2
        && keys.iter().any(|key| key.as_str() == "version")
        && keys.iter().any(|key| key.as_str() == "runs");
    if (!current_schema && !legacy_schema)
        || object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("runs").and_then(Value::as_array).is_none()
        || object
            .get("runs")
            .and_then(Value::as_array)
            .map(|runs| runs.len() > MAX_STORED_SUBAGENT_RUNS)
            .unwrap_or(true)
    {
        return Err(RunStoreError::message(
            "Invalid subagent V1 migration source schema.",
        ));
    }
    let run_values = object
        .get("runs")
        .expect("key")
        .as_array()
        .expect("checked");
    let mut runs = Vec::with_capacity(run_values.len());
    for raw in run_values {
        let snapshot = strict_snapshot(raw)?;
        // isDeepStrictEqual(raw, snapshot): the snapshot serialization must
        // equal the raw value exactly (no normalization).
        let reserialized = serde_json::to_value(&snapshot).expect("json");
        if &reserialized != raw {
            return Err(RunStoreError::message(
                "Subagent V1 migration would normalize a run.",
            ));
        }
        runs.push(snapshot);
    }
    let mut seen = HashSet::new();
    for run in &runs {
        if !seen.insert(run.run_id.clone()) {
            return Err(RunStoreError::message(
                "Subagent V1 migration source has duplicate runs.",
            ));
        }
    }
    let pending_chat_deletions = if current_schema {
        let Some(values) = object.get("pendingChatDeletions").and_then(Value::as_array) else {
            return Err(RunStoreError::message(
                "Invalid subagent V1 migration deletion state.",
            ));
        };
        if values.len() > MAX_SUBAGENT_CHAT_TOMBSTONES {
            return Err(RunStoreError::message(
                "Invalid subagent V1 migration deletion state.",
            ));
        }
        let mut normalized = Vec::with_capacity(values.len());
        for value in values {
            let Some(chat_id) = value.as_str() else {
                return Err(RunStoreError::message(
                    "Invalid subagent V1 migration deletion state.",
                ));
            };
            if !is_safe_subagent_identifier(&Value::String(chat_id.to_string())) {
                return Err(RunStoreError::message(
                    "Invalid subagent V1 migration deletion state.",
                ));
            }
            normalized.push(chat_id.to_string());
        }
        let unique: HashSet<&String> = normalized.iter().collect();
        if unique.len() != normalized.len() {
            return Err(RunStoreError::message(
                "Invalid subagent V1 migration deletion state.",
            ));
        }
        normalized
    } else {
        Vec::new()
    };
    let deleted_chats: HashSet<&String> = pending_chat_deletions.iter().collect();
    if runs.iter().any(|run| deleted_chats.contains(&run.chat_id)) {
        return Err(RunStoreError::message(
            "Subagent V1 migration source contains deletion-owned runs.",
        ));
    }
    Ok(SubagentRunDatabaseV1 {
        version: 1,
        runs,
        pending_chat_deletions,
    })
}

fn interrupted_snapshot(
    snapshot: &SubagentRunSnapshotV1,
    now: u64,
) -> Option<SubagentRunSnapshotV1> {
    if snapshot.revision >= u64::MAX - 1 {
        return None;
    }
    let mut candidate = snapshot.clone();
    candidate.state = SubagentRunState::Interrupted;
    candidate.revision += 1;
    candidate.updated_at = snapshot.updated_at.max(now);
    candidate.finished_at = Some(snapshot.updated_at.max(now));
    candidate.activity = Some("Interrupted after Aiden restarted.".to_string());
    strict_snapshot(&serde_json::to_value(&candidate).ok()?).ok()
}

// ===========================================================================
// Store
// ===========================================================================

#[derive(Default)]
pub struct SubagentRunStoreOptions {
    pub now: Option<Box<dyn Fn() -> u64 + Send + Sync>>,
    /// Test-only lower ceiling. Production can never exceed the exported cap.
    pub max_runs: Option<usize>,
    pub storage_factory: Option<
        Box<
            dyn Fn(
                    PathBuf,
                )
                    -> Result<Box<dyn SubagentRunStoreStorage>, SubagentRunStoreStorageError>
                + Send
                + Sync,
        >,
    >,
}

#[derive(Clone)]
struct Tombstone {
    attempts: BTreeSet<String>,
    committed: bool,
}

/// Serialized V1 run store (`createSubagentRunStore`). Every public operation
/// runs on one lock tail.
pub struct SubagentRunStore {
    inner: StdMutex<StoreInner>,
}

struct StoreInner {
    storage: Box<dyn SubagentRunStoreStorage>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    max_runs: usize,
    generation: String,
    cache: Option<SubagentRunDatabaseV1>,
    deleted_chats: HashMap<String, Tombstone>,
    restart_reconciliation_complete: bool,
}

impl SubagentRunStore {
    pub fn create(
        storage_factory: Box<
            dyn Fn(
                    PathBuf,
                )
                    -> Result<Box<dyn SubagentRunStoreStorage>, SubagentRunStoreStorageError>
                + Send
                + Sync,
        >,
        directory: PathBuf,
        options: SubagentRunStoreOptions,
    ) -> Result<Self, RunStoreError> {
        let SubagentRunStoreOptions {
            now,
            max_runs,
            storage_factory: _,
        } = options;
        if !directory.is_absolute() {
            return Err(RunStoreError::message(
                "Subagent run storage requires an absolute directory.",
            ));
        }
        let requested_max = max_runs.unwrap_or(MAX_STORED_SUBAGENT_RUNS);
        if !(1..=MAX_STORED_SUBAGENT_RUNS).contains(&requested_max) {
            return Err(RunStoreError::message(
                "Invalid subagent run history limit.",
            ));
        }
        let storage = storage_factory(directory)?;
        Ok(SubagentRunStore {
            inner: StdMutex::new(StoreInner {
                storage,
                now: now.unwrap_or_else(|| Box::new(now_millis)),
                max_runs: requested_max,
                generation: Generation::missing().0,
                cache: None,
                deleted_chats: HashMap::new(),
                restart_reconciliation_complete: false,
            }),
        })
    }

    fn read_now(
        inner: &mut StoreInner,
        reconcile_active: bool,
        force_durable_read: bool,
    ) -> Result<SubagentRunDatabaseV1, RunStoreError> {
        if inner.cache.is_some() && !reconcile_active && !force_durable_read {
            return Ok(inner.cache.clone().expect("checked"));
        }
        let mut parsed: Option<Value> = None;
        let mut should_rewrite = false;
        // Any durable read supersedes the cache as evidence.
        inner.cache = None;
        let read = inner.storage.read()?;
        inner.generation = match &read {
            ReadResult::Missing => Generation::missing().0,
            ReadResult::Oversized { generation } => generation.clone(),
            ReadResult::Data { generation, .. } => generation.clone(),
        };
        match read {
            ReadResult::Missing => {}
            ReadResult::Oversized { .. } => {
                // The generation proves runs.json exists. Its bytes may contain
                // a recovery-authoritative deletion marker, so absence can never
                // be inferred.
                return Err(RunStoreError::EvidenceUnreadable);
            }
            ReadResult::Data { contents, .. } => {
                let decoded =
                    String::from_utf8(contents).map_err(|_| RunStoreError::EvidenceUnreadable)?;
                assert_unique_json_object_keys(&decoded)
                    .map_err(|_| RunStoreError::EvidenceUnreadable)?;
                parsed = Some(
                    serde_json::from_str(&decoded)
                        .map_err(|_| RunStoreError::EvidenceUnreadable)?,
                );
            }
        }
        let database = parse_database(parsed.as_ref(), inner.max_runs)?;
        if let Some(parsed) = &parsed {
            let normalized = serde_json::to_value(&database).expect("json");
            if parsed != &normalized {
                should_rewrite = true;
            }
        }
        let mut reconciled = false;
        let mut database = database;
        if reconcile_active {
            let restart_time = (inner.now)();
            let mut interrupted_runs = Vec::new();
            for run in database.runs {
                if SUBAGENT_ACTIVE_STATES.contains(&run.state) {
                    reconciled = true;
                    if let Some(interrupted) = interrupted_snapshot(&run, restart_time) {
                        interrupted_runs.push(interrupted);
                    }
                } else {
                    interrupted_runs.push(run);
                }
            }
            database.runs = interrupted_runs;
        }
        if reconciled || should_rewrite {
            write_now(inner, &database)?;
            return Ok(database);
        }
        inner.cache = Some(database.clone());
        Ok(database)
    }

    /// Load, scrub, and reconcile persisted state during application startup.
    pub fn initialize(&self) -> Result<(), RunStoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("store poisoned"))?;
        if inner.restart_reconciliation_complete {
            return Ok(());
        }
        let removed = inner.storage.cleanup()?;
        if removed {
            inner.storage.sync_directory()?;
        }
        let database = Self::read_now(&mut inner, true, false)?;
        for chat_id in &database.pending_chat_deletions {
            inner
                .deleted_chats
                .entry(chat_id.clone())
                .or_insert_with(|| Tombstone {
                    attempts: BTreeSet::new(),
                    committed: true,
                })
                .committed = true;
        }
        inner.restart_reconciliation_complete = true;
        Ok(())
    }

    pub fn upsert(&self, value: &Value) -> Result<SubagentRunSnapshotV1, RunStoreError> {
        let snapshot = strict_snapshot(value)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("store poisoned"))?;
        if inner.deleted_chats.contains_key(&snapshot.chat_id) {
            return Err(RunStoreError::ChatDeleted);
        }
        for attempt in 0..=MAX_NATIVE_GENERATION_CONFLICT_RETRIES {
            let database = Self::read_now(&mut inner, false, attempt > 0)?;
            if inner.deleted_chats.contains_key(&snapshot.chat_id) {
                return Err(RunStoreError::ChatDeleted);
            }
            let existing = database
                .runs
                .iter()
                .find(|run| run.run_id == snapshot.run_id);
            if let Some(existing) = existing {
                if !has_stable_identity(existing, &snapshot) {
                    return Err(RunStoreError::IdentityChanged);
                }
                if snapshot.revision <= existing.revision {
                    if serde_json::to_value(&snapshot).expect("json")
                        == serde_json::to_value(existing).expect("json")
                    {
                        return Ok(existing.clone());
                    }
                    return Err(RunStoreError::RevisionNotMonotonic);
                }
                if !is_valid_progression(existing, &snapshot) {
                    return Err(RunStoreError::LifecycleMovedBackward);
                }
            }
            let mut next_runs = database.runs.clone();
            next_runs.retain(|run| run.run_id != snapshot.run_id);
            next_runs.push(snapshot.clone());
            let next = retained_runs(&next_runs, inner.max_runs, &database.pending_chat_deletions)?;
            let next_database = SubagentRunDatabaseV1 {
                version: 1,
                runs: next,
                pending_chat_deletions: database.pending_chat_deletions.clone(),
            };
            match write_now(&mut inner, &next_database) {
                Ok(()) => return Ok(snapshot.clone()),
                Err(error) => {
                    if !matches!(error, RunStoreError::GenerationConflict)
                        || attempt >= MAX_NATIVE_GENERATION_CONFLICT_RETRIES
                    {
                        return Err(error);
                    }
                }
            }
        }
        Err(RunStoreError::message(
            "Subagent run storage could not merge a newer generation.",
        ))
    }

    pub fn get(&self, run_id: &str) -> Result<Option<SubagentRunSnapshotV1>, RunStoreError> {
        if !is_safe_subagent_identifier(&Value::String(run_id.to_string())) {
            return Ok(None);
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("store poisoned"))?;
        let database = Self::read_now(&mut inner, false, true)?;
        Self::reconcile_tombstones_with_durable_snapshot(&mut inner, &database);
        let run = database
            .runs
            .iter()
            .find(|entry| entry.run_id == run_id)
            .cloned();
        Ok(match run {
            Some(run) if !inner.deleted_chats.contains_key(&run.chat_id) => Some(run),
            _ => None,
        })
    }

    pub fn list_by_chat(&self, chat_id: &str) -> Result<Vec<SubagentRunSnapshotV1>, RunStoreError> {
        if !is_safe_subagent_identifier(&Value::String(chat_id.to_string())) {
            return Ok(Vec::new());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("store poisoned"))?;
        let database = Self::read_now(&mut inner, false, true)?;
        Self::reconcile_tombstones_with_durable_snapshot(&mut inner, &database);
        if inner.deleted_chats.contains_key(chat_id) {
            return Ok(Vec::new());
        }
        Ok(ordered_newest_first(
            &database
                .runs
                .iter()
                .filter(|run| run.chat_id == chat_id)
                .cloned()
                .collect::<Vec<_>>(),
        ))
    }

    pub fn delete_chat(&self, chat_id: &str) -> Result<(), RunStoreError> {
        if !is_safe_subagent_identifier(&Value::String(chat_id.to_string())) {
            return Ok(());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("store poisoned"))?;
        if !inner.deleted_chats.contains_key(chat_id)
            && inner.deleted_chats.len() >= MAX_SUBAGENT_CHAT_TOMBSTONES
        {
            return Err(RunStoreError::message(
                "Too many subagent history deletions are pending.",
            ));
        }
        // Synchronous tombstone closes the race with already queued and future
        // projector writes before the serialized delete reaches the disk.
        let attempt = format!("attempt-{chat_id}");
        let tombstone = inner
            .deleted_chats
            .entry(chat_id.to_string())
            .or_insert_with(|| Tombstone {
                attempts: BTreeSet::new(),
                committed: false,
            });
        tombstone.attempts.insert(attempt.clone());
        let mut durable_absence_proven = false;
        let result = (|| -> Result<(), RunStoreError> {
            let database = Self::read_now(&mut inner, false, false)?;
            let _tombstone = inner
                .deleted_chats
                .entry(chat_id.to_string())
                .or_insert_with(|| Tombstone {
                    attempts: BTreeSet::new(),
                    committed: false,
                });
            if !database
                .pending_chat_deletions
                .iter()
                .any(|pending| pending == chat_id)
                && database.pending_chat_deletions.len() >= MAX_SUBAGENT_CHAT_TOMBSTONES
            {
                return Err(RunStoreError::message(
                    "Too many subagent history deletions are pending.",
                ));
            }
            let runs: Vec<SubagentRunSnapshotV1> = database
                .runs
                .iter()
                .filter(|run| run.chat_id != chat_id)
                .cloned()
                .collect();
            let already_pending = database
                .pending_chat_deletions
                .iter()
                .any(|pending| pending == chat_id);
            let pending_chat_deletions = if already_pending {
                database.pending_chat_deletions.clone()
            } else {
                let mut next = database.pending_chat_deletions.clone();
                next.push(chat_id.to_string());
                next
            };
            if runs.len() != database.runs.len()
                || pending_chat_deletions != database.pending_chat_deletions
            {
                write_now(
                    &mut inner,
                    &SubagentRunDatabaseV1 {
                        version: 1,
                        runs,
                        pending_chat_deletions,
                    },
                )?;
            }
            inner
                .deleted_chats
                .get_mut(chat_id)
                .expect("tombstone exists")
                .committed = true;
            Ok(())
        })();
        match result {
            Ok(()) => {}
            Err(error) => {
                // A storage write can install its replacement and then fail
                // before acknowledging. Only a fresh durable read may prove
                // that the provisional intent was never installed.
                inner.cache = None;
                let durable = Self::read_now(&mut inner, false, true);
                match durable {
                    Ok(durable) => {
                        if durable
                            .pending_chat_deletions
                            .iter()
                            .any(|pending| pending == chat_id)
                        {
                            if let Some(tombstone) = inner.deleted_chats.get_mut(chat_id) {
                                tombstone.committed = true;
                            }
                        } else {
                            durable_absence_proven = true;
                        }
                    }
                    Err(_) => {
                        // Indeterminate persistence is privacy-sensitive. Keep
                        // the tombstone fail-closed until a later
                        // delete/restart reconciles.
                    }
                }
                inner
                    .deleted_chats
                    .get_mut(chat_id)
                    .map(|tombstone| tombstone.attempts.remove(&attempt));
                if !inner
                    .deleted_chats
                    .get(chat_id)
                    .map(|tombstone| tombstone.committed)
                    .unwrap_or(false)
                    && inner
                        .deleted_chats
                        .get(chat_id)
                        .map(|tombstone| tombstone.attempts.is_empty())
                        .unwrap_or(false)
                    && durable_absence_proven
                {
                    inner.deleted_chats.remove(chat_id);
                }
                return Err(error);
            }
        }
        inner
            .deleted_chats
            .get_mut(chat_id)
            .map(|tombstone| tombstone.attempts.remove(&attempt));
        Ok(())
    }

    pub fn pending_chat_deletions(&self) -> Result<Vec<String>, RunStoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("store poisoned"))?;
        let database = Self::read_now(&mut inner, false, true)?;
        Self::reconcile_tombstones_with_durable_snapshot(&mut inner, &database);
        Ok(database.pending_chat_deletions.clone())
    }

    pub fn complete_chat_deletion(&self, chat_id: &str) -> Result<(), RunStoreError> {
        if !is_safe_subagent_identifier(&Value::String(chat_id.to_string())) {
            return Ok(());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("store poisoned"))?;
        let database = Self::read_now(&mut inner, false, false)?;
        let runs: Vec<SubagentRunSnapshotV1> = database
            .runs
            .iter()
            .filter(|run| run.chat_id != chat_id)
            .cloned()
            .collect();
        let pending_chat_deletions: Vec<String> = database
            .pending_chat_deletions
            .iter()
            .filter(|pending| *pending != chat_id)
            .cloned()
            .collect();
        if runs.len() != database.runs.len()
            || pending_chat_deletions.len() != database.pending_chat_deletions.len()
        {
            write_now(
                &mut inner,
                &SubagentRunDatabaseV1 {
                    version: 1,
                    runs,
                    pending_chat_deletions,
                },
            )?;
        }
        if let Some(tombstone) = inner.deleted_chats.get(chat_id) {
            if tombstone.attempts.is_empty() {
                inner.deleted_chats.remove(chat_id);
            }
        }
        Ok(())
    }

    pub fn flush(&self) -> Result<(), RunStoreError> {
        Ok(())
    }

    pub fn close(&self) -> Result<(), RunStoreError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| RunStoreError::message("store poisoned"))?;
        inner.storage.close()?;
        Ok(())
    }

    fn reconcile_tombstones_with_durable_snapshot(
        inner: &mut StoreInner,
        database: &SubagentRunDatabaseV1,
    ) {
        let durable: HashSet<String> = database.pending_chat_deletions.iter().cloned().collect();
        let stale: Vec<String> = inner
            .deleted_chats
            .iter()
            .filter(|(chat_id, tombstone)| {
                !durable.contains(*chat_id) && tombstone.attempts.is_empty()
            })
            .map(|(chat_id, _)| chat_id.clone())
            .collect();
        for chat_id in stale {
            inner.deleted_chats.remove(&chat_id);
        }
    }
}

fn write_now(
    inner: &mut StoreInner,
    database: &SubagentRunDatabaseV1,
) -> Result<(), RunStoreError> {
    let contents = database_json(database);
    if contents.len() > MAX_SUBAGENT_RUN_STORE_BYTES {
        return Err(RunStoreError::message(
            "Subagent run history exceeds the private store limit.",
        ));
    }
    inner.cache = None;
    let expected = inner.generation.clone();
    match inner.storage.write(&expected, &contents) {
        Ok(generation) => {
            inner.generation = generation;
            inner.storage.sync_directory()?;
            inner.cache = Some(database.clone());
            Ok(())
        }
        Err(error) if error.failure == StorageFailure::DestinationChanged => {
            Err(RunStoreError::GenerationConflict)
        }
        Err(error) => Err(RunStoreError::Storage(error)),
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Convenience factory with the production storage impl.
pub fn create_subagent_run_store(
    directory: PathBuf,
    options: SubagentRunStoreOptions,
) -> Result<SubagentRunStore, RunStoreError> {
    let SubagentRunStoreOptions {
        now,
        max_runs,
        storage_factory,
    } = options;
    let factory =
        storage_factory.unwrap_or_else(|| {
            Box::new(|directory| {
                Ok(Box::new(
                    crate::run_store_storage::InProcessSubagentRunStoreStorage::new(directory)?,
                ) as Box<dyn SubagentRunStoreStorage>)
            })
        });
    SubagentRunStore::create(
        factory,
        directory,
        SubagentRunStoreOptions {
            now,
            max_runs,
            storage_factory: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(run_id: &str, revision: u64, state: &str, chat_id: &str, updated_at: u64) -> Value {
        let mut value = json!({
            "version": 1,
            "runId": run_id,
            "groupId": "group-1",
            "generationId": "generation-1",
            "childId": "child-1",
            "chatId": chat_id,
            "workspaceId": "workspace-1",
            "revision": revision,
            "role": "scout",
            "label": "Scout",
            "taskPreview": "Explore the workspace.",
            "state": state,
            "activity": "Reviewing workspace context",
            "startedAt": 100,
            "updatedAt": updated_at,
            "modelId": "model-1",
            "turns": 0,
            "tools": 0,
            "tokens": 0,
            "warnings": [],
        });
        if matches!(state, "completed" | "failed" | "timed_out" | "interrupted") {
            value["finishedAt"] = json!(updated_at);
        }
        value
    }

    fn store() -> (tempfile::TempDir, SubagentRunStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = create_subagent_run_store(
            directory.path().to_path_buf(),
            SubagentRunStoreOptions::default(),
        )
        .unwrap();
        (directory, store)
    }

    #[test]
    fn initialize_creates_an_empty_store() {
        let (_directory, store) = store();
        store.initialize().unwrap();
        assert!(store.pending_chat_deletions().unwrap().is_empty());
    }

    #[test]
    fn upsert_get_list_and_monotonic_revisions() {
        let (_directory, store) = store();
        store.initialize().unwrap();
        let first = snapshot("run-1", 1, "queued", "chat-1", 100);
        store.upsert(&first).unwrap();
        let running = snapshot("run-1", 2, "running", "chat-1", 200);
        store.upsert(&running).unwrap();
        let got = store.get("run-1").unwrap().unwrap();
        assert_eq!(got.revision, 2);
        assert_eq!(got.state, SubagentRunState::Running);
        // Revision must increase monotonically.
        assert!(store.upsert(&first).is_err());
        // Lifecycle cannot move backward.
        let back = snapshot("run-1", 3, "queued", "chat-1", 300);
        assert!(store.upsert(&back).is_err());
        let listed = store.list_by_chat("chat-1").unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn identity_cannot_change() {
        let (_directory, store) = store();
        store.initialize().unwrap();
        store
            .upsert(&snapshot("run-1", 1, "queued", "chat-1", 100))
            .unwrap();
        let mut changed = snapshot("run-1", 2, "running", "chat-1", 200);
        changed["label"] = json!("Different label");
        assert!(store.upsert(&changed).is_err());
    }

    #[test]
    fn restart_reconciles_active_runs_to_interrupted() {
        let directory = tempfile::tempdir().unwrap();
        {
            let store = create_subagent_run_store(
                directory.path().to_path_buf(),
                SubagentRunStoreOptions::default(),
            )
            .unwrap();
            store.initialize().unwrap();
            store
                .upsert(&snapshot("run-1", 1, "running", "chat-1", 100))
                .unwrap();
            store
                .upsert(&snapshot("run-2", 1, "completed", "chat-1", 100))
                .unwrap();
        }
        let store = create_subagent_run_store(
            directory.path().to_path_buf(),
            SubagentRunStoreOptions::default(),
        )
        .unwrap();
        store.initialize().unwrap();
        let run = store.get("run-1").unwrap().unwrap();
        assert_eq!(run.state, SubagentRunState::Interrupted);
        assert!(run.activity.as_deref() == Some("Interrupted after Aiden restarted."));
        let terminal = store.get("run-2").unwrap().unwrap();
        assert_eq!(terminal.state, SubagentRunState::Completed);
    }

    #[test]
    fn delete_chat_removes_runs_and_tombstones_the_chat() {
        let (_directory, store) = store();
        store.initialize().unwrap();
        store
            .upsert(&snapshot("run-1", 1, "queued", "chat-1", 100))
            .unwrap();
        store.delete_chat("chat-1").unwrap();
        assert_eq!(store.pending_chat_deletions().unwrap(), vec!["chat-1"]);
        assert!(store.get("run-1").unwrap().is_none());
        assert!(store.list_by_chat("chat-1").unwrap().is_empty());
        // Upsert for the deleted chat is refused.
        assert!(store
            .upsert(&snapshot("run-1", 2, "running", "chat-1", 200))
            .is_err());
        store.complete_chat_deletion("chat-1").unwrap();
        assert!(store.pending_chat_deletions().unwrap().is_empty());
    }

    #[test]
    fn duplicate_json_keys_are_rejected() {
        assert!(assert_unique_json_object_keys(r#"{"version":1,"version":2}"#).is_err());
        assert!(assert_unique_json_object_keys(r#"{"version":1,"runs":[]}"#).is_ok());
        // Deep nesting beyond the limit.
        let mut deep = String::new();
        for _ in 0..130 {
            deep.push_str("{\"a\":");
        }
        deep.push('1');
        for _ in 0..130 {
            deep.push('}');
        }
        assert!(assert_unique_json_object_keys(&deep).is_err());
    }

    #[test]
    fn migration_parse_is_lossless_and_strict() {
        let (directory, store) = store();
        store.initialize().unwrap();
        store
            .upsert(&snapshot("run-1", 1, "queued", "chat-1", 100))
            .unwrap();
        let path = directory.path().join("runs.json");
        let serialized = std::fs::read_to_string(&path).unwrap();
        let parsed = parse_subagent_run_database_v1_for_migration(&serialized).unwrap();
        assert_eq!(parsed.runs.len(), 1);
        assert_eq!(parsed.runs[0].run_id, "run-1");
        // Normalization is refused: a run whose serialized form differs.
        let mut altered = serde_json::from_str::<Value>(&serialized).unwrap();
        altered["runs"][0]["activity"] = json!(Value::Null);
        let reserialized = serde_json::to_string(&altered).unwrap();
        assert!(parse_subagent_run_database_v1_for_migration(&reserialized).is_err());
    }
}
