//! Provider list shaping — port of `main/services/provider-list-core.ts`.
//!
//! The Settings picker list is composed from the persisted provider records
//! plus the OAuth-backed ChatGPT / Codex virtual provider, which appears only
//! when its credential snapshot says it is configured. Codex is never offered
//! through the generic API-key configuration path.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::codex::{
    OPENAI_CODEX_BASE_URL, OPENAI_CODEX_DEFAULT_MODEL, OPENAI_CODEX_PROVIDER_ID,
    OPENAI_CODEX_PROVIDER_LABEL,
};

/// `providers:auth:status-changed` — the global renderer channel Codex
/// status signals are forwarded on.
pub const CODEX_PROVIDER_STATUS_CHANGED_CHANNEL: &str = "providers:auth:status-changed";

/// `CodexProviderStatusChangedEvent`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderStatusChangedEvent {
    pub provider_id: String,
    pub needs_attention: bool,
}

/// `CodexModelSummary` (codex-provider.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelSummary {
    pub id: String,
    pub name: String,
    /// Always `openai-codex-responses` at the wire.
    #[serde(rename = "api")]
    pub api: String,
    pub reasoning: bool,
    pub vision: bool,
    pub context_window: u64,
    pub max_tokens: u64,
    pub thinking_levels: Vec<String>,
}

/// `CodexProviderSnapshot` (codex-provider.ts) — configuration-only status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderSnapshot {
    pub id: String,
    pub name: String,
    pub auth_name: String,
    pub configured: bool,
    pub needs_attention: bool,
    pub models: Vec<CodexModelSummary>,
}

/// Offline snapshot of the Codex models bundled with this Aiden build. The
/// configured/attention bits come from the credential backend; reading the
/// picker catalog must never contact OpenAI.
pub fn bundled_codex_provider_snapshot(
    configured: bool,
    needs_attention: bool,
) -> CodexProviderSnapshot {
    CodexProviderSnapshot {
        id: OPENAI_CODEX_PROVIDER_ID.to_string(),
        name: "OpenAI Codex".to_string(),
        auth_name: "OpenAI (ChatGPT Plus/Pro)".to_string(),
        configured,
        needs_attention,
        models: crate::builtin::builtin_models(OPENAI_CODEX_PROVIDER_ID)
            .iter()
            .map(|model| CodexModelSummary {
                id: model.id.to_string(),
                name: model.name.to_string(),
                api: "openai-codex-responses".to_string(),
                reasoning: model.reasoning,
                vision: model.vision,
                context_window: u64::from(model.context_window),
                max_tokens: u64::from(model.max_tokens),
                thinking_levels: model
                    .thinking_level_map
                    .iter()
                    .map(|(level, _)| (*level).to_string())
                    .collect(),
            })
            .collect(),
    }
}

/// The model-metadata shape embedded in a picker entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListModelMetadata {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_levels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
}

/// `Provider` as exposed to the renderer — the key itself never crosses IPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListEntry {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub base_url: String,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<BTreeMap<String, ProviderListModelMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub needs_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_preset: Option<bool>,
    pub has_key: bool,
}

