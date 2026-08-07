//! Shared OpenAI Responses API stream processing.
//!
//! Port of pi-ai `api/openai-responses-shared.js`: the normalized event
//! accumulator, response finalization (usage folding, stop-reason mapping),
//! message/tool conversion for the `/responses` item protocol, and text
//! signature helpers. Used by both the OpenAI Responses provider and the Codex
//! provider (which maps a handful of codex event types first).

use std::collections::HashMap;

use aiden_core::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, Message, StopReason, TextContent,
    ThinkingContent, ToolCall, Usage, UserContent,
};

use crate::json::{parse_streaming_json, safe_json_stringify, short_hash};
use crate::transform::transform_messages;
use crate::{now_ms, ProviderError};

// ===========================================================================
// Signature helpers
// ===========================================================================

/// `encodeTextSignatureV1` — message-id replay signature for text blocks.
pub fn encode_text_signature_v1(id: &str, phase: Option<&str>) -> String {
    match phase {
        Some(phase) => format!(
            "{{\"v\":1,\"id\":{},\"phase\":{}}}",
            safe_json_stringify(&serde_json::Value::String(id.to_string())),
            safe_json_stringify(&serde_json::Value::String(phase.to_string()))
        ),
        None => format!(
            "{{\"v\":1,\"id\":{}}}",
            safe_json_stringify(&serde_json::Value::String(id.to_string()))
        ),
    }
}

/// Parsed text signature: stable message id + optional phase.
#[derive(Debug, Clone, Default)]
pub struct TextSignature {
    pub id: String,
    pub phase: Option<String>,
}

/// `parseTextSignature` — JSON v1 signatures and legacy plain ids.
pub fn parse_text_signature(signature: Option<&str>) -> Option<TextSignature> {
    let signature = signature?;
    if signature.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(signature) {
            if parsed.get("v") == Some(&serde_json::json!(1)) {
                if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
                    let phase = parsed
                        .get("phase")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .filter(|phase| phase == "commentary" || phase == "final_answer");
                    return Some(TextSignature {
                        id: id.to_string(),
                        phase,
                    });
                }
            }
        }
    }
    Some(TextSignature {
        id: signature.to_string(),
        phase: None,
    })
}

// ===========================================================================
// Stop reason mapping
// ===========================================================================

/// `mapStopReason` for response status strings.
pub fn map_responses_stop_reason(status: Option<&str>) -> Result<StopReason, ProviderError> {
    match status {
        None => Ok(StopReason::Stop),
        Some("completed") => Ok(StopReason::Stop),
        Some("incomplete") => Ok(StopReason::Length),
        Some("failed") | Some("cancelled") => Ok(StopReason::Error),
        // Wonky but faithful to pi: in-flight statuses read as stop.
        Some("in_progress") | Some("queued") => Ok(StopReason::Stop),
        Some(other) => Err(ProviderError::Protocol(format!(
            "unhandled response status `{other}`"
        ))),
    }
}

// ===========================================================================
// Tool conversion
// ===========================================================================

/// `convertResponsesTools`. `strict` mirrors the JS options: `Some(false)` is
/// the default (`strict: false`), `None` emits `strict: null` (the official
/// Codex client contract).
pub fn convert_responses_tools(
    tools: &[aiden_core::ToolDef],
    defer_loading: bool,
    strict: Option<bool>,
) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|tool| {
            let mut value = serde_json::json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            });
            match strict {
                Some(true) => value["strict"] = serde_json::Value::Bool(true),
                Some(false) => value["strict"] = serde_json::Value::Bool(false),
                None => value["strict"] = serde_json::Value::Null,
            }
            if defer_loading {
                value["defer_loading"] = serde_json::Value::Bool(true);
            }
            value
        })
        .collect()
}

// ===========================================================================
// Message conversion (convertResponsesMessages)
// ===========================================================================

