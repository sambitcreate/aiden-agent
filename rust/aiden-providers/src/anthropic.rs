//! Anthropic Messages API transport: SSE frame parsing + streaming provider.
//!
//! The pure part (`parse_anthropic_sse`, [`AnthropicAccumulator`]) is shared
//! between the fixture tests and the live `reqwest-eventsource` stream, so
//! protocol mapping is exercised without any network. Frame splitting comes
//! from the crate-shared [`crate::sse`] module.

use aiden_core::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, StopReason, TextContent,
    ThinkingContent, ToolCall, Usage,
};
use futures::StreamExt;

use crate::sse::sse_frames;
use crate::{now_ms, EventStream, Provider, ProviderError, StreamOptions, StreamRequest};

/// Anthropic Messages API version header.
pub const ANTHROPIC_API_VERSION: &str = "2023-06-01";
/// Default base URL for the Messages API.
pub const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";

// ===========================================================================
// Stateful frame accumulator
// ===========================================================================

#[derive(Default)]
struct BlockState {
    kind: BlockKind,
    /// For text/thinking blocks: accumulated text. For tool calls: accumulated
    /// raw JSON fragments.
    buffer: String,
    /// Tool-call identity, present once the start frame arrives.
    tool_call: Option<ToolCall>,
}

#[derive(Clone, Copy, PartialEq, Default)]
enum BlockKind {
    #[default]
    Text,
    Thinking,
    ToolUse,
}

/// Accumulates the partial [`AssistantMessage`] across one stream and maps each
/// Anthropic SSE frame to a normalized [`AssistantMessageEvent`] (or nothing,
/// for frames with no pi-ai equivalent like `ping`/`message_delta`).
pub struct AnthropicAccumulator {
    message: AssistantMessage,
    started: bool,
    blocks: Vec<BlockState>,
    stop_reason: StopReason,
    /// A transport-level failure to surface as a terminal error event.
    error: Option<String>,
}

