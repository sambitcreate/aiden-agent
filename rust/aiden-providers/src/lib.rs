//! Provider abstraction and SSE streaming transport.
//!
//! This crate ports the pi-ai surface Aiden actually uses
//! (`main/services/generation-runtime.ts`, `model-runtime-core.ts`,
//! `generation-context.ts`, `models.ts`): a normalized `Provider` trait whose
//! `stream_simple` returns a stream of [`AssistantMessageEvent`]s, concrete
//! transports for the five API families Aiden talks to (anthropic-messages,
//! google-generative-ai, openai-completions, openai-responses,
//! openai-codex-responses), the model catalog + runtime resolution, token
//! estimation, and deterministic context compaction.
//!
//! Design notes (mirroring the vendored TS):
//! - Streams never throw: transport failures surface as terminal
//!   [`AssistantMessageEvent::Error`] events (`stop_reason == Error | Aborted`)
//!   matching the pi-ai contract.
//! - Every provider's SSE parsing is a pure, stateful frame parser shared by
//!   the live `reqwest` byte stream and the fixture tests — no network in
//!   tests.
//! - `aiden-core` stays tokio-free; async transport lives here behind the
//!   [`Provider`] trait.

use std::collections::HashMap;

use aiden_core::{AssistantMessageEvent, Message, ToolDef};
use futures::Stream;
use futures::StreamExt;

pub mod anthropic;
pub mod artificial_analysis;
pub mod auth_flow;
pub mod builtin;
pub mod catalog;
pub mod codex;
pub mod codex_oauth;
pub mod compact;
pub mod estimate;
pub mod gemini_cache;
pub mod google;
pub mod json;
pub mod list;
pub mod openai_completions;
pub mod openai_responses;
pub mod registry;
pub mod responses_shared;
pub mod sse;
pub mod transform;
pub mod web_search;

pub use anthropic::{parse_anthropic_sse, AnthropicAccumulator, AnthropicProvider};
pub use sse::{data_payloads, sse_frames, SseDecoder};

// ===========================================================================
// Request / response types
// ===========================================================================

/// Thinking effort levels from the pi contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ThinkingLevel {
    /// The wire name used by the OpenAI `reasoning_effort` field and the
    /// thinking-level maps (`off` is handled separately by callers).
    pub fn as_str(self) -> &'static str {
        match self {
            ThinkingLevel::Minimal => "minimal",
            ThinkingLevel::Low => "low",
            ThinkingLevel::Medium => "medium",
            ThinkingLevel::High => "high",
            ThinkingLevel::Xhigh => "xhigh",
            ThinkingLevel::Max => "max",
        }
    }

    /// The pi extended thinking levels in order (`models.js`).
    pub fn extended_order() -> &'static [ThinkingLevel] {
        &[
            ThinkingLevel::Minimal,
            ThinkingLevel::Low,
            ThinkingLevel::Medium,
            ThinkingLevel::High,
            ThinkingLevel::Xhigh,
            ThinkingLevel::Max,
        ]
    }

    /// `clampReasoning` — xhigh/max collapse to high for budget math.
    pub fn clamped_for_budget(self) -> ThinkingLevel {
        match self {
            ThinkingLevel::Xhigh | ThinkingLevel::Max => ThinkingLevel::High,
            other => other,
        }
    }
}

/// Look up a thinking-level-map entry. Returns `Ok(value)` when the key is
/// present, `Err(())` when absent (pi treats absent as supported, explicit
/// `null` as unsupported).
fn thinking_map_entry(
    map: Option<&std::collections::HashMap<String, Option<String>>>,
    key: &str,
) -> Result<Option<String>, ()> {
    match map.and_then(|m| m.get(key)) {
        Some(value) => Ok(value.clone()),
        None => Err(()),
    }
}

/// `clampThinkingLevel` (`models.js`) with `off` represented as `None`.
///
/// Supported levels: `off` unless the map explicitly nulls it, every extended
/// level except explicit `null` entries, and xhigh/max only when the map
/// explicitly maps them. Prefers the next-higher supported level, then the
/// nearest lower one.
pub fn clamp_thinking_level(
    reasoning: bool,
    thinking_level_map: Option<&std::collections::HashMap<String, Option<String>>>,
    level: ThinkingLevel,
) -> Option<ThinkingLevel> {
    if !reasoning {
        return None;
    }
    let off_available = thinking_map_entry(thinking_level_map, "off") != Ok(None);
    let level_available = |candidate: ThinkingLevel| -> bool {
        let entry = thinking_map_entry(thinking_level_map, candidate.as_str());
        match candidate {
            ThinkingLevel::Xhigh | ThinkingLevel::Max => matches!(entry, Ok(Some(_))),
            _ => entry != Ok(None),
        }
    };
    let available: Vec<Option<ThinkingLevel>> = {
        let mut levels = Vec::new();
        if off_available {
            levels.push(None);
        }
        for candidate in ThinkingLevel::extended_order() {
            if level_available(*candidate) {
                levels.push(Some(*candidate));
            }
        }
        levels
    };
    if available.contains(&Some(level)) {
        return Some(level);
    }
    // extended with `off` at index 0, mirroring `EXTENDED_THINKING_LEVELS`.
    let extended: Vec<Option<ThinkingLevel>> = std::iter::once(None)
        .chain(ThinkingLevel::extended_order().iter().copied().map(Some))
        .collect();
    let Some(requested_index) = extended
        .iter()
        .position(|candidate| *candidate == Some(level))
    else {
        return available.first().copied().flatten();
    };
    for candidate in &extended[requested_index..] {
        if available.contains(candidate) {
            return *candidate;
        }
    }
    for candidate in extended[..requested_index].iter().rev() {
        if available.contains(candidate) {
            return *candidate;
        }
    }
    available.first().copied().flatten()
}

