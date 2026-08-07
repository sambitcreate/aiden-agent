//! The agent-runner approval bridge: an [`ApprovalPolicy`] implementation that
//! forwards every gated tool call to the UI and awaits the user's decision over
//! a one-shot channel (the "UI-bound policy" the aiden-agent runner doc points
//! at).
//!
//! Flow: the runner calls [`ApprovalBridge::evaluate`] (synchronous, on the
//! background agent thread), which publishes an `ApprovalVerdict::Ask` carrying
//! renderer-safe details (including the `approvalId`) and parks the decision
//! channel. The runner emits `AgentEvent::ApprovalRequired`; the panel renders
//! the queue head and calls [`ApprovalBridge::decide`]. [`ApprovalBridge::resolve`]
//! (awaited by the runner) receives the decision over the channel. A decision
//! is one-shot; dropping the panel settles every outstanding request with the
//! cancelled error (fail closed), mirroring the renderer's abort-signal expiry.
//!
//! `AllowSession` records the tool name in a session allow-list so subsequent
//! calls of the same tool run without pausing until the panel (or bridge) is
//! recreated.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use aiden_agent::approval::{ApprovalRequest, ApprovalVerdict, APPROVAL_TOOL_NAMES};
use aiden_agent::summarize_tool_call;
use aiden_core::ToolCall;
use async_trait::async_trait;
use tokio::sync::mpsc;

/// The three-way decision the UI sends back for a tool approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    /// Run this single call, then ask again next time.
    AllowOnce,
    /// Run this call and every later call of the same tool without asking.
    AllowSession,
    /// Do not run; feed a blocked error result back to the model.
    Deny,
}

impl ApprovalDecision {
    pub fn label(self) -> &'static str {
        match self {
            ApprovalDecision::AllowOnce => "Allow once",
            ApprovalDecision::AllowSession => "Allow session",
            ApprovalDecision::Deny => "Deny",
        }
    }
}

/// Details discriminator for the bridge's tool approvals.
pub const TOOL_DETAILS_KIND: &str = "tool";
/// Details discriminator for automation proposals.
pub const AUTOMATION_DETAILS_KIND: &str = "assistant-automation";

/// The automation-proposal tools that pause for the automation card.
pub const AUTOMATION_TOOL_NAMES: &[&str] = &["schedule_task", "edit_automation"];

/// Whether a tool name is an automation proposal (`schedule_task` /
/// `edit_automation`).
pub fn is_automation_tool(tool_name: &str) -> bool {
    AUTOMATION_TOOL_NAMES.contains(&tool_name)
}

/// Whether a tool name pauses for a human decision in the bridge.
pub fn bridge_requires_approval(tool_name: &str) -> bool {
    is_automation_tool(tool_name) || APPROVAL_TOOL_NAMES.contains(&tool_name)
}

/// One pending entry: the decision channel. The receiver is held until
/// [`ApprovalBridge::resolve`] takes it; the sender is what [`ApprovalBridge::decide`]
/// uses.
struct Pending {
    tool_name: String,
    tx: mpsc::Sender<ApprovalDecision>,
    rx: Option<mpsc::Receiver<ApprovalDecision>>,
}

/// The UI-bound approval policy. Cheap to clone: the pending map and the
/// session allow-list are shared.
#[derive(Clone)]
pub struct ApprovalBridge {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    session_allow: Arc<Mutex<HashSet<String>>>,
}

impl Default for ApprovalBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalBridge {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            session_allow: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Settle the decision for one approval. The decision is delivered over the
    /// parked channel immediately; the map entry is only removed when the
    /// runner's [`ApprovalBridge::resolve`] collects the decision (or
    /// [`ApprovalBridge::cancel_all`] aborts), so `decide` and `resolve` are
    /// order-independent. One-shot: a second `decide` for the same id is a
    /// no-op (the channel already carries the first decision). `AllowSession`
    /// additionally records the tool in the session allow-list.
    ///
    /// A second `decide` also cleans up a *dead* entry: when the runner was
    /// cancelled after `resolve` took the receiver (so nothing can ever read a
    /// decision again), the entry is removed so the UI queue does not leak a
    /// stale, never-resolvable approval card.
    pub fn decide(&self, approval_id: &str, decision: ApprovalDecision) -> bool {
        let tool_name = {
            let mut pending = lock(&self.pending);
            let Some(entry) = pending.get(approval_id) else {
                return false;
            };
            let delivered = entry.tx.try_send(decision).is_ok();
            if !delivered {
                if entry.rx.is_none() {
                    // The runner's resolve already took the receiver and was
                    // then cancelled: nobody can consume this decision, so the
                    // entry is dead. Drop it to avoid a stale approval card.
                    pending.remove(approval_id);
                }
                return false;
            }
            entry.tool_name.clone()
        };
        if decision == ApprovalDecision::AllowSession {
            let mut session = lock(&self.session_allow);
            session.insert(tool_name);
        }
        true
    }

