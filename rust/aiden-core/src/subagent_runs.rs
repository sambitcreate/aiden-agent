//! Port of `renderer/shared/subagent-runs.ts` — the renderer-safe record for
//! one child run: snapshot types (V1 and V2), strict parsers, the message
//! reference projection, and the V1↔V2 adapters.
//!
//! Every parse function mirrors the Electron implementation's exact-key and
//! fail-closed validation, including the renderer-safety gate that any
//! persisted text must survive `sanitize_subagent_snapshot_text` unchanged.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::subagent_safe_text::sanitize_subagent_snapshot_text;

pub const SUBAGENT_RUN_SNAPSHOT_VERSION: u8 = 1;
pub const SUBAGENT_RUN_SNAPSHOT_VERSION_V2: u8 = 2;
pub const MAX_SUBAGENT_RUNS_PER_GENERATION: usize = 8;
pub const MAX_SUBAGENT_LABEL_CHARS: usize = 120;
pub const MAX_SUBAGENT_TASK_PREVIEW_CHARS: usize = 240;
pub const MAX_SUBAGENT_ACTIVITY_CHARS: usize = 160;
pub const MAX_SUBAGENT_LATEST_TEXT_CHARS: usize = 2_000;
pub const MAX_SUBAGENT_TERMINAL_MARKDOWN_CHARS: usize = 12_000;
pub const MAX_SUBAGENT_ERROR_CHARS: usize = 240;
pub const MAX_SUBAGENT_WARNINGS: usize = 5;
pub const MAX_SUBAGENT_WARNING_CHARS: usize = 240;
pub const MAX_SUBAGENT_MILESTONES: usize = 12;
pub const MAX_SUBAGENT_EFFECT_ACTIVITY: usize = 512;
pub const MAX_IDENTIFIER_ENCODING_SLICES: usize = 512;

// ===========================================================================
// Enums
// ===========================================================================

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum SubagentSnapshotRole {
    Scout,
    Planner,
    Reviewer,
}

impl SubagentSnapshotRole {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "scout" => Some(SubagentSnapshotRole::Scout),
            "planner" => Some(SubagentSnapshotRole::Planner),
            "reviewer" => Some(SubagentSnapshotRole::Reviewer),
            _ => None,
        }
    }
}

pub const SUBAGENT_MILESTONE_KINDS: &[SubagentMilestoneKind] = &[
    SubagentMilestoneKind::Reading,
    SubagentMilestoneKind::Listing,
    SubagentMilestoneKind::Matching,
    SubagentMilestoneKind::Searching,
    SubagentMilestoneKind::Inspecting,
    SubagentMilestoneKind::Composing,
];

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum SubagentMilestoneKind {
    Reading,
    Listing,
    Matching,
    Searching,
    Inspecting,
    Composing,
}

impl SubagentMilestoneKind {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "reading" => Some(SubagentMilestoneKind::Reading),
            "listing" => Some(SubagentMilestoneKind::Listing),
            "matching" => Some(SubagentMilestoneKind::Matching),
            "searching" => Some(SubagentMilestoneKind::Searching),
            "inspecting" => Some(SubagentMilestoneKind::Inspecting),
            "composing" => Some(SubagentMilestoneKind::Composing),
            _ => None,
        }
    }
}

/// The V1 run state machine: three active states, four terminal states.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
pub enum SubagentRunState {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "timed_out")]
    TimedOut,
    #[serde(rename = "interrupted")]
    Interrupted,
}

impl SubagentRunState {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(SubagentRunState::Queued),
            "starting" => Some(SubagentRunState::Starting),
            "running" => Some(SubagentRunState::Running),
            "completed" => Some(SubagentRunState::Completed),
            "failed" => Some(SubagentRunState::Failed),
            "timed_out" => Some(SubagentRunState::TimedOut),
            "interrupted" => Some(SubagentRunState::Interrupted),
            _ => None,
        }
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            SubagentRunState::Queued | SubagentRunState::Starting | SubagentRunState::Running
        )
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            SubagentRunState::Completed
                | SubagentRunState::Failed
                | SubagentRunState::TimedOut
                | SubagentRunState::Interrupted
        )
    }
}

/// V2 adds lifecycle-only states on top of the V1 machine.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
pub enum SubagentRunStateV2 {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "timed_out")]
    TimedOut,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "needs_attention")]
    NeedsAttention,
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "unknown")]
    Unknown,
}

impl SubagentRunStateV2 {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(SubagentRunStateV2::Queued),
            "starting" => Some(SubagentRunStateV2::Starting),
            "running" => Some(SubagentRunStateV2::Running),
            "completed" => Some(SubagentRunStateV2::Completed),
            "failed" => Some(SubagentRunStateV2::Failed),
            "timed_out" => Some(SubagentRunStateV2::TimedOut),
            "interrupted" => Some(SubagentRunStateV2::Interrupted),
            "needs_attention" => Some(SubagentRunStateV2::NeedsAttention),
            "stopped" => Some(SubagentRunStateV2::Stopped),
            "unknown" => Some(SubagentRunStateV2::Unknown),
            _ => None,
        }
    }
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum SubagentExecutionModeV2 {
    Foreground,
    Background,
}

impl SubagentExecutionModeV2 {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "foreground" => Some(SubagentExecutionModeV2::Foreground),
            "background" => Some(SubagentExecutionModeV2::Background),
            _ => None,
        }
    }
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum SubagentContextModeV2 {
    Fresh,
    Fork,
}

impl SubagentContextModeV2 {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "fresh" => Some(SubagentContextModeV2::Fresh),
            "fork" => Some(SubagentContextModeV2::Fork),
            _ => None,
        }
    }
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum SubagentEffectActivityKindV1 {
    McpMutation,
    Shell,
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
pub enum SubagentEffectActivityStateV1 {
    #[serde(rename = "prepared")]
    Prepared,
    #[serde(rename = "authorized")]
    Authorized,
    #[serde(rename = "dispatch_started")]
    DispatchStarted,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "remote_error")]
    RemoteError,
    #[serde(rename = "cancelled_before_dispatch")]
    CancelledBeforeDispatch,
    #[serde(rename = "unknown")]
    Unknown,
}

// ===========================================================================
// Snapshot structs
// ===========================================================================

