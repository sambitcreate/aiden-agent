//! Chat history persistence (port of `main/services/chat-store-core.ts` +
//! `chat-title-policy.ts`, with the strict timeline / subagent-reference
//! parsers from `renderer/shared/generation-timeline.ts` and
//! `renderer/shared/subagent-runs.ts`).
//!
//! Layout: `<userData>/chats/index.json` (array of `ChatMeta`, sorted by
//! `updatedAt` desc) + `<userData>/chats/<chatId>.json` per chat (full `Chat`).
//!
//! Durability protocol (ported faithfully):
//!
//! - All operations are serialized through one lock tail because the shared
//!   index file and background title generation can overlap message writes.
//! - Per chat file: write `.<name>.<uuid>.chat-write.tmp` with `O_EXCL` + mode
//!   0600 → fsync the file → optional pre-rename ownership fence → rename →
//!   fsync the directory. Crash-left staging files (matching the TS regexes)
//!   are swept before each write.
//! - Cross-file transaction: `writeChatAndMeta` = `beginChatTransaction`
//!   (creates `.chat-transaction.<id>.pending`) → write chat → update index →
//!   clear marker. Every operation re-runs `reconcileChatTransactions`, which
//!   repairs index/chat divergence.
//! - Index recovery: an unreadable/invalid `index.json` is quarantined to
//!   `.index.json.<uuid>.corrupt` and rebuilt by scanning `*.json` chat
//!   payloads; index entries are never trusted — metadata is always re-derived
//!   from the same-ID payload.
//! - Chat ids are NFKC-normal, `^[A-Za-z0-9._:-]+$`, ≤160 chars.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aiden_core::{
    Chat, ChatMessage, ChatMeta, ChatRole, GenerationTimeline, GenerationTimelineStatus,
};
use parking_lot::Mutex;
use serde_json::{Map, Value};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use crate::now_millis;

const INDEX: &str = "index.json";
const DEFAULT_WORKSPACE_ID: &str = "default";
const MAX_CHAT_ID_LENGTH: usize = 160;
const DEFAULT_CHAT_TITLE: &str = "New agent";
const MAX_CHAT_TITLE_LENGTH: usize = 50;

#[derive(Debug, thiserror::Error)]
pub enum ChatStoreError {
    #[error("Invalid chat id.")]
    InvalidChatId,
    #[error("Chat {0} not found")]
    ChatNotFound(String),
    #[error("Only a new chat can change workspaces.")]
    OnlyNewChatCanMove,
    #[error("The renderer document is no longer active.")]
    DocumentInactive,
    #[error("The chat workspace changed before the message could be saved.")]
    WorkspaceChanged,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Durability test seams (`ChatStoreDurability` in chat-store-core.ts).
#[derive(Default)]
pub struct ChatStoreDurability {
    pub read_file: Option<Box<dyn Fn(&Path) -> std::io::Result<Vec<u8>> + Send + Sync>>,
    pub sync_directory: Option<Box<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>>,
    pub sync_file: Option<Box<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>>,
}

fn sync_path(target: &Path) -> std::io::Result<()> {
    let handle = fs::File::open(target)?;
    handle.sync_all()
}

fn is_v4_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || bytes[8] != b'-'
        || bytes[13] != b'-'
        || bytes[18] != b'-'
        || bytes[23] != b'-'
    {
        return false;
    }
    let is_hex =
        |range: std::ops::Range<usize>| bytes[range].iter().all(|byte| byte.is_ascii_hexdigit());
    is_hex(0..8)
        && is_hex(9..13)
        && is_hex(14..18)
        && is_hex(19..23)
        && is_hex(24..36)
        // version 4 and RFC 4122 variant.
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn is_safe_chat_id_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
}

/// `CHAT_DELETE_STAGING` / `INDEX_WRITE_STAGING` / `CHAT_WRITE_STAGING`.
fn is_staging_name(name: &str) -> bool {
    if name.ends_with(".chat-delete.tmp") {
        return name
            .strip_prefix(".index.json.")
            .and_then(|suffix| suffix.strip_suffix(".chat-delete.tmp"))
            .map(is_v4_uuid)
            .unwrap_or(false);
    }
    if name.ends_with(".index-write.tmp") {
        return name
            .strip_prefix(".index.json.")
            .and_then(|suffix| suffix.strip_suffix(".index-write.tmp"))
            .map(is_v4_uuid)
            .unwrap_or(false);
    }
    if name.ends_with(".chat-write.tmp") {
        let Some(middle) = name.strip_suffix(".chat-write.tmp") else {
            return false;
        };
        // `.<chatid>.json.<uuid>`
        let Some(rest) = middle.strip_prefix('.') else {
            return false;
        };
        let Some((chat_part, uuid_part)) = rest.rsplit_once(".json.") else {
            return false;
        };
        if !chat_part.bytes().all(is_safe_chat_id_char) {
            return false;
        }
        return is_v4_uuid(uuid_part);
    }
    false
}

/// `CHAT_TRANSACTION`: `.chat-transaction.<id>.pending`.
fn is_transaction_name(name: &str) -> Option<String> {
    let rest = name.strip_prefix(".chat-transaction.")?;
    let id = rest.strip_suffix(".pending")?;
    if id.is_empty()
        || id.len() > MAX_CHAT_ID_LENGTH
        || !id.bytes().all(is_safe_chat_id_char)
        || !is_nfkc_normal(id)
    {
        return None;
    }
    Some(id.to_string())
}

fn is_nfkc_normal(value: &str) -> bool {
    // Cheap surrogate-free ASCII check: the safe charset is already ASCII, so
    // any non-ASCII byte fails NFKC normalization equality in practice.
    value.bytes().all(|byte| byte.is_ascii())
}

fn is_valid_chat_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CHAT_ID_LENGTH
        && is_nfkc_normal(id)
        && id.bytes().all(is_safe_chat_id_char)
}

fn is_valid_meta(value: &Value) -> bool {
    let Some(meta) = value.as_object() else {
        return false;
    };
    let id = meta.get("id").and_then(Value::as_str);
    let title = meta.get("title").and_then(Value::as_str);
    let created_at = meta.get("createdAt").and_then(Value::as_u64);
    let updated_at = meta.get("updatedAt").and_then(Value::as_u64);
    id.map(is_valid_chat_id).unwrap_or(false)
        && title.is_some()
        && created_at.is_some()
        && updated_at.is_some()
        && matches!(meta.get("workspaceId"), None | Some(Value::String(_)))
        && matches!(meta.get("providerId"), None | Some(Value::String(_)))
        && matches!(meta.get("model"), None | Some(Value::String(_)))
}

// ===========================================================================
// Strict replay parsers (renderer/shared/generation-timeline.ts,
// renderer/shared/subagent-runs.ts)
// ===========================================================================

fn finite_timestamp(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn safe_stored_target(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 240
        || value.starts_with('/')
        || value.starts_with('~')
        || value.bytes().take(2).enumerate().any(|(index, byte)| {
            index == 1
                && (byte == b'/' || byte == b'\\')
                && value.as_bytes()[0].is_ascii_alphabetic()
        })
    {
        return false;
    }
    !value.split(['/', '\\']).any(|segment| segment == "..")
}

fn safe_stored_detail(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|character| !character.is_control() && character != '\u{7f}')
}

