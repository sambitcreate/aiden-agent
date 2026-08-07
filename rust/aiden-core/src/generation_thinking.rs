//! Port of `renderer/shared/generation-thinking.ts` — the shared thinking
//! level vocabulary used across provider families.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The full ordered vocabulary of thinking effort levels. Providers surface
/// their own subsets of these.
pub const GENERATION_THINKING_LEVELS: &[GenerationThinkingLevel] = &[
    GenerationThinkingLevel::Off,
    GenerationThinkingLevel::Low,
    GenerationThinkingLevel::Medium,
    GenerationThinkingLevel::High,
    GenerationThinkingLevel::Xhigh,
    GenerationThinkingLevel::Max,
];

/// The enum wire form must match the string unions used by the Electron app.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum GenerationThinkingLevel {
    Off,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl GenerationThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            GenerationThinkingLevel::Off => "off",
            GenerationThinkingLevel::Low => "low",
            GenerationThinkingLevel::Medium => "medium",
            GenerationThinkingLevel::High => "high",
            GenerationThinkingLevel::Xhigh => "xhigh",
            GenerationThinkingLevel::Max => "max",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "off" => Some(GenerationThinkingLevel::Off),
            "low" => Some(GenerationThinkingLevel::Low),
            "medium" => Some(GenerationThinkingLevel::Medium),
            "high" => Some(GenerationThinkingLevel::High),
            "xhigh" => Some(GenerationThinkingLevel::Xhigh),
            "max" => Some(GenerationThinkingLevel::Max),
            _ => None,
        }
    }
}

/// Type guard mirroring the exported predicate.
pub fn is_generation_thinking_level(value: &Value) -> bool {
    match value.as_str() {
        Some(value) => GenerationThinkingLevel::from_str(value).is_some(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn level_set_matches_the_canonical_order() {
        let ids: Vec<&str> = GENERATION_THINKING_LEVELS
            .iter()
            .map(|l| l.as_str())
            .collect();
        assert_eq!(ids, ["off", "low", "medium", "high", "xhigh", "max"]);
    }

    #[test]
    fn predicates_and_roundtrips() {
        for level in GENERATION_THINKING_LEVELS {
            assert!(is_generation_thinking_level(&json!(level.as_str())));
            let back: GenerationThinkingLevel =
                serde_json::from_value(json!(level.as_str())).unwrap();
            assert_eq!(back, *level);
        }
        for bad in [json!("minimal"), json!("dynamic"), json!(""), json!(1)] {
            assert!(!is_generation_thinking_level(&bad));
        }
    }
}