/// The complete renderer-safe record for one child run (version 1). This is
/// deliberately a projection, not a serialized Pi session or AgentEvent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunSnapshotV1 {
    pub version: u8,
    pub run_id: String,
    pub group_id: String,
    pub generation_id: String,
    pub child_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub revision: u64,
    pub role: SubagentSnapshotRole,
    pub label: String,
    pub task_preview: String,
    pub state: SubagentRunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub model_id: String,
    pub turns: u64,
    pub tools: u64,
    pub tokens: u64,
    /// Bounded, ordered, renderer-safe activity kinds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestones: Option<Vec<SubagentMilestoneKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub warnings: Vec<String>,
}

/// Bounded reference copied onto a terminal assistant message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageReferenceV1 {
    pub version: u8,
    pub generation_id: String,
    pub run_ids: Vec<String>,
    /// New V1 writers include renderer-ready terminal metadata; older
    /// references replay without it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<SubagentMessageReferenceItemV1>>,
    pub total: u64,
    pub completed: u64,
    pub failed: u64,
    pub timed_out: u64,
    pub interrupted: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageReferenceItemV1 {
    pub run_id: String,
    pub label: String,
    pub role: SubagentSnapshotRole,
    pub state: SubagentRunState,
}

/// Version 2 snapshot: adds lineage, retry identity, and lifecycle-only
/// states on top of the V1 projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunSnapshotV2 {
    pub version: u8,
    pub run_id: String,
    pub group_id: String,
    pub generation_id: String,
    pub child_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub revision: u64,
    pub role: SubagentSnapshotRole,
    pub label: String,
    pub task_preview: String,
    pub state: SubagentRunStateV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub model_id: String,
    pub turns: u64,
    pub tools: u64,
    pub tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestones: Option<Vec<SubagentMilestoneKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_of_run_id: Option<String>,
    pub depth: u8,
    pub execution: SubagentExecutionModeV2,
    pub context: SubagentContextModeV2,
    pub authority_revision: u64,
}

/// The union accepted on the wire, discriminated by `version`.
#[derive(Debug, Clone, PartialEq)]
pub enum SubagentRunSnapshot {
    V1(SubagentRunSnapshotV1),
    V2(SubagentRunSnapshotV2),
}

impl schemars::JsonSchema for SubagentRunSnapshot {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Borrowed("SubagentRunSnapshot")
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "object",
            "description": "Version-tagged subagent run snapshot union (V1 or V2)."
        })
    }
}

