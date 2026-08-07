//! Approval prompt coordinator — port of `main/services/tool-approval.ts`.
//!
//! Owns approval promises and their abort listeners. A decision is one-shot;
//! every settlement path removes the map entry. The [`ToolApprovalCoordinator`]
//! pauses pi's `beforeToolCall` hook until `chat:approve` resolves, exactly as
//! the TS class does for the `llm-client` tool loop.
//!
//! ## Alignment with `aiden-core` approval types
//!
//! The TS `ToolApprovalPrompt.details` carries `ToolApprovalDetails` from
//! `renderer/shared/assistant.ts` — a union of the exact, digest-pinned
//! approval records (`AssistantAutomationApprovalDetails`,
//! `SubagentWorkspaceWriteApprovalDetails`, `SubagentMcpMutationApprovalDetails`,
//! `SubagentShellApprovalDetails`). The matching Rust types live in
//! `aiden-core` (`assistant.rs`), which also validates them via
//! `is_*_approval_details`. This module keeps `details` as an opaque
//! `serde_json::Value` so the coordinator stays dependency-light; the caller
//! (the llm-client glue) serializes one of those aiden-core records into it.
//! **Expiry** is handled by the caller-owned abort signal: an aborted signal
//! settles the request `false` (and, in the real loop, the tool call is
//! blocked). This mirrors the TS, where `AbortSignal` drives the same expiry
//! path.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, Notify};

/// A tiny `AbortSignal` stand-in (the TS `AbortSignal`): one-shot, shared,
/// settable. The coordinator races [`AbortSignal::notified`] against the
/// decision channel.
#[derive(Debug, Clone, Default)]
pub struct AbortSignal {
    aborted: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl AbortSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }

    async fn notified(&self) {
        if self.is_aborted() {
            return;
        }
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_aborted() {
            return;
        }
        notified.as_mut().await;
    }
}

/// The renderer-facing approval prompt (`ToolApprovalPrompt`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolApprovalPrompt {
    pub stream_id: String,
    pub approval_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// The prompt without the coordinator-assigned `approval_id`
/// (`Omit<ToolApprovalPrompt, "approvalId">`).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolApprovalDescriptor {
    pub stream_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub summary: String,
    pub details: Option<serde_json::Value>,
}

