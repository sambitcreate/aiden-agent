//! State and GPUI Settings surface for the personal Model Pad editor.
//!
//! Pointer updates only mutate the draft; persistence occurs exclusively
//! through `request_save`.
//! Artificial Analysis input is an already-normalized offline snapshot and
//! this module has no network capability.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use aiden_core::model_pad::{
    empty_model_pad_layout, model_pad_layouts_equal, next_model_pad_placement, ModelPadLayout,
    ModelPadPlacement, ModelPadPlacementSource, MAX_PLACEMENTS,
};
use aiden_data::model_pad_store::{ModelPadSaveOutcome, ModelPadStoreError};
use aiden_providers::artificial_analysis::{
    artificial_analysis_ranking, find_artificial_analysis_model, ArtificialAnalysisCatalog,
    ArtificialAnalysisCatalogSource, ArtificialAnalysisUserCache,
};
use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, BorrowAppContext as _, Context,
    FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputState},
    tooltip::Tooltip,
    v_flex, ActiveTheme, Disableable as _, IconName, PixelsExt as _, Sizable as _,
};

use super::providers::ProviderRow;
use super::SettingsView;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInventoryEntry {
    pub value: String,
    pub model: String,
    pub provider_label: String,
    pub is_local: bool,
}

fn embedding_like(model: &str) -> bool {
    model
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|part| {
            matches!(
                part.to_ascii_lowercase().as_str(),
                "embed" | "embedding" | "embeddings"
            )
        })
}

fn inventory_matches_filter(entry: &ModelInventoryEntry, filter: &str) -> bool {
    let needle = filter.trim().to_lowercase();
    needle.is_empty()
        || entry.model.to_lowercase().contains(&needle)
        || entry.provider_label.to_lowercase().contains(&needle)
        || entry.value.to_lowercase().contains(&needle)
}

fn centered_origin(center: f32, extent: f32) -> f32 {
    center - extent / 2.0
}

pub fn available_model_inventory(providers: &[ProviderRow]) -> Vec<ModelInventoryEntry> {
    providers
        .iter()
        .filter(|provider| !provider.models.is_empty())
        .filter(|provider| !provider.needs_key || provider.has_key)
        .flat_map(|provider| {
            provider
                .models
                .iter()
                .filter(|model| !embedding_like(model))
                .map(move |model| ModelInventoryEntry {
                    value: format!("{}::{model}", provider.id),
                    model: model.clone(),
                    provider_label: provider.label.clone(),
                    is_local: provider.deployment
                        == aiden_data::portable_config::ProviderDeployment::Local,
                })
        })
        .collect()
}

/// Match the validated device-local AA cache to the currently usable model
/// inventory. This is a pure projection: applying it remains an explicit user
/// action and can never trigger a network request.
pub fn offline_aa_placements(
    cache: &ArtificialAnalysisUserCache,
    inventory: &[ModelInventoryEntry],
) -> Vec<OfflineAaPlacement> {
    let catalog = ArtificialAnalysisCatalog {
        schema_version: cache.schema_version,
        source: ArtificialAnalysisCatalogSource {
            name: cache.source.name.clone(),
            url: cache.source.url.clone(),
            fetched_at: Some(cache.source.fetched_at.clone()),
            intelligence_index_version: Some(cache.source.intelligence_index_version),
        },
        models: cache.models.clone(),
    };
    inventory
        .iter()
        .filter_map(|entry| {
            let matched = find_artificial_analysis_model(
                &catalog,
                &entry.model,
                Some(&entry.provider_label),
                Some(&entry.model),
            )
            .or_else(|| {
                find_artificial_analysis_model(&catalog, &entry.model, None, Some(&entry.model))
            })?;
            let ranking = artificial_analysis_ranking(&catalog, &matched)?;
            Some(OfflineAaPlacement {
                model_id: entry.value.clone(),
                response_time_percentile: ranking.response_time_percentile,
                capability_percentile: ranking.capability_percentile,
            })
        })
        .collect()
}

