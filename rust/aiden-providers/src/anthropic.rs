//! Anthropic Messages API transport: SSE frame parsing + streaming provider.
//!
//! The pure part (`parse_anthropic_sse`, [`AnthropicAccumulator`]) is shared
//! between the fixture tests and the live `reqwest-eventsource` stream, so
//! protocol mapping is exercised without any network. Frame splitting comes
//! from the crate-shared [`crate::sse`] module.

use aiden_core::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, Message, StopReason, TextContent,
    ThinkingContent, ToolCall, Usage, UserContent,
};
use futures::StreamExt;

use crate::sse::sse_frames;
use crate::transform::transform_messages;
use crate::{now_ms, EventStream, Provider, ProviderError, StreamOptions, StreamRequest};

/// Anthropic Messages API version header.
pub const ANTHROPIC_API_VERSION: &str = "2023-06-01";
/// Default base URL for the Messages API.
pub const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";

/// Convert Aiden's normalized transcript into Anthropic Messages wire values.
/// Provider-owned metadata and timestamps never cross this boundary.
pub(crate) fn convert_anthropic_messages(request: &StreamRequest) -> Vec<serde_json::Value> {
    let normalized = transform_messages(
        request.messages.clone(),
        &request.provider_id,
        request.api.as_str(),
        &request.model,
        request.vision,
        &|id, _, _| normalize_tool_call_id(id),
        now_ms(),
    );
    let mut messages = Vec::new();
    let mut index = 0;
    while index < normalized.len() {
        match &normalized[index] {
            Message::User(user) => {
                if let Some(content) = user_content_value(&user.content) {
                    messages.push(serde_json::json!({ "role": "user", "content": content }));
                }
                index += 1;
            }
            Message::Assistant(assistant) => {
                let blocks: Vec<_> = assistant
                    .content
                    .iter()
                    .filter_map(assistant_block_value)
                    .collect();
                if !blocks.is_empty() {
                    messages.push(serde_json::json!({ "role": "assistant", "content": blocks }));
                }
                index += 1;
            }
            Message::ToolResult(_) => {
                let mut blocks = Vec::new();
                while index < normalized.len() {
                    let Message::ToolResult(result) = &normalized[index] else {
                        break;
                    };
                    blocks.push(serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": result.tool_call_id,
                        "content": tool_result_content_value(&result.content),
                        "is_error": result.is_error,
                    }));
                    index += 1;
                }
                messages.push(serde_json::json!({ "role": "user", "content": blocks }));
            }
        }
    }
    messages
}

pub(crate) fn convert_anthropic_tools(request: &StreamRequest) -> Vec<serde_json::Value> {
    request
        .tools
        .iter()
        .map(|tool| {
            let properties = tool
                .parameters
                .get("properties")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let required = tool
                .parameters
                .get("required")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            serde_json::json!({
                "name": tool.name,
                "description": tool.description,
                "eager_input_streaming": true,
                "input_schema": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                }
            })
        })
        .collect()
}

fn normalize_tool_call_id(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

fn user_content_value(content: &UserContent) -> Option<serde_json::Value> {
    match content {
        UserContent::Text(text) => (!text.trim().is_empty()).then(|| serde_json::json!(text)),
        UserContent::Blocks(blocks) => {
            let blocks: Vec<_> = blocks
                .iter()
                .filter_map(|block| match block {
                    aiden_core::UserBlock::Text(text) if !text.text.trim().is_empty() => {
                        Some(serde_json::json!({ "type": "text", "text": text.text }))
                    }
                    aiden_core::UserBlock::Text(_) => None,
                    aiden_core::UserBlock::Image(image) => Some(serde_json::json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.mime_type,
                            "data": image.data,
                        }
                    })),
                })
                .collect();
            (!blocks.is_empty()).then_some(serde_json::Value::Array(blocks))
        }
    }
}