impl Serialize for SubagentRunSnapshot {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            SubagentRunSnapshot::V1(snapshot) => snapshot.serialize(serializer),
            SubagentRunSnapshot::V2(snapshot) => snapshot.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for SubagentRunSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        match value.get("version").and_then(Value::as_u64) {
            Some(version) if version == SUBAGENT_RUN_SNAPSHOT_VERSION as u64 => {
                parse_subagent_run_snapshot_v1(&value)
                    .map(SubagentRunSnapshot::V1)
                    .ok_or_else(|| serde::de::Error::custom("invalid V1 subagent run snapshot"))
            }
            Some(version) if version == SUBAGENT_RUN_SNAPSHOT_VERSION_V2 as u64 => {
                parse_subagent_run_snapshot_v2(&value)
                    .map(SubagentRunSnapshot::V2)
                    .ok_or_else(|| serde::de::Error::custom("invalid V2 subagent run snapshot"))
            }
            _ => Err(serde::de::Error::custom(
                "unsupported subagent run snapshot version",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentEffectActivityV1 {
    pub version: u8,
    pub kind: SubagentEffectActivityKindV1,
    pub state: SubagentEffectActivityStateV1,
    pub label: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentHistoryDetailV1 {
    pub version: u8,
    pub snapshot: SubagentRunSnapshot,
    pub effects: Vec<SubagentEffectActivityV1>,
}

// ===========================================================================
// Validation helpers
// ===========================================================================

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn finite_timestamp(value: Option<&Value>) -> bool {
    match value.and_then(Value::as_f64) {
        Some(number) => number.is_finite() && number >= 0.0,
        None => false,
    }
}

fn non_negative_integer(value: Option<&Value>) -> bool {
    value.and_then(Value::as_u64).is_some()
}

/// NFKC-stability check. Identifiers are additionally gated to an ASCII set
/// (`SAFE_ID`), and ASCII is always NFKC-stable, so this is exact for every
/// identifier that can reach the check.
fn is_nfkc_stable_ascii_only(value: &str) -> bool {
    value.is_ascii()
}

fn has_control(value: &str, allow_newlines: bool) -> bool {
    value.chars().any(|ch| {
        let code = ch as u32;
        if allow_newlines && (code == 10 || code == 13) {
            return false;
        }
        code <= 31 || (127..=159).contains(&code) || code == 0x2028 || code == 0x2029
    })
}

fn safe_text(value: &Value, maximum: usize, allow_empty: bool, allow_newlines: bool) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    if !allow_empty && value.trim().is_empty() {
        return false;
    }
    if value.chars().count() > maximum || has_control(value, allow_newlines) {
        return false;
    }
    sanitize_subagent_snapshot_text(value) == value
}

fn safe_id_charset(value: &str) -> bool {
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

/// Shared privacy and syntax boundary for every identifier that can be
/// persisted in child history or reflected to a renderer.
pub fn is_safe_subagent_identifier(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    if value.is_empty()
        || value.chars().count() > 160
        || !is_nfkc_stable_ascii_only(value)
        || !safe_id_charset(value)
        || sanitize_subagent_snapshot_text(value) != value
    {
        return false;
    }
    identifier_encoding_slices_are_safe(value)
}

fn identifier_encoding_slices_are_safe(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    let mut starts: Vec<usize> = vec![0];
    let mut ends: Vec<usize> = vec![chars.len()];
    for (index, ch) in chars.iter().enumerate() {
        if !matches!(ch, '.' | '_' | ':' | '-') {
            continue;
        }
        if index > 0 {
            ends.push(index);
        }
        if index + 1 < chars.len() {
            starts.push(index + 1);
        }
    }

    let mut checked = 0usize;
    for start in &starts {
        for end in &ends {
            if *end <= *start || (*start == 0 && *end == chars.len()) || end - start < 8 {
                continue;
            }
            checked += 1;
            if checked > MAX_IDENTIFIER_ENCODING_SLICES {
                return false;
            }
            let slice: String = chars[*start..*end].iter().collect();
            if sanitize_subagent_snapshot_text(&slice) != slice {
                return false;
            }
            let compact: String = slice
                .chars()
                .filter(|ch| !matches!(ch, '.' | '_' | ':' | '-'))
                .collect();
            if compact.chars().count() >= 8 && sanitize_subagent_snapshot_text(&compact) != compact
            {
                return false;
            }
        }
    }
    let compact: String = chars
        .iter()
        .filter(|ch| !matches!(ch, '.' | '_' | ':' | '-'))
        .collect();
    if compact.chars().count() >= 8 && sanitize_subagent_snapshot_text(&compact) != compact {
        return false;
    }
    true
}

fn required_key_set() -> &'static [&'static str] {
    &[
        "version",
        "runId",
        "groupId",
        "generationId",
        "childId",
        "chatId",
        "workspaceId",
        "revision",
        "role",
        "label",
        "taskPreview",
        "state",
        "startedAt",
        "updatedAt",
        "modelId",
        "turns",
        "tools",
        "tokens",
        "warnings",
    ]
}

fn optional_key_set() -> &'static [&'static str] {
    &[
        "activity",
        "finishedAt",
        "milestones",
        "latestText",
        "terminalMarkdown",
        "error",
    ]
}

fn has_exact_snapshot_keys(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> bool {
    if object.len() < required.len() || object.len() > required.len() + optional.len() {
        return false;
    }
    for key in required {
        if !object.contains_key(*key) {
            return false;
        }
    }
    object
        .keys()
        .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn v1_required_keys() -> Vec<&'static str> {
    required_key_set().to_vec()
}

fn v1_optional_keys() -> Vec<&'static str> {
    optional_key_set().to_vec()
}

fn v2_required_keys() -> Vec<&'static str> {
    let mut required = required_key_set().to_vec();
    required.extend(["depth", "execution", "context", "authorityRevision"]);
    required
}

fn v2_optional_keys() -> Vec<&'static str> {
    let mut optional = optional_key_set().to_vec();
    optional.extend(["parentRunId", "retryOfRunId"]);
    optional
}

fn require_string<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

// ===========================================================================
// V1 parser
// ===========================================================================

/// Reject malformed or non-redacted values before they cross IPC or replay
/// from disk.
pub fn parse_subagent_run_snapshot_v1(value: &Value) -> Option<SubagentRunSnapshotV1> {
    let object = value.as_object()?;
    if !has_exact_snapshot_keys(object, &v1_required_keys(), &v1_optional_keys()) {
        return None;
    }
    if object.get("version") != Some(&Value::from(SUBAGENT_RUN_SNAPSHOT_VERSION)) {
        return None;
    }
    let identifier = |key: &str| -> Option<String> {
        let raw = require_string(object, key)?;
        if is_safe_subagent_identifier(&Value::String(raw.to_string())) {
            Some(raw.to_string())
        } else {
            None
        }
    };
    let run_id = identifier("runId")?;
    let group_id = identifier("groupId")?;
    let generation_id = identifier("generationId")?;
    let child_id = identifier("childId")?;
    let chat_id = identifier("chatId")?;
    let workspace_id = identifier("workspaceId")?;
    let revision = object.get("revision").and_then(Value::as_u64)?;
    if revision < 1 {
        return None;
    }
    let role = require_string(object, "role").and_then(SubagentSnapshotRole::from_str)?;
    if !safe_text(
        object.get("label").unwrap_or(&Value::Null),
        MAX_SUBAGENT_LABEL_CHARS,
        false,
        false,
    ) || !safe_text(
        object.get("taskPreview").unwrap_or(&Value::Null),
        MAX_SUBAGENT_TASK_PREVIEW_CHARS,
        false,
        false,
    ) {
        return None;
    }
    let state = require_string(object, "state").and_then(SubagentRunState::from_str)?;
    if !finite_timestamp(object.get("startedAt")) || !finite_timestamp(object.get("updatedAt")) {
        return None;
    }
    let started_at = object.get("startedAt").and_then(Value::as_u64)?;
    let updated_at = object.get("updatedAt").and_then(Value::as_u64)?;
    if updated_at < started_at {
        return None;
    }
    if !safe_text(
        object.get("modelId").unwrap_or(&Value::Null),
        160,
        false,
        false,
    ) {
        return None;
    }
    if !non_negative_integer(object.get("turns"))
        || !non_negative_integer(object.get("tools"))
        || !non_negative_integer(object.get("tokens"))
    {
        return None;
    }
    let turns = object.get("turns").and_then(Value::as_u64)?;
    let tools = object.get("tools").and_then(Value::as_u64)?;
    let tokens = object.get("tokens").and_then(Value::as_u64)?;

    if let Some(milestones) = object.get("milestones") {
        let milestones = milestones.as_array()?;
        if milestones.len() > MAX_SUBAGENT_MILESTONES {
            return None;
        }
        for milestone in milestones {
            if !milestone
                .as_str()
                .and_then(SubagentMilestoneKind::from_str)
                .is_some()
            {
                return None;
            }
        }
    }
    let warnings = object.get("warnings")?.as_array()?;
    if warnings.len() > MAX_SUBAGENT_WARNINGS {
        return None;
    }
    for warning in warnings {
        if !safe_text(warning, MAX_SUBAGENT_WARNING_CHARS, false, false) {
            return None;
        }
    }

    let active_has_terminal_fields = state.is_active()
        && (object.contains_key("latestText")
            || object.contains_key("terminalMarkdown")
            || object.contains_key("error")
            || !warnings.is_empty());
    if (object.contains_key("activity")
        && !safe_text(
            object.get("activity").unwrap(),
            MAX_SUBAGENT_ACTIVITY_CHARS,
            false,
            false,
        ))
        || (object.contains_key("latestText")
            && !safe_text(
                object.get("latestText").unwrap(),
                MAX_SUBAGENT_LATEST_TEXT_CHARS,
                false,
                true,
            ))
        || (object.contains_key("terminalMarkdown")
            && !safe_text(
                object.get("terminalMarkdown").unwrap(),
                MAX_SUBAGENT_TERMINAL_MARKDOWN_CHARS,
                false,
                true,
            ))
        || (object.contains_key("error")
            && !safe_text(
                object.get("error").unwrap(),
                MAX_SUBAGENT_ERROR_CHARS,
                false,
                false,
            ))
        || (object.contains_key("finishedAt")
            && (!finite_timestamp(object.get("finishedAt"))
                || object.get("finishedAt").and_then(Value::as_u64)? < updated_at))
        || active_has_terminal_fields
        || (state.is_active() && object.contains_key("finishedAt"))
        || (state.is_terminal() && !object.contains_key("finishedAt"))
    {
        return None;
    }

    let milestones = object.get("milestones").map(|milestones| {
        milestones
            .as_array()
            .unwrap()
            .iter()
            .map(|milestone| SubagentMilestoneKind::from_str(milestone.as_str().unwrap()).unwrap())
            .collect()
    });
    Some(SubagentRunSnapshotV1 {
        version: SUBAGENT_RUN_SNAPSHOT_VERSION,
        run_id,
        group_id,
        generation_id,
        child_id,
        chat_id,
        workspace_id,
        revision,
        role,
        label: require_string(object, "label").unwrap().to_string(),
        task_preview: require_string(object, "taskPreview").unwrap().to_string(),
        state,
        activity: object
            .get("activity")
            .and_then(Value::as_str)
            .map(str::to_string),
        started_at,
        updated_at,
        finished_at: object.get("finishedAt").and_then(Value::as_u64),
        model_id: require_string(object, "modelId").unwrap().to_string(),
        turns,
        tools,
        tokens,
        milestones,
        latest_text: object
            .get("latestText")
            .and_then(Value::as_str)
            .map(str::to_string),
        terminal_markdown: object
            .get("terminalMarkdown")
            .and_then(Value::as_str)
            .map(str::to_string),
        error: object
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
        warnings: warnings
            .iter()
            .map(|warning| warning.as_str().unwrap().to_string())
            .collect(),
    })
}

pub fn parse_subagent_run_snapshots_v1(value: &Value) -> Vec<SubagentRunSnapshotV1> {
    let Some(array) = value.as_array() else {
        return Vec::new();
    };
    if array.len() > MAX_SUBAGENT_RUNS_PER_GENERATION {
        return Vec::new();
    }
    let parsed: Option<Vec<SubagentRunSnapshotV1>> =
        array.iter().map(parse_subagent_run_snapshot_v1).collect();
    parsed.unwrap_or_default()
}

/// Build the bounded terminal reference copied onto an assistant message.
pub fn subagent_message_reference(
    generation_id: &str,
    snapshots: &[SubagentRunSnapshotV1],
) -> Option<SubagentMessageReferenceV1> {
    if !is_safe_subagent_identifier(&Value::String(generation_id.to_string()))
        || snapshots.is_empty()
    {
        return None;
    }
    let mut runs: Vec<&SubagentRunSnapshotV1> = Vec::new();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for snapshot in snapshots {
        if snapshot.generation_id != generation_id
            || !snapshot.state.is_terminal()
            || seen.contains(&snapshot.run_id.as_str())
        {
            continue;
        }
        seen.insert(&snapshot.run_id);
        runs.push(snapshot);
        if runs.len() == MAX_SUBAGENT_RUNS_PER_GENERATION {
            break;
        }
    }
    if runs.is_empty() {
        return None;
    }
    let counts = |state: SubagentRunState| -> u64 {
        runs.iter()
            .filter(|snapshot| snapshot.state == state)
            .count() as u64
    };
    Some(SubagentMessageReferenceV1 {
        version: SUBAGENT_RUN_SNAPSHOT_VERSION,
        generation_id: generation_id.to_string(),
        run_ids: runs
            .iter()
            .map(|snapshot| snapshot.run_id.clone())
            .collect(),
        items: Some(
            runs.iter()
                .map(|snapshot| SubagentMessageReferenceItemV1 {
                    run_id: snapshot.run_id.clone(),
                    label: snapshot.label.clone(),
                    role: snapshot.role,
                    state: snapshot.state,
                })
                .collect(),
        ),
        total: runs.len() as u64,
        completed: counts(SubagentRunState::Completed),
        failed: counts(SubagentRunState::Failed),
        timed_out: counts(SubagentRunState::TimedOut),
        interrupted: counts(SubagentRunState::Interrupted),
    })
}

/// Parse a persisted (possibly legacy, items-less) message reference.
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
    let enriched = object.len() == legacy_keys.len() + 1 && object.contains_key("items");
    if (object.len() != legacy_keys.len() && !enriched)
        || !legacy_keys.iter().all(|key| object.contains_key(*key))
        || object
            .keys()
            .any(|key| !legacy_keys.contains(&key.as_str()) && key != "items")
        || object.get("version") != Some(&Value::from(SUBAGENT_RUN_SNAPSHOT_VERSION))
        || !is_safe_subagent_identifier(object.get("generationId").unwrap_or(&Value::Null))
    {
        return None;
    }
    let run_ids = object.get("runIds")?.as_array()?;
    if run_ids.is_empty() || run_ids.len() > MAX_SUBAGENT_RUNS_PER_GENERATION {
        return None;
    }
    for run_id in run_ids {
        if !is_safe_subagent_identifier(run_id) {
            return None;
        }
    }
    let unique: BTreeSet<&str> = run_ids.iter().map(|id| id.as_str().unwrap()).collect();
    if unique.len() != run_ids.len() {
        return None;
    }
    let get_count = |key: &str| -> Option<u64> { object.get(key).and_then(Value::as_u64) };
    if !non_negative_integer(object.get("total"))
        || !non_negative_integer(object.get("completed"))
        || !non_negative_integer(object.get("failed"))
        || !non_negative_integer(object.get("timedOut"))
        || !non_negative_integer(object.get("interrupted"))
    {
        return None;
    }
    let total = get_count("total")?;
    let completed = get_count("completed")?;
    let failed = get_count("failed")?;
    let timed_out = get_count("timedOut")?;
    let interrupted = get_count("interrupted")?;
    let sum = completed + failed + timed_out + interrupted;
    if total != run_ids.len() as u64 || sum != total {
        return None;
    }

