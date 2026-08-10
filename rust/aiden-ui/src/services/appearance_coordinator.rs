//! Entity-ready appearance transaction state.
//!
//! This module intentionally performs no GPUI, filesystem, or native work.
//! [`ChatService`](crate::services::chat_service::ChatService) owns this value
//! and executes returned operations off the foreground executor. Monotonic
//! revisions ensure stale save/native completions cannot displace the newest
//! preview.

use aiden_core::appearance::{AppearanceConfig, DockIcon, Mode};
use aiden_core::appearance_preview::AppearancePreviewState;

/// Monotonic intent/operation revision.
pub type AppearanceRevision = u64;

/// A concrete persistence operation for an external executor.
#[derive(Debug, Clone, PartialEq)]
pub struct AppearanceSaveOperation {
    pub revision: AppearanceRevision,
    pub appearance: AppearanceConfig,
}

/// Native appearance fields that need an OS service rather than JSON alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeAppearanceIntent {
    pub mode: Mode,
    pub dock_icon: DockIcon,
}

impl From<&AppearanceConfig> for NativeAppearanceIntent {
    fn from(value: &AppearanceConfig) -> Self {
        Self {
            mode: value.mode,
            dock_icon: value.dock_icon,
        }
    }
}

/// A concrete native operation for an external executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeAppearanceOperation {
    pub revision: AppearanceRevision,
    pub intent: NativeAppearanceIntent,
}

/// Operation class attached to visible failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppearanceOperationKind {
    Save,
    NativeApply,
}

/// Typed, user-visible failure retained until retry or a newer intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppearanceFailure {
    pub operation: AppearanceOperationKind,
    pub message: String,
    pub retryable: bool,
}

impl AppearanceFailure {
    pub fn retryable(operation: AppearanceOperationKind, message: impl Into<String>) -> Self {
        Self {
            operation,
            message: message.into(),
            retryable: true,
        }
    }
}

/// Persistence status exposed to Settings.
#[derive(Debug, Clone, PartialEq)]
pub enum AppearanceSaveState {
    Clean,
    Dirty,
    Saving(AppearanceSaveOperation),
    Failed {
        operation: AppearanceSaveOperation,
        failure: AppearanceFailure,
    },
}

/// Native application status exposed to Settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeAppearanceState {
    Idle,
    Applying(NativeAppearanceOperation),
    Applied(NativeAppearanceOperation),
    Failed {
        operation: NativeAppearanceOperation,
        failure: AppearanceFailure,
    },
}

/// Whether an asynchronous completion was current or rejected as stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionDisposition {
    Applied,
    Stale,
}

/// Single-authority state ready to be held by a GPUI `Entity`.
pub struct AppearanceCoordinator {
    persisted: AppearanceConfig,
    effective: AppearanceConfig,
    preview: AppearancePreviewState,
    revision: AppearanceRevision,
    save_state: AppearanceSaveState,
    native_state: NativeAppearanceState,
    // Keep a failed full intent while rendering the last confirmed appearance.
    // Retrying native mode/Dock must not discard unrelated configuration edits.
    failed_native_appearance: Option<AppearanceConfig>,
}

impl AppearanceCoordinator {
    pub fn new(persisted: AppearanceConfig) -> Self {
        Self {
            effective: persisted.clone(),
            persisted,
            preview: AppearancePreviewState::default(),
            revision: 0,
            save_state: AppearanceSaveState::Clean,
            native_state: NativeAppearanceState::Idle,
            failed_native_appearance: None,
        }
    }

    pub fn persisted(&self) -> &AppearanceConfig {
        &self.persisted
    }

    pub fn effective(&self) -> &AppearanceConfig {
        &self.effective
    }

