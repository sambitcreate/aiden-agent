//! Port of `main/services/subagents/contracts.ts` — the model-facing
//! `subagent` tool contract: strict plain-record request parsing, bounded
//! label/task text, the MCP read/mutation disjointness check, and task
//! capability narrowing against the root request.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::capability_profile::is_subagent_role;
use crate::safe_text::sanitize_subagent_text;

pub const MAX_SUBAGENT_TASKS_PER_CALL: usize = 4;
pub const MAX_SUBAGENT_LAUNCHES_PER_GENERATION: usize = 8;
pub const MAX_SUBAGENT_LABEL_CHARS: usize = 120;
pub const MAX_SUBAGENT_TASK_CHARS: usize = 8_000;
pub const MAX_SUBAGENT_SUMMARY_CHARS: usize = 8_000;
pub const MAX_SUBAGENT_TOOL_RESULT_CHARS: usize = 24_000;
pub const MAX_SUBAGENT_REQUESTED_MCP_SERVERS: usize = 16;
pub const MAX_SUBAGENT_REQUESTED_MCP_TOOLS_PER_SERVER: usize = 32;

/// Model-facing positive MCP requests only. Host fingerprints/effects never
/// enter this shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRequestedMcpScope {
    pub server_id: String,
    pub tools: Vec<String>,
}

/// Model-facing positive requests only (`SubagentRequestedCapabilities`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentRequestedCapabilities {
    pub workspace_read: bool,
    pub workspace_write: bool,
    pub shell: Option<bool>,
    pub delegate: Option<bool>,
    pub web: bool,
    pub mcp: Vec<SubagentRequestedMcpScope>,
    pub mcp_mutations: Option<Vec<SubagentRequestedMcpScope>>,
}

impl SubagentRequestedCapabilities {
    pub fn from_value(value: &Value) -> Result<Self, String> {
        parse_requested_capabilities(value)
    }

    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("workspaceRead".into(), Value::Bool(self.workspace_read));
        object.insert("workspaceWrite".into(), Value::Bool(self.workspace_write));
        if let Some(shell) = self.shell {
            object.insert("shell".into(), Value::Bool(shell));
        }
        if let Some(delegate) = self.delegate {
            object.insert("delegate".into(), Value::Bool(delegate));
        }
        object.insert("web".into(), Value::Bool(self.web));
        object.insert("mcp".into(), mcp_scopes_to_value(&self.mcp));
        if let Some(mcp_mutations) = &self.mcp_mutations {
            object.insert("mcpMutations".into(), mcp_scopes_to_value(mcp_mutations));
        }
        Value::Object(object)
    }
}

fn mcp_scopes_to_value(scopes: &[SubagentRequestedMcpScope]) -> Value {
    Value::Array(
        scopes
            .iter()
            .map(|scope| {
                json!({
                    "serverId": scope.server_id,
                    "tools": scope.tools,
                })
            })
            .collect(),
    )
}

use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTaskRequest {
    pub role: String,
    pub label: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<SubagentRequestedCapabilities>,
}