    /// Whether a tool call is currently session-allowed (no approval needed).
    pub fn is_session_allowed(&self, tool_name: &str) -> bool {
        lock(&self.session_allow).contains(tool_name)
    }

    /// Settle every outstanding request with the cancelled path (panel drop,
    /// stop, thread switch). Receivers dropped here make any in-flight
    /// [`ApprovalBridge::resolve`] observe a closed channel and fail closed.
    pub fn cancel_all(&self) {
        lock(&self.pending).clear();
    }

    /// The number of outstanding approval requests.
    #[allow(dead_code)] // queue-badge surface; exercised by the bridge tests
    pub fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }

    /// Outstanding approval ids (test + badge surfaces).
    #[allow(dead_code)] // queue-badge surface; exercised by the bridge tests
    pub fn pending_ids(&self) -> Vec<String> {
        lock(&self.pending).keys().cloned().collect()
    }

    /// Clear the session allow-list (e.g. on stop).
    pub fn reset_session(&self) {
        lock(&self.session_allow).clear();
    }

    /// Register a gated request and publish the ask verdict. Shared by the
    /// automation and tool paths; `details` must already carry the
    /// kind-specific fields (the approval id and tool call id are injected
    /// here).
    fn ask(
        &self,
        call: &ToolCall,
        summary: &str,
        mut details: serde_json::Value,
    ) -> ApprovalVerdict {
        let approval_id = aiden_data::chat_store::new_uuid_like();
        details["approvalId"] = serde_json::Value::String(approval_id.clone());
        details["toolCallId"] = serde_json::Value::String(call.id.clone());
        details["toolName"] = serde_json::Value::String(call.name.clone());
        details["summary"] = serde_json::Value::String(summary.to_string());
        let (tx, rx) = mpsc::channel(1);
        let mut pending = lock(&self.pending);
        pending.insert(
            approval_id.clone(),
            Pending {
                tool_name: call.name.clone(),
                tx,
                rx: Some(rx),
            },
        );
        ApprovalVerdict::Ask(ApprovalRequest {
            approval_id,
            tool_name: call.name.clone(),
            summary: summary.to_string(),
            details,
        })
    }
}

/// Lock a shared mutex, tolerating a poisoned guard (the critical sections are
/// short and never panic).
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[async_trait]
impl aiden_agent::ApprovalPolicy for ApprovalBridge {
    fn evaluate(&self, call: &ToolCall) -> ApprovalVerdict {
        if self.is_session_allowed(&call.name) {
            return ApprovalVerdict::Allow;
        }
        if is_automation_tool(&call.name) {
            let now = aiden_data::now_millis();
            let summary = if call.name == "schedule_task" {
                "Create automation".to_string()
            } else {
                "Edit automation".to_string()
            };
            let details = automation_approval_details(call, now)
                .unwrap_or_else(|| serde_json::json!({ "kind": AUTOMATION_DETAILS_KIND }));
            return self.ask(call, &summary, details);
        }
        if APPROVAL_TOOL_NAMES.contains(&call.name.as_str()) {
            let summary = summarize_tool_call(&call.name, &call.arguments);
            return self.ask(call, &summary, tool_approval_details(call));
        }
        ApprovalVerdict::Allow
    }

    async fn resolve(&self, approval_id: &str) -> Result<(), String> {
        // Take the receiver (one-shot) while leaving the entry in the map so a
        // concurrent `decide` can still deliver; the entry is removed once the
        // decision lands (or the channel closes).
        let receiver = {
            let mut pending = lock(&self.pending);
            let Some(entry) = pending.get_mut(approval_id) else {
                return Err("approval request is no longer pending".to_string());
            };
            entry.rx.take()
        };
        let Some(mut receiver) = receiver else {
            return Err("approval request is no longer pending".to_string());
        };
        let outcome = match receiver.recv().await {
            Some(ApprovalDecision::AllowOnce | ApprovalDecision::AllowSession) => Ok(()),
            Some(ApprovalDecision::Deny) => Err("The tool call was denied.".to_string()),
            None => Err("The approval request was cancelled.".to_string()),
        };
        lock(&self.pending).remove(approval_id);
        outcome
    }
}