impl ToolApprovalDescriptor {
    pub fn new(
        stream_id: impl Into<String>,
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            stream_id: stream_id.into(),
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            summary: summary.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

/// The publisher callback: `sendGeneration(...) -> bool`. Returning `false`
/// means the generation's renderer document is no longer active, which settles
/// the request `false` (the TS throws there and `finish(false)` runs).
pub type ToolApprovalPublisher = Arc<dyn Fn(&ToolApprovalPrompt) -> bool + Send + Sync>;

struct PendingApproval {
    stream_id: String,
    owner_document_id: Option<String>,
    settle: mpsc::Sender<bool>,
}

/// `ToolApprovalCoordinator` — pauses a tool call until a human decision.
///
/// A decision is one-shot: `decide`, stream cancellation, shutdown, and the
/// abort signal all settle exactly once; the map entry and any notify
/// subscription are removed on the first settlement.
#[derive(Clone)]
pub struct ToolApprovalCoordinator {
    publish: ToolApprovalPublisher,
    pending: Arc<std::sync::Mutex<HashMap<String, PendingApproval>>>,
}

/// One outstanding approval request. The prompt was already published when
/// this handle is created; [`PendingApprovalRequest::wait`] races the decision
/// channel against the abort signal (the TS `Promise`).
#[must_use = "an approval request resolves only when awaited"]
pub struct PendingApprovalRequest {
    approval_id: String,
    pending: Arc<std::sync::Mutex<HashMap<String, PendingApproval>>>,
    rx: mpsc::Receiver<bool>,
    signal: Option<AbortSignal>,
}

impl PendingApprovalRequest {
    fn settled(allowed: bool) -> Self {
        let (settle_tx, rx) = mpsc::channel(1);
        let _ = settle_tx.try_send(allowed);
        Self {
            approval_id: String::new(),
            pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
            rx,
            signal: None,
        }
    }

    pub fn approval_id(&self) -> &str {
        &self.approval_id
    }

    /// Resolve the decision. One-shot: `decide`/`cancel_stream`/`shutdown`
    /// settle exactly once via the channel; the map entry is removed here on
    /// the abort path (other settlement paths remove it when they settle).
    pub async fn wait(mut self) -> bool {
        let outcome = if let Some(signal) = &self.signal {
            tokio::select! {
                biased;
                decision = self.rx.recv() => decision.unwrap_or(false),
                _ = signal.notified() => false,
            }
        } else {
            self.rx.recv().await.unwrap_or(false)
        };
        self.pending.lock().unwrap().remove(&self.approval_id);
        outcome
    }
}

impl ToolApprovalCoordinator {
    pub fn new(publish: ToolApprovalPublisher) -> Self {
        Self {
            publish,
            pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Publish a prompt synchronously (matching the TS, where `request()` runs
    /// through the publish before returning its promise) and return a handle
    /// whose [`PendingApprovalRequest::wait`] resolves with the decision. An
    /// already-aborted signal resolves `false` without publishing anything.
    pub fn request(
        &self,
        descriptor: &ToolApprovalDescriptor,
        signal: Option<&AbortSignal>,
        owner_document_id: Option<&str>,
    ) -> PendingApprovalRequest {
        if signal.is_some_and(AbortSignal::is_aborted) {
            return PendingApprovalRequest::settled(false);
        }
        let approval_id = format!("a-{}", new_uuid_like());
        let (settle_tx, settle_rx) = mpsc::channel(1);
        self.pending.lock().unwrap().insert(
            approval_id.clone(),
            PendingApproval {
                stream_id: descriptor.stream_id.clone(),
                owner_document_id: owner_document_id.map(str::to_string),
                settle: settle_tx,
            },
        );
        let prompt = ToolApprovalPrompt {
            stream_id: descriptor.stream_id.clone(),
            approval_id: approval_id.clone(),
            tool_call_id: descriptor.tool_call_id.clone(),
            tool_name: descriptor.tool_name.clone(),
            summary: descriptor.summary.clone(),
            details: descriptor.details.clone(),
        };
        // The TS catches a throwing publisher into `finish(false)`; a `false`
        // return means the same thing.
        if !(self.publish)(&prompt) {
            self.remove_and_settle(&approval_id, false);
            return PendingApprovalRequest::settled(false);
        }
        PendingApprovalRequest {
            approval_id,
            pending: self.pending.clone(),
            rx: settle_rx,
            signal: signal.cloned(),
        }
    }

    fn remove_and_settle(&self, approval_id: &str, allowed: bool) {
        let entry = self.pending.lock().unwrap().remove(approval_id);
        if let Some(entry) = entry {
            let _ = entry.settle.try_send(allowed);
        }
    }

    /// Resolve a pending request from the UI. Returns `false` when the id is
    /// unknown or the caller is not the owning renderer document.
    pub fn decide(
        &self,
        approval_id: &str,
        allowed: bool,
        owner_document_id: Option<&str>,
    ) -> bool {
        let entry = {
            let mut pending = self.pending.lock().unwrap();
            let entry = pending.get(approval_id);
            let owns =
                entry.is_some_and(|entry| entry.owner_document_id.as_deref() == owner_document_id);
            if !owns {
                return false;
            }
            pending.remove(approval_id)
        };
        if let Some(entry) = entry {
            let _ = entry.settle.try_send(allowed);
        }
        true
    }

    /// Settle every pending request of one stream with `false`.
    pub fn cancel_stream(&self, stream_id: &str) {
        let ids: Vec<String> = {
            let pending = self.pending.lock().unwrap();
            pending
                .iter()
                .filter(|(_, entry)| entry.stream_id == stream_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in ids {
            self.remove_and_settle(&id, false);
        }
    }

    /// Settle every pending request with `false` (app shutdown).
    pub fn shutdown(&self) {
        let ids: Vec<String> = {
            let pending = self.pending.lock().unwrap();
            pending.keys().cloned().collect()
        };
        for id in ids {
            self.remove_and_settle(&id, false);
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

fn new_uuid_like() -> String {
    static RNG_STATE: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);
    let mut bytes = [0u8; 16];
    let mut state = RNG_STATE.load(Ordering::Relaxed);
    for byte in bytes.iter_mut() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *byte = (state >> 33) as u8;
    }
    RNG_STATE.store(state, Ordering::Relaxed);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinator() -> (
        ToolApprovalCoordinator,
        Arc<std::sync::Mutex<Vec<ToolApprovalPrompt>>>,
    ) {
        let prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = prompts.clone();
        let coordinator = ToolApprovalCoordinator::new(Arc::new(move |prompt| {
            captured.lock().unwrap().push(prompt.clone());
            true
        }));
        (coordinator, prompts)
    }

    #[tokio::test]
    async fn approval_decisions_are_one_shot_and_remove_pending_state() {
        let (approvals, prompts) = coordinator();
        let signal = AbortSignal::new();
        let descriptor =
            ToolApprovalDescriptor::new("stream", "call-one", "computer_use", "click element 0");
        let pending = approvals.request(&descriptor, Some(&signal), None);
        assert_eq!(approvals.pending_count(), 1);
        let approval_id = prompts.lock().unwrap().first().unwrap().approval_id.clone();
        assert!(approvals.decide(&approval_id, true, None));
        assert!(pending.wait().await);
        assert_eq!(approvals.pending_count(), 0);
        // A second decision is a no-op.
        assert!(!approvals.decide(&approval_id, true, None));
    }

    #[tokio::test]
    async fn deny_abort_stream_cancellation_and_shutdown_leave_no_pending_state() {
        let (approvals, prompts) = coordinator();
        {
            let descriptor =
                ToolApprovalDescriptor::new("deny", "call-deny", "write_file", "write");
            let denied = approvals.request(&descriptor, None, None);
            let approval_id = prompts.lock().unwrap().last().unwrap().approval_id.clone();
            assert!(approvals.decide(&approval_id, false, None));
            assert!(!denied.wait().await);
        }
        {
            let signal = AbortSignal::new();
            let descriptor =
                ToolApprovalDescriptor::new("abort", "call-abort", "computer_use", "type");
            let aborted = approvals.request(&descriptor, Some(&signal), None);
            signal.abort();
            assert!(!aborted.wait().await);
        }
        {
            let descriptor =
                ToolApprovalDescriptor::new("cancel", "call-cancel", "edit_file", "edit");
            let cancelled = approvals.request(&descriptor, None, None);
            approvals.cancel_stream("cancel");
            assert!(!cancelled.wait().await);
        }
        {
            let descriptor =
                ToolApprovalDescriptor::new("shutdown", "call-shutdown", "run_command", "run");
            let shutdown = approvals.request(&descriptor, None, None);
            approvals.shutdown();
            assert!(!shutdown.wait().await);
        }
        assert_eq!(approvals.pending_count(), 0);
    }

    #[tokio::test]
    async fn an_already_aborted_request_publishes_nothing() {
        let (approvals, prompts) = coordinator();
        let signal = AbortSignal::new();
        signal.abort();
        let descriptor =
            ToolApprovalDescriptor::new("stream", "call-aborted", "computer_use", "click");
        assert!(
            !approvals
                .request(&descriptor, Some(&signal), None)
                .wait()
                .await
        );
        assert_eq!(prompts.lock().unwrap().len(), 0);
        assert_eq!(approvals.pending_count(), 0);
    }

    #[tokio::test]
    async fn only_the_renderer_document_that_received_a_prompt_can_decide_it() {
        let (approvals, prompts) = coordinator();
        let descriptor =
            ToolApprovalDescriptor::new("stream", "call-owned", "computer_use", "click");
        let pending = approvals.request(&descriptor, None, Some("document-one"));
        let approval_id = prompts.lock().unwrap()[0].approval_id.clone();
        assert!(!approvals.decide(&approval_id, true, Some("document-two")));
        assert_eq!(approvals.pending_count(), 1);
        assert!(approvals.decide(&approval_id, true, Some("document-one")));
        assert!(pending.wait().await);
    }

    #[tokio::test]
    async fn a_failing_publisher_settles_the_request_false() {
        let coordinator = ToolApprovalCoordinator::new(Arc::new(|_| false));
        let descriptor = ToolApprovalDescriptor::new("stream", "call-x", "write_file", "write");
        let allowed = coordinator.request(&descriptor, None, None).wait().await;
        assert!(!allowed);
        assert_eq!(coordinator.pending_count(), 0);
    }

    #[tokio::test]
    async fn abort_during_wait_resolves_false_and_clears_the_entry() {
        let (approvals, prompts) = coordinator();
        let signal = AbortSignal::new();
        let descriptor = ToolApprovalDescriptor::new("stream", "call-wait", "grep", "search");
        let pending = approvals.request(&descriptor, Some(&signal), None);
        assert_eq!(prompts.lock().unwrap().len(), 1);
        signal.abort();
        assert!(!pending.wait().await);
        assert_eq!(approvals.pending_count(), 0);
        // The published prompt cannot be decided afterwards.
        let approval_id = prompts.lock().unwrap()[0].approval_id.clone();
        assert!(!approvals.decide(&approval_id, true, None));
    }
}
