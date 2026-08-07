//! Port of `renderer/shared/codex-thinking.ts` — Codex's native thinking
//! contract; XHigh and Max are opt-in capabilities in Pi's model metadata.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CODEX_THINKING_LEVELS: &[CodexThinkingLevel] = &[
    CodexThinkingLevel::Low,
    CodexThinkingLevel::Medium,
    CodexThinkingLevel::High,
    CodexThinkingLevel::Xhigh,
    CodexThinkingLevel::Max,
];

pub const DEFAULT_CODEX_THINKING_LEVEL: CodexThinkingLevel = CodexThinkingLevel::Medium;

const MAX_THINKING_MODEL_PREFERENCES: usize = 256;
const MAX_MODEL_ID_CHARS: usize = 256;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum CodexThinkingLevel {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl CodexThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexThinkingLevel::Low => "low",
            CodexThinkingLevel::Medium => "medium",
            CodexThinkingLevel::High => "high",
            CodexThinkingLevel::Xhigh => "xhigh",
            CodexThinkingLevel::Max => "max",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "low" => Some(CodexThinkingLevel::Low),
            "medium" => Some(CodexThinkingLevel::Medium),
            "high" => Some(CodexThinkingLevel::High),
            "xhigh" => Some(CodexThinkingLevel::Xhigh),
            "max" => Some(CodexThinkingLevel::Max),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CodexThinkingModelCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<BTreeMap<String, Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct CodexThinkingError {
    message: String,
}

impl CodexThinkingError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub fn is_codex_thinking_level(value: &Value) -> bool {
    match value.as_str() {
        Some(value) => CodexThinkingLevel::from_str(value).is_some(),
        None => false,
    }
}

/// Match Pi's native model contract while omitting aliases and
/// provider-default states.
pub fn codex_thinking_levels_for_model(
    model: &CodexThinkingModelCapabilities,
) -> Vec<CodexThinkingLevel> {
    if model.reasoning != Some(true) {
        return Vec::new();
    }
    CODEX_THINKING_LEVELS
        .iter()
        .copied()
        .filter(|level| {
            let mapped = model
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get(level.as_str()).cloned());
            match mapped {
                Some(None) => false,
                Some(Some(_)) => true,
                None => !matches!(level, CodexThinkingLevel::Xhigh | CodexThinkingLevel::Max),
            }
        })
        .collect()
}

pub fn normalize_codex_thinking_level(
    levels: &[CodexThinkingLevel],
    value: &Value,
) -> CodexThinkingLevel {
    if let Some(parsed) = value.as_str().and_then(CodexThinkingLevel::from_str) {
        if levels.contains(&parsed) {
            return parsed;
        }
    }
    if levels.contains(&DEFAULT_CODEX_THINKING_LEVEL) {
        DEFAULT_CODEX_THINKING_LEVEL
    } else {
        levels
            .first()
            .copied()
            .unwrap_or(DEFAULT_CODEX_THINKING_LEVEL)
    }
}

/// Parse the complete device-local preference map before it crosses into
/// persistence.
pub fn parse_codex_thinking_preferences(
    value: &Value,
) -> Result<BTreeMap<String, CodexThinkingLevel>, CodexThinkingError> {
    let Some(object) = value.as_object() else {
        return Err(CodexThinkingError::new(
            "Invalid Codex thinking preferences.",
        ));
    };
    if object.len() > MAX_THINKING_MODEL_PREFERENCES {
        return Err(CodexThinkingError::new(
            "Too many Codex thinking preferences.",
        ));
    }
    let mut parsed = BTreeMap::new();
    for (model_id, level) in object {
        let parsed_level = level.as_str().and_then(CodexThinkingLevel::from_str);
        if model_id.is_empty()
            || model_id.chars().count() > MAX_MODEL_ID_CHARS
            || parsed_level.is_none()
        {
            return Err(CodexThinkingError::new(
                "Invalid Codex thinking preference.",
            ));
        }
        parsed.insert(model_id.clone(), parsed_level.unwrap());
    }
    Ok(parsed)
}

