//! Port of `main/services/subagents/subagent-effect-v2.ts` — durable effect
//! records bound by argument/effect/authority digests, with the terminal-state
//! pairing rules and the renderer activity projection.

use aiden_core::subagent_runs::{
    SubagentEffectActivityKindV1, SubagentEffectActivityStateV1, SubagentEffectActivityV1,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::safe_text::is_safe_subagent_identifier_str;

pub const MAX_DURABLE_SUBAGENT_EFFECTS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableSubagentApprovalStateV2 {
    Prepared,
    Authorized,
    Consumed,
    Cancelled,
}

impl DurableSubagentApprovalStateV2 {
    pub fn as_str(self) -> &'static str {
        match self {
            DurableSubagentApprovalStateV2::Prepared => "prepared",
            DurableSubagentApprovalStateV2::Authorized => "authorized",
            DurableSubagentApprovalStateV2::Consumed => "consumed",
            DurableSubagentApprovalStateV2::Cancelled => "cancelled",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "prepared" => Some(DurableSubagentApprovalStateV2::Prepared),
            "authorized" => Some(DurableSubagentApprovalStateV2::Authorized),
            "consumed" => Some(DurableSubagentApprovalStateV2::Consumed),
            "cancelled" => Some(DurableSubagentApprovalStateV2::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableSubagentEffectStateV2 {
    Prepared,
    Authorized,
    DispatchStarted,
    Completed,
    RemoteError,
    CancelledBeforeDispatch,
    Unknown,
}

impl DurableSubagentEffectStateV2 {
    pub fn as_str(self) -> &'static str {
        match self {
            DurableSubagentEffectStateV2::Prepared => "prepared",
            DurableSubagentEffectStateV2::Authorized => "authorized",
            DurableSubagentEffectStateV2::DispatchStarted => "dispatch_started",
            DurableSubagentEffectStateV2::Completed => "completed",
            DurableSubagentEffectStateV2::RemoteError => "remote_error",
            DurableSubagentEffectStateV2::CancelledBeforeDispatch => "cancelled_before_dispatch",
            DurableSubagentEffectStateV2::Unknown => "unknown",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "prepared" => Some(DurableSubagentEffectStateV2::Prepared),
            "authorized" => Some(DurableSubagentEffectStateV2::Authorized),
            "dispatch_started" => Some(DurableSubagentEffectStateV2::DispatchStarted),
            "completed" => Some(DurableSubagentEffectStateV2::Completed),
            "remote_error" => Some(DurableSubagentEffectStateV2::RemoteError),
            "cancelled_before_dispatch" => {
                Some(DurableSubagentEffectStateV2::CancelledBeforeDispatch)
            }
            "unknown" => Some(DurableSubagentEffectStateV2::Unknown),
            _ => None,
        }
    }
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            DurableSubagentEffectStateV2::Completed
                | DurableSubagentEffectStateV2::RemoteError
                | DurableSubagentEffectStateV2::CancelledBeforeDispatch
                | DurableSubagentEffectStateV2::Unknown
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentEffectKindV2 {
    McpMutation,
    Shell,
}

impl SubagentEffectKindV2 {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentEffectKindV2::McpMutation => "mcp_mutation",
            SubagentEffectKindV2::Shell => "shell",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "mcp_mutation" => Some(SubagentEffectKindV2::McpMutation),
            "shell" => Some(SubagentEffectKindV2::Shell),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableSubagentApprovalV2 {
    pub version: u8,
    pub approval_id: String,
    pub effect_id: String,
    pub run_id: String,
    pub chat_id: String,
    pub child_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub state: DurableSubagentApprovalStateV2,
    pub argument_digest: String,
    pub effect_digest: String,
    pub authority_digest: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableSubagentEffectV2 {
    pub version: u8,
    pub effect_id: String,
    pub approval_id: String,
    pub run_id: String,
    pub chat_id: String,
    pub child_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub effect_kind: SubagentEffectKindV2,
    pub state: DurableSubagentEffectStateV2,
    pub argument_digest: String,
    pub effect_digest: String,
    pub authority_digest: String,
    pub prepared_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_digest: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PrepareDurableSubagentEffectV2Input {
    pub approval_id: String,
    pub effect_id: String,
    pub run_id: String,
    pub chat_id: String,
    pub child_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub effect_kind: SubagentEffectKindV2,
    pub argument_digest: String,
    pub effect_digest: String,
    pub authority_digest: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableSubagentEffectOwnerV2 {
    pub effect_id: String,
    pub approval_id: String,
    pub run_id: String,
    pub chat_id: String,
}

#[derive(Debug, Clone)]
pub struct FinishDurableSubagentEffectV2Input {
    pub effect_id: String,
    pub approval_id: String,
    pub run_id: String,
    pub chat_id: String,
    pub state: DurableSubagentEffectStateV2,
    pub terminal_digest: String,
}

fn is_digest(value: &Value) -> bool {
    value
        .as_str()
        .map(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .unwrap_or(false)
}

fn identities(value: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|key| {
        value
            .get(*key)
            .map(|entry| {
                entry
                    .as_str()
                    .map(is_safe_subagent_identifier_str)
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    })
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

fn timestamp(value: &Value) -> bool {
    value
        .as_f64()
        .map(|value| value.is_finite() && value >= 0.0)
        .unwrap_or(false)
}

pub fn parse_prepare_durable_subagent_effect_v2_input(
    value: &Value,
) -> Option<PrepareDurableSubagentEffectV2Input> {
    if !has_keys(
        value,
        &[
            "approvalId",
            "effectId",
            "runId",
            "chatId",
            "childId",
            "toolCallId",
            "toolName",
            "effectKind",
            "argumentDigest",
            "effectDigest",
            "authorityDigest",
            "expiresAt",
        ],
        &[],
    ) || !identities(
        value,
        &[
            "approvalId",
            "effectId",
            "runId",
            "chatId",
            "childId",
            "toolCallId",
            "toolName",
        ],
    ) {
        return None;
    }
    let effect_kind = value
        .get("effectKind")
        .and_then(Value::as_str)
        .and_then(SubagentEffectKindV2::from_str)?;
    let argument_digest = value.get("argumentDigest")?;
    let effect_digest = value.get("effectDigest")?;
    let authority_digest = value.get("authorityDigest")?;
    if !is_digest(argument_digest) || !is_digest(effect_digest) || !is_digest(authority_digest) {
        return None;
    }
    let expires_at = value.get("expiresAt")?;
    if !timestamp(expires_at) {
        return None;
    }
    Some(PrepareDurableSubagentEffectV2Input {
        approval_id: value["approvalId"].as_str()?.to_string(),
        effect_id: value["effectId"].as_str()?.to_string(),
        run_id: value["runId"].as_str()?.to_string(),
        chat_id: value["chatId"].as_str()?.to_string(),
        child_id: value["childId"].as_str()?.to_string(),
        tool_call_id: value["toolCallId"].as_str()?.to_string(),
        tool_name: value["toolName"].as_str()?.to_string(),
        effect_kind,
        argument_digest: argument_digest.as_str()?.to_string(),
        effect_digest: effect_digest.as_str()?.to_string(),
        authority_digest: authority_digest.as_str()?.to_string(),
        expires_at: expires_at.as_u64()?,
    })
}

pub fn parse_durable_subagent_effect_owner_v2(
    value: &Value,
) -> Option<DurableSubagentEffectOwnerV2> {
    if !has_keys(value, &["effectId", "approvalId", "runId", "chatId"], &[])
        || !identities(value, &["effectId", "approvalId", "runId", "chatId"])
    {
        return None;
    }
    Some(DurableSubagentEffectOwnerV2 {
        effect_id: value["effectId"].as_str()?.to_string(),
        approval_id: value["approvalId"].as_str()?.to_string(),
        run_id: value["runId"].as_str()?.to_string(),
        chat_id: value["chatId"].as_str()?.to_string(),
    })
}

pub fn parse_finish_durable_subagent_effect_v2_input(
    value: &Value,
) -> Option<FinishDurableSubagentEffectV2Input> {
    if !has_keys(
        value,
        &[
            "effectId",
            "approvalId",
            "runId",
            "chatId",
            "state",
            "terminalDigest",
        ],
        &[],
    ) || !identities(value, &["effectId", "approvalId", "runId", "chatId"])
    {
        return None;
    }
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .and_then(DurableSubagentEffectStateV2::from_str)?;
    if !matches!(
        state,
        DurableSubagentEffectStateV2::Completed
            | DurableSubagentEffectStateV2::RemoteError
            | DurableSubagentEffectStateV2::Unknown
    ) {
        return None;
    }
    let terminal_digest = value.get("terminalDigest")?;
    if !is_digest(terminal_digest) {
        return None;
    }
    Some(FinishDurableSubagentEffectV2Input {
        effect_id: value["effectId"].as_str()?.to_string(),
        approval_id: value["approvalId"].as_str()?.to_string(),
        run_id: value["runId"].as_str()?.to_string(),
        chat_id: value["chatId"].as_str()?.to_string(),
        state,
        terminal_digest: terminal_digest.as_str()?.to_string(),
    })
}

pub fn parse_durable_subagent_approval_v2(value: &Value) -> Option<DurableSubagentApprovalV2> {
    if !has_keys(
        value,
        &[
            "version",
            "approvalId",
            "effectId",
            "runId",
            "chatId",
            "childId",
            "toolCallId",
            "toolName",
            "state",
            "argumentDigest",
            "effectDigest",
            "authorityDigest",
            "createdAt",
            "updatedAt",
            "expiresAt",
        ],
        &[],
    ) || value.get("version").and_then(Value::as_u64) != Some(1)
        || !identities(
            value,
            &[
                "approvalId",
                "effectId",
                "runId",
                "chatId",
                "childId",
                "toolCallId",
                "toolName",
            ],
        )
    {
        return None;
    }
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .and_then(DurableSubagentApprovalStateV2::from_str)?;
    for key in ["argumentDigest", "effectDigest", "authorityDigest"] {
        if !is_digest(value.get(key)?) {
            return None;
        }
    }
    let created_at = value.get("createdAt")?.as_u64()?;
    let updated_at = value.get("updatedAt")?.as_u64()?;
    let expires_at = value.get("expiresAt")?.as_u64()?;
    if updated_at < created_at || expires_at < created_at {
        return None;
    }
    Some(DurableSubagentApprovalV2 {
        version: 1,
        approval_id: value["approvalId"].as_str()?.to_string(),
        effect_id: value["effectId"].as_str()?.to_string(),
        run_id: value["runId"].as_str()?.to_string(),
        chat_id: value["chatId"].as_str()?.to_string(),
        child_id: value["childId"].as_str()?.to_string(),
        tool_call_id: value["toolCallId"].as_str()?.to_string(),
        tool_name: value["toolName"].as_str()?.to_string(),
        state,
        argument_digest: value["argumentDigest"].as_str()?.to_string(),
        effect_digest: value["effectDigest"].as_str()?.to_string(),
        authority_digest: value["authorityDigest"].as_str()?.to_string(),
        created_at,
        updated_at,
        expires_at,
    })
}

pub fn parse_durable_subagent_effect_v2(value: &Value) -> Option<DurableSubagentEffectV2> {
    if !has_keys(
        value,
        &[
            "version",
            "effectId",
            "approvalId",
            "runId",
            "chatId",
            "childId",
            "toolCallId",
            "toolName",
            "effectKind",
            "state",
            "argumentDigest",
            "effectDigest",
            "authorityDigest",
            "preparedAt",
            "updatedAt",
        ],
        &["terminalDigest"],
    ) || value.get("version").and_then(Value::as_u64) != Some(1)
        || !identities(
            value,
            &[
                "effectId",
                "approvalId",
                "runId",
                "chatId",
                "childId",
                "toolCallId",
                "toolName",
            ],
        )
    {
        return None;
    }
    let effect_kind = value
        .get("effectKind")
        .and_then(Value::as_str)
        .and_then(SubagentEffectKindV2::from_str)?;
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .and_then(DurableSubagentEffectStateV2::from_str)?;
    for key in ["argumentDigest", "effectDigest", "authorityDigest"] {
        if !is_digest(value.get(key)?) {
            return None;
        }
    }
    let prepared_at = value.get("preparedAt")?.as_u64()?;
    let updated_at = value.get("updatedAt")?.as_u64()?;
    if updated_at < prepared_at {
        return None;
    }
    let terminal_digest = value.get("terminalDigest");
    if (state.is_terminal() && !terminal_digest.map(is_digest).unwrap_or(false))
        || (!state.is_terminal() && terminal_digest.is_some())
    {
        return None;
    }
    Some(DurableSubagentEffectV2 {
        version: 1,
        effect_id: value["effectId"].as_str()?.to_string(),
        approval_id: value["approvalId"].as_str()?.to_string(),
        run_id: value["runId"].as_str()?.to_string(),
        chat_id: value["chatId"].as_str()?.to_string(),
        child_id: value["childId"].as_str()?.to_string(),
        tool_call_id: value["toolCallId"].as_str()?.to_string(),
        tool_name: value["toolName"].as_str()?.to_string(),
        effect_kind,
        state,
        argument_digest: value["argumentDigest"].as_str()?.to_string(),
        effect_digest: value["effectDigest"].as_str()?.to_string(),
        authority_digest: value["authorityDigest"].as_str()?.to_string(),
        prepared_at,
        updated_at,
        terminal_digest: terminal_digest.and_then(Value::as_str).map(str::to_string),
    })
}

/// `durableSubagentEffectRecordsMatchV2` — the approval/effect pair must agree
/// on every identity, digest, and paired state.
pub fn durable_subagent_effect_records_match_v2(
    approval: &DurableSubagentApprovalV2,
    effect: &DurableSubagentEffectV2,
) -> bool {
    let paired_state = (effect.state == DurableSubagentEffectStateV2::Prepared
        && approval.state == DurableSubagentApprovalStateV2::Prepared)
        || (effect.state == DurableSubagentEffectStateV2::Authorized
            && approval.state == DurableSubagentApprovalStateV2::Authorized)
        || (effect.state == DurableSubagentEffectStateV2::CancelledBeforeDispatch
            && approval.state == DurableSubagentApprovalStateV2::Cancelled)
        || (matches!(
            effect.state,
            DurableSubagentEffectStateV2::DispatchStarted
                | DurableSubagentEffectStateV2::Completed
                | DurableSubagentEffectStateV2::RemoteError
                | DurableSubagentEffectStateV2::Unknown
        ) && approval.state == DurableSubagentApprovalStateV2::Consumed);
    paired_state
        && approval.approval_id == effect.approval_id
        && approval.effect_id == effect.effect_id
        && approval.run_id == effect.run_id
        && approval.chat_id == effect.chat_id
        && approval.child_id == effect.child_id
        && approval.tool_call_id == effect.tool_call_id
        && approval.tool_name == effect.tool_name
        && approval.argument_digest == effect.argument_digest
        && approval.effect_digest == effect.effect_digest
        && approval.authority_digest == effect.authority_digest
        && approval.created_at == effect.prepared_at
        && approval.updated_at == effect.updated_at
}

/// `subagentEffectEvidenceDigestV2` — fixed evidence labels.
pub fn subagent_effect_evidence_digest_v2(label: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-subagent-effect-evidence-v1\0");
    hasher.update(label.as_bytes());
    crate::authority::hex(&hasher.finalize())
}

pub fn is_durable_subagent_effect_terminal_v2(state: DurableSubagentEffectStateV2) -> bool {
    state.is_terminal()
}

fn effect_activity_label(
    kind: SubagentEffectKindV2,
    state: DurableSubagentEffectStateV2,
) -> &'static str {
    match (kind, state) {
        (SubagentEffectKindV2::McpMutation, DurableSubagentEffectStateV2::Prepared) => {
            "Remote change prepared"
        }
        (SubagentEffectKindV2::McpMutation, DurableSubagentEffectStateV2::Authorized) => {
            "Remote change authorized"
        }
        (SubagentEffectKindV2::McpMutation, DurableSubagentEffectStateV2::DispatchStarted) => {
            "Remote change sent"
        }
        (SubagentEffectKindV2::McpMutation, DurableSubagentEffectStateV2::Completed) => {
            "Remote change completed"
        }
        (SubagentEffectKindV2::McpMutation, DurableSubagentEffectStateV2::RemoteError) => {
            "Remote change failed"
        }
        (
            SubagentEffectKindV2::McpMutation,
            DurableSubagentEffectStateV2::CancelledBeforeDispatch,
        ) => "Remote change cancelled before sending",
        (SubagentEffectKindV2::McpMutation, DurableSubagentEffectStateV2::Unknown) => {
            "Remote change outcome unknown. Check the remote system before retrying."
        }
        (SubagentEffectKindV2::Shell, DurableSubagentEffectStateV2::Prepared) => "Command prepared",
        (SubagentEffectKindV2::Shell, DurableSubagentEffectStateV2::Authorized) => {
            "Command authorized"
        }
        (SubagentEffectKindV2::Shell, DurableSubagentEffectStateV2::DispatchStarted) => {
            "Command started"
        }
        (SubagentEffectKindV2::Shell, DurableSubagentEffectStateV2::Completed) => {
            "Command completed"
        }
        (SubagentEffectKindV2::Shell, DurableSubagentEffectStateV2::RemoteError) => {
            "Command failed"
        }
        (SubagentEffectKindV2::Shell, DurableSubagentEffectStateV2::CancelledBeforeDispatch) => {
            "Command cancelled before starting"
        }
        (SubagentEffectKindV2::Shell, DurableSubagentEffectStateV2::Unknown) => {
            "Command outcome unknown. Check the workspace before retrying."
        }
    }
}

/// `projectDurableSubagentEffectActivityV1` — renderer-safe activity.
pub fn project_durable_subagent_effect_activity_v1(
    effect: &DurableSubagentEffectV2,
) -> SubagentEffectActivityV1 {
    let kind = match effect.effect_kind {
        SubagentEffectKindV2::McpMutation => SubagentEffectActivityKindV1::McpMutation,
        SubagentEffectKindV2::Shell => SubagentEffectActivityKindV1::Shell,
    };
    let state = match effect.state {
        DurableSubagentEffectStateV2::Prepared => SubagentEffectActivityStateV1::Prepared,
        DurableSubagentEffectStateV2::Authorized => SubagentEffectActivityStateV1::Authorized,
        DurableSubagentEffectStateV2::DispatchStarted => {
            SubagentEffectActivityStateV1::DispatchStarted
        }
        DurableSubagentEffectStateV2::Completed => SubagentEffectActivityStateV1::Completed,
        DurableSubagentEffectStateV2::RemoteError => SubagentEffectActivityStateV1::RemoteError,
        DurableSubagentEffectStateV2::CancelledBeforeDispatch => {
            SubagentEffectActivityStateV1::CancelledBeforeDispatch
        }
        DurableSubagentEffectStateV2::Unknown => SubagentEffectActivityStateV1::Unknown,
    };
    SubagentEffectActivityV1 {
        version: 1,
        kind,
        state,
        label: effect_activity_label(effect.effect_kind, effect.state).to_string(),
        updated_at: effect.updated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn digest(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    fn approval() -> Value {
        json!({
            "version": 1,
            "approvalId": "approval-1",
            "effectId": "effect-1",
            "runId": "run-1",
            "chatId": "chat-1",
            "childId": "child-1",
            "toolCallId": "call-1",
            "toolName": "run_command",
            "state": "prepared",
            "argumentDigest": digest(1),
            "effectDigest": digest(2),
            "authorityDigest": digest(3),
            "createdAt": 100,
            "updatedAt": 100,
            "expiresAt": 10_000,
        })
    }

    fn effect(state: &str) -> Value {
        let mut value = json!({
            "version": 1,
            "effectId": "effect-1",
            "approvalId": "approval-1",
            "runId": "run-1",
            "chatId": "chat-1",
            "childId": "child-1",
            "toolCallId": "call-1",
            "toolName": "run_command",
            "effectKind": "shell",
            "state": state,
            "argumentDigest": digest(1),
            "effectDigest": digest(2),
            "authorityDigest": digest(3),
            "preparedAt": 100,
            "updatedAt": 100,
        });
        if matches!(
            state,
            "completed" | "remote_error" | "unknown" | "cancelled_before_dispatch"
        ) {
            value["terminalDigest"] = json!(digest(9));
        }
        value
    }

    #[test]
    fn parses_exact_approval_and_effect_records() {
        let approval = parse_durable_subagent_approval_v2(&approval()).unwrap();
        assert_eq!(approval.approval_id, "approval-1");
        let prepared = parse_durable_subagent_effect_v2(&effect("prepared")).unwrap();
        assert_eq!(prepared.state, DurableSubagentEffectStateV2::Prepared);
        // terminal state without terminalDigest fails
        let mut bad = effect("completed");
        bad.as_object_mut().unwrap().remove("terminalDigest");
        assert!(parse_durable_subagent_effect_v2(&bad).is_none());
        // non-terminal state with terminalDigest fails
        let mut bad = effect("prepared");
        bad["terminalDigest"] = json!(digest(9));
        assert!(parse_durable_subagent_effect_v2(&bad).is_none());
        // extra key fails
        let mut bad = effect("prepared");
        bad["extra"] = json!(1);
        assert!(parse_durable_subagent_effect_v2(&bad).is_none());
    }

    #[test]
    fn prepared_input_and_owner_parsing() {
        let input = json!({
            "approvalId": "approval-1",
            "effectId": "effect-1",
            "runId": "run-1",
            "chatId": "chat-1",
            "childId": "child-1",
            "toolCallId": "call-1",
            "toolName": "run_command",
            "effectKind": "shell",
            "argumentDigest": digest(1),
            "effectDigest": digest(2),
            "authorityDigest": digest(3),
            "expiresAt": 10_000,
        });
        let parsed = parse_prepare_durable_subagent_effect_v2_input(&input).unwrap();
        assert_eq!(parsed.effect_kind, SubagentEffectKindV2::Shell);
        // wrong effect kind fails
        let mut bad = input.clone();
        bad["effectKind"] = json!("mutation");
        assert!(parse_prepare_durable_subagent_effect_v2_input(&bad).is_none());
        // unsafe identity fails
        let mut bad = input.clone();
        bad["runId"] = json!("not safe!");
        assert!(parse_prepare_durable_subagent_effect_v2_input(&bad).is_none());
        let owner = parse_durable_subagent_effect_owner_v2(&json!({
            "effectId": "effect-1", "approvalId": "approval-1", "runId": "run-1", "chatId": "chat-1",
        }))
        .unwrap();
        assert_eq!(owner.effect_id, "effect-1");
    }

    #[test]
    fn records_match_requires_paired_state_and_identity() {
        let approval = parse_durable_subagent_approval_v2(&approval()).unwrap();
        let prepared = parse_durable_subagent_effect_v2(&effect("prepared")).unwrap();
        assert!(durable_subagent_effect_records_match_v2(
            &approval, &prepared
        ));
        // Unpaired states.
        let mut authorized_effect = effect("authorized");
        authorized_effect["state"] = json!("authorized");
        let authorized = parse_durable_subagent_effect_v2(&authorized_effect).unwrap();
        assert!(!durable_subagent_effect_records_match_v2(
            &approval,
            &authorized
        ));
        // Identity drift.
        let mut drifted_value = serde_json::to_value(&approval).unwrap();
        drifted_value["effectId"] = json!("effect-other");
        let drifted = parse_durable_subagent_approval_v2(&drifted_value).unwrap();
        assert!(!durable_subagent_effect_records_match_v2(
            &drifted, &prepared
        ));
    }

    #[test]
    fn evidence_digests_are_fixed() {
        assert_eq!(
            subagent_effect_evidence_digest_v2("startup_cancelled_before_dispatch").len(),
            64
        );
        assert_eq!(
            subagent_effect_evidence_digest_v2("startup_cancelled_before_dispatch"),
            subagent_effect_evidence_digest_v2("startup_cancelled_before_dispatch")
        );
        assert_ne!(
            subagent_effect_evidence_digest_v2("startup_cancelled_before_dispatch"),
            subagent_effect_evidence_digest_v2("cancelled_before_dispatch")
        );
    }

    #[test]
    fn activity_projection_is_closed_and_labeled() {
        let prepared = parse_durable_subagent_effect_v2(&effect("prepared")).unwrap();
        let activity = project_durable_subagent_effect_activity_v1(&prepared);
        assert_eq!(activity.version, 1);
        assert_eq!(activity.label, "Command prepared");
        let mut unknown = effect("unknown");
        unknown["terminalDigest"] = json!(digest(9));
        let unknown = parse_durable_subagent_effect_v2(&unknown).unwrap();
        assert_eq!(
            project_durable_subagent_effect_activity_v1(&unknown).label,
            "Command outcome unknown. Check the workspace before retrying."
        );
    }
}
