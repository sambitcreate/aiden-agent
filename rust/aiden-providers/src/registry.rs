//! Provider registry: provider id → [`Provider`] impl + auth material.
//!
//! Aiden's generation path resolves a model runtime (see
//! [`crate::catalog::resolve_model_runtime`]) and then dispatches through the
//! matching provider. The registry owns that dispatch table plus the
//! device-local API-key resolver (keychain wiring lives in `aiden-data`), so
//! request auth is attached automatically when the caller did not set one.

use std::collections::HashMap;
use std::sync::Arc;

use crate::{EventStream, Provider, ProviderError, StreamOptions, StreamRequest};

/// Resolves a stored API key for a provider id (encrypted store in
/// `aiden-data`). Returns `None` when no key is stored.
pub trait ApiKeyResolver: Send + Sync {
    fn api_key(&self, provider_id: &str) -> Option<String>;
}

/// A no-op resolver for keyless flows.
#[derive(Debug, Clone, Default)]
pub struct NoopApiKeyResolver;

impl ApiKeyResolver for NoopApiKeyResolver {
    fn api_key(&self, _provider_id: &str) -> Option<String> {
        None
    }
}

/// A plain in-memory resolver (tests, temporary wiring).
#[derive(Debug, Clone, Default)]
pub struct MemoryApiKeyResolver {
    keys: HashMap<String, String>,
}

impl MemoryApiKeyResolver {
    pub fn new(keys: HashMap<String, String>) -> Self {
        Self { keys }
    }
}

impl ApiKeyResolver for MemoryApiKeyResolver {
    fn api_key(&self, provider_id: &str) -> Option<String> {
        self.keys.get(provider_id).cloned()
    }
}

/// The provider dispatch table + auth material for the running app.
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn Provider>>,
    api_keys: Arc<dyn ApiKeyResolver>,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new(Arc::new(NoopApiKeyResolver))
    }
}

impl ProviderRegistry {
    pub fn new(api_keys: Arc<dyn ApiKeyResolver>) -> Self {
        Self {
            providers: HashMap::new(),
            api_keys,
        }
    }

    pub fn register(&mut self, provider: Arc<dyn Provider>) {
        let info = provider.info();
        self.providers.insert(info.id, provider);
    }

    pub fn get(&self, provider_id: &str) -> Option<Arc<dyn Provider>> {
        self.providers.get(provider_id).cloned()
    }

    /// Provider ids in insertion order.
    pub fn ids(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    /// Attach the stored API key when the caller did not supply one.
    pub fn resolve_auth(&self, provider_id: &str, options: &StreamOptions) -> StreamOptions {
        if options.api_key.is_some() {
            return options.clone();
        }
        let mut resolved = options.clone();
        resolved.api_key = self.api_keys.api_key(provider_id);
        resolved
    }

    /// Resolve auth and dispatch one turn through the matching provider.
    /// Mirrors the TS contract: missing provider or auth is a typed error;
    /// transport failures surface as terminal stream events.
    pub fn stream_simple(
        &self,
        provider_id: &str,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<EventStream, ProviderError> {
        let provider = self.providers.get(provider_id).ok_or_else(|| {
            ProviderError::Config(format!("Provider \"{provider_id}\" is not registered."))
        })?;
        let options = self.resolve_auth(provider_id, options);
        provider.stream_simple(request, &options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anthropic::AnthropicProvider;
    use crate::google::GoogleProvider;
    use crate::{ApiFamily, ProviderInfo};
    use aiden_core::Message;

    struct CountingProvider(Arc<std::sync::atomic::AtomicUsize>, ProviderInfo);

    impl Provider for CountingProvider {
        fn info(&self) -> ProviderInfo {
            self.1.clone()
        }
        fn stream_simple(
            &self,
            _request: &StreamRequest,
            options: &StreamOptions,
        ) -> Result<EventStream, ProviderError> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(options.api_key.as_deref(), Some("k-123"));
            let stream =
                futures::stream::iter(vec![Ok(aiden_core::AssistantMessageEvent::Start {
                    partial: aiden_core::AssistantMessage {
                        content: Vec::new(),
                        api: "openai-completions".into(),
                        provider: self.1.id.clone(),
                        model: "m".into(),
                        response_model: None,
                        response_id: None,
                        usage: aiden_core::Usage {
                            input: 0,
                            output: 0,
                            cache_read: 0,
                            cache_write: 0,
                            cache_write_1h: None,
                            reasoning: None,
                            total_tokens: 0,
                            cost: aiden_core::UsageCost {
                                input: 0.0,
                                output: 0.0,
                                cache_read: 0.0,
                                cache_write: 0.0,
                                total: 0.0,
                            },
                        },
                        stop_reason: aiden_core::StopReason::Stop,
                        error_message: None,
                        timestamp: 1,
                    },
                })]);
            Ok(Box::pin(stream))
        }
    }

    #[test]
    fn registry_dispatches_with_auto_auth() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut keys = HashMap::new();
        keys.insert("custom:test".to_string(), "k-123".to_string());
        let mut registry = ProviderRegistry::new(Arc::new(MemoryApiKeyResolver::new(keys)));
        registry.register(Arc::new(CountingProvider(
            calls.clone(),
            ProviderInfo {
                id: "custom:test".into(),
                label: "Test".into(),
            },
        )));
        registry.register(Arc::new(AnthropicProvider::default()));
        registry.register(Arc::new(GoogleProvider::default()));
        assert_eq!(registry.ids().len(), 3);
        assert!(!registry.is_empty());

        let request = StreamRequest {
            provider_id: "custom:test".into(),
            api: ApiFamily::OpenAICompletions,
            model: "m".into(),
            base_url: "http://127.0.0.1:1/v1".into(),
            messages: Vec::<Message>::new(),
            ..Default::default()
        };
        let mut stream = registry
            .stream_simple("custom:test", &request, &StreamOptions::default())
            .unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let first = rt.block_on(futures::StreamExt::next(&mut stream));
        assert!(matches!(
            first,
            Some(Ok(aiden_core::AssistantMessageEvent::Start { .. }))
        ));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn registry_errors_for_unregistered_provider() {
        let registry = ProviderRegistry::new(Arc::new(NoopApiKeyResolver));
        let request = StreamRequest::default();
        match registry.stream_simple("missing", &request, &StreamOptions::default()) {
            Err(err) => assert!(err.to_string().contains("not registered")),
            Ok(_) => panic!("expected error for unregistered provider"),
        }
    }

    #[test]
    fn explicit_api_key_wins_over_resolver() {
        let mut keys = HashMap::new();
        keys.insert("p".to_string(), "stored".to_string());
        let registry = ProviderRegistry::new(Arc::new(MemoryApiKeyResolver::new(keys)));
        let options = StreamOptions {
            api_key: Some("explicit".into()),
            ..Default::default()
        };
        let resolved = registry.resolve_auth("p", &options);
        assert_eq!(resolved.api_key.as_deref(), Some("explicit"));
        let resolved = registry.resolve_auth("p", &StreamOptions::default());
        assert_eq!(resolved.api_key.as_deref(), Some("stored"));
        let resolved = registry.resolve_auth("nope", &StreamOptions::default());
        assert_eq!(resolved.api_key, None);
    }
}
