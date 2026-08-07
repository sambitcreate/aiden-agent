//! Port of `renderer/shared/google-thinking.ts` — Google's native thinking
//! levels; "off" remains Aiden's no-exposed-thoughts state.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const GOOGLE_THINKING_LEVELS: &[GoogleThinkingLevel] = &[
    GoogleThinkingLevel::Off,
    GoogleThinkingLevel::Low,
    GoogleThinkingLevel::Medium,
    GoogleThinkingLevel::High,
];

pub const DEFAULT_GOOGLE_THINKING_LEVEL: GoogleThinkingLevel = GoogleThinkingLevel::Off;

const MAX_THINKING_MODEL_PREFERENCES: usize = 256;
const MAX_MODEL_ID_CHARS: usize = 256;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum GoogleThinkingLevel {
    Off,
    Low,
    Medium,
    High,
}

impl GoogleThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            GoogleThinkingLevel::Off => "off",
            GoogleThinkingLevel::Low => "low",
            GoogleThinkingLevel::Medium => "medium",
            GoogleThinkingLevel::High => "high",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "off" => Some(GoogleThinkingLevel::Off),
            "low" => Some(GoogleThinkingLevel::Low),
            "medium" => Some(GoogleThinkingLevel::Medium),
            "high" => Some(GoogleThinkingLevel::High),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GoogleThinkingModelCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<BTreeMap<String, Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GoogleThinkingError {
    message: String,
}

impl GoogleThinkingError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub fn is_google_thinking_level(value: &Value) -> bool {
    match value.as_str() {
        Some(value) => GoogleThinkingLevel::from_str(value).is_some(),
        None => false,
    }
}

/// Keep the UI/request contract aligned with Pi's model-specific native
/// levels.
pub fn google_thinking_levels_for_model(
    model: &GoogleThinkingModelCapabilities,
) -> Vec<GoogleThinkingLevel> {
    if model.reasoning != Some(true) {
        return Vec::new();
    }
    GOOGLE_THINKING_LEVELS
        .iter()
        .copied()
        .filter(|level| {
            *level == GoogleThinkingLevel::Off
                || !matches!(
                    model
                        .thinking_level_map
                        .as_ref()
                        .and_then(|map| map.get(level.as_str()).cloned()),
                    Some(None)
                )
        })
        .collect()
}

pub fn google_thinking_can_disable(model: &GoogleThinkingModelCapabilities) -> bool {
    model.reasoning == Some(true)
        && !matches!(
            model
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get("off")),
            Some(None)
        )
}

pub fn normalize_google_thinking_level(
    levels: &[GoogleThinkingLevel],
    value: &Value,
) -> GoogleThinkingLevel {
    if let Some(parsed) = value.as_str().and_then(GoogleThinkingLevel::from_str) {
        if levels.contains(&parsed) {
            return parsed;
        }
    }
    levels
        .first()
        .copied()
        .unwrap_or(DEFAULT_GOOGLE_THINKING_LEVEL)
}

/// Parse the complete device-local preference map before it crosses into
/// persistence.
pub fn parse_google_thinking_preferences(
    value: &Value,
) -> Result<BTreeMap<String, GoogleThinkingLevel>, GoogleThinkingError> {
    let Some(object) = value.as_object() else {
        return Err(GoogleThinkingError::new(
            "Invalid Google thinking preferences.",
        ));
    };
    if object.len() > MAX_THINKING_MODEL_PREFERENCES {
        return Err(GoogleThinkingError::new(
            "Too many Google thinking preferences.",
        ));
    }
    let mut parsed = BTreeMap::new();
    for (model_id, level) in object {
        let parsed_level = level.as_str().and_then(GoogleThinkingLevel::from_str);
        if model_id.is_empty()
            || model_id.chars().count() > MAX_MODEL_ID_CHARS
            || parsed_level.is_none()
        {
            return Err(GoogleThinkingError::new(
                "Invalid Google thinking preference.",
            ));
        }
        parsed.insert(model_id.clone(), parsed_level.unwrap());
    }
    Ok(parsed)
}