impl Default for AnthropicAccumulator {
    fn default() -> Self {
        Self {
            message: AssistantMessage {
                content: Vec::new(),
                api: "anthropic-messages".to_string(),
                provider: "anthropic".to_string(),
                model: String::new(),
                response_model: None,
                response_id: None,
                usage: Usage {
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
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: 0,
            },
            started: false,
            blocks: Vec::new(),
            stop_reason: StopReason::Stop,
            error: None,
        }
    }
}

impl AnthropicAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Process one SSE frame; returns the event to emit (if any).
    pub fn step(
        &mut self,
        event: &str,
        data: &str,
    ) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        match event {
            "message_start" => self.message_start(data),
            "content_block_start" => self.content_block_start(data),
            "content_block_delta" => self.content_block_delta(data),
            "content_block_stop" => self.content_block_stop(data),
            "message_delta" => self.message_delta(data),
            "message_stop" => self.message_stop(),
            "error" => self.error_frame(data),
            "ping" | "" => Ok(None),
            other => {
                tracing::debug!(event = other, "ignoring unknown SSE event");
                Ok(None)
            }
        }
    }

    fn partial(&self) -> AssistantMessage {
        self.message.clone()
    }

    fn message_start(
        &mut self,
        data: &str,
    ) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        let value: serde_json::Value = serde_json::from_str(data)?;
        let message: AnthropicMessageStart =
            serde_json::from_value(value.get("message").cloned().unwrap_or_default())?;
        self.message = AssistantMessage {
            content: Vec::new(),
            api: "anthropic-messages".to_string(),
            provider: "anthropic".to_string(),
            model: message.model.unwrap_or_default(),
            response_model: None,
            response_id: message.id,
            usage: usage_from_anthropic(message.usage),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: now_ms(),
        };
        self.started = true;
        Ok(Some(AssistantMessageEvent::Start {
            partial: self.partial(),
        }))
    }

    fn content_block_start(
        &mut self,
        data: &str,
    ) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        let frame: ContentBlockStart = serde_json::from_str(data)?;
        let index = frame.index;
        let mut state = BlockState {
            kind: BlockKind::Text,
            buffer: String::new(),
            tool_call: None,
        };
        let (event, block) = match frame.content_block.r#type.as_str() {
            "text" => {
                let text = frame.content_block.text.unwrap_or_default();
                state.buffer = text.clone();
                (
                    AssistantMessageEvent::TextStart {
                        content_index: index,
                        partial: self.partial(),
                    },
                    ContentBlock::Text(TextContent {
                        text,
                        text_signature: None,
                    }),
                )
            }
            "thinking" => {
                let thinking = frame.content_block.thinking.unwrap_or_default();
                state.buffer = thinking.clone();
                state.kind = BlockKind::Thinking;
                (
                    AssistantMessageEvent::ThinkingStart {
                        content_index: index,
                        partial: self.partial(),
                    },
                    ContentBlock::Thinking(ThinkingContent {
                        thinking,
                        thinking_signature: None,
                        redacted: None,
                    }),
                )
            }
            "tool_use" => {
                state.kind = BlockKind::ToolUse;
                state.tool_call = Some(ToolCall {
                    id: frame.content_block.id.unwrap_or_default(),
                    name: frame.content_block.name.unwrap_or_default(),
                    arguments: serde_json::Value::Object(Default::default()),
                    thought_signature: None,
                });
                let tool_call = state.tool_call.clone().unwrap_or_else(|| ToolCall {
                    id: String::new(),
                    name: String::new(),
                    arguments: serde_json::Value::Object(Default::default()),
                    thought_signature: None,
                });
                (
                    AssistantMessageEvent::ToolcallStart {
                        content_index: index,
                        partial: self.partial(),
                    },
                    ContentBlock::ToolCall(tool_call),
                )
            }
            other => {
                return Err(ProviderError::Protocol(format!(
                    "unknown content block type `{other}`"
                )))
            }
        };
        if index >= self.blocks.len() {
            self.blocks.resize_with(index + 1, || BlockState {
                kind: BlockKind::Text,
                buffer: String::new(),
                tool_call: None,
            });
        }
        self.blocks[index] = state;
        self.message.content.push(block);
        Ok(Some(event))
    }

    fn content_block_delta(
        &mut self,
        data: &str,
    ) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        let frame: ContentBlockDelta = serde_json::from_str(data)?;
        let index = frame.index;
        if index >= self.blocks.len() {
            return Err(ProviderError::Protocol(format!(
                "delta for unknown block index {index}"
            )));
        }
        let delta_type = frame.delta.r#type.clone();
        let text_delta = frame.delta.text.clone();
        let thinking_delta = frame.delta.thinking.clone();
        let partial_json = frame.delta.partial_json.clone();

        // Apply the delta to the accumulator state FIRST so the event's
        // `partial` reflects the post-delta message.
        let block = match delta_type.as_str() {
            "text_delta" => {
                let delta = text_delta.clone().unwrap_or_default();
                self.blocks[index].buffer.push_str(&delta);
                ContentBlock::Text(TextContent {
                    text: self.blocks[index].buffer.clone(),
                    text_signature: None,
                })
            }
            "thinking_delta" => {
                let delta = thinking_delta.clone().unwrap_or_default();
                self.blocks[index].buffer.push_str(&delta);
                ContentBlock::Thinking(ThinkingContent {
                    thinking: self.blocks[index].buffer.clone(),
                    thinking_signature: None,
                    redacted: None,
                })
            }
            "input_json_delta" => {
                let delta = partial_json.clone().unwrap_or_default();
                self.blocks[index].buffer.push_str(&delta);
                ContentBlock::ToolCall(ToolCall {
                    id: self.blocks[index]
                        .tool_call
                        .as_ref()
                        .map(|call| call.id.clone())
                        .unwrap_or_default(),
                    name: self.blocks[index]
                        .tool_call
                        .as_ref()
                        .map(|call| call.name.clone())
                        .unwrap_or_default(),
                    arguments: serde_json::Value::String(self.blocks[index].buffer.clone()),
                    thought_signature: None,
                })
            }
            other => {
                return Err(ProviderError::Protocol(format!(
                    "unknown delta type `{other}`"
                )))
            }
        };
        if let Some(target) = self.message.content.get_mut(index) {
            *target = block;
        }
        let event = match delta_type.as_str() {
            "text_delta" => AssistantMessageEvent::TextDelta {
                content_index: index,
                delta: text_delta.unwrap_or_default(),
                partial: self.partial(),
            },
            "thinking_delta" => AssistantMessageEvent::ThinkingDelta {
                content_index: index,
                delta: thinking_delta.unwrap_or_default(),
                partial: self.partial(),
            },
            _ => AssistantMessageEvent::ToolcallDelta {
                content_index: index,
                delta: partial_json.unwrap_or_default(),
                partial: self.partial(),
            },
        };
        Ok(Some(event))
    }

    fn content_block_stop(
        &mut self,
        data: &str,
    ) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        let frame: ContentBlockStop = serde_json::from_str(data)?;
        let index = frame.index;
        if index >= self.blocks.len() {
            return Err(ProviderError::Protocol(format!(
                "stop for unknown block index {index}"
            )));
        }
        let state = std::mem::take(&mut self.blocks[index]);
        let event = match state.kind {
            BlockKind::Text => AssistantMessageEvent::TextEnd {
                content_index: index,
                content: state.buffer,
                partial: self.partial(),
            },
            BlockKind::Thinking => AssistantMessageEvent::ThinkingEnd {
                content_index: index,
                content: state.buffer,
                partial: self.partial(),
            },
            BlockKind::ToolUse => {
                let mut tool_call = state.tool_call.clone().unwrap_or(ToolCall {
                    id: String::new(),
                    name: String::new(),
                    arguments: serde_json::Value::Object(Default::default()),
                    thought_signature: None,
                });
                // Reassemble the JSON fragments accumulated by the deltas;
                // tolerate trailing/incomplete fragments.
                let raw = &state.buffer;
                if raw.trim().is_empty() {
                    tool_call.arguments = serde_json::Value::Object(Default::default());
                } else {
                    tool_call.arguments = serde_json::from_str(raw).unwrap_or_else(|_| {
                        // Best-effort: keep the raw fragment so consumers can
                        // still see what arrived.
                        serde_json::Value::String(raw.clone())
                    });
                }
                if let Some(block) = self.message.content.get_mut(index) {
                    *block = ContentBlock::ToolCall(tool_call.clone());
                }
                AssistantMessageEvent::ToolcallEnd {
                    content_index: index,
                    tool_call,
                    partial: self.partial(),
                }
            }
        };
        Ok(Some(event))
    }

    fn message_delta(
        &mut self,
        data: &str,
    ) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        let frame: MessageDelta = serde_json::from_str(data)?;
        self.stop_reason = match frame.delta.stop_reason.as_deref() {
            Some("end_turn") | Some("stop_sequence") | Some("max_tokens") => StopReason::Stop,
            Some("tool_use") => StopReason::ToolUse,
            Some(other) => {
                tracing::debug!(reason = other, "unmapped stop_reason");
                StopReason::Stop
            }
            None => StopReason::Stop,
        };
        // `usage` deltas are folded into the final message by the consumer; the
        // pi protocol has no direct event for message_delta.
        Ok(None)
    }

    fn message_stop(&mut self) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        if !self.started {
            return Err(ProviderError::Protocol(
                "message_stop without message_start".to_string(),
            ));
        }
        self.message.stop_reason = self.stop_reason;
        Ok(Some(AssistantMessageEvent::Done {
            reason: self.stop_reason,
            message: self.message.clone(),
        }))
    }

    fn error_frame(&mut self, data: &str) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        let value: serde_json::Value = serde_json::from_str(data)?;
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("provider stream error")
            .to_string();
        self.error = Some(message.clone());
        self.message.error_message = Some(message);
        self.message.stop_reason = StopReason::Error;
        Ok(Some(AssistantMessageEvent::Error {
            reason: StopReason::Error,
            error: self.message.clone(),
        }))
    }

    /// Recover any terminal transport error recorded by `step`.
    pub fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }
}

