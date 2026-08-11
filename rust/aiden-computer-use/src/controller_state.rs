//! Generation-owned Computer Use target and one-use grant state.
//!
//! Screenshots and accessibility payloads are deliberately absent. Only the
//! exact window identity and metadata required to fence later actions remain.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;

use crate::{
    computer_use_needs_approval, normalize_computer_use_args, summarize_computer_use_approval,
    ComputerUseBoundTarget, ComputerUseGrantConsumed, ComputerUseGrantLedger,
    ComputerUseGrantPrepared, ComputerUseSafetyError,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseTargetSnapshot {
    pub pid: i64,
    pub window_id: i64,
    pub app: Option<String>,
    pub title: Option<String>,
    pub screenshot_width: Option<u32>,
    pub screenshot_height: Option<u32>,
    pub element_indices: HashSet<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseApprovalDescriptor {
    pub summary: String,
    pub target: ComputerUseBoundTarget,
    pub app: Option<String>,
    pub title: Option<String>,
    pub grant: ComputerUseGrantPrepared,
}

#[derive(Debug, thiserror::Error)]
pub enum ComputerUseControllerStateError {
    #[error(transparent)]
    Safety(#[from] ComputerUseSafetyError),
    #[error("No active window. Capture or focus an app before this action.")]
    TargetRequired,
    #[error("The requested element is not present in the latest capture.")]
    StaleElement,
    #[error("Pixel coordinates require a fresh screenshot of this exact window.")]
    SnapshotRequired,
    #[error("The coordinate falls outside the latest captured window.")]
    CoordinateOutOfBounds,
    #[error("The focus target was not resolved before approval.")]
    FocusTargetRequired,
}

pub struct ComputerUseControllerState {
    revision: Arc<AtomicU64>,
    target: Option<ComputerUseTargetSnapshot>,
    grants: ComputerUseGrantLedger,
}

impl ComputerUseControllerState {
    pub fn new(generation_id: impl Into<String>) -> Self {
        let revision = Arc::new(AtomicU64::new(0));
        let ledger_revision = Arc::clone(&revision);
        Self {
            revision,
            target: None,
            grants: ComputerUseGrantLedger::new(
                generation_id,
                Box::new(move || ledger_revision.load(Ordering::Acquire)),
            ),
        }
    }

    pub fn target_revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    pub fn target(&self) -> Option<&ComputerUseTargetSnapshot> {
        self.target.as_ref()
    }

    pub fn publish_capture(&mut self, target: ComputerUseTargetSnapshot) {
        self.bump_revision();
        self.target = Some(target);
    }

    pub fn clear_target(&mut self) {
        self.bump_revision();
        self.target = None;
        self.grants.clear();
    }

    pub fn mutation_succeeded(&mut self) {
        self.bump_revision();
        if let Some(target) = self.target.as_mut() {
            target.screenshot_width = None;
            target.screenshot_height = None;
            target.element_indices.clear();
        }
        self.grants.clear();
    }

    pub fn approval_for(
        &mut self,
        args: &Value,
        focus_preview: Option<&ComputerUseTargetSnapshot>,
    ) -> Result<Option<ComputerUseApprovalDescriptor>, ComputerUseControllerStateError> {
        let normalized = normalize_computer_use_args(args)?;
        if !computer_use_needs_approval(&normalized) {
            return Ok(None);
        }
        let focus = normalized.get("action").and_then(Value::as_str) == Some("focus_app");
        let target = if focus {
            focus_preview.ok_or(ComputerUseControllerStateError::FocusTargetRequired)?
        } else {
            let target = self
                .target
                .as_ref()
                .ok_or(ComputerUseControllerStateError::TargetRequired)?;
            validate_target(&normalized, target)?;
            target
        };
        let bound = ComputerUseBoundTarget {
            pid: target.pid,
            window_id: target.window_id,
        };
        let grant = self.grants.prepare(&normalized, focus.then_some(bound))?;
        let app = target.app.clone();
        let title = target.title.clone();
        let target_summary = format!(
            "{}{}, pid {}, window {}",
            serde_json::to_string(app.as_deref().unwrap_or("Unknown app")).unwrap_or_default(),
            title
                .as_deref()
                .map(|title| format!(
                    ", title {}",
                    serde_json::to_string(title).unwrap_or_default()
                ))
                .unwrap_or_default(),
            target.pid,
            target.window_id
        );
        Ok(Some(ComputerUseApprovalDescriptor {
            summary: format!(
                "{} — {target_summary}",
                summarize_computer_use_approval(&normalized)?
            ),
            target: bound,
            app,
            title,
            grant,
        }))
    }

    pub fn authorize(
        &mut self,
        tool_call_id: &str,
        args: &Value,
        approval: &ComputerUseApprovalDescriptor,
    ) -> Result<(), ComputerUseControllerStateError> {
        self.grants.authorize(tool_call_id, args, &approval.grant)?;
        Ok(())
    }

    pub fn consume(
        &mut self,
        tool_call_id: &str,
        args: &Value,
    ) -> Result<ComputerUseGrantConsumed, ComputerUseControllerStateError> {
        Ok(self.grants.consume(tool_call_id, args)?)
    }

    pub fn close(&mut self) {
        self.clear_target();
    }

    fn bump_revision(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
    }
}

fn validate_target(
    args: &Value,
    target: &ComputerUseTargetSnapshot,
) -> Result<(), ComputerUseControllerStateError> {
    match args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "click" | "double_click" | "right_click" | "middle_click" | "scroll" => {
            validate_element(args.get("element"), target)?;
            validate_coordinate(args.get("coordinate"), target)?;
        }
        "drag" => {
            validate_element(args.get("from_element"), target)?;
            validate_element(args.get("to_element"), target)?;
            validate_coordinate(args.get("from_coordinate"), target)?;
            validate_coordinate(args.get("to_coordinate"), target)?;
        }
        "set_value" => validate_element(args.get("element"), target)?,
        _ => {}
    }
    Ok(())
}

fn validate_element(
    value: Option<&Value>,
    target: &ComputerUseTargetSnapshot,
) -> Result<(), ComputerUseControllerStateError> {
    let Some(index) = value.and_then(Value::as_i64) else {
        return Ok(());
    };
    target
        .element_indices
        .contains(&index)
        .then_some(())
        .ok_or(ComputerUseControllerStateError::StaleElement)
}

fn validate_coordinate(
    value: Option<&Value>,
    target: &ComputerUseTargetSnapshot,
) -> Result<(), ComputerUseControllerStateError> {
    let Some(parts) = value.and_then(Value::as_array) else {
        return Ok(());
    };
    let (Some(width), Some(height)) = (target.screenshot_width, target.screenshot_height) else {
        return Err(ComputerUseControllerStateError::SnapshotRequired);
    };
    let x = parts
        .first()
        .and_then(Value::as_f64)
        .unwrap_or(f64::INFINITY);
    let y = parts
        .get(1)
        .and_then(Value::as_f64)
        .unwrap_or(f64::INFINITY);
    if x < f64::from(width) && y < f64::from(height) {
        Ok(())
    } else {
        Err(ComputerUseControllerStateError::CoordinateOutOfBounds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target() -> ComputerUseTargetSnapshot {
        ComputerUseTargetSnapshot {
            pid: 42,
            window_id: 7,
            app: Some("Notes".into()),
            title: Some("Draft".into()),
            screenshot_width: Some(800),
            screenshot_height: Some(600),
            element_indices: HashSet::from([0, 2]),
        }
    }

    #[test]
    fn grant_is_bound_to_revision_arguments_and_one_use() {
        let mut state = ComputerUseControllerState::new("generation");
        state.publish_capture(target());
        let args = json!({ "action": "click", "element": 2 });
        let approval = state.approval_for(&args, None).unwrap().unwrap();
        state.authorize("call", &args, &approval).unwrap();
        state.consume("call", &args).unwrap();
        assert!(state.consume("call", &args).is_err());
        let approval = state.approval_for(&args, None).unwrap().unwrap();
        state.mutation_succeeded();
        assert!(state.authorize("late", &args, &approval).is_err());
    }

    #[test]
    fn stale_elements_and_pixels_fail_closed() {
        let mut state = ComputerUseControllerState::new("generation");
        state.publish_capture(target());
        assert!(state
            .approval_for(&json!({ "action": "click", "element": 1 }), None)
            .is_err());
        assert!(state
            .approval_for(&json!({ "action": "click", "coordinate": [800, 0] }), None)
            .is_err());
        state.mutation_succeeded();
        assert!(state
            .approval_for(&json!({ "action": "click", "coordinate": [1, 1] }), None)
            .is_err());
    }

    #[test]
    fn retained_state_has_no_capture_payload() {
        let encoded = format!("{:?}", target().element_indices);
        assert!(!encoded.contains("screenshot"));
        assert!(!encoded.contains("accessibility"));
        assert!(!encoded.contains("base64"));
    }
}
