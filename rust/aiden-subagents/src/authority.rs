//! Port of `main/services/subagents/authority-v2.ts` — the V2 authority
//! computation and the positive-intersection capability resolver.
//!
//! Every launch resolves a positive **intersection** of six ceilings —
//! requested ∩ root ∩ parent ∩ role ∩ rollout flags ∩ user grant — then
//! workspace permission gates (`none` → no tools). The result is an immutable
//! `SubagentAuthorityV2` whose canonical JSON (exact field order below, matching
//! the TS object-literal insertion order) is bound by
//! `subagent_authority_digest_v2` (`sha256("aiden-subagent-authority-v2\0" +
//! JSON)`).
//!
//! The parsers mirror the TS exact-key / fail-closed validation, including the
//! effect-profile fingerprint recheck (`subagent_mcp_effect_profile_fingerprint_v2`).

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::contracts::{parse_subagent_tool_request, SubagentTaskRequest};

pub const SUBAGENT_AUTHORITY_VERSION: u8 = 2;
pub const MAX_SUBAGENT_MCP_SCOPES: usize = 16;
pub const MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE: usize = 32;
pub const MAX_SUBAGENT_TREE_DEPTH: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubagentExecutionModeV2 {
    Foreground,
    Background,
}

impl SubagentExecutionModeV2 {
    #[allow(clippy::should_implement_trait)]
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "foreground" => Some(SubagentExecutionModeV2::Foreground),
            "background" => Some(SubagentExecutionModeV2::Background),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentExecutionModeV2::Foreground => "foreground",
            SubagentExecutionModeV2::Background => "background",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubagentContextModeV2 {
    Fresh,
    Fork,
}

impl SubagentContextModeV2 {
    #[allow(clippy::should_implement_trait)]
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "fresh" => Some(SubagentContextModeV2::Fresh),
            "fork" => Some(SubagentContextModeV2::Fork),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentContextModeV2::Fresh => "fresh",
            SubagentContextModeV2::Fork => "fork",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubagentMcpEffectV2 {
    Read,
    Mutating,
}

impl SubagentMcpEffectV2 {
    #[allow(clippy::should_implement_trait)]
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "read" => Some(SubagentMcpEffectV2::Read),
            "mutating" => Some(SubagentMcpEffectV2::Mutating),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentMcpEffectV2::Read => "read",
            SubagentMcpEffectV2::Mutating => "mutating",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentMcpMutationClassificationV2 {
    DeclaredMutating,
    UnprovenMutating,
}

impl SubagentMcpMutationClassificationV2 {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentMcpMutationClassificationV2::DeclaredMutating => "declared_mutating",
            SubagentMcpMutationClassificationV2::UnprovenMutating => "unproven_mutating",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentMcpDestructiveProfileV2 {
    Destructive,
    Additive,
    Unknown,
}

impl SubagentMcpDestructiveProfileV2 {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentMcpDestructiveProfileV2::Destructive => "destructive",
            SubagentMcpDestructiveProfileV2::Additive => "additive",
            SubagentMcpDestructiveProfileV2::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentMcpIdempotencyProfileV2 {
    Idempotent,
    NotDeclared,
}

impl SubagentMcpIdempotencyProfileV2 {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentMcpIdempotencyProfileV2::Idempotent => "idempotent",
            SubagentMcpIdempotencyProfileV2::NotDeclared => "not_declared",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentMcpOpenWorldProfileV2 {
    Open,
    Closed,
    Unknown,
}

impl SubagentMcpOpenWorldProfileV2 {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentMcpOpenWorldProfileV2::Open => "open",
            SubagentMcpOpenWorldProfileV2::Closed => "closed",
            SubagentMcpOpenWorldProfileV2::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentMcpTaskSupportV2 {
    Forbidden,
    Optional,
}

impl SubagentMcpTaskSupportV2 {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentMcpTaskSupportV2::Forbidden => "forbidden",
            SubagentMcpTaskSupportV2::Optional => "optional",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMcpMutationEffectProfileV2 {
    pub classification: SubagentMcpMutationClassificationV2,
    pub destructive: SubagentMcpDestructiveProfileV2,
    pub idempotency: SubagentMcpIdempotencyProfileV2,
    pub open_world: SubagentMcpOpenWorldProfileV2,
    pub task_support: SubagentMcpTaskSupportV2,
    pub fingerprint: String,
}

/// Read tool scope (effect == "read").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMcpReadToolScopeV2 {
    pub tool_name: String,
    pub schema_hash: String,
    pub effect: SubagentMcpEffectV2,
}

/// Mutating tool scope (effect == "mutating").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMcpMutationToolScopeV2 {
    pub tool_name: String,
    pub schema_hash: String,
    pub effect: SubagentMcpEffectV2,
    pub effect_profile: SubagentMcpMutationEffectProfileV2,
}

/// The union of the two tool scopes, discriminated by `effect`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentMcpToolScopeV2 {
    Read(SubagentMcpReadToolScopeV2),
    Mutating(SubagentMcpMutationToolScopeV2),
}

impl SubagentMcpToolScopeV2 {
    pub fn tool_name(&self) -> &str {
        match self {
            SubagentMcpToolScopeV2::Read(scope) => &scope.tool_name,
            SubagentMcpToolScopeV2::Mutating(scope) => &scope.tool_name,
        }
    }
    pub fn schema_hash(&self) -> &str {
        match self {
            SubagentMcpToolScopeV2::Read(scope) => &scope.schema_hash,
            SubagentMcpToolScopeV2::Mutating(scope) => &scope.schema_hash,
        }
    }
    pub fn effect(&self) -> SubagentMcpEffectV2 {
        match self {
            SubagentMcpToolScopeV2::Read(_) => SubagentMcpEffectV2::Read,
            SubagentMcpToolScopeV2::Mutating(_) => SubagentMcpEffectV2::Mutating,
        }
    }
}

impl Serialize for SubagentMcpToolScopeV2 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            SubagentMcpToolScopeV2::Read(scope) => scope.serialize(serializer),
            SubagentMcpToolScopeV2::Mutating(scope) => scope.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for SubagentMcpToolScopeV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_subagent_mcp_tool_scope_v2(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMcpScopeV2 {
    pub server_id: String,
    pub connection_fingerprint: String,
    pub tools: Vec<SubagentMcpToolScopeV2>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentCapabilitySetV2 {
    pub workspace_read: bool,
    pub workspace_write: bool,
    pub shell: bool,
    pub web: bool,
    pub delegation: bool,
    pub mcp: Vec<SubagentMcpScopeV2>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentBudgetV2 {
    pub deadline_ms: u64,
    pub max_turns: u64,
    pub max_tool_calls: u64,
    pub max_output_chars: u64,
    pub max_tokens: u64,
    pub max_launches: u64,
    pub max_depth: u64,
    pub max_active: u64,
    pub max_queued: u64,
    pub max_network_operations: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentLaunchRequestV2 {
    pub version: u8,
    pub execution: SubagentExecutionModeV2,
    pub context: SubagentContextModeV2,
    pub capabilities: SubagentCapabilitySetV2,
    pub limits: SubagentBudgetV2,
    pub tasks: Vec<SubagentTaskRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRolloutPolicyV2 {
    pub background: bool,
    pub fork: bool,
    pub workspace_write: bool,
    pub shell: bool,
    pub web: bool,
    pub mcp: bool,
    pub delegation: bool,
}

/// Immutable resolved authority. Field order is load-bearing: the digest below
/// hashes the canonical JSON and must stay byte-identical with the TS writer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentAuthorityV2 {
    pub version: u8,
    pub grant_id: String,
    pub tree_root_id: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    pub depth: u8,
    pub authority_revision: u64,
    pub generation_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub workspace_revision: String,
    pub owner_document_id: String,
    pub provider_fingerprint: String,
    pub model_fingerprint: String,
    pub context_revision: String,
    pub execution: SubagentExecutionModeV2,
    pub context: SubagentContextModeV2,
    pub thinking_level: String,
    pub capabilities: SubagentCapabilitySetV2,
    pub budgets: SubagentBudgetV2,
    pub expires_at: u64,
}

impl SubagentAuthorityV2 {
    pub fn digest(&self) -> String {
        subagent_authority_digest_v2(self)
    }
}

#[derive(Debug, Clone)]
pub struct ResolveSubagentCapabilitiesV2Input {
    pub requested: SubagentCapabilitySetV2,
    pub root: SubagentCapabilitySetV2,
    pub parent: SubagentCapabilitySetV2,
    pub role: SubagentCapabilitySetV2,
    pub rollout: SubagentRolloutPolicyV2,
    pub user_grant: SubagentCapabilitySetV2,
    pub workspace_permission: String,
    pub workspace_egress_approval: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSubagentAuthorityV2Input {
    pub grant_id: String,
    pub tree_root_id: String,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub depth: u8,
    pub authority_revision: u64,
    pub generation_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub workspace_revision: String,
    pub owner_document_id: String,
    pub provider_fingerprint: String,
    pub model_fingerprint: String,
    pub context_revision: String,
    pub execution: SubagentExecutionModeV2,
    pub context: SubagentContextModeV2,
    pub thinking_level: String,
    pub capabilities: SubagentCapabilitySetV2,
    pub budgets: SubagentBudgetV2,
    pub expires_at: u64,
}

// ===========================================================================
// Validation primitives
// ===========================================================================

const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn is_exact_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn has_exact_keys(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && object.keys().all(|key| keys.contains(&key.as_str()))
}

fn bounded_positive_integer(value: &Value, maximum: u64, field: &str) -> Result<u64, String> {
    let Some(value) = value.as_u64() else {
        return Err(format!("Invalid subagent {field}."));
    };
    if value < 1 || value > maximum {
        return Err(format!("Invalid subagent {field}."));
    }
    Ok(value)
}

fn scoped_identity(value: &Value, field: &str) -> Result<String, String> {
    let Some(value) = value.as_str() else {
        return Err(format!("Invalid subagent {field}."));
    };
    if !crate::safe_text::is_safe_subagent_identifier_str(value) {
        return Err(format!("Invalid subagent {field}."));
    }
    Ok(value.to_string())
}

/// `sha256("aiden-subagent-authority-v2\0" + JSON.stringify(authority))`.
pub fn subagent_authority_digest_v2(authority: &SubagentAuthorityV2) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-subagent-authority-v2\0");
    let serialized = serde_json::to_string(authority).expect("authority is always serializable");
    hasher.update(serialized.as_bytes());
    hex(&hasher.finalize())
}

/// `sha256("aiden-subagent-mcp-effect-profile-v2\0" + JSON of the five profile
/// fields in insertion order)`.
pub fn subagent_mcp_effect_profile_fingerprint_v2(
    classification: SubagentMcpMutationClassificationV2,
    destructive: SubagentMcpDestructiveProfileV2,
    idempotency: SubagentMcpIdempotencyProfileV2,
    open_world: SubagentMcpOpenWorldProfileV2,
    task_support: SubagentMcpTaskSupportV2,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-subagent-mcp-effect-profile-v2\0");
    let canonical = serde_json::json!({
        "classification": classification,
        "destructive": destructive,
        "idempotency": idempotency,
        "openWorld": open_world,
        "taskSupport": task_support,
    });
    hasher.update(
        serde_json::to_string(&canonical)
            .expect("json is serializable")
            .as_bytes(),
    );
    hex(&hasher.finalize())
}

pub fn parse_subagent_mcp_mutation_effect_profile_v2(
    value: &Value,
) -> Result<SubagentMcpMutationEffectProfileV2, String> {
    if !is_record(value) {
        return Err("Invalid subagent MCP mutation effect profile.".to_string());
    }
    let object = value.as_object().expect("checked");
    if !has_exact_keys(
        object,
        &[
            "classification",
            "destructive",
            "idempotency",
            "openWorld",
            "taskSupport",
            "fingerprint",
        ],
    ) {
        return Err("Invalid subagent MCP mutation effect profile fields.".to_string());
    }
    let classification = match object.get("classification").and_then(Value::as_str) {
        Some("declared_mutating") => SubagentMcpMutationClassificationV2::DeclaredMutating,
        Some("unproven_mutating") => SubagentMcpMutationClassificationV2::UnprovenMutating,
        _ => return Err("Invalid or stale subagent MCP mutation effect profile.".to_string()),
    };
    let destructive = match object.get("destructive").and_then(Value::as_str) {
        Some("destructive") => SubagentMcpDestructiveProfileV2::Destructive,
        Some("additive") => SubagentMcpDestructiveProfileV2::Additive,
        Some("unknown") => SubagentMcpDestructiveProfileV2::Unknown,
        _ => return Err("Invalid or stale subagent MCP mutation effect profile.".to_string()),
    };
    let idempotency = match object.get("idempotency").and_then(Value::as_str) {
        Some("idempotent") => SubagentMcpIdempotencyProfileV2::Idempotent,
        Some("not_declared") => SubagentMcpIdempotencyProfileV2::NotDeclared,
        _ => return Err("Invalid or stale subagent MCP mutation effect profile.".to_string()),
    };
    let open_world = match object.get("openWorld").and_then(Value::as_str) {
        Some("open") => SubagentMcpOpenWorldProfileV2::Open,
        Some("closed") => SubagentMcpOpenWorldProfileV2::Closed,
        Some("unknown") => SubagentMcpOpenWorldProfileV2::Unknown,
        _ => return Err("Invalid or stale subagent MCP mutation effect profile.".to_string()),
    };
    let task_support = match object.get("taskSupport").and_then(Value::as_str) {
        Some("forbidden") => SubagentMcpTaskSupportV2::Forbidden,
        Some("optional") => SubagentMcpTaskSupportV2::Optional,
        _ => return Err("Invalid or stale subagent MCP mutation effect profile.".to_string()),
    };
    let fingerprint = object.get("fingerprint").and_then(Value::as_str);
    if fingerprint
        != Some(
            subagent_mcp_effect_profile_fingerprint_v2(
                classification,
                destructive,
                idempotency,
                open_world,
                task_support,
            )
            .as_str(),
        )
    {
        return Err("Invalid or stale subagent MCP mutation effect profile.".to_string());
    }
    Ok(SubagentMcpMutationEffectProfileV2 {
        classification,
        destructive,
        idempotency,
        open_world,
        task_support,
        fingerprint: fingerprint.expect("checked").to_string(),
    })
}

fn parse_mcp_scopes(value: &Value) -> Result<Vec<SubagentMcpScopeV2>, String> {
    let Some(values) = value.as_array() else {
        return Err("Invalid subagent MCP scope.".to_string());
    };
    if values.len() > MAX_SUBAGENT_MCP_SCOPES {
        return Err("Invalid subagent MCP scope.".to_string());
    }
    let mut servers: Vec<String> = Vec::new();
    let mut scopes = Vec::with_capacity(values.len());
    for entry in values {
        let Some(object) = entry.as_object() else {
            return Err("Invalid subagent MCP scope fields.".to_string());
        };
        if !has_exact_keys(object, &["serverId", "connectionFingerprint", "tools"]) {
            return Err("Invalid subagent MCP scope fields.".to_string());
        }
        let server_id =
            scoped_identity(object.get("serverId").expect("key"), "MCP server identity")?;
        if servers.contains(&server_id) {
            return Err("Duplicate subagent MCP server scope.".to_string());
        }
        servers.push(server_id.clone());
        let connection_fingerprint = object
            .get("connectionFingerprint")
            .and_then(Value::as_str)
            .filter(|value| is_exact_fingerprint(value))
            .ok_or_else(|| "Invalid subagent MCP tool scope.".to_string())?;
        let tools_value = object.get("tools").expect("key");
        let Some(tool_values) = tools_value.as_array() else {
            return Err("Invalid subagent MCP tool scope.".to_string());
        };
        if tool_values.is_empty() || tool_values.len() > MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE {
            return Err("Invalid subagent MCP tool scope.".to_string());
        }
        let tools: Vec<SubagentMcpToolScopeV2> = tool_values
            .iter()
            .map(parse_subagent_mcp_tool_scope_v2)
            .collect::<Result<_, _>>()?;
        let mut names = Vec::with_capacity(tools.len());
        for tool in &tools {
            if names.contains(&tool.tool_name().to_string()) {
                return Err("Duplicate subagent MCP tool scope.".to_string());
            }
            names.push(tool.tool_name().to_string());
        }
        scopes.push(SubagentMcpScopeV2 {
            server_id,
            connection_fingerprint: connection_fingerprint.to_string(),
            tools,
        });
    }
    Ok(scopes)
}

pub fn parse_subagent_mcp_tool_scope_v2(value: &Value) -> Result<SubagentMcpToolScopeV2, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent MCP tool binding.".to_string());
    };
    let tool_name = scoped_identity(object.get("toolName").expect("key"), "MCP tool identity")?;
    let schema_hash = object
        .get("schemaHash")
        .and_then(Value::as_str)
        .filter(|value| is_exact_fingerprint(value))
        .ok_or_else(|| "Invalid subagent MCP tool binding.".to_string())?
        .to_string();
    let effect = match object.get("effect").and_then(Value::as_str) {
        Some("read") => SubagentMcpEffectV2::Read,
        Some("mutating") => SubagentMcpEffectV2::Mutating,
        _ => return Err("Invalid subagent MCP tool binding.".to_string()),
    };
    match effect {
        SubagentMcpEffectV2::Read => {
            if !has_exact_keys(object, &["toolName", "schemaHash", "effect"]) {
                return Err("Invalid subagent MCP tool binding fields.".to_string());
            }
            Ok(SubagentMcpToolScopeV2::Read(SubagentMcpReadToolScopeV2 {
                tool_name,
                schema_hash,
                effect,
            }))
        }
        SubagentMcpEffectV2::Mutating => {
            if !has_exact_keys(
                object,
                &["toolName", "schemaHash", "effect", "effectProfile"],
            ) {
                return Err("Invalid subagent MCP tool binding fields.".to_string());
            }
            let effect_profile = parse_subagent_mcp_mutation_effect_profile_v2(
                object.get("effectProfile").expect("key"),
            )?;
            Ok(SubagentMcpToolScopeV2::Mutating(
                SubagentMcpMutationToolScopeV2 {
                    tool_name,
                    schema_hash,
                    effect,
                    effect_profile,
                },
            ))
        }
    }
}

pub fn parse_subagent_capability_set_v2(value: &Value) -> Result<SubagentCapabilitySetV2, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent V2 capability fields.".to_string());
    };
    let keys = [
        "workspaceRead",
        "workspaceWrite",
        "shell",
        "web",
        "delegation",
        "mcp",
    ];
    if !has_exact_keys(object, &keys) {
        return Err("Invalid subagent V2 capability fields.".to_string());
    }
    for key in &keys[..keys.len() - 1] {
        if object.get(*key).and_then(Value::as_bool).is_none() {
            return Err("Invalid subagent V2 capability value.".to_string());
        }
    }
    Ok(SubagentCapabilitySetV2 {
        workspace_read: object
            .get("workspaceRead")
            .expect("key")
            .as_bool()
            .expect("checked"),
        workspace_write: object
            .get("workspaceWrite")
            .expect("key")
            .as_bool()
            .expect("checked"),
        shell: object
            .get("shell")
            .expect("key")
            .as_bool()
            .expect("checked"),
        web: object.get("web").expect("key").as_bool().expect("checked"),
        delegation: object
            .get("delegation")
            .expect("key")
            .as_bool()
            .expect("checked"),
        mcp: parse_mcp_scopes(object.get("mcp").expect("key"))?,
    })
}

pub fn parse_subagent_budget_v2(value: &Value) -> Result<SubagentBudgetV2, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent V2 budget fields.".to_string());
    };
    let keys = [
        "deadlineMs",
        "maxTurns",
        "maxToolCalls",
        "maxOutputChars",
        "maxTokens",
        "maxLaunches",
        "maxDepth",
        "maxActive",
        "maxQueued",
        "maxNetworkOperations",
    ];
    if !has_exact_keys(object, &keys) {
        return Err("Invalid subagent V2 budget fields.".to_string());
    }
    let field = |key: &str, maximum: u64, name: &str| -> Result<u64, String> {
        bounded_positive_integer(object.get(key).expect("key"), maximum, name)
    };
    Ok(SubagentBudgetV2 {
        deadline_ms: field("deadlineMs", 24 * 60 * 60_000, "deadline budget")?,
        max_turns: field("maxTurns", 128, "turn budget")?,
        max_tool_calls: field("maxToolCalls", 512, "tool-call budget")?,
        max_output_chars: field("maxOutputChars", 1_000_000, "output budget")?,
        max_tokens: field("maxTokens", 10_000_000, "token budget")?,
        max_launches: field("maxLaunches", 64, "launch budget")?,
        max_depth: field("maxDepth", MAX_SUBAGENT_TREE_DEPTH as u64, "depth budget")?,
        max_active: field("maxActive", 32, "active-child budget")?,
        max_queued: field("maxQueued", 32, "queued-child budget")?,
        max_network_operations: field("maxNetworkOperations", 512, "network-operation budget")?,
    })
}

pub fn parse_subagent_launch_request_v2(value: &Value) -> Result<SubagentLaunchRequestV2, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent V2 launch request.".to_string());
    };
    if !has_exact_keys(
        object,
        &[
            "version",
            "execution",
            "context",
            "capabilities",
            "limits",
            "tasks",
        ],
    ) || object.get("version").and_then(Value::as_u64) != Some(2)
    {
        return Err("Invalid subagent V2 launch request.".to_string());
    }
    let execution = object
        .get("execution")
        .and_then(Value::as_str)
        .and_then(SubagentExecutionModeV2::from_str)
        .ok_or_else(|| "Invalid subagent V2 launch request.".to_string())?;
    let context = object
        .get("context")
        .and_then(Value::as_str)
        .and_then(SubagentContextModeV2::from_str)
        .ok_or_else(|| "Invalid subagent V2 launch request.".to_string())?;
    let capabilities = parse_subagent_capability_set_v2(object.get("capabilities").expect("key"))?;
    let limits = parse_subagent_budget_v2(object.get("limits").expect("key"))?;
    let tasks = parse_subagent_tool_request(&Value::Object({
        let mut map = Map::new();
        map.insert(
            "tasks".to_string(),
            object.get("tasks").expect("key").clone(),
        );
        map
    }))?
    .tasks;
    Ok(SubagentLaunchRequestV2 {
        version: SUBAGENT_AUTHORITY_VERSION,
        execution,
        context,
        capabilities,
        limits,
        tasks,
    })
}

// ===========================================================================
// Intersection math
// ===========================================================================

/// Exact identity tuple for one MCP tool across every ceiling.
fn mcp_pairs(scopes: &[SubagentMcpScopeV2]) -> Vec<String> {
    let mut pairs = Vec::new();
    for scope in scopes {
        for tool in &scope.tools {
            let fingerprint = match tool {
                SubagentMcpToolScopeV2::Read(_) => "read".to_string(),
                SubagentMcpToolScopeV2::Mutating(scope) => scope.effect_profile.fingerprint.clone(),
            };
            pairs.push(format!(
                "{}\0{}\0{}\0{}\0{}\0{}",
                scope.server_id,
                scope.connection_fingerprint,
                tool.tool_name(),
                tool.schema_hash(),
                tool.effect().as_str(),
                fingerprint,
            ));
        }
    }
    pairs
}

fn intersect_mcp(scopes: &[&[SubagentMcpScopeV2]]) -> Vec<SubagentMcpScopeV2> {
    if scopes.is_empty() {
        return Vec::new();
    }
    let mut remaining: Vec<String> = mcp_pairs(scopes[0]);
    for scope in &scopes[1..] {
        let allowed = mcp_pairs(scope);
        remaining.retain(|pair| allowed.iter().any(|candidate| candidate == pair));
    }
    remaining.sort();
    let mut grouped: BTreeMap<String, Vec<SubagentMcpToolScopeV2>> = BTreeMap::new();
    for pair in &remaining {
        let fields: Vec<&str> = pair.split('\0').collect();
        if fields.len() != 6 || fields[..5].iter().any(|field| field.is_empty()) {
            continue;
        }
        let server_id = fields[0];
        let connection_fingerprint = fields[1];
        let tool_name = fields[2];
        let schema_hash = fields[3];
        let effect = fields[4];
        let profile_fingerprint = fields[5];
        let group_key = format!("{server_id}\0{connection_fingerprint}");
        let source_scope = scopes[0].iter().find(|scope| {
            scope.server_id == server_id && scope.connection_fingerprint == connection_fingerprint
        });
        let source_tool = source_scope.and_then(|scope| {
            scope.tools.iter().find(|tool| {
                tool.tool_name() == tool_name
                    && tool.schema_hash() == schema_hash
                    && tool.effect().as_str() == effect
                    && match tool {
                        SubagentMcpToolScopeV2::Read(_) => profile_fingerprint == "read",
                        SubagentMcpToolScopeV2::Mutating(scope) => {
                            scope.effect_profile.fingerprint == profile_fingerprint
                        }
                    }
            })
        });
        if let Some(tool) = source_tool {
            grouped.entry(group_key).or_default().push(tool.clone());
        }
    }
    grouped
        .into_iter()
        .map(|(key, tools)| {
            let fields: Vec<&str> = key.split('\0').collect();
            SubagentMcpScopeV2 {
                server_id: fields[0].to_string(),
                connection_fingerprint: fields[1].to_string(),
                tools,
            }
        })
        .collect()
}

/// The six-ceiling positive intersection. `workspace_permission` is one of
/// `"full" | "ask" | "none"`; `workspace_egress_approval` is
/// `"unavailable" | "per_call"`.
pub fn resolve_subagent_capabilities_v2(
    input: &ResolveSubagentCapabilitiesV2Input,
) -> Result<SubagentCapabilitySetV2, String> {
    let sources = [
        &input.requested,
        &input.root,
        &input.parent,
        &input.role,
        &input.user_grant,
    ];
    let workspace_allowed = input.workspace_permission != "none";
    let all =
        |field: fn(&SubagentCapabilitySetV2) -> bool| sources.iter().all(|source| field(source));
    let mcp_sources: Vec<&[SubagentMcpScopeV2]> =
        sources.iter().map(|source| source.mcp.as_slice()).collect();
    let capabilities = SubagentCapabilitySetV2 {
        workspace_read: workspace_allowed && all(|source| source.workspace_read),
        workspace_write: workspace_allowed
            && input.workspace_egress_approval == "per_call"
            && input.rollout.workspace_write
            && all(|source| source.workspace_write),
        shell: workspace_allowed && input.rollout.shell && all(|source| source.shell),
        web: input.rollout.web && all(|source| source.web),
        delegation: input.rollout.delegation && all(|source| source.delegation),
        mcp: if input.rollout.mcp {
            intersect_mcp(&mcp_sources)
        } else {
            Vec::new()
        },
    };
    if capabilities.workspace_read
        && (capabilities.web || !capabilities.mcp.is_empty())
        && input.workspace_egress_approval != "per_call"
    {
        return Err(
            "Workspace read plus network egress requires an explicit combined grant.".to_string(),
        );
    }
    Ok(capabilities)
}

pub fn intersect_subagent_budgets_v2(
    budgets: &[&SubagentBudgetV2],
) -> Result<SubagentBudgetV2, String> {
    if budgets.is_empty() {
        return Err("Subagent budget intersection requires a ceiling.".to_string());
    }
    let min = |field: fn(&SubagentBudgetV2) -> u64| {
        budgets
            .iter()
            .map(|budget| field(budget))
            .min()
            .expect("nonempty")
    };
    Ok(SubagentBudgetV2 {
        deadline_ms: min(|budget| budget.deadline_ms),
        max_turns: min(|budget| budget.max_turns),
        max_tool_calls: min(|budget| budget.max_tool_calls),
        max_output_chars: min(|budget| budget.max_output_chars),
        max_tokens: min(|budget| budget.max_tokens),
        max_launches: min(|budget| budget.max_launches),
        max_depth: min(|budget| budget.max_depth),
        max_active: min(|budget| budget.max_active),
        max_queued: min(|budget| budget.max_queued),
        max_network_operations: min(|budget| budget.max_network_operations),
    })
}

fn bounded_private_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains('\0')
}