// ===========================================================================
// Pure entry point (used by tests)
// ===========================================================================

/// Parse a complete SSE byte stream into normalized events (testable without
/// network).
pub fn parse_anthropic_sse(input: &[u8]) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    let mut accumulator = AnthropicAccumulator::new();
    let mut events = Vec::new();
    for (event, data) in sse_frames(input) {
        if let Some(event) = accumulator.step(&event, &data)? {
            events.push(event);
        }
    }
    Ok(events)
}

// ===========================================================================
// AnthropicProvider (streaming)
// ===========================================================================

/// Stub provider for the Anthropic Messages API. Phase 3 wires the transport
/// shape (SSE via reqwest-eventsource → normalized events); key resolution,
/// retries, and prompt caching arrive with the provider-config phase.
pub struct AnthropicProvider {
    base_url: String,
}

impl Default for AnthropicProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicProvider {
    pub fn new() -> Self {
        Self {
            base_url: ANTHROPIC_MESSAGES_URL.to_string(),
        }
    }

    fn build_request(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        let api_key = options
            .api_key
            .clone()
            .ok_or_else(|| ProviderError::Config("missing api key for anthropic".to_string()))?;
        let body = crate::anthropic_request_body(request, options);
        let mut builder = reqwest::Client::new()
            .post(&self.base_url)
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("content-type", "application/json")
            .json(&body);
        if let Some(timeout_ms) = options.timeout_ms {
            builder = builder.timeout(std::time::Duration::from_millis(timeout_ms));
        }
        for (name, value) in &options.headers {
            builder = match value {
                Some(value) => builder.header(name, value),
                // A null header suppresses a provider default.
                None => builder.header(name, ""),
            };
        }
        Ok(builder)
    }
}