/// The five API families Aiden routes to (pi `KnownApi` subset).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiFamily {
    AnthropicMessages,
    GoogleGenerativeAi,
    OpenAICompletions,
    OpenAIResponses,
    OpenAICodexResponses,
}

impl ApiFamily {
    /// The pi-ai `KnownApi` string this family dispatches to.
    pub fn as_str(self) -> &'static str {
        match self {
            ApiFamily::AnthropicMessages => "anthropic-messages",
            ApiFamily::GoogleGenerativeAi => "google-generative-ai",
            ApiFamily::OpenAICompletions => "openai-completions",
            ApiFamily::OpenAIResponses => "openai-responses",
            ApiFamily::OpenAICodexResponses => "openai-codex-responses",
        }
    }
}

/// Prompt-cache retention preference (pi `cacheRetention`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheRetention {
    None,
    Short,
    Long,
}

/// A request to generate one assistant turn.
///
/// The catalog layer (`catalog::resolve_model_runtime`) produces the
/// `provider_id` / `api` / model-metadata fields from a `StoredProvider` +
/// `Model` pair; `messages`/`tools` come from the chat context. Field names
/// follow the pi `Model` + `Context` + `SimpleStreamOptions` contract.
#[derive(Debug, Clone)]
pub struct StreamRequest {
    /// Aiden provider id (`google`, `openai-codex`, `custom:...`, ...).
    pub provider_id: String,
    /// Wire API family for message conversion and endpoint shaping.
    pub api: ApiFamily,
    pub model: String,
    /// Resolved base URL (already suffix-normalized for the family).
    pub base_url: String,
    /// `Model.reasoning` — gates thinking config and developer-role usage.
    pub reasoning: bool,
    /// `Model.thinkingLevelMap` — pi level → provider value; `None` value =
    /// unsupported.
    pub thinking_level_map: Option<HashMap<String, Option<String>>>,
    /// Pi `Model.compat.forceAdaptiveThinking` for Anthropic Messages.
    pub force_adaptive_thinking: bool,
    /// `Model.input` includes `"image"`.
    pub vision: bool,
    pub context_window: u32,
    /// `Model.maxTokens`.
    pub max_tokens_limit: u32,
    pub messages: Vec<Message>,
    pub system_prompt: Option<String>,
    pub max_tokens: Option<u32>,
    pub thinking_level: Option<ThinkingLevel>,
    pub tools: Vec<ToolDef>,
    pub temperature: Option<f64>,
    pub session_id: Option<String>,
    pub reasoning_summary: Option<String>,
    pub text_verbosity: Option<String>,
    pub service_tier: Option<String>,
    pub tool_choice: Option<String>,
    /// Static model-config headers (`Model.headers`).
    pub model_headers: HashMap<String, String>,
}

impl Default for StreamRequest {
    fn default() -> Self {
        Self {
            provider_id: String::new(),
            api: ApiFamily::OpenAICompletions,
            model: String::new(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            force_adaptive_thinking: false,
            vision: false,
            context_window: 0,
            max_tokens_limit: 0,
            messages: Vec::new(),
            system_prompt: None,
            max_tokens: None,
            thinking_level: None,
            tools: Vec::new(),
            temperature: None,
            session_id: None,
            reasoning_summary: None,
            text_verbosity: None,
            service_tier: None,
            tool_choice: None,
            model_headers: HashMap::new(),
        }
    }
}

/// Options resolved per request (key resolution, timeouts, retries).
#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    pub api_key: Option<String>,
    pub temperature: Option<f64>,
    pub timeout_ms: Option<u64>,
    pub max_retries: Option<u32>,
    pub max_retry_delay_ms: Option<u64>,
    pub session_id: Option<String>,
    pub cache_retention: Option<CacheRetention>,
    /// `"sse"` | `"websocket"` | `"auto"` — only `"sse"` is implemented.
    pub transport: Option<String>,
    pub reasoning_summary: Option<String>,
    pub text_verbosity: Option<String>,
    pub service_tier: Option<String>,
    pub tool_choice: Option<String>,
    /// Per-effort thinking budgets keyed by level name (`minimal`, `low`, ...).
    pub thinking_budgets: Option<HashMap<String, u32>>,
    /// Extra headers; a `None` value suppresses a provider default header.
    pub headers: HashMap<String, Option<String>>,
}

