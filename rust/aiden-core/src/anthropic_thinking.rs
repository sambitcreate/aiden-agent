//! Port of `renderer/shared/anthropic-thinking.ts` — Claude's distinct public
//! effort choices, omitting Pi's internal minimal alias.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ANTHROPIC_THINKING_LEVELS: &[AnthropicThinkingLevel] = &[
    AnthropicThinkingLevel::Off,
    AnthropicThinkingLevel::Low,
    AnthropicThinkingLevel::Medium,
    AnthropicThinkingLevel::High,
    AnthropicThinkingLevel::Xhigh,
    AnthropicThinkingLevel::Max,
];

pub const DEFAULT_ANTHROPIC_THINKING_LEVEL: AnthropicThinkingLevel = AnthropicThinkingLevel::High;

const MAX_PREFERENCES: usize = 256;
const MAX_MODEL_ID_CHARS: usize = 256;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum AnthropicThinkingLevel {
    Off,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl AnthropicThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            AnthropicThinkingLevel::Off => "off",
            AnthropicThinkingLevel::Low => "low",
            AnthropicThinkingLevel::Medium => "medium",
            AnthropicThinkingLevel::High => "high",
            AnthropicThinkingLevel::Xhigh => "xhigh",
            AnthropicThinkingLevel::Max => "max",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "off" => Some(AnthropicThinkingLevel::Off),
            "low" => Some(AnthropicThinkingLevel::Low),
            "medium" => Some(AnthropicThinkingLevel::Medium),
            "high" => Some(AnthropicThinkingLevel::High),
            "xhigh" => Some(AnthropicThinkingLevel::Xhigh),
            "max" => Some(AnthropicThinkingLevel::Max),
            _ => None,
        }
    }
}

/// Model capability metadata used to shape the UI effort picker.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicThinkingModelCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    /// `None` value means the level is mapped to null (unsupported).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<BTreeMap<String, Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct AnthropicThinkingError {
    message: String,
}

impl AnthropicThinkingError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub fn is_anthropic_thinking_level(value: &Value) -> bool {
    match value.as_str() {
        Some(value) => AnthropicThinkingLevel::from_str(value).is_some(),
        None => false,
    }
}

/// Expose Claude's distinct public effort choices, omitting Pi's internal
/// minimal alias.
pub fn anthropic_thinking_levels_for_model(
    model: &AnthropicThinkingModelCapabilities,
) -> Vec<AnthropicThinkingLevel> {
    if model.reasoning != Some(true) {
        return Vec::new();
    }
    ANTHROPIC_THINKING_LEVELS
        .iter()
        .copied()
        .filter(|level| {
            if *level == AnthropicThinkingLevel::Off {
                return true;
            }
            let mapped = model
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get(level.as_str()).cloned());
            match mapped {
                Some(None) => false,
                Some(Some(_)) => true,
                None => !matches!(
                    level,
                    AnthropicThinkingLevel::Xhigh | AnthropicThinkingLevel::Max
                ),
            }
        })
        .collect()
}

pub fn anthropic_thinking_can_disable(model: &AnthropicThinkingModelCapabilities) -> bool {
    model.reasoning == Some(true)
        && !matches!(
            model
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get("off")),
            Some(None)
        )
}

pub fn normalize_anthropic_thinking_level(
    levels: &[AnthropicThinkingLevel],
    value: &Value,
) -> AnthropicThinkingLevel {
    if let Some(parsed) = value.as_str().and_then(AnthropicThinkingLevel::from_str) {
        if levels.contains(&parsed) {
            return parsed;
        }
    }
    if levels.contains(&DEFAULT_ANTHROPIC_THINKING_LEVEL) {
        DEFAULT_ANTHROPIC_THINKING_LEVEL
    } else {
        levels
            .first()
            .copied()
            .unwrap_or(DEFAULT_ANTHROPIC_THINKING_LEVEL)
    }
}

