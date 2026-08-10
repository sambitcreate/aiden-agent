//! Device-local persistence for the personal Model Pad layout.
//!
//! The store is deliberately network-free. It persists the normalized v1
//! layout as one durable JSON snapshot and preserves placements for models
//! that are not currently available in the provider catalog.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use aiden_core::model_pad::{
    empty_model_pad_layout, model_pad_layouts_equal, parse_model_pad_layout, ModelPadLayout,
    MAX_PLACEMENTS,
};

use crate::{DataStore, DataStoreError, DataStoreOptions};

/// Machine-local filename for the personal layout.
pub const MODEL_PAD_LAYOUT_FILE: &str = "model-pad-layout.json";

static NEXT_MODEL_PAD_SAVE_INTENT: AtomicU64 = AtomicU64::new(1);

/// Opaque, process-unique token issued by [`ModelPadStore`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelPadSaveIntent(u64);

/// Whether a conditional save reached disk or was superseded before publish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelPadSaveOutcome {
    Published,
    Stale,
}

/// Failures exposed to the settings state instead of being silently dropped.
#[derive(Debug, thiserror::Error)]
pub enum ModelPadStoreError {
    #[error("model pad store: {0}")]
    Store(#[from] DataStoreError),
    #[error("model pad layout is invalid or exceeds {MAX_PLACEMENTS} placements")]
    InvalidLayout,
    #[error("model pad layout could not be normalized: {0}")]
    Json(#[from] serde_json::Error),
}

/// Durable, device-local Model Pad store.
pub struct ModelPadStore {
    store: DataStore<ModelPadLayout>,
    current_intent: AtomicU64,
}

impl ModelPadStore {
    /// Create a store rooted in `root`, or Aiden's machine-local data
    /// directory when `root` is `None`.
    pub fn new(root: Option<PathBuf>) -> Self {
        let mut options = DataStoreOptions::new();
        options.normalize = Some(Box::new(|value| parse_model_pad_layout(&value)));
        Self {
            store: DataStore::new(
                MODEL_PAD_LAYOUT_FILE,
                empty_model_pad_layout(),
                root,
                options,
            ),
            current_intent: AtomicU64::new(0),
        }
    }

    /// Load the normalized layout. Malformed files fail closed through the
    /// shared `DataStore` protocol.
    pub fn load(&self) -> Result<ModelPadLayout, ModelPadStoreError> {
        Ok(self.store.load()?)
    }

    /// Persist an exact normalized snapshot. Invalid coordinates, sources,
    /// schema versions, or oversized maps are rejected rather than replaced
    /// with an empty layout.
    pub fn save(&self, layout: &ModelPadLayout) -> Result<(), ModelPadStoreError> {
        let value = serde_json::to_value(layout)?;
        let normalized = parse_model_pad_layout(&value);
        if layout.placements.len() > MAX_PLACEMENTS
            || !model_pad_layouts_equal(layout, &normalized)
            || normalized != *layout
        {
            return Err(ModelPadStoreError::InvalidLayout);
        }
        self.store.save(&normalized)?;
        Ok(())
    }

    /// Issue and synchronously register a process-unique save intent before
    /// dispatching work to an executor.
    pub fn begin_save_intent(&self) -> ModelPadSaveIntent {
        let token = ModelPadSaveIntent(NEXT_MODEL_PAD_SAVE_INTENT.fetch_add(1, Ordering::AcqRel));
        self.current_intent.store(token.0, Ordering::Release);
        token
    }

    pub fn save_if_current(
        &self,
        intent: ModelPadSaveIntent,
        layout: &ModelPadLayout,
    ) -> Result<ModelPadSaveOutcome, ModelPadStoreError> {
        let value = serde_json::to_value(layout)?;
        let normalized = parse_model_pad_layout(&value);
        if layout.placements.len() > MAX_PLACEMENTS
            || !model_pad_layouts_equal(layout, &normalized)
            || normalized != *layout
        {
            return Err(ModelPadStoreError::InvalidLayout);
        }
        let current = || self.current_intent.load(Ordering::Acquire) == intent.0;
        match self.store.save_with_current(&normalized, &current) {
            Ok(()) => Ok(ModelPadSaveOutcome::Published),
            Err(DataStoreError::DocumentInactive) => Ok(ModelPadSaveOutcome::Stale),
            Err(error) => Err(error.into()),
        }
    }

    /// Absolute path of the backing file. Exposed for diagnostics only.
    pub fn path(&self) -> Result<PathBuf, ModelPadStoreError> {
        Ok(self.store.path()?)
    }
}

impl Default for ModelPadStore {
    fn default() -> Self {
        Self::new(None)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use aiden_core::model_pad::{ModelPadPlacement, ModelPadPlacementSource};
    use tempfile::tempdir;

    use super::*;

    fn placement(x: f64, y: f64) -> ModelPadPlacement {
        ModelPadPlacement {
            x,
            y,
            source: ModelPadPlacementSource::User,
        }
    }

    #[test]
    fn save_and_load_preserves_unavailable_model_ids() {
        let dir = tempdir().unwrap();
        let store = ModelPadStore::new(Some(dir.path().to_path_buf()));
        let mut layout = ModelPadLayout::empty();
        layout
            .placements
            .insert("removed-provider/old-model".into(), placement(0.2, 0.8));

        store.save(&layout).unwrap();

        assert_eq!(store.load().unwrap(), layout);
    }

    #[test]
    fn save_rejects_out_of_bounds_coordinates() {
        let dir = tempdir().unwrap();
        let store = ModelPadStore::new(Some(dir.path().to_path_buf()));
        let mut layout = ModelPadLayout::empty();
        layout
            .placements
            .insert("provider/model".into(), placement(1.1, 0.5));

        assert!(matches!(
            store.save(&layout),
            Err(ModelPadStoreError::InvalidLayout)
        ));
    }

    #[test]
    fn save_rejects_more_than_the_parser_bound() {
        let dir = tempdir().unwrap();
        let store = ModelPadStore::new(Some(dir.path().to_path_buf()));
        let placements = (0..=MAX_PLACEMENTS)
            .map(|index| (format!("provider/model-{index}"), placement(0.5, 0.5)))
            .collect::<BTreeMap<_, _>>();
        let layout = ModelPadLayout {
            schema_version: 1,
            placements,
        };

        assert!(matches!(
            store.save(&layout),
            Err(ModelPadStoreError::InvalidLayout)
        ));
    }

    #[test]
    fn malformed_disk_layout_fails_closed_without_network_or_repair_write() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(MODEL_PAD_LAYOUT_FILE), b"{not-json").unwrap();
        let store = ModelPadStore::new(Some(dir.path().to_path_buf()));

        assert_eq!(store.load().unwrap(), ModelPadLayout::empty());
        assert_eq!(
            std::fs::read(dir.path().join(MODEL_PAD_LAYOUT_FILE)).unwrap(),
            b"{not-json"
        );
    }

    #[test]
    fn reversed_executor_order_cannot_publish_an_older_intent() {
        let dir = tempdir().unwrap();
        let store = ModelPadStore::new(Some(dir.path().to_path_buf()));
        let mut older = ModelPadLayout::empty();
        older
            .placements
            .insert("provider::old".into(), placement(0.1, 0.1));
        let mut newest = ModelPadLayout::empty();
        newest
            .placements
            .insert("provider::new".into(), placement(0.9, 0.9));
        let older_intent = store.begin_save_intent();
        let newest_intent = store.begin_save_intent();

        assert_eq!(
            store.save_if_current(newest_intent, &newest).unwrap(),
            ModelPadSaveOutcome::Published
        );
        assert_eq!(
            store.save_if_current(older_intent, &older).unwrap(),
            ModelPadSaveOutcome::Stale
        );
        assert_eq!(
            ModelPadStore::new(Some(dir.path().to_path_buf()))
                .load()
                .unwrap(),
            newest
        );
    }
}