/// `parseGenerationTimeline` — validate the renderer-safe subset before
/// replaying a timeline from local chat storage.
pub fn parse_generation_timeline(value: &Value) -> Option<GenerationTimeline> {
    let candidate = value.as_object()?;
    let version = candidate.get("version").and_then(Value::as_u64)?;
    if version != 2 && version != 1 {
        return None;
    }
    let generation_id = candidate.get("generationId").and_then(Value::as_str)?;
    if generation_id.is_empty()
        || generation_id.len() > 128
        || !generation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return None;
    }
    let status = match candidate.get("status").and_then(Value::as_str) {
        Some("running") => GenerationTimelineStatus::Running,
        Some("completed") => GenerationTimelineStatus::Completed,
        Some("failed") => GenerationTimelineStatus::Failed,
        Some("cancelled") => GenerationTimelineStatus::Cancelled,
        _ => return None,
    };
    let started_at = finite_timestamp(candidate.get("startedAt"))?;
    let finished_at = match candidate.get("finishedAt") {
        None | Some(Value::Null) => None,
        Some(value) => Some(finite_timestamp(Some(value))?),
    };
    let steps_raw = candidate.get("steps")?.as_array()?;
    if steps_raw.len() > 200 {
        return None;
    }
    let mut steps: Vec<aiden_core::AgentStep> = Vec::new();
    for (index, raw_step) in steps_raw.iter().enumerate() {
        let step = raw_step.as_object()?;
        if step.get("order").and_then(Value::as_u64) != Some(index as u64)
            || finite_timestamp(step.get("startedAt")).is_none()
            || finite_timestamp(step.get("updatedAt")).is_none()
        {
            return None;
        }
        if let Some(finished_at) = step.get("finishedAt") {
            finite_timestamp(Some(finished_at))?;
        }
        // Version 1 predates reasoning steps, so it may only contain tool steps.
        match step.get("kind").and_then(Value::as_str) {
            Some("tool") => {
                let parsed = parse_tool_step(step, index)?;
                steps.push(aiden_core::AgentStep::Tool(parsed));
            }
            Some("thinking") if version == 2 => {
                let parsed = parse_thinking_step(step, index)?;
                steps.push(aiden_core::AgentStep::Thinking(parsed));
            }
            _ => return None,
        }
    }

    let mut claim_check = None;
    if let Some(raw_claim_check) = candidate.get("claimCheck") {
        if matches!(status, GenerationTimelineStatus::Running) {
            return None;
        }
        let claim = raw_claim_check.as_object()?;
        if claim.get("kind").and_then(Value::as_str) != Some("unverified_success") {
            return None;
        }
        let step_ids = claim.get("stepIds").and_then(Value::as_array)?;
        if step_ids.is_empty() || step_ids.len() > 20 {
            return None;
        }
        let mut seen = BTreeSet::new();
        for step_id in step_ids {
            let step_id = step_id.as_str()?;
            if !seen.insert(step_id.to_string()) {
                return None;
            }
            let matches_failed_step = steps.iter().any(|step| {
                matches!(
                    step,
                    aiden_core::AgentStep::Tool(tool)
                        if tool.id == step_id
                            && matches!(
                                tool.status,
                                aiden_core::AgentStepStatus::Failed
                                    | aiden_core::AgentStepStatus::Blocked
                                    | aiden_core::AgentStepStatus::Cancelled
                            )
                )
            });
            if !matches_failed_step {
                return None;
            }
        }
        claim_check = Some(aiden_core::GenerationClaimCheck::UnverifiedSuccess {
            step_ids: step_ids
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        });
    }

    Some(GenerationTimeline {
        version: version as u8,
        generation_id: generation_id.to_string(),
        status,
        started_at,
        finished_at,
        steps,
        claim_check,
    })
}