    let mut items: Option<Vec<SubagentMessageReferenceItemV1>> = None;
    if enriched {
        let raw_items = object.get("items")?.as_array()?;
        if raw_items.len() != run_ids.len() {
            return None;
        }
        let mut parsed_items: Vec<SubagentMessageReferenceItemV1> = Vec::new();
        for (index, raw_item) in raw_items.iter().enumerate() {
            let item = raw_item.as_object()?;
            if item.len() != 4
                || !["runId", "label", "role", "state"]
                    .iter()
                    .all(|key| item.contains_key(*key))
                || !is_safe_subagent_identifier(item.get("runId").unwrap_or(&Value::Null))
                || item.get("runId").and_then(Value::as_str) != run_ids[index].as_str()
                || !safe_text(
                    item.get("label").unwrap_or(&Value::Null),
                    MAX_SUBAGENT_LABEL_CHARS,
                    false,
                    false,
                )
            {
                return None;
            }
            let role = item
                .get("role")
                .and_then(Value::as_str)
                .and_then(SubagentSnapshotRole::from_str)?;
            let state = item
                .get("state")
                .and_then(Value::as_str)
                .and_then(SubagentRunState::from_str)?;
            if !state.is_terminal() {
                return None;
            }
            parsed_items.push(SubagentMessageReferenceItemV1 {
                run_id: item.get("runId").unwrap().as_str().unwrap().to_string(),
                label: item.get("label").unwrap().as_str().unwrap().to_string(),
                role,
                state,
            });
        }
        let item_count = |state: SubagentRunState| -> u64 {
            parsed_items
                .iter()
                .filter(|item| item.state == state)
                .count() as u64
        };
        if item_count(SubagentRunState::Completed) != completed
            || item_count(SubagentRunState::Failed) != failed
            || item_count(SubagentRunState::TimedOut) != timed_out
            || item_count(SubagentRunState::Interrupted) != interrupted
        {
            return None;
        }
        items = Some(parsed_items);
    }

