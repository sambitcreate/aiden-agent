//! Pending-approval queue reducer (pure, unit-tested).
//!
//! Ports the renderer's `enqueueAssistantApproval` (`use-assistant-chat.ts`)
//! and the queue-focus behavior of `assistant-panel.tsx`, which renders only
//! `approvals[0]`: the queue is **FIFO** — a new prompt is appended, and the
//! panel always surfaces the oldest outstanding approval first. A decision
//! removes exactly one entry (one-shot), so the next pending approval takes
//! the head on the following render.

use serde_json::Value;

/// The renderer-safe approval prompt the panel renders, mirroring
/// `ToolApprovalPrompt` (`aiden_agent::tool_approval`) minus the publisher.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingApproval {
    pub approval_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub summary: String,
    /// Structured details for the matching approval card. `None` renders the
    /// fail-closed invalid state (the TS "invalid and cannot be confirmed").
    pub details: Option<Value>,
}

impl PendingApproval {
    /// Parse a runner `AgentEvent::ApprovalRequired` payload. The bridge
    /// embeds the envelope fields (`approvalId`, `toolCallId`, `toolName`,
    /// `summary`) alongside the kind-specific details. A payload without an
    /// id or tool name is malformed and yields `None` — the panel can never
    /// confirm what it cannot identify (fail closed).
    pub fn from_details(details: &Value) -> Option<Self> {
        let approval_id = details.get("approvalId")?.as_str()?.to_string();
        if approval_id.is_empty() {
            return None;
        }
        let tool_name = details.get("toolName")?.as_str()?.to_string();
        let tool_call_id = details
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let summary = details
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Some(Self {
            approval_id,
            tool_call_id,
            tool_name,
            summary,
            details: Some(details.clone()),
        })
    }
}

/// The classification of a pending approval's details — selects the card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalKind {
    /// A mutating coding tool (`write_file` / `edit_file` / `run_command`).
    Tool,
    /// An automation proposal (`schedule_task` / `edit_automation`).
    AssistantAutomation,
    /// A full-host shell command (subagent shell approval).
    Shell,
    /// A mutating MCP connector call.
    McpMutation,
    /// Malformed or unknown details — the panel renders the invalid card.
    Unknown,
}

/// Classify details by their `kind` discriminator.
pub fn approval_kind(details: Option<&Value>) -> ApprovalKind {
    match details
        .and_then(|details| details.get("kind"))
        .and_then(Value::as_str)
    {
        Some("tool") => ApprovalKind::Tool,
        Some("assistant-automation") => ApprovalKind::AssistantAutomation,
        Some("subagent-shell") => ApprovalKind::Shell,
        Some("subagent-mcp-mutation") => ApprovalKind::McpMutation,
        _ => ApprovalKind::Unknown,
    }
}

/// `enqueueAssistantApproval` — append unless the id is already queued.
/// Newest approval lands at the tail; the panel renders the head.
pub fn enqueue_approval(
    approvals: Vec<PendingApproval>,
    prompt: PendingApproval,
) -> Vec<PendingApproval> {
    if approvals
        .iter()
        .any(|approval| approval.approval_id == prompt.approval_id)
    {
        return approvals;
    }
    let mut next = approvals;
    next.push(prompt);
    next
}

/// The head of the queue — the only approval the panel renders
/// (`approvals[0]` in the renderer).
pub fn queue_head(approvals: &[PendingApproval]) -> Option<&PendingApproval> {
    approvals.first()
}

/// Resolve one pending approval: remove exactly the first matching entry and
/// return it alongside the remaining queue. One-shot: a second `decide_approval`
/// for the same id is a no-op (returns `None`).
pub fn decide_approval(
    approvals: Vec<PendingApproval>,
    approval_id: &str,
) -> (Vec<PendingApproval>, Option<PendingApproval>) {
    let mut found = None;
    let mut next = Vec::with_capacity(approvals.len().saturating_sub(1));
    for approval in approvals {
        if approval.approval_id == approval_id && found.is_none() {
            found = Some(approval);
        } else {
            next.push(approval);
        }
    }
    (next, found)
}

/// Drop every pending approval (new turn / stop / thread switch).
pub fn clear_approvals(_approvals: Vec<PendingApproval>) -> Vec<PendingApproval> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(id: &str, tool: &str) -> PendingApproval {
        PendingApproval {
            approval_id: id.to_string(),
            tool_call_id: format!("call-{id}"),
            tool_name: tool.to_string(),
            summary: "do something".to_string(),
            details: None,
        }
    }

    #[test]
    fn enqueue_is_deduping_and_fifo() {
        let mut queue = vec![prompt("a", "schedule_task")];
        // Duplicate id is ignored.
        queue = enqueue_approval(queue, prompt("a", "schedule_task"));
        assert_eq!(queue.len(), 1);
        // New approvals append at the tail: the head stays the oldest.
        queue = enqueue_approval(queue, prompt("b", "edit_automation"));
        queue = enqueue_approval(queue, prompt("c", "run_command"));
        assert_eq!(queue_head(&queue).unwrap().approval_id, "a");
        assert_eq!(queue.last().unwrap().approval_id, "c");
    }

    #[test]
    fn decide_removes_exactly_the_matching_entry_and_is_one_shot() {
        let queue = vec![prompt("a", "schedule_task"), prompt("b", "edit_automation")];
        let (queue, removed) = decide_approval(queue, "a");
        assert_eq!(removed.unwrap().approval_id, "a");
        // The next approval takes the head (FIFO focus handoff).
        assert_eq!(queue_head(&queue).unwrap().approval_id, "b");
        let (queue, removed) = decide_approval(queue, "a");
        assert!(removed.is_none());
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn decide_on_an_unknown_id_changes_nothing() {
        let queue = vec![prompt("a", "schedule_task")];
        let (queue, removed) = decide_approval(queue, "nope");
        assert!(removed.is_none());
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn from_details_parses_the_bridge_envelope_and_rejects_malformed_payloads() {
        let details = serde_json::json!({
            "kind": "assistant-automation",
            "approvalId": "a-1",
            "toolCallId": "call-1",
            "toolName": "schedule_task",
            "summary": "Create Morning brief",
        });
        let prompt = PendingApproval::from_details(&details).expect("parses");
        assert_eq!(prompt.approval_id, "a-1");
        assert_eq!(prompt.tool_name, "schedule_task");
        assert_eq!(prompt.summary, "Create Morning brief");
        // Missing approval id / tool name → fail closed.
        assert!(PendingApproval::from_details(&serde_json::json!({})).is_none());
        assert!(PendingApproval::from_details(&serde_json::json!({
            "toolName": "x"
        }))
        .is_none());
    }

    #[test]
    fn approval_kind_classifies_the_details_discriminator() {
        assert_eq!(
            approval_kind(Some(&serde_json::json!({ "kind": "tool" }))),
            ApprovalKind::Tool
        );
        assert_eq!(
            approval_kind(Some(&serde_json::json!({ "kind": "assistant-automation" }))),
            ApprovalKind::AssistantAutomation
        );
        assert_eq!(
            approval_kind(Some(&serde_json::json!({ "kind": "subagent-shell" }))),
            ApprovalKind::Shell
        );
        assert_eq!(
            approval_kind(Some(
                &serde_json::json!({ "kind": "subagent-mcp-mutation" })
            )),
            ApprovalKind::McpMutation
        );
        assert_eq!(
            approval_kind(Some(&serde_json::json!({ "kind": "bogus" }))),
            ApprovalKind::Unknown
        );
        assert_eq!(approval_kind(None), ApprovalKind::Unknown);
    }
}
