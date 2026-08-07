//! Computer Use gating logic (port of
//! `main/services/computer-use/generation-gate.ts` plus the renderer control
//! functions its tests exercise: `renderer/lib/computer-use-control.ts`).

use std::collections::HashSet;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;

/// A monotonically increasing generation/activation revision. Closing the
/// global gate invalidates every snapshot taken before the close.
#[derive(Debug, Default)]
pub struct ComputerUseGenerationGate {
    revision: u64,
}

impl ComputerUseGenerationGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> u64 {
        self.revision
    }

    pub fn is_current(&self, snapshot: u64) -> bool {
        snapshot == self.revision
    }

    pub fn close(&mut self) {
        self.revision += 1;
    }
}

/// Select stream ids whose entry carries an activated Computer Use controller.
pub fn activated_computer_use_stream_ids(
    entries: impl IntoIterator<Item = (String, Value)>,
) -> Vec<String> {
    entries
        .into_iter()
        .filter(|(_, entry)| entry.get("computerUse").is_some())
        .map(|(stream_id, _)| stream_id)
        .collect()
}

/// A per-chat lease that excludes generation start until released.
#[derive(Debug, Default)]
pub struct ChatComputerUseMutationGate {
    changing: Arc<StdMutex<HashSet<String>>>,
}

/// Held while a chat's Computer Use setting is being changed. Releasing (or
/// dropping) it removes the chat from the mutation set.
pub struct ChatMutationLease {
    chat_id: String,
    active: bool,
    changing: Arc<StdMutex<HashSet<String>>>,
}

impl ChatMutationLease {
    pub fn release(mut self) {
        self.active = false;
        self.changing.lock().unwrap().remove(&self.chat_id);
    }
}

impl Drop for ChatMutationLease {
    fn drop(&mut self) {
        if self.active {
            self.changing.lock().unwrap().remove(&self.chat_id);
        }
    }
}

impl ChatComputerUseMutationGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn try_begin(&mut self, chat_id: &str, busy: bool) -> Option<ChatMutationLease> {
        let mut changing = self.changing.lock().unwrap();
        if busy || changing.contains(chat_id) {
            return None;
        }
        changing.insert(chat_id.to_string());
        Some(ChatMutationLease {
            chat_id: chat_id.to_string(),
            active: true,
            changing: Arc::clone(&self.changing),
        })
    }

    pub fn is_changing(&self, chat_id: &str) -> bool {
        self.changing.lock().unwrap().contains(chat_id)
    }
}

// ===========================================================================
// Renderer control functions (computer-use-control.ts)
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComputerUseControlStateInput {
    pub enabled: bool,
    pub ready: bool,
    pub busy: bool,
}

/// Keep an unavailable control keyboard-reachable while blocking real races.
pub fn computer_use_control_state(input: ComputerUseControlStateInput) -> (bool, bool) {
    (input.busy, !input.enabled && !input.ready)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComposerSubmissionStateInput {
    pub ready: bool,
    pub is_generating: bool,
    pub sending: bool,
    pub permission_saving: bool,
    pub computer_use_saving: bool,
    pub git_operation_busy: bool,
}

/// One gate shared by the Send button and Enter-key submission path.
pub fn composer_submission_allowed(input: ComposerSubmissionStateInput) -> bool {
    input.ready
        && !input.is_generating
        && !input.sending
        && !input.permission_saving
        && !input.computer_use_saving
        && !input.git_operation_busy
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseRefreshEvent {
    Start,
    Succeeded,
    Failed,
}

/// A fresh status always replaces any stale manual-retry error.
pub fn reduce_computer_use_refresh_state(
    _state: (bool, Option<String>),
    event: ComputerUseRefreshEvent,
) -> (bool, Option<String>) {
    match event {
        ComputerUseRefreshEvent::Start => (true, None),
        ComputerUseRefreshEvent::Failed => (false, Some("helper failed".into())),
        ComputerUseRefreshEvent::Succeeded => (false, None),
    }
}

/// Stale cached readiness cannot survive a failed readiness query.
pub fn computer_use_readiness_ready(status_ready: bool, status_failed: bool) -> bool {
    status_ready && !status_failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn stream_map(entries: &[(&str, bool)]) -> HashMap<String, Value> {
        entries
            .iter()
            .map(|(id, has_controller)| {
                (
                    (*id).to_string(),
                    if *has_controller {
                        json!({ "computerUse": { "close": {} } })
                    } else {
                        json!({})
                    },
                )
            })
            .collect()
    }

    #[test]
    fn closing_the_global_gate_invalidates_old_activation_snapshots() {
        let mut gate = ComputerUseGenerationGate::new();
        let before = gate.snapshot();
        assert!(gate.is_current(before));
        gate.close();
        assert!(!gate.is_current(before));
        assert!(gate.is_current(gate.snapshot()));
    }

    #[test]
    fn global_close_selects_only_streams_with_an_activated_controller() {
        let ids = activated_computer_use_stream_ids(stream_map(&[
            ("ordinary", false),
            ("computer", true),
        ]));
        assert_eq!(ids, vec!["computer".to_string()]);
    }

    #[test]
    fn a_per_chat_setting_lease_excludes_generation_start_until_released() {
        let mut gate = ChatComputerUseMutationGate::new();
        let release = gate.try_begin("chat-1", false);
        assert!(release.is_some());
        assert!(gate.is_changing("chat-1"));
        assert!(gate.try_begin("chat-1", false).is_none());
        assert!(gate.try_begin("busy", true).is_none());
        drop(release);
        assert!(!gate.is_changing("chat-1"));
    }

    #[test]
    fn an_unavailable_per_chat_control_remains_keyboard_reachable_and_reports_aria_disabled() {
        assert_eq!(
            computer_use_control_state(ComputerUseControlStateInput {
                enabled: false,
                ready: false,
                busy: false,
            }),
            (false, true)
        );
        assert_eq!(
            computer_use_control_state(ComputerUseControlStateInput {
                enabled: false,
                ready: true,
                busy: true,
            }),
            (true, false)
        );
    }

    #[test]
    fn enter_key_submission_and_the_send_button_share_the_save_gate() {
        let base = ComposerSubmissionStateInput {
            ready: true,
            is_generating: false,
            sending: false,
            permission_saving: false,
            computer_use_saving: false,
            git_operation_busy: false,
        };
        assert!(composer_submission_allowed(base));
        assert!(!composer_submission_allowed(ComposerSubmissionStateInput {
            computer_use_saving: true,
            ..base
        }));
    }

    #[test]
    fn a_fresh_direct_or_background_query_status_clears_a_stale_manual_retry_error() {
        let failed =
            reduce_computer_use_refresh_state((true, None), ComputerUseRefreshEvent::Failed);
        assert_eq!(failed, (false, Some("helper failed".into())));
        let succeeded =
            reduce_computer_use_refresh_state(failed, ComputerUseRefreshEvent::Succeeded);
        assert_eq!(succeeded, (false, None));
    }

    #[test]
    fn a_failed_status_query_overrides_stale_cached_readiness() {
        assert!(computer_use_readiness_ready(true, false));
        assert!(!computer_use_readiness_ready(true, true));
    }
}
