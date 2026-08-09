//! Live model discovery for local LLM runtimes (LM Studio, Ollama).
//!
//! Port of the local-runtime subset of `main/services/models.ts`
//! (`discoverModels` / `testConnection`): enumerate the models a *running*
//! local server actually serves, over HTTP, with bounded connect + total
//! timeouts so the settings "Test" action and the chat-service boot hook never
//! hang on an offline server.
//!
//! Endpoint mapping (TS `providerEndpoint` semantics — the base URL's pathname
//! is *replaced*, so `http://127.0.0.1:1234/v1` + `/v1/models` resolves to
//! `http://127.0.0.1:1234/v1/models`):
//!
//! - [`RuntimeKind::LmStudio`] → `{origin}/v1/models`, the OpenAI-compatible
//!   `{"data": [{"id": "..."}]}` shape LM Studio's server exposes.
//! - [`RuntimeKind::Ollama`] → `{origin}/api/tags`, the native
//!   `{"models": [{"name": "..."}]}` shape, with context windows folded from
//!   each tag's `model_info.<family>.context_length`.
//! - [`RuntimeKind::Generic`] → `{origin}/v1/models` first, then the TS
//!   generic fallback `${baseUrl}/models` on HTTP 404/405
//!   (`canFallBackFromNative`).
//!
//! The parsers are pure and fixture-tested; the network path is exercised
//! against a local mock server, so the crate never contacts a real runtime in
//! tests.

use std::collections::HashSet;
use std::time::Duration;

/// Default connection timeout — additive to the total below so a
/// black-holed server fails fast (`models.ts` `MODEL_DISCOVERY_TIMEOUT_MS` is
/// the total bound).
pub const DISCOVERY_CONNECT_TIMEOUT_MS: u64 = 5_000;
/// Default total discovery timeout (`MODEL_DISCOVERY_TIMEOUT_MS`).
pub const DISCOVERY_TOTAL_TIMEOUT_MS: u64 = 10_000;

/// Which local runtime's model-enumeration protocol to speak.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    /// LM Studio's OpenAI-compatible server (`/v1/models`).
    LmStudio,
    /// Ollama's native REST API (`/api/tags`).
    Ollama,
    /// Anything else: try the OpenAI `/v1/models` shape first.
    Generic,
}

impl RuntimeKind {
    /// A short display label for status messages.
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeKind::LmStudio => "LM Studio",
            RuntimeKind::Ollama => "Ollama",
            RuntimeKind::Generic => "OpenAI-compatible",
        }
    }
}

/// One model served by a running local runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub id: String,
    /// A human-friendly name when the endpoint reports one.
    pub name: Option<String>,
    /// The context window the endpoint reports (Ollama `model_info` /
    /// OpenAI-style `max_context_length`), when available.
    pub context_window: Option<u32>,
}

/// Discovery timeouts. [`Default`] is 5s connect / 10s total.
#[derive(Debug, Clone, Copy)]
pub struct DiscoveryOptions {
    pub connect_timeout: Duration,
    pub total_timeout: Duration,
}

impl Default for DiscoveryOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_millis(DISCOVERY_CONNECT_TIMEOUT_MS),
            total_timeout: Duration::from_millis(DISCOVERY_TOTAL_TIMEOUT_MS),
        }
    }
}

/// Why model discovery failed — every variant is user-displayable.
#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("Enter a valid HTTP(S) base URL.")]
    InvalidBaseUrl,
    #[error("Connection timed out after {seconds} seconds.")]
    Timeout { seconds: u64 },
    #[error("Could not connect to the model server ({0}).")]
    Connect(String),
    #[error("Failed to list models: HTTP {status}{message}")]
    Http { status: u16, message: String },
    #[error("Model endpoint returned an unexpected response.")]
    Unparseable,
    #[error("The model server returned invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
}

/// Enumerate the models a running local server serves. See the module docs
/// for the per-runtime endpoint + response mapping.
pub async fn discover_models(
    base_url: &str,
    runtime: RuntimeKind,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    discover_models_with_options(base_url, runtime, &DiscoveryOptions::default()).await
}