fn parse_tool_step(step: &Map<String, Value>, index: usize) -> Option<aiden_core::AgentToolStep> {
    let id = step.get("id").and_then(Value::as_str)?;
    let tool_call_id = step.get("toolCallId").and_then(Value::as_str)?;
    let tool_name = step.get("toolName").and_then(Value::as_str)?;
    let label = step.get("label").and_then(Value::as_str)?;
    if !id.starts_with("tool-") || id[5..].parse::<u64>().ok()? == 0 {
        return None;
    }
    if !tool_call_id.starts_with("call-") || tool_call_id[5..].parse::<u64>().ok()? == 0 {
        return None;
    }
    if tool_name.is_empty() || tool_name.len() > 80 {
        return None;
    }
    if label.is_empty() || label.len() > 120 {
        return None;
    }
    let status = match step.get("status").and_then(Value::as_str) {
        Some("pending") => aiden_core::AgentStepStatus::Pending,
        Some("awaiting_approval") => aiden_core::AgentStepStatus::AwaitingApproval,
        Some("running") => aiden_core::AgentStepStatus::Running,
        Some("completed") => aiden_core::AgentStepStatus::Completed,
        Some("failed") => aiden_core::AgentStepStatus::Failed,
        Some("blocked") => aiden_core::AgentStepStatus::Blocked,
        Some("cancelled") => aiden_core::AgentStepStatus::Cancelled,
        _ => return None,
    };
    if let Some(target) = step.get("target").and_then(Value::as_str) {
        if !safe_stored_target(target) {
            return None;
        }
    }
    if let Some(detail) = step.get("detail").and_then(Value::as_str) {
        if !safe_stored_detail(detail) {
            return None;
        }
    }
    Some(aiden_core::AgentToolStep {
        id: id.to_string(),
        order: index,
        tool_call_id: tool_call_id.to_string(),
        tool_name: tool_name.to_string(),
        label: label.to_string(),
        status,
        started_at: step.get("startedAt")?.as_u64()?,
        updated_at: step.get("updatedAt")?.as_u64()?,
        finished_at: step.get("finishedAt").and_then(Value::as_u64),
        target: step
            .get("target")
            .and_then(Value::as_str)
            .map(str::to_string),
        detail: step
            .get("detail")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_thinking_step(
    step: &Map<String, Value>,
    index: usize,
) -> Option<aiden_core::AgentThinkingStep> {
    let id = step.get("id").and_then(Value::as_str)?;
    if !id.starts_with("think-") || id[6..].parse::<u64>().ok()? == 0 {
        return None;
    }
    if let Some(duration_ms) = step.get("durationMs") {
        finite_timestamp(Some(duration_ms))?;
    }
    Some(aiden_core::AgentThinkingStep {
        id: id.to_string(),
        order: index,
        started_at: step.get("startedAt")?.as_u64()?,
        updated_at: step.get("updatedAt")?.as_u64()?,
        finished_at: step.get("finishedAt").and_then(Value::as_u64),
        duration_ms: step.get("durationMs").and_then(Value::as_u64),
    })
}

/// `SubagentMessageReferenceV1` (renderer/shared/subagent-runs.ts).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageReferenceV1 {
    pub version: u8,
    pub generation_id: String,
    pub run_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<SubagentMessageReferenceItemV1>>,
    pub total: u64,
    pub completed: u64,
    pub failed: u64,
    pub timed_out: u64,
    pub interrupted: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageReferenceItemV1 {
    pub run_id: String,
    pub label: String,
    pub role: String,
    pub state: String,
}

const MAX_SUBAGENT_RUNS_PER_GENERATION: usize = 8;
const MAX_SUBAGENT_LABEL_CHARS: usize = 120;

fn is_safe_subagent_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_terminal_subagent_state(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "timed_out" | "interrupted")
}

fn non_negative_integer(value: &Value) -> Option<u64> {
    value.as_u64()
}

/// `parseSubagentMessageReferenceV1` — legacy 8-key shape or the enriched
/// 9-key shape with items; counts must reconcile exactly.
pub fn parse_subagent_message_reference_v1(value: &Value) -> Option<SubagentMessageReferenceV1> {
    let object = value.as_object()?;
    let legacy_keys = [
        "version",
        "generationId",
        "runIds",
        "total",
        "completed",
        "failed",
        "timedOut",
        "interrupted",
    ];
    let has_items = object.contains_key("items");
    let enriched = object.len() == legacy_keys.len() + 1 && has_items;
    if (object.len() != legacy_keys.len() && !enriched)
        || !legacy_keys.iter().all(|key| object.contains_key(*key))
        || object
            .keys()
            .any(|key| !legacy_keys.contains(&key.as_str()) && key != "items")
    {
        return None;
    }
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let generation_id = object.get("generationId")?.as_str()?;
    if !is_safe_subagent_identifier(generation_id) {
        return None;
    }
    let run_ids_raw = object.get("runIds")?.as_array()?;
    if run_ids_raw.is_empty() || run_ids_raw.len() > MAX_SUBAGENT_RUNS_PER_GENERATION {
        return None;
    }
    let mut run_ids = Vec::new();
    let mut seen = BTreeSet::new();
    for run_id in run_ids_raw {
        let run_id = run_id.as_str()?;
        if !is_safe_subagent_identifier(run_id) || !seen.insert(run_id.to_string()) {
            return None;
        }
        run_ids.push(run_id.to_string());
    }
    let completed = non_negative_integer(object.get("completed")?)?;
    let failed = non_negative_integer(object.get("failed")?)?;
    let timed_out = non_negative_integer(object.get("timedOut")?)?;
    let interrupted = non_negative_integer(object.get("interrupted")?)?;
    let total = non_negative_integer(object.get("total")?)?;
    if total != run_ids.len() as u64 || completed + failed + timed_out + interrupted != total {
        return None;
    }

    let mut items = None;
    if enriched {
        let items_raw = object.get("items")?.as_array()?;
        if items_raw.len() != run_ids.len() {
            return None;
        }
        let mut parsed_items = Vec::new();
        let mut counts = (0u64, 0u64, 0u64, 0u64);
        for (index, item) in items_raw.iter().enumerate() {
            let item = item.as_object()?;
            if item.len() != 4
                || !["runId", "label", "role", "state"]
                    .iter()
                    .all(|key| item.contains_key(*key))
            {
                return None;
            }
            let run_id = item.get("runId")?.as_str()?;
            let label = item.get("label")?.as_str()?;
            if !is_safe_subagent_identifier(run_id) || run_id != run_ids[index] {
                return None;
            }
            if label.trim().is_empty() || label.len() > MAX_SUBAGENT_LABEL_CHARS {
                return None;
            }
            let role = item.get("role")?.as_str()?;
            let state = item.get("state")?.as_str()?;
            if !matches!(role, "scout" | "planner" | "reviewer")
                || !is_terminal_subagent_state(state)
            {
                return None;
            }
            match state {
                "completed" => counts.0 += 1,
                "failed" => counts.1 += 1,
                "timed_out" => counts.2 += 1,
                _ => counts.3 += 1,
            }
            parsed_items.push(SubagentMessageReferenceItemV1 {
                run_id: run_id.to_string(),
                label: label.to_string(),
                role: role.to_string(),
                state: state.to_string(),
            });
        }
        if counts != (completed, failed, timed_out, interrupted) {
            return None;
        }
        items = Some(parsed_items);
    }

    Some(SubagentMessageReferenceV1 {
        version: 1,
        generation_id: generation_id.to_string(),
        run_ids,
        items,
        total,
        completed,
        failed,
        timed_out,
        interrupted,
    })
}

// ===========================================================================
// Title policy (chat-title-policy.ts)
// ===========================================================================

/// Legacy default kept replaceable so existing untitled chats still auto-rename.
pub fn is_default_chat_title(title: &str) -> bool {
    let normalized = title.trim().to_lowercase();
    normalized == DEFAULT_CHAT_TITLE.to_lowercase() || normalized == "new chat"
}

pub fn can_replace_generated_chat_title(current_title: &str, title_seed: &str) -> bool {
    let current = current_title.trim();
    is_default_chat_title(current) || current == title_seed.trim()
}

fn compact(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn truncate(value: &str) -> String {
    if value.len() <= MAX_CHAT_TITLE_LENGTH {
        return value.to_string();
    }
    format!("{}...", value[..MAX_CHAT_TITLE_LENGTH - 3].trim_end())
}

/// `deriveChatTitleSeed` — the first-message seed replaced by background title
/// generation.
pub fn derive_chat_title_seed(input: &ChatMessage) -> String {
    let message = compact(&input.content);
    if !message.is_empty() {
        return truncate(&message);
    }
    let first_attachment = input
        .attachments
        .as_ref()
        .and_then(|attachments| attachments.first());
    let Some(first_attachment) = first_attachment else {
        return DEFAULT_CHAT_TITLE.to_string();
    };
    let prefix = if first_attachment.kind == aiden_core::AttachmentKind::Image {
        "Image"
    } else {
        "File"
    };
    let name = compact(&first_attachment.name);
    truncate(&format!(
        "{prefix}: {}",
        if name.is_empty() { "Attachment" } else { &name }
    ))
}

// ===========================================================================
// The store
// ===========================================================================

#[derive(Default)]
pub struct ChatStoreInput<'a> {
    pub title: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub provider_id: Option<&'a str>,
    pub model: Option<&'a str>,
}

/// Meta for `append_message` (auto-title seed + workspace fence).
#[derive(Default)]
pub struct AppendMessageMeta<'a> {
    pub provider_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub auto_title: bool,
    pub expected_workspace_id: Option<&'a str>,
}

/// An incoming message before id/createdAt assignment (`Omit<ChatMessage,
/// "id" | "createdAt"> & { id?, createdAt? }`).
pub struct ChatMessageInput {
    pub id: Option<String>,
    pub role: ChatRole,
    pub content: String,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub attachments: Option<Vec<aiden_core::Attachment>>,
    pub timeline: Option<Value>,
    pub subagents: Option<Value>,
    pub created_at: Option<u64>,
}

#[allow(clippy::type_complexity)]
struct StoreInner {
    resolve_chats_dir: Box<dyn Fn() -> PathBuf + Send + Sync>,
    resolve_provider_id: Box<dyn Fn(Option<&str>) -> Option<String> + Send + Sync>,
    read_file: Box<dyn Fn(&Path) -> std::io::Result<Vec<u8>> + Send + Sync>,
    sync_directory: Box<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>,
    sync_file: Box<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>,
    /// Directory sync owed from a previous write whose fsync failed; retried
    /// before the next operation (never contended: only the tail lock touches it).
    pending_directory_sync: std::sync::Mutex<Option<PathBuf>>,
}

/// The chat store. Every public operation runs under one lock tail, preserving
/// the TS `serialized()` RMW semantics for a synchronous port.
pub struct ChatStore {
    inner: Mutex<StoreInner>,
}

/// `migrateLegacyPiProviderId` default resolver.
pub fn default_resolve_provider_id(provider_id: Option<&str>) -> Option<String> {
    crate::portable_config::migrate_legacy_pi_provider_id(provider_id)
}

pub fn create_chat_store(
    resolve_chats_dir: Box<dyn Fn() -> PathBuf + Send + Sync>,
    resolve_provider_id: Option<Box<dyn Fn(Option<&str>) -> Option<String> + Send + Sync>>,
    durability: ChatStoreDurability,
) -> ChatStore {
    ChatStore {
        inner: Mutex::new(StoreInner {
            resolve_chats_dir,
            resolve_provider_id: resolve_provider_id
                .unwrap_or_else(|| Box::new(default_resolve_provider_id)),
            read_file: durability
                .read_file
                .unwrap_or_else(|| Box::new(|path| fs::read(path))),
            sync_directory: durability
                .sync_directory
                .unwrap_or_else(|| Box::new(sync_path)),
            sync_file: durability.sync_file.unwrap_or_else(|| Box::new(sync_path)),
            pending_directory_sync: std::sync::Mutex::new(None),
        }),
    }
}

impl ChatStore {
    fn serialized<R>(
        &self,
        operation: impl FnOnce(&StoreInner) -> Result<R, ChatStoreError>,
    ) -> Result<R, ChatStoreError> {
        let inner = self.inner.lock();
        (|| -> Result<R, ChatStoreError> {
            self.retry_pending_directory_sync(&inner)?;
            self.reconcile_chat_transactions(&inner)?;
            operation(&inner)
        })()
    }

    // -- durability helpers -------------------------------------------------

    fn sync_directory_durably(
        &self,
        inner: &StoreInner,
        directory: &Path,
    ) -> Result<(), ChatStoreError> {
        // Record the intent so a failed fsync is retried before the next
        // operation (TS `pendingDirectorySync`).
        *inner.pending_directory_sync.lock().unwrap() = Some(directory.to_path_buf());
        (inner.sync_directory)(directory)?;
        *inner.pending_directory_sync.lock().unwrap() = None;
        Ok(())
    }

    fn retry_pending_directory_sync(&self, inner: &StoreInner) -> Result<(), ChatStoreError> {
        let pending = inner.pending_directory_sync.lock().unwrap().clone();
        let Some(directory) = pending else {
            return Ok(());
        };
        (inner.sync_directory)(&directory)?;
        *inner.pending_directory_sync.lock().unwrap() = None;
        Ok(())
    }

    fn index_path(&self, inner: &StoreInner) -> PathBuf {
        (inner.resolve_chats_dir)().join(INDEX)
    }

    fn chat_path(&self, inner: &StoreInner, id: &str) -> Result<PathBuf, ChatStoreError> {
        if !is_valid_chat_id(id) {
            return Err(ChatStoreError::InvalidChatId);
        }
        Ok((inner.resolve_chats_dir)().join(format!("{id}.json")))
    }

    fn transaction_path(&self, inner: &StoreInner, id: &str) -> Result<PathBuf, ChatStoreError> {
        let payload = self.chat_path(inner, id)?;
        let directory = payload
            .parent()
            .ok_or_else(|| std::io::Error::other("no parent dir"))?;
        Ok(directory.join(format!(".chat-transaction.{id}.pending")))
    }

    fn read_file_utf8(&self, inner: &StoreInner, path: &Path) -> Result<String, ChatStoreError> {
        let bytes = (inner.read_file)(path)?;
        String::from_utf8(bytes).map_err(|_| std::io::Error::other("invalid UTF-8").into())
    }

    // -- crash recovery -----------------------------------------------------

    fn remove_crash_left_stages(
        &self,
        inner: &StoreInner,
        directory: &Path,
    ) -> Result<(), ChatStoreError> {
        let mut removed = false;
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_staging_name(&name) {
                continue;
            }
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            fs::remove_file(entry.path())?;
            removed = true;
        }
        if removed {
            self.sync_directory_durably(inner, directory)?;
        }
        Ok(())
    }

    fn remove_staged_file_durably(
        &self,
        inner: &StoreInner,
        staged: &Path,
        directory: &Path,
    ) -> Result<(), ChatStoreError> {
        match fs::remove_file(staged) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        self.sync_directory_durably(inner, directory)?;
        Ok(())
    }

    fn write_index_durably(
        &self,
        inner: &StoreInner,
        index: &[ChatMeta],
        purpose: IndexWritePurpose,
    ) -> Result<(), ChatStoreError> {
        let target = self.index_path(inner);
        let directory = target
            .parent()
            .ok_or_else(|| std::io::Error::other("no parent dir"))?
            .to_path_buf();
        self.remove_crash_left_stages(inner, &directory)?;
        let mut sorted = index.to_vec();
        sorted.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
        let suffix = match purpose {
            IndexWritePurpose::ChatDelete => "chat-delete",
            IndexWritePurpose::IndexWrite => "index-write",
        };
        let staged = directory.join(format!(".{}.{}.{suffix}.tmp", INDEX, new_uuid_like()));
        let serialized = format!(
            "{}\n",
            serde_json::to_string_pretty(&sorted).map_err(ChatStoreError::Json)?
        );
        let result = (|| -> Result<(), ChatStoreError> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&staged)?;
            file.write_all(serialized.as_bytes())?;
            file.sync_all()?;
            drop(file);
            (inner.sync_file)(&staged)?;
            fs::rename(&staged, &target)?;
            self.sync_directory_durably(inner, &directory)?;
            Ok(())
        })();
        let sweep = self.remove_staged_file_durably(inner, &staged, &directory);
        result?;
        sweep
    }

    fn write_index(&self, inner: &StoreInner, index: &[ChatMeta]) -> Result<(), ChatStoreError> {
        self.write_index_durably(inner, index, IndexWritePurpose::IndexWrite)
    }

    fn begin_chat_transaction(&self, inner: &StoreInner, id: &str) -> Result<(), ChatStoreError> {
        let target = self.transaction_path(inner, id)?;
        let directory = target
            .parent()
            .ok_or_else(|| std::io::Error::other("no parent dir"))?
            .to_path_buf();
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&target)?;
        handle.write_all(b"1\n")?;
        handle.sync_all()?;
        drop(handle);
        self.sync_directory_durably(inner, &directory)?;
        Ok(())
    }

    fn clear_chat_transaction(&self, inner: &StoreInner, id: &str) -> Result<(), ChatStoreError> {
        let target = self.transaction_path(inner, id)?;
        match fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        let directory = target
            .parent()
            .ok_or_else(|| std::io::Error::other("no parent dir"))?;
        self.sync_directory_durably(inner, directory)?;
        Ok(())
    }

    // -- index recovery -----------------------------------------------------

    fn recover_index(
        &self,
        inner: &StoreInner,
        quarantine_existing: bool,
        seed: &[ChatMeta],
    ) -> Result<Vec<ChatMeta>, ChatStoreError> {
        let target = self.index_path(inner);
        let directory = target
            .parent()
            .ok_or_else(|| std::io::Error::other("no parent dir"))?
            .to_path_buf();
        self.remove_crash_left_stages(inner, &directory)?;

        let mut recovered: std::collections::BTreeMap<String, ChatMeta> = Default::default();
        for meta in seed {
            let Some(chat) = self.read_chat(inner, &meta.id)? else {
                continue;
            };
            if chat.id != meta.id {
                continue;
            }
            let recovered_meta = meta_of(&chat);
            if is_valid_meta(&serde_json::to_value(&recovered_meta)?) {
                recovered.insert(recovered_meta.id.clone(), recovered_meta);
            }
        }
        let entries = fs::read_dir(&directory)?;
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_file() || entry.file_type()?.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == INDEX || name.starts_with('.') || !name.ends_with(".json") {
                continue;
            }
            let id = &name[..name.len() - ".json".len()];
            if !is_valid_chat_id(id) {
                continue;
            }
            let Some(chat) = self.read_chat(inner, id)? else {
                continue;
            };
            if chat.id != id {
                continue;
            }
            let meta = meta_of(&chat);
            if is_valid_meta(&serde_json::to_value(&meta)?) {
                recovered.insert(meta.id.clone(), meta);
            }
        }

        let mut resolved: Vec<ChatMeta> = Vec::with_capacity(recovered.len());
        for mut meta in recovered.into_values() {
            let provider_id = (inner.resolve_provider_id)(meta.provider_id.as_deref());
            if provider_id != meta.provider_id {
                meta.provider_id = provider_id;
            }
            resolved.push(meta);
        }

        if quarantine_existing {
            let quarantine = directory.join(format!(".{INDEX}.{}.corrupt", new_uuid_like()));
            match fs::rename(&target, &quarantine) {
                Ok(()) => {
                    self.sync_directory_durably(inner, &directory)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        self.write_index(inner, &resolved)?;
        Ok(resolved)
    }

    fn read_index(&self, inner: &StoreInner) -> Result<Vec<ChatMeta>, ChatStoreError> {
        let target = self.index_path(inner);
        let data = match self.read_file_utf8(inner, &target) {
            Ok(data) => data,
            Err(ChatStoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return self.recover_index(inner, false, &[]);
            }
            Err(error) => return Err(error),
        };
        let parsed: Value = match serde_json::from_str(&data) {
            Ok(parsed) => parsed,
            Err(_) => return self.recover_index(inner, true, &[]),
        };
        let Some(raw_index) = parsed.as_array() else {
            return self.recover_index(inner, true, &[]);
        };
        let valid: Vec<ChatMeta> = raw_index
            .iter()
            .filter(|entry| is_valid_meta(entry))
            .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
            .collect();
        if valid.len() != raw_index.len() {
            return self.recover_index(inner, true, &valid);
        }

        // Schema validity is not existence or ownership. Bind every entry to
        // its exact same-ID payload and derive all list metadata from that
        // validated payload so a valid-looking stale index cannot expose a
        // ghost title or workspace.
        let mut canonical: std::collections::BTreeMap<String, ChatMeta> = Default::default();
        for indexed in &valid {
            let Some(chat) = self.read_chat(inner, &indexed.id)? else {
                continue;
            };
            if chat.id != indexed.id {
                continue;
            }
            let metadata = meta_of(&chat);
            if is_valid_meta(&serde_json::to_value(&metadata)?) {
                canonical.insert(metadata.id.clone(), metadata);
            }
        }
        let resolved: Vec<ChatMeta> = canonical.into_values().collect();
        if serde_json::to_string(&resolved)? != serde_json::to_string(&valid)? {
            // Operational payload errors escape before this point. A transient
            // EIO therefore leaves the valid index intact and retryable.
            self.write_index(inner, &resolved)?;
        }
        Ok(resolved)
    }

    fn remove_from_index_durably(
        &self,
        inner: &StoreInner,
        id: &str,
    ) -> Result<(), ChatStoreError> {
        let next: Vec<ChatMeta> = self
            .read_index(inner)?
            .into_iter()
            .filter(|entry| entry.id != id)
            .collect();
        self.write_index_durably(inner, &next, IndexWritePurpose::ChatDelete)
    }

    // -- chat payloads ------------------------------------------------------

    fn normalize_message(&self, message: &ChatMessage, raw: &Value) -> ChatMessage {
        let mut message = message.clone();
        if message.role == aiden_core::ChatRole::Assistant {
            message.reasoning = message
                .reasoning
                .as_ref()
                .filter(|reasoning| !reasoning.trim().is_empty())
                .cloned();
            message.timeline = raw.get("timeline").and_then(parse_generation_timeline);
            message.subagents = raw
                .get("subagents")
                .and_then(parse_subagent_message_reference_v1)
                .and_then(|reference| serde_json::to_value(reference).ok());
        } else {
            message.reasoning = None;
            message.timeline = None;
            message.subagents = None;
        }
        message
    }

    fn read_chat(&self, inner: &StoreInner, id: &str) -> Result<Option<Chat>, ChatStoreError> {
        let path = self.chat_path(inner, id)?;
        let data = match self.read_file_utf8(inner, &path) {
            Ok(data) => data,
            Err(ChatStoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let parsed: Value = match serde_json::from_str(&data) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(None),
        };
        let raw_messages = match parsed.get("messages") {
            Some(Value::Array(messages)) if messages.iter().all(Value::is_object) => {
                messages.clone()
            }
            _ => return Ok(None),
        };
        if !is_valid_meta(&parsed) {
            return Ok(None);
        }
        if parsed.get("id").and_then(Value::as_str) != Some(id) {
            return Ok(None);
        }
        let mut chat: Chat = serde_json::from_value(parsed.clone())?;
        let provider_id = (inner.resolve_provider_id)(chat.provider_id.as_deref());
        let migrated_provider = provider_id != chat.provider_id;
        if migrated_provider {
            chat.provider_id = provider_id;
        }
        let normalized: Vec<ChatMessage> = chat
            .messages
            .iter()
            .zip(raw_messages.iter())
            .map(|(message, raw)| self.normalize_message(message, raw))
            .collect();
        chat.messages = normalized;
        if migrated_provider {
            let _ = self.write_chat(inner, &chat, None);
        }
        Ok(Some(chat))
    }

    fn write_chat(
        &self,
        inner: &StoreInner,
        chat: &Chat,
        before_rename: Option<&dyn Fn() -> Result<(), ChatStoreError>>,
    ) -> Result<(), ChatStoreError> {
        let target = self.chat_path(inner, &chat.id)?;
        let directory = target
            .parent()
            .ok_or_else(|| std::io::Error::other("no parent dir"))?
            .to_path_buf();
        self.remove_crash_left_stages(inner, &directory)?;
        let staged = directory.join(format!(
            ".{}.{}.chat-write.tmp",
            target
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            new_uuid_like()
        ));
        let serialized = format!(
            "{}\n",
            serde_json::to_string_pretty(chat).map_err(ChatStoreError::Json)?
        );
        let result = (|| -> Result<(), ChatStoreError> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&staged)?;
            file.write_all(serialized.as_bytes())?;
            file.sync_all()?;
            drop(file);
            (inner.sync_file)(&staged)?;
            if let Some(fence) = before_rename {
                fence()?;
            }
            fs::rename(&staged, &target)?;
            self.sync_directory_durably(inner, &directory)?;
            Ok(())
        })();
        let sweep = self.remove_staged_file_durably(inner, &staged, &directory);
        result?;
        sweep
    }

    fn update_meta(&self, inner: &StoreInner, chat: &Chat) -> Result<(), ChatStoreError> {
        let mut index = self.read_index(inner)?;
        let metadata = meta_of(chat);
        match index.iter_mut().find(|entry| entry.id == chat.id) {
            Some(entry) => *entry = metadata,
            None => index.push(metadata),
        }
        self.write_index(inner, &index)
    }

    fn write_chat_and_meta(&self, inner: &StoreInner, chat: &Chat) -> Result<(), ChatStoreError> {
        self.begin_chat_transaction(inner, &chat.id)?;
        self.write_chat(inner, chat, None)?;
        self.update_meta(inner, chat)?;
        self.clear_chat_transaction(inner, &chat.id)
    }

    fn reconcile_chat_transactions(&self, inner: &StoreInner) -> Result<(), ChatStoreError> {
        let directory = (inner.resolve_chats_dir)();
        let mut transaction_ids: Vec<String> = Vec::new();
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = is_transaction_name(&name) else {
                continue;
            };
            let metadata = entry.metadata()?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            // Re-run the canonical identifier validation before using a
            // directory entry as either a payload or cleanup target.
            self.chat_path(inner, &id)?;
            transaction_ids.push(id);
        }
        if transaction_ids.is_empty() {
            return Ok(());
        }

        let mut index = self.read_index(inner)?;
        let mut changed = false;
        for id in transaction_ids {
            let chat = self.read_chat(inner, &id)?;
            let index_position = index.iter().position(|entry| entry.id == id);
            let Some(chat) = chat else {
                if let Some(index_position) = index_position {
                    index.remove(index_position);
                    changed = true;
                }
                continue;
            };
            if chat.id != id {
                if let Some(index_position) = index_position {
                    index.remove(index_position);
                    changed = true;
                }
                continue;
            }
            let next_meta = meta_of(&chat);
            let needs_update = match index_position {
                Some(index_position) => {
                    serde_json::to_string(&index[index_position])?
                        != serde_json::to_string(&next_meta)?
                }
                None => true,
            };
            if needs_update {
                match index_position {
                    Some(index_position) => index[index_position] = next_meta,
                    None => index.push(next_meta),
                }
                changed = true;
            }
            self.clear_chat_transaction(inner, &id)?;
        }
        if changed {
            self.write_index(inner, &index)?;
        }
        Ok(())
    }

    // -- public API ---------------------------------------------------------

    /// List chats, newest first. Legacy chats without a workspace fall under
    /// the default one.
    pub fn list(&self, workspace_id: Option<&str>) -> Result<Vec<ChatMeta>, ChatStoreError> {
        self.serialized(|inner| {
            let mut index: Vec<ChatMeta> = self
                .read_index(inner)?
                .into_iter()
                .map(|mut meta| {
                    meta.workspace_id = Some(
                        meta.workspace_id
                            .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string()),
                    );
                    meta
                })
                .collect();
            if let Some(workspace_id) = workspace_id {
                index.retain(|meta| meta.workspace_id.as_deref() == Some(workspace_id));
            }
            index.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
            Ok(index)
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Chat>, ChatStoreError> {
        self.serialized(|inner| self.read_chat(inner, id))
    }

    pub fn create(&self, input: ChatStoreInput<'_>) -> Result<Chat, ChatStoreError> {
        self.serialized(|inner| {
            let now = now_millis();
            let title = input
                .title
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| DEFAULT_CHAT_TITLE.to_string());
            let chat = Chat {
                id: new_id(),
                title,
                workspace_id: Some(
                    input
                        .workspace_id
                        .map(str::to_string)
                        .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string()),
                ),
                provider_id: (inner.resolve_provider_id)(input.provider_id),
                model: input.model.map(str::to_string),
                created_at: now,
                updated_at: now,
                computer_use_enabled: None,
                messages: Vec::new(),
            };
            self.write_chat_and_meta(inner, &chat)?;
            Ok(chat)
        })
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<(), ChatStoreError> {
        self.serialized(|inner| {
            let mut chat = self
                .read_chat(inner, id)?
                .ok_or_else(|| ChatStoreError::ChatNotFound(id.to_string()))?;
            let trimmed = title.trim();
            chat.title = if trimmed.is_empty() {
                chat.title.clone()
            } else {
                trimmed.to_string()
            };
            chat.updated_at = now_millis();
            self.write_chat_and_meta(inner, &chat)
        })
    }

    /// Apply an asynchronous rename only when no newer rename won the race.
    pub fn replace_title_if_unchanged(
        &self,
        id: &str,
        expected_title: &str,
        title: &str,
    ) -> Result<Option<Chat>, ChatStoreError> {
        self.serialized(|inner| {
            let mut chat = self.read_chat(inner, id)?;
            let Some(chat_ref) = chat.as_mut() else {
                return Ok(None);
            };
            if chat_ref.title != expected_title {
                return Ok(None);
            }
            let next_title = title.trim();
            if next_title.is_empty() || next_title == chat_ref.title {
                return Ok(None);
            }
            chat_ref.title = next_title.to_string();
            chat_ref.updated_at = now_millis();
            self.write_chat_and_meta(inner, chat_ref)?;
            Ok(chat)
        })
    }

    /// Move only an untouched new chat so its workspace can be chosen from the
    /// composer.
    pub fn move_empty_chat_to_workspace(
        &self,
        id: &str,
        workspace_id: &str,
    ) -> Result<Chat, ChatStoreError> {
        self.serialized(|inner| {
            let mut chat = self
                .read_chat(inner, id)?
                .ok_or_else(|| ChatStoreError::ChatNotFound(id.to_string()))?;
            if !chat.messages.is_empty() {
                return Err(ChatStoreError::OnlyNewChatCanMove);
            }
            chat.workspace_id = Some(workspace_id.to_string());
            chat.updated_at = now_millis();
            self.write_chat_and_meta(inner, &chat)?;
            Ok(chat)
        })
    }

    /// Persist the chat-local Computer Use opt-in without reordering history.
    pub fn set_computer_use_enabled(
        &self,
        id: &str,
        enabled: bool,
        is_current: &dyn Fn() -> bool,
    ) -> Result<Chat, ChatStoreError> {
        self.serialized(|inner| {
            let mut chat = self
                .read_chat(inner, id)?
                .ok_or_else(|| ChatStoreError::ChatNotFound(id.to_string()))?;
            if !is_current() {
                return Err(ChatStoreError::DocumentInactive);
            }
            chat.computer_use_enabled = Some(enabled);
            self.write_chat(
                inner,
                &chat,
                Some(&|| {
                    // No I/O happens between this ownership check and the atomic
                    // rename, so a replaced document cannot commit the staged
                    // opt-in.
                    if !is_current() {
                        Err(ChatStoreError::DocumentInactive)
                    } else {
                        Ok(())
                    }
                }),
            )?;
            Ok(chat)
        })
    }

    pub fn remove(&self, id: &str) -> Result<(), ChatStoreError> {
        self.serialized(|inner| {
            let payload = self.chat_path(inner, id)?;
            let directory = payload
                .parent()
                .ok_or_else(|| std::io::Error::other("no parent dir"))?
                .to_path_buf();
            self.remove_crash_left_stages(inner, &directory)?;
            let mut removed_payload = false;
            match fs::remove_file(&payload) {
                Ok(()) => removed_payload = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            if removed_payload {
                self.sync_directory_durably(inner, &directory)?;
            }
            self.remove_from_index_durably(inner, id)
        })
    }

    /// Drop every message after the first `keep_count` entries (retaining the
    /// head of the transcript). Used by the chat service's error-banner retry
    /// to retract a failed assistant turn before re-sending the last user
    /// message, so a reload never resurrects a hanging failed turn.
    pub fn truncate_messages(&self, id: &str, keep_count: usize) -> Result<Chat, ChatStoreError> {
        self.serialized(|inner| {
            let mut chat = self
                .read_chat(inner, id)?
                .ok_or_else(|| ChatStoreError::ChatNotFound(id.to_string()))?;
            if chat.messages.len() <= keep_count {
                return Ok(chat);
            }
            chat.messages.truncate(keep_count);
            chat.updated_at = now_millis();
            self.write_chat_and_meta(inner, &chat)?;
            Ok(chat)
        })
    }

    pub fn append_message(
        &self,
        id: &str,
        message: ChatMessageInput,
        meta: Option<AppendMessageMeta<'_>>,
    ) -> Result<Chat, ChatStoreError> {
        self.serialized(|inner| {
            let mut chat = self
                .read_chat(inner, id)?
                .ok_or_else(|| ChatStoreError::ChatNotFound(id.to_string()))?;
            if let Some(expected_workspace_id) =
                meta.as_ref().and_then(|meta| meta.expected_workspace_id)
            {
                let actual = chat.workspace_id.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID);
                if actual != expected_workspace_id {
                    return Err(ChatStoreError::WorkspaceChanged);
                }
            }
            let raw_message = serde_json::json!({
                "timeline": message.timeline,
                "subagents": message.subagents,
            });
            let mut full = ChatMessage {
                id: message.id.unwrap_or_else(new_id),
                role: message.role,
                content: message.content,
                model: message.model,
                reasoning: message.reasoning,
                attachments: message.attachments,
                timeline: None,
                subagents: None,
                created_at: message.created_at.unwrap_or_else(now_millis),
            };
            full = self.normalize_message(&full, &raw_message);
            let is_first_user_message = full.role == ChatRole::User
                && !chat
                    .messages
                    .iter()
                    .any(|entry| entry.role == ChatRole::User);
            chat.messages.push(full.clone());
            // The chat service persists the user message, the assistant turn,
            // and a retry's next user message from separate background tasks.
            // They serialize through this lock but can acquire it out of
            // submission order, so a plain `push` could land an earlier
            // assistant turn after a later user message. Every message carries
            // a monotonic `created_at`, so a stable sort by timestamp makes the
            // on-disk order deterministic regardless of append interleaving.
            chat.messages.sort_by_key(|entry| entry.created_at);
            chat.updated_at = now_millis();
            if let Some(meta) = &meta {
                if let Some(provider_id) = meta.provider_id {
                    chat.provider_id = Some(provider_id.to_string());
                }
                if let Some(model) = meta.model {
                    chat.model = Some(model.to_string());
                }
                if meta.auto_title && is_first_user_message && is_default_chat_title(&chat.title) {
                    chat.title = derive_chat_title_seed(&full);
                }
            }
            self.write_chat_and_meta(inner, &chat)?;
            Ok(chat)
        })
    }

    /// Replace only the untouched first-message seed, preserving any manual rename.
    pub fn replace_auto_title(
        &self,
        id: &str,
        expected_seed: &str,
        title: &str,
    ) -> Result<Option<Chat>, ChatStoreError> {
        self.serialized(|inner| {
            let mut chat = self.read_chat(inner, id)?;
            let Some(chat_ref) = chat.as_mut() else {
                return Ok(None);
            };
            if !can_replace_generated_chat_title(&chat_ref.title, expected_seed) {
                return Ok(None);
            }
            let next_title = title.trim();
            if next_title.is_empty() || next_title == chat_ref.title {
                return Ok(None);
            }
            chat_ref.title = next_title.to_string();
            chat_ref.updated_at = now_millis();
            self.write_chat_and_meta(inner, chat_ref)?;
            Ok(chat)
        })
    }
}

