//! Provider catalog + streaming dispatch for the chat service.
//!
//! The catalog is built from the *portable config* (`ConfigStore::list_providers`)
//! — anthropic, openai, and `custom:` base-URL providers — plus the keychain
//! state attached to each (`hasKey`). Streaming dispatches through the
//! aiden-providers transports on the tokio runtime and forwards batched
//! updates over a channel to the GPUI foreground (see [`drive_stream`]).

use std::sync::Arc;

use aiden_core::{
    AssistantMessage, ChatMessage, ChatRole, ContentBlock, Message, StopReason, TextContent,
    UserContent, UserMessage,
};
use aiden_data::config_store::Provider as StoredProvider;
use aiden_data::portable_config::ProviderKind;
use aiden_providers::provider_error_message;
use aiden_providers::{
    anthropic::AnthropicProvider, openai_completions::OpenAICompletionsProvider, ApiFamily,
    EventStream, Provider, ProviderError, StreamOptions, StreamRequest,
};

use crate::services::stream::{zero_usage, StreamReducer, StreamTerminal};

/// Channel message sent from the streaming driver to the foreground.
#[derive(Debug)]
pub enum StreamMsg {
    /// Batched incremental append (text/thinking deltas since the last flush).
    Flush {
        text: String,
        thinking: String,
        thinking_active: Option<bool>,
    },
    /// Terminal success: the final assistant message + full text/thinking.
    Done {
        message: Box<AssistantMessage>,
        full_text: String,
        full_thinking: String,
    },
    /// Terminal failure.
    Error {
        message: String,
        partial_text: String,
        partial_thinking: String,
    },
}

/// One provider as configured on disk (the model-picker catalog entry).
#[derive(Debug, Clone, PartialEq)]
pub struct ConfiguredProvider {
    pub id: String,
    pub label: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub models: Vec<String>,
    pub default_model: Option<String>,
    pub needs_key: bool,
    pub has_key: bool,
}

impl ConfiguredProvider {
    /// The pi-ai API family this provider dispatches through.
    pub fn api_family(&self) -> ApiFamily {
        match self.kind {
            ProviderKind::Anthropic => ApiFamily::AnthropicMessages,
            ProviderKind::Openai => ApiFamily::OpenAICompletions,
        }
    }

    /// The concrete transport registered for this provider's API family. The
    /// transport's fixed info id (`anthropic`, `google`, `openai-completions`)
    /// is decoupled from the *configured* provider id so `custom:` providers
    /// work; the request still carries the configured id for auth + headers.
    pub fn transport(&self) -> Arc<dyn Provider> {
        match self.kind {
            ProviderKind::Anthropic => Arc::new(AnthropicProvider::new()),
            ProviderKind::Openai => Arc::new(OpenAICompletionsProvider::with_base_url(
                self.base_url.clone(),
            )),
        }
    }
}

impl From<&StoredProvider> for ConfiguredProvider {
    fn from(provider: &StoredProvider) -> Self {
        Self {
            id: provider.id.clone(),
            label: provider.label.clone(),
            kind: provider.kind,
            base_url: provider.base_url.clone(),
            models: provider.models.clone(),
            default_model: provider.default_model.clone(),
            needs_key: provider.needs_key,
            has_key: provider.has_key,
        }
    }
}

/// A fully-resolved selection: provider + model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSelection {
    pub provider_id: String,
    pub model: String,
}

impl ModelSelection {
    /// `providerId`/`model` — the key used by the settings persistence.
    pub fn to_settings(&self) -> serde_json::Value {
        serde_json::json!({
            "providerId": self.provider_id,
            "model": self.model,
        })
    }

    pub fn from_settings(value: &serde_json::Value) -> Option<Self> {
        let provider_id = value.get("providerId")?.as_str()?.to_string();
        let model = value.get("model")?.as_str()?.to_string();
        if provider_id.is_empty() || model.is_empty() {
            return None;
        }
        Some(Self { provider_id, model })
    }
}

