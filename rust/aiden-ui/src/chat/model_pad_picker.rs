//! Pure interaction state for the runtime two-dimensional model picker.
//!
//! A future GPUI view supplies focus/pointer capture and calls
//! `flush_pointer_frame` at most once per rendered frame. This state performs
//! no persistence or network work.

use std::rc::Rc;

use aiden_core::model_pad::ModelPadLayout;
use aiden_core::model_pad::MAX_PLACEMENTS;
use gpui::{
    relative, size, App, Bounds, CursorStyle, DispatchPhase, Element, ElementId, GlobalElementId,
    Hitbox, HitboxBehavior, InspectorElementId, IntoElement, LayoutId, MouseButton, MouseDownEvent,
    MouseExitEvent, MouseMoveEvent, MouseUpEvent, Pixels, Style, Window,
};

/// App-wide device-local snapshot shared by Settings and the composer picker.
/// It contains no provider state and never performs network access.
#[derive(Clone, Default)]
pub struct ModelPadRuntime {
    pub layout: ModelPadLayout,
    pub revision: u64,
}

impl gpui::Global for ModelPadRuntime {}

impl ModelPadRuntime {
    pub fn replace(&mut self, layout: ModelPadLayout) {
        self.layout = layout;
        self.revision = self.revision.saturating_add(1);
    }
}

const DIRECTION_EPSILON: f64 = 0.001;
const ORTHOGONAL_PENALTY: f64 = 2.25;
const POINTER_HYSTERESIS: f64 = 0.025;
const BASE_MODEL_GRID_SIZE: usize = 11;

/// Match the canonical picker lattice: retain the calm 11×11 reference grid,
/// expanding only when the positioned inventory needs more unique cells.
pub fn model_grid_size(model_count: usize) -> usize {
    let mut size = BASE_MODEL_GRID_SIZE;
    while size.saturating_mul(size) < model_count.max(1) {
        size += 1;
    }
    size
}

/// Return the nearest lattice column/row for a normalized Model Pad point.
/// Y is inverted because pad coordinates grow upward while layout grows down.
pub fn model_grid_axes(point: ModelPoint, grid_size: usize) -> (usize, usize) {
    let divisions = grid_size.saturating_sub(1).max(1) as f64;
    let column = (point.x.clamp(0.0, 1.0) * divisions).round() as usize;
    let row = ((1.0 - point.y.clamp(0.0, 1.0)) * divisions).round() as usize;
    (column, row)
}

pub fn model_grid_coordinate(index: usize, grid_size: usize) -> f32 {
    let divisions = grid_size.saturating_sub(1).max(1) as f32;
    0.07 + index as f32 / divisions * 0.86
}

#[derive(Debug, Clone, PartialEq)]
pub struct PositionedModel {
    pub model_id: String,
    pub x: f64,
    pub y: f64,
}