    Some(SubagentMessageReferenceV1 {
        version: SUBAGENT_RUN_SNAPSHOT_VERSION,
        generation_id: require_string(object, "generationId").unwrap().to_string(),
        run_ids: run_ids
            .iter()
            .map(|id| id.as_str().unwrap().to_string())
            .collect(),
        items,
        total,
        completed,
        failed,
        timed_out,
        interrupted,
    })
}

// ===========================================================================
// V2 parser
// ===========================================================================

fn v2_state_as_v1(state: SubagentRunStateV2) -> SubagentRunState {
    match state {
        SubagentRunStateV2::NeedsAttention => SubagentRunState::Running,
        SubagentRunStateV2::Stopped => SubagentRunState::Interrupted,
        SubagentRunStateV2::Unknown => SubagentRunState::Failed,
        SubagentRunStateV2::Queued => SubagentRunState::Queued,
        SubagentRunStateV2::Starting => SubagentRunState::Starting,
        SubagentRunStateV2::Running => SubagentRunState::Running,
        SubagentRunStateV2::Completed => SubagentRunState::Completed,
        SubagentRunStateV2::Failed => SubagentRunState::Failed,
        SubagentRunStateV2::TimedOut => SubagentRunState::TimedOut,
        SubagentRunStateV2::Interrupted => SubagentRunState::Interrupted,
    }
}