/// `assertMutableProviderId` — the OAuth-backed Codex ID never enters the
/// generic API-key configuration path.
pub fn assert_mutable_provider_id(provider_id: &str) -> Result<(), ProviderListError> {
    if provider_id == OPENAI_CODEX_PROVIDER_ID {
        return Err(ProviderListError::CodexManaged);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderListError {
    #[error("ChatGPT / Codex is managed through its built-in sign-in settings.")]
    CodexManaged,
}

/// `forwardCodexProviderStatusChanges` — bridge every main-process Codex
/// status signal into one global renderer event. Returns the unsubscribe
/// closure.
pub type StatusListener = Arc<dyn Fn(bool) + Send + Sync>;
pub type StatusSubscribe = Arc<dyn Fn(StatusListener) -> Arc<dyn Fn() + Send + Sync> + Send + Sync>;
pub type StatusBroadcast = Arc<dyn Fn(&CodexProviderStatusChangedEvent) + Send + Sync>;

pub fn forward_codex_provider_status_changes(
    on_status_change: StatusSubscribe,
    broadcast: StatusBroadcast,
) -> Arc<dyn Fn() + Send + Sync> {
    let event = CodexProviderStatusChangedEvent {
        provider_id: OPENAI_CODEX_PROVIDER_ID.to_string(),
        needs_attention: false,
    };
    on_status_change(Arc::new(move |needs_attention| {
        broadcast(&CodexProviderStatusChangedEvent {
            needs_attention,
            ..event.clone()
        });
    }))
}

/// `mergeCodexProvider` — add Codex to the shared picker only when OAuth
/// metadata says it is configured. Any stale custom record using the reserved
/// ID is hidden in either state.
pub fn merge_codex_provider(
    providers: &[ProviderListEntry],
    snapshot: Option<&CodexProviderSnapshot>,
) -> Vec<ProviderListEntry> {
    let legacy: Vec<ProviderListEntry> = providers
        .iter()
        .filter(|provider| provider.id != OPENAI_CODEX_PROVIDER_ID)
        .cloned()
        .collect();
    let Some(snapshot) = snapshot else {
        return legacy;
    };
    if !snapshot.configured || snapshot.needs_attention {
        return legacy;
    }

    let mut model_ids: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for model in &snapshot.models {
        if seen.insert(model.id.clone()) {
            model_ids.push(model.id.clone());
        }
    }
    let default_model = if model_ids.contains(&OPENAI_CODEX_DEFAULT_MODEL.to_string()) {
        OPENAI_CODEX_DEFAULT_MODEL.to_string()
    } else {
        model_ids.first().cloned().unwrap_or_default()
    };
    let model_metadata = snapshot
        .models
        .iter()
        .map(|model| {
            (
                model.id.clone(),
                ProviderListModelMetadata {
                    source: "provider".to_string(),
                    name: Some(model.name.clone()),
                    r#type: Some("llm".to_string()),
                    vision: Some(model.vision),
                    tool_call: Some(true),
                    reasoning: Some(model.reasoning),
                    thinking_levels: Some(model.thinking_levels.clone()),
                    context_length: Some(model.context_window),
                },
            )
        })
        .collect();
    let mut merged = legacy;
    merged.push(ProviderListEntry {
        id: OPENAI_CODEX_PROVIDER_ID.to_string(),
        kind: "openai".to_string(),
        label: OPENAI_CODEX_PROVIDER_LABEL.to_string(),
        base_url: OPENAI_CODEX_BASE_URL.to_string(),
        models: model_ids,
        model_metadata: Some(model_metadata),
        default_model: Some(default_model),
        needs_key: true,
        is_preset: Some(true),
        has_key: true,
    });
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy() -> ProviderListEntry {
        ProviderListEntry {
            id: "openai".to_string(),
            kind: "openai".to_string(),
            label: "OpenAI".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            models: vec!["gpt-4.1".to_string()],
            model_metadata: None,
            default_model: Some("gpt-4.1".to_string()),
            needs_key: true,
            is_preset: Some(true),
            has_key: true,
        }
    }

    fn snapshot(configured: bool) -> CodexProviderSnapshot {
        CodexProviderSnapshot {
            id: "openai-codex".to_string(),
            name: "OpenAI Codex".to_string(),
            auth_name: "OpenAI (ChatGPT Plus/Pro)".to_string(),
            configured,
            needs_attention: false,
            models: vec![
                CodexModelSummary {
                    id: "gpt-5.4".to_string(),
                    name: "GPT-5.4".to_string(),
                    api: "openai-codex-responses".to_string(),
                    reasoning: true,
                    vision: true,
                    context_window: 272_000,
                    max_tokens: 128_000,
                    thinking_levels: vec![
                        "low".to_string(),
                        "medium".to_string(),
                        "high".to_string(),
                        "xhigh".to_string(),
                    ],
                },
                CodexModelSummary {
                    id: "gpt-5.6-sol".to_string(),
                    name: "GPT-5.6 Sol".to_string(),
                    api: "openai-codex-responses".to_string(),
                    reasoning: true,
                    vision: true,
                    context_window: 372_000,
                    max_tokens: 128_000,
                    thinking_levels: vec![
                        "low".to_string(),
                        "medium".to_string(),
                        "high".to_string(),
                        "xhigh".to_string(),
                        "max".to_string(),
                    ],
                },
            ],
        }
    }

    #[test]
    fn exposes_the_virtual_codex_provider_only_for_configured_oauth() {
        let providers = vec![legacy()];
        assert_eq!(
            merge_codex_provider(&providers, Some(&snapshot(false))),
            providers
        );
        let mut attention = snapshot(true);
        attention.needs_attention = true;
        assert_eq!(
            merge_codex_provider(&providers, Some(&attention)),
            providers
        );

        let merged = merge_codex_provider(&providers, Some(&snapshot(true)));
        assert_eq!(merged.len(), 2);
        let codex = &merged[1];
        assert_eq!(codex.id, "openai-codex");
        assert_eq!(codex.kind, "openai");
        assert_eq!(codex.label, "ChatGPT / Codex");
        assert_eq!(codex.base_url, "https://chatgpt.com/backend-api");
        assert_eq!(codex.models, vec!["gpt-5.4", "gpt-5.6-sol"]);
        let metadata = codex.model_metadata.as_ref().unwrap();
        assert_eq!(metadata["gpt-5.4"].source, "provider");
        assert_eq!(metadata["gpt-5.4"].name.as_deref(), Some("GPT-5.4"));
        assert_eq!(metadata["gpt-5.4"].r#type.as_deref(), Some("llm"));
        assert_eq!(metadata["gpt-5.4"].vision, Some(true));
        assert_eq!(metadata["gpt-5.4"].tool_call, Some(true));
        assert_eq!(metadata["gpt-5.4"].reasoning, Some(true));
        assert_eq!(metadata["gpt-5.4"].context_length, Some(272_000));
        assert_eq!(
            metadata["gpt-5.6-sol"].thinking_levels.as_ref().unwrap(),
            &vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(codex.default_model.as_deref(), Some("gpt-5.4"));
        assert!(codex.needs_key);
        assert_eq!(codex.is_preset, Some(true));
        assert!(codex.has_key);
    }

    #[test]
    fn filters_reserved_stored_collisions_and_rejects_generic_credential_management() {
        let collision = ProviderListEntry {
            id: "openai-codex".to_string(),
            label: "Unsafe custom collision".to_string(),
            ..legacy()
        };
        assert_eq!(
            merge_codex_provider(&[collision, legacy()], None),
            vec![legacy()]
        );
        assert!(matches!(
            assert_mutable_provider_id("openai-codex"),
            Err(ProviderListError::CodexManaged)
        ));
        assert!(assert_mutable_provider_id("custom-provider").is_ok());
    }

    #[test]
    fn forwards_each_main_process_codex_status_signal_to_the_global_renderer_channel() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Mutex;

        let listener_slot: Arc<Mutex<Option<StatusListener>>> = Arc::new(Mutex::new(None));
        let unsubscribed = Arc::new(AtomicBool::new(false));
        let events: Arc<Mutex<Vec<(String, CodexProviderStatusChangedEvent)>>> =
            Arc::new(Mutex::new(Vec::new()));

        let on_status_change = {
            let listener_slot = listener_slot.clone();
            let unsubscribed = unsubscribed.clone();
            Arc::new(move |listener: Arc<dyn Fn(bool) + Send + Sync>| {
                *listener_slot.lock().unwrap() = Some(listener);
                let unsubscribed = unsubscribed.clone();
                Arc::new(move || {
                    unsubscribed.store(true, Ordering::SeqCst);
                }) as Arc<dyn Fn() + Send + Sync>
            })
                as Arc<
                    dyn Fn(Arc<dyn Fn(bool) + Send + Sync>) -> Arc<dyn Fn() + Send + Sync>
                        + Send
                        + Sync,
                >
        };
        let broadcast = {
            let events = events.clone();
            Arc::new(move |event: &CodexProviderStatusChangedEvent| {
                events.lock().unwrap().push((
                    CODEX_PROVIDER_STATUS_CHANGED_CHANNEL.to_string(),
                    event.clone(),
                ));
            }) as Arc<dyn Fn(&CodexProviderStatusChangedEvent) + Send + Sync>
        };

        let unsubscribe = forward_codex_provider_status_changes(on_status_change, broadcast);
        let listener = listener_slot.lock().unwrap().clone().unwrap();
        listener(false);
        listener(true);

        let seen = events.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, "providers:auth:status-changed");
        assert!(!seen[0].1.needs_attention);
        assert!(seen[1].1.needs_attention);
        assert_eq!(seen[0].1.provider_id, "openai-codex");
        drop(seen);

        unsubscribe();
        assert!(unsubscribed.load(Ordering::SeqCst));
    }
}