impl PositionedModel {
    fn valid(&self) -> bool {
        !self.model_id.is_empty()
            && self.x.is_finite()
            && self.y.is_finite()
            && (0.0..=1.0).contains(&self.x)
            && (0.0..=1.0).contains(&self.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPoint {
    pub x: f64,
    pub y: f64,
}

/// Pointer transitions emitted by the bounds-aware GPUI pad surface.
///
/// The surface owns the hitbox created during prepaint and registers global
/// mouse handlers during paint. That gives a started drag continuous motion
/// and a final mouse-up even after it leaves the pad bounds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PadPointerEvent {
    Down(ModelPoint),
    Move(ModelPoint),
    Up(ModelPoint),
    Leave,
    Cancel,
}

type PadPointerListener = Rc<dyn Fn(PadPointerEvent, &mut Window, &mut App)>;

/// A transparent, full-size interaction surface for a Model Pad.
///
/// Decoration remains declarative in the caller, while this low-level element
/// records the layout engine's final bounds in prepaint before converting
/// window-space pointer coordinates. It is intentionally the only pad-wide
/// hitbox: individual model dots are presentation, not commit controls.
pub struct BoundsAwarePadSurface {
    id: ElementId,
    listener: PadPointerListener,
}

impl BoundsAwarePadSurface {
    pub fn new(
        id: impl Into<ElementId>,
        listener: impl Fn(PadPointerEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            listener: Rc::new(listener),
        }
    }
}

impl IntoElement for BoundsAwarePadSurface {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for BoundsAwarePadSurface {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        (
            window.request_layout(
                Style {
                    size: size(relative(1.0).into(), relative(1.0).into()),
                    ..Default::default()
                },
                [],
                cx,
            ),
            (),
        )
    }

    fn prepaint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        window.set_cursor_style(CursorStyle::Crosshair, &hitbox);
        hitbox
    }

    fn paint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        hitbox: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let to_point = move |position: gpui::Point<Pixels>| {
            point_from_pad_bounds(
                position.x.into(),
                position.y.into(),
                bounds.origin.x.into(),
                bounds.origin.y.into(),
                bounds.size.width.into(),
                bounds.size.height.into(),
            )
        };
        let listener = self.listener.clone();
        let down_hitbox = hitbox.clone();
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble
                && event.button == MouseButton::Left
                && down_hitbox.is_hovered(window)
            {
                if let Some(point) = to_point(event.position) {
                    listener(PadPointerEvent::Down(point), window, cx);
                    cx.stop_propagation();
                }
            }
        });

        let listener = self.listener.clone();
        let move_hitbox = hitbox.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, _phase, window, cx| {
            if let Some(point) = to_point(event.position) {
                listener(PadPointerEvent::Move(point), window, cx);
            }
            if !move_hitbox.is_hovered(window) {
                // A dragging state deliberately ignores Leave, but still got
                // the clamped Move above. Hover-only previews roll back.
                listener(PadPointerEvent::Leave, window, cx);
            }
        });

        let listener = self.listener.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _window, cx| {
            if phase == DispatchPhase::Capture && event.button == MouseButton::Left {
                if let Some(point) = to_point(event.position) {
                    listener(PadPointerEvent::Up(point), _window, cx);
                }
            }
        });

        let listener = self.listener.clone();
        window.on_mouse_event(move |_event: &MouseExitEvent, phase, window, cx| {
            if phase == DispatchPhase::Capture {
                listener(PadPointerEvent::Cancel, window, cx);
            }
        });
    }
}

