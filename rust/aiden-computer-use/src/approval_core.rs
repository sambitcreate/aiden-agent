//! Cancellation-aware attended approval bridge for Computer Use.
//!
//! There is deliberately no session-wide decision: every mutating action
//! consumes one grant exactly once.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const MAX_APPROVAL_SUMMARY_CHARS: usize = 2_000;
const MAX_TARGET_LABEL_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseApprovalDecision {
    AllowOnce,
    Deny,
}

impl ComputerUseApprovalDecision {
    pub fn label(self) -> &'static str {
        match self {
            Self::AllowOnce => "Allow once",
            Self::Deny => "Deny",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseApprovalRequest {
    pub approval_id: String,
    pub generation_id: String,
    pub tool_call_id: String,
    pub summary: String,
    pub target_pid: u32,
    pub target_window_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub generation_revision: u64,
    pub target_revision: u64,
}

pub struct ComputerUseApprovalFacts<'a> {
    pub generation_id: &'a str,
    pub tool_call_id: &'a str,
    pub summary: &'a str,
    pub target_pid: u32,
    pub target_window_id: u64,
    pub app: Option<&'a str>,
    pub title: Option<&'a str>,
    pub generation_revision: u64,
    pub target_revision: u64,
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseApprovalError {
    #[error("The Computer Use action was denied.")]
    Denied,
    #[error("The Computer Use approval was cancelled.")]
    Cancelled,
}

struct PendingApproval {
    generation_id: String,
    sender: oneshot::Sender<ComputerUseApprovalDecision>,
}

#[derive(Default)]
struct ApprovalShared {
    pending: Mutex<HashMap<String, PendingApproval>>,
}

#[derive(Clone, Default)]
pub struct ComputerUseApprovalGate {
    shared: Arc<ApprovalShared>,
}

pub struct ComputerUseApprovalWaiter {
    approval_id: String,
    receiver: Option<oneshot::Receiver<ComputerUseApprovalDecision>>,
    shared: Weak<ApprovalShared>,
}

impl ComputerUseApprovalGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(
        &self,
        facts: &ComputerUseApprovalFacts<'_>,
    ) -> (ComputerUseApprovalRequest, ComputerUseApprovalWaiter) {
        let approval_id = aiden_data::chat_store::new_uuid_like();
        let (sender, receiver) = oneshot::channel();
        let generation_id = bounded(facts.generation_id, 160);
        self.shared.pending.lock().unwrap().insert(
            approval_id.clone(),
            PendingApproval {
                generation_id: generation_id.clone(),
                sender,
            },
        );
        (
            ComputerUseApprovalRequest {
                approval_id: approval_id.clone(),
                generation_id,
                tool_call_id: bounded(facts.tool_call_id, 256),
                summary: bounded(facts.summary, MAX_APPROVAL_SUMMARY_CHARS),
                target_pid: facts.target_pid,
                target_window_id: facts.target_window_id,
                app: facts
                    .app
                    .map(|value| bounded(value, MAX_TARGET_LABEL_CHARS)),
                title: facts
                    .title
                    .map(|value| bounded(value, MAX_TARGET_LABEL_CHARS)),
                generation_revision: facts.generation_revision,
                target_revision: facts.target_revision,
            },
            ComputerUseApprovalWaiter {
                approval_id,
                receiver: Some(receiver),
                shared: Arc::downgrade(&self.shared),
            },
        )
    }

    pub fn decide(&self, approval_id: &str, decision: ComputerUseApprovalDecision) -> bool {
        self.shared
            .pending
            .lock()
            .unwrap()
            .remove(approval_id)
            .is_some_and(|pending| pending.sender.send(decision).is_ok())
    }

    pub fn cancel_all(&self) {
        self.shared.pending.lock().unwrap().clear();
    }

    pub fn cancel_generation(&self, generation_id: &str) {
        self.shared
            .pending
            .lock()
            .unwrap()
            .retain(|_, pending| pending.generation_id != generation_id);
    }

    pub fn pending_count(&self) -> usize {
        self.shared.pending.lock().unwrap().len()
    }
}

impl ComputerUseApprovalWaiter {
    pub async fn wait(
        mut self,
        cancellation: &CancellationToken,
    ) -> Result<(), ComputerUseApprovalError> {
        let receiver = self.receiver.take().expect("approval waiter consumed once");
        let decision = tokio::select! {
            decision = receiver => decision.ok(),
            _ = cancellation.cancelled() => None,
        };
        self.remove_pending();
        match decision {
            Some(ComputerUseApprovalDecision::AllowOnce) => Ok(()),
            Some(ComputerUseApprovalDecision::Deny) => Err(ComputerUseApprovalError::Denied),
            None => Err(ComputerUseApprovalError::Cancelled),
        }
    }

    fn remove_pending(&self) {
        if let Some(shared) = self.shared.upgrade() {
            shared.pending.lock().unwrap().remove(&self.approval_id);
        }
    }
}

impl Drop for ComputerUseApprovalWaiter {
    fn drop(&mut self) {
        self.remove_pending();
    }
}

fn bounded(value: &str, maximum: usize) -> String {
    value
        .replace(['\0', '\r', '\n'], " ")
        .chars()
        .take(maximum)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin(
        gate: &ComputerUseApprovalGate,
    ) -> (ComputerUseApprovalRequest, ComputerUseApprovalWaiter) {
        gate.begin(&ComputerUseApprovalFacts {
            generation_id: "generation",
            tool_call_id: "tool-call",
            summary: "Click element 2",
            target_pid: 42,
            target_window_id: 7,
            app: Some("Notes"),
            title: Some("Private note"),
            generation_revision: 3,
            target_revision: 9,
        })
    }

    #[tokio::test]
    async fn allow_once_is_one_use_and_duplicates_are_inert() {
        let gate = ComputerUseApprovalGate::new();
        let (request, waiter) = begin(&gate);
        assert!(gate.decide(&request.approval_id, ComputerUseApprovalDecision::AllowOnce));
        assert!(!gate.decide(&request.approval_id, ComputerUseApprovalDecision::AllowOnce));
        assert_eq!(waiter.wait(&CancellationToken::new()).await, Ok(()));
    }

    #[tokio::test]
    async fn cancellation_fails_closed() {
        let gate = ComputerUseApprovalGate::new();
        let (request, waiter) = begin(&gate);
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            waiter.wait(&cancellation).await,
            Err(ComputerUseApprovalError::Cancelled)
        );
        assert!(!gate.decide(&request.approval_id, ComputerUseApprovalDecision::AllowOnce));
    }

    #[test]
    fn renderer_shape_has_no_payload_or_grant() {
        let gate = ComputerUseApprovalGate::new();
        let (request, _waiter) = begin(&gate);
        let value = serde_json::to_value(request).unwrap();
        let object = value.as_object().unwrap();
        for private in [
            "args",
            "arguments",
            "text",
            "value",
            "keys",
            "fingerprint",
            "screenshot",
            "accessibility",
        ] {
            assert!(!object.contains_key(private));
        }
    }
}
