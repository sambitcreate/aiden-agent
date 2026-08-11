//! Pure reducer for the GPUI Computer Use settings card.
//!
//! It owns no host and performs no effects. In particular, hydration only
//! copies the durable global flag; a readiness probe or permission request can
//! begin only when an explicit UI handler calls the matching `begin_*` method.

use crate::{ComputerUseStatus, ComputerUseStatusState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseSettingsOperation {
    Toggle,
    Check,
    RequestPermissions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComputerUseSettingsRequest {
    pub revision: u64,
    pub operation: ComputerUseSettingsOperation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseStatusTone {
    Neutral,
    Success,
    Warning,
    Danger,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseStatusPresentation {
    pub label: &'static str,
    pub detail: String,
    pub tone: ComputerUseStatusTone,
}

#[derive(Debug, Clone, Default)]
pub struct ComputerUseSettingsState {
    pub enabled: bool,
    pub status: Option<ComputerUseStatus>,
    pub active: Option<ComputerUseSettingsRequest>,
    pub error: Option<String>,
    revision: u64,
    rollback_enabled: Option<bool>,
}

impl ComputerUseSettingsState {
    /// Inert boot/render hydration. This does not create a request token.
    pub fn hydrate(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Fence an owner that left the Settings surface. Any late completion is
    /// rejected and an optimistic toggle returns to its prior value.
    pub fn cancel_active(&mut self) {
        self.revision = self.revision.saturating_add(1);
        if self
            .active
            .is_some_and(|request| request.operation == ComputerUseSettingsOperation::Toggle)
        {
            self.enabled = self.rollback_enabled.unwrap_or(self.enabled);
        }
        self.active = None;
        self.rollback_enabled = None;
    }

    pub fn begin_toggle(&mut self, enabled: bool) -> Option<ComputerUseSettingsRequest> {
        if self.active.is_some() {
            return None;
        }
        self.rollback_enabled = Some(self.enabled);
        self.enabled = enabled;
        Some(self.begin(ComputerUseSettingsOperation::Toggle))
    }

    pub fn begin_check(&mut self) -> Option<ComputerUseSettingsRequest> {
        (self.active.is_none()).then(|| self.begin(ComputerUseSettingsOperation::Check))
    }

    pub fn begin_permission_request(&mut self) -> Option<ComputerUseSettingsRequest> {
        if self.active.is_some()
            || !self
                .status
                .as_ref()
                .is_some_and(|status| status.can_request_permissions)
        {
            return None;
        }
        Some(self.begin(ComputerUseSettingsOperation::RequestPermissions))
    }

    pub fn complete(
        &mut self,
        request: ComputerUseSettingsRequest,
        status: ComputerUseStatus,
    ) -> bool {
        if self.active != Some(request) {
            return false;
        }
        self.enabled = status.enabled;
        self.status = Some(status);
        self.active = None;
        self.error = None;
        self.rollback_enabled = None;
        true
    }

    pub fn fail(
        &mut self,
        request: ComputerUseSettingsRequest,
        message: impl Into<String>,
    ) -> bool {
        if self.active != Some(request) {
            return false;
        }
        if request.operation == ComputerUseSettingsOperation::Toggle {
            self.enabled = self.rollback_enabled.unwrap_or(false);
        }
        self.active = None;
        self.error = Some(message.into());
        self.rollback_enabled = None;
        true
    }

    pub fn presentation(&self) -> ComputerUseStatusPresentation {
        if self.active.is_some_and(|request| {
            matches!(
                request.operation,
                ComputerUseSettingsOperation::Check
                    | ComputerUseSettingsOperation::RequestPermissions
            )
        }) {
            return ComputerUseStatusPresentation {
                label: "Checking…",
                detail: "Checking the pinned Computer Use helper without prompting.".into(),
                tone: ComputerUseStatusTone::Neutral,
            };
        }
        if let Some(error) = &self.error {
            return ComputerUseStatusPresentation {
                label: "Check failed",
                detail: error.clone(),
                tone: ComputerUseStatusTone::Danger,
            };
        }
        let Some(status) = &self.status else {
            return ComputerUseStatusPresentation {
                label: "Not checked",
                detail: "Aiden has not started the Computer Use helper in this app session.".into(),
                tone: ComputerUseStatusTone::Neutral,
            };
        };
        let (label, tone) = match status.state {
            ComputerUseStatusState::Ready => ("Ready", ComputerUseStatusTone::Success),
            ComputerUseStatusState::PermissionRequired => {
                ("Permission needed", ComputerUseStatusTone::Warning)
            }
            ComputerUseStatusState::Disabled => ("Off", ComputerUseStatusTone::Neutral),
            ComputerUseStatusState::ProductionBuildRequired
            | ComputerUseStatusState::Unsupported
            | ComputerUseStatusState::Unavailable
            | ComputerUseStatusState::Incompatible
            | ComputerUseStatusState::Error => ("Unavailable", ComputerUseStatusTone::Danger),
        };
        ComputerUseStatusPresentation {
            label,
            detail: status.detail.clone(),
            tone,
        }
    }

    fn begin(&mut self, operation: ComputerUseSettingsOperation) -> ComputerUseSettingsRequest {
        self.revision = self.revision.saturating_add(1);
        let request = ComputerUseSettingsRequest {
            revision: self.revision,
            operation,
        };
        self.active = Some(request);
        self.error = None;
        request
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_core::ComputerUsePermissions;

    fn status(state: ComputerUseStatusState, enabled: bool) -> ComputerUseStatus {
        ComputerUseStatus {
            enabled,
            beta: true,
            state,
            detail: state.as_str().into(),
            ready: state == ComputerUseStatusState::Ready,
            available: matches!(
                state,
                ComputerUseStatusState::Ready | ComputerUseStatusState::PermissionRequired
            ),
            retryable: false,
            can_request_permissions: state == ComputerUseStatusState::PermissionRequired,
            driver_version: None,
            permissions: ComputerUsePermissions {
                accessibility: None,
                screen_recording: None,
            },
        }
    }

    #[test]
    fn hydration_is_inert_and_truthfully_reports_not_checked() {
        let mut state = ComputerUseSettingsState::default();
        state.hydrate(true);

        assert!(state.enabled);
        assert!(state.active.is_none());
        assert!(state.status.is_none());
        assert_eq!(state.presentation().label, "Not checked");
    }

    #[test]
    fn stale_status_completion_cannot_replace_a_newer_request() {
        let mut state = ComputerUseSettingsState::default();
        let first = state.begin_check().unwrap();
        assert!(state.fail(first, "retry"));
        let second = state.begin_check().unwrap();

        assert!(!state.complete(first, status(ComputerUseStatusState::Ready, true)));
        assert!(state.complete(
            second,
            status(ComputerUseStatusState::PermissionRequired, true)
        ));
        assert_eq!(state.presentation().label, "Permission needed");
    }

    #[test]
    fn failed_toggle_rolls_back_optimistic_state() {
        let mut state = ComputerUseSettingsState::default();
        let request = state.begin_toggle(true).unwrap();
        assert!(state.enabled);

        assert!(state.fail(request, "helper mismatch"));
        assert!(!state.enabled);
        assert_eq!(state.presentation().label, "Check failed");
    }

    #[test]
    fn permission_request_requires_an_explicit_permission_required_status() {
        let mut state = ComputerUseSettingsState::default();
        assert!(state.begin_permission_request().is_none());
        state.status = Some(status(ComputerUseStatusState::PermissionRequired, true));
        assert!(state.begin_permission_request().is_some());
        assert!(state.begin_permission_request().is_none());
    }

    #[test]
    fn leaving_settings_fences_completion_and_rolls_back_preview() {
        let mut state = ComputerUseSettingsState::default();
        let request = state.begin_toggle(true).unwrap();
        state.cancel_active();

        assert!(!state.enabled);
        assert!(!state.complete(request, status(ComputerUseStatusState::Ready, true)));
    }
}