/// Desktop inventory width from the Electron reference (13.5 rem at 16 px).
pub const MODEL_PAD_INVENTORY_WIDTH_PX: f32 = 216.0;
/// Width below which the inventory stacks below the square pad.
pub const MODEL_PAD_STACK_BREAKPOINT_PX: f32 = 620.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PadBounds {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

impl PadBounds {
    fn normalized(self, x: f32, y: f32) -> Option<(f64, f64)> {
        if self.width <= 0.0 || self.height <= 0.0 {
            return None;
        }
        let horizontal = ((x - self.left) / self.width).clamp(0.0, 1.0) as f64;
        // Stored y is capability: 1.0 is the visual top of the pad.
        let capability = (1.0 - ((y - self.top) / self.height)).clamp(0.0, 1.0) as f64;
        Some((horizontal, capability))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InventoryLayout {
    BesidePad,
    BelowPad,
}

pub fn inventory_layout(content_width: f32) -> InventoryLayout {
    if content_width <= MODEL_PAD_STACK_BREAKPOINT_PX {
        InventoryLayout::BelowPad
    } else {
        InventoryLayout::BesidePad
    }
}

pub fn model_pad_content_width(viewport_width: f32) -> f32 {
    let rail = if viewport_width <= 700.0 { 0.0 } else { 272.0 };
    (viewport_width - rail - 40.0).clamp(0.0, 672.0)
}

fn nudge_direction_for_key(key: &str) -> Option<NudgeDirection> {
    match key {
        "left" => Some(NudgeDirection::Left),
        "right" => Some(NudgeDirection::Right),
        "up" => Some(NudgeDirection::Up),
        "down" => Some(NudgeDirection::Down),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NudgeDirection {
    Left,
    Right,
    Up,
    Down,
}

#[derive(Clone)]
struct ModelChipDrag {
    model_id: String,
    start_x: f64,
    start_y: f64,
    pad_range: f32,
    pointer: Rc<Cell<Option<(f32, f32)>>>,
}

struct ModelChipDragView;

impl Render for ModelChipDragView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_0()
    }
}

/// Offline ranking projection supplied after the AA cache is normalized and
/// matched to an Aiden model id.
#[derive(Debug, Clone, PartialEq)]
pub struct OfflineAaPlacement {
    pub model_id: String,
    pub response_time_percentile: f64,
    pub capability_percentile: f64,
}

impl OfflineAaPlacement {
    fn placement(&self) -> Option<ModelPadPlacement> {
        let valid = [self.response_time_percentile, self.capability_percentile]
            .into_iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(&value));
        valid.then_some(ModelPadPlacement {
            x: self.response_time_percentile,
            y: self.capability_percentile,
            source: ModelPadPlacementSource::ArtificialAnalysis,
        })
    }
}

fn suggestion_action_state(
    cache_ready: Option<bool>,
    suggestions: &[OfflineAaPlacement],
    editor: &ModelPadEditorState,
) -> (usize, bool) {
    let count = suggestions
        .iter()
        .filter(|suggestion| editor.available.contains(&suggestion.model_id))
        .filter(|suggestion| !editor.draft().placements.contains_key(&suggestion.model_id))
        .count();
    (count, cache_ready == Some(true) && count > 0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelPadSaveOperation {
    pub revision: u64,
    pub layout: ModelPadLayout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPadSaveFailure {
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ModelPadSaveState {
    Clean,
    Dirty,
    Saving(ModelPadSaveOperation),
    Failed {
        operation: ModelPadSaveOperation,
        failure: ModelPadSaveFailure,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelPadEditError {
    CapacityReached,
    UnknownModel,
    SaveInProgress,
}

#[derive(Debug, Clone, PartialEq)]
struct DragState {
    model_id: String,
    bounds: PadBounds,
}

/// Entity-ready settings editor state.
pub struct ModelPadEditorState {
    saved: ModelPadLayout,
    draft: ModelPadLayout,
    available: BTreeSet<String>,
    active_model: Option<String>,
    drag: Option<DragState>,
    revision: u64,
    save_state: ModelPadSaveState,
}

impl ModelPadEditorState {
    pub fn new(saved: ModelPadLayout, available: impl IntoIterator<Item = String>) -> Self {
        Self {
            draft: saved.clone(),
            saved,
            available: available.into_iter().collect(),
            active_model: None,
            drag: None,
            revision: 0,
            save_state: ModelPadSaveState::Clean,
        }
    }

    pub fn saved(&self) -> &ModelPadLayout {
        &self.saved
    }

    pub fn draft(&self) -> &ModelPadLayout {
        &self.draft
    }

    pub fn save_state(&self) -> &ModelPadSaveState {
        &self.save_state
    }

    pub fn is_dirty(&self) -> bool {
        !model_pad_layouts_equal(&self.saved, &self.draft)
    }

    pub fn is_saving(&self) -> bool {
        matches!(self.save_state, ModelPadSaveState::Saving(_))
    }

    pub fn active_model(&self) -> Option<&str> {
        self.active_model.as_deref()
    }

    /// Catalog changes never remove saved positions. The returned ids are
    /// retained placements that are currently unavailable.
    pub fn set_available_models(
        &mut self,
        available: impl IntoIterator<Item = String>,
    ) -> Vec<String> {
        self.available = available.into_iter().collect();
        self.unavailable_model_ids()
    }

    pub fn unavailable_model_ids(&self) -> Vec<String> {
        self.draft
            .placements
            .keys()
            .filter(|id| !self.available.contains(*id))
            .cloned()
            .collect()
    }

    pub fn available_models(&self) -> impl Iterator<Item = &str> {
        self.available.iter().map(String::as_str)
    }

    pub fn add_model(&mut self, model_id: &str) -> Result<(), ModelPadEditError> {
        self.ensure_editable()?;
        if self.draft.placements.contains_key(model_id) {
            return Ok(());
        }
        if self.draft.placements.len() >= MAX_PLACEMENTS {
            return Err(ModelPadEditError::CapacityReached);
        }
        let placement = next_model_pad_placement(&self.draft.placements);
        self.draft
            .placements
            .insert(model_id.to_string(), placement);
        self.mark_dirty();
        Ok(())
    }

    pub fn remove_model(&mut self, model_id: &str) -> bool {
        if self.is_saving() {
            return false;
        }
        let removed = self.draft.placements.remove(model_id).is_some();
        if removed {
            self.mark_dirty();
        }
        removed
    }

    /// Add only unplaced ranked models. Personal positions therefore always
    /// win over offline benchmark suggestions.
    pub fn apply_offline_aa_suggestions(&mut self, snapshot: &[OfflineAaPlacement]) -> usize {
        if self.is_saving() {
            return 0;
        }
        let capacity = MAX_PLACEMENTS.saturating_sub(self.draft.placements.len());
        let additions = snapshot
            .iter()
            .filter(|suggestion| self.available.contains(&suggestion.model_id))
            .filter(|suggestion| !self.draft.placements.contains_key(&suggestion.model_id))
            .filter_map(|suggestion| {
                suggestion
                    .placement()
                    .map(|placement| (suggestion.model_id.clone(), placement))
            })
            .take(capacity)
            .collect::<BTreeMap<_, _>>();
        let count = additions.len();
        if count > 0 {
            self.draft.placements.extend(additions);
            self.mark_dirty();
        }
        count
    }

    pub fn begin_drag(
        &mut self,
        model_id: &str,
        bounds: PadBounds,
    ) -> Result<(), ModelPadEditError> {
        self.ensure_editable()?;
        if !self.draft.placements.contains_key(model_id) {
            return Err(ModelPadEditError::UnknownModel);
        }
        self.active_model = Some(model_id.to_string());
        self.drag = Some(DragState {
            model_id: model_id.to_string(),
            bounds,
        });
        Ok(())
    }

    /// Update the draft only. The caller may coalesce pointer motion to one
    /// foreground-frame update; this method never writes storage.
    pub fn update_drag(&mut self, pointer_x: f32, pointer_y: f32) -> bool {
        if self.is_saving() {
            return false;
        }
        let Some(drag) = &self.drag else {
            return false;
        };
        let Some((x, y)) = drag.bounds.normalized(pointer_x, pointer_y) else {
            return false;
        };
        let Some(placement) = self.draft.placements.get_mut(&drag.model_id) else {
            return false;
        };
        placement.x = x;
        placement.y = y;
        placement.source = ModelPadPlacementSource::User;
        self.mark_dirty();
        true
    }

    pub fn end_drag(&mut self) {
        self.drag = None;
    }

    pub fn nudge(
        &mut self,
        model_id: &str,
        direction: NudgeDirection,
        shift: bool,
    ) -> Result<ModelPadPlacement, ModelPadEditError> {
        self.ensure_editable()?;
        let step = if shift { 0.10 } else { 0.04 };
        let placement = self
            .draft
            .placements
            .get_mut(model_id)
            .ok_or(ModelPadEditError::UnknownModel)?;
        match direction {
            NudgeDirection::Left => placement.x = (placement.x - step).max(0.0),
            NudgeDirection::Right => placement.x = (placement.x + step).min(1.0),
            NudgeDirection::Up => placement.y = (placement.y + step).min(1.0),
            NudgeDirection::Down => placement.y = (placement.y - step).max(0.0),
        }
        placement.source = ModelPadPlacementSource::User;
        let result = *placement;
        self.active_model = Some(model_id.to_string());
        self.mark_dirty();
        Ok(result)
    }

    pub fn move_by(
        &mut self,
        model_id: &str,
        start_x: f64,
        start_y: f64,
        delta_x: f32,
        delta_y: f32,
        pad_range: f32,
    ) -> Result<(), ModelPadEditError> {
        self.ensure_editable()?;
        let placement = self
            .draft
            .placements
            .get_mut(model_id)
            .ok_or(ModelPadEditError::UnknownModel)?;
        placement.x = (start_x + f64::from(delta_x / pad_range)).clamp(0.0, 1.0);
        placement.y = (start_y - f64::from(delta_y / pad_range)).clamp(0.0, 1.0);
        placement.source = ModelPadPlacementSource::User;
        self.active_model = Some(model_id.to_string());
        self.mark_dirty();
        Ok(())
    }

    pub fn reset(&mut self) {
        if self.is_saving() {
            return;
        }
        self.draft = self.saved.clone();
        self.drag = None;
        self.save_state = ModelPadSaveState::Clean;
    }

    pub fn clear(&mut self) {
        if self.is_saving() {
            return;
        }
        self.draft = empty_model_pad_layout();
        self.drag = None;
        self.active_model = None;
        self.mark_dirty();
    }

    /// Explicitly create a save operation. This is the only persistence seam.
    pub fn request_save(&mut self) -> Option<ModelPadSaveOperation> {
        if self.is_saving() || !self.is_dirty() {
            return None;
        }
        self.revision = self.revision.saturating_add(1);
        let operation = ModelPadSaveOperation {
            revision: self.revision,
            layout: self.draft.clone(),
        };
        self.save_state = ModelPadSaveState::Saving(operation.clone());
        Some(operation)
    }

    pub fn complete_save(
        &mut self,
        revision: u64,
        result: Result<(), ModelPadSaveFailure>,
    ) -> bool {
        let ModelPadSaveState::Saving(operation) = &self.save_state else {
            return false;
        };
        if operation.revision != revision {
            return false;
        }
        let operation = operation.clone();
        match result {
            Ok(()) => {
                self.saved = operation.layout;
                self.save_state = if self.is_dirty() {
                    ModelPadSaveState::Dirty
                } else {
                    ModelPadSaveState::Clean
                };
            }
            Err(failure) => {
                self.save_state = ModelPadSaveState::Failed { operation, failure };
            }
        }
        true
    }

    pub fn retry_save(&mut self) -> Option<ModelPadSaveOperation> {
        let retryable = matches!(
            &self.save_state,
            ModelPadSaveState::Failed { failure, .. } if failure.retryable
        );
        retryable.then(|| self.request_save()).flatten()
    }

    fn mark_dirty(&mut self) {
        self.save_state = if self.is_dirty() {
            ModelPadSaveState::Dirty
        } else {
            ModelPadSaveState::Clean
        };
    }

    fn ensure_editable(&self) -> Result<(), ModelPadEditError> {
        if self.is_saving() {
            Err(ModelPadEditError::SaveInProgress)
        } else {
            Ok(())
        }
    }
}

/// Retained Settings wrapper around the pure editor. Store access stays on
/// the background executor and completions are revision-fenced by the editor.
#[derive(Default)]
pub struct ModelPadState {
    editor: Option<ModelPadEditorState>,
    load_error: Option<String>,
    filter_input: Option<gpui::Entity<InputState>>,
}

impl ModelPadState {
    pub fn hydrate(
        &mut self,
        layout: Result<ModelPadLayout, ModelPadStoreError>,
        available: impl IntoIterator<Item = String>,
    ) {
        match layout {
            Ok(layout) => {
                self.editor = Some(ModelPadEditorState::new(layout, available));
                self.load_error = None;
            }
            Err(error) => {
                self.editor = Some(ModelPadEditorState::new(ModelPadLayout::empty(), available));
                self.load_error = Some(format!("Aiden couldn’t load your Model Pad: {error}"));
            }
        }
    }

    pub fn set_available_models(&mut self, available: impl IntoIterator<Item = String>) {
        if let Some(editor) = self.editor.as_mut() {
            editor.set_available_models(available);
        }
    }
}

fn complete_model_pad_store_save(
    editor: &mut ModelPadEditorState,
    revision: u64,
    result: Result<ModelPadSaveOutcome, ModelPadStoreError>,
) -> bool {
    let completion = match result {
        Ok(ModelPadSaveOutcome::Published) => Ok(()),
        Ok(ModelPadSaveOutcome::Stale) => return false,
        Err(error) => Err(ModelPadSaveFailure {
            message: format!("Aiden couldn’t save your Model Pad on this Mac: {error}"),
            retryable: true,
        }),
    };
    editor.complete_save(revision, completion)
        && matches!(editor.save_state(), ModelPadSaveState::Clean)
}

const PAD_INSET_PX: f32 = 32.0;
const PAD_DOT_RADIUS_PX: f32 = 2.0;
const MODEL_CHIP_SLOT_WIDTH_PX: f32 = 112.0;
const MODEL_CHIP_HEIGHT_PX: f32 = 24.0;

impl SettingsView {
    pub(crate) fn model_pad_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        if self.model_pad.filter_input.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("Filter models…"));
            self._subscriptions
                .push(cx.observe(&input, |_this, _input, cx| cx.notify()));
            self.model_pad.filter_input = Some(input);
        }
        let Some(filter_input) = self.model_pad.filter_input.clone() else {
            return div()
                .child("Model Pad filter is unavailable.")
                .into_any_element();
        };
        let filter = filter_input.read(cx).value().to_string();
        let Some(editor) = self.model_pad.editor.as_ref() else {
            return v_flex()
                .id("model-pad-section")
                .gap_3()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Model Pad"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Loading models…"),
                )
                .into_any_element();
        };
        let dirty = editor.is_dirty();
        let saving = editor.is_saving();
        let placements = editor
            .draft()
            .placements
            .iter()
            .filter(|(id, _)| editor.available.contains(*id))
            .map(|(id, placement)| (id.clone(), *placement))
            .collect::<Vec<_>>();
        let full_inventory = available_model_inventory(&self.providers.providers);
        let available = full_inventory
            .iter()
            .filter(|entry| inventory_matches_filter(entry, &filter))
            .cloned()
            .collect::<Vec<_>>();
        let aa_suggestions = self
            .model_data
            .aa_catalog
            .as_ref()
            .map_or_else(Vec::new, |cache| {
                offline_aa_placements(cache, &full_inventory)
            });
        let inventory_count = editor.available_models().count();
        let active_model = editor.active_model().map(str::to_string);
        let (suggestion_count, suggestions_enabled) = suggestion_action_state(
            self.model_data.aa.as_ref().map(|status| status.ready),
            &aa_suggestions,
            editor,
        );
        let unavailable = editor.unavailable_model_ids().len();
        let save_state = editor.save_state().clone();
        let content_width = model_pad_content_width(window.viewport_size().width.as_f32());
        let layout = inventory_layout(content_width);
        let pad_size = if layout == InventoryLayout::BesidePad {
            400.0
        } else {
            content_width.clamp(240.0, 400.0)
        };
        let pad_range = pad_size - PAD_INSET_PX * 2.0;

        v_flex()
            .id("model-pad-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child("Model Pad"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child("Choose the models you want close at hand, then arrange them by capability and response pace."),
                    ),
            )
            .when_some(self.model_pad.load_error.clone(), |el, message| {
                el.child(div().text_sm().text_color(theme.danger).child(message))
            })
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                div()
                                    .px_2()
                                    .py_1()
                                    .rounded_md()
                                    .bg(theme.muted)
                                    .text_xs()
                                    .child(format!("{} on Pad", placements.len())),
                            )
                            .when(dirty, |el| {
                                el.child(
                                    div()
                                        .px_2()
                                        .py_1()
                                        .rounded_md()
                                        .bg(theme.accent.opacity(0.14))
                                        .text_color(theme.accent)
                                        .text_xs()
                                        .child("Unsaved changes"),
                                )
                            })
                            .when(!dirty && !placements.is_empty(), |el| {
                                el.child(
                                    div()
                                        .px_2()
                                        .py_1()
                                        .rounded_md()
                                        .bg(theme.muted)
                                        .text_xs()
                                        .child("Saved locally"),
                                )
                            }),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("model-pad-reset")
                                    .ghost()
                                    .small()
                                    .icon(IconName::Undo2)
                                    .label("Reset changes")
                                    .disabled(!dirty || saving)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if let Some(editor) = this.model_pad.editor.as_mut() {
                                            editor.reset();
                                            cx.notify();
                                        }
                                    })),
                            )
                            .child(
                                Button::new("model-pad-save")
                                    .primary()
                                    .small()
                                    .icon(IconName::Check)
                                    .label(match save_state {
                                        ModelPadSaveState::Saving(_) => "Saving…",
                                        _ => "Save Pad",
                                    })
                                    .disabled(!dirty || matches!(save_state, ModelPadSaveState::Saving(_)))
                                    .on_click(cx.listener(|this, _, _, cx| this.save_model_pad(cx))),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .flex_wrap()
                    .gap_4()
                    .child(
                        v_flex()
                            .min_w(px(0.))
                            .gap_2()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .text_center()
                                    .child("More capable"),
                            )
                            .child(
                                div()
                                    .id("personal-model-pad-arrangement")
                                    .relative()
                                    .size(px(pad_size))
                                    .max_w_full()
                                    .rounded_xl()
                                    .border_1()
                                    .border_color(theme.border)
                                    .bg(theme.background)
                                    .overflow_hidden()
                                    .children((0..49).map(|index| {
                                        div()
                                            .absolute()
                                            .left(px(centered_origin(PAD_INSET_PX + (index % 7) as f32 / 6.0 * pad_range, PAD_DOT_RADIUS_PX * 2.0)))
                                            .top(px(centered_origin(PAD_INSET_PX + (index / 7) as f32 / 6.0 * pad_range, PAD_DOT_RADIUS_PX * 2.0)))
                                            .size(px(4.))
                                            .rounded_full()
                                            .bg(theme.foreground.opacity(0.16))
                                    }))
                                    .when(placements.is_empty(), |el| {
                                        el.child(div().absolute().inset_0().flex().items_center().justify_center().px_10().text_center().text_sm().text_color(theme.muted_foreground).child("Add a few models from the list, then use the arrow keys to arrange them."))
                                    })
                                    .children(placements.into_iter().map(|(id, placement)| {
                                        let left = PAD_INSET_PX + placement.x as f32 * pad_range;
                                        let top = PAD_INSET_PX + (1.0 - placement.y as f32) * pad_range;
                                        let metadata = available_model_inventory(&self.providers.providers)
                                            .into_iter()
                                            .find(|entry| entry.value == id);
                                        let label = metadata.as_ref().map_or_else(
                                            || id.split_once("::").map_or(id.as_str(), |(_, model)| model).to_string(),
                                            |entry| entry.model.clone(),
                                        );
                                        let accessible_label = metadata.as_ref().map_or_else(
                                            || format!("{label}, positioned on Model Pad"),
                                            |entry| format!("{} from {}, positioned on Model Pad", entry.model, entry.provider_label),
                                        );
                                        let is_active = active_model.as_deref() == Some(id.as_str());
                                        let keyboard_id = id.clone();
                                        let drag = ModelChipDrag {
                                            model_id: id.clone(),
                                            start_x: placement.x,
                                            start_y: placement.y,
                                            pad_range,
                                            pointer: Rc::new(Cell::new(None)),
                                        };
                                        let settings = cx.entity();
                                        div()
                                            .absolute()
                                            .left(px(centered_origin(left, MODEL_CHIP_SLOT_WIDTH_PX)))
                                            .top(px(centered_origin(top, MODEL_CHIP_HEIGHT_PX)))
                                            .w(px(MODEL_CHIP_SLOT_WIDTH_PX))
                                            .h(px(MODEL_CHIP_HEIGHT_PX))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .child(
                                                div()
                                                    .id(SharedString::from(format!("model-pad-chip-{id}")))
                                                    .max_w(px(MODEL_CHIP_SLOT_WIDTH_PX))
                                                    .px_2()
                                                    .py_1()
                                                    .rounded_full()
                                                    .border_1()
                                                    .border_color(if is_active { theme.ring } else { theme.border.opacity(0.0) })
                                                    .bg(if placement.source == ModelPadPlacementSource::User {
                                                        theme.accent
                                                    } else {
                                                        theme.popover
                                                    })
                                                    .text_color(if placement.source == ModelPadPlacementSource::User {
                                                        theme.accent_foreground
                                                    } else {
                                                        theme.foreground
                                                    })
                                                    .text_xs()
                                                    .cursor_pointer()
                                                    .tab_stop(true)
                                                    .tooltip(move |window, cx| Tooltip::new(accessible_label.clone()).build(window, cx))
                                                    .focus(|style| style.border_color(theme.ring).bg(theme.list_active))
                                                    .on_drag(drag, |drag, position, _window, cx| {
                                                        drag.pointer.set(Some((position.x.as_f32(), position.y.as_f32())));
                                                        cx.new(|_| ModelChipDragView)
                                                    })
                                                    .on_drag_move(move |event: &gpui::DragMoveEvent<ModelChipDrag>, _window, cx| {
                                                        let drag = event.drag(cx).clone();
                                                        let Some((pointer_x, pointer_y)) = drag.pointer.get() else { return; };
                                                        settings.update(cx, |this, cx| {
                                                            if let Some(editor) = this.model_pad.editor.as_mut() {
                                                                let _ = editor.move_by(
                                                                    &drag.model_id,
                                                                    drag.start_x,
                                                                    drag.start_y,
                                                                    event.event.position.x.as_f32() - pointer_x,
                                                                    event.event.position.y.as_f32() - pointer_y,
                                                                    drag.pad_range,
                                                                );
                                                                cx.notify();
                                                            }
                                                        });
                                                    })
                                                    .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _window, cx| {
                                                        let Some(direction) = nudge_direction_for_key(event.keystroke.key.as_str()) else { return; };
                                                        if let Some(editor) = this.model_pad.editor.as_mut() {
                                                            let _ = editor.nudge(&keyboard_id, direction, event.keystroke.modifiers.shift);
                                                            cx.stop_propagation();
                                                            cx.notify();
                                                        }
                                                    }))
                                                    .child(label),
                                            )
                                    })),
                            )
                            .child(
                                h_flex()
                                    .justify_between()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("Faster")
                                    .child("More deliberate"),
                            ),
                    )
                    .child(
                        v_flex()
                            .id("model-pad-inventory")
                            .w(px(if layout == InventoryLayout::BesidePad { MODEL_PAD_INVENTORY_WIDTH_PX } else { pad_size }))
                            .max_h(px(400.))
                            .gap_1()
                            .child(Input::new(&filter_input).small())
                            .child(v_flex().id("model-pad-inventory-list").overflow_y_scroll().when(available.is_empty(), |el| {
                                el.child(div().px_2().py_4().text_sm().text_color(theme.muted_foreground).child(if inventory_count == 0 {
                                    "No usable chat models are available. Connect or discover a provider first."
                                } else {
                                    "No models match this filter."
                                }))
                            }).children(available.into_iter().map(|entry| {
                                let id = entry.value;
                                let on_pad = editor.draft().placements.contains_key(&id);
                                let label = entry.model;
                                h_flex()
                                    .id(SharedString::from(format!("model-pad-inventory-{id}")))
                                    .min_h(px(44.))
                                    .px_2()
                                    .gap_2()
                                    .items_center()
                                    .rounded_lg()
                                    .hover(|style| style.bg(theme.list_hover))
                                    .child(
                                        v_flex()
                                            .min_w(px(0.))
                                            .flex_1()
                                            .child(div().text_sm().child(label))
                                            .child(div().text_xs().text_color(theme.muted_foreground).child(format!("{} · {}", entry.provider_label, if entry.is_local { "Local" } else { "Hosted" }))),
                                    )
                                    .child(
                                        Button::new(SharedString::from(format!("model-pad-toggle-{id}")))
                                            .ghost()
                                            .small()
                                            .icon(if on_pad { IconName::Close } else { IconName::Plus })
                                            .tooltip(if on_pad { "Remove from Pad" } else { "Add to Pad" })
                                            .disabled(saving)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                if let Some(editor) = this.model_pad.editor.as_mut() {
                                                    if on_pad {
                                                        editor.remove_model(&id);
                                                    } else if let Err(error) = editor.add_model(&id) {
                                                        this.error = Some(format!("Couldn’t add model: {error:?}"));
                                                    }
                                                    cx.notify();
                                                }
                                            })),
                                    )
                            }))),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .child(
                        div().text_sm().text_color(theme.muted_foreground).child(
                            match self.model_data.aa.as_ref() {
                                None => "Checking the local benchmark cache…".to_string(),
                                Some(status) if !status.ready => "Artificial Analysis suggestions are off. Your personal Model Pad works without them.".to_string(),
                                Some(_) if suggestion_count == 0 => "No unplaced available models have cached benchmark positions.".to_string(),
                                Some(_) => format!("{suggestion_count} unplaced model{} can use cached benchmark positions.", if suggestion_count == 1 { "" } else { "s" }),
                            },
                        ),
                    )
                    .child(
                        Button::new("model-pad-suggest-unplaced")
                            .small()
                            .label(format!("Suggest unplaced ({suggestion_count})"))
                            .disabled(!suggestions_enabled || saving)
                            .on_click(cx.listener(|this, _, _, cx| {
                                let inventory = available_model_inventory(&this.providers.providers);
                                let suggestions = this
                                    .model_data
                                    .aa_catalog
                                    .as_ref()
                                    .map_or_else(Vec::new, |cache| offline_aa_placements(cache, &inventory));
                                if let Some(editor) = this.model_pad.editor.as_mut() {
                                    editor.apply_offline_aa_suggestions(&suggestions);
                                    cx.notify();
                                }
                            })),
                    ),
            )
            .when(unavailable > 0, |el| {
                el.child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Saved positions for temporarily unavailable models are retained and will return when those models are available again."),
                )
            })
            .when(editor.draft().placements.is_empty(), |el| el)
            .when(!editor.draft().placements.is_empty(), |el| {
                el.child(
                    Button::new("model-pad-clear")
                        .ghost()
                        .small()
                        .label("Remove all models from Pad")
                        .disabled(saving)
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(editor) = this.model_pad.editor.as_mut() {
                                editor.clear();
                                cx.notify();
                            }
                        })),
                )
            })
            .when_some(match save_state {
                ModelPadSaveState::Failed { failure, .. } => Some(failure.message),
                _ => None,
            }, |el, message| el.child(div().text_sm().text_color(theme.danger).child(message)))
            .child(self.aa_card(cx))
            .into_any_element()
    }

    fn save_model_pad(&mut self, cx: &mut Context<Self>) {
        let Some(operation) = self
            .model_pad
            .editor
            .as_mut()
            .and_then(ModelPadEditorState::request_save)
        else {
            return;
        };
        let store = self.services.model_pad.clone();
        let revision = operation.revision;
        let layout = operation.layout;
        let intent = store.begin_save_intent();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { store.save_if_current(intent, &layout) })
                .await;
            this.update(cx, |this, cx| {
                if let Some(editor) = this.model_pad.editor.as_mut() {
                    if complete_model_pad_store_save(editor, revision, result) {
                        let layout = editor.saved().clone();
                        if cx
                            .try_global::<crate::chat::model_pad_picker::ModelPadRuntime>()
                            .is_some()
                        {
                            cx.update_global::<crate::chat::model_pad_picker::ModelPadRuntime, _>(
                                |runtime, _cx| runtime.replace(layout),
                            );
                        }
                    }
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn provider(
        id: &str,
        label: &str,
        models: &[&str],
        needs_key: bool,
        has_key: bool,
    ) -> ProviderRow {
        ProviderRow {
            id: id.into(),
            kind: aiden_data::portable_config::ProviderKind::Openai,
            label: label.into(),
            base_url: String::new(),
            models: models.iter().map(|model| (*model).to_string()).collect(),
            default_model: None,
            needs_key,
            has_key,
            is_builtin: false,
            is_preset: false,
            deployment: aiden_data::portable_config::ProviderDeployment::Hosted,
            catalog_models: Vec::new(),
        }
    }

    fn editor() -> ModelPadEditorState {
        let mut layout = ModelPadLayout::empty();
        layout.placements.insert(
            "provider/personal".into(),
            ModelPadPlacement {
                x: 0.2,
                y: 0.3,
                source: ModelPadPlacementSource::User,
            },
        );
        ModelPadEditorState::new(
            layout,
            ["provider/personal".into(), "provider/suggested".into()],
        )
    }

    #[test]
    fn personal_placement_wins_over_offline_suggestion() {
        let mut editor = editor();
        let added = editor.apply_offline_aa_suggestions(&[
            OfflineAaPlacement {
                model_id: "provider/personal".into(),
                response_time_percentile: 0.9,
                capability_percentile: 0.9,
            },
            OfflineAaPlacement {
                model_id: "provider/suggested".into(),
                response_time_percentile: 0.8,
                capability_percentile: 0.7,
            },
        ]);

        assert_eq!(added, 1);
        assert_eq!(editor.draft().placements["provider/personal"].x, 0.2);
        assert_eq!(
            editor.draft().placements["provider/suggested"].source,
            ModelPadPlacementSource::ArtificialAnalysis
        );
    }

    #[test]
    fn catalog_change_retains_unavailable_position() {
        let mut editor = editor();
        let unavailable = editor.set_available_models(["provider/suggested".into()]);

        assert_eq!(unavailable, vec!["provider/personal"]);
        assert!(editor.draft().placements.contains_key("provider/personal"));
    }

    #[test]
    fn live_inventory_filters_unusable_providers_and_embedding_models() {
        let inventory = available_model_inventory(&[
            provider(
                "ready",
                "Ready",
                &["chat", "text-embedding-3-small"],
                true,
                true,
            ),
            provider("locked", "Locked", &["chat"], true, false),
        ]);

        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0].value, "ready::chat");
        assert_eq!(inventory[0].provider_label, "Ready");
    }

    #[test]
    fn inventory_filter_matches_visible_model_provider_and_encoded_id() {
        let entry = ModelInventoryEntry {
            value: "custom:provider::internal-id".into(),
            model: "Visible Model".into(),
            provider_label: "Local Lab".into(),
            is_local: true,
        };

        assert!(inventory_matches_filter(&entry, "visible"));
        assert!(inventory_matches_filter(&entry, "local lab"));
        assert!(inventory_matches_filter(&entry, "internal-id"));
        assert!(!inventory_matches_filter(&entry, "hosted"));
    }

    #[test]
    fn offline_cache_projects_only_ranked_available_models() {
        let cache: ArtificialAnalysisUserCache = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "source": {
                "name": "Artificial Analysis",
                "url": "https://artificialanalysis.ai",
                "endpoint": "https://artificialanalysis.ai/api/v2/data/llms/models",
                "generation": "generation-1",
                "fetched_at": "2026-08-10T00:00:00Z",
                "tier": "free",
                "intelligence_index_version": 4
            },
            "models": [{
                "id": "model-1",
                "slug": "model-1",
                "name": "Model 1",
                "creator": "Ready",
                "ranking": {
                    "capability_percentile": 0.8,
                    "response_time_percentile": 0.7,
                    "pace_metric": "median_end_to_end_response_time_seconds"
                }
            }, {
                "id": "unranked",
                "slug": "unranked",
                "name": "Unranked",
                "creator": "Ready"
            }]
        }))
        .unwrap();
        let inventory = vec![
            ModelInventoryEntry {
                value: "ready::model-1".into(),
                model: "model-1".into(),
                provider_label: "Ready".into(),
                is_local: false,
            },
            ModelInventoryEntry {
                value: "ready::missing".into(),
                model: "missing".into(),
                provider_label: "Ready".into(),
                is_local: false,
            },
        ];

        assert_eq!(
            offline_aa_placements(&cache, &inventory),
            vec![OfflineAaPlacement {
                model_id: "ready::model-1".into(),
                response_time_percentile: 0.7,
                capability_percentile: 0.8,
            }]
        );
    }

    #[test]
    fn suggestion_action_counts_only_unplaced_available_rows_and_requires_ready_cache() {
        let editor = editor();
        let suggestions = [
            OfflineAaPlacement {
                model_id: "provider/personal".into(),
                response_time_percentile: 0.2,
                capability_percentile: 0.3,
            },
            OfflineAaPlacement {
                model_id: "provider/suggested".into(),
                response_time_percentile: 0.7,
                capability_percentile: 0.8,
            },
            OfflineAaPlacement {
                model_id: "provider/unavailable".into(),
                response_time_percentile: 0.5,
                capability_percentile: 0.5,
            },
        ];

        assert_eq!(
            suggestion_action_state(None, &suggestions, &editor),
            (1, false)
        );
        assert_eq!(
            suggestion_action_state(Some(false), &suggestions, &editor),
            (1, false)
        );
        assert_eq!(
            suggestion_action_state(Some(true), &suggestions, &editor),
            (1, true)
        );
    }

    #[test]
    fn drag_changes_draft_without_creating_save_operation() {
        let mut editor = editor();
        editor
            .begin_drag(
                "provider/personal",
                PadBounds {
                    left: 10.0,
                    top: 20.0,
                    width: 100.0,
                    height: 100.0,
                },
            )
            .unwrap();

        assert!(editor.update_drag(110.0, 20.0));
        assert_eq!(editor.draft().placements["provider/personal"].x, 1.0);
        assert_eq!(editor.draft().placements["provider/personal"].y, 1.0);
        assert!(matches!(editor.save_state(), ModelPadSaveState::Dirty));
    }

    #[test]
    fn arrow_nudge_uses_four_or_ten_percent_and_clamps() {
        let mut editor = editor();
        let normal = editor
            .nudge("provider/personal", NudgeDirection::Right, false)
            .unwrap();
        let shifted = editor
            .nudge("provider/personal", NudgeDirection::Up, true)
            .unwrap();

        assert!((normal.x - 0.24).abs() < f64::EPSILON);
        assert!((shifted.y - 0.4).abs() < f64::EPSILON);
    }

    #[test]
    fn explicit_save_and_reset_have_distinct_semantics() {
        let mut editor = editor();
        editor
            .nudge("provider/personal", NudgeDirection::Right, false)
            .unwrap();
        let operation = editor.request_save().unwrap();
        assert!(editor.complete_save(operation.revision, Ok(())));
        editor
            .nudge("provider/personal", NudgeDirection::Right, false)
            .unwrap();

        editor.reset();

        assert_eq!(editor.draft(), editor.saved());
        assert!(matches!(editor.save_state(), ModelPadSaveState::Clean));
    }

    #[test]
    fn inventory_stacks_at_reference_breakpoint() {
        assert_eq!(inventory_layout(621.0), InventoryLayout::BesidePad);
        assert_eq!(inventory_layout(620.0), InventoryLayout::BelowPad);
    }

    #[test]
    fn responsive_content_width_accounts_for_wide_and_compact_settings_rails() {
        assert_eq!(model_pad_content_width(1000.0), 672.0);
        assert_eq!(
            inventory_layout(model_pad_content_width(700.0)),
            InventoryLayout::BesidePad
        );
        assert_eq!(model_pad_content_width(540.0), 500.0);
        assert_eq!(
            inventory_layout(model_pad_content_width(540.0)),
            InventoryLayout::BelowPad
        );
    }

    #[test]
    fn only_arrow_keys_map_to_pad_nudges() {
        assert_eq!(nudge_direction_for_key("left"), Some(NudgeDirection::Left));
        assert_eq!(nudge_direction_for_key("enter"), None);
    }

    #[test]
    fn dots_and_chip_slots_are_centered_on_saved_coordinates() {
        assert_eq!(centered_origin(32.0, 4.0), 30.0);
        assert_eq!(centered_origin(200.0, 112.0), 144.0);
        assert_eq!(centered_origin(200.0, 24.0), 188.0);
    }

    #[test]
    fn saving_locks_layout_edits_until_store_publication_completes() {
        let dir = tempdir().unwrap();
        let store = aiden_data::model_pad_store::ModelPadStore::new(Some(dir.path().to_path_buf()));
        let mut editor = editor();
        editor
            .nudge("provider/personal", NudgeDirection::Right, false)
            .unwrap();
        let operation = editor.request_save().unwrap();
        let frozen = editor.draft().clone();

        assert_eq!(
            editor.nudge("provider/personal", NudgeDirection::Up, false),
            Err(ModelPadEditError::SaveInProgress)
        );
        assert_eq!(
            editor.add_model("provider/new"),
            Err(ModelPadEditError::SaveInProgress)
        );
        assert!(!editor.remove_model("provider/personal"));
        editor.reset();
        editor.clear();
        assert_eq!(editor.draft(), &frozen);

        let intent = store.begin_save_intent();
        let result = store.save_if_current(intent, &operation.layout);
        assert!(complete_model_pad_store_save(
            &mut editor,
            operation.revision,
            result
        ));
        assert_eq!(store.load().unwrap(), frozen);
    }

    #[test]
    fn store_tokens_span_editor_lifetimes_and_stale_save_never_marks_saved() {
        let dir = tempdir().unwrap();
        let store = aiden_data::model_pad_store::ModelPadStore::new(Some(dir.path().to_path_buf()));
        let mut old_editor = editor();
        old_editor
            .nudge("provider/personal", NudgeDirection::Left, false)
            .unwrap();
        let old_operation = old_editor.request_save().unwrap();
        let old_intent = store.begin_save_intent();

        let mut new_editor = editor();
        new_editor
            .nudge("provider/personal", NudgeDirection::Up, false)
            .unwrap();
        let new_operation = new_editor.request_save().unwrap();
        let new_intent = store.begin_save_intent();

        let new_result = store.save_if_current(new_intent, &new_operation.layout);
        assert!(complete_model_pad_store_save(
            &mut new_editor,
            new_operation.revision,
            new_result
        ));
        let old_result = store.save_if_current(old_intent, &old_operation.layout);
        assert!(!complete_model_pad_store_save(
            &mut old_editor,
            old_operation.revision,
            old_result
        ));

        assert!(matches!(
            old_editor.save_state(),
            ModelPadSaveState::Saving(_)
        ));
        assert_eq!(store.load().unwrap(), new_operation.layout);
    }
}