/// Renderer-safe details for a mutating coding-tool approval. The `risk` badge
/// classifies the call; `arguments` previews the exact JSON payload.
pub fn tool_approval_details(call: &ToolCall) -> serde_json::Value {
    serde_json::json!({
        "kind": TOOL_DETAILS_KIND,
        "arguments": call.arguments,
        "risk": "mutating",
    })
}

/// Renderer-safe details for an automation proposal (`schedule_task` /
/// `edit_automation`). Returns `None` when the call does not carry a valid
/// proposal shape (name/cron are required) — such a request renders the
/// fail-closed invalid card and can never be confirmed. `now` drives the
/// `nextRunAt` computation so tests are deterministic.
pub fn automation_approval_details(call: &ToolCall, now: u64) -> Option<serde_json::Value> {
    let args = call.arguments.as_object()?;
    let action = if call.name == "schedule_task" {
        "create"
    } else if call.name == "edit_automation" {
        "edit"
    } else {
        return None;
    };
    let name = args.get("name")?.as_str()?.to_string();
    let cron = args.get("cron")?.as_str()?.to_string();
    let timezone = args
        .get("timezone")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("UTC")
        .to_string();
    let permission = match args.get("permission").and_then(serde_json::Value::as_str) {
        Some("full") => "full",
        _ => "read-only",
    };
    let workspace_id = args.get("workspaceId").and_then(serde_json::Value::as_str);
    let workspace_name = args
        .get("workspaceName")
        .and_then(serde_json::Value::as_str);
    let mcp_server_ids: Vec<String> = args
        .get("mcpServerIds")
        .and_then(serde_json::Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mcp_server_names: Vec<String> = args
        .get("mcpServerNames")
        .and_then(serde_json::Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let provider_id = args
        .get("providerId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let model = args
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let prompt = args
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let enabled = args.get("enabled").and_then(serde_json::Value::as_bool);
    let task_id = args.get("taskId").and_then(serde_json::Value::as_str);
    let next_run_at = aiden_data::schedule_store::next_scheduled_run(&cron, &timezone, now).ok();

    Some(serde_json::json!({
        "kind": AUTOMATION_DETAILS_KIND,
        "action": action,
        "name": name,
        "prompt": prompt,
        "cron": cron,
        "timezone": timezone,
        "nextRunAt": next_run_at,
        "permission": permission,
        "workspaceId": workspace_id,
        "workspaceName": workspace_name,
        "mcpServerIds": mcp_server_ids,
        "mcpServerNames": mcp_server_names,
        "providerId": provider_id,
        "providerName": provider_id,
        "model": model,
        "modelName": model,
        "enabled": enabled,
        "taskId": task_id,
        "notify": true,
        "mode": "llm",
        "schedulerEnabled": true,
    }))
}

/// A human "schedule" label for the automation card, mirroring the renderer's
/// `formatSchedule` intent: "Every day at 9:00 AM" style. Falls back to the
/// raw cron when the expression is unparseable (or not a plain daily schedule).
pub fn format_schedule(cron: &str, timezone: &str, next_run_at: Option<u64>) -> String {
    let parts: Vec<&str> = cron.split_whitespace().collect();
    if parts.len() == 5 {
        let minute = parts[0];
        let hour = parts[1];
        let dom = parts[2];
        let month = parts[3];
        let dow = parts[4];
        if minute == "0" && hour.parse::<u32>().is_ok() && dom == "*" && month == "*" && dow == "*"
        {
            let hour: u32 = hour.parse().unwrap_or(0);
            let (display, suffix) = match hour % 12 {
                0 => (12, "AM"),
                h if hour < 12 => (h, "AM"),
                h => (h, "PM"),
            };
            return format!("Every day at {display}:00 {suffix}");
        }
    }
    let _ = timezone;
    let _ = next_run_at;
    format!("Cron {cron}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_agent::ApprovalPolicy;

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call-1".to_string(),
            name: name.to_string(),
            arguments: args,
            thought_signature: None,
        }
    }

    #[test]
    fn automation_tools_are_recognized() {
        assert!(is_automation_tool("schedule_task"));
        assert!(is_automation_tool("edit_automation"));
        assert!(!is_automation_tool("list_scheduled_tasks"));
        assert!(!is_automation_tool("read_file"));
    }

    #[test]
    fn gated_set_is_automation_plus_the_mutating_coding_tools() {
        assert!(bridge_requires_approval("schedule_task"));
        assert!(bridge_requires_approval("edit_automation"));
        assert!(bridge_requires_approval("write_file"));
        assert!(bridge_requires_approval("run_command"));
        assert!(!bridge_requires_approval("read_file"));
        assert!(!bridge_requires_approval("grep"));
        assert!(!bridge_requires_approval("mcp_Linear__search_issues_abc"));
    }

    #[test]
    fn evaluate_asks_with_embedded_approval_id_and_allows_read_only_tools() {
        let bridge = ApprovalBridge::new();
        let verdict = bridge.evaluate(&call(
            "schedule_task",
            serde_json::json!({
                "name": "Morning brief",
                "cron": "0 9 * * *",
                "timezone": "UTC",
                "prompt": "Summarize updates",
            }),
        ));
        let ApprovalVerdict::Ask(request) = verdict else {
            panic!("expected ask verdict");
        };
        assert_eq!(request.tool_name, "schedule_task");
        assert!(request.details["approvalId"].is_string());
        assert_eq!(request.details["kind"], "assistant-automation");
        assert_eq!(request.details["permission"], "read-only");
        assert_eq!(bridge.pending_count(), 1);
        assert_eq!(
            bridge.evaluate(&call("read_file", serde_json::json!({ "path": "x" }))),
            ApprovalVerdict::Allow
        );
    }

    #[tokio::test]
    async fn resolve_once_and_second_decide_is_a_no_op() {
        let bridge = ApprovalBridge::new();
        let _ = bridge.evaluate(&call("write_file", serde_json::json!({ "path": "x" })));
        let approval_id = bridge.pending_ids()[0].clone();
        assert!(bridge.decide(&approval_id, ApprovalDecision::AllowOnce));
        // The entry stays until the runner resolves the decision.
        assert_eq!(bridge.pending_count(), 1);
        // The first decision stands; a second decide on the same id is a no-op.
        assert!(!bridge.decide(&approval_id, ApprovalDecision::Deny));
        assert_eq!(bridge.resolve(&approval_id).await, Ok(()));
        assert_eq!(bridge.pending_count(), 0);
        // A decide after resolution is a no-op.
        assert!(!bridge.decide(&approval_id, ApprovalDecision::AllowOnce));
    }

    #[tokio::test]
    async fn resolve_awaits_the_ui_decision() {
        let bridge = ApprovalBridge::new();
        let _ = bridge.evaluate(&call("run_command", serde_json::json!({ "command": "ls" })));
        let approval_id = bridge.pending_ids()[0].clone();
        let resolve = {
            let bridge = bridge.clone();
            let id = approval_id.clone();
            tokio::spawn(async move { bridge.resolve(&id).await })
        };
        // Let the resolver park on the channel.
        tokio::task::yield_now().await;
        assert!(bridge.decide(&approval_id, ApprovalDecision::AllowOnce));
        assert_eq!(resolve.await.expect("resolver completes"), Ok(()));
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn deny_and_drop_settle_with_the_blocked_and_cancelled_paths() {
        let bridge = ApprovalBridge::new();
        let _ = bridge.evaluate(&call("write_file", serde_json::json!({ "path": "x" })));
        let denied_id = bridge.pending_ids()[0].clone();
        assert!(bridge.decide(&denied_id, ApprovalDecision::Deny));
        let outcome = bridge.resolve(&denied_id).await;
        assert!(outcome.is_err());
        assert!(outcome.unwrap_err().contains("denied"));

        // Cancel-on-drop: cancel_all drops the receivers, so an in-flight
        // resolve observes the closed channel and fails closed.
        let _ = bridge.evaluate(&call("edit_file", serde_json::json!({ "path": "x" })));
        let cancelled_id = bridge.pending_ids()[0].clone();
        let resolve = {
            let bridge = bridge.clone();
            tokio::spawn(async move { bridge.resolve(&cancelled_id).await })
        };
        tokio::task::yield_now().await;
        bridge.cancel_all();
        let outcome = resolve.await.expect("resolver completes");
        assert!(outcome.is_err());
        assert!(outcome.unwrap_err().contains("cancelled"));
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn a_cancelled_resolver_leak_is_cleaned_up_on_the_next_decide() {
        let bridge = ApprovalBridge::new();
        let _ = bridge.evaluate(&call("write_file", serde_json::json!({ "path": "x" })));
        let approval_id = bridge.pending_ids()[0].clone();
        // The runner parks in resolve (taking the receiver), then is cancelled
        // without cancel_all — the stop path that drops the driver task.
        let resolve = {
            let bridge = bridge.clone();
            let id = approval_id.clone();
            tokio::spawn(async move { bridge.resolve(&id).await })
        };
        // Give the resolver time to take the receiver and park on recv.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        resolve.abort();
        // Once the runtime processes the abort the parked receiver is dropped,
        // and the next decide must discover the dead entry and remove it
        // instead of leaving a stale, never-resolvable approval card.
        let mut cleaned = false;
        for _ in 0..100 {
            tokio::task::yield_now().await;
            if !bridge.decide(&approval_id, ApprovalDecision::AllowOnce) {
                cleaned = true;
                break;
            }
        }
        assert!(
            cleaned,
            "the dead entry must be cleaned up once the receiver is dropped"
        );
        assert_eq!(bridge.pending_count(), 0);
        assert_eq!(
            bridge.resolve(&approval_id).await.unwrap_err(),
            "approval request is no longer pending"
        );
    }

    #[tokio::test]
    async fn session_allow_runs_later_calls_without_asking() {
        let bridge = ApprovalBridge::new();
        let _ = bridge.evaluate(&call("run_command", serde_json::json!({ "command": "ls" })));
        let approval_id = bridge.pending_ids()[0].clone();
        assert!(bridge.decide(&approval_id, ApprovalDecision::AllowSession));
        // The first call resolves allowed.
        assert_eq!(bridge.resolve(&approval_id).await, Ok(()));
        // Later calls of the same tool are allowed immediately.
        assert_eq!(
            bridge.evaluate(&call(
                "run_command",
                serde_json::json!({ "command": "pwd" })
            )),
            ApprovalVerdict::Allow
        );
        // A different mutating tool still asks.
        assert!(matches!(
            bridge.evaluate(&call("write_file", serde_json::json!({ "path": "x" }))),
            ApprovalVerdict::Ask(_)
        ));
    }

    #[test]
    fn automation_details_are_renderer_safe_and_fail_closed() {
        let details = automation_approval_details(
            &call(
                "schedule_task",
                serde_json::json!({
                    "name": "Morning brief",
                    "cron": "0 9 * * *",
                    "timezone": "America/New_York",
                    "permission": "full",
                    "workspaceId": "w-1",
                    "mcpServerIds": ["gmail"],
                    "providerId": "local-provider",
                    "model": "local-model",
                    "prompt": "Summarize email.",
                }),
            ),
            1_700_000_000_000,
        )
        .expect("valid proposal");
        assert_eq!(details["kind"], "assistant-automation");
        assert_eq!(details["action"], "create");
        assert_eq!(details["permission"], "full");
        assert_eq!(details["workspaceId"], "w-1");
        assert_eq!(details["mcpServerIds"][0], "gmail");
        // Missing name/cron → None (cannot be confirmed).
        assert!(automation_approval_details(
            &call("schedule_task", serde_json::json!({ "name": "only" })),
            1_700_000_000_000,
        )
        .is_none());
        assert!(automation_approval_details(
            &call("list_projects", serde_json::json!({})),
            1_700_000_000_000,
        )
        .is_none());
    }

    #[test]
    fn edit_automation_details_carry_the_task_id() {
        let details = automation_approval_details(
            &call(
                "edit_automation",
                serde_json::json!({
                    "taskId": "task-1",
                    "name": "Morning brief",
                    "cron": "30 7 * * *",
                    "prompt": "Summarize email.",
                }),
            ),
            1_700_000_000_000,
        )
        .expect("valid edit");
        assert_eq!(details["action"], "edit");
        assert_eq!(details["taskId"], "task-1");
    }

    #[test]
    fn schedule_labels_read_human_time_and_fall_back_to_cron() {
        assert_eq!(
            format_schedule("0 9 * * *", "UTC", None),
            "Every day at 9:00 AM"
        );
        assert_eq!(
            format_schedule("0 0 * * *", "UTC", None),
            "Every day at 12:00 AM"
        );
        assert_eq!(
            format_schedule("0 15 * * *", "UTC", None),
            "Every day at 3:00 PM"
        );
        assert_eq!(format_schedule("0 9 * * 1", "UTC", None), "Cron 0 9 * * 1");
    }
}