pub fn create_subagent_authority_v2(
    input: &CreateSubagentAuthorityV2Input,
) -> Result<SubagentAuthorityV2, String> {
    let identifiers = [
        Some(&input.grant_id),
        Some(&input.tree_root_id),
        Some(&input.run_id),
        input.parent_run_id.as_ref(),
        Some(&input.generation_id),
        Some(&input.chat_id),
        Some(&input.workspace_id),
    ];
    for identifier in identifiers.into_iter().flatten() {
        if !crate::safe_text::is_safe_subagent_identifier_str(identifier) {
            return Err("Invalid subagent V2 authority identity.".to_string());
        }
    }
    if input.depth < 1
        || input.depth > MAX_SUBAGENT_TREE_DEPTH
        || input.authority_revision < 1
        || input.expires_at == 0
        || !THINKING_LEVELS.contains(&input.thinking_level.as_str())
        || !bounded_private_identity(&input.owner_document_id)
        || !bounded_private_identity(&input.workspace_revision)
        || !bounded_private_identity(&input.provider_fingerprint)
        || !bounded_private_identity(&input.model_fingerprint)
        || !bounded_private_identity(&input.context_revision)
    {
        return Err("Invalid subagent V2 authority fields.".to_string());
    }
    if input.depth == 1 && input.parent_run_id.is_some() {
        return Err("A direct subagent cannot name a parent run.".to_string());
    }
    if input.depth > 1 && input.parent_run_id.is_none() {
        return Err("A nested subagent requires a parent run.".to_string());
    }
    if input.parent_run_id.as_deref() == Some(input.run_id.as_str()) {
        return Err("A subagent run cannot be its own parent.".to_string());
    }
    // Re-parse the capability set and budget exactly so every stored authority
    // revalidates its own contents (TS `parseSubagentCapabilitySetV2`).
    let capabilities_value = serde_json::to_value(&input.capabilities)
        .map_err(|_| "Invalid subagent V2 authority fields.".to_string())?;
    let capabilities = parse_subagent_capability_set_v2(&capabilities_value)
        .map_err(|_| "Invalid subagent V2 authority fields.".to_string())?;
    let budgets_value = serde_json::to_value(&input.budgets)
        .map_err(|_| "Invalid subagent V2 authority fields.".to_string())?;
    let budgets = parse_subagent_budget_v2(&budgets_value)
        .map_err(|_| "Invalid subagent V2 authority fields.".to_string())?;
    if input.depth as u64 > budgets.max_depth {
        return Err("Subagent depth exceeds its authority budget.".to_string());
    }
    Ok(SubagentAuthorityV2 {
        version: SUBAGENT_AUTHORITY_VERSION,
        grant_id: input.grant_id.clone(),
        tree_root_id: input.tree_root_id.clone(),
        run_id: input.run_id.clone(),
        parent_run_id: input.parent_run_id.clone(),
        depth: input.depth,
        authority_revision: input.authority_revision,
        generation_id: input.generation_id.clone(),
        chat_id: input.chat_id.clone(),
        workspace_id: input.workspace_id.clone(),
        workspace_revision: input.workspace_revision.clone(),
        owner_document_id: input.owner_document_id.clone(),
        provider_fingerprint: input.provider_fingerprint.clone(),
        model_fingerprint: input.model_fingerprint.clone(),
        context_revision: input.context_revision.clone(),
        execution: input.execution,
        context: input.context,
        thinking_level: input.thinking_level.clone(),
        capabilities,
        budgets,
        expires_at: input.expires_at,
    })
}