fn normalize_id_part(part: &str) -> String {
    let sanitized: String = part
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let truncated: String = sanitized.chars().take(64).collect();
    truncated.trim_end_matches('_').to_string()
}

fn build_foreign_responses_item_id(item_id: &str) -> String {
    let normalized = format!("fc_{}", short_hash(item_id));
    normalized.chars().take(64).collect()
}

/// `convertResponsesMessages` — `Message[]` → Responses input items.
///
/// `allowed_tool_call_providers` mirrors pi's `OPENAI_TOOL_CALL_PROVIDERS` /
/// `CODEX_TOOL_CALL_PROVIDERS` sets (providers whose pipe-separated tool call
/// ids are preserved).
#[allow(clippy::too_many_arguments)]
pub fn convert_responses_messages(
    provider_id: &str,
    api: &str,
    model_id: &str,
    reasoning: bool,
    vision: bool,
    allow_developer_role: bool,
    include_system_prompt: bool,
    system_prompt: Option<&str>,
    messages: Vec<Message>,
    now: u64,
) -> Vec<serde_json::Value> {
    let allowed: std::collections::HashSet<&str> =
        ["openai", "openai-codex", "opencode"].into_iter().collect();
    let provider_allowed = allowed.contains(provider_id);
    let normalize_tool_call_id =
        move |id: &str, source_provider: &str, source_api: &str| -> String {
            if !provider_allowed {
                return normalize_id_part(id);
            }
            let Some((call_id, item_id)) = id.split_once('|') else {
                return normalize_id_part(id);
            };
            let normalized_call_id = normalize_id_part(call_id);
            let is_foreign_tool_call = source_provider != provider_id || source_api != api;
            let mut normalized_item_id = if is_foreign_tool_call {
                build_foreign_responses_item_id(item_id)
            } else {
                normalize_id_part(item_id)
            };
            if !normalized_item_id.starts_with("fc_") {
                normalized_item_id = normalize_id_part(&format!("fc_{normalized_item_id}"));
            }
            format!("{normalized_call_id}|{normalized_item_id}")
        };
    let transformed = transform_messages(
        messages,
        provider_id,
        api,
        model_id,
        vision,
        &normalize_tool_call_id,
        now,
    );

    let mut output: Vec<serde_json::Value> = Vec::new();
    if include_system_prompt {
        if let Some(system_prompt) = system_prompt {
            let role = if reasoning && allow_developer_role {
                "developer"
            } else {
                "system"
            };
            output.push(serde_json::json!({
                "role": role,
                "content": system_prompt,
            }));
        }
    }
    let mut msg_index: u64 = 0;
    for message in transformed {
        match message {
            Message::User(user) => {
                let content: Vec<serde_json::Value> = match &user.content {
                    UserContent::Text(text) => vec![serde_json::json!({
                        "type": "input_text",
                        "text": text,
                    })],
                    UserContent::Blocks(blocks) => blocks
                        .iter()
                        .map(|block| match block {
                            aiden_core::UserBlock::Text(text) => serde_json::json!({
                                "type": "input_text",
                                "text": text.text,
                            }),
                            aiden_core::UserBlock::Image(image) => serde_json::json!({
                                "type": "input_image",
                                "detail": "auto",
                                "image_url": format!("data:{};base64,{}", image.mime_type, image.data),
                            }),
                        })
                        .collect(),
                };
                if content.is_empty() {
                    msg_index += 1;
                    continue;
                }
                output.push(serde_json::json!({ "role": "user", "content": content }));
            }
            Message::Assistant(assistant) => {
                let mut items: Vec<serde_json::Value> = Vec::new();
                let is_different_model = assistant.model != model_id
                    && assistant.provider == provider_id
                    && assistant.api == api;
                let mut text_block_index = 0usize;
                for block in &assistant.content {
                    match block {
                        ContentBlock::Thinking(thinking) => {
                            if let Some(signature) = &thinking.thinking_signature {
                                if let Ok(item) =
                                    serde_json::from_str::<serde_json::Value>(signature)
                                {
                                    items.push(item);
                                }
                            }
                        }
                        ContentBlock::Text(text) => {
                            let parsed = parse_text_signature(text.text_signature.as_deref());
                            let fallback = if text_block_index == 0 {
                                format!("msg_pi_{msg_index}")
                            } else {
                                format!("msg_pi_{msg_index}_{text_block_index}")
                            };
                            text_block_index += 1;
                            let mut msg_id =
                                parsed.as_ref().map(|p| p.id.clone()).unwrap_or(fallback);
                            if msg_id.chars().count() > 64 {
                                msg_id = format!("msg_{}", short_hash(&msg_id));
                            }
                            let mut item = serde_json::json!({
                                "type": "message",
                                "role": "assistant",
                                "content": [{ "type": "output_text", "text": text.text, "annotations": [] }],
                                "status": "completed",
                                "id": msg_id,
                            });
                            if let Some(phase) = parsed.as_ref().and_then(|p| p.phase.clone()) {
                                item["phase"] = serde_json::Value::String(phase);
                            }
                            items.push(item);
                        }
                        ContentBlock::ToolCall(tool_call) => {
                            let (call_id, item_id_raw) = tool_call
                                .id
                                .split_once('|')
                                .map(|(a, b)| (a.to_string(), Some(b.to_string())))
                                .unwrap_or((tool_call.id.clone(), None));
                            let mut item_id = item_id_raw;
                            // Different-model messages omit the item id to avoid
                            // OpenAI's fc_xxx pairing validation.
                            if is_different_model
                                && item_id
                                    .as_deref()
                                    .map(|id| id.starts_with("fc_"))
                                    .unwrap_or(false)
                            {
                                item_id = None;
                            }
                            let mut item = serde_json::json!({
                                "type": "function_call",
                                "call_id": call_id,
                                "name": tool_call.name,
                                "arguments": safe_json_stringify(&tool_call.arguments),
                            });
                            if let Some(item_id) = item_id {
                                item["id"] = serde_json::Value::String(item_id);
                            }
                            items.push(item);
                        }
                        ContentBlock::Image(_) => {}
                    }
                }
                if items.is_empty() {
                    msg_index += 1;
                    continue;
                }
                output.extend(items);
            }
            Message::ToolResult(result) => {
                let text_result = result
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let has_images = result
                    .content
                    .iter()
                    .any(|block| matches!(block, ContentBlock::Image(_)));
                let has_text = !text_result.is_empty();
                let call_id = result
                    .tool_call_id
                    .split_once('|')
                    .map(|(call_id, _)| call_id.to_string())
                    .unwrap_or_else(|| result.tool_call_id.clone());
                let mut item = serde_json::json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                });
                if has_images && vision {
                    let mut content_parts: Vec<serde_json::Value> = Vec::new();
                    if has_text {
                        content_parts.push(serde_json::json!({
                            "type": "input_text",
                            "text": text_result,
                        }));
                    }
                    for block in &result.content {
                        if let ContentBlock::Image(image) = block {
                            content_parts.push(serde_json::json!({
                                "type": "input_image",
                                "detail": "auto",
                                "image_url": format!("data:{};base64,{}", image.mime_type, image.data),
                            }));
                        }
                    }
                    item["output"] = serde_json::Value::Array(content_parts);
                } else {
                    let output_text = if has_text {
                        text_result
                    } else if has_images {
                        "(see attached image)".to_string()
                    } else {
                        "(no tool output)".to_string()
                    };
                    item["output"] = serde_json::Value::String(output_text);
                }
                output.push(item);
            }
        }
        msg_index += 1;
    }
    output
}