/// A snapshot of everything the background driver needs for one turn.
#[derive(Debug, Clone)]
pub struct TurnSnapshot {
    pub provider: ConfiguredProvider,
    pub selection: ModelSelection,
    pub messages: Vec<Message>,
}

/// Map persisted chat history into the normalized `Message` union the
/// providers serialize onto the wire. System messages are dropped (the
/// phase-5 build has no system-prompt pipeline).
pub fn chat_history_to_messages(
    history: &[ChatMessage],
    default_model: &str,
    default_provider: &str,
) -> Vec<Message> {
    history
        .iter()
        .filter_map(|entry| match entry.role {
            ChatRole::User => Some(Message::User(UserMessage {
                content: UserContent::Text(entry.content.clone()),
                timestamp: entry.created_at,
            })),
            ChatRole::Assistant => Some(Message::Assistant(AssistantMessage {
                content: if entry.content.is_empty() {
                    Vec::new()
                } else {
                    vec![ContentBlock::Text(TextContent {
                        text: entry.content.clone(),
                        text_signature: None,
                    })]
                },
                api: "openai-completions".to_string(),
                provider: default_provider.to_string(),
                model: entry
                    .model
                    .clone()
                    .unwrap_or_else(|| default_model.to_string()),
                response_model: None,
                response_id: None,
                usage: zero_usage(),
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: entry.created_at,
            })),
            ChatRole::System => None,
        })
        .collect()
}

/// Build the normalized `StreamRequest` for one turn.
pub fn build_stream_request(snapshot: &TurnSnapshot) -> StreamRequest {
    StreamRequest {
        provider_id: snapshot.selection.provider_id.clone(),
        api: snapshot.provider.api_family(),
        model: snapshot.selection.model.clone(),
        base_url: snapshot.provider.base_url.clone(),
        reasoning: false,
        thinking_level_map: None,
        vision: false,
        context_window: 32_768,
        max_tokens_limit: 4_096,
        messages: snapshot.messages.clone(),
        system_prompt: None,
        max_tokens: None,
        ..Default::default()
    }
}

/// The timeout for one provider turn.
const TURN_TIMEOUT_MS: u64 = 120_000;
/// Batched flush cadence, mirroring the renderer's rAF batching (~30ms).
const FLUSH_INTERVAL_MS: u64 = 30;

/// Drive one provider turn on the tokio runtime, forwarding batched updates
/// into `tx`. Never panics: transport failures become a terminal
/// [`StreamMsg::Error`].
pub async fn drive_stream(
    snapshot: TurnSnapshot,
    api_key: Option<String>,
    tx: tokio::sync::mpsc::UnboundedSender<StreamMsg>,
) {
    let transport = snapshot.provider.transport();
    let request = build_stream_request(&snapshot);
    let options = StreamOptions {
        api_key,
        timeout_ms: Some(TURN_TIMEOUT_MS),
        ..Default::default()
    };

    let result = transport.stream_simple(&request, &options);
    let mut reducer = StreamReducer::new();
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));

    let stream_result: Result<EventStream, ProviderError> = result;
    match stream_result {
        Ok(mut stream) => {
            use futures::StreamExt;
            loop {
                tokio::select! {
                    maybe_event = stream.next() => match maybe_event {
                        Some(Ok(event)) => reducer.apply(event),
                        Some(Err(error)) => {
                            reducer.fail(provider_error_message(&error));
                            break;
                        }
                        None => break,
                    },
                    _ = interval.tick() => {
                        if let Some(flush) = reducer.take_flush() {
                            let _ = tx.send(StreamMsg::Flush {
                                text: flush.text,
                                thinking: flush.thinking,
                                thinking_active: flush.thinking_active,
                            });
                        }
                    }
                }
            }
        }
        Err(error) => {
            reducer.fail(provider_error_message(&error));
        }
    }

    // Drain one final flush so trailing deltas reach the UI.
    if let Some(flush) = reducer.take_flush() {
        let _ = tx.send(StreamMsg::Flush {
            text: flush.text,
            thinking: flush.thinking,
            thinking_active: flush.thinking_active,
        });
    }

    match reducer.finalize() {
        StreamTerminal::Done { message, .. } => {
            let (full_text, full_thinking) = crate::services::stream::message_content(&message);
            let _ = tx.send(StreamMsg::Done {
                message,
                full_text,
                full_thinking,
            });
        }
        StreamTerminal::Error {
            message,
            partial_text,
            partial_thinking,
            ..
        } => {
            let _ = tx.send(StreamMsg::Error {
                message,
                partial_text,
                partial_thinking,
            });
        }
    }
}