pub fn assert_subagent_launch_rollout_v2(
    execution: SubagentExecutionModeV2,
    context: SubagentContextModeV2,
    rollout: &SubagentRolloutPolicyV2,
) -> Result<(), String> {
    if execution == SubagentExecutionModeV2::Background && !rollout.background {
        return Err("Background subagents are not enabled.".to_string());
    }
    if context == SubagentContextModeV2::Fork && !rollout.fork {
        return Err("Forked subagent context is not enabled.".to_string());
    }
    Ok(())
}

pub fn subagent_capabilities_are_subset_v2(
    child: &SubagentCapabilitySetV2,
    parent: &SubagentCapabilitySetV2,
) -> bool {
    if (child.workspace_read && !parent.workspace_read)
        || (child.workspace_write && !parent.workspace_write)
        || (child.shell && !parent.shell)
        || (child.web && !parent.web)
        || (child.delegation && !parent.delegation)
    {
        return false;
    }
    let parent_pairs = mcp_pairs(&parent.mcp);
    mcp_pairs(&child.mcp)
        .iter()
        .all(|pair| parent_pairs.iter().any(|candidate| candidate == pair))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut out, "{byte:02x}").expect("write to string");
    }
    out
}

/// Recompute the effect profile fingerprint exactly (public helper used by
/// tests and the mutation-approval surface).
pub fn effect_profile_fingerprint_for(profile: &SubagentMcpMutationEffectProfileV2) -> String {
    subagent_mcp_effect_profile_fingerprint_v2(
        profile.classification,
        profile.destructive,
        profile.idempotency,
        profile.open_world,
        profile.task_support,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inspect() -> SubagentCapabilitySetV2 {
        serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": false,
            "shell": false,
            "web": false,
            "delegation": false,
            "mcp": [],
        }))
        .unwrap()
    }

    fn profile(
        classification: &str,
        destructive: &str,
        idempotency: &str,
        open_world: &str,
        task_support: &str,
    ) -> Value {
        let value = json!({
            "classification": classification,
            "destructive": destructive,
            "idempotency": idempotency,
            "openWorld": open_world,
            "taskSupport": task_support,
        });
        let classification = match classification {
            "declared_mutating" => SubagentMcpMutationClassificationV2::DeclaredMutating,
            _ => SubagentMcpMutationClassificationV2::UnprovenMutating,
        };
        let destructive = match destructive {
            "destructive" => SubagentMcpDestructiveProfileV2::Destructive,
            "additive" => SubagentMcpDestructiveProfileV2::Additive,
            _ => SubagentMcpDestructiveProfileV2::Unknown,
        };
        let idempotency = match idempotency {
            "idempotent" => SubagentMcpIdempotencyProfileV2::Idempotent,
            _ => SubagentMcpIdempotencyProfileV2::NotDeclared,
        };
        let open_world = match open_world {
            "open" => SubagentMcpOpenWorldProfileV2::Open,
            "closed" => SubagentMcpOpenWorldProfileV2::Closed,
            _ => SubagentMcpOpenWorldProfileV2::Unknown,
        };
        let task_support = match task_support {
            "forbidden" => SubagentMcpTaskSupportV2::Forbidden,
            _ => SubagentMcpTaskSupportV2::Optional,
        };
        let fingerprint = subagent_mcp_effect_profile_fingerprint_v2(
            classification,
            destructive,
            idempotency,
            open_world,
            task_support,
        );
        let mut object = value.as_object().expect("object").clone();
        object.insert("fingerprint".to_string(), json!(fingerprint));
        Value::Object(object)
    }

    fn mcp_scope(server_id: &str, connection: &str, tool_names: &[(&str, &str)]) -> Value {
        // tool_names: (name, schema_letter)
        let tools: Vec<Value> = tool_names
            .iter()
            .map(|(name, schema)| {
                if name.starts_with("get_") {
                    json!({ "toolName": name, "schemaHash": schema.repeat(64), "effect": "read" })
                } else {
                    json!({
                        "toolName": name,
                        "schemaHash": schema.repeat(64),
                        "effect": "mutating",
                        "effectProfile": profile("declared_mutating", "unknown", "not_declared", "unknown", "forbidden"),
                    })
                }
            })
            .collect();
        json!({
            "serverId": server_id,
            "connectionFingerprint": connection.repeat(64),
            "tools": tools,
        })
    }

    fn budget() -> SubagentBudgetV2 {
        serde_json::from_value(json!({
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
        }))
        .unwrap()
    }

    fn request() -> Value {
        json!({
            "version": 2,
            "execution": "foreground",
            "context": "fresh",
            "capabilities": inspect(),
            "limits": budget(),
            "tasks": [{"role": "reviewer", "label": "Review", "task": "Review the authority boundary."}],
        })
    }

    fn authority_input() -> Value {
        json!({
            "grantId": "grant-1",
            "treeRootId": "tree-1",
            "runId": "run-1",
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
            "execution": "foreground",
            "context": "fresh",
            "thinkingLevel": "high",
            "capabilities": inspect(),
            "budgets": budget(),
            "expiresAt": 10_000,
        })
    }

    fn rollout() -> SubagentRolloutPolicyV2 {
        SubagentRolloutPolicyV2 {
            background: false,
            fork: false,
            workspace_write: false,
            shell: false,
            web: false,
            mcp: false,
            delegation: false,
        }
    }

    #[test]
    fn launch_parsing_is_exact_bounded_and_revalidates_tasks() {
        let parsed = parse_subagent_launch_request_v2(&request()).unwrap();
        assert_eq!(parsed.version, 2);
        assert_eq!(parsed.execution, SubagentExecutionModeV2::Foreground);
        assert_eq!(parsed.context, SubagentContextModeV2::Fresh);
        assert_eq!(parsed.tasks.len(), 1);
        // extra key rejected
        let mut extra = request();
        extra
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), json!(true));
        assert!(parse_subagent_launch_request_v2(&extra).is_err());
        // non-boolean capability rejected
        let mut bad_cap = request();
        bad_cap["capabilities"]["shell"] = json!("yes");
        assert!(parse_subagent_launch_request_v2(&bad_cap).is_err());
        // unknown role rejected
        let mut bad_role = request();
        bad_role["tasks"] = json!([{"role": "worker", "label": "Escalate", "task": "Gain tools."}]);
        assert!(parse_subagent_launch_request_v2(&bad_role).is_err());
        // over-depth budget rejected
        let mut over = request();
        over["limits"]["maxDepth"] = json!(3);
        assert!(parse_subagent_launch_request_v2(&over).is_err());
    }

    #[test]
    fn capability_resolution_is_a_monotonic_positive_intersection() {
        let everything: SubagentCapabilitySetV2 = serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": true,
            "shell": true,
            "web": true,
            "delegation": true,
            "mcp": [mcp_scope("linear", "a", &[("get_issue", "c"), ("update_issue", "d")])],
        }))
        .unwrap();
        let effective = resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
            requested: everything.clone(),
            root: everything.clone(),
            parent: everything.clone(),
            role: inspect(),
            rollout: rollout(),
            user_grant: everything.clone(),
            workspace_permission: "full".to_string(),
            workspace_egress_approval: "unavailable".to_string(),
        })
        .unwrap();
        assert_eq!(effective, inspect());
        assert!(subagent_capabilities_are_subset_v2(&effective, &everything));
        assert!(!subagent_capabilities_are_subset_v2(
            &everything,
            &effective
        ));

        // permission none zeroes every capability
        let denied = resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
            requested: everything.clone(),
            root: everything.clone(),
            parent: everything.clone(),
            role: everything.clone(),
            rollout: SubagentRolloutPolicyV2 {
                workspace_write: true,
                shell: true,
                ..rollout()
            },
            user_grant: everything.clone(),
            workspace_permission: "none".to_string(),
            workspace_egress_approval: "unavailable".to_string(),
        })
        .unwrap();
        assert!(!denied.workspace_read && !denied.workspace_write && !denied.shell);
        assert!(!denied.web && !denied.delegation && denied.mcp.is_empty());
    }

    #[test]
    fn budget_intersection_never_exceeds_any_ceiling() {
        let low = budget();
        let mut narrowed = budget();
        narrowed.max_turns = 10;
        narrowed.max_depth = 1;
        let intersected = intersect_subagent_budgets_v2(&[&low, &narrowed]).unwrap();
        assert_eq!(intersected.max_turns, 10);
        assert_eq!(intersected.max_depth, 1);
        assert_eq!(intersected.max_tool_calls, 64);
        assert!(intersect_subagent_budgets_v2(&[]).is_err());
    }

    #[test]
    fn mcp_scopes_intersect_by_server_and_tool_identity() {
        let everything: SubagentCapabilitySetV2 = serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": true,
            "shell": true,
            "web": true,
            "delegation": true,
            "mcp": [mcp_scope("linear", "a", &[("get_issue", "c"), ("update_issue", "d")])],
        }))
        .unwrap();
        let narrow_grant: SubagentCapabilitySetV2 = serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": true,
            "shell": true,
            "web": true,
            "delegation": true,
            "mcp": [mcp_scope("linear", "a", &[("get_issue", "c")])],
        }))
        .unwrap();
        let effective = resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
            requested: everything.clone(),
            root: everything.clone(),
            parent: everything.clone(),
            role: everything.clone(),
            rollout: SubagentRolloutPolicyV2 {
                mcp: true,
                ..rollout()
            },
            user_grant: narrow_grant,
            workspace_permission: "full".to_string(),
            workspace_egress_approval: "per_call".to_string(),
        })
        .unwrap();
        assert_eq!(effective.mcp.len(), 1);
        assert_eq!(effective.mcp[0].tools.len(), 1);
        assert_eq!(effective.mcp[0].tools[0].tool_name(), "get_issue");

        // drifted connection fingerprint yields no intersection
        let drifted: SubagentCapabilitySetV2 = serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": true,
            "shell": true,
            "web": true,
            "delegation": true,
            "mcp": [mcp_scope("linear", "9", &[("get_issue", "c")])],
        }))
        .unwrap();
        let effective = resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
            requested: everything.clone(),
            root: everything.clone(),
            parent: everything.clone(),
            role: everything.clone(),
            rollout: SubagentRolloutPolicyV2 {
                mcp: true,
                ..rollout()
            },
            user_grant: drifted,
            workspace_permission: "full".to_string(),
            workspace_egress_approval: "per_call".to_string(),
        })
        .unwrap();
        assert!(effective.mcp.is_empty());
    }

    #[test]
    fn mutating_mcp_binds_every_profile_field_and_recomputed_fingerprint() {
        let mutating = mcp_scope("linear", "a", &[("update_issue", "d")]);
        // stale fingerprint is rejected
        let mut stale = mutating.clone();
        stale["tools"][0]["effectProfile"]["fingerprint"] = json!("0".repeat(64));
        assert!(parse_subagent_mcp_tool_scope_v2(&stale["tools"][0]).is_err());
        // a freshly recomputed drifted profile parses but no longer intersects
        let parsed = parse_subagent_mcp_tool_scope_v2(&mutating["tools"][0]).unwrap();
        assert_eq!(parsed.effect(), SubagentMcpEffectV2::Mutating);
        let everything: SubagentCapabilitySetV2 = serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": true,
            "shell": true,
            "web": true,
            "delegation": true,
            "mcp": [mutating.clone()],
        }))
        .unwrap();
        let drifted_profile = profile(
            "declared_mutating",
            "destructive",
            "not_declared",
            "unknown",
            "forbidden",
        );
        let drifted: SubagentCapabilitySetV2 = serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": true,
            "shell": true,
            "web": true,
            "delegation": true,
            "mcp": [{
                "serverId": "linear",
                "connectionFingerprint": "a".repeat(64),
                "tools": [{
                    "toolName": "update_issue",
                    "schemaHash": "d".repeat(64),
                    "effect": "mutating",
                    "effectProfile": drifted_profile,
                }],
            }],
        }))
        .unwrap();
        let effective = resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
            requested: everything.clone(),
            root: everything.clone(),
            parent: everything.clone(),
            role: everything.clone(),
            rollout: SubagentRolloutPolicyV2 {
                mcp: true,
                ..rollout()
            },
            user_grant: drifted,
            workspace_permission: "full".to_string(),
            workspace_egress_approval: "per_call".to_string(),
        })
        .unwrap();
        assert!(effective.mcp.is_empty());
    }

    #[test]
    fn workspace_read_plus_outbound_requires_combined_grant() {
        let everything: SubagentCapabilitySetV2 = serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": true,
            "shell": true,
            "web": true,
            "delegation": true,
            "mcp": [mcp_scope("linear", "a", &[("get_issue", "c")])],
        }))
        .unwrap();
        assert!(
            resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
                requested: everything.clone(),
                root: everything.clone(),
                parent: everything.clone(),
                role: everything.clone(),
                rollout: SubagentRolloutPolicyV2 {
                    web: true,
                    ..rollout()
                },
                user_grant: everything.clone(),
                workspace_permission: "full".to_string(),
                workspace_egress_approval: "unavailable".to_string(),
            })
            .is_err()
        );
    }

    #[test]
    fn workspace_write_requires_rollout_and_per_call_approval() {
        let everything: SubagentCapabilitySetV2 = serde_json::from_value(json!({
            "workspaceRead": true,
            "workspaceWrite": true,
            "shell": true,
            "web": true,
            "delegation": true,
            "mcp": [],
        }))
        .unwrap();
        let without = resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
            requested: everything.clone(),
            root: everything.clone(),
            parent: everything.clone(),
            role: everything.clone(),
            rollout: SubagentRolloutPolicyV2 {
                workspace_write: true,
                ..rollout()
            },
            user_grant: everything.clone(),
            workspace_permission: "full".to_string(),
            workspace_egress_approval: "unavailable".to_string(),
        })
        .unwrap();
        assert!(!without.workspace_write);
        let approved = resolve_subagent_capabilities_v2(&ResolveSubagentCapabilitiesV2Input {
            requested: everything.clone(),
            root: everything.clone(),
            parent: everything.clone(),
            role: everything.clone(),
            rollout: SubagentRolloutPolicyV2 {
                workspace_write: true,
                ..rollout()
            },
            user_grant: everything.clone(),
            workspace_permission: "ask".to_string(),
            workspace_egress_approval: "per_call".to_string(),
        })
        .unwrap();
        assert!(approved.workspace_write);
        assert!(!approved.shell && !approved.delegation);
    }

    #[test]
    fn rollout_denies_background_and_fork_independently() {
        assert!(assert_subagent_launch_rollout_v2(
            SubagentExecutionModeV2::Foreground,
            SubagentContextModeV2::Fresh,
            &rollout(),
        )
        .is_ok());
        assert!(assert_subagent_launch_rollout_v2(
            SubagentExecutionModeV2::Background,
            SubagentContextModeV2::Fresh,
            &rollout(),
        )
        .is_err());
        assert!(assert_subagent_launch_rollout_v2(
            SubagentExecutionModeV2::Foreground,
            SubagentContextModeV2::Fork,
            &rollout(),
        )
        .is_err());
    }

    #[test]
    fn authority_creation_validates_identity_lineage_and_budgets() {
        let input_value = authority_input();
        let input: CreateSubagentAuthorityV2Input =
            serde_json::from_value(input_value.clone()).unwrap();
        let authority = create_subagent_authority_v2(&input).unwrap();
        assert_eq!(authority.digest().len(), 64);
        // depth 1 cannot name a parent
        let mut with_parent = input_value.clone();
        with_parent["parentRunId"] = json!("run-parent");
        assert!(
            create_subagent_authority_v2(&serde_json::from_value(with_parent).unwrap(),).is_err()
        );
        // depth 2 requires a parent
        let mut nested = input_value.clone();
        nested["depth"] = json!(2);
        assert!(create_subagent_authority_v2(&serde_json::from_value(nested).unwrap()).is_err());
        // cannot be its own parent
        let mut own_parent = input_value.clone();
        own_parent["depth"] = json!(2);
        own_parent["parentRunId"] = json!("run-1");
        assert!(
            create_subagent_authority_v2(&serde_json::from_value(own_parent).unwrap()).is_err()
        );
        // depth exceeding budget
        let mut deep = input_value.clone();
        deep["depth"] = json!(2);
        deep["parentRunId"] = json!("run-parent");
        deep["budgets"]["maxDepth"] = json!(1);
        assert!(create_subagent_authority_v2(&serde_json::from_value(deep).unwrap()).is_err());
    }

    #[test]
    fn authority_rejects_malformed_thinking_levels() {
        for thinking in ["ultra", "HIGH", "high-extra"] {
            let mut input = authority_input();
            input["thinkingLevel"] = json!(thinking);
            assert!(
                create_subagent_authority_v2(&serde_json::from_value(input).unwrap(),).is_err()
            );
        }
        for thinking in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
            let mut input = authority_input();
            input["thinkingLevel"] = json!(thinking);
            let authority =
                create_subagent_authority_v2(&serde_json::from_value(input).unwrap()).unwrap();
            assert_eq!(authority.thinking_level, thinking);
        }
    }

    #[test]
    fn authority_digest_is_stable_across_serialization() {
        let input: CreateSubagentAuthorityV2Input =
            serde_json::from_value(authority_input()).unwrap();
        let authority = create_subagent_authority_v2(&input).unwrap();
        // Round-trip through JSON must not change the digest.
        let reparsed: SubagentAuthorityV2 =
            serde_json::from_value(serde_json::to_value(&authority).unwrap()).unwrap();
        assert_eq!(authority.digest(), reparsed.digest());
        assert_eq!(
            authority.digest(),
            subagent_authority_digest_v2(
                &serde_json::from_value(serde_json::to_value(&authority).unwrap()).unwrap()
            )
        );
        // Reordering any identity field changes the digest.
        let mut changed = authority.clone();
        changed.authority_revision += 1;
        assert_ne!(changed.digest(), authority.digest());
        // sanitize check: every identifier must survive snapshot sanitization.
        let serialized = serde_json::to_string(&authority).unwrap();
        assert_eq!(
            crate::safe_text::sanitize_subagent_text(&serialized),
            serialized
        );
    }

    #[test]
    fn authority_digest_is_stable_across_restarts_with_reordered_persisted_keys() {
        // A persisted authority is re-read from the run store on every launch.
        // The *file's* key order must be irrelevant: parsing a reordered JSON
        // object yields the identical digest, so stored digests stay valid
        // across restarts and file rewrites.
        let input: CreateSubagentAuthorityV2Input =
            serde_json::from_value(authority_input()).unwrap();
        let authority = create_subagent_authority_v2(&input).unwrap();
        let mut value = serde_json::to_value(&authority).unwrap();

        // Reverse the top-level key order the way a hand-edited or rewritten
        // store file might.
        let object = value.as_object_mut().unwrap();
        let mut pairs: Vec<(String, serde_json::Value)> =
            std::mem::take(object).into_iter().collect();
        pairs.reverse();
        let reordered: serde_json::Map<String, serde_json::Value> = pairs.into_iter().collect();
        let reparsed: SubagentAuthorityV2 =
            serde_json::from_value(serde_json::Value::Object(reordered)).unwrap();
        assert_eq!(authority.digest(), reparsed.digest());

        // The canonical digest itself is a fixed hex string for a given
        // authority (regression: field order must never drift with a reparse).
        assert_eq!(reparsed.digest().len(), 64);
        assert!(reparsed
            .digest()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
    }
}
