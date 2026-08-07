//! Aiden agent loop — scaffold.
//!
//! Phase 3 placeholder. This crate will port the pi-agent-core surface Aiden
//! wraps (`main/services/assistant/`, `coding-tools.ts`, `tools.ts`):
//!
//! - **Turn loop** — consume an [`AssistantMessageEvent`](aiden_core::AssistantMessageEvent)
//!   stream, dispatch tool calls, feed results back, sequential/parallel
//!   execution via `tokio::task::JoinSet`, event fan-out over a broadcast
//!   channel.
//! - **Tool definitions** — `AgentTool { name, label, description, parameters }`
//!   with schemars-derived JSON Schema (replacing typebox). Coding tools
//!   (folder-scoped): `read_file`, `list_dir`, `glob`, `grep`, `write_file`,
//!   `edit_file`, `run_command`; integrations (`web_search`, `skill_*`, MCP
//!   tools, `computer_use`, `schedule_task`, `edit_automation`, `subagent`).
//! - **Approval gate** — `before_tool_call` pausing on
//!   [`ToolApprovalDetails`](aiden_core::ToolApprovalDetails) with a oneshot
//!   resolution per approval id; `APPROVAL_TOOL_NAMES` = mutating set.
//! - **Event projection** — `AgentEvent` fan-out → timeline projector
//!   ([`GenerationTimeline`](aiden_core::GenerationTimeline) v2).
//!
//! The approval tool set is part of the domain contract, so it is defined now.

/// The mutating tool set that pauses for explicit user approval ("ask"
/// permission). Mirrors `APPROVAL_TOOL_NAMES` in `main/services/assistant/`.
pub const APPROVAL_TOOL_NAMES: &[&str] = &["write_file", "edit_file", "run_command"];

/// Whether a tool name requires attended approval.
pub fn requires_approval(tool_name: &str) -> bool {
    APPROVAL_TOOL_NAMES.contains(&tool_name)
}

/// A tool call being dispatched by the loop.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallDispatch {
    pub tool_call_id: String,
    pub tool_name: String,
    /// Decoded JSON arguments for the tool.
    pub arguments: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutating_tools_require_approval() {
        assert!(requires_approval("write_file"));
        assert!(requires_approval("run_command"));
        assert!(!requires_approval("read_file"));
        assert!(!requires_approval("web_search"));
    }
}
