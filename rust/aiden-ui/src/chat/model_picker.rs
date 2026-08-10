//! Retained composer model-picker state.
//!
//! The picker deliberately owns only presentation state. `ChatService` stays
//! the single authority for accepted provider/model selection.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use gpui::Global;
use serde_json::{Map, Value};

use crate::chat::composer::{model_items_with_layout, model_key, ModelItem};
use crate::chat::model_pad_picker::{
    ModelPadPickerOutcome, ModelPadPickerState, ModelPadRuntime, ModelPoint, PositionedModel,
};
use crate::services::provider_kit::ConfiguredProvider;

const MAX_PINS: usize = 24;
const PINS_SETTING: &str = "composerModelPins";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerTab {
    List,
    Pad,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerModelPickerEvent {
    Commit { provider_id: String, model: String },
}

/// Device-local convenience state, deliberately independent of selection.
#[derive(Clone)]
pub struct ModelPickerPins {
    pub keys: Vec<String>,
    generation: u64,
    current_generation: Arc<AtomicU64>,
}
impl Global for ModelPickerPins {}
impl Default for ModelPickerPins {
    fn default() -> Self {
        Self {
            keys: Vec::new(),
            generation: 0,
            current_generation: Arc::new(AtomicU64::new(0)),
        }
    }
}
impl ModelPickerPins {
    pub fn load(store: &aiden_data::config_store::ConfigStore) -> Self {
        let keys = store
            .get_settings()
            .ok()
            .and_then(|settings| settings.get(PINS_SETTING).cloned())
            .and_then(|value| value.as_array().cloned())
            .map(|values| {
                values
                    .into_iter()
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .take(MAX_PINS)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            keys,
            ..Self::default()
        }
    }

    pub fn persist(&self, store: &aiden_data::config_store::ConfigStore) {
        let mut patch = Map::new();
        patch.insert(
            PINS_SETTING.into(),
            Value::Array(self.keys.iter().cloned().map(Value::String).collect()),
        );
        let current_generation = self.current_generation.clone();
        let generation = self.generation;
        let _ = store.set_settings(&patch, &|| {
            current_generation.load(Ordering::Acquire) == generation
        });
    }
    pub fn toggle(&mut self, key: String) {
        if let Some(index) = self.keys.iter().position(|item| item == &key) {
            self.keys.remove(index);
        } else {
            self.keys.retain(|item| item != &key);
            self.keys.push(key);
            if self.keys.len() > MAX_PINS {
                self.keys.remove(0);
            }
        }
        self.bump_generation();
    }
    pub fn reconcile(&mut self, available: &BTreeSet<String>) -> bool {
        let before = self.keys.len();
        self.keys.retain(|key| available.contains(key));
        let changed = self.keys.len() != before;
        if changed {
            self.bump_generation();
        }
        changed
    }

    fn bump_generation(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.current_generation
            .store(self.generation, Ordering::Release);
    }

    #[cfg(test)]
    fn persistence_is_current(&self) -> bool {
        self.current_generation.load(Ordering::Acquire) == self.generation
    }
}

/// Retained local popover state. Preview and query changes cannot commit.
pub struct ComposerModelPicker {
    pub open: bool,
    pub tab: PickerTab,
    pub query: String,
    pub active: Option<String>,
    pub items: Vec<ModelItem>,
    selection: Option<String>,
    pad: Option<ModelPadPickerState>,
    pad_revision: Option<u64>,
    pointer_frame_scheduled: bool,
}

impl ComposerModelPicker {
    pub fn new(items: Vec<ModelItem>, selection: Option<String>) -> Self {
        Self {
            open: false,
            tab: PickerTab::List,
            query: String::new(),
            active: selection.clone(),
            items,
            selection,
            pad: None,
            pad_revision: None,
            pointer_frame_scheduled: false,
        }
    }
    pub fn reconcile(
        &mut self,
        providers: &[ConfiguredProvider],
        runtime: Option<&ModelPadRuntime>,
        selection: Option<String>,
    ) {
        self.items = model_items_with_layout(providers, runtime);
        let available: BTreeSet<_> = self.items.iter().map(ModelItem::value_key).collect();
        self.selection = selection.filter(|key| available.contains(key));
        if self
            .active
            .as_ref()
            .is_none_or(|key| !available.contains(key))
        {
            self.active = self
                .selection
                .clone()
                .or_else(|| self.items.first().map(ModelItem::value_key));
        }
        if self.tab == PickerTab::Pad && !self.has_pad(runtime) {
            self.tab = PickerTab::List;
        }
        self.repair_active_visible();
        if self.open {
            self.reset_pad(runtime);
        } else {
            self.pad = None;
            self.pad_revision = None;
        }
    }
    pub fn toggle(&mut self, runtime: Option<&ModelPadRuntime>) {
        self.open = !self.open;
        if self.open {
            self.tab = if self.has_pad(runtime) {
                PickerTab::Pad
            } else {
                PickerTab::List
            };
            self.active = self
                .selection
                .clone()
                .or_else(|| self.items.first().map(ModelItem::value_key));
            self.reset_pad(runtime);
        } else {
            self.query.clear();
            self.pad = None;
            self.pad_revision = None;
            self.pointer_frame_scheduled = false;
        }
    }
    pub fn close_rollback(&mut self) {
        self.active = self.selection.clone();
        self.open = false;
        self.query.clear();
        self.pad = None;
        self.pad_revision = None;
        self.pointer_frame_scheduled = false;
    }
    /// Escape first restores the accepted selection; only an already-restored
    /// picker closes on the next Escape.
    pub fn escape(&mut self) -> bool {
        if self.active != self.selection {
            self.active = self.selection.clone();
            if let Some(pad) = self.pad.as_mut() {
                let _ = pad.handle_key(crate::chat::model_pad_picker::ModelPadKey::Escape);
            }
            false
        } else {
            self.close_rollback();
            true
        }
    }
    pub fn preview(&mut self, key: String) {
        if self.items.iter().any(|item| item.value_key() == key) {
            self.active = Some(key);
        }
    }
    pub fn filtered(&self) -> Vec<&ModelItem> {
        let needle = self.query.to_ascii_lowercase();
        self.items
            .iter()
            .filter(|item| {
                needle.is_empty()
                    || [
                        item.provider_label.as_str(),
                        item.model.as_str(),
                        item.value_key().as_str(),
                    ]
                    .iter()
                    .any(|field| field.to_ascii_lowercase().contains(&needle))
            })
            .collect()
    }
    pub fn filtered_pinned_first(&self, pins: &[String]) -> Vec<&ModelItem> {
        let mut visible = self.filtered();
        visible.sort_by_key(|item| {
            pins.iter()
                .position(|key| key == &item.value_key())
                .map_or((1, usize::MAX), |index| (0, index))
        });
        visible
    }
    pub fn rove_visible_with_pins(&mut self, delta: isize, pins: &[String]) {
        let visible = self.filtered_pinned_first(pins);
        if visible.is_empty() {
            self.active = None;
            return;
        }
        let current = self
            .active
            .as_ref()
            .and_then(|key| visible.iter().position(|item| item.value_key() == *key))
            .unwrap_or(0);
        let next = (current as isize + delta).clamp(0, visible.len() as isize - 1) as usize;
        self.active = Some(visible[next].value_key());
    }
    pub fn repair_active_visible(&mut self) {
        let visible = self.filtered();
        if visible.is_empty() {
            self.active = None;
        } else if self
            .active
            .as_ref()
            .is_none_or(|active| !visible.iter().any(|item| item.value_key() == *active))
        {
            self.active = Some(visible[0].value_key());
        }
    }
    pub fn rove_home_with_pins(&mut self, pins: &[String]) {
        self.active = self
            .filtered_pinned_first(pins)
            .first()
            .map(|item| item.value_key());
    }
    pub fn rove_end_with_pins(&mut self, pins: &[String]) {
        self.active = self
            .filtered_pinned_first(pins)
            .last()
            .map(|item| item.value_key());
    }

    pub fn reset_pad(&mut self, runtime: Option<&ModelPadRuntime>) {
        self.pad_revision = runtime.map(|runtime| runtime.revision);
        self.pad = runtime.and_then(|runtime| {
            let models = self
                .items
                .iter()
                .filter_map(|item| {
                    runtime
                        .layout
                        .placements
                        .get(item.pad_key())
                        .map(|placement| PositionedModel {
                            model_id: item.value_key(),
                            x: placement.x,
                            y: placement.y,
                        })
                })
                .collect();
            ModelPadPickerState::new(models, self.selection.clone()).ok()
        });
        if self.tab == PickerTab::Pad {
            self.active = self
                .pad
                .as_ref()
                .and_then(|pad| pad.preview().map(str::to_owned));
        }
        self.pointer_frame_scheduled = false;
    }

    pub fn ensure_pad_revision(&mut self, runtime: Option<&ModelPadRuntime>) {
        if self.open && self.pad_revision != runtime.map(|runtime| runtime.revision) {
            self.reset_pad(runtime);
        }
    }

    pub fn activate_pad_tab(&mut self) {
        self.tab = PickerTab::Pad;
        self.active = self
            .pad
            .as_ref()
            .and_then(|pad| pad.preview().map(str::to_owned));
    }

    fn apply_pad_outcome(&mut self, outcome: ModelPadPickerOutcome) -> Option<String> {
        match outcome {
            ModelPadPickerOutcome::Previewed(key) => {
                self.preview(key);
                None
            }
            ModelPadPickerOutcome::RolledBack(key) => {
                self.active = key;
                None
            }
            ModelPadPickerOutcome::Committed(key) => Some(key),
            ModelPadPickerOutcome::Unchanged => None,
        }
    }

    pub fn pad_down(&mut self, point: ModelPoint) {
        if let Some(pad) = self.pad.as_mut() {
            let outcome = pad.pointer_down(point);
            self.apply_pad_outcome(outcome);
        }
    }

    /// Returns true only for the first queued motion in a frame.
    pub fn pad_move(&mut self, point: ModelPoint) -> bool {
        let Some(pad) = self.pad.as_mut() else {
            return false;
        };
        pad.queue_pointer_move(point);
        if self.pointer_frame_scheduled {
            false
        } else {
            self.pointer_frame_scheduled = true;
            true
        }
    }

    pub fn flush_pad_frame(&mut self) {
        self.pointer_frame_scheduled = false;
        if let Some(pad) = self.pad.as_mut() {
            let outcome = pad.flush_pointer_frame();
            self.apply_pad_outcome(outcome);
        }
    }

    pub fn pad_up(&mut self, point: ModelPoint) -> Option<ComposerModelPickerEvent> {
        let outcome = self.pad.as_mut()?.pointer_up(point);
        let key = self.apply_pad_outcome(outcome)?;
        self.commit(&key)
    }

    pub fn pad_leave(&mut self) {
        if let Some(pad) = self.pad.as_mut() {
            let outcome = pad.pointer_leave();
            self.apply_pad_outcome(outcome);
        }
    }

    pub fn pad_cancel(&mut self) {
        if let Some(pad) = self.pad.as_mut() {
            let outcome = pad.pointer_cancel();
            self.apply_pad_outcome(outcome);
        }
    }
    pub fn pad_key(
        &mut self,
        key: crate::chat::model_pad_picker::ModelPadKey,
    ) -> Option<ComposerModelPickerEvent> {
        let outcome = self.pad.as_mut()?.handle_key(key);
        let key = self.apply_pad_outcome(outcome)?;
        self.commit(&key)
    }
    pub fn has_pad(&self, runtime: Option<&ModelPadRuntime>) -> bool {
        runtime.is_some_and(|runtime| {
            self.items
                .iter()
                .any(|item| runtime.layout.placements.contains_key(item.pad_key()))
        })
    }
    pub fn selection(&self) -> Option<&str> {
        self.selection.as_deref()
    }
    pub fn commit(&mut self, key: &str) -> Option<ComposerModelPickerEvent> {
        if !self.open {
            return None;
        }
        let item = self.items.iter().find(|item| item.value_key() == key)?;
        let (provider_id, model) = crate::chat::composer::decode_model_key(&item.value_key())?;
        self.selection = Some(model_key(&provider_id, &model));
        self.active = self.selection.clone();
        self.open = false;
        self.query.clear();
        self.pad = None;
        self.pad_revision = None;
        Some(ComposerModelPickerEvent::Commit { provider_id, model })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(provider: &str, model: &str) -> ModelItem {
        ModelItem::test_item(provider, model)
    }
    #[test]
    fn filters_provider_model_and_key() {
        let mut picker =
            ComposerModelPicker::new(vec![item("local", "llama"), item("openai", "gpt")], None);
        picker.query = "local".into();
        assert_eq!(picker.filtered().len(), 1);
        picker.query = "gpt".into();
        assert_eq!(picker.filtered().len(), 1);
    }
    #[test]
    fn preview_never_commits() {
        let mut picker = ComposerModelPicker::new(vec![item("p", "a")], None);
        picker.preview(model_key("p", "a"));
        assert!(picker.selection().is_none());
    }
    #[test]
    fn roving_stays_inside_filtered_visible_rows() {
        let mut picker = ComposerModelPicker::new(vec![item("p", "a"), item("p", "b")], None);
        picker.query = "b".into();
        picker.rove_visible_with_pins(1, &[]);
        let expected = model_key("p", "b");
        assert_eq!(picker.active.as_deref(), Some(expected.as_str()));
    }
    #[test]
    fn inventory_repair_keeps_roving_row_visible_after_a_filter() {
        let mut picker = ComposerModelPicker::new(vec![item("p", "a"), item("p", "b")], None);
        picker.active = Some(model_key("p", "a"));
        picker.query = "b".into();
        picker.repair_active_visible();

        let expected = model_key("p", "b");
        assert_eq!(picker.active.as_deref(), Some(expected.as_str()));
    }
    #[test]
    fn pins_are_bounded_and_reconciled() {
        let mut pins = ModelPickerPins::default();
        for index in 0..30 {
            pins.toggle(index.to_string());
        }
        assert_eq!(pins.keys.len(), MAX_PINS);
        pins.reconcile(&BTreeSet::from(["29".to_string()]));
        assert_eq!(pins.keys, ["29"]);
    }

    #[test]
    fn pins_render_first_in_pin_order() {
        let picker =
            ComposerModelPicker::new(vec![item("p", "a"), item("p", "b"), item("p", "c")], None);
        let ordered = picker.filtered_pinned_first(&[model_key("p", "c"), model_key("p", "a")]);

        assert_eq!(ordered[0].model, "c");
        assert_eq!(ordered[1].model, "a");
    }

    #[test]
    fn newer_pin_mutation_invalidates_an_older_persistence_snapshot() {
        let mut pins = ModelPickerPins::default();
        pins.toggle("a".into());
        let older = pins.clone();
        pins.toggle("b".into());

        assert!(!older.persistence_is_current());
        assert!(pins.persistence_is_current());
    }

    #[test]
    fn escape_rolls_preview_back_before_closing() {
        let selected = model_key("p", "a");
        let mut picker =
            ComposerModelPicker::new(vec![item("p", "a"), item("p", "b")], Some(selected.clone()));
        picker.open = true;
        picker.preview(model_key("p", "b"));

        assert!(!picker.escape());
        assert!(picker.open);
        assert_eq!(picker.active.as_deref(), Some(selected.as_str()));
        assert!(picker.escape());
        assert!(!picker.open);
    }

    #[test]
    fn accepted_commit_can_be_emitted_exactly_once_per_open_picker() {
        let key = model_key("p", "a");
        let mut picker = ComposerModelPicker::new(vec![item("p", "a")], None);
        picker.open = true;

        assert!(picker.commit(&key).is_some());
        assert!(picker.commit(&key).is_none());
    }
}
