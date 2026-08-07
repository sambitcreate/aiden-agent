//! Appearance preview state — port of `main/services/appearance-preview-core.ts`.
//!
//! Owns the newest safe appearance preview until that exact value is
//! persisted. An older save completing after a newer preview must never roll
//! auxiliary windows (onboarding, settings preview) back to the older palette.

use crate::appearance::{AppearanceConfig, AppearancePreviewSnapshot};

/// `AppearancePreviewState` — pending-preview ownership.
#[derive(Debug, Clone, Default)]
pub struct AppearancePreviewState {
    pending: Option<AppearanceConfig>,
}

/// The structural fingerprint the TS computes with `JSON.stringify(config)`.
fn fingerprint(config: &AppearanceConfig) -> String {
    serde_json::to_string(config).unwrap_or_default()
}

impl AppearancePreviewState {
    /// `preview(config)` — record the newest preview and return it.
    pub fn preview(&mut self, config: AppearanceConfig) -> AppearanceConfig {
        self.pending = Some(config.clone());
        config
    }

    /// `effective(persisted)` — the pending preview wins over persisted state.
    pub fn effective(&self, persisted: &AppearanceConfig) -> AppearanceConfig {
        self.pending.clone().unwrap_or_else(|| persisted.clone())
    }

    /// `snapshot(persisted)` — the appearance auxiliary windows must render.
    pub fn snapshot(&self, persisted: &AppearanceConfig) -> AppearancePreviewSnapshot {
        AppearancePreviewSnapshot {
            appearance: self.effective(persisted),
            pending: self.pending.is_some(),
        }
    }

    /// `persisted(config)` — clear the pending preview only when the save that
    /// completed matches the exact previewed value. A stale save never rolls
    /// auxiliary windows back.
    pub fn persisted(&mut self, config: &AppearanceConfig) -> AppearanceConfig {
        if let Some(pending) = &self.pending {
            if fingerprint(pending) == fingerprint(config) {
                self.pending = None;
            }
        }
        self.pending.clone().unwrap_or_else(|| config.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appearance::{
        create_default_appearance_config, get_preset_variant, AppearanceConfig, PresetId, Scheme,
    };

    fn dark_mode(config: &mut AppearanceConfig) {
        config.mode = crate::appearance::Mode::Dark;
    }

    #[test]
    fn newer_appearance_preview_survives_older_persistence_completion() {
        let mut state = AppearancePreviewState::default();
        let original = create_default_appearance_config();
        let mut first = original.clone();
        dark_mode(&mut first);
        let mut newer = first.clone();
        let dark = get_preset_variant(PresetId::Moss, Scheme::Dark);
        newer.dark = dark;

        assert_eq!(state.effective(&original), original);
        assert_eq!(state.preview(first.clone()), first);
        assert_eq!(state.effective(&original), first);
        assert_eq!(state.preview(newer.clone()), newer);
        // The older `first` save completing must not displace the newer preview.
        assert_eq!(state.persisted(&first), newer);
        assert_eq!(state.persisted(&newer), newer);
        assert_eq!(state.effective(&original), original);
    }

    #[test]
    fn failed_save_keeps_preview_authoritative_for_reopened_and_reloaded_readers() {
        let mut state = AppearancePreviewState::default();
        let persisted = create_default_appearance_config();
        let mut preview = persisted.clone();
        preview.mode = crate::appearance::Mode::Dark;
        let dark = get_preset_variant(PresetId::Berry, Scheme::Dark);
        preview.dark = dark;

        state.preview(preview.clone());
        assert_eq!(state.effective(&persisted), preview, "settings reopen");
        assert_eq!(state.effective(&persisted), preview, "theme reload");
        assert_eq!(
            state.snapshot(&persisted),
            AppearancePreviewSnapshot {
                appearance: preview.clone(),
                pending: true,
            }
        );
        let after = state.persisted(&preview);
        assert_eq!(
            state.snapshot(&after),
            AppearancePreviewSnapshot {
                appearance: preview,
                pending: false,
            }
        );
    }
}