/// Metadata about a provider (catalog scaffolding for the model picker).
#[derive(Debug, Clone)]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
}

/// A stream of normalized assistant events.
pub type EventStream = BoxStream<'static, Result<AssistantMessageEvent, ProviderError>>;

pub type BoxStream<'a, T> = std::pin::Pin<Box<dyn Stream<Item = T> + Send + 'a>>;

// ===========================================================================
// Errors
// ===========================================================================

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("request construction failed: {0}")]
    Request(String),
    #[error("stream transport failed: {0}")]
    Stream(String),
    #[error("invalid server event: {0}")]
    Protocol(String),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("provider configuration error: {0}")]
    Config(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("http error {status}: {message}")]
    Http { status: u16, message: String },
}

impl ProviderError {
    /// Compose a display message from a normalizable provider error, mirroring
    /// pi's `formatProviderError`: status + body when the message does not
    /// already carry them.
    pub fn from_http_status(status: u16, message: String) -> Self {
        ProviderError::Http { status, message }
    }
}

/// The user-facing message of a provider error, without the enum-variant
/// prefix (used when recording `errorMessage` on terminal events, matching the
/// JS `formatProviderError(normalizeProviderError(error))` output).
pub fn provider_error_message(err: &ProviderError) -> String {
    match err {
        ProviderError::Stream(message)
        | ProviderError::Config(message)
        | ProviderError::Auth(message)
        | ProviderError::Request(message) => message.clone(),
        ProviderError::Json(json) => json.to_string(),
        ProviderError::Protocol(message) => message.clone(),
        ProviderError::Http { status, message } => format!("{status}: {message}"),
    }
}

// ===========================================================================
// Provider trait
// ===========================================================================

/// The normalized provider surface — one impl per API family (anthropic,
/// google, openai-completions, openai-responses, codex-responses). Aiden needs
/// five of pi's ten APIs.
pub trait Provider: Send + Sync {
    fn info(&self) -> ProviderInfo;

    /// Stream one turn. Implementations must resolve the API key themselves
    /// (or refuse), build the wire request, and map wire events to
    /// [`AssistantMessageEvent`]s.
    fn stream_simple(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<EventStream, ProviderError>;
}

// ===========================================================================
// Transport helpers
// ===========================================================================

/// Wrap a `reqwest::Response` body as a stream of data-only SSE payload
/// strings (`[DONE]` included). The pure [`SseDecoder`] does the splitting, so
/// the same parser runs in fixture tests and over the live byte stream.
pub fn sse_payload_stream(
    response: reqwest::Response,
) -> impl Stream<Item = Result<String, ProviderError>> + Send + 'static {
    futures::stream::unfold(
        (response.bytes_stream(), SseDecoder::new()),
        |(mut bytes, mut decoder)| async move {
            match bytes.next().await {
                Some(Ok(chunk)) => {
                    let payloads: Vec<_> = decoder.push(&chunk).into_iter().map(Ok).collect();
                    Some((futures::stream::iter(payloads), (bytes, decoder)))
                }
                Some(Err(err)) => {
                    let item = Err(ProviderError::Stream(err.to_string()));
                    Some((futures::stream::iter(vec![item]), (bytes, decoder)))
                }
                None => {
                    let payloads: Vec<_> = decoder.finish().into_iter().map(Ok).collect();
                    Some((futures::stream::iter(payloads), (bytes, decoder)))
                }
            }
        },
    )
    .flatten()
}

