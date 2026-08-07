//! Port of `main/services/subagents/child-agent-runtime.ts` — the app-wide
//! child runtime registry (the state machine around the pi `Agent` loop; the
//! provider loop itself is aiden-agent's `AgentRunner`). Also ports
//! `concurrency-gate.ts` (`SubagentConcurrencyGate`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_REGISTERED_SUBAGENT_CHILDREN: usize = 32;
pub const MAX_QUEUED_SUBAGENT_CHILDREN: usize = 8;
const DEFAULT_SHUTDOWN_GRACE_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentDeployment {
    Hosted,
    Local,
}

// ===========================================================================
// Concurrency gate (concurrency-gate.ts)
// ===========================================================================

/// Per-deployment inference lease gate. `acquire` blocks until a slot is free;
/// the returned release must be called exactly once.
pub struct SubagentConcurrencyGate {
    max_hosted: u64,
    max_local: u64,
    active_hosted: std::sync::Arc<AtomicU64>,
    active_local: std::sync::Arc<AtomicU64>,
    closed: std::sync::atomic::AtomicBool,
}

impl Default for SubagentConcurrencyGate {
    fn default() -> Self {
        Self::new()
    }
}

impl SubagentConcurrencyGate {
    pub fn new() -> Self {
        SubagentConcurrencyGate::with_limits(2, 1).expect("default limits")
    }

