//! Aiden agent loop — port of `main/services/assistant/` + `coding-tools.ts`.
//!
//! This crate replaces the pi-agent-core surface Aiden wraps:
//!
//! - **Turn loop** (`runner`): an [`AgentRunner`](runner::run_agent) drives a
//!   [`Provider`](aiden_providers::Provider) stream, dispatches tool calls
//!   through a [`ToolExecutor`](runner::ToolExecutor), enforces the tool-loop
//!   guard rails (repeated-call detection, max iterations, attended tool-error
//!   recovery) and fans a unified [`AgentEvent`](runner::AgentEvent) stream out
//!   over a `tokio::sync::mpsc` channel. Streams never throw: every provider
//!   failure is a terminal `AgentEvent::Error`.
//! - **Tool definitions** (`coding_tools`): the folder-scoped coding tools
//!   (`read_file`, `list_dir`, `glob`, `grep`, `write_file`, `edit_file`,
//!   `run_command`) with JSON-schema parameters (replacing typebox) and the
//!   safe-execution core: workspace-root path confinement, TOCTOU-verified
//!   reads, credential-path exclusion, and bounded traversal. The shell tool
//!   runs through `tokio::process` behind an [`ApprovalPolicy`](approval)
//!   whose default in this crate denies everything mutating (the UI wires a
//!   real approval flow later).
//! - **Assistant tools** (`mcp_tool`, `project_tool`): the read-only
//!   `list_mcp_servers` / `list_projects` identity tools from the attended
//!   dock.
//! - **System prompt** (`system_prompt`): the Aiden persona builder with the
//!   attended/unattended `[SILENT]` contract, byte-preserving the TS prompt
//!   text.
//! - **Automation runtime contract** (`automation`): the mode/tool-assembly
//!   contract that scheduler runs rely on (coding-tools-only project
//!   automations, no MCP connectors, renderer cannot request internal modes).
//!
//! The approval tool set is part of the domain contract, so it is defined now.

pub mod approval;
pub mod automation;
pub mod coding_tools;
pub mod mcp_tool;
pub mod project_tool;
pub mod runner;
pub mod system_prompt;
pub mod tool_loop_guard;

pub use approval::{
    requires_approval, AllowAllApprovalPolicy, ApprovalPolicy, ApprovalRequest, ApprovalVerdict,
    DenyAllApprovalPolicy, APPROVAL_TOOL_NAMES,
};
pub use automation::{
    parse_chat_start_mode, resolve_automation_tool_plan, AgentToolMode, AutomationToolContext,
    ToolAssemblyError, ToolFamily, ToolPlan, WorkspacePermission,
    ASSISTANT_AUTOMATION_REJECT_MCP_MSG, ATTENDED_DECLINE_REPLY,
};
pub use coding_tools::{
    build_coding_tool_executor, build_subagent_coding_tool_executor, parent_coding_tool_defs,
    subagent_coding_tool_defs, summarize_tool_call, CodingTool, CodingToolExecutor,
};
pub use mcp_tool::{
    assistant_mcp_server_instruction, assistant_mcp_server_inventory, assistant_mcp_server_status,
    AssistantMcpServerIdentity, AssistantMcpServerInventory, AssistantMcpServerTool,
    McpServerLister, McpServerRecord, ASSISTANT_MCP_SERVERS_TOOL_NAME,
};
pub use project_tool::{
    AssistantProjectTool, WorkspaceLister, WorkspaceRecord, LIST_PROJECTS_TOOL_NAME,
};
pub use runner::{
    run_agent, AgentEvent, AgentOutcome, AgentOutcomeStatus, RunnerConfig, ToolExecutionError,
    ToolExecutor, ToolOutput,
};
pub use system_prompt::{
    build_assistant_system_prompt, with_unattended_assistant_contract, AssistantPromptInput,
};
pub use tool_loop_guard::{
    advance_attended_tool_error_state, attended_tool_recovery_message,
    recover_attended_tool_error_context, AgentContext, AttendedToolErrorState,
    ATTENDED_TOOL_FAILURE_RECOVERY_REPLY, MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS,
};

/// A tool call being dispatched by the loop.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallDispatch {
    pub tool_call_id: String,
    pub tool_name: String,
    /// Decoded JSON arguments for the tool.
    pub arguments: serde_json::Value,
}