    /// Full user intent used as the base for subsequent Settings edits. A
    /// native failure keeps rendering `effective` (the confirmed snapshot),
    /// while edits continue from the retained failed configuration so a
    /// non-native tweak cannot silently discard its mode or Dock choice.
    pub fn editing(&self) -> &AppearanceConfig {
        self.failed_native_appearance
            .as_ref()
            .unwrap_or(&self.effective)
    }

    pub fn revision(&self) -> AppearanceRevision {
        self.revision
    }

    pub fn save_state(&self) -> &AppearanceSaveState {
        &self.save_state
    }

    pub fn native_state(&self) -> &NativeAppearanceState {
        &self.native_state
    }

    /// Make a safe preview immediately authoritative. No persistence or native
    /// operation is performed here.
    pub fn preview(&mut self, appearance: AppearanceConfig) -> AppearanceRevision {
        let revision = self.next_revision();
        self.effective = self.preview.preview(appearance);
        self.save_state = AppearanceSaveState::Dirty;
        self.failed_native_appearance = None;
        if matches!(self.native_state, NativeAppearanceState::Applying(_)) {
            self.native_state = NativeAppearanceState::Idle;
        }
        revision
    }

    /// Create the newest persistence operation. Calling this again fences the
    /// previous operation even when it later completes successfully.
    pub fn begin_save(&mut self) -> AppearanceSaveOperation {
        let operation = AppearanceSaveOperation {
            revision: self.next_revision(),
            appearance: self.effective.clone(),
        };
        self.save_state = AppearanceSaveState::Saving(operation.clone());
        operation
    }

    /// Complete only the currently active save operation.
    pub fn complete_save(
        &mut self,
        revision: AppearanceRevision,
        result: Result<(), AppearanceFailure>,
    ) -> CompletionDisposition {
        let AppearanceSaveState::Saving(operation) = &self.save_state else {
            return CompletionDisposition::Stale;
        };
        if operation.revision != revision {
            return CompletionDisposition::Stale;
        }
        let operation = operation.clone();
        match result {
            Ok(()) => {
                self.persisted = operation.appearance.clone();
                self.effective = self.preview.persisted(&operation.appearance);
                self.save_state = if self.effective == self.persisted {
                    AppearanceSaveState::Clean
                } else {
                    AppearanceSaveState::Dirty
                };
            }
            Err(failure) => {
                self.save_state = AppearanceSaveState::Failed {
                    operation,
                    failure: normalize_failure(failure, AppearanceOperationKind::Save),
                };
            }
        }
        CompletionDisposition::Applied
    }

    /// Retry a visible failed save using the still-authoritative effective
    /// preview. Returns `None` when there is no retryable save failure.
    pub fn retry_save(&mut self) -> Option<AppearanceSaveOperation> {
        let retryable = matches!(
            &self.save_state,
            AppearanceSaveState::Failed { failure, .. } if failure.retryable
        );
        retryable.then(|| self.begin_save())
    }

    pub fn begin_native_apply(&mut self) -> NativeAppearanceOperation {
        let operation = NativeAppearanceOperation {
            revision: self.next_revision(),
            intent: NativeAppearanceIntent::from(&self.effective),
        };
        self.native_state = NativeAppearanceState::Applying(operation);
        operation
    }

    pub fn complete_native_apply(
        &mut self,
        revision: AppearanceRevision,
        result: Result<(), AppearanceFailure>,
    ) -> CompletionDisposition {
        let NativeAppearanceState::Applying(operation) = self.native_state else {
            return CompletionDisposition::Stale;
        };
        if operation.revision != revision {
            return CompletionDisposition::Stale;
        }
        self.native_state = match result {
            Ok(()) => {
                if let Some(appearance) = self.failed_native_appearance.take() {
                    self.effective = self.preview.preview(appearance);
                    self.save_state = AppearanceSaveState::Dirty;
                }
                NativeAppearanceState::Applied(operation)
            }
            Err(failure) => {
                // Native rejection means the preview could not become the
                // system appearance. Roll back the shared effective value and
                // fence any save prepared for the rejected preview.
                self.failed_native_appearance = Some(self.effective.clone());
                self.preview = AppearancePreviewState::default();
                self.effective = self.persisted.clone();
                self.save_state = AppearanceSaveState::Clean;
                NativeAppearanceState::Failed {
                    operation,
                    failure: normalize_failure(failure, AppearanceOperationKind::NativeApply),
                }
            }
        };
        CompletionDisposition::Applied
    }