fn assistant_block_value(block: &ContentBlock) -> Option<serde_json::Value> {
    match block {
        ContentBlock::Text(text) => (!text.text.trim().is_empty())
            .then(|| serde_json::json!({ "type": "text", "text": text.text })),
        ContentBlock::Thinking(thinking) if thinking.redacted == Some(true) => thinking
            .thinking_signature
            .as_ref()
            .filter(|signature| !signature.is_empty())
            .map(|signature| serde_json::json!({ "type": "redacted_thinking", "data": signature })),
        ContentBlock::Thinking(thinking) => {
            match thinking
                .thinking_signature
                .as_ref()
                .filter(|signature| !signature.trim().is_empty())
            {
                Some(signature) => Some(serde_json::json!({
                    "type": "thinking",
                    "thinking": thinking.thinking,
                    "signature": signature,
                })),
                None => (!thinking.thinking.trim().is_empty()).then(|| {
                    // Unsigned partial thinking is invalid on replay; Pi
                    // degrades it to ordinary text for compatible continuity.
                    serde_json::json!({ "type": "text", "text": thinking.thinking })
                }),
            }
        }
        ContentBlock::ToolCall(call) => Some(serde_json::json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.name,
            "input": call.arguments,
        })),
        ContentBlock::Image(_) => None,
    }
}

fn tool_result_content_value(content: &[ContentBlock]) -> serde_json::Value {
    let has_images = content
        .iter()
        .any(|block| matches!(block, ContentBlock::Image(_)));
    if !has_images {
        return serde_json::json!(content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text(text) => Some(text.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut blocks = Vec::new();
    let mut has_text = false;
    for block in content {
        match block {
            ContentBlock::Text(text) => {
                has_text = true;
                blocks.push(serde_json::json!({ "type": "text", "text": text.text }));
            }
            ContentBlock::Image(image) => blocks.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.mime_type,
                    "data": image.data,
                }
            })),
            _ => {}
        }
    }
    if !has_text {
        blocks.insert(
            0,
            serde_json::json!({ "type": "text", "text": "(see attached image)" }),
        );
    }
    serde_json::Value::Array(blocks)
}

// ===========================================================================
// Stateful frame accumulator
// ===========================================================================

#[derive(Default)]
struct BlockState {
    kind: BlockKind,
    /// For text/thinking blocks: accumulated text. For tool calls: accumulated
    /// raw JSON fragments.
    buffer: String,
    /// Extended-thinking signature or opaque redacted payload.
    signature: String,
    redacted: bool,
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
    requested_provider: String,
    requested_model: String,
    message: AssistantMessage,
    started: bool,
    blocks: Vec<BlockState>,
    stop_reason: StopReason,
    /// A transport-level failure to surface as a terminal error event.
    error: Option<String>,
    /// Set when `message_stop` is processed; `finish` relies on it to detect
    /// a connection dropped mid-stream (EOF without a terminal event).
    message_stop_seen: bool,
}

impl Default for AnthropicAccumulator {
    fn default() -> Self {
        Self {
            requested_provider: "anthropic".to_string(),
            requested_model: String::new(),
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
            message_stop_seen: false,
        }
    }
}