/// Serialize support: the requested-capabilities value is canonical.
impl Serialize for SubagentRequestedCapabilities {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SubagentRequestedCapabilities {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_requested_capabilities(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentToolRequest {
    pub context: String,
    pub capabilities: Option<SubagentRequestedCapabilities>,
    pub tasks: Vec<SubagentTaskRequest>,
}

impl Serialize for SubagentToolRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut object = Map::new();
        object.insert("context".into(), json!(self.context));
        if let Some(capabilities) = &self.capabilities {
            object.insert("capabilities".into(), capabilities.to_value());
        }
        object.insert(
            "tasks".into(),
            serde_json::to_value(&self.tasks).map_err(serde::ser::Error::custom)?,
        );
        Value::Object(object).serialize(serializer)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTaskResult {
    pub role: String,
    pub label: String,
    pub status: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

pub const SUBAGENT_TASK_STATUSES: &[&str] = &["completed", "failed", "timed_out", "interrupted"];

// ===========================================================================
// Parsing
// ===========================================================================

fn has_optional_keys(object: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    object.len() >= required.len()
        && object.len() <= required.len() + optional.len()
        && required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn has_disallowed_label_character(value: &str) -> bool {
    value.chars().any(|character| {
        let code = character as u32;
        code <= 0x1f
            || (0x7f..=0x9f).contains(&code)
            || code == 0x061c
            || code == 0x200e
            || code == 0x200f
            || (0x2028..=0x202e).contains(&code)
            || (0x2066..=0x2069).contains(&code)
    })
}

fn bounded_text(value: &Value, field: &str, maximum: usize) -> Result<String, String> {
    let Some(value) = value.as_str() else {
        return Err(format!(
            "Subagent {field} must contain between 1 and {maximum} characters."
        ));
    };
    if value.is_empty() || value.chars().count() > maximum {
        return Err(format!(
            "Subagent {field} must contain between 1 and {maximum} characters."
        ));
    }
    if value.trim().is_empty()
        || value.contains('\0')
        || (field == "label" && value.trim() != value)
    {
        return Err(format!(
            "Subagent {field} must contain visible text without NUL characters."
        ));
    }
    if field == "label" && has_disallowed_label_character(value) {
        return Err("Subagent label must be a single line without control characters.".to_string());
    }
    Ok(sanitize_subagent_text(value))
}

fn bounded_identifier(value: &Value, field: &str) -> Result<String, String> {
    let Some(value) = value.as_str() else {
        return Err(format!("Invalid subagent {field}."));
    };
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(format!("Invalid subagent {field}."));
    }
    Ok(value.to_string())
}

fn parse_requested_capabilities(value: &Value) -> Result<SubagentRequestedCapabilities, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent capability request.".to_string());
    };
    if !has_optional_keys(
        object,
        &["workspaceRead", "web", "mcp"],
        &["workspaceWrite", "shell", "delegate", "mcpMutations"],
    ) {
        return Err("Invalid subagent capability request.".to_string());
    }
    let workspace_read = object
        .get("workspaceRead")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Invalid subagent capability request.".to_string())?;
    let workspace_write = match object.get("workspaceWrite") {
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "Invalid subagent capability request.".to_string())?,
        None => false,
    };
    let shell = match object.get("shell") {
        Some(value) => Some(
            value
                .as_bool()
                .ok_or_else(|| "Invalid subagent capability request.".to_string())?,
        ),
        None => None,
    };
    let delegate = match object.get("delegate") {
        Some(value) => Some(
            value
                .as_bool()
                .ok_or_else(|| "Invalid subagent capability request.".to_string())?,
        ),
        None => None,
    };
    let web = object
        .get("web")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Invalid subagent capability request.".to_string())?;
    let mcp_value = object.get("mcp").expect("required");
    let mcp = parse_lane(mcp_value, "MCP read")?;
    let mcp_mutations = match object.get("mcpMutations") {
        Some(value) => Some(parse_lane(value, "MCP mutation")?),
        None => None,
    };
    let read_pairs: std::collections::HashSet<String> = mcp
        .iter()
        .flat_map(|scope| {
            scope
                .tools
                .iter()
                .map(move |tool| format!("{}\0{}", scope.server_id, tool))
        })
        .collect();
    if let Some(mutations) = &mcp_mutations {
        if mutations.iter().any(|scope| {
            scope
                .tools
                .iter()
                .any(|tool| read_pairs.contains(&format!("{}\0{}", scope.server_id, tool)))
        }) {
            return Err("Subagent MCP read and mutation requests must be disjoint.".to_string());
        }
    }
    Ok(SubagentRequestedCapabilities {
        workspace_read,
        workspace_write,
        shell,
        delegate,
        web,
        mcp,
        mcp_mutations,
    })
}

fn parse_lane(value: &Value, label: &str) -> Result<Vec<SubagentRequestedMcpScope>, String> {
    let Some(values) = value.as_array() else {
        return Err(format!("Invalid subagent {label} request."));
    };
    if values.len() > MAX_SUBAGENT_REQUESTED_MCP_SERVERS {
        return Err(format!("Invalid subagent {label} request."));
    }
    let mut server_ids: Vec<String> = Vec::new();
    let mut scopes = Vec::with_capacity(values.len());
    for entry in values {
        let Some(object) = entry.as_object() else {
            return Err(format!("Invalid subagent {label} request."));
        };
        if !has_optional_keys(object, &["serverId", "tools"], &[]) {
            return Err(format!("Invalid subagent {label} request."));
        }
        let tools_value = object.get("tools").expect("required");
        let Some(tool_values) = tools_value.as_array() else {
            return Err(format!("Invalid subagent {label} request."));
        };
        if tool_values.is_empty() || tool_values.len() > MAX_SUBAGENT_REQUESTED_MCP_TOOLS_PER_SERVER
        {
            return Err(format!("Invalid subagent {label} request."));
        }
        let server_id = bounded_identifier(
            object.get("serverId").expect("required"),
            &format!("{label} server request"),
        )?;
        if server_ids.contains(&server_id) {
            return Err(format!("Duplicate subagent {label} server request."));
        }
        server_ids.push(server_id.clone());
        let mut tools = Vec::with_capacity(tool_values.len());
        for tool in tool_values {
            let tool = bounded_identifier(tool, &format!("{label} tool request"))?;
            if tools.contains(&tool) {
                return Err(format!("Duplicate subagent {label} tool request."));
            }
            tools.push(tool);
        }
        scopes.push(SubagentRequestedMcpScope { server_id, tools });
    }
    Ok(scopes)
}

fn requested_mcp_pairs(
    value: &SubagentRequestedCapabilities,
    lane: bool,
) -> std::collections::HashSet<String> {
    let scopes = if lane {
        value.mcp_mutations.as_ref()
    } else {
        Some(&value.mcp)
    };
    let mut pairs = std::collections::HashSet::new();
    if let Some(scopes) = scopes {
        for scope in scopes {
            for tool in &scope.tools {
                pairs.insert(format!("{}\0{}", scope.server_id, tool));
            }
        }
    }
    pairs
}

fn assert_task_capabilities_narrow_root(
    root: &SubagentRequestedCapabilities,
    task: &SubagentRequestedCapabilities,
) -> Result<(), String> {
    if (task.workspace_read && !root.workspace_read)
        || (task.workspace_write && !root.workspace_write)
        || (task.shell == Some(true) && root.shell != Some(true))
        || (task.delegate == Some(true) && root.delegate != Some(true))
        || (task.web && !root.web)
    {
        return Err(
            "A subagent task capability request cannot widen its root request.".to_string(),
        );
    }
    for lane in [false, true] {
        let root_pairs = requested_mcp_pairs(root, lane);
        for pair in requested_mcp_pairs(task, lane) {
            if !root_pairs.contains(&pair) {
                return Err("A subagent task MCP request cannot widen its root lane.".to_string());
            }
        }
    }
    Ok(())
}

/// Default read-only root ceiling when the request omits capabilities.
pub fn default_root_capabilities() -> SubagentRequestedCapabilities {
    SubagentRequestedCapabilities {
        workspace_read: true,
        workspace_write: false,
        shell: Some(false),
        delegate: Some(false),
        web: false,
        mcp: Vec::new(),
        mcp_mutations: None,
    }
}

/// Revalidate model arguments independently of TypeBox/provider schema
/// enforcement (`parseSubagentToolRequest`).
pub fn parse_subagent_tool_request(value: &Value) -> Result<SubagentToolRequest, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent request.".to_string());
    };
    if !has_optional_keys(object, &["tasks"], &["context", "capabilities"]) {
        return Err("Invalid subagent request.".to_string());
    }
    let Some(task_values) = object.get("tasks").and_then(Value::as_array) else {
        return Err("Invalid subagent request.".to_string());
    };
    if task_values.is_empty() || task_values.len() > MAX_SUBAGENT_TASKS_PER_CALL {
        return Err(format!(
            "A subagent request must contain 1 to {MAX_SUBAGENT_TASKS_PER_CALL} tasks."
        ));
    }
    let context = match object.get("context") {
        Some(Value::String(context)) if context == "fresh" || context == "fork" => context.clone(),
        None => "fresh".to_string(),
        _ => return Err("Invalid subagent request.".to_string()),
    };
    let capabilities = match object.get("capabilities") {
        Some(value) => Some(parse_requested_capabilities(value)?),
        None => None,
    };
    let root_capabilities = capabilities
        .clone()
        .unwrap_or_else(default_root_capabilities);
    let mut tasks = Vec::with_capacity(task_values.len());
    for entry in task_values {
        let Some(task_object) = entry.as_object() else {
            return Err("Invalid subagent task fields.".to_string());
        };
        if !has_optional_keys(task_object, &["role", "label", "task"], &["capabilities"]) {
            return Err("Invalid subagent task fields.".to_string());
        }
        let role = task_object
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "Unknown subagent role.".to_string())?;
        if !is_subagent_role(role) {
            return Err("Unknown subagent role.".to_string());
        }
        let task_capabilities = match task_object.get("capabilities") {
            Some(value) => Some(parse_requested_capabilities(value)?),
            None => None,
        };
        if let Some(task_capabilities) = &task_capabilities {
            assert_task_capabilities_narrow_root(&root_capabilities, task_capabilities)?;
        }
        tasks.push(SubagentTaskRequest {
            role: role.to_string(),
            label: bounded_text(
                task_object.get("label").expect("required"),
                "label",
                MAX_SUBAGENT_LABEL_CHARS,
            )?,
            task: bounded_text(
                task_object.get("task").expect("required"),
                "task",
                MAX_SUBAGENT_TASK_CHARS,
            )?,
            capabilities: task_capabilities,
        });
    }
    Ok(SubagentToolRequest {
        context,
        capabilities,
        tasks,
    })
}