    pub fn retry_native_apply(&mut self) -> Option<NativeAppearanceOperation> {
        let retryable = matches!(
            &self.native_state,
            NativeAppearanceState::Failed { failure, .. } if failure.retryable
        );
        if !retryable {
            return None;
        }
        let intent = match &self.native_state {
            NativeAppearanceState::Failed { operation, .. } => operation.intent,
            _ => return None,
        };
        let operation = NativeAppearanceOperation {
            revision: self.next_revision(),
            intent,
        };
        self.native_state = NativeAppearanceState::Applying(operation);
        Some(operation)
    }

    fn next_revision(&mut self) -> AppearanceRevision {
        self.revision = self.revision.saturating_add(1);
        self.revision
    }
}

fn normalize_failure(
    mut failure: AppearanceFailure,
    operation: AppearanceOperationKind,
) -> AppearanceFailure {
    failure.operation = operation;
    failure
}

#[cfg(test)]
mod tests {
    use aiden_core::appearance::{create_default_appearance_config, DockIcon, Mode};

    use super::*;

    fn failure(kind: AppearanceOperationKind) -> AppearanceFailure {
        AppearanceFailure::retryable(kind, "temporary failure")
    }

    #[test]
    fn stale_save_completion_cannot_replace_newer_preview() {
        let initial = create_default_appearance_config();
        let mut coordinator = AppearanceCoordinator::new(initial.clone());
        let mut first = initial.clone();
        first.mode = Mode::Dark;
        coordinator.preview(first.clone());
        let old = coordinator.begin_save();
        let mut newest = first;
        newest.dock_icon = DockIcon::Monochrome;
        coordinator.preview(newest.clone());

        let disposition = coordinator.complete_save(old.revision, Ok(()));

        assert_eq!(disposition, CompletionDisposition::Stale);
        assert_eq!(coordinator.effective(), &newest);
        assert_eq!(coordinator.persisted(), &initial);
    }

    #[test]
    fn matching_save_clears_only_its_exact_preview() {
        let initial = create_default_appearance_config();
        let mut coordinator = AppearanceCoordinator::new(initial);
        let mut preview = coordinator.effective().clone();
        preview.mode = Mode::Dark;
        coordinator.preview(preview.clone());
        let save = coordinator.begin_save();

        assert_eq!(
            coordinator.complete_save(save.revision, Ok(())),
            CompletionDisposition::Applied
        );
        assert_eq!(coordinator.persisted(), &preview);
        assert_eq!(coordinator.save_state(), &AppearanceSaveState::Clean);
    }

    #[test]
    fn failed_save_remains_visible_and_retry_gets_new_revision() {
        let mut coordinator = AppearanceCoordinator::new(create_default_appearance_config());
        let save = coordinator.begin_save();
        coordinator.complete_save(save.revision, Err(failure(AppearanceOperationKind::Save)));

        let retry = coordinator.retry_save().unwrap();

        assert!(retry.revision > save.revision);
        assert!(matches!(
            coordinator.save_state(),
            AppearanceSaveState::Saving(current) if current == &retry
        ));
    }

    #[test]
    fn stale_native_completion_cannot_clear_newer_operation() {
        let mut coordinator = AppearanceCoordinator::new(create_default_appearance_config());
        let old = coordinator.begin_native_apply();
        let newest = coordinator.begin_native_apply();

        assert_eq!(
            coordinator.complete_native_apply(old.revision, Ok(())),
            CompletionDisposition::Stale
        );
        assert_eq!(
            coordinator.native_state(),
            &NativeAppearanceState::Applying(newest)
        );
    }