/// Build an Anthropic-style request body from a normalized request. Nullable
/// optional fields (`system`, `temperature`) are omitted rather than emitted
/// as JSON `null`, which the Messages API rejects with a validation error.
pub fn anthropic_request_body(
    request: &StreamRequest,
    options: &StreamOptions,
) -> serde_json::Value {
    const MIN_ANSWER_TOKENS: u32 = 1024;
    let model_max_tokens = if request.max_tokens_limit == 0 {
        8192
    } else {
        request.max_tokens_limit
    };
    let mut max_tokens = request.max_tokens.unwrap_or(model_max_tokens);
    let cache_control = match options.cache_retention.unwrap_or(CacheRetention::Short) {
        CacheRetention::None => None,
        CacheRetention::Short => Some(serde_json::json!({ "type": "ephemeral" })),
        CacheRetention::Long => Some(serde_json::json!({ "type": "ephemeral", "ttl": "1h" })),
    };
    let mut body = serde_json::Map::new();
    body.insert("model".into(), serde_json::json!(request.model));
    body.insert("stream".into(), serde_json::Value::Bool(true));
    if let Some(system) = &request.system_prompt {
        let mut block = serde_json::json!({ "type": "text", "text": system });
        if let Some(cache_control) = &cache_control {
            block["cache_control"] = cache_control.clone();
        }
        body.insert("system".into(), serde_json::json!([block]));
    }
    let mut messages = anthropic::convert_anthropic_messages(request);
    if let (Some(cache_control), Some(last)) = (cache_control.as_ref(), messages.last_mut()) {
        if last.get("role").and_then(serde_json::Value::as_str) == Some("user") {
            match last.get_mut("content") {
                Some(content @ serde_json::Value::String(_)) => {
                    let text = content.as_str().unwrap_or_default().to_string();
                    *content = serde_json::json!([{
                        "type": "text",
                        "text": text,
                        "cache_control": cache_control,
                    }]);
                }
                Some(serde_json::Value::Array(blocks)) => {
                    if let Some(block) = blocks.last_mut() {
                        if matches!(
                            block.get("type").and_then(serde_json::Value::as_str),
                            Some("text" | "image" | "tool_result")
                        ) {
                            block["cache_control"] = cache_control.clone();
                        }
                    }
                }
                _ => {}
            }
        }
    }
    body.insert("messages".into(), serde_json::Value::Array(messages));
    let mut tools = anthropic::convert_anthropic_tools(request);
    if let (Some(cache_control), Some(last_tool)) = (cache_control.as_ref(), tools.last_mut()) {
        last_tool["cache_control"] = cache_control.clone();
    }
    if !tools.is_empty() {
        body.insert("tools".into(), serde_json::Value::Array(tools));
    }
    if let Some(level) = request.thinking_level {
        if request.force_adaptive_thinking {
            let mapped = request
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get(level.as_str()))
                .and_then(|value| value.as_deref());
            let effort = mapped.unwrap_or(match level {
                ThinkingLevel::Minimal | ThinkingLevel::Low => "low",
                ThinkingLevel::Medium => "medium",
                ThinkingLevel::High => "high",
                ThinkingLevel::Xhigh | ThinkingLevel::Max => "high",
            });
            body.insert(
                "thinking".into(),
                serde_json::json!({ "type": "adaptive", "display": "summarized" }),
            );
            body.insert(
                "output_config".into(),
                serde_json::json!({ "effort": effort }),
            );
        } else {
            let clamped_level = level.clamped_for_budget();
            let default_budget = match clamped_level {
                ThinkingLevel::Minimal => 1024,
                ThinkingLevel::Low => 2048,
                ThinkingLevel::Medium => 8192,
                ThinkingLevel::High => 16384,
                ThinkingLevel::Xhigh | ThinkingLevel::Max => unreachable!("level was clamped"),
            };
            let budget = options
                .thinking_budgets
                .as_ref()
                .and_then(|budgets| budgets.get(clamped_level.as_str()))
                .copied()
                .unwrap_or(default_budget);
            if request.max_tokens.is_some() {
                max_tokens = max_tokens.saturating_add(budget).min(model_max_tokens);
            } else {
                max_tokens = model_max_tokens;
            }
            max_tokens = estimate::clamp_max_tokens_to_context(
                request.context_window,
                &request.messages,
                max_tokens,
            );
            // Pi's Anthropic request builder falls back to 1,024 when the
            // answer reserve consumes the whole explicit cap. Preserve that
            // wire behavior instead of emitting Anthropic's invalid zero
            // thinking budget.
            let budget = budget
                .min(max_tokens.saturating_sub(MIN_ANSWER_TOKENS))
                .max(1024);
            body.insert(
                "thinking".into(),
                serde_json::json!({
                    "type": "enabled",
                    "budget_tokens": budget,
                    "display": "summarized"
                }),
            );
        }
    } else if request.reasoning
        && !matches!(
            request
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get("off")),
            Some(None)
        )
    {
        body.insert("thinking".into(), serde_json::json!({ "type": "disabled" }));
    }
    max_tokens = estimate::clamp_max_tokens_to_context(
        request.context_window,
        &request.messages,
        max_tokens,
    );
    body.insert("max_tokens".into(), serde_json::json!(max_tokens));
    // Anthropic rejects temperature when extended thinking is enabled.
    if request.thinking_level.is_none() {
        if let Some(temperature) = options.temperature.or(request.temperature) {
            body.insert("temperature".into(), serde_json::json!(temperature));
        }
    }
    serde_json::Value::Object(body)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===========================================================================