/// Project a V2 snapshot (or raw V2 object) down to the V1 shape.
fn v2_base_projection(value: &Value) -> Value {
    let object = value.as_object().unwrap();
    let state =
        SubagentRunStateV2::from_str(object.get("state").unwrap().as_str().unwrap()).unwrap();
    let mut projection = Map::new();
    projection.insert("version".into(), Value::from(SUBAGENT_RUN_SNAPSHOT_VERSION));
    for key in [
        "runId",
        "groupId",
        "generationId",
        "childId",
        "chatId",
        "workspaceId",
        "revision",
        "role",
        "label",
        "taskPreview",
        "startedAt",
        "updatedAt",
        "modelId",
        "turns",
        "tools",
        "tokens",
        "warnings",
    ] {
        projection.insert(
            key.to_string(),
            object.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    projection.insert(
        "state".to_string(),
        Value::String(
            match v2_state_as_v1(state) {
                SubagentRunState::Queued => "queued",
                SubagentRunState::Starting => "starting",
                SubagentRunState::Running => "running",
                SubagentRunState::Completed => "completed",
                SubagentRunState::Failed => "failed",
                SubagentRunState::TimedOut => "timed_out",
                SubagentRunState::Interrupted => "interrupted",
            }
            .to_string(),
        ),
    );
    if state == SubagentRunStateV2::NeedsAttention {
        projection.insert(
            "activity".to_string(),
            Value::String("Needs attention.".into()),
        );
    } else if let Some(activity) = object.get("activity") {
        projection.insert("activity".to_string(), activity.clone());
    }
    for key in [
        "finishedAt",
        "milestones",
        "latestText",
        "terminalMarkdown",
        "error",
    ] {
        if let Some(entry) = object.get(key) {
            projection.insert(key.to_string(), entry.clone());
        }
    }
    Value::Object(projection)
}

pub fn parse_subagent_run_snapshot_v2(value: &Value) -> Option<SubagentRunSnapshotV2> {
    let object = value.as_object()?;
    if !has_exact_snapshot_keys(object, &v2_required_keys(), &v2_optional_keys())
        || object.get("version") != Some(&Value::from(SUBAGENT_RUN_SNAPSHOT_VERSION_V2))
    {
        return None;
    }
    let state = require_string(object, "state").and_then(SubagentRunStateV2::from_str)?;
    let depth = object.get("depth").and_then(Value::as_u64)?;
    if !(1..=2).contains(&depth) {
        return None;
    }
    let execution =
        require_string(object, "execution").and_then(SubagentExecutionModeV2::from_str)?;
    let context = require_string(object, "context").and_then(SubagentContextModeV2::from_str)?;
    if !non_negative_integer(object.get("authorityRevision")) {
        return None;
    }
    let run_id = require_string(object, "runId").unwrap();
    if let Some(parent_run_id) = object.get("parentRunId") {
        if !is_safe_subagent_identifier(parent_run_id) {
            return None;
        }
    }
    if let Some(retry_of_run_id) = object.get("retryOfRunId") {
        if !is_safe_subagent_identifier(retry_of_run_id) {
            return None;
        }
    }
    if (depth == 1 && object.contains_key("parentRunId"))
        || (depth > 1 && !object.contains_key("parentRunId"))
        || object.get("parentRunId").and_then(Value::as_str) == Some(run_id)
        || (state == SubagentRunStateV2::NeedsAttention
            && object.get("activity").and_then(Value::as_str) != Some("Needs attention."))
        || object.get("retryOfRunId").and_then(Value::as_str) == Some(run_id)
    {
        return None;
    }
    let v1 = parse_subagent_run_snapshot_v1(&v2_base_projection(value))?;
    if (state == SubagentRunStateV2::NeedsAttention && object.contains_key("finishedAt"))
        || ((state == SubagentRunStateV2::Stopped || state == SubagentRunStateV2::Unknown)
            && !object.contains_key("finishedAt"))
    {
        return None;
    }
    Some(SubagentRunSnapshotV2 {
        version: SUBAGENT_RUN_SNAPSHOT_VERSION_V2,
        run_id: v1.run_id,
        group_id: v1.group_id,
        generation_id: v1.generation_id,
        child_id: v1.child_id,
        chat_id: v1.chat_id,
        workspace_id: v1.workspace_id,
        revision: v1.revision,
        role: v1.role,
        label: v1.label,
        task_preview: v1.task_preview,
        state,
        activity: v1.activity,
        started_at: v1.started_at,
        updated_at: v1.updated_at,
        finished_at: v1.finished_at,
        model_id: v1.model_id,
        turns: v1.turns,
        tools: v1.tools,
        tokens: v1.tokens,
        milestones: v1.milestones,
        latest_text: v1.latest_text,
        terminal_markdown: v1.terminal_markdown,
        error: v1.error,
        warnings: v1.warnings,
        parent_run_id: object
            .get("parentRunId")
            .and_then(Value::as_str)
            .map(str::to_string),
        retry_of_run_id: object
            .get("retryOfRunId")
            .and_then(Value::as_str)
            .map(str::to_string),
        depth: depth as u8,
        execution,
        context,
        authority_revision: object
            .get("authorityRevision")
            .and_then(Value::as_u64)
            .unwrap(),
    })
}

/// Version-dispatched snapshot parser.
pub fn parse_subagent_run_snapshot(value: &Value) -> Option<SubagentRunSnapshot> {
    if !is_record(value) {
        return None;
    }
    match value.get("version").and_then(Value::as_u64) {
        Some(version) if version == SUBAGENT_RUN_SNAPSHOT_VERSION as u64 => {
            parse_subagent_run_snapshot_v1(value).map(SubagentRunSnapshot::V1)
        }
        Some(version) if version == SUBAGENT_RUN_SNAPSHOT_VERSION_V2 as u64 => {
            parse_subagent_run_snapshot_v2(value).map(SubagentRunSnapshot::V2)
        }
        _ => None,
    }
}

/// An active V1 run is evidence of an interrupted session; the adapter
/// preserves terminal presentation and interrupts active evidence.
pub fn adapt_subagent_run_snapshot_v1_to_v2(
    snapshot: &SubagentRunSnapshotV1,
) -> Option<SubagentRunSnapshotV2> {
    let value = serde_json::to_value(snapshot).ok()?;
    let parsed = parse_subagent_run_snapshot_v1(&value)?;
    let active = parsed.state.is_active();
    let mut object = serde_json::to_value(&parsed)
        .ok()?
        .as_object()
        .unwrap()
        .clone();
    object.insert(
        "version".to_string(),
        Value::from(SUBAGENT_RUN_SNAPSHOT_VERSION_V2),
    );
    object.insert(
        "state".to_string(),
        Value::String(
            if active {
                "interrupted"
            } else {
                match parsed.state {
                    SubagentRunState::Queued => "queued",
                    SubagentRunState::Starting => "starting",
                    SubagentRunState::Running => "running",
                    SubagentRunState::Completed => "completed",
                    SubagentRunState::Failed => "failed",
                    SubagentRunState::TimedOut => "timed_out",
                    SubagentRunState::Interrupted => "interrupted",
                }
            }
            .to_string(),
        ),
    );
    if active {
        object.insert("finishedAt".to_string(), Value::from(parsed.updated_at));
    }
    object.insert("depth".to_string(), Value::from(1));
    object.insert("execution".to_string(), Value::String("foreground".into()));
    object.insert("context".to_string(), Value::String("fresh".into()));
    object.insert("authorityRevision".to_string(), Value::from(0));
    parse_subagent_run_snapshot_v2(&Value::Object(object))
}

pub fn adapt_subagent_run_snapshot_v2_to_v1(
    snapshot: &SubagentRunSnapshotV2,
) -> Option<SubagentRunSnapshotV1> {
    let value = serde_json::to_value(snapshot).ok()?;
    let parsed = parse_subagent_run_snapshot_v2(&value)?;
    parse_subagent_run_snapshot_v1(&v2_base_projection(&serde_json::to_value(&parsed).ok()?))
}

// ===========================================================================
// Effect activity + history detail
// ===========================================================================

fn has_exact_plain_data_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == expected.len() && object.keys().all(|key| expected.contains(&key.as_str()))
}

pub fn parse_subagent_effect_activity_v1(value: &Value) -> Option<SubagentEffectActivityV1> {
    if !has_exact_plain_data_keys(value, &["version", "kind", "state", "label", "updatedAt"])
        || value.get("version") != Some(&Value::from(1))
    {
        return None;
    }
    let kind = require_string(value.as_object()?, "kind").and_then(|value| match value {
        "mcp_mutation" => Some(SubagentEffectActivityKindV1::McpMutation),
        "shell" => Some(SubagentEffectActivityKindV1::Shell),
        _ => None,
    })?;
    let state = require_string(value.as_object()?, "state").and_then(|value| match value {
        "prepared" => Some(SubagentEffectActivityStateV1::Prepared),
        "authorized" => Some(SubagentEffectActivityStateV1::Authorized),
        "dispatch_started" => Some(SubagentEffectActivityStateV1::DispatchStarted),
        "completed" => Some(SubagentEffectActivityStateV1::Completed),
        "remote_error" => Some(SubagentEffectActivityStateV1::RemoteError),
        "cancelled_before_dispatch" => Some(SubagentEffectActivityStateV1::CancelledBeforeDispatch),
        "unknown" => Some(SubagentEffectActivityStateV1::Unknown),
        _ => None,
    })?;
    let label = require_string(value.as_object()?, "label")?;
    if label.is_empty()
        || label.chars().count() > MAX_SUBAGENT_ACTIVITY_CHARS
        || sanitize_subagent_snapshot_text(label) != label
        || !finite_timestamp(value.as_object()?.get("updatedAt"))
    {
        return None;
    }
    Some(SubagentEffectActivityV1 {
        version: 1,
        kind,
        state,
        label: label.to_string(),
        updated_at: value.as_object()?.get("updatedAt")?.as_u64()?,
    })
}

pub fn parse_subagent_history_detail_v1(value: &Value) -> Option<SubagentHistoryDetailV1> {
    if !has_exact_plain_data_keys(value, &["version", "snapshot", "effects"])
        || value.get("version") != Some(&Value::from(1))
    {
        return None;
    }
    let object = value.as_object()?;
    let effects = object.get("effects")?.as_array()?;
    if effects.len() > MAX_SUBAGENT_EFFECT_ACTIVITY {
        return None;
    }
    let snapshot = parse_subagent_run_snapshot(object.get("snapshot")?)?;
    let parsed_effects: Vec<SubagentEffectActivityV1> = effects
        .iter()
        .map(parse_subagent_effect_activity_v1)
        .collect::<Option<_>>()?;
    Some(SubagentHistoryDetailV1 {
        version: 1,
        snapshot,
        effects: parsed_effects,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v1(state: &str) -> Value {
        let active = matches!(state, "queued" | "starting" | "running");
        let mut object = Map::new();
        object.insert("version".into(), json!(1));
        object.insert("runId".into(), json!("run-1"));
        object.insert("groupId".into(), json!("group-1"));
        object.insert("generationId".into(), json!("generation-1"));
        object.insert("childId".into(), json!("child-1"));
        object.insert("chatId".into(), json!("chat-1"));
        object.insert("workspaceId".into(), json!("workspace-1"));
        object.insert("revision".into(), json!(1));
        object.insert("role".into(), json!("reviewer"));
        object.insert("label".into(), json!("Review"));
        object.insert(
            "taskPreview".into(),
            json!("Review the authority boundary."),
        );
        object.insert("state".into(), json!(state));
        if active {
            object.insert("activity".into(), json!("Reading workspace files"));
        } else {
            object.insert("finishedAt".into(), json!(2_000));
            object.insert("terminalMarkdown".into(), json!("Complete."));
        }
        object.insert("startedAt".into(), json!(1_000));
        object.insert("updatedAt".into(), json!(2_000));
        object.insert("modelId".into(), json!("test-model"));
        object.insert("turns".into(), json!(2));
        object.insert("tools".into(), json!(3));
        object.insert("tokens".into(), json!(100));
        object.insert("warnings".into(), json!([]));
        Value::Object(object)
    }

    fn v2(state: &str) -> Value {
        let v1_state = match state {
            "needs_attention" => "running",
            "stopped" => "interrupted",
            "unknown" => "failed",
            _ => state,
        };
        let mut object = v1(v1_state).as_object().unwrap().clone();
        object.insert("version".into(), json!(2));
        object.insert("state".into(), json!(state));
        if state == "needs_attention" {
            object.insert("activity".into(), json!("Needs attention."));
            object.remove("finishedAt");
            object.remove("terminalMarkdown");
        }
        object.insert("depth".into(), json!(1));
        object.insert("execution".into(), json!("foreground"));
        object.insert("context".into(), json!("fresh"));
        object.insert("authorityRevision".into(), json!(1));
        Value::Object(object)
    }

    #[test]
    fn v1_parsers_remain_exact_while_the_dispatcher_accepts_exact_v2() {
        let snapshot = v2("completed");
        assert_eq!(parse_subagent_run_snapshot_v1(&snapshot), None);
        assert!(parse_subagent_run_snapshot_v2(&snapshot).is_some());
        assert!(parse_subagent_run_snapshot(&snapshot).is_some());
        let mut extra = snapshot.clone();
        extra
            .as_object_mut()
            .unwrap()
            .insert("privateGrantId".into(), json!("grant-1"));
        assert_eq!(parse_subagent_run_snapshot(&extra), None);
        let mut version3 = snapshot;
        version3
            .as_object_mut()
            .unwrap()
            .insert("version".into(), json!(3));
        assert_eq!(parse_subagent_run_snapshot(&version3), None);
    }

    #[test]
    fn v1_migration_preserves_terminal_presentation_and_interrupts_active_evidence() {
        let terminal_value = v1("completed");
        let terminal: SubagentRunSnapshotV1 =
            serde_json::from_value(terminal_value.clone()).unwrap();
        let adapted = adapt_subagent_run_snapshot_v1_to_v2(&terminal);
        let adapted = adapted.unwrap();
        assert_eq!(adapted.state, SubagentRunStateV2::Completed);
        assert_eq!(adapted.authority_revision, 0);
        assert_eq!(adapted.execution, SubagentExecutionModeV2::Foreground);
        assert_eq!(adapted.context, SubagentContextModeV2::Fresh);
        assert_eq!(
            adapt_subagent_run_snapshot_v2_to_v1(&adapted)
                .map(|v| serde_json::to_value(v).unwrap()),
            Some(terminal_value)
        );

        let active_value = v1("running");
        let active: SubagentRunSnapshotV1 = serde_json::from_value(active_value).unwrap();
        let adapted_active = adapt_subagent_run_snapshot_v1_to_v2(&active).unwrap();
        assert_eq!(adapted_active.state, SubagentRunStateV2::Interrupted);
        assert_eq!(adapted_active.finished_at, Some(adapted_active.updated_at));
    }

    #[test]
    fn v2_lifecycle_only_states_project_through_the_unchanged_v1_parser() {
        let attention = v2("needs_attention");
        let attention: SubagentRunSnapshotV2 = serde_json::from_value(attention).unwrap();
        let attention_v1 = adapt_subagent_run_snapshot_v2_to_v1(&attention).unwrap();
        assert_eq!(attention_v1.state, SubagentRunState::Running);
        assert_eq!(attention_v1.activity.as_deref(), Some("Needs attention."));

        let stopped = v2("stopped");
        let stopped: SubagentRunSnapshotV2 = serde_json::from_value(stopped).unwrap();
        let stopped_v1 = adapt_subagent_run_snapshot_v2_to_v1(&stopped).unwrap();
        assert_eq!(stopped_v1.state, SubagentRunState::Interrupted);
        assert!(
            parse_subagent_run_snapshot_v1(&serde_json::to_value(&stopped_v1).unwrap()).is_some()
        );
    }

    #[test]
    fn v2_lineage_and_retry_identities_are_exact_and_non_self_referential() {
        let mut with_parent = v2("completed");
        with_parent
            .as_object_mut()
            .unwrap()
            .insert("parentRunId".into(), json!("run-parent"));
        assert_eq!(parse_subagent_run_snapshot_v2(&with_parent), None);

        let mut depth_two_same = v2("completed");
        {
            let object = depth_two_same.as_object_mut().unwrap();
            object.insert("depth".into(), json!(2));
            object.insert("parentRunId".into(), json!("run-1"));
        }
        assert_eq!(parse_subagent_run_snapshot_v2(&depth_two_same), None);

        let mut depth_two = v2("completed");
        {
            let object = depth_two.as_object_mut().unwrap();
            object.insert("depth".into(), json!(2));
            object.insert("parentRunId".into(), json!("run-parent"));
            object.insert("retryOfRunId".into(), json!("run-prior"));
        }
        assert!(parse_subagent_run_snapshot_v2(&depth_two).is_some());

        let mut retry_self = v2("completed");
        retry_self
            .as_object_mut()
            .unwrap()
            .insert("retryOfRunId".into(), json!("run-1"));
        assert_eq!(parse_subagent_run_snapshot_v2(&retry_self), None);
    }

    #[test]
    fn needs_attention_activity_is_exact_evidence_and_never_silently_normalized() {
        let attention = v2("needs_attention");
        assert!(parse_subagent_run_snapshot_v2(&attention).is_some());
        let mut missing_activity = attention.clone();
        missing_activity.as_object_mut().unwrap().remove("activity");
        assert_eq!(parse_subagent_run_snapshot_v2(&missing_activity), None);
        let mut wrong_activity = attention.clone();
        wrong_activity
            .as_object_mut()
            .unwrap()
            .insert("activity".into(), json!("Waiting for a secret"));
        assert_eq!(parse_subagent_run_snapshot_v2(&wrong_activity), None);
        let mut long_activity = attention;
        long_activity
            .as_object_mut()
            .unwrap()
            .insert("activity".into(), json!("x".repeat(10_000)));
        assert_eq!(parse_subagent_run_snapshot_v2(&long_activity), None);
    }

    #[test]
    fn history_detail_accepts_only_bounded_sanitized_effect_activity_envelopes() {
        let detail = json!({
            "version": 1,
            "snapshot": v2("completed"),
            "effects": [{
                "version": 1,
                "kind": "mcp_mutation",
                "state": "unknown",
                "label": "Remote change outcome unknown. Check the remote system before retrying.",
                "updatedAt": 2_100,
            }],
        });
        assert!(parse_subagent_history_detail_v1(&detail).is_some());
        let mut extra_effect = detail.clone();
        extra_effect["effects"][0]["terminalDigest"] = json!("a".repeat(64));
        assert_eq!(parse_subagent_history_detail_v1(&extra_effect), None);
        let mut extra_detail = detail.clone();
        extra_detail["rawResult"] = json!("secret");
        assert_eq!(parse_subagent_history_detail_v1(&extra_detail), None);
        let mut too_many = detail.clone();
        too_many["effects"] = json!(vec![detail["effects"][0].clone(); 513]);
        assert_eq!(parse_subagent_history_detail_v1(&too_many), None);
    }

    #[test]
    fn message_reference_projection_and_parsing_round_trip() {
        let mut failed = v1("failed");
        failed
            .as_object_mut()
            .unwrap()
            .insert("runId".into(), json!("run-2"));
        let snapshots: Vec<SubagentRunSnapshotV1> = vec![
            serde_json::from_value(v1("completed")).unwrap(),
            serde_json::from_value(failed).unwrap(),
        ];
        let reference = subagent_message_reference("generation-1", &snapshots).unwrap();
        assert_eq!(reference.total, 2);
        assert_eq!(reference.completed, 1);
        assert_eq!(reference.failed, 1);
        let value = serde_json::to_value(&reference).unwrap();
        let parsed = parse_subagent_message_reference_v1(&value).unwrap();
        assert_eq!(parsed, reference);

        // Legacy references without items still replay.
        let legacy = json!({
            "version": 1,
            "generationId": "generation-1",
            "runIds": ["run-1"],
            "total": 1,
            "completed": 1,
            "failed": 0,
            "timedOut": 0,
            "interrupted": 0,
        });
        let parsed = parse_subagent_message_reference_v1(&legacy).unwrap();
        assert!(parsed.items.is_none());
        assert_eq!(parsed.completed, 1);
        // Mismatched counts are rejected.
        let bad = json!({
            "version": 1,
            "generationId": "generation-1",
            "runIds": ["run-1"],
            "total": 2,
            "completed": 1,
            "failed": 0,
            "timedOut": 0,
            "interrupted": 0,
        });
        assert_eq!(parse_subagent_message_reference_v1(&bad), None);
    }

    #[test]
    fn run_snapshot_union_serde_is_version_discriminated() {
        let v2_value = v2("completed");
        let union: SubagentRunSnapshot = serde_json::from_value(v2_value.clone()).unwrap();
        assert!(matches!(union, SubagentRunSnapshot::V2(_)));
        let v1_value = v1("completed");
        let union: SubagentRunSnapshot = serde_json::from_value(v1_value.clone()).unwrap();
        assert!(matches!(union, SubagentRunSnapshot::V1(_)));
        let back = serde_json::to_value(&union).unwrap();
        assert_eq!(back, v1_value);
    }
}