// ===========================================================================
// Accumulator
// ===========================================================================

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ResponsesSlotKind {
    Thinking,
    Text,
    ToolCall,
}

#[derive(Clone)]
pub struct ResponsesSlot {
    pub kind: ResponsesSlotKind,
    pub content_index: usize,
    /// Streaming JSON scratch buffer for function-call arguments.
    pub partial_json: String,
}

/// Accumulates Responses API SSE events into normalized `AssistantMessageEvent`s.
pub struct ResponsesAccumulator {
    pub message: AssistantMessage,
    pub slots: HashMap<usize, ResponsesSlot>,
    pub reasoning_blocks_by_id: HashMap<String, usize>,
    pub saw_terminal_response_event: bool,
}

fn empty_message(provider: &str, model: &str, api: &str, now: u64) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: api.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
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
        timestamp: now,
    }
}

impl ResponsesAccumulator {
    pub fn new(provider: &str, model: &str, api: &str) -> Self {
        Self::with_now(provider, model, api, now_ms())
    }

    pub fn with_now(provider: &str, model: &str, api: &str, now: u64) -> Self {
        Self {
            message: empty_message(provider, model, api, now),
            slots: Default::default(),
            reasoning_blocks_by_id: Default::default(),
            saw_terminal_response_event: false,
        }
    }