#[derive(Clone, Copy)]
enum IndexWritePurpose {
    ChatDelete,
    IndexWrite,
}

fn meta_of(chat: &Chat) -> ChatMeta {
    ChatMeta {
        id: chat.id.clone(),
        title: chat.title.clone(),
        workspace_id: Some(
            chat.workspace_id
                .clone()
                .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string()),
        ),
        provider_id: chat.provider_id.clone(),
        model: chat.model.clone(),
        created_at: chat.created_at,
        updated_at: chat.updated_at,
    }
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

static RNG_STATE: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);

fn new_id() -> String {
    let stamp = base36(now_millis());
    let mut state = RNG_STATE.load(Ordering::Relaxed);
    let mut random = String::with_capacity(6);
    for _ in 0..6 {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let digit = ((state >> 33) % 36) as u8;
        random.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        } as char);
    }
    RNG_STATE.store(state, Ordering::Relaxed);
    format!("{stamp}-{random}")
}

/// A v4-uuid-shaped unique suffix for staging/transaction names. The TS side
/// used `randomUUID()`; only the shape (and the sweep regexes that match it)
/// matters for on-disk compatibility.
pub fn new_uuid_like() -> String {
    let mut bytes = [0u8; 16];
    let mut state = RNG_STATE.load(Ordering::Relaxed);
    for byte in bytes.iter_mut() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *byte = (state >> 33) as u8;
    }
    RNG_STATE.store(state, Ordering::Relaxed);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &Path) -> ChatStore {
        let dir = dir.to_path_buf();
        create_chat_store(
            Box::new(move || dir.clone()),
            None,
            ChatStoreDurability::default(),
        )
    }

    #[test]
    fn invalid_chat_ids_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        assert!(matches!(
            store.get("bad id"),
            Err(ChatStoreError::InvalidChatId)
        ));
        assert!(matches!(
            store.get(&"x".repeat(161)),
            Err(ChatStoreError::InvalidChatId)
        ));
    }

    #[test]
    fn create_list_get_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        assert_eq!(chat.title, "New agent");
        assert_eq!(chat.workspace_id.as_deref(), Some("default"));

        let listed = store.list(None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, chat.id);

        let loaded = store.get(&chat.id).unwrap().unwrap();
        assert_eq!(loaded.id, chat.id);
        assert!(loaded.messages.is_empty());

        // index.json is a pretty-printed array sorted by updatedAt desc.
        let raw = std::fs::read_to_string(dir.path().join("index.json")).unwrap();
        assert!(raw.starts_with("["));
        assert!(raw.contains(&format!("\"id\": \"{}\"", chat.id)));
        assert!(dir.path().join(format!("{}.json", chat.id)).exists());
    }

    #[test]
    fn create_accepts_title_workspace_and_provider() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store
            .create(ChatStoreInput {
                title: Some("  My chat  "),
                workspace_id: Some("workspace-a"),
                provider_id: Some("gemini"),
                model: Some("gemini-2.5-flash"),
            })
            .unwrap();
        assert_eq!(chat.title, "My chat");
        assert_eq!(chat.workspace_id.as_deref(), Some("workspace-a"));
        // Legacy gemini is migrated to google on write.
        assert_eq!(chat.provider_id.as_deref(), Some("google"));
        assert_eq!(chat.model.as_deref(), Some("gemini-2.5-flash"));
    }

    #[test]
    fn rename_and_replace_title_if_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        store.rename(&chat.id, "Renamed").unwrap();
        assert_eq!(store.get(&chat.id).unwrap().unwrap().title, "Renamed");
        assert_eq!(store.list(None).unwrap()[0].title, "Renamed");

        // CAS: expected title matches → replaced.
        let replaced = store
            .replace_title_if_unchanged(&chat.id, "Renamed", "Background title")
            .unwrap();
        assert!(replaced.is_some());
        // Stale expected title → no-op.
        let stale = store
            .replace_title_if_unchanged(&chat.id, "Renamed", "Nope")
            .unwrap();
        assert!(stale.is_none());
        assert_eq!(
            store.get(&chat.id).unwrap().unwrap().title,
            "Background title"
        );
    }

    #[test]
    fn append_message_seeds_title_and_normalizes_assistant_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();

        let appended = store
            .append_message(
                &chat.id,
                ChatMessageInput {
                    id: None,
                    role: ChatRole::User,
                    content: "  Fix the build  ".to_string(),
                    model: None,
                    reasoning: Some("not-user-reasoning".to_string()),
                    attachments: None,
                    timeline: None,
                    subagents: None,
                    created_at: None,
                },
                Some(AppendMessageMeta {
                    provider_id: Some("google"),
                    model: Some("gemini-2.5-flash"),
                    auto_title: true,
                    expected_workspace_id: Some("default"),
                }),
            )
            .unwrap();
        assert_eq!(appended.messages.len(), 1);
        // The message content is stored verbatim; only the title seed is compacted.
        assert_eq!(appended.messages[0].content, "  Fix the build  ");
        assert_eq!(
            appended.messages[0].reasoning, None,
            "user reasoning is dropped"
        );
        assert_eq!(
            appended.title, "Fix the build",
            "first user message seeds the title"
        );
        assert_eq!(appended.provider_id.as_deref(), Some("google"));

        // A workspace fence rejects when the chat moved.
        assert!(store
            .move_empty_chat_to_workspace(&chat.id, "other")
            .is_err());
    }

    /// The chat service persists the user message, the assistant turn, and a
    /// retry's next user message from independent background tasks. They
    /// serialize through the store lock but can acquire it out of submission
    /// order, so the on-disk message order must be derived from each message's
    /// monotonic `created_at` rather than the (nondeterministic) append order.
    #[test]
    fn append_message_orders_history_by_created_at_under_out_of_order_appends() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(store_in(dir.path()));
        let chat = store.create(ChatStoreInput::default()).unwrap();
        let id = std::sync::Arc::new(chat.id);

        // Three messages with deliberately staggered timestamps. They are
        // appended from separate threads so the lock-acquisition order is
        // nondeterministic; without timestamp ordering this could persist as
        // user1, user2, assistant (a corrupted transcript).
        let cases: Vec<(ChatRole, &str, u64)> = vec![
            (ChatRole::User, "first", 1_000),
            (ChatRole::Assistant, "reply", 2_000),
            (ChatRole::User, "second", 3_000),
        ];
        let mut handles = Vec::new();
        for (role, content, created_at) in cases {
            let store = store.clone();
            let id = id.clone();
            handles.push(std::thread::spawn(move || {
                store
                    .append_message(
                        &id,
                        ChatMessageInput {
                            id: None,
                            role,
                            content: content.to_string(),
                            model: None,
                            reasoning: None,
                            attachments: None,
                            timeline: None,
                            subagents: None,
                            created_at: Some(created_at),
                        },
                        None,
                    )
                    .unwrap();
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let loaded = store.get(&id).unwrap().unwrap();
        let order: Vec<&str> = loaded.messages.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(
            order,
            vec!["first", "reply", "second"],
            "history must follow created_at regardless of append interleaving"
        );
        assert_eq!(
            loaded
                .messages
                .iter()
                .map(|m| m.created_at)
                .collect::<Vec<_>>(),
            vec![1_000, 2_000, 3_000],
        );
    }

    #[test]
    fn truncate_messages_retracts_the_failed_assistant_turn() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        for (role, content) in [
            (ChatRole::User, "Summarize this."),
            (ChatRole::Assistant, "Partial reply"),
        ] {
            store
                .append_message(
                    &chat.id,
                    ChatMessageInput {
                        id: None,
                        role,
                        content: content.to_string(),
                        model: None,
                        reasoning: None,
                        attachments: None,
                        timeline: None,
                        subagents: None,
                        created_at: Some(now_millis()),
                    },
                    None,
                )
                .unwrap();
        }

        let truncated = store.truncate_messages(&chat.id, 1).unwrap();
        assert_eq!(truncated.messages.len(), 1);
        assert_eq!(truncated.messages[0].role, ChatRole::User);
        assert_eq!(truncated.messages[0].content, "Summarize this.");

        // A reload from disk reflects the retraction (no hanging failed turn).
        let reloaded = store.get(&chat.id).unwrap().unwrap();
        assert_eq!(reloaded.messages.len(), 1);

        // Truncating to >= the current length is a no-op.
        let noop = store.truncate_messages(&chat.id, 5).unwrap();
        assert_eq!(noop.messages.len(), 1);
    }

    #[test]
    fn move_empty_chat_to_workspace_rejects_non_empty_chats() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        let moved = store
            .move_empty_chat_to_workspace(&chat.id, "workspace-b")
            .unwrap();
        assert_eq!(moved.workspace_id.as_deref(), Some("workspace-b"));

        let with_message = store
            .append_message(
                &chat.id,
                ChatMessageInput {
                    id: None,
                    role: ChatRole::User,
                    content: "hello".to_string(),
                    model: None,
                    reasoning: None,
                    attachments: None,
                    timeline: None,
                    subagents: None,
                    created_at: None,
                },
                None,
            )
            .unwrap();
        assert!(store
            .move_empty_chat_to_workspace(&with_message.id, "workspace-c")
            .is_err());
    }

    #[test]
    fn remove_deletes_payload_and_index_entry() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        store.remove(&chat.id).unwrap();
        assert!(store.get(&chat.id).unwrap().is_none());
        assert!(store.list(None).unwrap().is_empty());
        assert!(!dir.path().join(format!("{}.json", chat.id)).exists());
    }

    #[test]
    fn set_computer_use_enabled_checks_the_ownership_fence_before_rename() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        let mut current = true;
        let updated = store
            .set_computer_use_enabled(&chat.id, true, &|| current)
            .unwrap();
        assert_eq!(updated.computer_use_enabled, Some(true));

        current = false;
        assert!(matches!(
            store.set_computer_use_enabled(&chat.id, false, &|| current),
            Err(ChatStoreError::DocumentInactive)
        ));
        // The staged write never landed: the value on disk is unchanged.
        let reloaded = store.get(&chat.id).unwrap().unwrap();
        assert_eq!(reloaded.computer_use_enabled, Some(true));
    }

    #[test]
    fn a_crash_left_transaction_marker_reconciles_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        // Simulate a crash between the chat write and the index update: the
        // transaction marker exists but the index entry is stale.
        store.rename(&chat.id, "Renamed before crash").unwrap();
        let payload: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join(format!("{}.json", chat.id))).unwrap(),
        )
        .unwrap();
        let canonical_updated_at = payload["updatedAt"].as_u64().unwrap();
        let index: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("index.json")).unwrap())
                .unwrap();
        let mut stale_index = index.clone();
        for entry in stale_index.iter_mut() {
            if entry["id"] == chat.id {
                entry["title"] = Value::String("Stale title".into());
                entry["updatedAt"] = Value::Number((canonical_updated_at - 1).into());
            }
        }
        std::fs::write(
            dir.path().join("index.json"),
            serde_json::to_string_pretty(&stale_index).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.path()
                .join(format!(".chat-transaction.{}.pending", chat.id)),
            "1\n",
        )
        .unwrap();

        // Any operation reconciles the transaction from the payload.
        let listed = store.list(None).unwrap();
        assert_eq!(listed[0].title, "Renamed before crash");
        assert_eq!(listed[0].updated_at, canonical_updated_at);
        assert!(!dir
            .path()
            .join(format!(".chat-transaction.{}.pending", chat.id))
            .exists());
    }

    #[test]
    fn a_corrupt_index_is_quarantined_and_rebuilt_from_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        store
            .append_message(
                &chat.id,
                ChatMessageInput {
                    id: None,
                    role: ChatRole::User,
                    content: "hello".to_string(),
                    model: None,
                    reasoning: None,
                    attachments: None,
                    timeline: None,
                    subagents: None,
                    created_at: None,
                },
                None,
            )
            .unwrap();

        std::fs::write(dir.path().join("index.json"), "{ not json").unwrap();
        let listed = store.list(None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, chat.id);
        // The corrupt index was parked, not destroyed.
        let parks: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".corrupt"))
            .collect();
        assert_eq!(parks.len(), 1);
    }

    #[test]
    fn staging_litter_is_swept_before_each_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let uuid = new_uuid_like();
        let staged = dir
            .path()
            .join(format!(".index.json.{uuid}.index-write.tmp"));
        std::fs::write(&staged, "partial").unwrap();
        let _chat = store.create(ChatStoreInput::default()).unwrap();
        assert!(!staged.exists(), "crash-left staging file must be swept");
    }

    #[test]
    fn corrupt_payloads_are_skipped_in_index_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let chat = store.create(ChatStoreInput::default()).unwrap();
        // A malformed chat payload with a valid name is not listed.
        std::fs::write(dir.path().join("zombie.json"), "{ not json").unwrap();
        std::fs::remove_file(dir.path().join("index.json")).unwrap();
        let listed = store.list(None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, chat.id);
    }

    #[test]
    fn timeline_parser_accepts_and_rejects_the_ts_cases() {
        let valid = serde_json::json!({
            "version": 2,
            "generationId": "gen-abc123",
            "status": "completed",
            "startedAt": 1000,
            "finishedAt": 2000,
            "steps": [{
                "id": "tool-1",
                "order": 0,
                "kind": "tool",
                "toolCallId": "call-1",
                "toolName": "grep",
                "label": "Searching",
                "status": "failed",
                "startedAt": 1000,
                "updatedAt": 1500,
                "finishedAt": 1500,
                "target": "src/main.rs",
                "detail": "pattern: foo"
            }, {
                "id": "think-1",
                "order": 1,
                "kind": "thinking",
                "startedAt": 1500,
                "updatedAt": 1800,
                "durationMs": 300
            }],
            "claimCheck": {
                "kind": "unverified_success",
                "stepIds": ["tool-1"]
            }
        });
        let parsed = parse_generation_timeline(&valid).unwrap();
        assert_eq!(parsed.steps.len(), 2);
        assert!(parsed.claim_check.is_some());

        // Invalid: order mismatch, bad step id, version 1 with thinking steps.
        let mut bad = valid.clone();
        bad["steps"][1]["order"] = serde_json::json!(9);
        assert!(parse_generation_timeline(&bad).is_none());

        let mut v1 = valid.clone();
        v1["version"] = serde_json::json!(1);
        v1["steps"][1]["kind"] = serde_json::json!("thinking");
        assert!(parse_generation_timeline(&v1).is_none());

        // Invalid: running status with a claim check.
        let mut running = valid;
        running["status"] = serde_json::json!("running");
        assert!(parse_generation_timeline(&running).is_none());
    }

    #[test]
    fn subagent_reference_parser_rejects_inconsistent_counts() {
        let valid = serde_json::json!({
            "version": 1,
            "generationId": "gen-1",
            "runIds": ["run-1", "run-2"],
            "items": [
                { "runId": "run-1", "label": "Scout", "role": "scout", "state": "completed" },
                { "runId": "run-2", "label": "Review", "role": "reviewer", "state": "failed" }
            ],
            "total": 2,
            "completed": 1,
            "failed": 1,
            "timedOut": 0,
            "interrupted": 0
        });
        let parsed = parse_subagent_message_reference_v1(&valid).unwrap();
        assert_eq!(parsed.run_ids.len(), 2);

        let mut bad = valid.clone();
        bad["total"] = serde_json::json!(3);
        assert!(parse_subagent_message_reference_v1(&bad).is_none());

        let mut bad2 = valid;
        bad2["completed"] = serde_json::json!(2);
        assert!(parse_subagent_message_reference_v1(&bad2).is_none());
    }
}