/// [`discover_models`] with explicit timeouts (the settings Test action and
/// the chat-service boot hook tune the total bound independently).
pub async fn discover_models_with_options(
    base_url: &str,
    runtime: RuntimeKind,
    options: &DiscoveryOptions,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    let client = reqwest::Client::builder()
        .connect_timeout(options.connect_timeout)
        .timeout(options.total_timeout)
        .build()
        .map_err(|error| DiscoveryError::Connect(error.to_string()))?;
    match runtime {
        RuntimeKind::LmStudio => {
            let url = provider_endpoint(base_url, "/v1/models")?;
            let body = fetch(&client, &url, options).await?;
            parse_lmstudio_models(&body)
        }
        RuntimeKind::Ollama => {
            let url = provider_endpoint(base_url, "/api/tags")?;
            let body = fetch(&client, &url, options).await?;
            parse_ollama_tags(&body)
        }
        RuntimeKind::Generic => generic_discovery(&client, base_url, options).await,
    }
}

/// Resolve the runtime kind from a provider id + base URL: known provider ids
/// (`lmstudio`, `custom:lmstudio`, `ollama`, `custom:ollama`) win, then the
/// base URL port heuristic, then [`RuntimeKind::Generic`].
pub fn runtime_kind_for_provider(provider_id: &str, base_url: &str) -> RuntimeKind {
    match provider_id {
        "lmstudio" | "custom:lmstudio" => RuntimeKind::LmStudio,
        "ollama" | "custom:ollama" => RuntimeKind::Ollama,
        _ => runtime_kind_for_base_url(base_url),
    }
}

/// Detect the runtime from a base URL: the default LM Studio port (1234) and
/// the default Ollama port (11434) are the strong signals; anything else is
/// [`RuntimeKind::Generic`] (both runtimes also serve the OpenAI `/v1/models`
/// shape, so Generic still works for them).
pub fn runtime_kind_for_base_url(base_url: &str) -> RuntimeKind {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return RuntimeKind::Generic;
    };
    match url.port() {
        Some(11434) => RuntimeKind::Ollama,
        Some(1234) => RuntimeKind::LmStudio,
        _ => RuntimeKind::Generic,
    }
}

/// Merge discovered model ids into an existing provider model list: user-added
/// models keep their order, discovered ids not already listed are appended
/// (sorted). The chat-service boot hook uses this so a running local server's
/// models appear in the picker without manual configuration.
pub fn merge_discovered_models(existing: &[String], discovered: &[DiscoveredModel]) -> Vec<String> {
    let mut merged = existing.to_vec();
    let mut seen: HashSet<String> = existing.iter().cloned().collect();
    let mut additions: Vec<String> = discovered
        .iter()
        .map(|model| model.id.clone())
        .filter(|id| seen.insert(id.clone()))
        .collect();
    additions.sort();
    merged.extend(additions);
    merged
}

// ===========================================================================
// Parsers (pure; fixture-tested)
// ===========================================================================

/// Parse an OpenAI-compatible `/v1/models` response — LM Studio's server and
/// the generic fallback both use `{"data": [{"id": "..."}]}` (a `models`
/// array is tolerated for servers that emit it). Embedding entries (`type`
/// containing "embed" or a capabilities flag) are skipped so the picker only
/// gets chat-capable ids.
pub fn parse_lmstudio_models(
    value: &serde_json::Value,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    let entries = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .or_else(|| value.get("models").and_then(serde_json::Value::as_array));
    let Some(entries) = entries else {
        return Err(DiscoveryError::Unparseable);
    };
    Ok(finalize_models(
        entries
            .iter()
            .filter(|entry| !embedding_entry(entry))
            .filter_map(openai_entry),
    ))
}

/// Parse an Ollama `/api/tags` response: `{"models": [{"name": "..."}]}`.
/// Context windows fold from each tag's `model_info.<family>.context_length`
/// (the max when several families report one), mirroring TS
/// `ollamaContextLength`.
pub fn parse_ollama_tags(
    value: &serde_json::Value,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    let Some(models) = value.get("models").and_then(serde_json::Value::as_array) else {
        return Err(DiscoveryError::Unparseable);
    };
    Ok(finalize_models(models.iter().filter_map(ollama_entry)))
}