    fn partial(&self) -> AssistantMessage {
        self.message.clone()
    }

    fn create_slot(
        &mut self,
        _output_index: usize,
        item: &serde_json::Value,
    ) -> Option<(ResponsesSlot, AssistantMessageEvent)> {
        let item_type = item
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        match item_type {
            "reasoning" => {
                let index = self.message.content.len();
                self.message
                    .content
                    .push(ContentBlock::Thinking(ThinkingContent {
                        thinking: String::new(),
                        thinking_signature: None,
                        redacted: None,
                    }));
                let slot = ResponsesSlot {
                    kind: ResponsesSlotKind::Thinking,
                    content_index: index,
                    partial_json: String::new(),
                };
                let event = AssistantMessageEvent::ThinkingStart {
                    content_index: index,
                    partial: self.partial(),
                };
                Some((slot, event))
            }
            "message" => {
                let index = self.message.content.len();
                self.message.content.push(ContentBlock::Text(TextContent {
                    text: String::new(),
                    text_signature: None,
                }));
                let slot = ResponsesSlot {
                    kind: ResponsesSlotKind::Text,
                    content_index: index,
                    partial_json: String::new(),
                };
                let event = AssistantMessageEvent::TextStart {
                    content_index: index,
                    partial: self.partial(),
                };
                Some((slot, event))
            }
            "function_call" => {
                let index = self.message.content.len();
                let call_id = item
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                self.message.content.push(ContentBlock::ToolCall(ToolCall {
                    id: format!("{call_id}|{item_id}"),
                    name: item
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    arguments: serde_json::Value::Object(Default::default()),
                    thought_signature: None,
                }));
                let slot = ResponsesSlot {
                    kind: ResponsesSlotKind::ToolCall,
                    content_index: index,
                    partial_json: item
                        .get("arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                };
                let event = AssistantMessageEvent::ToolcallStart {
                    content_index: index,
                    partial: self.partial(),
                };
                Some((slot, event))
            }
            _ => None,
        }
    }

    fn get_slot(&self, output_index: usize, kind: ResponsesSlotKind) -> Option<&ResponsesSlot> {
        self.slots
            .get(&output_index)
            .filter(|slot| slot.kind == kind)
    }

    fn get_or_create_slot(
        &mut self,
        output_index: usize,
        item: &serde_json::Value,
        events: &mut Vec<AssistantMessageEvent>,
    ) -> Option<ResponsesSlot> {
        if self.slots.contains_key(&output_index) {
            return self.slots.get(&output_index).cloned();
        }
        if let Some((slot, event)) = self.create_slot(output_index, item) {
            events.push(event);
            self.slots.insert(output_index, slot.clone());
            return Some(slot);
        }
        None
    }

    /// Process one Responses API SSE event (the `data:` payload).
    pub fn step(
        &mut self,
        event: &serde_json::Value,
    ) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
        let event_type = event
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let mut events = Vec::new();
        match event_type {
            "response.created" => {
                if let Some(id) = event
                    .get("response")
                    .and_then(|r| r.get("id"))
                    .and_then(|v| v.as_str())
                {
                    self.message.response_id = Some(id.to_string());
                }
            }
            "response.output_item.added" => {
                if let Some(item) = event.get("item") {
                    if let Some(output_index) = event.get("output_index").and_then(|v| v.as_u64()) {
                        if let Some((slot, ev)) = self.create_slot(output_index as usize, item) {
                            events.push(ev);
                            self.slots.insert(output_index as usize, slot);
                        }
                    }
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let Some(delta) = event.get("delta").and_then(|v| v.as_str()) else {
                    return Ok(events);
                };
                let Some(output_index) = event.get("output_index").and_then(|v| v.as_u64()) else {
                    return Ok(events);
                };
                if let Some(slot) =
                    self.get_slot(output_index as usize, ResponsesSlotKind::Thinking)
                {
                    let index = slot.content_index;
                    if let Some(ContentBlock::Thinking(block)) = self.message.content.get_mut(index)
                    {
                        block.thinking.push_str(delta);
                    }
                    events.push(AssistantMessageEvent::ThinkingDelta {
                        content_index: index,
                        delta: delta.to_string(),
                        partial: self.partial(),
                    });
                }
            }
            "response.reasoning_summary_part.done" => {
                let Some(output_index) = event.get("output_index").and_then(|v| v.as_u64()) else {
                    return Ok(events);
                };
                if let Some(slot) =
                    self.get_slot(output_index as usize, ResponsesSlotKind::Thinking)
                {
                    let index = slot.content_index;
                    if let Some(ContentBlock::Thinking(block)) = self.message.content.get_mut(index)
                    {
                        block.thinking.push_str("\n\n");
                    }
                    events.push(AssistantMessageEvent::ThinkingDelta {
                        content_index: index,
                        delta: "\n\n".to_string(),
                        partial: self.partial(),
                    });
                }
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                let Some(delta) = event.get("delta").and_then(|v| v.as_str()) else {
                    return Ok(events);
                };
                let Some(output_index) = event.get("output_index").and_then(|v| v.as_u64()) else {
                    return Ok(events);
                };
                if let Some(slot) = self.get_slot(output_index as usize, ResponsesSlotKind::Text) {
                    let index = slot.content_index;
                    if let Some(ContentBlock::Text(block)) = self.message.content.get_mut(index) {
                        block.text.push_str(delta);
                    }
                    events.push(AssistantMessageEvent::TextDelta {
                        content_index: index,
                        delta: delta.to_string(),
                        partial: self.partial(),
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                let Some(delta) = event.get("delta").and_then(|v| v.as_str()) else {
                    return Ok(events);
                };
                let Some(output_index) = event.get("output_index").and_then(|v| v.as_u64()) else {
                    return Ok(events);
                };
                if let Some(slot) =
                    self.get_slot(output_index as usize, ResponsesSlotKind::ToolCall)
                {
                    let index = slot.content_index;
                    if let Some(slot_mut) = self.slots.get_mut(&(output_index as usize)) {
                        slot_mut.partial_json.push_str(delta);
                        if let Some(ContentBlock::ToolCall(block)) =
                            self.message.content.get_mut(index)
                        {
                            block.arguments = parse_streaming_json(&slot_mut.partial_json);
                        }
                    }
                    events.push(AssistantMessageEvent::ToolcallDelta {
                        content_index: index,
                        delta: delta.to_string(),
                        partial: self.partial(),
                    });
                }
            }
            "response.function_call_arguments.done" => {
                let Some(output_index) = event.get("output_index").and_then(|v| v.as_u64()) else {
                    return Ok(events);
                };
                let Some(arguments) = event.get("arguments").and_then(|v| v.as_str()) else {
                    return Ok(events);
                };
                if let Some(slot) =
                    self.get_slot(output_index as usize, ResponsesSlotKind::ToolCall)
                {
                    let index = slot.content_index;
                    let previous = self
                        .slots
                        .get(&(output_index as usize))
                        .map(|s| s.partial_json.clone())
                        .unwrap_or_default();
                    if let Some(slot_mut) = self.slots.get_mut(&(output_index as usize)) {
                        slot_mut.partial_json = arguments.to_string();
                        if let Some(ContentBlock::ToolCall(block)) =
                            self.message.content.get_mut(index)
                        {
                            block.arguments = parse_streaming_json(&slot_mut.partial_json);
                        }
                    }
                    if arguments.starts_with(&previous) {
                        let delta = &arguments[previous.len()..];
                        if !delta.is_empty() {
                            events.push(AssistantMessageEvent::ToolcallDelta {
                                content_index: index,
                                delta: delta.to_string(),
                                partial: self.partial(),
                            });
                        }
                    }
                }
            }
            "response.output_item.done" => {
                let Some(item) = event.get("item") else {
                    return Ok(events);
                };
                let output_index = event
                    .get("output_index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                if let Some(slot) = self.get_or_create_slot(output_index, item, &mut events) {
                    let item_type = item
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let index = slot.content_index;
                    match item_type {
                        "reasoning" => {
                            if slot.kind == ResponsesSlotKind::Thinking {
                                let summary_text = item
                                    .get("summary")
                                    .and_then(|s| s.as_array())
                                    .map(|summary| {
                                        summary
                                            .iter()
                                            .filter_map(|entry| {
                                                entry.get("text").and_then(|t| t.as_str())
                                            })
                                            .collect::<Vec<_>>()
                                            .join("\n\n")
                                    })
                                    .unwrap_or_default();
                                let content_text = item
                                    .get("content")
                                    .and_then(|c| c.as_array())
                                    .map(|content| {
                                        content
                                            .iter()
                                            .filter_map(|entry| {
                                                entry.get("text").and_then(|t| t.as_str())
                                            })
                                            .collect::<Vec<_>>()
                                            .join("\n\n")
                                    })
                                    .unwrap_or_default();
                                let thinking = if !summary_text.is_empty() {
                                    summary_text
                                } else if !content_text.is_empty() {
                                    content_text
                                } else {
                                    match self.message.content.get(index) {
                                        Some(ContentBlock::Thinking(block)) => {
                                            block.thinking.clone()
                                        }
                                        _ => String::new(),
                                    }
                                };
                                if let Some(ContentBlock::Thinking(block)) =
                                    self.message.content.get_mut(index)
                                {
                                    block.thinking = thinking.clone();
                                    block.thinking_signature = Some(safe_json_stringify(item));
                                }
                                if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                                    self.reasoning_blocks_by_id.insert(id.to_string(), index);
                                }
                                events.push(AssistantMessageEvent::ThinkingEnd {
                                    content_index: index,
                                    content: thinking,
                                    partial: self.partial(),
                                });
                                self.slots.remove(&output_index);
                            }
                        }
                        "message" => {
                            if slot.kind == ResponsesSlotKind::Text {
                                let text = item
                                    .get("content")
                                    .and_then(|c| c.as_array())
                                    .map(|content| {
                                        content
                                            .iter()
                                            .map(|entry| {
                                                entry
                                                    .get("text")
                                                    .and_then(|t| t.as_str())
                                                    .or_else(|| {
                                                        entry
                                                            .get("refusal")
                                                            .and_then(|t| t.as_str())
                                                    })
                                                    .unwrap_or_default()
                                                    .to_string()
                                            })
                                            .collect::<String>()
                                    })
                                    .unwrap_or_default();
                                let item_id =
                                    item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                                let phase = item.get("phase").and_then(|v| v.as_str());
                                let signature = encode_text_signature_v1(item_id, phase);
                                if let Some(ContentBlock::Text(block)) =
                                    self.message.content.get_mut(index)
                                {
                                    block.text = text.clone();
                                    block.text_signature = Some(signature);
                                }
                                events.push(AssistantMessageEvent::TextEnd {
                                    content_index: index,
                                    content: text,
                                    partial: self.partial(),
                                });
                                self.slots.remove(&output_index);
                            }
                        }
                        "function_call" if slot.kind == ResponsesSlotKind::ToolCall => {
                            let partial_json = self
                                .slots
                                .get(&output_index)
                                .map(|s| s.partial_json.clone())
                                .unwrap_or_default();
                            let item_arguments = item
                                .get("arguments")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let source = if item_arguments.is_empty() {
                                if partial_json.is_empty() {
                                    "{}".to_string()
                                } else {
                                    partial_json.clone()
                                }
                            } else {
                                item_arguments
                            };
                            let arguments = parse_streaming_json(&source);
                            let mut tool_call = match self.message.content.get(index).cloned() {
                                Some(ContentBlock::ToolCall(tool_call)) => tool_call,
                                _ => ToolCall {
                                    id: String::new(),
                                    name: String::new(),
                                    arguments: serde_json::Value::Object(Default::default()),
                                    thought_signature: None,
                                },
                            };
                            tool_call.arguments = arguments;
                            if let Some(ContentBlock::ToolCall(block)) =
                                self.message.content.get_mut(index)
                            {
                                block.arguments = tool_call.arguments.clone();
                            }
                            events.push(AssistantMessageEvent::ToolcallEnd {
                                content_index: index,
                                tool_call,
                                partial: self.partial(),
                            });
                            self.slots.remove(&output_index);
                        }
                        _ => {}
                    }
                }
            }
            "response.completed" | "response.incomplete" => {
                if let Some(response) = event.get("response") {
                    self.finalize_response(response);
                }
            }
            "error" => {
                let code = event
                    .get("code")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let message = event
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error");
                return Err(ProviderError::Stream(format!(
                    "Error Code {code}: {message}"
                )));
            }
            "response.failed" => {
                self.saw_terminal_response_event = true;
                let response = event.get("response");
                let error_message = response
                    .and_then(|r| r.get("error"))
                    .map(|error| {
                        let code = error
                            .get("code")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let message = error
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("no message");
                        format!("{code}: {message}")
                    })
                    .or_else(|| {
                        response
                            .and_then(|r| r.get("incomplete_details"))
                            .and_then(|details| details.get("reason"))
                            .and_then(|v| v.as_str())
                            .map(|reason| format!("incomplete: {reason}"))
                    })
                    .unwrap_or_else(|| "Unknown error (no error details in response)".to_string());
                return Err(ProviderError::Stream(error_message));
            }
            _ => {
                // Unknown events are ignored (e.g. response.output_item.done
                // variants pi does not model).
            }
        }
        Ok(events)
    }

    /// `finalizeResponse` — fold id/usage/status from a terminal response.
    fn finalize_response(&mut self, response: &serde_json::Value) {
        self.saw_terminal_response_event = true;
        self.backfill_reasoning_signatures(response.get("output").and_then(|o| o.as_array()));
        if let Some(id) = response.get("id").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                self.message.response_id = Some(id.to_string());
            }
        }
        if let Some(usage) = response.get("usage") {
            let input_tokens = usage
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cached_tokens = usage
                .get("input_tokens_details")
                .and_then(|v| v.get("cached_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cache_write_tokens = usage
                .get("input_tokens_details")
                .and_then(|v| v.get("cache_write_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output_tokens = usage
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let reasoning_tokens = usage
                .get("output_tokens_details")
                .and_then(|v| v.get("reasoning_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            self.message.usage = Usage {
                input: input_tokens
                    .saturating_sub(cached_tokens)
                    .saturating_sub(cache_write_tokens),
                output: output_tokens,
                cache_read: cached_tokens,
                cache_write: cache_write_tokens,
                cache_write_1h: None,
                reasoning: Some(reasoning_tokens),
                total_tokens: usage
                    .get("total_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                cost: aiden_core::UsageCost {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total: 0.0,
                },
            };
        }
        let status = response.get("status").and_then(|v| v.as_str());
        self.message.stop_reason = map_responses_stop_reason(status).unwrap_or(StopReason::Error);
        if self.message.stop_reason == StopReason::Stop
            && self
                .message
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolCall(_)))
        {
            self.message.stop_reason = StopReason::ToolUse;
        }
    }

    /// Azure workaround: backfill persisted reasoning signatures from the
    /// terminal response output.
    fn backfill_reasoning_signatures(&mut self, output: Option<&Vec<serde_json::Value>>) {
        let Some(output) = output else {
            return;
        };
        for item in output {
            if item.get("type").and_then(|v| v.as_str()) != Some("reasoning") {
                continue;
            }
            let Some(encrypted_content) = item.get("encrypted_content") else {
                continue;
            };
            let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(&index) = self.reasoning_blocks_by_id.get(id) else {
                continue;
            };
            let Some(ContentBlock::Thinking(block)) = self.message.content.get_mut(index) else {
                continue;
            };
            let Some(signature) = block.thinking_signature.clone() else {
                continue;
            };
            if let Ok(mut stored) = serde_json::from_str::<serde_json::Value>(&signature) {
                if stored.get("encrypted_content").is_some() {
                    continue;
                }
                stored["encrypted_content"] = encrypted_content.clone();
                block.thinking_signature = Some(safe_json_stringify(&stored));
            }
        }
    }

    /// Terminal check mirroring the JS post-loop guard: without a terminal
    /// response event the stream is a protocol failure.
    pub fn require_terminal_event(&self) -> Result<(), ProviderError> {
        if self.saw_terminal_response_event {
            Ok(())
        } else {
            Err(ProviderError::Protocol(
                "OpenAI Responses stream ended before a terminal response event".to_string(),
            ))
        }
    }
}

/// Emit the terminal event after the stream ends, mirroring the JS `done`
/// push (with the `stopReason == error/aborted` conversion).
pub fn finish_responses(
    accumulator: &mut ResponsesAccumulator,
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    let mut events = Vec::new();
    // Close any open text blocks so consumers see their accumulated content.
    let open_indexes: Vec<usize> = {
        let mut indexes: Vec<usize> = accumulator
            .slots
            .values()
            .map(|slot| slot.content_index)
            .collect();
        indexes.sort_unstable();
        indexes.dedup();
        indexes
    };
    for index in open_indexes {
        match accumulator.message.content.get(index).cloned() {
            Some(aiden_core::ContentBlock::Text(text)) => {
                events.push(AssistantMessageEvent::TextEnd {
                    content_index: index,
                    content: text.text,
                    partial: accumulator.message.clone(),
                });
            }
            Some(aiden_core::ContentBlock::Thinking(thinking)) => {
                events.push(AssistantMessageEvent::ThinkingEnd {
                    content_index: index,
                    content: thinking.thinking,
                    partial: accumulator.message.clone(),
                });
            }
            _ => {}
        }
    }
    accumulator.slots.clear();
    if accumulator.message.stop_reason == StopReason::Error
        || accumulator.message.stop_reason == StopReason::Aborted
    {
        events.push(AssistantMessageEvent::Error {
            reason: accumulator.message.stop_reason,
            error: accumulator.message.clone(),
        });
    } else {
        events.push(AssistantMessageEvent::Done {
            reason: accumulator.message.stop_reason,
            message: accumulator.message.clone(),
        });
    }
    Ok(events)
}