    #[test]
    fn native_failure_is_typed_visible_and_retryable() {
        let mut coordinator = AppearanceCoordinator::new(create_default_appearance_config());
        let operation = coordinator.begin_native_apply();
        coordinator.complete_native_apply(
            operation.revision,
            Err(failure(AppearanceOperationKind::NativeApply)),
        );

        let retry = coordinator.retry_native_apply().unwrap();

        assert!(retry.revision > operation.revision);
        assert_eq!(retry.intent, operation.intent);
    }

    #[test]
    fn native_failure_rolls_effective_preview_back_to_persisted() {
        let initial = create_default_appearance_config();
        let mut coordinator = AppearanceCoordinator::new(initial.clone());
        let mut preview = initial.clone();
        preview.mode = Mode::Dark;
        coordinator.preview(preview);
        let operation = coordinator.begin_native_apply();

        coordinator.complete_native_apply(
            operation.revision,
            Err(failure(AppearanceOperationKind::NativeApply)),
        );

        assert_eq!(coordinator.effective(), &initial);
        assert_eq!(coordinator.save_state(), &AppearanceSaveState::Clean);
    }

    #[test]
    fn native_retry_restores_full_failed_intent_only_after_native_success() {
        let initial = create_default_appearance_config();
        let mut coordinator = AppearanceCoordinator::new(initial.clone());
        let mut attempted = initial.clone();
        attempted.mode = Mode::Dark;
        attempted.dock_icon = DockIcon::Monochrome;
        attempted.ui_font_size = 17;
        coordinator.preview(attempted.clone());
        let operation = coordinator.begin_native_apply();
        coordinator.complete_native_apply(
            operation.revision,
            Err(failure(AppearanceOperationKind::NativeApply)),
        );
        assert_eq!(coordinator.effective(), &initial);

        let retry = coordinator.retry_native_apply().expect("retryable failure");
        coordinator.complete_native_apply(retry.revision, Ok(()));
        assert_eq!(coordinator.effective(), &attempted);
        assert!(matches!(
            coordinator.save_state(),
            AppearanceSaveState::Dirty
        ));
    }

    #[test]
    fn newer_preview_fences_older_native_failure_without_rollback() {
        let initial = create_default_appearance_config();
        let mut coordinator = AppearanceCoordinator::new(initial);
        let mut older = coordinator.effective().clone();
        older.mode = Mode::Dark;
        coordinator.preview(older);
        let operation = coordinator.begin_native_apply();
        let mut newest = coordinator.effective().clone();
        newest.dock_icon = DockIcon::Monochrome;
        coordinator.preview(newest.clone());

        assert_eq!(
            coordinator.complete_native_apply(
                operation.revision,
                Err(failure(AppearanceOperationKind::NativeApply)),
            ),
            CompletionDisposition::Stale
        );
        assert_eq!(coordinator.effective(), &newest);
    }

    #[test]
    fn edit_after_native_failure_merges_with_failed_full_intent() {
        let initial = create_default_appearance_config();
        let mut attempted = initial.clone();
        attempted.mode = Mode::Dark;
        attempted.dock_icon = DockIcon::Monochrome;
        attempted.ui_font_size = 16;
        let mut coordinator = AppearanceCoordinator::new(initial.clone());
        coordinator.preview(attempted.clone());
        let failed = coordinator.begin_native_apply();
        coordinator.complete_native_apply(
            failed.revision,
            Err(failure(AppearanceOperationKind::NativeApply)),
        );

        let mut edited = coordinator.editing().clone();
        edited.ui_font_size = 17;
        coordinator.preview(edited.clone());
        let retry = coordinator.begin_native_apply();

        assert_eq!(retry.intent, NativeAppearanceIntent::from(&attempted));
        assert_eq!(coordinator.effective(), &edited);
    }
}