/// Parse the complete device-local preference map before it crosses into
/// persistence.
pub fn parse_anthropic_thinking_preferences(
    value: &Value,
) -> Result<BTreeMap<String, AnthropicThinkingLevel>, AnthropicThinkingError> {
    let Some(object) = value.as_object() else {
        return Err(AnthropicThinkingError::new(
            "Invalid Anthropic thinking preferences.",
        ));
    };
    if object.len() > MAX_PREFERENCES {
        return Err(AnthropicThinkingError::new(
            "Too many Anthropic thinking preferences.",
        ));
    }
    let mut parsed = BTreeMap::new();
    for (model_id, level) in object {
        let parsed_level = level.as_str().and_then(AnthropicThinkingLevel::from_str);
        if model_id.is_empty()
            || model_id.chars().count() > MAX_MODEL_ID_CHARS
            || parsed_level.is_none()
        {
            return Err(AnthropicThinkingError::new(
                "Invalid Anthropic thinking preference.",
            ));
        }
        parsed.insert(model_id.clone(), parsed_level.unwrap());
    }
    Ok(parsed)
}

/// Merge one preference, preserving every unrelated (and opaque future) value.
pub fn merge_anthropic_thinking_preference(
    current: &Value,
    model_id: &str,
    level: AnthropicThinkingLevel,
) -> Result<BTreeMap<String, Value>, AnthropicThinkingError> {
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
    if entries.len() >= MAX_PREFERENCES {
        return Err(AnthropicThinkingError::new(
            "Too many Anthropic thinking preferences.",
        ));
    }
    entries.push((model_id.to_string(), serde_json::json!(level.as_str())));
    Ok(entries.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(value: serde_json::Value) -> AnthropicThinkingModelCapabilities {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn exposes_only_distinct_claude_effort_choices_supported_by_the_model() {
        assert_eq!(
            anthropic_thinking_levels_for_model(&model(json!({ "reasoning": true }))),
            vec![
                AnthropicThinkingLevel::Off,
                AnthropicThinkingLevel::Low,
                AnthropicThinkingLevel::Medium,
                AnthropicThinkingLevel::High,
            ]
        );
        assert_eq!(
            anthropic_thinking_levels_for_model(&model(json!({
                "reasoning": true,
                "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
            }))),
            ANTHROPIC_THINKING_LEVELS.to_vec()
        );
        assert_eq!(
            anthropic_thinking_levels_for_model(&model(json!({ "reasoning": false }))),
            vec![]
        );
    }

    #[test]
    fn uses_high_by_default_and_treats_always_on_thinking_as_hideable() {
        let levels = anthropic_thinking_levels_for_model(&model(json!({
            "reasoning": true,
            "thinkingLevelMap": { "off": null, "xhigh": "xhigh", "max": "max" },
        })));
        assert_eq!(
            normalize_anthropic_thinking_level(&levels, &Value::Null),
            AnthropicThinkingLevel::High
        );
        assert!(!anthropic_thinking_can_disable(&model(json!({
            "reasoning": true,
            "thinkingLevelMap": { "off": null },
        }))));
        assert!(anthropic_thinking_can_disable(&model(
            json!({ "reasoning": true })
        )));
    }

    #[test]
    fn validates_persisted_anthropic_choices() {
        let parsed =
            parse_anthropic_thinking_preferences(&json!({ "claude-opus-4-8": "xhigh" })).unwrap();
        assert_eq!(
            parsed.get("claude-opus-4-8"),
            Some(&AnthropicThinkingLevel::Xhigh)
        );
        let err = parse_anthropic_thinking_preferences(&json!({ "claude-opus-4-8": "minimal" }))
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("Invalid Anthropic thinking preference"));
    }

    #[test]
    fn updating_a_full_preference_map_preserves_every_unrelated_model() {
        let mut full = serde_json::Map::new();
        for index in 0..256 {
            full.insert(format!("model-{index}"), json!("high"));
        }
        let updated = merge_anthropic_thinking_preference(
            &Value::Object(full),
            "model-0",
            AnthropicThinkingLevel::Low,
        )
        .unwrap();
        assert_eq!(updated.len(), 256);
        assert_eq!(updated.get("model-0"), Some(&json!("low")));
        assert_eq!(updated.get("model-255"), Some(&json!("high")));
        let mut again = serde_json::Map::new();
        for index in 0..256 {
            again.insert(format!("model-{index}"), json!("high"));
        }
        let err = merge_anthropic_thinking_preference(
            &Value::Object(again),
            "model-new",
            AnthropicThinkingLevel::Low,
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("Too many Anthropic thinking preferences"));
    }
}
