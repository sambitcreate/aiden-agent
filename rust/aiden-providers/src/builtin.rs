//! Built-in (pi-native) model catalog.
//!
//! Port of the pi-ai builtin model records Aiden consumes for its native
//! providers: `getBuiltinModels("anthropic")`, `getBuiltinModels("google")`,
//! and the OAuth-backed `getBuiltinModels("openai-codex")`
//! (`main/services/anthropic-provider.ts`, `main/services/google-provider.ts`)
//! and the `piExact` model resolution in `main/services/model-runtime.ts`.
//!
//! The data is a snapshot of
//! `node_modules/@earendil-works/pi-ai/dist/providers/*.models.js` at port
//! time. Aiden ships the two API-key-native providers it renders as built-ins
//! plus the OAuth-backed Codex virtual provider; ordinary
//! `openai`/`deepseek`/`moonshotai` builtins remain models.dev-catalog-only.

use crate::ApiFamily;

/// `ANTHROPIC_PROVIDER_ID` (`anthropic-provider.ts`).
pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";
/// `ANTHROPIC_DEFAULT_MODELS` (`anthropic-provider.ts`).
pub const ANTHROPIC_DEFAULT_MODELS: &[&str] =
    &["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
/// `ANTHROPIC_DEFAULT_MODEL` (`anthropic-provider.ts`).
pub const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-5";
/// `LEGACY_DEFAULT_MODELS` (`anthropic-provider.ts`) — the pre-pi preset that
/// `migrateLegacyAnthropicPreset` recognizes.
pub const LEGACY_ANTHROPIC_PRESET_MODELS: &[&str] = &[
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-latest",
    "claude-3-5-haiku-latest",
];

/// One pi-ai builtin `Model<Api>` row reduced to the fields Aiden's catalog
/// actually consumes. `thinking_level_map` mirrors pi `thinkingLevelMap`
/// (level name → wire value; `None` = explicitly nulled/unsupported).
#[derive(Debug, Clone, Copy)]
pub struct BuiltinModel {
    pub id: &'static str,
    pub name: &'static str,
    pub api: ApiFamily,
    pub reasoning: bool,
    pub thinking_level_map: &'static [(&'static str, Option<&'static str>)],
    /// `Model.input` includes `"image"`.
    pub vision: bool,
    pub context_window: u32,
    pub max_tokens: u32,
    /// pi `Model.compat.forceAdaptiveThinking` (anthropic-messages only).
    pub force_adaptive_thinking: bool,
}

/// Pi-ai `ANTHROPIC_MODELS` snapshot (`anthropic.models.js`).
#[rustfmt::skip]
pub const ANTHROPIC_BUILTIN_MODELS: &[BuiltinModel] = &[
    BuiltinModel { id: "claude-fable-5", name: "Claude Fable 5", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[("off", None), ("xhigh", Some("xhigh")), ("max", Some("max"))],
        vision: true, context_window: 1_000_000, max_tokens: 128_000, force_adaptive_thinking: true },
    BuiltinModel { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (latest)", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 200_000, max_tokens: 64_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 200_000, max_tokens: 64_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-opus-4-1", name: "Claude Opus 4.1 (latest)", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 200_000, max_tokens: 32_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 200_000, max_tokens: 32_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 200_000, max_tokens: 64_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 200_000, max_tokens: 64_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-opus-4-6", name: "Claude Opus 4.6", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[("max", Some("max"))], vision: true, context_window: 1_000_000, max_tokens: 128_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-opus-4-7", name: "Claude Opus 4.7", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[("xhigh", Some("xhigh")), ("max", Some("max"))], vision: true, context_window: 1_000_000, max_tokens: 128_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-opus-4-8", name: "Claude Opus 4.8", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[("xhigh", Some("xhigh")), ("max", Some("max"))], vision: true, context_window: 1_000_000, max_tokens: 128_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (latest)", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 1_000_000, max_tokens: 64_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 1_000_000, max_tokens: 64_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[("max", Some("max"))], vision: true, context_window: 1_000_000, max_tokens: 128_000, force_adaptive_thinking: false },
    BuiltinModel { id: "claude-sonnet-5", name: "Claude Sonnet 5", api: ApiFamily::AnthropicMessages, reasoning: true,
        thinking_level_map: &[("xhigh", Some("xhigh")), ("max", Some("max"))], vision: true, context_window: 1_000_000, max_tokens: 128_000, force_adaptive_thinking: false },
];

/// Pi-ai Codex model snapshot used by the virtual OAuth provider and the
/// request-time `piExact` limit resolver.
#[rustfmt::skip]
pub const CODEX_BUILTIN_MODELS: &[BuiltinModel] = &[
    BuiltinModel { id: "gpt-5.4", name: "GPT-5.4", api: ApiFamily::OpenAICodexResponses, reasoning: true,
        thinking_level_map: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))],
        vision: true, context_window: 272_000, max_tokens: 128_000, force_adaptive_thinking: false },
    BuiltinModel { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", api: ApiFamily::OpenAICodexResponses, reasoning: true,
        thinking_level_map: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh")), ("max", Some("max"))],
        vision: true, context_window: 372_000, max_tokens: 128_000, force_adaptive_thinking: false },
];