impl AnthropicAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_identity(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            requested_provider: provider.into(),
            requested_model: model.into(),
            ..Self::default()
        }
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
            provider: self.requested_provider.clone(),
            model: if self.requested_model.is_empty() {
                message.model.clone().unwrap_or_default()
            } else {
                self.requested_model.clone()
            },
            response_model: message.model.filter(|response| {
                !self.requested_model.is_empty() && response != &self.requested_model
            }),
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
            signature: String::new(),
            redacted: false,
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
                state.signature = frame.content_block.signature.unwrap_or_default();
                state.kind = BlockKind::Thinking;
                (
                    AssistantMessageEvent::ThinkingStart {
                        content_index: index,
                        partial: self.partial(),
                    },
                    ContentBlock::Thinking(ThinkingContent {
                        thinking,
                        thinking_signature: (!state.signature.is_empty())
                            .then(|| state.signature.clone()),
                        redacted: None,
                    }),
                )
            }
            "redacted_thinking" => {
                state.kind = BlockKind::Thinking;
                state.redacted = true;
                state.signature = frame.content_block.data.unwrap_or_default();
                (
                    AssistantMessageEvent::ThinkingStart {
                        content_index: index,
                        partial: self.partial(),
                    },
                    ContentBlock::Thinking(ThinkingContent {
                        thinking: String::new(),
                        thinking_signature: (!state.signature.is_empty())
                            .then(|| state.signature.clone()),
                        redacted: Some(true),
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
                signature: String::new(),
                redacted: false,
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

        if delta_type == "signature_delta" {
            self.blocks[index]
                .signature
                .push_str(frame.delta.signature.as_deref().unwrap_or_default());
            let state = &self.blocks[index];
            if let Some(target) = self.message.content.get_mut(index) {
                *target = ContentBlock::Thinking(ThinkingContent {
                    thinking: state.buffer.clone(),
                    thinking_signature: (!state.signature.is_empty())
                        .then(|| state.signature.clone()),
                    redacted: state.redacted.then_some(true),
                });
            }
            return Ok(None);
        }

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
                    thinking_signature: (!self.blocks[index].signature.is_empty())
                        .then(|| self.blocks[index].signature.clone()),
                    redacted: self.blocks[index].redacted.then_some(true),
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
            Some("end_turn") | Some("stop_sequence") | Some("pause_turn") => StopReason::Stop,
            Some("max_tokens") => StopReason::Length,
            Some("tool_use") => StopReason::ToolUse,
            Some("refusal") => {
                self.message.error_message = Some(
                    frame
                        .delta
                        .stop_details
                        .as_ref()
                        .and_then(|details| details.explanation.clone())
                        .unwrap_or_else(|| "The model refused to complete the request".into()),
                );
                StopReason::Error
            }
            Some("sensitive") => {
                self.message.error_message = Some("Provider stopped with: sensitive".into());
                StopReason::Error
            }
            Some(other) => {
                self.message.error_message =
                    Some(format!("Unhandled provider stop reason: {other}"));
                StopReason::Error
            }
            None => StopReason::Stop,
        };
        merge_anthropic_usage(&mut self.message.usage, frame.usage);
        Ok(None)
    }

    fn message_stop(&mut self) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        if !self.started {
            return Err(ProviderError::Protocol(
                "message_stop without message_start".to_string(),
            ));
        }
        self.message_stop_seen = true;
        self.message.stop_reason = self.stop_reason;
        if self.stop_reason == StopReason::Error {
            Ok(Some(AssistantMessageEvent::Error {
                reason: StopReason::Error,
                error: self.message.clone(),
            }))
        } else {
            Ok(Some(AssistantMessageEvent::Done {
                reason: self.stop_reason,
                message: self.message.clone(),
            }))
        }
    }

    /// Finish the stream: when the connection closed before `message_stop`
    /// arrived (a dropped connection or a provider truncation), emit a
    /// terminal `Error` event carrying the partial message so consumers do not
    /// mistake a truncated generation for a complete one. Streams that never
    /// produced a `message_start` emit nothing (they never had content).
    pub fn finish(&mut self) -> Result<Option<AssistantMessageEvent>, ProviderError> {
        if self.message_stop_seen || !self.started {
            return Ok(None);
        }
        self.message.stop_reason = StopReason::Error;
        self.message.error_message =
            Some("Stream ended before message_stop (connection dropped)".to_string());
        Ok(Some(AssistantMessageEvent::Error {
            reason: StopReason::Error,
            error: self.message.clone(),
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
/// network). A stream that ends before `message_stop` (dropped connection)
/// produces a terminal `Error` event carrying the partial message.
pub fn parse_anthropic_sse(input: &[u8]) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    let mut accumulator = AnthropicAccumulator::new();
    let mut events = Vec::new();
    for (event, data) in sse_frames(input) {
        if let Some(event) = accumulator.step(&event, &data)? {
            events.push(event);
        }
    }
    if let Some(event) = accumulator.finish()? {
        events.push(event);
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

    /// Point the transport at a configured (custom / gateway) Messages
    /// endpoint. The value must be the full `/v1/messages` URL — the provider
    /// POSTs to it verbatim.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub(crate) fn build_request(
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
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("content-type", "application/json")
            .json(&body);
        if api_key != crate::catalog::PI_AUTH_COMPATIBILITY_TOKEN {
            builder = builder.header("x-api-key", api_key);
        }
        if let Some(timeout_ms) = options.timeout_ms {
            builder = builder.timeout(std::time::Duration::from_millis(timeout_ms));
        }
        for (name, value) in &options.headers {
            builder = match value {
                Some(value) => builder.header(name, value),
                // A null header suppresses a provider default. Defaults are
                // installed conditionally above, so no empty credential
                // header needs to cross the wire.
                None => builder,
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
        let accumulator =
            AnthropicAccumulator::with_identity(request.provider_id.clone(), request.model.clone());

        let stream = futures::stream::unfold(
            (source, accumulator, false),
            |(mut source, mut accumulator, mut finished)| async move {
                loop {
                    if finished {
                        return None;
                    }
                    match source.next().await {
                        Some(Ok(reqwest_eventsource::Event::Open)) => continue,
                        Some(Ok(reqwest_eventsource::Event::Message(message))) => {
                            if let Some(event) =
                                accumulator.step(&message.event, &message.data).transpose()
                            {
                                return Some((event, (source, accumulator, finished)));
                            }
                            continue;
                        }
                        Some(Err(err)) => {
                            finished = true;
                            return Some((
                                Err(ProviderError::Stream(err.to_string())),
                                (source, accumulator, finished),
                            ));
                        }
                        None => {
                            // Connection closed: flush the terminal event
                            // (an Error when message_stop never arrived).
                            let terminal = accumulator.finish().ok().flatten();
                            if let Some(terminal) = terminal {
                                return Some((Ok(terminal), (source, accumulator, true)));
                            }
                            return None;
                        }
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
    cache_creation: Option<AnthropicCacheCreation>,
    output_tokens_details: Option<AnthropicOutputTokenDetails>,
}

#[derive(serde::Deserialize, Default)]
struct AnthropicCacheCreation {
    ephemeral_1h_input_tokens: Option<u64>,
}

#[derive(serde::Deserialize, Default)]
struct AnthropicOutputTokenDetails {
    thinking_tokens: Option<u64>,
}

fn usage_from_anthropic(usage: Option<AnthropicUsage>) -> Usage {
    let usage = usage.unwrap_or_default();
    let cache_write_1h = usage
        .cache_creation
        .as_ref()
        .and_then(|cache| cache.ephemeral_1h_input_tokens);
    let reasoning = usage
        .output_tokens_details
        .as_ref()
        .and_then(|details| details.thinking_tokens);
    Usage {
        input: usage.input_tokens.unwrap_or(0),
        output: usage.output_tokens.unwrap_or(0),
        cache_read: usage.cache_read_input_tokens.unwrap_or(0),
        cache_write: usage.cache_creation_input_tokens.unwrap_or(0),
        cache_write_1h,
        reasoning,
        total_tokens: usage
            .input_tokens
            .unwrap_or(0)
            .saturating_add(usage.output_tokens.unwrap_or(0))
            .saturating_add(usage.cache_read_input_tokens.unwrap_or(0))
            .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0)),
        cost: aiden_core::UsageCost {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: 0.0,
        },
    }
}

fn merge_anthropic_usage(target: &mut Usage, update: Option<AnthropicUsage>) {
    let Some(update) = update else {
        return;
    };
    let reasoning = update
        .output_tokens_details
        .as_ref()
        .and_then(|details| details.thinking_tokens);
    if let Some(value) = update.input_tokens {
        target.input = value;
    }
    if let Some(value) = update.output_tokens {
        target.output = value;
    }
    if let Some(value) = update.cache_read_input_tokens {
        target.cache_read = value;
    }
    if let Some(value) = update.cache_creation_input_tokens {
        target.cache_write = value;
    }
    if let Some(value) = update
        .cache_creation
        .and_then(|cache| cache.ephemeral_1h_input_tokens)
    {
        target.cache_write_1h = Some(value);
    }
    if let Some(value) = reasoning {
        target.reasoning = Some(value);
    }
    target.total_tokens = target
        .input
        .saturating_add(target.output)
        .saturating_add(target.cache_read)
        .saturating_add(target.cache_write);
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
    signature: Option<String>,
    data: Option<String>,
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
    signature: Option<String>,
    partial_json: Option<String>,
}

#[derive(serde::Deserialize)]
struct ContentBlockStop {
    index: usize,
}

#[derive(serde::Deserialize)]
struct MessageDelta {
    delta: DeltaReason,
    usage: Option<AnthropicUsage>,
}

#[derive(serde::Deserialize, Default)]
struct DeltaReason {
    stop_reason: Option<String>,
    stop_details: Option<AnthropicStopDetails>,
}

#[derive(serde::Deserialize, Default)]
struct AnthropicStopDetails {
    explanation: Option<String>,
}