/// Convert window-space coordinates into the pad's 7–93% interaction lattice.
/// The custom GPUI pad element supplies its prepaint bounds here, keeping the
/// coordinate math independent of rendering and readily testable.
pub fn point_from_pad_bounds(
    pointer_x: f64,
    pointer_y: f64,
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
) -> Option<ModelPoint> {
    if !(width.is_finite() && height.is_finite()) || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let inset = 0.07;
    let range = 0.86;
    let x = ((pointer_x - origin_x) / width - inset) / range;
    let y = 1.0 - ((pointer_y - origin_y) / height - inset) / range;
    Some(ModelPoint {
        x: x.clamp(0.0, 1.0),
        y: y.clamp(0.0, 1.0),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelDirection {
    Left,
    Right,
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelPadKey {
    Arrow(ModelDirection),
    Enter,
    Space,
    Escape,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelPadPickerOutcome {
    Unchanged,
    Previewed(String),
    Committed(String),
    RolledBack(Option<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelPadPickerError {
    TooManyModels,
    InvalidModel,
    DuplicateModel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelPadInitialFocus {
    Pad,
    ListFilter,
}

/// Electron opens directly into the personal Pad when it has models;
/// otherwise focus lands in the searchable list.
pub const fn initial_focus(has_pad_models: bool) -> ModelPadInitialFocus {
    if has_pad_models {
        ModelPadInitialFocus::Pad
    } else {
        ModelPadInitialFocus::ListFilter
    }
}

/// Entity-ready runtime picker state. The opening selection remains the
/// Escape/pointer-cancel rollback target until a commit is accepted.
pub struct ModelPadPickerState {
    models: Vec<PositionedModel>,
    opening_selection: Option<String>,
    preview: Option<String>,
    dragging: bool,
    queued_pointer: Option<ModelPoint>,
}

impl ModelPadPickerState {
    pub fn new(
        models: Vec<PositionedModel>,
        selected: Option<String>,
    ) -> Result<Self, ModelPadPickerError> {
        if models.len() > MAX_PLACEMENTS {
            return Err(ModelPadPickerError::TooManyModels);
        }
        if models.iter().any(|model| !model.valid()) {
            return Err(ModelPadPickerError::InvalidModel);
        }
        let mut ids = models
            .iter()
            .map(|model| model.model_id.as_str())
            .collect::<Vec<_>>();
        ids.sort_unstable();
        if ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(ModelPadPickerError::DuplicateModel);
        }
        let selected = selected.filter(|id| models.iter().any(|model| &model.model_id == id));
        let preview = selected
            .clone()
            .or_else(|| models.first().map(|model| model.model_id.clone()));
        Ok(Self {
            preview,
            opening_selection: selected,
            models,
            dragging: false,
            queued_pointer: None,
        })
    }

    pub fn preview(&self) -> Option<&str> {
        self.preview.as_deref()
    }

    pub fn is_dragging(&self) -> bool {
        self.dragging
    }

    pub fn handle_key(&mut self, key: ModelPadKey) -> ModelPadPickerOutcome {
        match key {
            ModelPadKey::Arrow(direction) => {
                let next = find_directional_model(&self.models, self.preview.as_deref(), direction)
                    .map(|model| model.model_id.clone());
                self.preview_model(next)
            }
            ModelPadKey::Enter | ModelPadKey::Space => self.commit_preview(),
            ModelPadKey::Escape => self.rollback(),
        }
    }

    /// Pointer down should be paired with GPUI pointer capture and focus.
    pub fn pointer_down(&mut self, point: ModelPoint) -> ModelPadPickerOutcome {
        self.dragging = true;
        self.queued_pointer = None;
        let next = nearest_model(
            &self.models,
            point,
            self.preview.as_deref(),
            POINTER_HYSTERESIS,
        )
        .map(|model| model.model_id.clone());
        self.preview_model(next)
    }

    /// Queue pointer motion; the GPUI view schedules one frame flush. This
    /// prevents high-frequency events from causing repeated render work.
    pub fn queue_pointer_move(&mut self, point: ModelPoint) {
        self.queued_pointer = Some(point);
    }

    pub fn flush_pointer_frame(&mut self) -> ModelPadPickerOutcome {
        let Some(point) = self.queued_pointer.take() else {
            return ModelPadPickerOutcome::Unchanged;
        };
        let next = nearest_model(
            &self.models,
            point,
            self.preview.as_deref(),
            POINTER_HYSTERESIS,
        )
        .map(|model| model.model_id.clone());
        self.preview_model(next)
    }

    pub fn pointer_up(&mut self, point: ModelPoint) -> ModelPadPickerOutcome {
        if !self.dragging {
            return ModelPadPickerOutcome::Unchanged;
        }
        self.queued_pointer = Some(point);
        let _ = self.flush_pointer_frame();
        self.dragging = false;
        self.commit_preview()
    }

    pub fn pointer_cancel(&mut self) -> ModelPadPickerOutcome {
        if !self.dragging {
            return ModelPadPickerOutcome::Unchanged;
        }
        self.dragging = false;
        self.queued_pointer = None;
        self.rollback()
    }

    /// Non-drag mouse leave restores the opening selection just like Electron.
    pub fn pointer_leave(&mut self) -> ModelPadPickerOutcome {
        if self.dragging {
            ModelPadPickerOutcome::Unchanged
        } else {
            self.queued_pointer = None;
            self.rollback()
        }
    }

    fn preview_model(&mut self, model_id: Option<String>) -> ModelPadPickerOutcome {
        let Some(model_id) = model_id else {
            return ModelPadPickerOutcome::Unchanged;
        };
        if self.preview.as_deref() == Some(model_id.as_str()) {
            return ModelPadPickerOutcome::Unchanged;
        }
        self.preview = Some(model_id.clone());
        ModelPadPickerOutcome::Previewed(model_id)
    }

    fn commit_preview(&mut self) -> ModelPadPickerOutcome {
        let Some(model_id) = self.preview.clone() else {
            return ModelPadPickerOutcome::Unchanged;
        };
        self.opening_selection = Some(model_id.clone());
        ModelPadPickerOutcome::Committed(model_id)
    }

    fn rollback(&mut self) -> ModelPadPickerOutcome {
        if self.preview == self.opening_selection {
            return ModelPadPickerOutcome::Unchanged;
        }
        self.preview = self.opening_selection.clone();
        ModelPadPickerOutcome::RolledBack(self.preview.clone())
    }
}

pub fn nearest_model<'a>(
    models: &'a [PositionedModel],
    point: ModelPoint,
    current_id: Option<&str>,
    hysteresis: f64,
) -> Option<&'a PositionedModel> {
    let nearest = models.iter().min_by(|left, right| {
        squared_distance(left, point)
            .total_cmp(&squared_distance(right, point))
            .then_with(|| left.model_id.cmp(&right.model_id))
    })?;
    let current = current_id.and_then(|id| models.iter().find(|model| model.model_id == id));
    if let Some(current) = current {
        if current.model_id != nearest.model_id {
            let current_distance = squared_distance(current, point).sqrt();
            let nearest_distance = squared_distance(nearest, point).sqrt();
            if current_distance - nearest_distance < hysteresis {
                return Some(current);
            }
        }
    }
    Some(nearest)
}

pub fn find_directional_model<'a>(
    models: &'a [PositionedModel],
    current_id: Option<&str>,
    direction: ModelDirection,
) -> Option<&'a PositionedModel> {
    let current = current_id
        .and_then(|id| models.iter().find(|model| model.model_id == id))
        .or_else(|| models.first())?;
    models
        .iter()
        .filter(|candidate| candidate.model_id != current.model_id)
        .filter(|candidate| match direction {
            ModelDirection::Left => candidate.x < current.x - DIRECTION_EPSILON,
            ModelDirection::Right => candidate.x > current.x + DIRECTION_EPSILON,
            ModelDirection::Up => candidate.y > current.y + DIRECTION_EPSILON,
            ModelDirection::Down => candidate.y < current.y - DIRECTION_EPSILON,
        })
        .min_by(|left, right| {
            directional_score(current, left, direction)
                .total_cmp(&directional_score(current, right, direction))
                .then_with(|| left.model_id.cmp(&right.model_id))
        })
        .or(Some(current))
}

fn directional_score(
    current: &PositionedModel,
    candidate: &PositionedModel,
    direction: ModelDirection,
) -> f64 {
    let dx = (candidate.x - current.x).abs();
    let dy = (candidate.y - current.y).abs();
    let (primary, orthogonal) = match direction {
        ModelDirection::Left | ModelDirection::Right => (dx, dy),
        ModelDirection::Up | ModelDirection::Down => (dy, dx),
    };
    primary + orthogonal * ORTHOGONAL_PENALTY
}

fn squared_distance(model: &PositionedModel, point: ModelPoint) -> f64 {
    (model.x - point.x).powi(2) + (model.y - point.y).powi(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Vec<PositionedModel> {
        vec![
            PositionedModel {
                model_id: "center".into(),
                x: 0.5,
                y: 0.5,
            },
            PositionedModel {
                model_id: "right".into(),
                x: 0.8,
                y: 0.5,
            },
            PositionedModel {
                model_id: "upper-right".into(),
                x: 0.65,
                y: 0.8,
            },
        ]
    }

    #[test]
    fn directional_navigation_penalizes_orthogonal_distance() {
        let models = models();
        let next = find_directional_model(&models, Some("center"), ModelDirection::Right);

        assert_eq!(next.unwrap().model_id, "right");
    }

    #[test]
    fn enter_and_space_commit_the_preview() {
        let mut picker = ModelPadPickerState::new(models(), Some("center".into())).unwrap();
        picker.handle_key(ModelPadKey::Arrow(ModelDirection::Right));

        assert_eq!(
            picker.handle_key(ModelPadKey::Enter),
            ModelPadPickerOutcome::Committed("right".into())
        );
        assert_eq!(
            picker.handle_key(ModelPadKey::Space),
            ModelPadPickerOutcome::Committed("right".into())
        );
    }

    #[test]
    fn escape_rolls_preview_back_to_opening_selection() {
        let mut picker = ModelPadPickerState::new(models(), Some("center".into())).unwrap();
        picker.handle_key(ModelPadKey::Arrow(ModelDirection::Right));

        assert_eq!(
            picker.handle_key(ModelPadKey::Escape),
            ModelPadPickerOutcome::RolledBack(Some("center".into()))
        );
    }

    #[test]
    fn pointer_motion_is_queued_until_one_frame_flush() {
        let mut picker = ModelPadPickerState::new(models(), Some("center".into())).unwrap();
        picker.queue_pointer_move(ModelPoint { x: 0.8, y: 0.5 });
        picker.queue_pointer_move(ModelPoint { x: 0.65, y: 0.8 });

        assert_eq!(picker.preview(), Some("center"));
        assert_eq!(
            picker.flush_pointer_frame(),
            ModelPadPickerOutcome::Previewed("upper-right".into())
        );
    }

    #[test]
    fn pointer_cancel_rolls_back_without_commit() {
        let mut picker = ModelPadPickerState::new(models(), Some("center".into())).unwrap();
        picker.pointer_down(ModelPoint { x: 0.8, y: 0.5 });

        assert_eq!(
            picker.pointer_cancel(),
            ModelPadPickerOutcome::RolledBack(Some("center".into()))
        );
    }

    #[test]
    fn non_drag_hover_only_previews_after_a_frame_and_never_commits() {
        let mut picker = ModelPadPickerState::new(models(), Some("center".into())).unwrap();
        picker.queue_pointer_move(ModelPoint { x: 0.8, y: 0.5 });

        assert_eq!(
            picker.flush_pointer_frame(),
            ModelPadPickerOutcome::Previewed("right".into())
        );
        assert_eq!(picker.preview(), Some("right"));
        assert_eq!(
            picker.pointer_leave(),
            ModelPadPickerOutcome::RolledBack(Some("center".into()))
        );
    }

    #[test]
    fn pointer_up_is_the_only_pointer_commit_boundary() {
        let mut picker = ModelPadPickerState::new(models(), Some("center".into())).unwrap();
        assert_eq!(
            picker.pointer_down(ModelPoint { x: 0.8, y: 0.5 }),
            ModelPadPickerOutcome::Previewed("right".into())
        );
        assert_eq!(
            picker.pointer_up(ModelPoint { x: 0.8, y: 0.5 }),
            ModelPadPickerOutcome::Committed("right".into())
        );
    }

    #[test]
    fn captured_drag_commits_the_final_outside_point() {
        let mut picker = ModelPadPickerState::new(models(), Some("center".into())).unwrap();
        picker.pointer_down(ModelPoint { x: 0.5, y: 0.5 });
        picker.queue_pointer_move(ModelPoint { x: 0.8, y: 0.5 });

        assert_eq!(
            picker.pointer_up(ModelPoint { x: 1.0, y: 0.5 }),
            ModelPadPickerOutcome::Committed("right".into())
        );
        assert!(!picker.is_dragging());
    }

    #[test]
    fn bounds_mapping_uses_inset_and_inverts_y() {
        assert_eq!(
            point_from_pad_bounds(7.0, 93.0, 0.0, 0.0, 100.0, 100.0),
            Some(ModelPoint { x: 0.0, y: 0.0 })
        );
        assert_eq!(
            point_from_pad_bounds(93.0, 7.0, 0.0, 0.0, 100.0, 100.0),
            Some(ModelPoint { x: 1.0, y: 1.0 })
        );
    }

    #[test]
    fn grid_expands_from_the_positioned_inventory_and_maps_active_axes() {
        assert_eq!(model_grid_size(0), 11);
        assert_eq!(model_grid_size(121), 11);
        assert_eq!(model_grid_size(122), 12);
        assert_eq!(model_grid_axes(ModelPoint { x: 0.8, y: 0.3 }, 11), (8, 7));
        assert_eq!(model_grid_coordinate(0, 11), 0.07);
        assert!((model_grid_coordinate(10, 11) - 0.93).abs() < f32::EPSILON);
    }

    #[test]
    fn constructor_enforces_layout_bound() {
        let too_many = (0..=MAX_PLACEMENTS)
            .map(|index| PositionedModel {
                model_id: format!("model-{index}"),
                x: 0.5,
                y: 0.5,
            })
            .collect();

        assert!(matches!(
            ModelPadPickerState::new(too_many, None),
            Err(ModelPadPickerError::TooManyModels)
        ));
    }

    #[test]
    fn initial_focus_matches_pad_availability() {
        assert_eq!(initial_focus(true), ModelPadInitialFocus::Pad);
        assert_eq!(initial_focus(false), ModelPadInitialFocus::ListFilter);
    }

    #[test]
    fn unplaced_accepted_model_falls_back_to_first_positioned_model() {
        let mut picker = ModelPadPickerState::new(models(), Some("not-on-pad".into())).unwrap();

        assert_eq!(picker.preview(), Some("center"));
        assert_eq!(
            picker.handle_key(ModelPadKey::Enter),
            ModelPadPickerOutcome::Committed("center".into())
        );
    }
}
