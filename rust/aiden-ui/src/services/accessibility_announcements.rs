//! Pure lifecycle state for VoiceOver announcements.
//!
//! GPUI renders every streamed delta, so announcement decisions must happen
//! only when a lifecycle phase changes. This module has no platform calls and
//! can therefore be tested without a window or an AppKit runtime.

/// Coarse phases that are useful to a screen-reader user. Token and thinking
/// updates intentionally do not appear here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GenerationAnnouncementPhase {
    Running,
    Completed,
    Failed,
}

/// Deduplicates user-visible accessibility lifecycle messages.
#[derive(Debug, Default)]
pub(crate) struct AccessibilityAnnouncementState {
    generation_owner: Option<String>,
    generation_phase: Option<GenerationAnnouncementPhase>,
    approval_key: Option<String>,
}

impl AccessibilityAnnouncementState {
    /// Return one message when a generation enters a new coarse phase.
    pub(crate) fn observe_generation(
        &mut self,
        owner: Option<&str>,
        phase: Option<GenerationAnnouncementPhase>,
    ) -> Option<String> {
        let (Some(owner), Some(phase)) = (owner, phase) else {
            self.generation_owner = None;
            self.generation_phase = None;
            return None;
        };

        if self.generation_owner.as_deref() != Some(owner) {
            self.generation_owner = Some(owner.to_string());
            self.generation_phase = None;
        }
        if self.generation_phase == Some(phase) {
            return None;
        }
        self.generation_phase = Some(phase);
        Some(
            match phase {
                GenerationAnnouncementPhase::Running => "Aiden is generating a response.",
                GenerationAnnouncementPhase::Completed => "Aiden finished generating a response.",
                GenerationAnnouncementPhase::Failed => {
                    "Aiden couldn't finish generating a response."
                }
            }
            .to_string(),
        )
    }

    /// Return one message when a new foreground approval becomes actionable.
    pub(crate) fn observe_approval(
        &mut self,
        owner: Option<&str>,
        approval_id: Option<&str>,
    ) -> Option<String> {
        let next_key = owner
            .zip(approval_id)
            .map(|(owner, approval_id)| format!("{owner}:{approval_id}"));
        if self.approval_key == next_key {
            return None;
        }
        self.approval_key = next_key;
        approval_id.map(|_| "Aiden is waiting for your approval.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_announces_running_once_per_owner() {
        let mut state = AccessibilityAnnouncementState::default();
        let first =
            state.observe_generation(Some("chat-1:1"), Some(GenerationAnnouncementPhase::Running));
        let repeat =
            state.observe_generation(Some("chat-1:1"), Some(GenerationAnnouncementPhase::Running));
        assert_eq!(first.as_deref(), Some("Aiden is generating a response."));
        assert_eq!(repeat, None);
    }

    #[test]
    fn generation_announces_terminal_transition_once() {
        let mut state = AccessibilityAnnouncementState::default();
        state.observe_generation(Some("chat-1:1"), Some(GenerationAnnouncementPhase::Running));
        let terminal = state.observe_generation(
            Some("chat-1:1"),
            Some(GenerationAnnouncementPhase::Completed),
        );
        let repeat = state.observe_generation(
            Some("chat-1:1"),
            Some(GenerationAnnouncementPhase::Completed),
        );
        assert_eq!(
            terminal.as_deref(),
            Some("Aiden finished generating a response.")
        );
        assert_eq!(repeat, None);
    }

    #[test]
    fn a_new_generation_owner_restarts_phase_dedupe() {
        let mut state = AccessibilityAnnouncementState::default();
        state.observe_generation(Some("chat-1:1"), Some(GenerationAnnouncementPhase::Running));
        let next =
            state.observe_generation(Some("chat-1:2"), Some(GenerationAnnouncementPhase::Running));
        assert_eq!(next.as_deref(), Some("Aiden is generating a response."));
    }

    #[test]
    fn clearing_generation_resets_the_owner_without_an_announcement() {
        let mut state = AccessibilityAnnouncementState::default();
        state.observe_generation(Some("chat-1:1"), Some(GenerationAnnouncementPhase::Running));
        assert_eq!(state.observe_generation(None, None), None);
        assert_eq!(
            state
                .observe_generation(Some("chat-1:1"), Some(GenerationAnnouncementPhase::Running),)
                .as_deref(),
            Some("Aiden is generating a response.")
        );
    }

    #[test]
    fn approval_announces_once_per_generation_request() {
        let mut state = AccessibilityAnnouncementState::default();
        let first = state.observe_approval(Some("chat-1:1"), Some("approval-1"));
        let repeat = state.observe_approval(Some("chat-1:1"), Some("approval-1"));
        assert_eq!(
            first.as_deref(),
            Some("Aiden is waiting for your approval.")
        );
        assert_eq!(repeat, None);
    }

    #[test]
    fn replacing_or_clearing_approval_rearms_dedupe() {
        let mut state = AccessibilityAnnouncementState::default();
        state.observe_approval(Some("chat-1:1"), Some("approval-1"));
        assert_eq!(state.observe_approval(Some("chat-1:1"), None), None);
        assert_eq!(
            state
                .observe_approval(Some("chat-1:1"), Some("approval-1"))
                .as_deref(),
            Some("Aiden is waiting for your approval.")
        );
    }
}
