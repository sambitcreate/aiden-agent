//! Probe whether a local LLM is already resident in memory (Ollama / LM
//! Studio) — port of `main/services/local-runtime-status.ts`.
//!
//! The parsers and id-matching helpers are pure and always available. The
//! network probes (`probe_local_model_loaded`) only run when the app decides
//! to ask the user's own local server — no automatic traffic.

use aiden_core::provider_deployment::{is_local_provider_deployment, ProviderDeploymentFields};
use serde_json::Value;

/// `LocalModelLoadState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LocalModelLoadState {
    Loaded,
    Unloaded,
    #[default]
    Unknown,
}

/// `LOCAL_RUNTIME_PROBE_TIMEOUT_MS`.
pub const LOCAL_RUNTIME_PROBE_TIMEOUT_MS: u64 = 2_000;
/// `LOCAL_RUNTIME_POLL_INTERVAL_MS`.
pub const LOCAL_RUNTIME_POLL_INTERVAL_MS: u64 = 500;

/// `CUSTOM_PROVIDER_ID_PREFIX` (custom-provider-id.ts).
pub const CUSTOM_PROVIDER_ID_PREFIX: &str = "custom:";

/// `isCustomProviderId` (custom-provider-id.ts).
pub fn is_custom_provider_id(provider_id: &str) -> bool {
    provider_id.starts_with(CUSTOM_PROVIDER_ID_PREFIX)
        && provider_id.len() > CUSTOM_PROVIDER_ID_PREFIX.len()
}

/// `isOllamaProviderId` (custom-provider-id.ts).
pub fn is_ollama_provider_id(provider_id: &str) -> bool {
    provider_id == "ollama" || provider_id == format!("{CUSTOM_PROVIDER_ID_PREFIX}ollama")
}

/// `isLmStudioProviderId` (custom-provider-id.ts).
pub fn is_lm_studio_provider_id(provider_id: &str) -> bool {
    provider_id == "lmstudio" || provider_id == format!("{CUSTOM_PROVIDER_ID_PREFIX}lmstudio")
}

/// `normalizeLocalModelId` — `foo` ≡ `foo:latest`.
pub fn normalize_local_model_id(model_id: &str) -> String {
    let trimmed = model_id.trim().to_lowercase();
    if let Some(stripped) = trimmed.strip_suffix(":latest") {
        stripped.to_string()
    } else {
        trimmed
    }
}

/// `localModelIdsMatch`.
pub fn local_model_ids_match(left: &str, right: &str) -> bool {
    let a = normalize_local_model_id(left);
    let b = normalize_local_model_id(right);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.starts_with(&format!("{b}:")) || b.starts_with(&format!("{a}:"))
}

fn object(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}

/// `parseOllamaPsLoaded` — `/api/ps` `{ models: [{ model|name }] }`.
pub fn parse_ollama_ps_loaded(value: &Value, model_id: &str) -> LocalModelLoadState {
    let Some(body) = object(value) else {
        return LocalModelLoadState::Unknown;
    };
    let Some(models) = body.get("models").and_then(Value::as_array) else {
        return LocalModelLoadState::Unknown;
    };
    for entry in models {
        let Some(row) = object(entry) else {
            continue;
        };
        let name = row
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| row.get("name").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        if !name.is_empty() && local_model_ids_match(&name, model_id) {
            return LocalModelLoadState::Loaded;
        }
    }
    LocalModelLoadState::Unloaded
}

/// `parseLmStudioModelsLoaded` — v0 `{ data: [{ id, state }] }` and v1
/// `{ models: [{ key, loaded_instances }] }` shapes.
pub fn parse_lm_studio_models_loaded(value: &Value, model_id: &str) -> LocalModelLoadState {
    let Some(body) = object(value) else {
        return LocalModelLoadState::Unknown;
    };

    // REST API v0: `{ data: [{ id, state: "loaded" | "not-loaded" }] }`.
    if let Some(data) = body.get("data").and_then(Value::as_array) {
        let mut saw_match = false;
        for entry in data {
            let Some(row) = object(entry) else {
                continue;
            };
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            if id.is_empty() || !local_model_ids_match(&id, model_id) {
                continue;
            }
            saw_match = true;
            match row.get("state").and_then(Value::as_str) {
                Some("loaded") => return LocalModelLoadState::Loaded,
                Some("not-loaded") => return LocalModelLoadState::Unloaded,
                _ => {}
            }
        }
        // When JIT is off, /api/v0/models may only list loaded models.
        return if saw_match {
            LocalModelLoadState::Unknown
        } else {
            LocalModelLoadState::Unloaded
        };
    }

    // REST API v1 list: `{ models: [{ key, loaded_instances: [...] }] }`.
    if let Some(models) = body.get("models").and_then(Value::as_array) {
        let mut saw_match = false;
        for entry in models {
            let Some(row) = object(entry) else {
                continue;
            };
            let key = row
                .get("key")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| row.get("id").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            if key.is_empty() || !local_model_ids_match(&key, model_id) {
                continue;
            }
            saw_match = true;
            if let Some(instances) = row.get("loaded_instances").and_then(Value::as_array) {
                return if instances.is_empty() {
                    LocalModelLoadState::Unloaded
                } else {
                    LocalModelLoadState::Loaded
                };
            }
            match row.get("state").and_then(Value::as_str) {
                Some("loaded") => return LocalModelLoadState::Loaded,
                Some("not-loaded") => return LocalModelLoadState::Unloaded,
                _ => {}
            }
        }
        return if saw_match {
            LocalModelLoadState::Unknown
        } else {
            LocalModelLoadState::Unloaded
        };
    }

    LocalModelLoadState::Unknown
}