// Tests (fixture SSE, no network)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{
        AssistantMessage, ContentBlock, StopReason, TextContent, ThinkingContent, ToolCall,
        ToolResultMessage, Usage, UsageCost, UserContent, UserMessage,
    };
    use anthropic::parse_anthropic_sse;

    fn anthropic_thinking_request(level: Option<ThinkingLevel>) -> StreamRequest {
        StreamRequest {
            provider_id: "anthropic".into(),
            api: ApiFamily::AnthropicMessages,
            model: "claude-sonnet-4-5".into(),
            reasoning: true,
            max_tokens_limit: 32_768,
            max_tokens: Some(8_192),
            thinking_level: level,
            ..Default::default()
        }
    }

    #[test]
    fn anthropic_adaptive_thinking_maps_effort_and_omits_temperature() {
        let mut request = anthropic_thinking_request(Some(ThinkingLevel::Xhigh));
        request.force_adaptive_thinking = true;
        request.thinking_level_map = Some(HashMap::from([
            ("off".into(), None),
            ("xhigh".into(), Some("xhigh".into())),
        ]));
        let body = anthropic_request_body(
            &request,
            &StreamOptions {
                temperature: Some(0.4),
                ..Default::default()
            },
        );

        assert_eq!(
            body["thinking"],
            serde_json::json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(
            body["output_config"],
            serde_json::json!({ "effort": "xhigh" })
        );
        assert_eq!(body["max_tokens"], 8_192);
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn anthropic_legacy_thinking_reserves_answer_tokens_and_clamps_large_effort() {
        let request = anthropic_thinking_request(Some(ThinkingLevel::Max));
        let body = anthropic_request_body(&request, &StreamOptions::default());

        assert_eq!(
            body["thinking"],
            serde_json::json!({
                "type": "enabled",
                "budget_tokens": 16_384,
                "display": "summarized"
            })
        );
        assert_eq!(body["max_tokens"], 24_576);
    }

    #[test]
    fn anthropic_legacy_thinking_uses_configured_budget_and_never_emits_zero() {
        let mut request = anthropic_thinking_request(Some(ThinkingLevel::Medium));
        let options = StreamOptions {
            thinking_budgets: Some(HashMap::from([("medium".into(), 4_096)])),
            ..Default::default()
        };
        let body = anthropic_request_body(&request, &options);
        assert_eq!(body["thinking"]["budget_tokens"], 4_096);
        assert_eq!(body["max_tokens"], 12_288);

        request.max_tokens = Some(512);
        request.max_tokens_limit = 512;
        let tiny = anthropic_request_body(&request, &options);
        assert_eq!(tiny["thinking"]["budget_tokens"], 1_024);
        assert_eq!(tiny["max_tokens"], 512);
    }

    #[test]
    fn anthropic_off_emits_disabled_only_when_the_model_can_disable() {
        let mut request = anthropic_thinking_request(None);
        request.thinking_level_map = Some(HashMap::from([("off".into(), Some("off".into()))]));
        let body = anthropic_request_body(&request, &StreamOptions::default());
        assert_eq!(body["thinking"], serde_json::json!({ "type": "disabled" }));

        request.thinking_level_map = Some(HashMap::from([("off".into(), None)]));
        let hidden = anthropic_request_body(&request, &StreamOptions::default());
        assert!(hidden.get("thinking").is_none());
    }

    #[test]
    fn keyless_compatibility_token_never_crosses_provider_headers() {
        let options = StreamOptions {
            api_key: Some(catalog::PI_AUTH_COMPATIBILITY_TOKEN.into()),
            ..Default::default()
        };
        let anthropic = anthropic::AnthropicProvider::new()
            .build_request(&anthropic_thinking_request(None), &options)
            .unwrap()
            .build()
            .unwrap();
        assert!(anthropic.headers().get("x-api-key").is_none());
        assert!(!format!("{anthropic:?}").contains(catalog::PI_AUTH_COMPATIBILITY_TOKEN));

        let openai_request = StreamRequest {
            provider_id: "custom:local".into(),
            api: ApiFamily::OpenAICompletions,
            model: "local-model".into(),
            ..Default::default()
        };
        let (builder, _) = openai_completions::OpenAICompletionsProvider::with_base_url(
            "http://127.0.0.1:1234/v1",
        )
        .build_request(&openai_request, &options)
        .unwrap();
        let openai = builder.build().unwrap();
        assert!(openai.headers().get("authorization").is_none());
        assert!(!format!("{openai:?}").contains(catalog::PI_AUTH_COMPATIBILITY_TOKEN));
    }

    #[test]
    fn anthropic_body_converts_internal_messages_tools_and_results_to_wire_shape() {
        let mut request = anthropic_thinking_request(Some(ThinkingLevel::High));
        request.messages = vec![
            Message::User(UserMessage {
                content: UserContent::Text("inspect the workspace".into()),
                timestamp: 41,
            }),
            Message::Assistant(AssistantMessage {
                content: vec![
                    ContentBlock::Thinking(ThinkingContent {
                        thinking: "I should read it".into(),
                        thinking_signature: Some("sig-1".into()),
                        redacted: None,
                    }),
                    ContentBlock::ToolCall(ToolCall {
                        id: "toolu_1".into(),
                        name: "read_file".into(),
                        arguments: serde_json::json!({ "path": "README.md" }),
                        thought_signature: None,
                    }),
                ],
                api: "anthropic-messages".into(),
                provider: "anthropic".into(),
                model: request.model.clone(),
                response_model: None,
                response_id: Some("msg_1".into()),
                usage: usage_fixture(),
                stop_reason: StopReason::ToolUse,
                error_message: None,
                timestamp: 42,
            }),
            Message::ToolResult(ToolResultMessage {
                tool_call_id: "toolu_1".into(),
                tool_name: "read_file".into(),
                content: vec![ContentBlock::Text(TextContent {
                    text: "contents".into(),
                    text_signature: None,
                })],
                details: None,
                added_tool_names: None,
                is_error: false,
                timestamp: 43,
            }),
            Message::ToolResult(ToolResultMessage {
                tool_call_id: "toolu_2".into(),
                tool_name: "grep".into(),
                content: vec![ContentBlock::Text(TextContent {
                    text: "no matches".into(),
                    text_signature: None,
                })],
                details: None,
                added_tool_names: None,
                is_error: true,
                timestamp: 44,
            }),
        ];
        request.tools = vec![ToolDef {
            name: "read_file".into(),
            description: "Read a file".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
                "additionalProperties": false
            }),
        }];

        let body = anthropic_request_body(&request, &StreamOptions::default());
        assert_eq!(
            body["messages"],
            serde_json::json!([
                { "role": "user", "content": "inspect the workspace" },
                {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "I should read it", "signature": "sig-1" },
                        { "type": "tool_use", "id": "toolu_1", "name": "read_file", "input": { "path": "README.md" } }
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        { "type": "tool_result", "tool_use_id": "toolu_1", "content": "contents", "is_error": false },
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_2",
                            "content": "no matches",
                            "is_error": true,
                            "cache_control": { "type": "ephemeral" }
                        }
                    ]
                }
            ])
        );
        assert_eq!(
            body["tools"],
            serde_json::json!([{
                "name": "read_file",
                "description": "Read a file",
                "eager_input_streaming": true,
                "input_schema": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                },
                "cache_control": { "type": "ephemeral" }
            }])
        );
        assert!(!body["messages"].to_string().contains("timestamp"));
        assert!(!body["messages"].to_string().contains("toolCall"));
        assert!(!body["messages"].to_string().contains("toolResult"));
    }

    #[test]
    fn anthropic_cache_retention_marks_system_last_tool_and_last_user_boundary() {
        let mut request = anthropic_thinking_request(None);
        request.system_prompt = Some("Pinned system".into());
        request.messages = vec![Message::User(UserMessage {
            content: UserContent::Text("hello".into()),
            timestamp: 1,
        })];
        request.tools = vec![ToolDef {
            name: "read_file".into(),
            description: "Read".into(),
            parameters: serde_json::json!({ "type": "object" }),
        }];

        let long = anthropic_request_body(
            &request,
            &StreamOptions {
                cache_retention: Some(CacheRetention::Long),
                ..Default::default()
            },
        );
        let expected = serde_json::json!({ "type": "ephemeral", "ttl": "1h" });
        assert_eq!(long["system"][0]["cache_control"], expected);
        assert_eq!(long["tools"][0]["cache_control"], expected);
        assert_eq!(long["messages"][0]["content"][0]["cache_control"], expected);

        let none = anthropic_request_body(
            &request,
            &StreamOptions {
                cache_retention: Some(CacheRetention::None),
                ..Default::default()
            },
        );
        assert!(none["system"][0].get("cache_control").is_none());
        assert!(none["tools"][0].get("cache_control").is_none());
        assert!(none["messages"][0]["content"].is_string());
    }

    #[test]
    fn anthropic_output_cap_is_clamped_to_the_remaining_context() {
        let mut request = anthropic_thinking_request(None);
        request.context_window = 10_000;
        request.max_tokens = None;
        request.max_tokens_limit = 8_192;
        request.messages = vec![Message::User(UserMessage {
            content: UserContent::Text("x".repeat(20_000)),
            timestamp: 1,
        })];
        let body = anthropic_request_body(&request, &StreamOptions::default());
        assert_eq!(body["max_tokens"], 904);
    }

    /// A captured (abridged) Anthropic Messages SSE byte stream. Deliberately
    /// uses CRLF in one frame to exercise the line normalization.
    const FIXTURE: &[u8] = br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" from Aiden"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: ping