/// `effectiveSubagentTaskCapabilities` — per-task effective request with the
/// delegated flag normalized to a positive boolean.
pub fn effective_subagent_task_capabilities(
    request: &SubagentToolRequest,
    task: &SubagentTaskRequest,
) -> SubagentRequestedCapabilities {
    let mut effective = task
        .capabilities
        .clone()
        .or_else(|| request.capabilities.clone())
        .unwrap_or_else(default_root_capabilities);
    effective.delegate = Some(effective.delegate == Some(true));
    effective
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_subagent_tool_request_accepts_minimal_read_only() {
        let parsed = parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "scout", "label": "Look", "task": "Explore." }],
        }))
        .unwrap();
        assert_eq!(parsed.context, "fresh");
        assert_eq!(parsed.tasks.len(), 1);
        assert_eq!(parsed.tasks[0].role, "scout");
        assert!(parsed.capabilities.is_none());
        let effective = effective_subagent_task_capabilities(&parsed, &parsed.tasks[0]);
        assert!(effective.workspace_read);
        assert_eq!(effective.delegate, Some(false));
    }

    #[test]
    fn parse_rejects_unknown_roles_and_bad_text() {
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "worker", "label": "x", "task": "y" }],
        }))
        .is_err());
        // over-long label
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "scout", "label": "x".repeat(121), "task": "y" }],
        }))
        .is_err());
        // NUL
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "scout", "label": "ok", "task": "bad\u{0}task" }],
        }))
        .is_err());
        // control characters in label
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "scout", "label": "line\u{2028}break", "task": "y" }],
        }))
        .is_err());
        // too many tasks
        let tasks: Vec<Value> = (0..5)
            .map(|index| json!({ "role": "scout", "label": format!("t{index}"), "task": "y" }))
            .collect();
        assert!(parse_subagent_tool_request(&json!({ "tasks": tasks })).is_err());
    }

    #[test]
    fn mcp_read_and_mutation_lanes_must_be_disjoint() {
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "scout", "label": "x", "task": "y" }],
            "capabilities": {
                "workspaceRead": true,
                "web": false,
                "mcp": [{ "serverId": "linear", "tools": ["get_issue"] }],
                "mcpMutations": [{ "serverId": "linear", "tools": ["get_issue"] }],
            },
        }))
        .is_err());
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "scout", "label": "x", "task": "y" }],
            "capabilities": {
                "workspaceRead": true,
                "web": false,
                "mcp": [{ "serverId": "linear", "tools": ["get_issue"] }],
                "mcpMutations": [{ "serverId": "linear", "tools": ["update_issue"] }],
            },
        }))
        .is_ok());
    }

    #[test]
    fn task_capabilities_cannot_widen_the_root() {
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{
                "role": "scout",
                "label": "x",
                "task": "y",
                "capabilities": {
                    "workspaceRead": true,
                    "workspaceWrite": true,
                    "web": false,
                    "mcp": [],
                },
            }],
            "capabilities": {
                "workspaceRead": true,
                "workspaceWrite": false,
                "web": false,
                "mcp": [],
            },
        }))
        .is_err());
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{
                "role": "scout",
                "label": "x",
                "task": "y",
                "capabilities": {
                    "workspaceRead": true,
                    "workspaceWrite": false,
                    "web": false,
                    "mcp": [],
                },
            }],
            "capabilities": {
                "workspaceRead": true,
                "workspaceWrite": false,
                "web": false,
                "mcp": [],
            },
        }))
        .is_ok());
    }

    #[test]
    fn duplicate_server_or_tool_requests_are_rejected() {
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "scout", "label": "x", "task": "y" }],
            "capabilities": {
                "workspaceRead": true,
                "web": false,
                "mcp": [
                    { "serverId": "linear", "tools": ["a"] },
                    { "serverId": "linear", "tools": ["b"] },
                ],
            },
        }))
        .is_err());
        assert!(parse_subagent_tool_request(&json!({
            "tasks": [{ "role": "scout", "label": "x", "task": "y" }],
            "capabilities": {
                "workspaceRead": true,
                "web": false,
                "mcp": [{ "serverId": "linear", "tools": ["a", "a"] }],
            },
        }))
        .is_err());
    }

    #[test]
    fn effective_task_capabilities_normalize_delegate() {
        let request_value = json!({
            "context": "fresh",
            "capabilities": {
                "workspaceRead": true,
                "workspaceWrite": true,
                "web": false,
                "mcp": [],
                "delegate": true,
            },
            "tasks": [{ "role": "planner", "label": "x", "task": "y" }],
        });
        let parsed = parse_subagent_tool_request(&request_value).unwrap();
        let effective = effective_subagent_task_capabilities(&parsed, &parsed.tasks[0]);
        assert_eq!(effective.delegate, Some(true));
        assert!(effective.workspace_write);
    }
}