/// The provider shape the probe needs (`StoredProvider` subset).
pub struct LocalRuntimeProvider {
    pub id: String,
    pub base_url: String,
    pub deployment: Option<aiden_core::provider_deployment::ProviderDeployment>,
}

impl LocalRuntimeProvider {
    fn fields(&self) -> ProviderDeploymentFields {
        ProviderDeploymentFields {
            id: Some(self.id.clone()),
            base_url: Some(self.base_url.clone()),
            deployment: self.deployment,
        }
    }
}

/// `providerEndpoint` — replace the pathname of the base URL.
fn provider_endpoint(provider: &LocalRuntimeProvider, pathname: &str) -> String {
    let mut url = provider.base_url.clone();
    if let Some(fragment) = url.find('#') {
        url.truncate(fragment);
    }
    if let Some(query) = url.find('?') {
        url.truncate(query);
    }
    // Strip any trailing path so the pathname below replaces it cleanly.
    if let Some(scheme_end) = url.find("://") {
        let after_scheme = &url[scheme_end + 3..];
        if let Some(slash) = after_scheme.find('/') {
            url.truncate(scheme_end + 3 + slash);
        }
    }
    url.push_str(pathname);
    url
}

/// `fetchJson` with the probe timeout.
async fn fetch_json(url: &str) -> Result<Value, String> {
    #[cfg(feature = "dictation")]
    {
        let response = reqwest::Client::new()
            .get(url)
            .timeout(std::time::Duration::from_millis(
                LOCAL_RUNTIME_PROBE_TIMEOUT_MS,
            ))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Probe failed: {}", response.status()));
        }
        response
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(feature = "dictation"))]
    {
        let _ = (url, LOCAL_RUNTIME_PROBE_TIMEOUT_MS);
        Err("local runtime probing is unavailable in this build".into())
    }
}

async fn probe_ollama(provider: &LocalRuntimeProvider, model_id: &str) -> LocalModelLoadState {
    let url = provider_endpoint(provider, "/api/ps");
    match fetch_json(&url).await {
        Ok(value) => parse_ollama_ps_loaded(&value, model_id),
        Err(_) => LocalModelLoadState::Unknown,
    }
}

async fn probe_lm_studio(provider: &LocalRuntimeProvider, model_id: &str) -> LocalModelLoadState {
    let v0 = provider_endpoint(provider, "/api/v0/models");
    if let Ok(value) = fetch_json(&v0).await {
        let state = parse_lm_studio_models_loaded(&value, model_id);
        if state != LocalModelLoadState::Unknown {
            return state;
        }
    }
    let v1 = provider_endpoint(provider, "/api/v1/models");
    match fetch_json(&v1).await {
        Ok(value) => parse_lm_studio_models_loaded(&value, model_id),
        Err(_) => LocalModelLoadState::Unknown,
    }
}