data: {"type":"ping"}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}
"#;

    #[test]
    fn fixture_parses_into_expected_event_sequence() {
        let events = parse_anthropic_sse(FIXTURE).unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            [
                "start",
                "text_start",
                "text_delta",
                "text_delta",
                "text_end",
                "done",
            ]
        );

        // start carries the initial partial message with id + usage.
        let AssistantMessageEvent::Start { partial } = &events[0] else {
            panic!("expected start event");
        };
        assert_eq!(partial.model, "claude-sonnet-5");
        assert_eq!(partial.usage.input, 12);

        // text deltas accumulate into the partial content.
        let AssistantMessageEvent::TextDelta {
            content_index,
            delta,
            partial,
        } = &events[2]
        else {
            panic!("expected text_delta");
        };
        assert_eq!(*content_index, 0);
        assert_eq!(delta, "Hello");
        assert_eq!(
            partial_text(partial),
            Some("Hello"),
            "partial should carry accumulated text"
        );

        // text_end reports the finished block content.
        let AssistantMessageEvent::TextEnd { content, .. } = &events[4] else {
            panic!("expected text_end");
        };
        assert_eq!(content, "Hello from Aiden");

        // done carries the final message and the mapped stop reason.
        let AssistantMessageEvent::Done { reason, message } = &events[5] else {
            panic!("expected done");
        };
        assert_eq!(*reason, StopReason::Stop);
        assert_eq!(message.stop_reason, StopReason::Stop);
    }

    #[test]
    fn tool_use_frames_map_to_toolcall_events() {
        let fixture = br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"grep","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"pattern\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"foo\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}
"#;
        let events = parse_anthropic_sse(fixture).unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            [
                "toolcall_start",
                "toolcall_delta",
                "toolcall_delta",
                "toolcall_end"
            ]
        );

        let AssistantMessageEvent::ToolcallStart { content_index, .. } = &events[0] else {
            panic!();
        };
        assert_eq!(*content_index, 0);

        // The end event carries the reassembled JSON-fragment tool call.
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[3] else {
            panic!();
        };
        assert_eq!(tool_call.name, "grep");
        assert_eq!(tool_call.arguments, serde_json::json!({"pattern": "foo"}));
    }

    #[test]
    fn signed_thinking_usage_and_length_survive_anthropic_streaming() {
        let mut accumulator =
            AnthropicAccumulator::with_identity("custom:anthropic-gateway", "claude-sonnet-4-5");
        accumulator
            .step(
                "message_start",
                r#"{"message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"cache_creation":{"ephemeral_1h_input_tokens":2}}}}"#,
            )
            .unwrap();
        accumulator
            .step(
                "content_block_start",
                r#"{"index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            )
            .unwrap();
        accumulator
            .step(
                "content_block_delta",
                r#"{"index":0,"delta":{"type":"thinking_delta","thinking":"private"}}"#,
            )
            .unwrap();
        assert!(accumulator
            .step(
                "content_block_delta",
                r#"{"index":0,"delta":{"type":"signature_delta","signature":"signed-value"}}"#,
            )
            .unwrap()
            .is_none());
        accumulator
            .step("content_block_stop", r#"{"index":0}"#)
            .unwrap();
        accumulator
            .step(
                "message_delta",
                r#"{"delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9,"output_tokens_details":{"thinking_tokens":6}}}"#,
            )
            .unwrap();
        let event = accumulator
            .step("message_stop", r#"{"type":"message_stop"}"#)
            .unwrap()
            .unwrap();
        let AssistantMessageEvent::Done { reason, message } = event else {
            panic!("expected done");
        };
        assert_eq!(reason, StopReason::Length);
        assert_eq!(message.provider, "custom:anthropic-gateway");
        assert_eq!(message.model, "claude-sonnet-4-5");
        assert_eq!(
            message.response_model.as_deref(),
            Some("claude-sonnet-4-5-20250929")
        );
        let ContentBlock::Thinking(thinking) = &message.content[0] else {
            panic!("expected thinking");
        };
        assert_eq!(thinking.thinking, "private");
        assert_eq!(thinking.thinking_signature.as_deref(), Some("signed-value"));
        assert_eq!(message.usage.input, 12);
        assert_eq!(message.usage.output, 9);
        assert_eq!(message.usage.cache_read, 3);
        assert_eq!(message.usage.cache_write, 4);
        assert_eq!(message.usage.cache_write_1h, Some(2));
        assert_eq!(message.usage.reasoning, Some(6));
        assert_eq!(message.usage.total_tokens, 28);
    }

    #[test]
    fn anthropic_refusal_is_a_terminal_error_with_provider_explanation() {
        let mut accumulator = AnthropicAccumulator::new();
        accumulator
            .step(
                "message_start",
                r#"{"message":{"id":"msg_refused","model":"claude-sonnet-5","usage":{}}}"#,
            )
            .unwrap();
        accumulator
            .step(
                "message_delta",
                r#"{"delta":{"stop_reason":"refusal","stop_details":{"explanation":"Request cannot be completed"}},"usage":{"output_tokens":1}}"#,
            )
            .unwrap();
        let event = accumulator
            .step("message_stop", r#"{"type":"message_stop"}"#)
            .unwrap()
            .unwrap();
        let AssistantMessageEvent::Error { error, .. } = event else {
            panic!("expected refusal error");
        };
        assert_eq!(error.stop_reason, StopReason::Error);
        assert_eq!(
            error.error_message.as_deref(),
            Some("Request cannot be completed")
        );
    }

    #[test]
    fn redacted_thinking_is_preserved_as_opaque_signed_content() {
        let fixture = br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","content":[],"usage":{}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque-secret"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
"#;
        let events = parse_anthropic_sse(fixture).unwrap();
        let AssistantMessageEvent::Done { message, .. } = events.last().unwrap() else {
            panic!("expected done");
        };
        let ContentBlock::Thinking(thinking) = &message.content[0] else {
            panic!("expected redacted thinking");
        };
        assert_eq!(thinking.redacted, Some(true));
        assert_eq!(
            thinking.thinking_signature.as_deref(),
            Some("opaque-secret")
        );
        assert!(thinking.thinking.is_empty());
    }

    #[test]
    fn malformed_sse_reports_error_not_panic() {
        let fixture = br#"event: message_start
data: {not valid json
"#;
        // Malformed frame JSON surfaces as an Err (Json or Protocol depending
        // on where it fails); the stream contract is "never panic, never
        // emit a partial event for a malformed frame".
        let result = parse_anthropic_sse(fixture);
        assert!(result.is_err());
    }

    #[test]
    fn error_frame_maps_to_terminal_error_event() {
        let fixture = br#"event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}
"#;
        let events = parse_anthropic_sse(fixture).unwrap();
        let AssistantMessageEvent::Error { reason, .. } = &events[0] else {
            panic!("expected error event");
        };
        assert_eq!(*reason, StopReason::Error);
    }

    #[test]
    fn stream_ending_without_message_stop_is_a_terminal_error() {
        // A connection dropped after content was delivered but before
        // `message_stop` must not silently truncate the response.
        let fixture = br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":12,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answer"}}
"#;
        let events = parse_anthropic_sse(fixture).unwrap();
        let AssistantMessageEvent::Error { reason, error } = events.last().unwrap() else {
            panic!("expected terminal error event, got {events:?}");
        };
        assert_eq!(*reason, StopReason::Error);
        // The partial message survives so consumers can preserve delivered text.
        let ContentBlock::Text(block) = &error.content[0] else {
            panic!("expected text block");
        };
        assert_eq!(block.text, "partial answer");
        assert!(error
            .error_message
            .as_deref()
            .unwrap()
            .contains("message_stop"));
    }

    #[test]
    fn complete_and_error_only_streams_emit_no_spurious_terminal() {
        // A complete stream ends on `done` with no extra event.
        let events = parse_anthropic_sse(FIXTURE).unwrap();
        assert!(matches!(
            events.last(),
            Some(AssistantMessageEvent::Done { .. })
        ));
        // An error-only stream (no message_start) emits exactly one error.
        let fixture = br#"event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}
"#;
        let events = parse_anthropic_sse(fixture).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], AssistantMessageEvent::Error { .. }));
    }

    fn kind(event: &AssistantMessageEvent) -> &'static str {
        match event {
            AssistantMessageEvent::Start { .. } => "start",
            AssistantMessageEvent::TextStart { .. } => "text_start",
            AssistantMessageEvent::TextDelta { .. } => "text_delta",
            AssistantMessageEvent::TextEnd { .. } => "text_end",
            AssistantMessageEvent::ThinkingStart { .. } => "thinking_start",
            AssistantMessageEvent::ThinkingDelta { .. } => "thinking_delta",
            AssistantMessageEvent::ThinkingEnd { .. } => "thinking_end",
            AssistantMessageEvent::ToolcallStart { .. } => "toolcall_start",
            AssistantMessageEvent::ToolcallDelta { .. } => "toolcall_delta",
            AssistantMessageEvent::ToolcallEnd { .. } => "toolcall_end",
            AssistantMessageEvent::Done { .. } => "done",
            AssistantMessageEvent::Error { .. } => "error",
        }
    }

    fn partial_text(message: &AssistantMessage) -> Option<&str> {
        match message.content.last()? {
            ContentBlock::Text(TextContent { text, .. }) => Some(text.as_str()),
            _ => None,
        }
    }

    #[allow(dead_code)]
    fn usage_fixture() -> Usage {
        Usage {
            input: 1,
            output: 1,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: None,
            reasoning: None,
            total_tokens: 2,
            cost: UsageCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total: 0.0,
            },
        }
    }

    #[allow(dead_code)]
    fn tool_call_fixture() -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: "grep".into(),
            arguments: serde_json::json!({}),
            thought_signature: None,
        }
    }
}