pub fn merge_google_thinking_preference(
    current: &Value,
    model_id: &str,
    level: GoogleThinkingLevel,
) -> Result<BTreeMap<String, Value>, GoogleThinkingError> {
    let mut entries: Vec<(String, Value)> = match current.as_object() {
        Some(object) => object
            .iter()
            .filter(|(id, _)| {
                !id.is_empty() && id.chars().count() <= MAX_MODEL_ID_CHARS && *id != model_id
            })
            .map(|(id, value)| (id.clone(), value.clone()))
            .collect(),
        None => Vec::new(),
    };
    if entries.len() >= MAX_THINKING_MODEL_PREFERENCES {
        return Err(GoogleThinkingError::new(
            "Too many Google thinking preferences.",
        ));
    }
    entries.push((model_id.to_string(), serde_json::json!(level.as_str())));
    Ok(entries.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(value: serde_json::Value) -> GoogleThinkingModelCapabilities {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn google_thinking_levels_stay_a_small_explicit_request_contract() {
        let ids: Vec<&str> = GOOGLE_THINKING_LEVELS.iter().map(|l| l.as_str()).collect();
        assert_eq!(ids, ["off", "low", "medium", "high"]);
        assert_eq!(DEFAULT_GOOGLE_THINKING_LEVEL.as_str(), "off");
        for level in GOOGLE_THINKING_LEVELS {
            assert!(is_google_thinking_level(&json!(level.as_str())));
        }
        for bad in [
            json!("minimal"),
            json!("xhigh"),
            json!("dynamic"),
            json!(""),
            Value::Null,
            json!(1),
        ] {
            assert!(!is_google_thinking_level(&bad));
        }
    }

    #[test]
    fn google_thinking_preferences_validate_model_ids_values_and_size() {
        let parsed = parse_google_thinking_preferences(&json!({
            "gemini-2.5-pro": "high",
            "gemini-3-flash-preview": "low",
        }))
        .unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(
            parsed.get("gemini-2.5-pro"),
            Some(&GoogleThinkingLevel::High)
        );

        let err = parse_google_thinking_preferences(&Value::Null).unwrap_err();
        assert!(err
            .to_string()
            .contains("Invalid Google thinking preferences"));
        let err =
            parse_google_thinking_preferences(&json!({ "gemini-2.5-pro": "dynamic" })).unwrap_err();
        assert!(err
            .to_string()
            .contains("Invalid Google thinking preference"));
        let err =
            parse_google_thinking_preferences(&json!({ "x".repeat(257): "low" })).unwrap_err();
        assert!(err
            .to_string()
            .contains("Invalid Google thinking preference"));

        let mut too_many = serde_json::Map::new();
        for index in 0..257 {
            too_many.insert(format!("model-{index}"), json!("off"));
        }
        let err = parse_google_thinking_preferences(&Value::Object(too_many)).unwrap_err();
        assert!(err
            .to_string()
            .contains("Too many Google thinking preferences"));
    }

    #[test]
    fn google_thinking_choices_expose_only_distinct_native_outcomes() {
        assert_eq!(
            google_thinking_levels_for_model(&model(json!({ "reasoning": false }))),
            vec![]
        );
        assert_eq!(
            google_thinking_levels_for_model(&model(json!({ "reasoning": true }))),
            GOOGLE_THINKING_LEVELS.to_vec()
        );
        assert_eq!(
            google_thinking_levels_for_model(&model(json!({
                "reasoning": true,
                "thinkingLevelMap": { "off": null, "minimal": null, "low": "LOW", "medium": null, "high": "HIGH" },
            }))),
            vec![
                GoogleThinkingLevel::Off,
                GoogleThinkingLevel::Low,
                GoogleThinkingLevel::High
            ]
        );
        assert_eq!(
            google_thinking_levels_for_model(&model(json!({
                "reasoning": true,
                "thinkingLevelMap": { "off": null, "minimal": "MINIMAL", "low": null, "medium": null, "high": "HIGH" },
            }))),
            vec![GoogleThinkingLevel::Off, GoogleThinkingLevel::High]
        );
        assert!(google_thinking_can_disable(&model(
            json!({ "reasoning": true })
        )));
        assert!(!google_thinking_can_disable(&model(json!({
            "reasoning": true,
            "thinkingLevelMap": { "off": null },
        }))));
        assert_eq!(
            normalize_google_thinking_level(
                &[
                    GoogleThinkingLevel::Off,
                    GoogleThinkingLevel::Low,
                    GoogleThinkingLevel::High
                ],
                &json!("medium"),
            ),
            GoogleThinkingLevel::Off
        );
    }

    #[test]
    fn one_preference_mutation_preserves_current_and_opaque_future_model_values() {
        let merged = merge_google_thinking_preference(
            &json!({ "gemini-2.5-pro": "high" }),
            "gemini-2.5-flash",
            GoogleThinkingLevel::Low,
        )
        .unwrap();
        assert_eq!(merged.get("gemini-2.5-pro"), Some(&json!("high")));
        assert_eq!(merged.get("gemini-2.5-flash"), Some(&json!("low")));

        let merged = merge_google_thinking_preference(
            &json!({ "gemini-2.5-pro": "invalid" }),
            "gemini-2.5-flash",
            GoogleThinkingLevel::Low,
        )
        .unwrap();
        assert_eq!(merged.get("gemini-2.5-pro"), Some(&json!("invalid")));
        assert_eq!(merged.get("gemini-2.5-flash"), Some(&json!("low")));
    }

    #[test]
    fn updating_a_full_preference_map_preserves_every_unrelated_model() {
        let mut full = serde_json::Map::new();
        for index in 0..256 {
            full.insert(format!("model-{index}"), json!("high"));
        }
        let updated = merge_google_thinking_preference(
            &Value::Object(full),
            "model-0",
            GoogleThinkingLevel::Low,
        )
        .unwrap();
        assert_eq!(updated.len(), 256);
        assert_eq!(updated.get("model-0"), Some(&json!("low")));
        assert_eq!(updated.get("model-255"), Some(&json!("high")));
        let mut again = serde_json::Map::new();
        for index in 0..256 {
            again.insert(format!("model-{index}"), json!("high"));
        }
        let err = merge_google_thinking_preference(
            &Value::Object(again),
            "model-new",
            GoogleThinkingLevel::Low,
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("Too many Google thinking preferences"));
    }
}
