//! Port of the automation runtime contract (`main/services/assistant/
//! automation-runtime-contract.test.ts` asserts the tool-assembly invariants in
//! `tools.ts`, `schedule-execution.ts`, `llm-client.ts` and `chat-params.ts`).
//!
//! The contract for scheduler runs:
//! - **`assistant-automation`** (approved project automations) receives only
//!   folder-scoped coding tools and must never be mixed with MCP connectors;
//!   project and connector scopes are intentionally separate so untrusted data
//!   from an external service cannot flow into project mutation tools.
//! - **`assistant`** (attended dock) receives a positive allowlist: identity
//!   tools (`list_projects`, `list_mcp_servers`) + scheduling tools, plus MCP
//!   connector tools only when explicitly allowed. No ambient tools appear by
//!   default.
//! - The **renderer cannot request the internal modes**; only `"assistant"`
//!   (or no mode) parses as a chat-start mode.

use std::path::PathBuf;

/// The internal generation modes. Only [`AgentToolMode::Assistant`] is
/// requestable by the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentToolMode {
    Assistant,
    AssistantUnattended,
    AssistantAutomation,
}

impl AgentToolMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentToolMode::Assistant => "assistant",
            AgentToolMode::AssistantUnattended => "assistant-unattended",
            AgentToolMode::AssistantAutomation => "assistant-automation",
        }
    }
}

/// Workspace permission levels (`WorkspacePermission` in `types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkspacePermission {
    Full,
    Ask,
    None,
}

impl WorkspacePermission {
    /// Parse a stored permission string (`"full"` | `"ask"` | `"none"`).
    pub fn from_value(value: &str) -> Option<Self> {
        match value {
            "full" => Some(WorkspacePermission::Full),
            "ask" => Some(WorkspacePermission::Ask),
            "none" => Some(WorkspacePermission::None),
            _ => None,
        }
    }
}

/// The tool families a generation may receive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolFamily {
    /// Folder-scoped coding tools (`buildCodingTools`).
    CodingTools,
    /// `list_projects` + `list_mcp_servers` identity tools.
    AssistantIdentityTools,
    /// `schedule_task` / `edit_automation` / `list_scheduled_tasks`.
    SchedulingTools,
    /// Ambient MCP connector tools (`mcp_<server>_<tool>`).
    McpConnectorTools,
}

/// The resolved tool-assembly plan for a mode, in assembly order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPlan {
    pub families: Vec<ToolFamily>,
}

impl ToolPlan {
    pub fn is_empty(&self) -> bool {
        self.families.is_empty()
    }
}

/// Errors assembling tools for a generation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ToolAssemblyError {
    #[error("unknown agent tool mode: {0}")]
    UnknownMode(String),
    #[error("Assistant project automations cannot use MCP connectors.")]
    McpConnectorsInProjectAutomation,
}

/// The reject message shown when an approved project automation would mix MCP
/// connectors into its coding-tool set.
pub const ASSISTANT_AUTOMATION_REJECT_MCP_MSG: &str =
    "Assistant project automations cannot use MCP connectors.";

/// The attended decline reply the model must use when an automation proposal is
/// declined (also embedded in the system prompt handbook).
pub const ATTENDED_DECLINE_REPLY: &str = "Okay—what else should we do?";

/// Everything the tool assembly needs to decide a generation's tool set
/// (mirrors `ToolContext`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationToolContext {
    pub mode: AgentToolMode,
    pub workspace_root: Option<PathBuf>,
    pub permission: WorkspacePermission,
    /// Background scheduled runs disable this to prevent recursive task
    /// creation.
    pub allow_scheduling: Option<bool>,
    /// Read-only background runs withhold MCP tools because their mutation
    /// semantics are unknown.
    pub allow_mcp_tools: Option<bool>,
    /// Exact configured server identities approved for this generation.
    pub mcp_server_ids: Vec<String>,
}

impl Default for AutomationToolContext {
    fn default() -> Self {
        Self {
            mode: AgentToolMode::Assistant,
            workspace_root: None,
            permission: WorkspacePermission::Ask,
            allow_scheduling: None,
            allow_mcp_tools: None,
            mcp_server_ids: Vec::new(),
        }
    }
}

/// Resolve the tool-assembly plan, mirroring `buildAgentTools` for the two
/// assistant modes.
pub fn resolve_automation_tool_plan(
    ctx: &AutomationToolContext,
) -> Result<ToolPlan, ToolAssemblyError> {
    match ctx.mode {
        AgentToolMode::Assistant | AgentToolMode::AssistantUnattended => {
            let mut families: Vec<ToolFamily> = if ctx.allow_scheduling == Some(false) {
                Vec::new()
            } else {
                vec![
                    ToolFamily::AssistantIdentityTools,
                    ToolFamily::SchedulingTools,
                ]
            };
            if ctx.allow_mcp_tools == Some(true) {
                families.push(ToolFamily::McpConnectorTools);
            }
            Ok(ToolPlan { families })
        }
        AgentToolMode::AssistantAutomation => {
            if ctx.allow_mcp_tools == Some(true) || !ctx.mcp_server_ids.is_empty() {
                return Err(ToolAssemblyError::McpConnectorsInProjectAutomation);
            }
            let families =
                if ctx.workspace_root.is_some() && ctx.permission != WorkspacePermission::None {
                    vec![ToolFamily::CodingTools]
                } else {
                    Vec::new()
                };
            Ok(ToolPlan { families })
        }
    }
}