/// Resolve a stored API key for the provider (keychain access — call on a
/// background thread, never the GPUI foreground).
pub fn resolve_api_key(
    keys: &aiden_data::secret_map::ProviderKeysStore,
    provider: &ConfiguredProvider,
) -> Option<String> {
    if !provider.needs_key {
        return None;
    }
    keys.get(&provider.id).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: "m1".into(),
            role,
            content: content.into(),
            created_at: 1_700_000_000_000,
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        }
    }

    #[test]
    fn history_maps_user_and_assistant_turns() {
        let history = vec![
            user(ChatRole::User, "hi"),
            user(ChatRole::Assistant, "hello there"),
            user(ChatRole::System, "you are a helper"),
        ];
        let messages = chat_history_to_messages(&history, "claude-sonnet-5", "anthropic");
        assert_eq!(messages.len(), 2, "system messages are dropped");
        assert!(
            matches!(messages[0], Message::User(ref u) if matches!(&u.content, UserContent::Text(t) if t == "hi"))
        );
        let Message::Assistant(ref a) = messages[1] else {
            panic!("expected assistant turn");
        };
        assert_eq!(a.provider, "anthropic");
        assert_eq!(a.model, "claude-sonnet-5");
        assert!(matches!(&a.content[0], ContentBlock::Text(t) if t.text == "hello there"));
    }

    #[test]
    fn history_keeps_per_message_model() {
        let mut assistant = user(ChatRole::Assistant, "hi");
        assistant.model = Some("claude-haiku-4".into());
        let messages = chat_history_to_messages(&[assistant], "claude-sonnet-5", "anthropic");
        let Message::Assistant(ref a) = messages[0] else {
            panic!();
        };
        assert_eq!(a.model, "claude-haiku-4");
    }

    #[test]
    fn empty_assistant_history_produces_no_text_block() {
        let assistant = user(ChatRole::Assistant, "");
        let messages = chat_history_to_messages(&[assistant], "m", "p");
        let Message::Assistant(ref a) = messages[0] else {
            panic!();
        };
        assert!(a.content.is_empty());
    }

    #[test]
    fn custom_provider_resolves_to_openai_completions_transport() {
        let provider = ConfiguredProvider {
            id: "custom:lmstudio".into(),
            label: "LM Studio".into(),
            kind: ProviderKind::Openai,
            base_url: "http://127.0.0.1:1234/v1".into(),
            models: vec!["qwen2.5-coder".into()],
            default_model: None,
            needs_key: false,
            has_key: false,
        };
        assert_eq!(provider.api_family(), ApiFamily::OpenAICompletions);
        // The transport is constructible and reports its fixed info id.
        let transport = provider.transport();
        assert_eq!(transport.info().id, "openai-completions");
    }

    #[test]
    fn selection_settings_roundtrip() {
        let selection = ModelSelection {
            provider_id: "anthropic".into(),
            model: "claude-sonnet-5".into(),
        };
        let value = selection.to_settings();
        assert_eq!(value["providerId"], "anthropic");
        let back = ModelSelection::from_settings(&value).expect("parses back");
        assert_eq!(back, selection);
        assert!(ModelSelection::from_settings(&serde_json::json!({})).is_none());
    }
}
