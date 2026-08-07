//! Port of `main/services/subagents/background-lifecycle-v2.ts` — the private
//! background run lifecycle: event ledger, steering ledger, wait accounting,
//! the strict state machine (`queued → starting → running ↔ needs_attention →
//! terminal`), and the restart/revocation termination paths.

use aiden_core::subagent_runs::{
    parse_subagent_run_snapshot_v2, SubagentRunSnapshotV2, SubagentRunStateV2,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::authority::{
    create_subagent_authority_v2, CreateSubagentAuthorityV2Input, SubagentAuthorityV2,
    SUBAGENT_AUTHORITY_VERSION,
};
use crate::safe_text::{is_safe_subagent_identifier_str, sanitize_subagent_text};

pub const MAX_BACKGROUND_EVENTS_V2: usize = 128;
pub const MAX_BACKGROUND_STEERS_V2: usize = 16;
pub const MAX_BACKGROUND_WAITS_V2: usize = 64;
pub const MAX_BACKGROUND_WAIT_MS_V2: u64 = 30_000;
pub const MAX_BACKGROUND_STEER_CHARS_V2: usize = 8_000;

pub const BACKGROUND_ACTIVE_STATES: &[SubagentRunStateV2] = &[
    SubagentRunStateV2::Queued,
    SubagentRunStateV2::Starting,
    SubagentRunStateV2::Running,
    SubagentRunStateV2::NeedsAttention,
];

fn transitions(state: SubagentRunStateV2) -> &'static [SubagentRunStateV2] {
    match state {
        SubagentRunStateV2::Queued => &[
            SubagentRunStateV2::Starting,
            SubagentRunStateV2::Stopped,
            SubagentRunStateV2::Interrupted,
        ],
        SubagentRunStateV2::Starting => &[
            SubagentRunStateV2::Running,
            SubagentRunStateV2::Failed,
            SubagentRunStateV2::TimedOut,
            SubagentRunStateV2::Stopped,
            SubagentRunStateV2::Interrupted,
            SubagentRunStateV2::Unknown,
        ],
        SubagentRunStateV2::Running => &[
            SubagentRunStateV2::NeedsAttention,
            SubagentRunStateV2::Completed,
            SubagentRunStateV2::Failed,
            SubagentRunStateV2::TimedOut,
            SubagentRunStateV2::Stopped,
            SubagentRunStateV2::Interrupted,
            SubagentRunStateV2::Unknown,
        ],
        SubagentRunStateV2::NeedsAttention => &[
            SubagentRunStateV2::Running,
            SubagentRunStateV2::Failed,
            SubagentRunStateV2::TimedOut,
            SubagentRunStateV2::Stopped,
            SubagentRunStateV2::Interrupted,
            SubagentRunStateV2::Unknown,
        ],
        _ => &[],
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSubagentEventV2 {
    pub sequence: u64,
    pub at: u64,
    pub kind: String,
    pub state: SubagentRunStateV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSubagentSteerV2 {
    pub sequence: u64,
    pub at: u64,
    pub instruction: String,
    pub consumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSubagentManifestV2 {
    pub version: u8,
    pub execution: String,
    pub context: String,
    pub reusable_authority: bool,
    pub accepted_at: u64,
    pub task: String,
    pub authority: SubagentAuthorityV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSubagentRunV2 {
    pub version: u8,
    pub manifest: BackgroundSubagentManifestV2,
    pub snapshot: SubagentRunSnapshotV2,
    pub events: Vec<BackgroundSubagentEventV2>,
    pub steering: Vec<BackgroundSubagentSteerV2>,
    pub wait_count: u64,
    pub waited_ms: u64,
}

/// Store port used by the lifecycle machine.
pub trait BackgroundSubagentStoreV2: Send + Sync {
    fn get(&self, run_id: &str) -> Result<Option<BackgroundSubagentRunV2>, String>;
    fn put(
        &self,
        run: &BackgroundSubagentRunV2,
        expected_revision: Option<u64>,
    ) -> Result<bool, String>;
    fn list(&self) -> Result<Vec<BackgroundSubagentRunV2>, String>;
}

const EVENT_KINDS: &[&str] = &[
    "accepted",
    "transition",
    "wait",
    "steer",
    "stop_requested",
    "reconciled",
];
const RUN_STATES: &[&str] = &[
    "queued",
    "starting",
    "running",
    "needs_attention",
    "completed",
    "failed",
    "timed_out",
    "stopped",
    "interrupted",
    "unknown",
];
const AUTHORITY_KEYS: &[&str] = &[
    "version",
    "grantId",
    "treeRootId",
    "runId",
    "depth",
    "authorityRevision",
    "generationId",
    "chatId",
    "workspaceId",
    "workspaceRevision",
    "ownerDocumentId",
    "providerFingerprint",
    "modelFingerprint",
    "contextRevision",
    "execution",
    "context",
    "thinkingLevel",
    "capabilities",
    "budgets",
    "expiresAt",
];

fn record(value: &Value) -> bool {
    value.is_object()
}

fn has_keys(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() >= required.len()
        && object.len() <= required.len() + optional.len()
        && required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn bounded(value: &Value, maximum: usize) -> Option<&str> {
    let value = value.as_str()?;
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return None;
    }
    Some(value)
}

pub fn parse_background_authority(value: &Value) -> Option<SubagentAuthorityV2> {
    if !record(value) || !has_keys(value, AUTHORITY_KEYS, &["parentRunId"]) {
        return None;
    }
    let input: CreateSubagentAuthorityV2Input = serde_json::from_value(value.clone()).ok()?;
    let authority = create_subagent_authority_v2(&input).ok()?;
    assert_background_authority(&authority).ok()?;
    Some(authority)
}

/// Strict private parser used before any background record crosses durable
/// storage (`parseBackgroundSubagentRunV2`).
pub fn parse_background_subagent_run_v2(value: &Value) -> Option<BackgroundSubagentRunV2> {
    if !record(value)
        || !has_keys(
            value,
            &[
                "version",
                "manifest",
                "snapshot",
                "events",
                "steering",
                "waitCount",
                "waitedMs",
            ],
            &[],
        )
        || value.get("version").and_then(Value::as_u64) != Some(2)
    {
        return None;
    }
    let manifest = value.get("manifest")?;
    if !record(manifest)
        || !has_keys(
            manifest,
            &[
                "version",
                "execution",
                "context",
                "reusableAuthority",
                "acceptedAt",
                "task",
                "authority",
            ],
            &[],
        )
        || manifest.get("version").and_then(Value::as_u64) != Some(2)
        || manifest.get("execution").and_then(Value::as_str) != Some("background")
        || manifest.get("context").and_then(Value::as_str) != Some("fresh")
        || manifest.get("reusableAuthority").and_then(Value::as_bool) != Some(false)
    {
        return None;
    }
    let accepted_at = manifest.get("acceptedAt")?.as_u64()?;
    let task = bounded(manifest.get("task")?, 240)?;
    if sanitize_subagent_text(task) != task {
        return None;
    }
    let events_value = value.get("events")?.as_array()?;
    let steering_value = value.get("steering")?.as_array()?;
    if events_value.is_empty()
        || events_value.len() > MAX_BACKGROUND_EVENTS_V2
        || steering_value.len() > MAX_BACKGROUND_STEERS_V2
        || value
            .get("waitCount")
            .and_then(Value::as_u64)
            .map(|count| count > MAX_BACKGROUND_WAITS_V2 as u64)
            .unwrap_or(true)
        || value
            .get("waitedMs")
            .and_then(Value::as_u64)
            .map(|ms| ms > (MAX_BACKGROUND_WAITS_V2 * MAX_BACKGROUND_WAIT_MS_V2 as usize) as u64)
            .unwrap_or(true)
    {
        return None;
    }
    let authority = parse_background_authority(manifest.get("authority")?)?;
    let snapshot = parse_subagent_run_snapshot_v2(value.get("snapshot")?)?;
    if snapshot.execution != aiden_core::subagent_runs::SubagentExecutionModeV2::Background
        || snapshot.context != aiden_core::subagent_runs::SubagentContextModeV2::Fresh
        || snapshot.run_id != authority.run_id
        || snapshot.generation_id != authority.generation_id
        || snapshot.chat_id != authority.chat_id
        || snapshot.workspace_id != authority.workspace_id
        || snapshot.authority_revision != authority.authority_revision
        || snapshot.task_preview != task
    {
        return None;
    }
    let mut events = Vec::with_capacity(events_value.len());
    let mut previous_sequence = 0u64;
    for (index, item) in events_value.iter().enumerate() {
        if !record(item)
            || !has_keys(item, &["sequence", "at", "kind", "state"], &[])
            || !item
                .get("sequence")
                .and_then(Value::as_u64)
                .map(|sequence| sequence >= 1)
                .unwrap_or(false)
            || (index > 0
                && item.get("sequence").and_then(Value::as_u64) != Some(previous_sequence + 1))
            || !item
                .get("kind")
                .and_then(Value::as_str)
                .map(|kind| EVENT_KINDS.contains(&kind))
                .unwrap_or(false)
            || !item
                .get("state")
                .and_then(Value::as_str)
                .map(|state| RUN_STATES.contains(&state))
                .unwrap_or(false)
        {
            return None;
        }
        previous_sequence = item.get("sequence")?.as_u64()?;
        events.push(BackgroundSubagentEventV2 {
            sequence: previous_sequence,
            at: item.get("at")?.as_u64()?,
            kind: item.get("kind")?.as_str()?.to_string(),
            state: SubagentRunStateV2::from_str(item.get("state")?.as_str()?)?,
        });
    }
    let mut steering = Vec::with_capacity(steering_value.len());
    for (index, item) in steering_value.iter().enumerate() {
        if !record(item)
            || !has_keys(item, &["sequence", "at", "instruction", "consumed"], &[])
            || item.get("sequence").and_then(Value::as_u64) != Some(index as u64 + 1)
            || !bounded(item.get("instruction")?, MAX_BACKGROUND_STEER_CHARS_V2)
                .map(|instruction| sanitize_subagent_text(instruction) == instruction)
                .unwrap_or(false)
            || item.get("consumed").and_then(Value::as_bool).is_none()
        {
            return None;
        }
        steering.push(BackgroundSubagentSteerV2 {
            sequence: index as u64 + 1,
            at: item.get("at")?.as_u64()?,
            instruction: item.get("instruction")?.as_str()?.to_string(),
            consumed: item.get("consumed")?.as_bool()?,
        });
    }
    Some(BackgroundSubagentRunV2 {
        version: 2,
        manifest: BackgroundSubagentManifestV2 {
            version: 2,
            execution: "background".to_string(),
            context: "fresh".to_string(),
            reusable_authority: false,
            accepted_at,
            task: task.to_string(),
            authority,
        },
        snapshot,
        events,
        steering,
        wait_count: value.get("waitCount")?.as_u64()?,
        waited_ms: value.get("waitedMs")?.as_u64()?,
    })
}

#[derive(Debug, Clone)]
pub struct BackgroundSubagentManagementRequestV2 {
    pub version: u8,
    pub action: String,
    pub run_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub owner_document_id: String,
    pub authority_revision: u64,
    pub expected_revision: u64,
    pub timeout_ms: Option<u64>,
    pub instruction: Option<String>,
}

pub fn parse_background_subagent_management_request_v2(
    value: &Value,
) -> Result<BackgroundSubagentManagementRequestV2, String> {
    if !record(value) {
        return Err("Invalid background subagent management request.".to_string());
    }
    let action = value
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?;
    if !["status", "wait", "stop", "steer"].contains(&action) {
        return Err("Invalid background subagent management request fields.".to_string());
    }
    let base = [
        "version",
        "action",
        "runId",
        "chatId",
        "workspaceId",
        "ownerDocumentId",
        "authorityRevision",
        "expectedRevision",
    ];
    let optional: &[&str] = match action {
        "wait" => &["timeoutMs"],
        "steer" => &["instruction"],
        _ => &[],
    };
    if !has_keys(value, &base, optional)
        || value.get("version").and_then(Value::as_u64) != Some(SUBAGENT_AUTHORITY_VERSION as u64)
    {
        return Err("Invalid background subagent management request fields.".to_string());
    }
    for key in ["runId", "chatId", "workspaceId"] {
        if !value
            .get(key)
            .and_then(Value::as_str)
            .map(is_safe_subagent_identifier_str)
            .unwrap_or(false)
        {
            return Err("Invalid background subagent management request fields.".to_string());
        }
    }
    if !bounded(
        value
            .get("ownerDocumentId")
            .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?,
        256,
    )
    .is_some()
    {
        return Err("Invalid background subagent management request fields.".to_string());
    }
    let authority_revision = value
        .get("authorityRevision")
        .and_then(Value::as_u64)
        .filter(|value| *value >= 1)
        .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?;
    let expected_revision = value
        .get("expectedRevision")
        .and_then(Value::as_u64)
        .filter(|value| *value >= 1)
        .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?;
    let timeout_ms = if action == "wait" {
        let value = value
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .filter(|value| *value <= MAX_BACKGROUND_WAIT_MS_V2)
            .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?;
        Some(value)
    } else {
        None
    };
    let instruction = if action == "steer" {
        let value = bounded(
            value.get("instruction").ok_or_else(|| {
                "Invalid background subagent management request fields.".to_string()
            })?,
            MAX_BACKGROUND_STEER_CHARS_V2,
        )
        .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?;
        if value.trim().is_empty() {
            return Err("Invalid background subagent management request fields.".to_string());
        }
        Some(value.to_string())
    } else {
        None
    };
    let run_id = value
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?
        .to_string();
    let chat_id = value
        .get("chatId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?
        .to_string();
    let workspace_id = value
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?
        .to_string();
    let owner_document_id = value
        .get("ownerDocumentId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid background subagent management request fields.".to_string())?
        .to_string();
    Ok(BackgroundSubagentManagementRequestV2 {
        version: 2,
        action: action.to_string(),
        run_id,
        chat_id,
        workspace_id,
        owner_document_id,
        authority_revision,
        expected_revision,
        timeout_ms,
        instruction,
    })
}

pub fn assert_background_authority(authority: &SubagentAuthorityV2) -> Result<(), String> {
    let capabilities = &authority.capabilities;
    if authority.execution != crate::authority::SubagentExecutionModeV2::Background
        || authority.context != crate::authority::SubagentContextModeV2::Fresh
        || authority.depth != 1
        || authority.parent_run_id.is_some()
        || authority.tree_root_id != authority.run_id
        || !capabilities.workspace_read
        || capabilities.workspace_write
        || capabilities.shell
        || capabilities.web
        || capabilities.delegation
        || !capabilities.mcp.is_empty()
    {
        return Err(
            "Background Phase 7A authority must be fresh, depth-1, and read-only without outbound capabilities."
                .to_string(),
        );
    }
    Ok(())
}

fn safe_visible(value: &str, maximum: usize, field: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > maximum {
        return Err(format!("Invalid background {field}."));
    }
    let safe = sanitize_subagent_text(value);
    if safe.trim().is_empty() {
        return Err(format!("Invalid background {field}."));
    }
    Ok(safe)
}

fn event(
    run: &BackgroundSubagentRunV2,
    kind: &str,
    at: u64,
    required: bool,
) -> Result<Vec<BackgroundSubagentEventV2>, String> {
    let next = BackgroundSubagentEventV2 {
        sequence: run.events.last().map(|event| event.sequence).unwrap_or(0) + 1,
        at,
        kind: kind.to_string(),
        state: run.snapshot.state,
    };
    if run.events.len() >= MAX_BACKGROUND_EVENTS_V2 {
        if !required {
            return Err("Background event ledger is full.".to_string());
        }
        let mut next_events = run.events[1..].to_vec();
        next_events.push(next);
        return Ok(next_events);
    }
    let mut next_events = run.events.clone();
    next_events.push(next);
    Ok(next_events)
}

fn set_state(
    run: &mut BackgroundSubagentRunV2,
    state: SubagentRunStateV2,
    activity: &str,
    at: u64,
) -> Result<(), String> {
    if at < run.snapshot.updated_at {
        return Err("Background lifecycle clock moved backwards.".to_string());
    }
    let activity = safe_visible(activity, 512, "activity")?;
    let mut snapshot = run.snapshot.clone();
    snapshot.revision += 1;
    snapshot.state = state;
    snapshot.activity = Some(activity);
    snapshot.updated_at = at;
    if BACKGROUND_ACTIVE_STATES.contains(&state) {
        snapshot.finished_at = None;
    } else {
        snapshot.finished_at = Some(at);
    }
    run.snapshot = snapshot;
    run.events = event(
        run,
        if state == SubagentRunStateV2::Interrupted {
            "reconciled"
        } else {
            "transition"
        },
        at,
        matches!(
            state,
            SubagentRunStateV2::Stopped
                | SubagentRunStateV2::Interrupted
                | SubagentRunStateV2::Unknown
        ),
    )?;
    Ok(())
}

#[derive(Default)]
pub struct BackgroundSubagentHooksV2 {
    pub stop: Option<Box<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>>,
    pub steer: Option<Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>>,
}

/// The background lifecycle machine. All store I/O is synchronous in this port.
pub struct BackgroundSubagentLifecycleV2 {
    store: Box<dyn BackgroundSubagentStoreV2>,
    hooks: BackgroundSubagentHooksV2,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl BackgroundSubagentLifecycleV2 {
    pub fn new(
        store: Box<dyn BackgroundSubagentStoreV2>,
        hooks: BackgroundSubagentHooksV2,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        BackgroundSubagentLifecycleV2 { store, hooks, now }
    }

    pub fn accept(
        &self,
        authority: &SubagentAuthorityV2,
        snapshot_value: &Value,
        task: &str,
    ) -> Result<(String, u64, String), String> {
        assert_background_authority(authority)?;
        let accepted_at = (self.now)();
        let task = safe_visible(task, 240, "task")?;
        let mut snapshot: SubagentRunSnapshotV2 = parse_subagent_run_snapshot_v2(snapshot_value)
            .ok_or_else(|| "Invalid or duplicate background launch acceptance.".to_string())?;
        snapshot.label = safe_visible(&snapshot.label, 80, "label")?;
        snapshot.task_preview = task.clone();
        if let Some(activity) = &snapshot.activity {
            snapshot.activity = Some(safe_visible(activity, 512, "activity")?);
        }
        if snapshot.execution != aiden_core::subagent_runs::SubagentExecutionModeV2::Background
            || snapshot.context != aiden_core::subagent_runs::SubagentContextModeV2::Fresh
            || snapshot.state != SubagentRunStateV2::Queued
            || snapshot.finished_at.is_some()
            || snapshot.depth != 1
            || snapshot.parent_run_id.is_some()
            || authority.expires_at <= accepted_at
            || snapshot.run_id != authority.run_id
            || snapshot.generation_id != authority.generation_id
            || snapshot.chat_id != authority.chat_id
            || snapshot.workspace_id != authority.workspace_id
            || snapshot.authority_revision != authority.authority_revision
        {
            return Err("Invalid or duplicate background launch acceptance.".to_string());
        }
        let mut run = BackgroundSubagentRunV2 {
            version: 2,
            manifest: BackgroundSubagentManifestV2 {
                version: 2,
                execution: "background".to_string(),
                context: "fresh".to_string(),
                reusable_authority: false,
                accepted_at,
                task: task.clone(),
                authority: authority.clone(),
            },
            snapshot,
            events: Vec::new(),
            steering: Vec::new(),
            wait_count: 0,
            waited_ms: 0,
        };
        run.events = event(&run, "accepted", accepted_at, false)?;
        if !self.store.put(&run, None)? {
            return Err("Duplicate background launch acceptance.".to_string());
        }
        Ok((
            run.snapshot.run_id.clone(),
            run.snapshot.revision,
            "queued".to_string(),
        ))
    }

    fn owned(
        &self,
        request: &BackgroundSubagentManagementRequestV2,
    ) -> Result<BackgroundSubagentRunV2, String> {
        let run = self.store.get(&request.run_id)?;
        let Some(run) = run else {
            return Err("Background subagent ownership or revision changed.".to_string());
        };
        let authority = &run.manifest.authority;
        if authority.chat_id != request.chat_id
            || authority.workspace_id != request.workspace_id
            || authority.owner_document_id != request.owner_document_id
            || authority.authority_revision != request.authority_revision
            || run.snapshot.revision != request.expected_revision
        {
            return Err("Background subagent ownership or revision changed.".to_string());
        }
        Ok(run)
    }

    pub fn manage(&self, value: &Value) -> Result<BackgroundSubagentRunV2, String> {
        let request = parse_background_subagent_management_request_v2(value)?;
        let mut run = self.owned(&request)?;
        if request.action == "status" {
            return Ok(run);
        }
        let at = (self.now)();
        if request.action == "wait" {
            if run.wait_count >= MAX_BACKGROUND_WAITS_V2 as u64 {
                return Err("Background wait ledger is full.".to_string());
            }
            run.wait_count += 1;
            run.waited_ms += request.timeout_ms.unwrap_or(0);
            run.snapshot.revision += 1;
            run.snapshot.updated_at = run.snapshot.updated_at.max(at);
            run.events = event(&run, "wait", at, false)?;
        } else if request.action == "steer" {
            if !matches!(
                run.snapshot.state,
                SubagentRunStateV2::Running | SubagentRunStateV2::NeedsAttention
            ) {
                return Err("Background run cannot be steered in its current state.".to_string());
            }
            if run.steering.len() >= MAX_BACKGROUND_STEERS_V2 {
                return Err("Background steering ledger is full.".to_string());
            }
            let instruction = safe_visible(
                request.instruction.as_deref().unwrap_or(""),
                MAX_BACKGROUND_STEER_CHARS_V2,
                "steering instruction",
            )?;
            run.steering.push(BackgroundSubagentSteerV2 {
                sequence: run.steering.len() as u64 + 1,
                at,
                instruction,
                consumed: false,
            });
            run.snapshot.revision += 1;
            run.snapshot.updated_at = run.snapshot.updated_at.max(at);
            run.events = event(&run, "steer", at, false)?;
        } else if request.action == "stop" && BACKGROUND_ACTIVE_STATES.contains(&run.snapshot.state)
        {
            run.events = event(&run, "stop_requested", at, true)?;
            set_state(
                &mut run,
                SubagentRunStateV2::Stopped,
                "Stopped by owner.",
                at,
            )?;
        }
        if !self.store.put(&run, Some(request.expected_revision))? {
            return Err("Background subagent revision changed before persistence.".to_string());
        }
        let hook_result = if request.action == "steer" {
            self.hooks
                .steer
                .as_ref()
                .map(|steer| steer(&run.snapshot.run_id))
        } else if request.action == "stop" && run.snapshot.state == SubagentRunStateV2::Stopped {
            self.hooks
                .stop
                .as_ref()
                .map(|stop| stop(&run.snapshot.run_id, "explicit"))
        } else {
            None
        };
        if let Some(Err(_)) = hook_result {
            self.record_hook_failure(&run.clone())?;
        }
        Ok(run)
    }

    pub fn transition(
        &self,
        value: &Value,
        next: SubagentRunStateV2,
        activity: &str,
    ) -> Result<BackgroundSubagentRunV2, String> {
        let request = parse_background_subagent_management_request_v2(value)?;
        if request.action != "status" {
            return Err("A status ownership proof is required for transition.".to_string());
        }
        let mut run = self.owned(&request)?;
        if !transitions(run.snapshot.state).contains(&next) {
            return Err("Invalid background subagent state transition.".to_string());
        }
        let at = (self.now)();
        if (next == SubagentRunStateV2::Starting || next == SubagentRunStateV2::Running)
            && run.manifest.authority.expires_at <= at
        {
            return Err(
                "Background subagent authority expired before execution transition.".to_string(),
            );
        }
        set_state(&mut run, next, activity, at)?;
        if !self.store.put(&run, Some(request.expected_revision))? {
            return Err("Background subagent revision changed before persistence.".to_string());
        }
        Ok(run)
    }

    fn record_hook_failure(&self, run: &BackgroundSubagentRunV2) -> Result<(), String> {
        let expected_revision = run.snapshot.revision;
        let mut failed = run.clone();
        set_state(
            &mut failed,
            SubagentRunStateV2::Unknown,
            "Lifecycle hook outcome could not be proven.",
            (self.now)(),
        )?;
        if self.store.put(&failed, Some(expected_revision))? {
            return Ok(());
        }
        let Some(current) = self.store.get(&failed.snapshot.run_id)? else {
            return Ok(());
        };
        if !BACKGROUND_ACTIVE_STATES.contains(&current.snapshot.state) {
            return Ok(());
        }
        let retry_revision = current.snapshot.revision;
        let mut retry = current;
        set_state(
            &mut retry,
            SubagentRunStateV2::Unknown,
            "Lifecycle hook outcome could not be proven.",
            (self.now)(),
        )?;
        if !self.store.put(&retry, Some(retry_revision))? {
            return Err("Background hook ambiguity could not be persisted.".to_string());
        }
        Ok(())
    }

    fn terminate(
        &self,
        reason: &str,
        state: SubagentRunStateV2,
        activity: &str,
        matches: &dyn Fn(&BackgroundSubagentRunV2) -> bool,
    ) -> Result<usize, String> {
        let mut count = 0usize;
        let candidates = self.store.list()?;
        for candidate in candidates {
            if !matches(&candidate) {
                continue;
            }
            let mut stored: Option<BackgroundSubagentRunV2> = Some(candidate);
            for _ in 0..2 {
                let Some(current) = &stored else { break };
                if !BACKGROUND_ACTIVE_STATES.contains(&current.snapshot.state) {
                    break;
                }
                let expected_revision = current.snapshot.revision;
                let mut run = current.clone();
                set_state(&mut run, state, activity, (self.now)())?;
                if !self.store.put(&run, Some(expected_revision))? {
                    stored = self.store.get(&current.snapshot.run_id)?;
                    continue;
                }
                if let Some(stop) = &self.hooks.stop {
                    if stop(&run.snapshot.run_id, reason).is_err() {
                        self.record_hook_failure(&run)?;
                    }
                }
                count += 1;
                break;
            }
        }
        Ok(count)
    }

    pub fn reconcile_startup(&self) -> Result<usize, String> {
        self.terminate(
            "shutdown",
            SubagentRunStateV2::Interrupted,
            "Interrupted after Aiden restarted.",
            &|_| true,
        )
    }

    pub fn chat_deleted(&self, chat_id: &str) -> Result<usize, String> {
        self.terminate(
            "chat_deleted",
            SubagentRunStateV2::Stopped,
            "Stopped because the chat was deleted.",
            &|run| run.snapshot.chat_id == chat_id,
        )
    }

    pub fn workspace_revoked(&self, workspace_id: &str) -> Result<usize, String> {
        self.terminate(
            "workspace_revoked",
            SubagentRunStateV2::Stopped,
            "Stopped because workspace access was revoked.",
            &|run| run.snapshot.workspace_id == workspace_id,
        )
    }

    pub fn shutdown(&self) -> Result<usize, String> {
        self.terminate(
            "shutdown",
            SubagentRunStateV2::Interrupted,
            "Interrupted during Aiden shutdown.",
            &|_| true,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_store_v2::create_subagent_run_store_v2;
    use serde_json::json;

    fn background_authority(run_id: &str) -> SubagentAuthorityV2 {
        let input: CreateSubagentAuthorityV2Input = serde_json::from_value(json!({
            "grantId": "grant-1",
            "treeRootId": run_id,
            "runId": run_id,
            "depth": 1,
            "authorityRevision": 1,
            "generationId": "generation-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "workspaceRevision": "workspace-revision-1",
            "ownerDocumentId": "document-1",
            "providerFingerprint": "provider-fingerprint",
            "modelFingerprint": "model-fingerprint",
            "contextRevision": "context-revision",
            "execution": "background",
            "context": "fresh",
            "thinkingLevel": "high",
            "capabilities": json!({
                "workspaceRead": true,
                "workspaceWrite": false,
                "shell": false,
                "web": false,
                "delegation": false,
                "mcp": [],
            }),
            "budgets": json!({
                "deadlineMs": 60_000,
                "maxTurns": 24,
                "maxToolCalls": 64,
                "maxOutputChars": 120_000,
                "maxTokens": 200_000,
                "maxLaunches": 8,
                "maxDepth": 2,
                "maxActive": 4,
                "maxQueued": 8,
                "maxNetworkOperations": 16,
            }),
            "expiresAt": 100_000,
        }))
        .unwrap();
        create_subagent_authority_v2(&input).unwrap()
    }

    fn queued_snapshot(run_id: &str) -> Value {
        json!({
            "version": 2,
            "runId": run_id,
            "groupId": "group-1",
            "generationId": "generation-1",
            "childId": "child-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "revision": 1,
            "role": "scout",
            "label": "Scout",
            "taskPreview": "Explore the workspace.",
            "state": "queued",
            "activity": "Waiting for an execution slot",
            "startedAt": 100,
            "updatedAt": 100,
            "modelId": "model-1",
            "turns": 0,
            "tools": 0,
            "tokens": 0,
            "warnings": [],
            "depth": 1,
            "execution": "background",
            "context": "fresh",
            "authorityRevision": 1,
        })
    }

    fn setup() -> (
        tempfile::TempDir,
        Box<dyn BackgroundSubagentStoreV2>,
        Box<dyn Fn() -> u64 + Send + Sync>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let committed = json!({
            "version": 2,
            "storeRevision": 1,
            "migration": {
                "status": "committed",
                "adapterVersion": 1,
                "source": "missing",
                "sourceGeneration": "missing",
                "sourceSha256": "0".repeat(64),
                "migratedAt": 0,
            },
            "snapshots": [],
            "manifests": [],
            "approvals": [],
            "effects": [],
            "backgroundRuns": [],
            "pendingChatDeletions": [],
            "deletionTransactions": [],
        });
        std::fs::write(
            directory.path().join("runs.json"),
            serde_json::to_string_pretty(&committed).unwrap(),
        )
        .unwrap();
        let store =
            create_subagent_run_store_v2(directory.path().to_path_buf(), Default::default())
                .unwrap();
        store.initialize().unwrap();
        let clock = Box::new(move || 5_000u64);
        (
            directory,
            Box::new(store) as Box<dyn BackgroundSubagentStoreV2>,
            clock,
        )
    }

    #[test]
    fn accept_then_transition_through_the_state_machine() {
        let (_directory, store, clock) = setup();
        let lifecycle =
            BackgroundSubagentLifecycleV2::new(store, BackgroundSubagentHooksV2::default(), clock);
        let authority = background_authority("run-1");
        let (run_id, revision, state) = lifecycle
            .accept(
                &authority,
                &queued_snapshot("run-1"),
                "Explore the workspace.",
            )
            .unwrap();
        assert_eq!(run_id, "run-1");
        assert_eq!(state, "queued");
        let status = json!({
            "version": 2,
            "action": "status",
            "runId": "run-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "ownerDocumentId": "document-1",
            "authorityRevision": 1,
            "expectedRevision": revision,
        });
        let starting = lifecycle
            .transition(
                &status,
                SubagentRunStateV2::Starting,
                "Starting a fresh child agent",
            )
            .unwrap();
        assert_eq!(starting.snapshot.state, SubagentRunStateV2::Starting);
        let mut status2 = status.clone();
        status2["expectedRevision"] = serde_json::json!(starting.snapshot.revision);
        let running = lifecycle
            .transition(
                &status2,
                SubagentRunStateV2::Running,
                "Reviewing workspace context",
            )
            .unwrap();
        assert_eq!(running.snapshot.state, SubagentRunStateV2::Running);
        assert_eq!(running.events.last().unwrap().kind, "transition");
        // Invalid transition from running to queued.
        let mut status3 = status2.clone();
        status3["expectedRevision"] = serde_json::json!(running.snapshot.revision);
        assert!(lifecycle
            .transition(&status3, SubagentRunStateV2::Queued, "bad")
            .is_err());
        // Completed is valid.
        let mut status4 = status3.clone();
        status4["expectedRevision"] = serde_json::json!(running.snapshot.revision);
        let completed = lifecycle
            .transition(
                &status4,
                SubagentRunStateV2::Completed,
                "Completed successfully.",
            )
            .unwrap();
        assert_eq!(completed.snapshot.state, SubagentRunStateV2::Completed);
        assert!(completed.snapshot.finished_at.is_some());
    }

    #[test]
    fn steer_requires_running_and_is_bounded() {
        let (_directory, store, clock) = setup();
        let lifecycle =
            BackgroundSubagentLifecycleV2::new(store, BackgroundSubagentHooksV2::default(), clock);
        let authority = background_authority("run-1");
        lifecycle
            .accept(
                &authority,
                &queued_snapshot("run-1"),
                "Explore the workspace.",
            )
            .unwrap();
        let status = json!({
            "version": 2,
            "action": "status",
            "runId": "run-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "ownerDocumentId": "document-1",
            "authorityRevision": 1,
            "expectedRevision": 1,
        });
        let starting = lifecycle
            .transition(
                &status,
                SubagentRunStateV2::Starting,
                "Starting a fresh child agent",
            )
            .unwrap();
        let mut status2 = status.clone();
        status2["expectedRevision"] = serde_json::json!(starting.snapshot.revision);
        let run = lifecycle
            .transition(
                &status2,
                SubagentRunStateV2::Running,
                "Reviewing workspace context",
            )
            .unwrap();
        let steer = json!({
            "version": 2,
            "action": "steer",
            "runId": "run-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "ownerDocumentId": "document-1",
            "authorityRevision": 1,
            "expectedRevision": run.snapshot.revision,
            "instruction": "Focus on the security boundary.",
        });
        let steered = lifecycle.manage(&steer).unwrap();
        assert_eq!(steered.steering.len(), 1);
        assert_eq!(
            steered.steering[0].instruction,
            "Focus on the security boundary."
        );
        // Oversized steering is rejected.
        let bad_steer = json!({
            "version": 2,
            "action": "steer",
            "runId": "run-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "ownerDocumentId": "document-1",
            "authorityRevision": 1,
            "expectedRevision": steered.snapshot.revision,
            "instruction": "x".repeat(8_001),
        });
        assert!(lifecycle.manage(&bad_steer).is_err());
    }

    #[test]
    fn stop_and_restart_reconciliation() {
        let (_directory, store, clock) = setup();
        let lifecycle =
            BackgroundSubagentLifecycleV2::new(store, BackgroundSubagentHooksV2::default(), clock);
        let authority = background_authority("run-1");
        lifecycle
            .accept(
                &authority,
                &queued_snapshot("run-1"),
                "Explore the workspace.",
            )
            .unwrap();
        let stop = json!({
            "version": 2,
            "action": "stop",
            "runId": "run-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "ownerDocumentId": "document-1",
            "authorityRevision": 1,
            "expectedRevision": 1,
        });
        let stopped = lifecycle.manage(&stop).unwrap();
        assert_eq!(stopped.snapshot.state, SubagentRunStateV2::Stopped);
        // Restart reconciliation leaves stopped runs alone.
        let count = lifecycle.reconcile_startup().unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn chat_deleted_terminates_matching_runs() {
        let (_directory, store, clock) = setup();
        let lifecycle =
            BackgroundSubagentLifecycleV2::new(store, BackgroundSubagentHooksV2::default(), clock);
        let authority = background_authority("run-1");
        lifecycle
            .accept(
                &authority,
                &queued_snapshot("run-1"),
                "Explore the workspace.",
            )
            .unwrap();
        let count = lifecycle.chat_deleted("chat-1").unwrap();
        assert_eq!(count, 1);
        let run = lifecycle
            .manage(&json!({
                "version": 2,
                "action": "status",
                "runId": "run-1",
                "chatId": "chat-1",
                "workspaceId": "workspace-1",
                "ownerDocumentId": "document-1",
                "authorityRevision": 1,
                "expectedRevision": 2,
            }))
            .unwrap();
        assert_eq!(run.snapshot.state, SubagentRunStateV2::Stopped);
        assert_eq!(
            run.snapshot.activity.as_deref(),
            Some("Stopped because the chat was deleted.")
        );
    }
}