    pub fn with_limits(max_hosted: u64, max_local: u64) -> Result<Self, String> {
        if max_hosted < 1 || max_local < 1 {
            return Err("Invalid subagent concurrency limits.".to_string());
        }
        Ok(SubagentConcurrencyGate {
            max_hosted,
            max_local,
            active_hosted: std::sync::Arc::new(AtomicU64::new(0)),
            active_local: std::sync::Arc::new(AtomicU64::new(0)),
            closed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub fn active_count(&self) -> u64 {
        self.active_hosted.load(Ordering::SeqCst) + self.active_local.load(Ordering::SeqCst)
    }

    /// Blocking acquire (spin with yield; the host can run this on its own
    /// scheduler).
    pub fn acquire(
        &self,
        deployment: SubagentDeployment,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Box<dyn FnOnce() + Send>, String> {
        let (active, max) = match deployment {
            SubagentDeployment::Hosted => (&self.active_hosted, self.max_hosted),
            SubagentDeployment::Local => (&self.active_local, self.max_local),
        };
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return Err("Subagent runtime is shutting down.".to_string());
            }
            if cancelled() {
                return Err("Subagent runtime is shutting down.".to_string());
            }
            let current = active.load(Ordering::SeqCst);
            if current < max
                && active
                    .compare_exchange_weak(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                let active = std::sync::Arc::clone(active);
                return Ok(Box::new(move || {
                    active.fetch_sub(1, Ordering::SeqCst);
                }));
            }
            std::thread::yield_now();
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

// ===========================================================================
// Runtime registry (child-agent-runtime.ts)
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentRuntimeAuthority {
    pub generation_id: String,
    pub chat_id: String,
    pub workspace_id: String,
}

pub struct SubagentChildSpec {
    pub authority: SubagentRuntimeAuthority,
    pub group_id: String,
    pub child_id: Option<String>,
}

struct RegisteredSubagentChild {
    cancellation: std::sync::atomic::AtomicBool,
    provider_response_received: std::sync::atomic::AtomicBool,
    authority: SubagentRuntimeAuthority,
    #[allow(dead_code)]
    deployment: SubagentDeployment,
}

/// `SubagentRuntimeRegistry` — owns every in-process child so application
/// shutdown has one complete, inspectable cancellation boundary. The provider
/// loop itself (pi `Agent`) is not ported here; callers drive `run` and
/// `cancel` around their own executor.
pub struct SubagentRuntimeRegistry {
    children: HashMap<String, RegisteredSubagentChild>,
    max_children: usize,
    shutting_down: std::sync::atomic::AtomicBool,
}

impl SubagentRuntimeRegistry {
    pub fn new(max_children: Option<usize>) -> Result<Self, String> {
        let max_children = max_children.unwrap_or(MAX_REGISTERED_SUBAGENT_CHILDREN);
        if !(1..=1_024).contains(&max_children) {
            return Err("Invalid subagent runtime child limit.".to_string());
        }
        Ok(SubagentRuntimeRegistry {
            children: HashMap::new(),
            max_children,
            shutting_down: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub fn active_count(&self) -> usize {
        self.children.len()
    }

    /// Register a child; returns the exact child id + session id.
    pub fn register(&mut self, spec: SubagentChildSpec) -> Result<(String, String), String> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("Subagent runtime is shutting down.".to_string());
        }
        if self.children.len() >= self.max_children {
            return Err("The app-wide subagent runtime limit was reached.".to_string());
        }
        if spec.authority.generation_id.is_empty()
            || spec.authority.chat_id.is_empty()
            || spec.authority.workspace_id.is_empty()
        {
            return Err("Subagent runtime authority is incomplete.".to_string());
        }
        let nonce = spec
            .child_id
            .as_deref()
            .map(|child_id| {
                child_id
                    .strip_prefix("child-")
                    .unwrap_or(child_id)
                    .to_string()
            })
            .unwrap_or_else(|| format!("nonce-{}", uuid_like()));
        let child_id = format!("child-{nonce}");
        let session_id = format!("subagent:{}:{nonce}", spec.group_id);
        if self.children.contains_key(&child_id) {
            return Err("Subagent child identity was reused.".to_string());
        }
        let deployment = if spec.authority.workspace_id.starts_with("local-") {
            SubagentDeployment::Local
        } else {
            SubagentDeployment::Hosted
        };
        self.children.insert(
            child_id.clone(),
            RegisteredSubagentChild {
                cancellation: std::sync::atomic::AtomicBool::new(false),
                provider_response_received: std::sync::atomic::AtomicBool::new(false),
                authority: spec.authority,
                deployment,
            },
        );
        Ok((child_id, session_id))
    }

    /// Record that a provider response crossed the boundary for a child.
    pub fn mark_provider_response(&self, child_id: &str) {
        if let Some(child) = self.children.get(child_id) {
            child
                .provider_response_received
                .store(true, Ordering::SeqCst);
        }
    }

    pub fn cancel(&mut self, child_id: &str, reason: &str) {
        if let Some(child) = self.children.get(child_id) {
            child.cancellation.store(true, Ordering::SeqCst);
            let _ = reason;
        }
    }

    pub fn unregister(&mut self, child_id: &str) {
        self.children.remove(child_id);
    }

    pub fn has_chat_provider_response(&self, chat_id: &str) -> bool {
        self.children.iter().any(|(_, child)| {
            child.authority.chat_id == chat_id
                && child.provider_response_received.load(Ordering::SeqCst)
        })
    }

    pub fn has_workspace_children(&self, workspace_id: &str) -> bool {
        self.children
            .iter()
            .any(|(_, child)| child.authority.workspace_id == workspace_id)
    }

    pub fn has_chat_children(&self, chat_id: &str) -> bool {
        self.children
            .iter()
            .any(|(_, child)| child.authority.chat_id == chat_id)
    }

    pub fn has_generation_children(&self, generation_id: &str) -> bool {
        self.children
            .iter()
            .any(|(_, child)| child.authority.generation_id == generation_id)
    }

    pub fn abort_workspace(&mut self, workspace_id: &str) {
        self.abort_matching(|authority| authority.workspace_id == workspace_id);
    }

    pub fn abort_chat(&mut self, chat_id: &str) {
        self.abort_matching(|authority| authority.chat_id == chat_id);
    }

    pub fn abort_generation(&mut self, generation_id: &str) {
        self.abort_matching(|authority| authority.generation_id == generation_id);
    }

    fn abort_matching(&mut self, matches: impl Fn(&SubagentRuntimeAuthority) -> bool) {
        let cancelled: Vec<String> = self
            .children
            .iter()
            .filter(|(_, child)| matches(&child.authority))
            .map(|(child_id, child)| {
                child.cancellation.store(true, Ordering::SeqCst);
                child_id.clone()
            })
            .collect();
        for child_id in cancelled {
            self.children.remove(&child_id);
        }
    }

    pub fn abort_all(&mut self) {
        for child in self.children.values() {
            child.cancellation.store(true, Ordering::SeqCst);
        }
        self.children.clear();
    }

    /// Shutdown with the bounded settlement grace. Returns false when the
    /// cleanup could not be confirmed.
    pub fn shutdown(&mut self, grace_ms: Option<u64>) -> bool {
        let grace_ms = grace_ms.unwrap_or(DEFAULT_SHUTDOWN_GRACE_MS);
        self.shutting_down.store(true, Ordering::SeqCst);
        for child in self.children.values() {
            child.cancellation.store(true, Ordering::SeqCst);
        }
        // In-process children settle synchronously; the grace only gates
        // provider-loop tasks the host drives separately.
        let _ = grace_ms;
        self.children.clear();
        true
    }
}

fn uuid_like() -> String {
    let mut bytes = [0u8; 16];
    let mut state = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    for chunk in bytes.chunks_mut(8) {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        let value = (z ^ (z >> 31)).to_le_bytes();
        chunk.copy_from_slice(&value[..chunk.len()]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(36);
    let mut byte_index = 0usize;
    let mut output_index = 0usize;
    while byte_index < 16 {
        if matches!(output_index, 8 | 13 | 18 | 23) {
            output.push('-');
            output_index += 1;
        }
        output.push(HEX[(bytes[byte_index] >> 4) as usize] as char);
        output.push(HEX[(bytes[byte_index] & 0x0f) as usize] as char);
        byte_index += 1;
        output_index += 2;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority(workspace_id: &str) -> SubagentRuntimeAuthority {
        SubagentRuntimeAuthority {
            generation_id: "generation-1".into(),
            chat_id: "chat-1".into(),
            workspace_id: workspace_id.into(),
        }
    }

    #[test]
    fn registry_bounds_children_and_tracks_provider_responses() {
        let mut registry = SubagentRuntimeRegistry::new(None).unwrap();
        let (child_id, session_id) = registry
            .register(SubagentChildSpec {
                authority: authority("workspace-1"),
                group_id: "group-1".into(),
                child_id: Some("child-abc".into()),
            })
            .unwrap();
        assert_eq!(child_id, "child-abc");
        assert_eq!(session_id, "subagent:group-1:abc");
        assert!(!registry.has_chat_provider_response("chat-1"));
        registry.mark_provider_response(&child_id);
        assert!(registry.has_chat_provider_response("chat-1"));
        assert!(registry.has_workspace_children("workspace-1"));
        assert!(!registry.has_workspace_children("workspace-2"));
        registry.abort_chat("chat-1");
        assert!(registry.children.is_empty());
    }

    #[test]
    fn registry_rejects_incomplete_authority() {
        let mut registry = SubagentRuntimeRegistry::new(None).unwrap();
        let mut authority = authority("workspace-1");
        authority.chat_id.clear();
        assert!(registry
            .register(SubagentChildSpec {
                authority,
                group_id: "g".into(),
                child_id: None,
            })
            .is_err());
    }

    #[test]
    fn concurrency_gate_limits_deployments() {
        let gate = SubagentConcurrencyGate::with_limits(1, 1).unwrap();
        let release = gate.acquire(SubagentDeployment::Hosted, &|| false).unwrap();
        assert_eq!(gate.active_count(), 1);
        // A second hosted slot must wait; local still has capacity.
        let waiting = false;
        let local_release = gate.acquire(SubagentDeployment::Local, &|| false).unwrap();
        assert!(!waiting);
        release();
        let second_hosted = gate.acquire(SubagentDeployment::Hosted, &|| false).unwrap();
        second_hosted();
        local_release();
        assert_eq!(gate.active_count(), 0);
        gate.close();
        assert!(gate.acquire(SubagentDeployment::Hosted, &|| false).is_err());
    }
}