/// Pi-ai `GOOGLE_MODELS` snapshot (`google.models.js`) — the same ids as the
/// `GOOGLE_PROVIDER_MODEL_IDS` list in `aiden-data/portable_config.rs`.
#[rustfmt::skip]
pub const GOOGLE_BUILTIN_MODELS: &[BuiltinModel] = &[
    BuiltinModel { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", api: ApiFamily::GoogleGenerativeAi, reasoning: false,
        thinking_level_map: &[], vision: true, context_window: 1_048_576, max_tokens: 8_192, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash-Lite", api: ApiFamily::GoogleGenerativeAi, reasoning: false,
        thinking_level_map: &[], vision: true, context_window: 1_048_576, max_tokens: 8_192, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None)], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None), ("minimal", None), ("low", Some("LOW")), ("medium", None), ("high", Some("HIGH"))],
        vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None)], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None)], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None), ("minimal", None), ("low", Some("LOW")), ("medium", None), ("high", Some("HIGH"))],
        vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-3.1-pro-preview-customtools", name: "Gemini 3.1 Pro Preview Custom Tools", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None), ("minimal", None), ("low", Some("LOW")), ("medium", None), ("high", Some("HIGH"))],
        vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None)], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-flash-latest", name: "Gemini Flash Latest", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None)], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemini-flash-lite-latest", name: "Gemini Flash-Lite Latest", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None)], vision: true, context_window: 1_048_576, max_tokens: 65_536, force_adaptive_thinking: false },
    BuiltinModel { id: "gemma-4-26b-a4b-it", name: "Gemma 4 26B A4B IT", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None), ("minimal", Some("MINIMAL")), ("low", None), ("medium", None), ("high", Some("HIGH"))],
        vision: true, context_window: 262_144, max_tokens: 32_768, force_adaptive_thinking: false },
    BuiltinModel { id: "gemma-4-31b-it", name: "Gemma 4 31B IT", api: ApiFamily::GoogleGenerativeAi, reasoning: true,
        thinking_level_map: &[("off", None), ("minimal", Some("MINIMAL")), ("low", None), ("medium", None), ("high", Some("HIGH"))],
        vision: true, context_window: 262_144, max_tokens: 32_768, force_adaptive_thinking: false },
];

/// `getBuiltinModels(provider)` — the provider-scoped builtin model list.
pub fn builtin_models(provider_id: &str) -> &'static [BuiltinModel] {
    match provider_id {
        ANTHROPIC_PROVIDER_ID => ANTHROPIC_BUILTIN_MODELS,
        crate::google::GOOGLE_PROVIDER_ID => GOOGLE_BUILTIN_MODELS,
        crate::codex::OPENAI_CODEX_PROVIDER_ID => CODEX_BUILTIN_MODELS,
        _ => &[],
    }
}

/// `getBuiltinModel(provider, model)` — exact pi-native model lookup.
pub fn builtin_model(provider_id: &str, model_id: &str) -> Option<&'static BuiltinModel> {
    builtin_models(provider_id)
        .iter()
        .find(|model| model.id == model_id)
}