/// `probeLocalModelLoaded` — ask the local server whether `model_id` is
/// resident in memory. Returns `Unknown` when the backend is not probeable or
/// the probe fails.
pub async fn probe_local_model_loaded(
    provider: &LocalRuntimeProvider,
    model_id: &str,
) -> LocalModelLoadState {
    if model_id.trim().is_empty() || !is_local_provider_deployment(&provider.fields()) {
        return LocalModelLoadState::Unknown;
    }
    if is_ollama_provider_id(&provider.id) {
        return probe_ollama(provider, model_id).await;
    }
    if is_lm_studio_provider_id(&provider.id) {
        return probe_lm_studio(provider, model_id).await;
    }
    // Custom local: try Ollama then LM Studio shapes.
    let ollama = probe_ollama(provider, model_id).await;
    if ollama != LocalModelLoadState::Unknown {
        return ollama;
    }
    probe_lm_studio(provider, model_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_ids_follow_the_custom_prefix_contract() {
        assert!(is_ollama_provider_id("ollama"));
        assert!(is_ollama_provider_id("custom:ollama"));
        assert!(!is_ollama_provider_id("custom:lmstudio"));
        assert!(is_lm_studio_provider_id("lmstudio"));
        assert!(is_lm_studio_provider_id("custom:lmstudio"));
        assert!(!is_lm_studio_provider_id("ollama"));
        assert!(is_custom_provider_id("custom:ollama"));
        assert!(!is_custom_provider_id("ollama"));
    }

    #[test]
    fn model_ids_normalize_and_match() {
        assert_eq!(normalize_local_model_id("Foo:latest"), "foo");
        assert_eq!(normalize_local_model_id(" foo "), "foo");
        assert!(local_model_ids_match("qwen3", "qwen3:latest"));
        assert!(local_model_ids_match("qwen3:8b", "qwen3"));
        assert!(local_model_ids_match("Qwen3:8B", "qwen3:8b"));
        assert!(!local_model_ids_match("qwen3", "llama3"));
        assert!(!local_model_ids_match("", "qwen3"));
    }

    #[test]
    fn ollama_ps_parsing_matches_the_ts() {
        let loaded = json!({ "models": [{ "model": "qwen3:8b", "name": "qwen3:8b" }] });
        assert_eq!(
            parse_ollama_ps_loaded(&loaded, "qwen3"),
            LocalModelLoadState::Loaded
        );
        let loaded_via_name = json!({ "models": [{ "name": "qwen3" }] });
        assert_eq!(
            parse_ollama_ps_loaded(&loaded_via_name, "qwen3:latest"),
            LocalModelLoadState::Loaded
        );
        let unloaded = json!({ "models": [{ "model": "llama3" }] });
        assert_eq!(
            parse_ollama_ps_loaded(&unloaded, "qwen3"),
            LocalModelLoadState::Unloaded
        );
        assert_eq!(
            parse_ollama_ps_loaded(&json!({ "nope": true }), "qwen3"),
            LocalModelLoadState::Unknown
        );
    }

    #[test]
    fn lm_studio_v0_parsing_matches_the_ts() {
        let loaded = json!({ "data": [{ "id": "qwen3:8b", "state": "loaded" }] });
        assert_eq!(
            parse_lm_studio_models_loaded(&loaded, "qwen3"),
            LocalModelLoadState::Loaded
        );
        let not_loaded = json!({ "data": [{ "id": "qwen3", "state": "not-loaded" }] });
        assert_eq!(
            parse_lm_studio_models_loaded(&not_loaded, "qwen3"),
            LocalModelLoadState::Unloaded
        );
        // JIT off: /api/v0 only lists loaded models -> a missing match is
        // "unloaded".
        let partial = json!({ "data": [{ "id": "llama3", "state": "loaded" }] });
        assert_eq!(
            parse_lm_studio_models_loaded(&partial, "qwen3"),
            LocalModelLoadState::Unloaded
        );
        assert_eq!(
            parse_lm_studio_models_loaded(&json!({}), "qwen3"),
            LocalModelLoadState::Unknown
        );
    }

    #[test]
    fn lm_studio_v1_parsing_matches_the_ts() {
        let loaded = json!({ "models": [{ "key": "qwen3", "loaded_instances": [{}, {}] }] });
        assert_eq!(
            parse_lm_studio_models_loaded(&loaded, "qwen3"),
            LocalModelLoadState::Loaded
        );
        let empty_instances = json!({ "models": [{ "key": "qwen3", "loaded_instances": [] }] });
        assert_eq!(
            parse_lm_studio_models_loaded(&empty_instances, "qwen3"),
            LocalModelLoadState::Unloaded
        );
        let state_field = json!({ "models": [{ "key": "qwen3", "state": "loaded" }] });
        assert_eq!(
            parse_lm_studio_models_loaded(&state_field, "qwen3"),
            LocalModelLoadState::Loaded
        );
    }

    #[test]
    fn provider_endpoint_replaces_the_pathname() {
        let provider = LocalRuntimeProvider {
            id: "custom:ollama".into(),
            base_url: "http://127.0.0.1:11434/v1?key=1#frag".into(),
            deployment: None,
        };
        assert_eq!(
            provider_endpoint(&provider, "/api/ps"),
            "http://127.0.0.1:11434/api/ps"
        );
    }

    #[tokio::test]
    async fn hosted_or_unknown_providers_are_not_probed() {
        let provider = LocalRuntimeProvider {
            id: "custom:remote".into(),
            base_url: "https://example.com/v1".into(),
            deployment: None,
        };
        assert_eq!(
            probe_local_model_loaded(&provider, "qwen3").await,
            LocalModelLoadState::Unknown
        );
        let provider = LocalRuntimeProvider {
            id: "custom:ollama".into(),
            base_url: "http://127.0.0.1:11434/v1".into(),
            deployment: None,
        };
        // Nothing listens on the loopback port in tests: the probe times out
        // fast and reports Unknown (never a fake status).
        let state = probe_local_model_loaded(&provider, "qwen3").await;
        assert_ne!(state, LocalModelLoadState::Loaded);
    }
}
