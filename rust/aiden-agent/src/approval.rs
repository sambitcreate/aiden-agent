//! Approval gate for the agent loop — the port of the "ask"-permission
//! `beforeToolCall` boundary plus the shell-tool gate.
//!
//! The mutating tool set (`write_file`, `edit_file`, `run_command`) is part of
//! the domain contract (mirrors `APPROVAL_TOOL_NAMES`). In this crate the
//! default policy denies everything mutating; a UI-bound policy wires real
//! human approval later through [`ApprovalPolicy::resolve`].

use async_trait::async_trait;

use aiden_core::ToolCall;

/// The mutating tool set that pauses for explicit user approval ("ask"
/// permission). Mirrors `APPROVAL_TOOL_NAMES` in `main/services/coding-tools.ts`.
pub const APPROVAL_TOOL_NAMES: &[&str] = &["write_file", "edit_file", "run_command"];

/// Whether a tool name requires attended approval.
pub fn requires_approval(tool_name: &str) -> bool {
    APPROVAL_TOOL_NAMES.contains(&tool_name)
}

/// A renderer-safe request to pause a tool call for human approval.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub tool_name: String,
    /// One-line summary of the action (e.g. "Run command: cargo test").
    pub summary: String,
    /// Structured details a UI can render for the approval card.
    pub details: serde_json::Value,
}

/// How an [`ApprovalPolicy`] disposes of one tool call.
#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalVerdict {
    /// Execute immediately.
    Allow,
    /// Emit `AgentEvent::ApprovalRequired` and wait for
    /// [`ApprovalPolicy::resolve`]. UI-bound policies await `chat:approve`;
    /// this crate's defaults never produce `Ask` without a resolver.
    Ask(ApprovalRequest),
    /// Never execute; feed a blocked error result to the model.
    Deny { reason: String },
}

/// Decides whether a tool call may execute.
///
/// The default in this crate is deny-all for the mutating set — no tool with
/// side effects runs until the UI wires a real approval channel. `evaluate` is
/// synchronous so the loop can build deterministic events; `resolve` is async
/// for a future UI-backed pause.
#[async_trait]
pub trait ApprovalPolicy: Send + Sync {
    fn evaluate(&self, call: &ToolCall) -> ApprovalVerdict;

    /// Resolve an outstanding [`ApprovalVerdict::Ask`] request. The default
    /// denies, matching the crate's fail-closed posture.
    async fn resolve(&self, approval_id: &str) -> Result<(), String> {
        let _ = approval_id;
        Err("no approval resolution is wired".to_string())
    }
}

/// The crate default: mutating tools require approval and are denied; read-only
/// tools run.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyAllApprovalPolicy;

impl DenyAllApprovalPolicy {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ApprovalPolicy for DenyAllApprovalPolicy {
    fn evaluate(&self, call: &ToolCall) -> ApprovalVerdict {
        if requires_approval(&call.name) {
            ApprovalVerdict::Deny {
                reason: "Tool execution requires approval.".to_string(),
            }
        } else {
            ApprovalVerdict::Allow
        }
    }
}

/// Everything is allowed immediately (tests and explicit opt-in callers).
#[derive(Debug, Clone, Copy, Default)]
pub struct AllowAllApprovalPolicy;

impl AllowAllApprovalPolicy {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ApprovalPolicy for AllowAllApprovalPolicy {
    fn evaluate(&self, _call: &ToolCall) -> ApprovalVerdict {
        ApprovalVerdict::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: "call-1".to_string(),
            name: name.to_string(),
            arguments: serde_json::json!({}),
            thought_signature: None,
        }
    }

    #[test]
    fn mutating_tools_require_approval() {
        assert!(requires_approval("write_file"));
        assert!(requires_approval("edit_file"));
        assert!(requires_approval("run_command"));
        assert!(!requires_approval("read_file"));
        assert!(!requires_approval("list_dir"));
        assert!(!requires_approval("glob"));
        assert!(!requires_approval("grep"));
        assert!(!requires_approval("list_mcp_servers"));
        assert!(!requires_approval("list_projects"));
    }

    #[test]
    fn deny_all_policy_blocks_only_the_mutating_set() {
        let policy = DenyAllApprovalPolicy::new();
        assert!(matches!(
            policy.evaluate(&call("write_file")),
            ApprovalVerdict::Deny { .. }
        ));
        assert!(matches!(
            policy.evaluate(&call("run_command")),
            ApprovalVerdict::Deny { .. }
        ));
        assert!(matches!(
            policy.evaluate(&call("read_file")),
            ApprovalVerdict::Allow
        ));
        assert!(matches!(
            policy.evaluate(&call("grep")),
            ApprovalVerdict::Allow
        ));
    }

    #[test]
    fn allow_all_policy_permits_everything() {
        let policy = AllowAllApprovalPolicy::new();
        assert!(matches!(
            policy.evaluate(&call("write_file")),
            ApprovalVerdict::Allow
        ));
        assert!(matches!(
            policy.evaluate(&call("run_command")),
            ApprovalVerdict::Allow
        ));
    }
}