/// Aiden's canonical anthropic default models in preset order.
pub fn anthropic_default_models() -> &'static [&'static str] {
    ANTHROPIC_DEFAULT_MODELS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_lists_match_the_ts_constants() {
        assert_eq!(ANTHROPIC_PROVIDER_ID, "anthropic");
        assert_eq!(
            anthropic_default_models(),
            &["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"]
        );
        assert_eq!(ANTHROPIC_DEFAULT_MODEL, "claude-sonnet-5");
        assert_eq!(
            LEGACY_ANTHROPIC_PRESET_MODELS,
            &[
                "claude-sonnet-4-20250514",
                "claude-3-7-sonnet-latest",
                "claude-3-5-haiku-latest",
            ]
        );
    }

    #[test]
    fn every_default_anthropic_model_resolves_with_pi_exact_fields() {
        for model_id in ANTHROPIC_DEFAULT_MODELS {
            let model = builtin_model(ANTHROPIC_PROVIDER_ID, model_id)
                .unwrap_or_else(|| panic!("missing builtin {model_id}"));
            assert!(model.reasoning, "{model_id} is a reasoning model");
            assert!(model.vision, "{model_id} accepts images");
            assert!(model.context_window > 0);
            assert!(model.max_tokens > 0);
            assert_eq!(model.api, ApiFamily::AnthropicMessages);
        }
        // claude-sonnet-5 exposes xhigh/max in its thinking map (pi data).
        let sonnet = builtin_model(ANTHROPIC_PROVIDER_ID, "claude-sonnet-5").unwrap();
        let keys: Vec<&str> = sonnet
            .thinking_level_map
            .iter()
            .map(|(key, _)| *key)
            .collect();
        assert_eq!(keys, vec!["xhigh", "max"]);
        // Only claude-fable-5 forces adaptive thinking (compat field).
        let fable = builtin_model(ANTHROPIC_PROVIDER_ID, "claude-fable-5").unwrap();
        assert!(fable.force_adaptive_thinking);
        assert!(!sonnet.force_adaptive_thinking);
    }

    #[test]
    fn google_builtins_carry_pi_exact_thinking_maps_and_windows() {
        let flash = builtin_model(crate::google::GOOGLE_PROVIDER_ID, "gemini-2.5-flash").unwrap();
        assert!(flash.reasoning);
        assert_eq!(flash.context_window, 1_048_576);
        assert_eq!(flash.max_tokens, 65_536);
        assert!(
            flash.thinking_level_map.is_empty(),
            "2.5 models expose all levels"
        );

        let pro = builtin_model(crate::google::GOOGLE_PROVIDER_ID, "gemini-3-pro-preview").unwrap();
        // pi: medium nulled, low/high mapped — off nulled means can't disable.
        let nulled: Vec<&str> = pro
            .thinking_level_map
            .iter()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| *key)
            .collect();
        assert_eq!(nulled, vec!["off", "minimal", "medium"]);

        let gemma = builtin_model(crate::google::GOOGLE_PROVIDER_ID, "gemma-4-31b-it").unwrap();
        assert_eq!(gemma.context_window, 262_144);
        assert_eq!(gemma.max_tokens, 32_768);
        assert_eq!(gemma.api, ApiFamily::GoogleGenerativeAi);
    }

    #[test]
    fn codex_builtins_drive_the_virtual_catalog_and_runtime_limits() {
        let model = builtin_model(crate::codex::OPENAI_CODEX_PROVIDER_ID, "gpt-5.6-sol")
            .expect("bundled Codex model");
        assert_eq!(model.api, ApiFamily::OpenAICodexResponses);
        assert_eq!(model.context_window, 372_000);
        assert_eq!(model.max_tokens, 128_000);
        assert_eq!(model.thinking_level_map.last().unwrap().0, "max");
    }

    #[test]
    fn unknown_providers_and_models_resolve_to_nothing() {
        assert!(builtin_model("openai", "gpt-4o").is_none());
        assert!(builtin_model(ANTHROPIC_PROVIDER_ID, "not-a-model").is_none());
        assert!(builtin_models("custom:lmstudio").is_empty());
    }
}
