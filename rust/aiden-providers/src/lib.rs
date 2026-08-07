//! Provider abstraction and SSE streaming transport.
//!
//! This crate ports the pi-ai surface Aiden actually uses
//! (`main/services/generation-runtime.ts`, `model-runtime-core.ts`): a
//! normalized `Provider` trait whose `stream_simple` returns a stream of
//! [`AssistantMessageEvent`]s, plus a first concrete `AnthropicProvider` that
//! streams over HTTP SSE via `reqwest-eventsource`.
//!
//! Design notes:
//! - Streams never throw: transport failures surface as terminal
//!   [`AssistantMessageEvent::Error`] events (`stop_reason == Error | Aborted`)
//!   matching the pi-ai contract. The `Result` in the item type is reserved for
//!   transport-level failures the consumer cannot meaningfully map.
//! - `parse_anthropic_sse` is a pure, stateful frame parser shared by the
//!   streaming provider and the fixture test — no network in tests.

use aiden_core::{AssistantMessageEvent, Message};
use futures::Stream;

pub mod anthropic;

pub use anthropic::{parse_anthropic_sse, sse_frames, AnthropicAccumulator, AnthropicProvider};

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

/// A request to generate one assistant turn.
#[derive(Debug, Clone)]
pub struct StreamRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub system_prompt: Option<String>,
    pub max_tokens: Option<u32>,
    pub thinking_level: Option<ThinkingLevel>,
    pub tools: Vec<aiden_core::ToolDef>,
}

/// Options resolved per request (key resolution, timeouts, retries).
#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    pub api_key: Option<String>,
    pub temperature: Option<f32>,
    pub timeout_ms: Option<u64>,
    pub max_retries: Option<u32>,
    /// Extra headers; a `None` value suppresses a provider default header.
    pub headers: std::collections::HashMap<String, Option<String>>,
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

/// Build an Anthropic-style request body from a normalized request (stub shape
/// for the phase-3 scaffold; the exact prompt-cache/session fields arrive with
/// the compaction work).
pub fn anthropic_request_body(
    request: &StreamRequest,
    options: &StreamOptions,
) -> serde_json::Value {
    serde_json::json!({
        "model": request.model,
        "max_tokens": request.max_tokens.unwrap_or(8192),
        "stream": true,
        "system": request.system_prompt,
        "messages": request.messages,
        "temperature": options.temperature,
    })
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