impl Provider for AnthropicProvider {
    fn info(&self) -> crate::ProviderInfo {
        crate::ProviderInfo {
            id: "anthropic".to_string(),
            label: "Anthropic".to_string(),
        }
    }

    fn stream_simple(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<EventStream, ProviderError> {
        let request_builder = self.build_request(request, options)?;
        let source = reqwest_eventsource::EventSource::new(request_builder)
            .map_err(|err| ProviderError::Request(err.to_string()))?;
        let accumulator = AnthropicAccumulator::new();

        let stream = futures::stream::unfold(
            (source, accumulator),
            |(mut source, mut accumulator)| async move {
                loop {
                    match source.next().await {
                        Some(Ok(reqwest_eventsource::Event::Open)) => continue,
                        Some(Ok(reqwest_eventsource::Event::Message(message))) => {
                            if let Some(event) =
                                accumulator.step(&message.event, &message.data).transpose()
                            {
                                return Some((event, (source, accumulator)));
                            }
                            continue;
                        }
                        Some(Err(err)) => {
                            return Some((
                                Err(ProviderError::Stream(err.to_string())),
                                (source, accumulator),
                            ));
                        }
                        None => return None,
                    }
                }
            },
        );

        Ok(Box::pin(stream))
    }
}

// ===========================================================================
// Wire JSON shapes (the subset the accumulator reads)
// ===========================================================================

#[derive(serde::Deserialize, Default)]
struct AnthropicMessageStart {
    id: Option<String>,
    model: Option<String>,
    usage: Option<AnthropicUsage>,
}

#[derive(serde::Deserialize, Default)]
struct AnthropicUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

fn usage_from_anthropic(usage: Option<AnthropicUsage>) -> Usage {
    let usage = usage.unwrap_or_default();
    Usage {
        input: usage.input_tokens.unwrap_or(0),
        output: usage.output_tokens.unwrap_or(0),
        cache_read: usage.cache_read_input_tokens.unwrap_or(0),
        cache_write: usage.cache_creation_input_tokens.unwrap_or(0),
        cache_write_1h: None,
        reasoning: None,
        total_tokens: usage
            .input_tokens
            .unwrap_or(0)
            .saturating_add(usage.output_tokens.unwrap_or(0)),
        cost: aiden_core::UsageCost {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: 0.0,
        },
    }
}

#[derive(serde::Deserialize)]
struct ContentBlockStart {
    index: usize,
    content_block: StartBlock,
}

#[derive(serde::Deserialize)]
struct StartBlock {
    r#type: String,
    text: Option<String>,
    thinking: Option<String>,
    id: Option<String>,
    name: Option<String>,
}

#[derive(serde::Deserialize)]
struct ContentBlockDelta {
    index: usize,
    delta: DeltaBlock,
}

#[derive(serde::Deserialize)]
struct DeltaBlock {
    r#type: String,
    text: Option<String>,
    thinking: Option<String>,
    partial_json: Option<String>,
}

#[derive(serde::Deserialize)]
struct ContentBlockStop {
    index: usize,
}

#[derive(serde::Deserialize)]
struct MessageDelta {
    delta: DeltaReason,
}

#[derive(serde::Deserialize, Default)]
struct DeltaReason {
    stop_reason: Option<String>,
}
