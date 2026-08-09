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
pub mod compact;
pub mod estimate;
pub mod gemini_cache;
pub mod google;
pub mod json;
pub mod list;
pub mod live_discovery;
pub mod model_capabilities;
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

/// Build an Anthropic-style request body from a normalized request (stub shape
/// for the phase-3 scaffold; the exact prompt-cache/session fields arrive with
/// the compaction work). Nullable optional fields (`system`, `temperature`)
/// are omitted rather than emitted as JSON `null`, which the Messages API
/// rejects with a validation error.
pub fn anthropic_request_body(
    request: &StreamRequest,
    options: &StreamOptions,
) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    body.insert("model".into(), serde_json::json!(request.model));
    body.insert(
        "max_tokens".into(),
        serde_json::json!(request.max_tokens.unwrap_or(8192)),
    );
    body.insert("stream".into(), serde_json::Value::Bool(true));
    if let Some(system) = &request.system_prompt {
        body.insert("system".into(), serde_json::json!(system));
    }
    body.insert("messages".into(), serde_json::json!(request.messages));
    if let Some(temperature) = options.temperature {
        body.insert("temperature".into(), serde_json::json!(temperature));
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
        AssistantMessage, ContentBlock, StopReason, TextContent, ToolCall, Usage, UsageCost,
    };
    use anthropic::parse_anthropic_sse;

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