fn openai_entry(entry: &serde_json::Value) -> Option<DiscoveredModel> {
    let object = entry.as_object()?;
    let id = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .or_else(|| object.get("key").and_then(serde_json::Value::as_str))
        .or_else(|| object.get("name").and_then(serde_json::Value::as_str))?;
    let name = object
        .get("display_name")
        .and_then(serde_json::Value::as_str)
        .or_else(|| object.get("name").and_then(serde_json::Value::as_str));
    let context_window = object
        .get("max_context_length")
        .or_else(|| object.get("context_length"))
        .and_then(finite_positive);
    Some(DiscoveredModel {
        id: id.to_string(),
        name: name.map(String::from),
        context_window,
    })
}

fn ollama_entry(entry: &serde_json::Value) -> Option<DiscoveredModel> {
    let object = entry.as_object()?;
    let id = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .or_else(|| object.get("model").and_then(serde_json::Value::as_str))?;
    let name = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .or_else(|| object.get("model").and_then(serde_json::Value::as_str));
    Some(DiscoveredModel {
        id: id.to_string(),
        name: name.map(String::from),
        context_window: ollama_context_length(object.get("model_info")),
    })
}

/// `ollamaContextLength` — max `<family>.context_length` in `model_info`.
fn ollama_context_length(value: Option<&serde_json::Value>) -> Option<u32> {
    let info = value?.as_object()?;
    info.iter()
        .filter(|(key, value)| key.ends_with(".context_length") && finite_positive(value).is_some())
        .filter_map(|(_, value)| value.as_u64())
        .max()
        .map(|length| length as u32)
}

fn embedding_entry(entry: &serde_json::Value) -> bool {
    let type_is_embedding = entry
        .get("type")
        .and_then(serde_json::Value::as_str)
        .map(|value| value.to_lowercase().contains("embed"))
        .unwrap_or(false);
    let capability_flag = entry
        .get("capabilities")
        .and_then(|value| value.as_array())
        .map(|flags| {
            flags
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|flag| flag == "embedding" || flag == "embeddings")
        })
        .unwrap_or(false);
    type_is_embedding || capability_flag
}

fn finite_positive(value: &serde_json::Value) -> Option<u32> {
    value
        .as_u64()
        .map(|value| value as u32)
        .filter(|value| *value > 0)
}

/// Sort by id and collapse duplicate ids (first occurrence wins) so discovery
/// output is deterministic for callers and tests.
fn finalize_models(models: impl IntoIterator<Item = DiscoveredModel>) -> Vec<DiscoveredModel> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut models: Vec<DiscoveredModel> = models
        .into_iter()
        .filter(|model| seen.insert(model.id.clone()))
        .collect();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models
}

// ===========================================================================
// HTTP (bounded; local runtimes are keyless, so no auth headers)
// ===========================================================================

/// `providerEndpoint` — replace the base URL's pathname.
fn provider_endpoint(base_url: &str, pathname: &str) -> Result<String, DiscoveryError> {
    let mut url = parse_http_url(base_url)?;
    url.set_path(pathname);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

/// TS generic fallback: append `/models` to the literal base URL.
fn generic_models_endpoint(base_url: &str) -> Result<String, DiscoveryError> {
    let url = parse_http_url(base_url)?;
    let mut text = url.to_string();
    text = text.trim_end_matches('/').to_string();
    Ok(format!("{text}/models"))
}

fn parse_http_url(base_url: &str) -> Result<url::Url, DiscoveryError> {
    let input = base_url.trim();
    let Ok(url) = url::Url::parse(input) else {
        return Err(DiscoveryError::InvalidBaseUrl);
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(DiscoveryError::InvalidBaseUrl);
    }
    if url.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(DiscoveryError::InvalidBaseUrl);
    }
    Ok(url)
}

async fn generic_discovery(
    client: &reqwest::Client,
    base_url: &str,
    options: &DiscoveryOptions,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    let first = provider_endpoint(base_url, "/v1/models")?;
    match fetch(client, &first, options).await {
        Ok(body) => parse_lmstudio_models(&body),
        // `canFallBackFromNative` (models.ts): only 404/405 fall through to
        // the bare `${baseUrl}/models`; timeouts / connection errors surface.
        Err(error) if http_status(&error).is_some_and(|status| status == 404 || status == 405) => {
            let second = generic_models_endpoint(base_url)?;
            let body = fetch(client, &second, options).await?;
            parse_lmstudio_models(&body)
        }
        Err(error) => Err(error),
    }
}