/// Whether a mode string may be requested by the renderer for `chat:start`
/// (mirrors the `chat-params.ts` reject: any non-`"assistant"` mode is
/// main-only).
pub fn is_renderer_requestable_mode(mode: &str) -> bool {
    mode == AgentToolMode::Assistant.as_str()
}

/// Parse the renderer-supplied `mode` for `chat:start`. `None` (absent) is
/// allowed; `"assistant"` is allowed; every other value is rejected as an
/// internal mode.
pub fn parse_chat_start_mode(
    value: Option<&str>,
) -> Result<Option<AgentToolMode>, ToolAssemblyError> {
    match value {
        None => Ok(None),
        Some(mode) if mode == AgentToolMode::Assistant.as_str() => {
            Ok(Some(AgentToolMode::Assistant))
        }
        Some(other) => Err(ToolAssemblyError::UnknownMode(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn automation(root: Option<&str>) -> AutomationToolContext {
        AutomationToolContext {
            mode: AgentToolMode::AssistantAutomation,
            workspace_root: root.map(PathBuf::from),
            permission: WorkspacePermission::Ask,
            allow_scheduling: None,
            allow_mcp_tools: None,
            mcp_server_ids: Vec::new(),
        }
    }

    #[test]
    fn project_automations_receive_only_coding_tools_and_reject_mcp_scope() {
        let plan = resolve_automation_tool_plan(&automation(Some("/tmp/project"))).unwrap();
        assert_eq!(plan.families, vec![ToolFamily::CodingTools]);

        // MCP scope is rejected, matching "cannot use MCP connectors".
        let mut with_mcp = automation(Some("/tmp/project"));
        with_mcp.allow_mcp_tools = Some(true);
        assert_eq!(
            resolve_automation_tool_plan(&with_mcp).unwrap_err(),
            ToolAssemblyError::McpConnectorsInProjectAutomation
        );
        let mut with_ids = automation(Some("/tmp/project"));
        with_ids.mcp_server_ids = vec!["gmail".to_string()];
        assert_eq!(
            resolve_automation_tool_plan(&with_ids).unwrap_err(),
            ToolAssemblyError::McpConnectorsInProjectAutomation
        );

        // No folder or none-permission → no tools at all.
        assert!(resolve_automation_tool_plan(&automation(None))
            .unwrap()
            .is_empty());
        let mut none_permission = automation(Some("/tmp/project"));
        none_permission.permission = WorkspacePermission::None;
        assert!(resolve_automation_tool_plan(&none_permission)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn attended_assistant_sees_identity_tools_and_scheduling_but_no_ambient_connectors() {
        let ctx = AutomationToolContext {
            mode: AgentToolMode::Assistant,
            ..Default::default()
        };
        let plan = resolve_automation_tool_plan(&ctx).unwrap();
        assert_eq!(
            plan.families,
            vec![
                ToolFamily::AssistantIdentityTools,
                ToolFamily::SchedulingTools,
            ]
        );
        // Connector tools only when explicitly allowed.
        let mut allowed = ctx.clone();
        allowed.allow_mcp_tools = Some(true);
        let plan = resolve_automation_tool_plan(&allowed).unwrap();
        assert_eq!(
            plan.families,
            vec![
                ToolFamily::AssistantIdentityTools,
                ToolFamily::SchedulingTools,
                ToolFamily::McpConnectorTools,
            ]
        );
        // Scheduling suppressed.
        let mut no_scheduling = ctx.clone();
        no_scheduling.allow_scheduling = Some(false);
        assert!(resolve_automation_tool_plan(&no_scheduling)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_internal_project_automation_mode_cannot_be_requested_by_the_renderer() {
        assert_eq!(parse_chat_start_mode(None).unwrap(), None);
        assert_eq!(
            parse_chat_start_mode(Some("assistant")).unwrap(),
            Some(AgentToolMode::Assistant)
        );
        assert!(matches!(
            parse_chat_start_mode(Some("assistant-automation")),
            Err(ToolAssemblyError::UnknownMode(_))
        ));
        assert!(matches!(
            parse_chat_start_mode(Some("assistant-unattended")),
            Err(ToolAssemblyError::UnknownMode(_))
        ));
        assert!(matches!(
            parse_chat_start_mode(Some("subagent")),
            Err(ToolAssemblyError::UnknownMode(_))
        ));
        assert!(!is_renderer_requestable_mode("assistant-automation"));
        assert!(is_renderer_requestable_mode("assistant"));
    }

    #[test]
    fn unattended_mode_maps_to_the_attended_plan_without_scheduling_tools() {
        let ctx = AutomationToolContext {
            mode: AgentToolMode::AssistantUnattended,
            ..Default::default()
        };
        let plan = resolve_automation_tool_plan(&ctx).unwrap();
        assert_eq!(
            plan.families,
            vec![
                ToolFamily::AssistantIdentityTools,
                ToolFamily::SchedulingTools,
            ]
        );
    }
}