pub fn merge_codex_thinking_preference(
    current: &Value,
    model_id: &str,
    level: CodexThinkingLevel,
) -> Result<BTreeMap<String, Value>, CodexThinkingError> {
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
        return Err(CodexThinkingError::new(
            "Too many Codex thinking preferences.",
        ));
    }
    entries.push((model_id.to_string(), serde_json::json!(level.as_str())));
    Ok(entries.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(value: serde_json::Value) -> CodexThinkingModelCapabilities {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn codex_thinking_levels_stay_a_small_explicit_request_contract() {
        let ids: Vec<&str> = CODEX_THINKING_LEVELS.iter().map(|l| l.as_str()).collect();
        assert_eq!(ids, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(DEFAULT_CODEX_THINKING_LEVEL.as_str(), "medium");
        for level in CODEX_THINKING_LEVELS {
            assert!(is_codex_thinking_level(&json!(level.as_str())));
        }
        for bad in [
            json!("off"),
            json!("minimal"),
            json!("dynamic"),
            json!(""),
            Value::Null,
            json!(1),
        ] {
            assert!(!is_codex_thinking_level(&bad));
        }
    }

    #[test]
    fn codex_choices_expose_only_distinct_native_outcomes() {
        assert_eq!(
            codex_thinking_levels_for_model(&model(json!({ "reasoning": false }))),
            vec![]
        );
        assert_eq!(
            codex_thinking_levels_for_model(&model(json!({
                "reasoning": true,
                "thinkingLevelMap": { "minimal": "low", "xhigh": "xhigh" },
            }))),
            vec![
                CodexThinkingLevel::Low,
                CodexThinkingLevel::Medium,
                CodexThinkingLevel::High,
                CodexThinkingLevel::Xhigh,
            ]
        );
        assert_eq!(
            codex_thinking_levels_for_model(&model(json!({
                "reasoning": true,
                "thinkingLevelMap": { "minimal": "low", "medium": null, "xhigh": "xhigh", "max": "max" },
            }))),
            vec![
                CodexThinkingLevel::Low,
                CodexThinkingLevel::High,
                CodexThinkingLevel::Xhigh,
                CodexThinkingLevel::Max,
            ]
        );
        assert_eq!(
            normalize_codex_thinking_level(
                &[
                    CodexThinkingLevel::Low,
                    CodexThinkingLevel::Medium,
                    CodexThinkingLevel::High
                ],
                &Value::Null,
            ),
            CodexThinkingLevel::Medium
        );
        assert_eq!(
            normalize_codex_thinking_level(
                &[CodexThinkingLevel::Low, CodexThinkingLevel::High],
                &json!("medium"),
            ),
            CodexThinkingLevel::Low
        );
    }

    #[test]
    fn codex_thinking_preferences_validate_and_merge_bounded_model_entries() {
        let parsed = parse_codex_thinking_preferences(&json!({
            "gpt-5.4": "xhigh",
            "gpt-5.6-sol": "max",
        }))
        .unwrap();
        assert_eq!(parsed.get("gpt-5.4"), Some(&CodexThinkingLevel::Xhigh));
        assert_eq!(parsed.get("gpt-5.6-sol"), Some(&CodexThinkingLevel::Max));

        let err = parse_codex_thinking_preferences(&json!({ "gpt-5.4": "minimal" })).unwrap_err();
        assert!(err
            .to_string()
            .contains("Invalid Codex thinking preference"));
        let err = parse_codex_thinking_preferences(&json!({ "x".repeat(257): "low" })).unwrap_err();
        assert!(err
            .to_string()
            .contains("Invalid Codex thinking preference"));
        let mut too_many = serde_json::Map::new();
        for index in 0..257 {
            too_many.insert(format!("model-{index}"), json!("medium"));
        }
        let err = parse_codex_thinking_preferences(&Value::Object(too_many)).unwrap_err();
        assert!(err
            .to_string()
            .contains("Too many Codex thinking preferences"));

        let merged = merge_codex_thinking_preference(
            &json!({ "gpt-5.4": "high" }),
            "gpt-5.6-sol",
            CodexThinkingLevel::Max,
        )
        .unwrap();
        assert_eq!(merged.get("gpt-5.4"), Some(&json!("high")));
        assert_eq!(merged.get("gpt-5.6-sol"), Some(&json!("max")));

        let merged = merge_codex_thinking_preference(
            &json!({ "gpt-5.4": "minimal" }),
            "gpt-5.6-sol",
            CodexThinkingLevel::Medium,
        )
        .unwrap();
        assert_eq!(merged.get("gpt-5.4"), Some(&json!("minimal")));
        assert_eq!(merged.get("gpt-5.6-sol"), Some(&json!("medium")));
    }

    #[test]
    fn updating_a_full_preference_map_preserves_every_unrelated_model() {
        let mut full = serde_json::Map::new();
        for index in 0..256 {
            full.insert(format!("model-{index}"), json!("high"));
        }
        let updated = merge_codex_thinking_preference(
            &Value::Object(full),
            "model-0",
            CodexThinkingLevel::Low,
        )
        .unwrap();
        assert_eq!(updated.len(), 256);
        assert_eq!(updated.get("model-0"), Some(&json!("low")));
        assert_eq!(updated.get("model-255"), Some(&json!("high")));
        let mut again = serde_json::Map::new();
        for index in 0..256 {
            again.insert(format!("model-{index}"), json!("high"));
        }
        let err = merge_codex_thinking_preference(
            &Value::Object(again),
            "model-new",
            CodexThinkingLevel::Low,
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("Too many Codex thinking preferences"));
    }
}