fn http_status(error: &DiscoveryError) -> Option<u16> {
    match error {
        DiscoveryError::Http { status, .. } => Some(*status),
        _ => None,
    }
}

async fn fetch(
    client: &reqwest::Client,
    url: &str,
    options: &DiscoveryOptions,
) -> Result<serde_json::Value, DiscoveryError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| classify(&error, options))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let body = body.trim();
        let message = if body.is_empty() {
            String::new()
        } else {
            let truncated: String = body.chars().take(200).collect();
            format!(" — {truncated}")
        };
        return Err(DiscoveryError::Http { status, message });
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| classify(&error, options))
}

fn classify(error: &reqwest::Error, options: &DiscoveryOptions) -> DiscoveryError {
    if error.is_timeout() {
        return DiscoveryError::Timeout {
            seconds: options.total_timeout.as_secs().max(1),
        };
    }
    if error.is_decode() {
        return DiscoveryError::Unparseable;
    }
    DiscoveryError::Connect(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // ------------------------------------------------------------------
    // Runtime detection
    // ------------------------------------------------------------------

    #[test]
    fn runtime_kind_is_detected_from_base_url() {
        assert_eq!(
            runtime_kind_for_base_url("http://localhost:11434"),
            RuntimeKind::Ollama
        );
        assert_eq!(
            runtime_kind_for_base_url("http://127.0.0.1:11434/v1"),
            RuntimeKind::Ollama
        );
        assert_eq!(
            runtime_kind_for_base_url("http://localhost:1234/v1"),
            RuntimeKind::LmStudio
        );
        assert_eq!(
            runtime_kind_for_base_url("http://127.0.0.1:1234"),
            RuntimeKind::LmStudio
        );
        assert_eq!(
            runtime_kind_for_base_url("https://api.openai.com/v1"),
            RuntimeKind::Generic
        );
        assert_eq!(
            runtime_kind_for_base_url("http://localhost:8080/v1"),
            RuntimeKind::Generic
        );
        assert_eq!(runtime_kind_for_base_url("not a url"), RuntimeKind::Generic);
        assert_eq!(runtime_kind_for_base_url(""), RuntimeKind::Generic);
    }

    #[test]
    fn runtime_kind_prefers_known_provider_ids() {
        assert_eq!(
            runtime_kind_for_provider("custom:lmstudio", "https://remote.example/v1"),
            RuntimeKind::LmStudio
        );
        assert_eq!(
            runtime_kind_for_provider("ollama", "https://remote.example"),
            RuntimeKind::Ollama
        );
        assert_eq!(
            runtime_kind_for_provider("custom:connection-1", "http://localhost:1234/v1"),
            RuntimeKind::LmStudio
        );
        assert_eq!(
            runtime_kind_for_provider("custom:connection-1", "http://localhost:11434"),
            RuntimeKind::Ollama
        );
        assert_eq!(
            runtime_kind_for_provider("custom:connection-1", "http://localhost:8000/v1"),
            RuntimeKind::Generic
        );
    }

    // ------------------------------------------------------------------
    // Parsing fixtures (inline JSON, no network)
    // ------------------------------------------------------------------

    #[test]
    fn lm_studio_parses_openai_data_array() {
        let value = json!({
            "object": "list",
            "data": [
                {"id": "qwen2.5-coder-7b-instruct", "object": "model", "max_context_length": 32768},
                {"id": "embedding-model", "type": "embedding"},
                {"id": "llama-3.1", "display_name": "Llama 3.1 8B", "context_length": 128000}
            ]
        });
        let models = parse_lmstudio_models(&value).unwrap();
        assert_eq!(models.len(), 2, "embedding entries are skipped");
        assert_eq!(models[0].id, "llama-3.1");
        assert_eq!(models[0].name.as_deref(), Some("Llama 3.1 8B"));
        assert_eq!(models[0].context_window, Some(128_000));
        assert_eq!(models[1].id, "qwen2.5-coder-7b-instruct");
        assert_eq!(models[1].context_window, Some(32_768));
    }

    #[test]
    fn lm_studio_tolerates_a_models_array_with_keys() {
        let value = json!({
            "models": [
                {"key": "qwen2.5", "display_name": "Qwen", "max_context_length": 32768},
                {"id": "nomic-embed-text", "capabilities": ["embedding"]}
            ]
        });
        let models = parse_lmstudio_models(&value).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen2.5");
        assert_eq!(models[0].context_window, Some(32_768));
    }

    #[test]
    fn lm_studio_empty_and_unparseable_bodies() {
        assert_eq!(
            parse_lmstudio_models(&json!({ "data": [] })).unwrap(),
            vec![]
        );
        assert!(matches!(
            parse_lmstudio_models(&json!({ "foo": 1 })),
            Err(DiscoveryError::Unparseable)
        ));
        assert!(matches!(
            parse_lmstudio_models(&json!("nope")),
            Err(DiscoveryError::Unparseable)
        ));
    }

    #[test]
    fn ollama_tags_parse_names_and_context_windows() {
        let value = json!({
            "models": [
                {"name": "llama3.2:latest", "model": "llama3.2",
                 "model_info": {"llama.context_length": 131072, "other.context_length": 4096}},
                {"name": "qwen3:8b", "model": "qwen3:8b",
                 "model_info": {"qwen2.context_length": 32768}},
                {"name": "embed-test", "model": "embed-test"}
            ]
        });
        let models = parse_ollama_tags(&value).unwrap();
        assert_eq!(models.len(), 3);
        // `finalize_models` sorts by id, so the fixture order is not preserved.
        assert_eq!(models[0].id, "embed-test");
        assert_eq!(models[0].context_window, None);
        assert_eq!(models[1].id, "llama3.2:latest");
        assert_eq!(
            models[1].context_window,
            Some(131_072),
            "the max family context window wins"
        );
        assert_eq!(models[1].name.as_deref(), Some("llama3.2:latest"));
        assert_eq!(models[2].id, "qwen3:8b");
        assert_eq!(models[2].context_window, Some(32_768));
    }

    #[test]
    fn ollama_tags_without_models_array_is_unparseable() {
        assert!(matches!(
            parse_ollama_tags(&json!({})),
            Err(DiscoveryError::Unparseable)
        ));
        assert!(matches!(
            parse_ollama_tags(&json!({ "nope": true })),
            Err(DiscoveryError::Unparseable)
        ));
        assert_eq!(parse_ollama_tags(&json!({ "models": [] })).unwrap(), vec![]);
    }

    #[test]
    fn merging_preserves_user_models_and_dedupes() {
        let existing = vec!["user-model".to_string(), "llama3".to_string()];
        let discovered = vec![
            DiscoveredModel {
                id: "llama3".into(),
                name: None,
                context_window: None,
            },
            DiscoveredModel {
                id: "qwen3:8b".into(),
                name: None,
                context_window: Some(32_768),
            },
            DiscoveredModel {
                id: "llama3.2".into(),
                name: None,
                context_window: None,
            },
        ];
        let merged = merge_discovered_models(&existing, &discovered);
        assert_eq!(merged, vec!["user-model", "llama3", "llama3.2", "qwen3:8b"]);
        // Empty discovery leaves the list untouched.
        assert_eq!(merge_discovered_models(&existing, &[]), existing);
    }

    // ------------------------------------------------------------------
    // Endpoint construction
    // ------------------------------------------------------------------

    #[test]
    fn endpoints_replace_the_base_url_pathname() {
        assert_eq!(
            provider_endpoint("http://127.0.0.1:1234/v1", "/v1/models").unwrap(),
            "http://127.0.0.1:1234/v1/models"
        );
        assert_eq!(
            provider_endpoint("http://localhost:11434", "/api/tags").unwrap(),
            "http://localhost:11434/api/tags"
        );
        assert_eq!(
            provider_endpoint("http://localhost:11434/v1?key=1#frag", "/api/tags").unwrap(),
            "http://localhost:11434/api/tags"
        );
        assert_eq!(
            generic_models_endpoint("http://127.0.0.1:1234/v1/").unwrap(),
            "http://127.0.0.1:1234/v1/models"
        );
        assert!(matches!(
            provider_endpoint("not a url", "/x"),
            Err(DiscoveryError::InvalidBaseUrl)
        ));
        assert!(matches!(
            provider_endpoint("ftp://x", "/x"),
            Err(DiscoveryError::InvalidBaseUrl)
        ));
        assert!(matches!(
            provider_endpoint("http://", "/x"),
            Err(DiscoveryError::InvalidBaseUrl)
        ));
    }

    // ------------------------------------------------------------------
    // Network (mock server on a loopback port)
    // ------------------------------------------------------------------

    struct MockServer {
        base: String,
        handle: tokio::task::JoinHandle<()>,
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    /// Serve canned responses by request-path prefix until dropped.
    async fn mock_server(routes: &[(&'static str, u16, &'static str)]) -> MockServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let routes: Vec<(String, u16, String)> = routes
            .iter()
            .map(|(path, status, body)| (path.to_string(), *status, body.to_string()))
            .collect();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut buffer = [0u8; 4096];
                let Ok(read) = socket.read(&mut buffer).await else {
                    continue;
                };
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let (status, body) = routes
                    .iter()
                    .find(|(prefix, _, _)| path.starts_with(prefix))
                    .map(|(_, status, body)| (*status, body.clone()))
                    .unwrap_or((404, "{}".to_string()));
                let reason = if status == 200 { "OK" } else { "Not Found" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        MockServer {
            base: format!("http://{address}"),
            handle,
        }
    }

    #[tokio::test]
    async fn lm_studio_discovery_hits_v1_models() {
        let server = mock_server(&[(
            "/v1/models",
            200,
            r#"{"data":[{"id":"qwen2.5","max_context_length":32768},{"id":"embed","type":"embedding"}]}"#,
        )])
        .await;
        let models = discover_models(&server.base, RuntimeKind::LmStudio)
            .await
            .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen2.5");
        assert_eq!(models[0].context_window, Some(32_768));
    }

    #[tokio::test]
    async fn ollama_discovery_hits_api_tags() {
        let server = mock_server(&[(
            "/api/tags",
            200,
            r#"{"models":[{"name":"llama3.2:latest","model_info":{"llama.context_length":131072}}]}"#,
        )])
        .await;
        let models = discover_models(&server.base, RuntimeKind::Ollama)
            .await
            .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "llama3.2:latest");
        assert_eq!(models[0].context_window, Some(131_072));
    }

    #[tokio::test]
    async fn generic_discovery_serves_v1_models_directly() {
        let server = mock_server(&[("/v1/models", 200, r#"{"data":[{"id":"direct"}]}"#)]).await;
        let models = discover_models(&server.base, RuntimeKind::Generic)
            .await
            .unwrap();
        assert_eq!(models[0].id, "direct");
    }

    #[tokio::test]
    async fn generic_discovery_falls_back_from_404_to_base_url_models() {
        let server = mock_server(&[
            ("/v1/models", 404, "{}"),
            (
                "/models",
                200,
                r#"{"data":[{"id":"custom-1"},{"id":"custom-2"}]}"#,
            ),
        ])
        .await;
        let models = discover_models(&server.base, RuntimeKind::Generic)
            .await
            .unwrap();
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, vec!["custom-1", "custom-2"]);
    }

    #[tokio::test]
    async fn discovery_surfaces_http_errors() {
        let server = mock_server(&[("/v1/models", 500, "boom")]).await;
        let error = discover_models(&server.base, RuntimeKind::LmStudio)
            .await
            .unwrap_err();
        assert!(matches!(error, DiscoveryError::Http { status: 500, .. }));
    }

    #[tokio::test]
    async fn discovery_times_out_when_the_server_never_responds() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            // Accept the connection and hold it open without answering.
            if let Ok((_socket, _)) = listener.accept().await {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
        let options = DiscoveryOptions {
            connect_timeout: Duration::from_millis(100),
            total_timeout: Duration::from_millis(250),
        };
        let base = format!("http://{address}");
        let result = discover_models_with_options(&base, RuntimeKind::Ollama, &options).await;
        server.abort();
        assert!(
            matches!(result, Err(DiscoveryError::Timeout { .. })),
            "expected a timeout error, got {result:?}"
        );
    }

    #[tokio::test]
    async fn discovery_connection_refused_is_reported() {
        // Bind, note the port, then drop the listener so nothing listens.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = discover_models(&format!("http://{address}"), RuntimeKind::LmStudio)
            .await
            .unwrap_err();
        assert!(matches!(error, DiscoveryError::Connect(_)), "got {error:?}");
    }
}
