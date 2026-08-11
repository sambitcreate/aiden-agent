//! Exact assistant-facing Computer Use tool contract.

use serde_json::{json, Value};

pub const COMPUTER_USE_TOOL_NAME: &str = "computer_use";
pub const COMPUTER_USE_TOOL_DESCRIPTION: &str = "Use native macOS apps in the background through Aiden's pinned Computer Use helper. Capture a window first with an app or exact pid/window_id, then act by its zero-based element index when possible. Mutating actions always require the user's approval.";

pub const COMPUTER_USE_ACTIONS: &[&str] = &[
    "capture",
    "click",
    "double_click",
    "right_click",
    "middle_click",
    "drag",
    "scroll",
    "type",
    "key",
    "set_value",
    "wait",
    "list_apps",
    "list_windows",
    "focus_app",
];

/// The model receives no lifecycle, authentication, filesystem, or process
/// fields. The safety normalizer validates action-specific combinations again.
pub fn computer_use_parameters_schema() -> Value {
    let coordinate = json!({
        "type": "array",
        "prefixItems": [
            { "type": "number", "minimum": 0 },
            { "type": "number", "minimum": 0 }
        ],
        "minItems": 2,
        "maxItems": 2
    });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["action"],
        "properties": {
            "action": { "type": "string", "enum": COMPUTER_USE_ACTIONS },
            "mode": { "type": "string", "enum": ["som", "vision", "ax"] },
            "app": { "type": "string", "minLength": 1, "maxLength": 512 },
            "pid": { "type": "integer", "minimum": 1 },
            "window_id": { "type": "integer", "minimum": 1 },
            "max_elements": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
            "element": { "type": "integer", "minimum": 0 },
            "coordinate": coordinate.clone(),
            "button": { "type": "string", "enum": ["left", "right", "middle"] },
            "modifiers": {
                "type": "array",
                "maxItems": 4,
                "uniqueItems": true,
                "items": {
                    "type": "string",
                    "enum": ["cmd", "command", "shift", "option", "alt", "ctrl", "control", "fn", "win", "windows", "super", "meta"]
                }
            },
            "from_element": { "type": "integer", "minimum": 0 },
            "to_element": { "type": "integer", "minimum": 0 },
            "from_coordinate": coordinate.clone(),
            "to_coordinate": coordinate,
            "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
            "amount": { "type": "integer", "minimum": 1, "maximum": 50, "default": 3 },
            "value": { "type": "string", "maxLength": 4000 },
            "text": { "type": "string", "maxLength": 4000 },
            "keys": { "type": "string", "minLength": 1, "maxLength": 256 },
            "seconds": { "type": "number", "minimum": 0, "maximum": 30, "default": 1 },
            "raise_window": { "type": "boolean" },
            "delivery_mode": { "type": "string", "enum": ["background", "foreground"] },
            "bring_to_front": { "type": "boolean" },
            "capture_after": { "type": "boolean" }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn schema_is_exact_and_has_no_private_surface() {
        let schema = computer_use_parameters_schema();
        assert_eq!(schema["additionalProperties"], false);
        let actions = schema["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(actions, COMPUTER_USE_ACTIONS.iter().copied().collect());
        let properties = schema["properties"].as_object().unwrap();
        for private in [
            "session",
            "token",
            "socket",
            "command",
            "path",
            "environment",
        ] {
            assert!(!properties.contains_key(private));
        }
    }

    #[test]
    fn payload_bounds_match_the_safety_contract() {
        let schema = computer_use_parameters_schema();
        assert_eq!(schema["properties"]["text"]["maxLength"], 4000);
        assert_eq!(schema["properties"]["value"]["maxLength"], 4000);
        assert_eq!(schema["properties"]["seconds"]["maximum"], 30);
        assert_eq!(schema["properties"]["max_elements"]["maximum"], 1000);
    }
}
