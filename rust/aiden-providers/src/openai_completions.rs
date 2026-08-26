//! OpenAI Chat Completions transport (`chat/completions` streaming).
//!
//! Port of pi-ai `api/openai-completions.js`: compat auto-detection,
//! message/tool conversion, request params (including per-endpoint thinking
//! formats), and the streaming accumulator (text / reasoning / tool_calls
//! assembly / usage / finish_reason). Covers Aiden custom connections and
//! local runtimes (LM Studio, Ollama).

use std::collections::HashMap;

use aiden_core::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, Message, StopReason, TextContent,
    ThinkingContent, ToolCall, Usage, UserContent,
};
use futures::Stream;

use crate::estimate::clamp_max_tokens_to_context;
use crate::json::{parse_streaming_json, safe_json_stringify, sanitize_surrogates};
use crate::sse::data_payloads;
use crate::transform::transform_messages;
use crate::{
    now_ms, sse_payload_stream, EventStream, Provider, ProviderError, StreamOptions, StreamRequest,
    ThinkingLevel,
};

/// Auto-detected compatibility fields that shape request bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaxTokensField {
    MaxTokens,
    MaxCompletionTokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingFormat {
    Openai,
    Deepseek,
    Zai,
    Together,
    AntLing,
    Openrouter,
    StringThinking,
    Qwen,
    QwenChatTemplate,
    ChatTemplate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAffinityFormat {
    Openai,
    Openrouter,
}

#[derive(Debug, Clone)]
pub struct OpenAICompletionsCompat {
    pub supports_store: bool,
    pub supports_developer_role: bool,
    pub supports_reasoning_effort: bool,
    pub supports_usage_in_streaming: bool,
    pub max_tokens_field: MaxTokensField,
    pub requires_tool_result_name: bool,
    pub requires_assistant_after_tool_result: bool,
    pub requires_thinking_as_text: bool,
    pub requires_reasoning_content_on_assistant_messages: bool,
    pub thinking_format: ThinkingFormat,
    pub supports_strict_mode: bool,
    pub send_session_affinity_headers: bool,
    pub session_affinity_format: SessionAffinityFormat,
    pub supports_long_cache_retention: bool,
}

impl Default for OpenAICompletionsCompat {
    fn default() -> Self {
        Self {
            supports_store: true,
            supports_developer_role: true,
            supports_reasoning_effort: true,
            supports_usage_in_streaming: true,
            max_tokens_field: MaxTokensField::MaxCompletionTokens,
            requires_tool_result_name: false,
            requires_assistant_after_tool_result: false,
            requires_thinking_as_text: false,
            requires_reasoning_content_on_assistant_messages: false,
            thinking_format: ThinkingFormat::Openai,
            supports_strict_mode: true,
            send_session_affinity_headers: false,
            session_affinity_format: SessionAffinityFormat::Openai,
            supports_long_cache_retention: true,
        }
    }
}

/// `detectCompat` — auto-detect compatibility from provider id + base URL.
pub fn detect_compat(provider_id: &str, base_url: &str, model_id: &str) -> OpenAICompletionsCompat {
    let is_zai = provider_id == "zai"
        || provider_id == "zai-coding-cn"
        || base_url.contains("api.z.ai")
        || base_url.contains("open.bigmodel.cn");
    let is_together = provider_id == "together"
        || base_url.contains("api.together.ai")
        || base_url.contains("api.together.xyz");
    let is_moonshot = provider_id == "moonshotai"
        || provider_id == "moonshotai-cn"
        || base_url.contains("api.moonshot.");
    let is_openrouter = provider_id == "openrouter" || base_url.contains("openrouter.ai");
    let is_cloudflare_workers_ai =
        provider_id == "cloudflare-workers-ai" || base_url.contains("api.cloudflare.com");
    let is_cloudflare_ai_gateway =
        provider_id == "cloudflare-ai-gateway" || base_url.contains("gateway.ai.cloudflare.com");
    let is_nvidia = provider_id == "nvidia" || base_url.contains("integrate.api.nvidia.com");
    let is_ant_ling = provider_id == "ant-ling" || base_url.contains("api.ant-ling.com");
    let is_non_standard = is_nvidia
        || provider_id == "cerebras"
        || base_url.contains("cerebras.ai")
        || provider_id == "xai"
        || base_url.contains("api.x.ai")
        || is_together
        || base_url.contains("chutes.ai")
        || base_url.contains("deepseek.com")
        || is_zai
        || is_moonshot
        || provider_id == "opencode"
        || base_url.contains("opencode.ai")
        || is_cloudflare_workers_ai
        || is_cloudflare_ai_gateway
        || is_ant_ling;
    let use_max_tokens = base_url.contains("chutes.ai")
        || is_moonshot
        || is_cloudflare_ai_gateway
        || is_together
        || is_nvidia
        || is_ant_ling;
    let is_grok = provider_id == "xai" || base_url.contains("api.x.ai");
    let is_deepseek = provider_id == "deepseek" || base_url.contains("deepseek.com");
    let is_openrouter_developer_role_model =
        is_openrouter && (model_id.starts_with("anthropic/") || model_id.starts_with("openai/"));
    let thinking_format = if is_deepseek {
        ThinkingFormat::Deepseek
    } else if is_zai {
        ThinkingFormat::Zai
    } else if is_together {
        ThinkingFormat::Together
    } else if is_ant_ling {
        ThinkingFormat::AntLing
    } else if is_openrouter {
        ThinkingFormat::Openrouter
    } else {
        ThinkingFormat::Openai
    };
    OpenAICompletionsCompat {
        supports_store: !is_non_standard,
        supports_developer_role: is_openrouter_developer_role_model
            || (!is_non_standard && !is_openrouter),
        supports_reasoning_effort: !is_grok
            && !is_zai
            && !is_moonshot
            && !is_together
            && !is_cloudflare_ai_gateway
            && !is_nvidia
            && !is_ant_ling,
        supports_usage_in_streaming: true,
        max_tokens_field: if use_max_tokens {
            MaxTokensField::MaxTokens
        } else {
            MaxTokensField::MaxCompletionTokens
        },
        requires_tool_result_name: false,
        requires_assistant_after_tool_result: false,
        requires_thinking_as_text: false,
        requires_reasoning_content_on_assistant_messages: is_deepseek,
        thinking_format,
        supports_strict_mode: !is_moonshot
            && !is_together
            && !is_cloudflare_ai_gateway
            && !is_nvidia,
        send_session_affinity_headers: false,
        session_affinity_format: if is_openrouter {
            SessionAffinityFormat::Openrouter
        } else {
            SessionAffinityFormat::Openai
        },
        supports_long_cache_retention: !(is_together
            || is_cloudflare_workers_ai
            || is_cloudflare_ai_gateway
            || is_nvidia
            || is_ant_ling),
    }
}

// ===========================================================================
// Message conversion (convertMessages)
// ===========================================================================

/// `convertMessages` — normalized messages → OpenAI Chat Completions params.
pub fn convert_openai_completions_messages(
    request: &StreamRequest,
    compat: &OpenAICompletionsCompat,
    messages: Vec<Message>,
    now: u64,
) -> Vec<serde_json::Value> {
    let normalize_tool_call_id = move |id: &str, _provider: &str, _api: &str| -> String {
        if let Some((call_id, _)) = id.split_once('|') {
            let sanitized: String = call_id
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect();
            return sanitized.chars().take(40).collect();
        }
        if request.provider_id == "openai" {
            return id.chars().take(40).collect();
        }
        id.to_string()
    };
    let transformed = transform_messages(
        messages,
        &request.provider_id,
        request.api.as_str(),
        &request.model,
        request.vision,
        &normalize_tool_call_id,
        now,
    );
    let mut params: Vec<serde_json::Value> = Vec::new();
    if let Some(system_prompt) = &request.system_prompt {
        let use_developer_role = request.reasoning && compat.supports_developer_role;
        let role = if use_developer_role {
            "developer"
        } else {
            "system"
        };
        params.push(serde_json::json!({
            "role": role,
            "content": sanitize_surrogates(system_prompt),
        }));
    }
    let mut last_role: Option<&'static str> = None;
    let mut index = 0;
    while index < transformed.len() {
        let message = &transformed[index];
        if compat.requires_assistant_after_tool_result
            && last_role == Some("toolResult")
            && matches!(message, Message::User(_))
        {
            params.push(serde_json::json!({
                "role": "assistant",
                "content": "I have processed the tool results.",
            }));
        }
        match message {
            Message::User(user) => {
                match &user.content {
                    UserContent::Text(text) => {
                        params.push(serde_json::json!({
                            "role": "user",
                            "content": sanitize_surrogates(text),
                        }));
                    }
                    UserContent::Blocks(blocks) => {
                        let content: Vec<serde_json::Value> = blocks
                            .iter()
                            .map(|block| match block {
                                aiden_core::UserBlock::Text(text) => serde_json::json!({
                                    "type": "text",
                                    "text": sanitize_surrogates(&text.text),
                                }),
                                aiden_core::UserBlock::Image(image) => serde_json::json!({
                                    "type": "image_url",
                                    "image_url": {
                                        "url": format!("data:{};base64,{}", image.mime_type, image.data),
                                    },
                                }),
                            })
                            .collect();
                        if content.is_empty() {
                            last_role = Some("user");
                            index += 1;
                            continue;
                        }
                        params.push(serde_json::json!({ "role": "user", "content": content }));
                    }
                }
                last_role = Some("user");
            }
            Message::Assistant(assistant) => {
                let mut assistant_msg = serde_json::Map::new();
                assistant_msg.insert("role".into(), serde_json::Value::String("assistant".into()));
                let mut assistant_text = String::new();
                for block in &assistant.content {
                    if let ContentBlock::Text(text) = block {
                        assistant_text.push_str(&text.text);
                    }
                }
                let non_empty_thinking: Vec<&ThinkingContent> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Thinking(thinking)
                            if !thinking.thinking.trim().is_empty() =>
                        {
                            Some(thinking)
                        }
                        _ => None,
                    })
                    .collect();
                if !non_empty_thinking.is_empty() {
                    if compat.requires_thinking_as_text {
                        let thinking_text = non_empty_thinking
                            .iter()
                            .map(|block| sanitize_surrogates(&block.thinking))
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        let mut text_parts = vec![serde_json::json!({
                            "type": "text",
                            "text": thinking_text,
                        })];
                        for block in &assistant.content {
                            if let ContentBlock::Text(text) = block {
                                if !text.text.trim().is_empty() {
                                    text_parts.push(serde_json::json!({
                                        "type": "text",
                                        "text": sanitize_surrogates(&text.text),
                                    }));
                                }
                            }
                        }
                        assistant_msg
                            .insert("content".into(), serde_json::Value::Array(text_parts));
                    } else {
                        if !assistant_text.is_empty() {
                            assistant_msg.insert(
                                "content".into(),
                                serde_json::Value::String(assistant_text.clone()),
                            );
                        }
                        let mut signature = non_empty_thinking[0].thinking_signature.clone();
                        if request.provider_id == "opencode-go"
                            && signature.as_deref() == Some("reasoning")
                        {
                            signature = Some("reasoning_content".to_string());
                        }
                        if let Some(signature) = signature {
                            if !signature.is_empty() {
                                let joined = non_empty_thinking
                                    .iter()
                                    .map(|block| block.thinking.clone())
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                assistant_msg.insert(signature, serde_json::Value::String(joined));
                            }
                        }
                    }
                } else if !assistant_text.is_empty() {
                    assistant_msg.insert(
                        "content".into(),
                        serde_json::Value::String(assistant_text.clone()),
                    );
                }
                let tool_calls: Vec<&ToolCall> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolCall(tool_call) => Some(tool_call),
                        _ => None,
                    })
                    .collect();
                if !tool_calls.is_empty() {
                    let calls: Vec<serde_json::Value> = tool_calls
                        .iter()
                        .map(|tool_call| {
                            serde_json::json!({
                                "id": tool_call.id,
                                "type": "function",
                                "function": {
                                    "name": tool_call.name,
                                    "arguments": safe_json_stringify(&tool_call.arguments),
                                },
                            })
                        })
                        .collect();
                    assistant_msg.insert("tool_calls".into(), serde_json::Value::Array(calls));
                    let reasoning_details: Vec<serde_json::Value> = tool_calls
                        .iter()
                        .filter_map(|tool_call| tool_call.thought_signature.as_ref())
                        .filter_map(|signature| serde_json::from_str(signature).ok())
                        .collect();
                    if !reasoning_details.is_empty() {
                        assistant_msg.insert(
                            "reasoning_details".into(),
                            serde_json::Value::Array(reasoning_details),
                        );
                    }
                }
                if compat.requires_reasoning_content_on_assistant_messages
                    && request.reasoning
                    && !assistant_msg.contains_key("reasoning_content")
                {
                    assistant_msg.insert(
                        "reasoning_content".into(),
                        serde_json::Value::String(String::new()),
                    );
                }
                let has_content = assistant_msg.contains_key("content")
                    && match assistant_msg.get("content") {
                        Some(serde_json::Value::String(text)) => !text.is_empty(),
                        Some(serde_json::Value::Array(parts)) => !parts.is_empty(),
                        _ => false,
                    };
                if has_content || assistant_msg.contains_key("tool_calls") {
                    params.push(serde_json::Value::Object(assistant_msg));
                }
                last_role = Some("assistant");
            }
            Message::ToolResult(_) => {
                // Tool results are coalesced across consecutive tool messages.
                let mut image_blocks: Vec<serde_json::Value> = Vec::new();
                let mut end = index;
                while end < transformed.len() && matches!(transformed[end], Message::ToolResult(_))
                {
                    let Message::ToolResult(tool_msg) = &transformed[end] else {
                        break;
                    };
                    let text_result = tool_msg
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text(text) => Some(text.text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let has_images = tool_msg
                        .content
                        .iter()
                        .any(|block| matches!(block, ContentBlock::Image(_)));
                    let has_text = !text_result.is_empty();
                    let tool_result_text = if has_text {
                        text_result
                    } else if has_images {
                        "(see attached image)".to_string()
                    } else {
                        "(no tool output)".to_string()
                    };
                    let mut tool_result_msg = serde_json::json!({
                        "role": "tool",
                        "content": sanitize_surrogates(&tool_result_text),
                        "tool_call_id": tool_msg.tool_call_id,
                    });
                    if compat.requires_tool_result_name && !tool_msg.tool_name.is_empty() {
                        tool_result_msg["name"] =
                            serde_json::Value::String(tool_msg.tool_name.clone());
                    }
                    params.push(tool_result_msg);
                    if has_images && request.vision {
                        for block in &tool_msg.content {
                            if let ContentBlock::Image(image) = block {
                                image_blocks.push(serde_json::json!({
                                    "type": "image_url",
                                    "image_url": {
                                        "url": format!("data:{};base64,{}", image.mime_type, image.data),
                                    },
                                }));
                            }
                        }
                    }
                    end += 1;
                }
                if !image_blocks.is_empty() {
                    if compat.requires_assistant_after_tool_result {
                        params.push(serde_json::json!({
                            "role": "assistant",
                            "content": "I have processed the tool results.",
                        }));
                    }
                    let mut content = vec![serde_json::json!({
                        "type": "text",
                        "text": "Attached image(s) from tool result:",
                    })];
                    content.extend(image_blocks);
                    params.push(serde_json::json!({ "role": "user", "content": content }));
                    last_role = Some("user");
                } else {
                    last_role = Some("toolResult");
                }
                index = end;
                continue;
            }
        }
        index += 1;
    }
    params
}

/// `convertTools` — OpenAI function tools with optional strict.
pub fn convert_openai_completions_tools(
    tools: &[aiden_core::ToolDef],
    compat: &OpenAICompletionsCompat,
) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|tool| {
            let mut function = serde_json::json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            });
            if compat.supports_strict_mode {
                function["strict"] = serde_json::Value::Bool(false);
            }
            serde_json::json!({ "type": "function", "function": function })
        })
        .collect()
}

// ===========================================================================
// Request params (buildParams)
// ===========================================================================

/// Whether any message carries tool calls or tool results.
fn has_tool_history(messages: &[Message]) -> bool {
    messages.iter().any(|message| match message {
        Message::ToolResult(_) => true,
        Message::Assistant(assistant) => assistant
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolCall(_))),
        _ => false,
    })
}

fn thinking_map_value(request: &StreamRequest, level: Option<ThinkingLevel>) -> Option<String> {
    let level = level?;
    let mapped = request
        .thinking_level_map
        .as_ref()
        .and_then(|map| map.get(level.as_str()))
        .cloned()
        .flatten();
    Some(mapped.unwrap_or_else(|| level.as_str().to_string()))
}

/// Port of `buildParams` for chat completions.
pub fn build_openai_completions_params(
    request: &StreamRequest,
    options: &StreamOptions,
    compat: &OpenAICompletionsCompat,
) -> serde_json::Value {
    let messages =
        convert_openai_completions_messages(request, compat, request.messages.clone(), now_ms());
    let mut params = serde_json::Map::new();
    params.insert(
        "model".into(),
        serde_json::Value::String(request.model.clone()),
    );
    params.insert("messages".into(), serde_json::Value::Array(messages));
    params.insert("stream".into(), serde_json::Value::Bool(true));
    if compat.supports_usage_in_streaming {
        params.insert(
            "stream_options".into(),
            serde_json::json!({ "include_usage": true }),
        );
    }
    if compat.supports_store {
        params.insert("store".into(), serde_json::Value::Bool(false));
    }
    let max_tokens = request
        .max_tokens
        .unwrap_or(request.max_tokens_limit)
        .max(1);
    // Clamp to the context window with safety headroom (simple-options).
    let max_tokens =
        clamp_max_tokens_to_context(request.context_window, &request.messages, max_tokens);
    match compat.max_tokens_field {
        MaxTokensField::MaxTokens => {
            params.insert("max_tokens".into(), serde_json::json!(max_tokens));
        }
        MaxTokensField::MaxCompletionTokens => {
            params.insert(
                "max_completion_tokens".into(),
                serde_json::json!(max_tokens),
            );
        }
    }
    if let Some(temperature) = options.temperature.or(request.temperature) {
        params.insert("temperature".into(), serde_json::json!(temperature));
    }
    if !request.tools.is_empty() {
        params.insert(
            "tools".into(),
            serde_json::Value::Array(convert_openai_completions_tools(&request.tools, compat)),
        );
    } else if has_tool_history(&request.messages) {
        params.insert("tools".into(), serde_json::Value::Array(Vec::new()));
    }
    if let Some(tool_choice) = options
        .tool_choice
        .clone()
        .or_else(|| request.tool_choice.clone())
    {
        params.insert("tool_choice".into(), serde_json::Value::String(tool_choice));
    }

    // Thinking formats.
    let reasoning_effort = request.thinking_level;
    let clamped_effort = reasoning_effort.and_then(|level| {
        crate::clamp_thinking_level(
            request.reasoning,
            request.thinking_level_map.as_ref(),
            level,
        )
    });
    match compat.thinking_format {
        ThinkingFormat::Zai if request.reasoning => {
            params.insert(
                "thinking".into(),
                if clamped_effort.is_some() {
                    serde_json::json!({ "type": "enabled", "clear_thinking": false })
                } else {
                    serde_json::json!({ "type": "disabled" })
                },
            );
            if clamped_effort.is_some() && compat.supports_reasoning_effort {
                if let Some(effort) = thinking_map_value(request, clamped_effort) {
                    params.insert("reasoning_effort".into(), serde_json::Value::String(effort));
                }
            }
        }
        ThinkingFormat::Qwen if request.reasoning => {
            params.insert(
                "enable_thinking".into(),
                serde_json::Value::Bool(clamped_effort.is_some()),
            );
        }
        ThinkingFormat::Deepseek if request.reasoning => {
            if clamped_effort.is_some() {
                params.insert("thinking".into(), serde_json::json!({ "type": "enabled" }));
            } else {
                let off_is_supported = request
                    .thinking_level_map
                    .as_ref()
                    .and_then(|map| map.get("off"))
                    .map(|value| value.is_some())
                    .unwrap_or(true);
                if off_is_supported {
                    params.insert("thinking".into(), serde_json::json!({ "type": "disabled" }));
                }
            }
            if clamped_effort.is_some() && compat.supports_reasoning_effort {
                let effort = thinking_map_value(request, clamped_effort)
                    .unwrap_or_else(|| clamped_effort.unwrap().as_str().to_string());
                params.insert("reasoning_effort".into(), serde_json::Value::String(effort));
            }
        }
        ThinkingFormat::Openrouter if request.reasoning => {
            if let Some(effort) = clamped_effort {
                params.insert(
                    "reasoning".into(),
                    serde_json::json!({ "effort": thinking_map_value(request, Some(effort)).unwrap_or_else(|| effort.as_str().to_string()) }),
                );
            } else {
                let off = request
                    .thinking_level_map
                    .as_ref()
                    .and_then(|map| map.get("off"))
                    .cloned()
                    .flatten()
                    .unwrap_or_else(|| "none".to_string());
                params.insert("reasoning".into(), serde_json::json!({ "effort": off }));
            }
        }
        ThinkingFormat::AntLing if request.reasoning => {
            if let Some(effort) = clamped_effort {
                if let Some(mapped) = thinking_map_value(request, Some(effort)) {
                    params.insert("reasoning".into(), serde_json::json!({ "effort": mapped }));
                }
            }
        }
        ThinkingFormat::Together if request.reasoning => {
            params.insert(
                "reasoning".into(),
                serde_json::json!({ "enabled": clamped_effort.is_some() }),
            );
            if clamped_effort.is_some() && compat.supports_reasoning_effort {
                let effort = thinking_map_value(request, clamped_effort)
                    .unwrap_or_else(|| clamped_effort.unwrap().as_str().to_string());
                params.insert("reasoning_effort".into(), serde_json::Value::String(effort));
            }
        }
        ThinkingFormat::StringThinking if request.reasoning => {
            if let Some(effort) = clamped_effort {
                params.insert(
                    "thinking".into(),
                    serde_json::Value::String(
                        thinking_map_value(request, Some(effort))
                            .unwrap_or_else(|| effort.as_str().to_string()),
                    ),
                );
            } else {
                let off = request
                    .thinking_level_map
                    .as_ref()
                    .and_then(|map| map.get("off"))
                    .cloned()
                    .flatten()
                    .unwrap_or_else(|| "none".to_string());
                params.insert("thinking".into(), serde_json::Value::String(off));
            }
        }
        _ => {
            if let Some(effort) = clamped_effort {
                if request.reasoning && compat.supports_reasoning_effort {
                    params.insert(
                        "reasoning_effort".into(),
                        serde_json::Value::String(
                            thinking_map_value(request, Some(effort))
                                .unwrap_or_else(|| effort.as_str().to_string()),
                        ),
                    );
                }
            } else if request.reasoning && compat.supports_reasoning_effort {
                if let Some(off_value) = request
                    .thinking_level_map
                    .as_ref()
                    .and_then(|map| map.get("off"))
                    .cloned()
                    .flatten()
                {
                    params.insert(
                        "reasoning_effort".into(),
                        serde_json::Value::String(off_value),
                    );
                }
            }
        }
    }
    serde_json::Value::Object(params)
}

// ===========================================================================
// Streaming accumulator
// ===========================================================================

struct CcToolCallState {
    block_index: usize,
    name: String,
    partial_args: String,
    stream_index: Option<u64>,
}

/// Accumulates `chat.completions` SSE chunks into normalized events.
pub struct OpenAICompletionsAccumulator {
    message: AssistantMessage,
    provider_id: String,
    started: bool,
    text_block: Option<usize>,
    thinking_block: Option<usize>,
    tool_call_by_index: HashMap<u64, usize>,
    tool_call_by_id: HashMap<String, usize>,
    tool_calls: Vec<CcToolCallState>,
    pending_reasoning_details: HashMap<String, String>,
    has_finish_reason: bool,
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

impl OpenAICompletionsAccumulator {
    pub fn new(provider: &str, model: &str, api: &str) -> Self {
        Self::with_now(provider, model, api, now_ms())
    }

    pub fn with_now(provider: &str, model: &str, api: &str, now: u64) -> Self {
        Self {
            message: empty_message(provider, model, api, now),
            provider_id: provider.to_string(),
            started: false,
            text_block: None,
            thinking_block: None,
            tool_call_by_index: Default::default(),
            tool_call_by_id: Default::default(),
            tool_calls: Vec::new(),
            pending_reasoning_details: Default::default(),
            has_finish_reason: false,
        }
    }

    fn partial(&self) -> AssistantMessage {
        self.message.clone()
    }

    /// Process one `chat.completions` chunk.
    pub fn step(
        &mut self,
        chunk: &serde_json::Value,
    ) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
        self.started = true;
        let mut events = Vec::new();
        if let Some(id) = chunk.get("id").and_then(|v| v.as_str()) {
            if self.message.response_id.is_none() {
                self.message.response_id = Some(id.to_string());
            }
        }
        if let Some(model) = chunk.get("model").and_then(|v| v.as_str()) {
            if !model.is_empty()
                && model != self.message.model
                && self.message.response_model.is_none()
            {
                self.message.response_model = Some(model.to_string());
            }
        }
        if let Some(usage) = chunk.get("usage") {
            self.message.usage = parse_chunk_usage(usage);
        }
        let choice = chunk
            .get("choices")
            .and_then(|v| v.as_array())
            .and_then(|array| array.first());
        let Some(choice) = choice else {
            return Ok(events);
        };
        if self.message.usage.total_tokens == 0 {
            if let Some(usage) = choice.get("usage") {
                self.message.usage = parse_chunk_usage(usage);
            }
        }
        if let Some(finish_reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            let result = map_stop_reason(finish_reason);
            self.message.stop_reason = result.stop_reason;
            if let Some(error_message) = result.error_message {
                self.message.error_message = Some(error_message);
            }
            self.has_finish_reason = true;
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(events);
        };
        if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
            if !content.is_empty() {
                let block_index = self.ensure_text_block(&mut events);
                if let Some(ContentBlock::Text(block)) = self.message.content.get_mut(block_index) {
                    block.text.push_str(content);
                }
                events.push(AssistantMessageEvent::TextDelta {
                    content_index: block_index,
                    delta: content.to_string(),
                    partial: self.partial(),
                });
            }
        }
        // Reasoning fields: reasoning_content, reasoning, reasoning_text.
        let mut found_reasoning: Option<(&str, String)> = None;
        for field in ["reasoning_content", "reasoning", "reasoning_text"] {
            if let Some(value) = delta.get(field).and_then(|v| v.as_str()) {
                if !value.is_empty() {
                    found_reasoning = Some((field, value.to_string()));
                    break;
                }
            }
        }
        if let Some((field, delta_text)) = found_reasoning {
            let signature = if self.provider_id == "opencode-go" && field == "reasoning" {
                "reasoning_content".to_string()
            } else {
                field.to_string()
            };
            let block_index = self.ensure_thinking_block(&mut events, Some(signature));
            if let Some(ContentBlock::Thinking(block)) = self.message.content.get_mut(block_index) {
                block.thinking.push_str(&delta_text);
            }
            events.push(AssistantMessageEvent::ThinkingDelta {
                content_index: block_index,
                delta: delta_text,
                partial: self.partial(),
            });
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for tool_call in tool_calls {
                let stream_index = tool_call.get("index").and_then(|v| v.as_u64());
                let id = tool_call
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let name = tool_call
                    .get("function")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let args_delta = tool_call
                    .get("function")
                    .and_then(|v| v.get("arguments"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let block_index = self.ensure_tool_call_block(
                    stream_index,
                    id.as_deref(),
                    name.as_deref(),
                    &mut events,
                );
                let mut delta = String::new();
                if let Some(args_delta) = args_delta {
                    delta = args_delta.clone();
                    if let Some(state) = self
                        .tool_calls
                        .iter_mut()
                        .find(|state| state.block_index == block_index)
                    {
                        state.partial_args.push_str(&args_delta);
                        if let Some(ContentBlock::ToolCall(block)) =
                            self.message.content.get_mut(block_index)
                        {
                            block.arguments = parse_streaming_json(&state.partial_args);
                        }
                    }
                }
                events.push(AssistantMessageEvent::ToolcallDelta {
                    content_index: block_index,
                    delta,
                    partial: self.partial(),
                });
            }
        }
        if let Some(reasoning_details) = delta.get("reasoning_details").and_then(|v| v.as_array()) {
            for detail in reasoning_details {
                if is_encrypted_reasoning_detail(detail) {
                    let serialized = safe_json_stringify(detail);
                    if let Some(id) = detail.get("id").and_then(|v| v.as_str()) {
                        if let Some(&block_index) = self.tool_call_by_id.get(id) {
                            if let Some(ContentBlock::ToolCall(block)) =
                                self.message.content.get_mut(block_index)
                            {
                                block.thought_signature = Some(serialized.clone());
                            }
                        } else {
                            self.pending_reasoning_details
                                .insert(id.to_string(), serialized);
                        }
                    }
                }
            }
        }
        Ok(events)
    }

    fn ensure_text_block(&mut self, events: &mut Vec<AssistantMessageEvent>) -> usize {
        if let Some(index) = self.text_block {
            return index;
        }
        let index = self.message.content.len();
        self.message.content.push(ContentBlock::Text(TextContent {
            text: String::new(),
            text_signature: None,
        }));
        self.text_block = Some(index);
        events.push(AssistantMessageEvent::TextStart {
            content_index: index,
            partial: self.partial(),
        });
        index
    }

    fn ensure_thinking_block(
        &mut self,
        events: &mut Vec<AssistantMessageEvent>,
        thinking_signature: Option<String>,
    ) -> usize {
        if let Some(index) = self.thinking_block {
            return index;
        }
        let index = self.message.content.len();
        self.message
            .content
            .push(ContentBlock::Thinking(ThinkingContent {
                thinking: String::new(),
                thinking_signature,
                redacted: None,
            }));
        self.thinking_block = Some(index);
        events.push(AssistantMessageEvent::ThinkingStart {
            content_index: index,
            partial: self.partial(),
        });
        index
    }

    fn ensure_tool_call_block(
        &mut self,
        stream_index: Option<u64>,
        id: Option<&str>,
        name: Option<&str>,
        events: &mut Vec<AssistantMessageEvent>,
    ) -> usize {
        let existing = stream_index
            .and_then(|index| self.tool_call_by_index.get(&index).copied())
            .or_else(|| id.and_then(|id| self.tool_call_by_id.get(id).copied()));
        if let Some(block_index) = existing {
            if let Some(state) = self
                .tool_calls
                .iter_mut()
                .find(|state| state.block_index == block_index)
            {
                if state.stream_index.is_none() {
                    state.stream_index = stream_index;
                    if let Some(stream_index) = stream_index {
                        self.tool_call_by_index.insert(stream_index, block_index);
                    }
                }
            }
            if let Some(id) = id {
                self.tool_call_by_id.insert(id.to_string(), block_index);
            }
            if let Some(name) = name {
                if let Some(ContentBlock::ToolCall(block)) =
                    self.message.content.get_mut(block_index)
                {
                    if block.name.is_empty() {
                        block.name = name.to_string();
                    }
                }
                if let Some(state) = self
                    .tool_calls
                    .iter_mut()
                    .find(|state| state.block_index == block_index)
                {
                    if state.name.is_empty() {
                        state.name = name.to_string();
                    }
                }
            }
            self.apply_pending_reasoning_detail(block_index);
            return block_index;
        }
        let block_index = self.message.content.len();
        self.message.content.push(ContentBlock::ToolCall(ToolCall {
            id: id.unwrap_or_default().to_string(),
            name: name.unwrap_or_default().to_string(),
            arguments: serde_json::Value::Object(Default::default()),
            thought_signature: None,
        }));
        self.tool_calls.push(CcToolCallState {
            block_index,
            name: name.unwrap_or_default().to_string(),
            partial_args: String::new(),
            stream_index,
        });
        if let Some(stream_index) = stream_index {
            self.tool_call_by_index.insert(stream_index, block_index);
        }
        if let Some(id) = id {
            self.tool_call_by_id.insert(id.to_string(), block_index);
        }
        events.push(AssistantMessageEvent::ToolcallStart {
            content_index: block_index,
            partial: self.partial(),
        });
        self.apply_pending_reasoning_detail(block_index);
        block_index
    }

    fn apply_pending_reasoning_detail(&mut self, block_index: usize) {
        let id = match self.message.content.get(block_index) {
            Some(ContentBlock::ToolCall(block)) => block.id.clone(),
            _ => return,
        };
        if let Some(signature) = self.pending_reasoning_details.remove(&id) {
            if let Some(ContentBlock::ToolCall(block)) = self.message.content.get_mut(block_index) {
                block.thought_signature = Some(signature);
            }
        }
    }

    /// Finish all open blocks and emit the terminal event. Mirrors the JS
    /// post-loop checks: a missing `finish_reason` or an `error` stop reason
    /// becomes a terminal `Error` event (the JS throws, the catch pushes
    /// `error`), otherwise a `done` event.
    pub fn finish(&mut self) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
        let mut events = Vec::new();
        let indexes: Vec<usize> = (0..self.message.content.len()).collect();
        for block_index in indexes {
            events.extend(self.finish_block(block_index));
        }
        if !self.has_finish_reason {
            self.message.stop_reason = StopReason::Error;
            self.message.error_message = Some("Stream ended without finish_reason".to_string());
            events.push(AssistantMessageEvent::Error {
                reason: StopReason::Error,
                error: self.message.clone(),
            });
            return Ok(events);
        }
        if self.message.stop_reason == StopReason::Error
            || self.message.stop_reason == StopReason::Aborted
        {
            if self.message.error_message.is_none() {
                self.message.error_message =
                    Some("Provider returned an error stop reason".to_string());
            }
            events.push(AssistantMessageEvent::Error {
                reason: self.message.stop_reason,
                error: self.message.clone(),
            });
        } else {
            events.push(AssistantMessageEvent::Done {
                reason: self.message.stop_reason,
                message: self.message.clone(),
            });
        }
        Ok(events)
    }

    fn finish_block(&mut self, block_index: usize) -> Vec<AssistantMessageEvent> {
        let Some(block) = self.message.content.get(block_index).cloned() else {
            return Vec::new();
        };
        let event = match block {
            ContentBlock::Text(TextContent { text, .. }) => AssistantMessageEvent::TextEnd {
                content_index: block_index,
                content: text,
                partial: self.partial(),
            },
            ContentBlock::Thinking(ThinkingContent { thinking, .. }) => {
                AssistantMessageEvent::ThinkingEnd {
                    content_index: block_index,
                    content: thinking,
                    partial: self.partial(),
                }
            }
            ContentBlock::ToolCall(mut tool_call) => {
                if let Some(state) = self
                    .tool_calls
                    .iter()
                    .find(|state| state.block_index == block_index)
                {
                    tool_call.arguments = parse_streaming_json(&state.partial_args);
                    if let Some(ContentBlock::ToolCall(block)) =
                        self.message.content.get_mut(block_index)
                    {
                        block.arguments = tool_call.arguments.clone();
                    }
                }
                AssistantMessageEvent::ToolcallEnd {
                    content_index: block_index,
                    tool_call,
                    partial: self.partial(),
                }
            }
            ContentBlock::Image(_) => return Vec::new(),
        };
        vec![event]
    }
}

fn is_encrypted_reasoning_detail(detail: &serde_json::Value) -> bool {
    detail.get("type").and_then(|v| v.as_str()) == Some("reasoning.encrypted")
        && detail
            .get("id")
            .and_then(|v| v.as_str())
            .map(|id| !id.is_empty())
            .unwrap_or(false)
        && detail
            .get("data")
            .and_then(|v| v.as_str())
            .map(|data| !data.is_empty())
            .unwrap_or(false)
}

/// `parseChunkUsage` — normalized usage from a streaming chunk.
pub fn parse_chunk_usage(raw_usage: &serde_json::Value) -> Usage {
    let prompt_tokens = raw_usage
        .get("prompt_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_read_tokens = raw_usage
        .get("prompt_tokens_details")
        .and_then(|v| v.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .or_else(|| {
            raw_usage
                .get("prompt_cache_hit_tokens")
                .and_then(|v| v.as_u64())
        })
        .unwrap_or(0);
    let cache_write_tokens = raw_usage
        .get("prompt_tokens_details")
        .and_then(|v| v.get("cache_write_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let input = prompt_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    let output_tokens = raw_usage
        .get("completion_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let reasoning = raw_usage
        .get("completion_tokens_details")
        .and_then(|v| v.get("reasoning_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    Usage {
        input,
        output: output_tokens,
        cache_read: cache_read_tokens,
        cache_write: cache_write_tokens,
        cache_write_1h: None,
        reasoning: Some(reasoning),
        total_tokens: input + output_tokens + cache_read_tokens + cache_write_tokens,
        cost: aiden_core::UsageCost {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: 0.0,
        },
    }
}

pub struct StopReasonResult {
    pub stop_reason: StopReason,
    pub error_message: Option<String>,
}

/// `mapStopReason` for chat completions finish reasons.
pub fn map_stop_reason(reason: &str) -> StopReasonResult {
    match reason {
        "stop" | "end" => StopReasonResult {
            stop_reason: StopReason::Stop,
            error_message: None,
        },
        "length" => StopReasonResult {
            stop_reason: StopReason::Length,
            error_message: None,
        },
        "function_call" | "tool_calls" => StopReasonResult {
            stop_reason: StopReason::ToolUse,
            error_message: None,
        },
        "content_filter" => StopReasonResult {
            stop_reason: StopReason::Error,
            error_message: Some("Provider finish_reason: content_filter".to_string()),
        },
        "network_error" => StopReasonResult {
            stop_reason: StopReason::Error,
            error_message: Some("Provider finish_reason: network_error".to_string()),
        },
        other => StopReasonResult {
            stop_reason: StopReason::Error,
            error_message: Some(format!("Provider finish_reason: {other}")),
        },
    }
}

/// Parse a complete chat-completions SSE byte stream into normalized events.
pub fn parse_openai_completions_sse(
    provider: &str,
    model: &str,
    api: &str,
    input: &[u8],
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    parse_openai_completions_sse_with_now(provider, model, api, input, now_ms())
}

/// Fixture-friendly variant with a fixed timestamp.
pub fn parse_openai_completions_sse_with_now(
    provider: &str,
    model: &str,
    api: &str,
    input: &[u8],
    now: u64,
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    let mut accumulator = OpenAICompletionsAccumulator::with_now(provider, model, api, now);
    let mut events = Vec::new();
    for payload in data_payloads(input) {
        if payload == crate::json::SSE_DONE {
            continue;
        }
        let chunk: serde_json::Value = serde_json::from_str(&payload)?;
        events.extend(accumulator.step(&chunk)?);
    }
    events.extend(accumulator.finish()?);
    Ok(events)
}

// ===========================================================================
// OpenAICompletionsProvider (streaming)
// ===========================================================================

/// Provider for OpenAI-compatible `chat/completions` endpoints.
pub struct OpenAICompletionsProvider {
    base_url: String,
}

impl Default for OpenAICompletionsProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAICompletionsProvider {
    pub fn new() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
        }
    }

    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
        }
    }

    pub(crate) fn build_request(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<(reqwest::RequestBuilder, serde_json::Value), ProviderError> {
        let compat = detect_compat(&request.provider_id, &self.base_url, &request.model);
        let api_key =
            get_client_api_key(&request.provider_id, options.api_key.as_deref(), options)?;
        let body = build_openai_completions_params(request, options, &compat);
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let mut headers: HashMap<String, String> = request.model_headers.clone();
        if let Some(session_id) = options
            .session_id
            .as_deref()
            .or(request.session_id.as_deref())
        {
            if compat.send_session_affinity_headers {
                if compat.session_affinity_format == SessionAffinityFormat::Openrouter {
                    headers.insert("x-session-id".to_string(), session_id.to_string());
                } else {
                    if compat.session_affinity_format == SessionAffinityFormat::Openai {
                        headers.insert("session_id".to_string(), session_id.to_string());
                    }
                    headers.insert("x-client-request-id".to_string(), session_id.to_string());
                    headers.insert("x-session-affinity".to_string(), session_id.to_string());
                }
            }
        }
        for (name, value) in &options.headers {
            match value {
                Some(value) => {
                    headers.insert(name.clone(), value.clone());
                }
                None => {
                    headers.remove(name);
                }
            }
        }
        let mut builder = reqwest::Client::new()
            .post(url)
            .header("content-type", "application/json");
        if api_key != crate::catalog::PI_AUTH_COMPATIBILITY_TOKEN {
            builder = builder.header("Authorization", format!("Bearer {api_key}"));
        }
        for (name, value) in headers {
            builder = builder.header(name, value);
        }
        builder = builder.json(&body);
        if let Some(timeout_ms) = options.timeout_ms {
            builder = builder.timeout(std::time::Duration::from_millis(timeout_ms));
        }
        Ok((builder, body))
    }
}

/// `getClientApiKey` — allow keyless endpoints that carry their own auth
/// headers; otherwise require the API key.
pub fn get_client_api_key(
    provider: &str,
    api_key: Option<&str>,
    options: &StreamOptions,
) -> Result<String, ProviderError> {
    if let Some(api_key) = api_key {
        if !api_key.is_empty() {
            return Ok(api_key.to_string());
        }
    }
    let has_auth_header = options.headers.iter().any(|(name, value)| {
        let lower = name.to_lowercase();
        (lower == "authorization" || lower == "cf-aig-authorization")
            && value
                .as_deref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
    });
    if has_auth_header {
        return Ok("unused".to_string());
    }
    Err(ProviderError::Auth(format!(
        "No API key for provider: {provider}"
    )))
}

type PayloadStream2 = std::pin::Pin<Box<dyn Stream<Item = Result<String, ProviderError>> + Send>>;

// The Streaming variant carries the payload stream + accumulator; boxing the
// payload keeps the enum reasonably sized.
#[allow(clippy::large_enum_variant)]
enum CcDriveState {
    Idle(Option<reqwest::RequestBuilder>),
    Streaming {
        payload: PayloadStream2,
        accumulator: OpenAICompletionsAccumulator,
        pending: std::collections::VecDeque<Result<AssistantMessageEvent, ProviderError>>,
        finished: bool,
    },
    Done,
}

impl Provider for OpenAICompletionsProvider {
    fn info(&self) -> crate::ProviderInfo {
        crate::ProviderInfo {
            id: "openai-completions".to_string(),
            label: "OpenAI-compatible (chat completions)".to_string(),
        }
    }

    fn stream_simple(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<EventStream, ProviderError> {
        let (request_builder, _body) = self.build_request(request, options)?;
        let provider_id = request.provider_id.clone();
        let model = request.model.clone();
        let api = request.api.as_str().to_string();
        let stream =
            futures::stream::unfold(CcDriveState::Idle(Some(request_builder)), move |state| {
                drive_completions(state, provider_id.clone(), model.clone(), api.clone())
            });
        Ok(Box::pin(stream))
    }
}

async fn drive_completions(
    mut state: CcDriveState,
    provider_id: String,
    model: String,
    api: String,
) -> Option<(Result<AssistantMessageEvent, ProviderError>, CcDriveState)> {
    loop {
        state = match state {
            CcDriveState::Idle(Some(request_builder)) => match request_builder.send().await {
                Ok(response) if response.status().is_success() => CcDriveState::Streaming {
                    payload: Box::pin(sse_payload_stream(response)),
                    accumulator: OpenAICompletionsAccumulator::new(&provider_id, &model, &api),
                    pending: Default::default(),
                    finished: false,
                },
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_default();
                    return Some((
                        Err(ProviderError::from_http_status(status, body)),
                        CcDriveState::Done,
                    ));
                }
                Err(err) => {
                    return Some((
                        Err(ProviderError::Stream(err.to_string())),
                        CcDriveState::Done,
                    ))
                }
            },
            CcDriveState::Idle(None) => return None,
            CcDriveState::Streaming {
                mut payload,
                mut accumulator,
                mut pending,
                finished,
            } => {
                if finished {
                    if let Some(item) = pending.pop_front() {
                        return Some((
                            item,
                            CcDriveState::Streaming {
                                payload,
                                accumulator,
                                pending,
                                finished,
                            },
                        ));
                    }
                    return None;
                }
                match futures::StreamExt::next(&mut payload).await {
                    Some(Ok(payload_text)) if payload_text != crate::json::SSE_DONE => {
                        let chunk: serde_json::Value = match serde_json::from_str(&payload_text) {
                            Ok(chunk) => chunk,
                            Err(err) => {
                                return Some((Err(ProviderError::Json(err)), CcDriveState::Done))
                            }
                        };
                        match accumulator.step(&chunk) {
                            Ok(events) => {
                                pending.extend(events.into_iter().map(Ok));
                            }
                            Err(err) => {
                                return Some((Err(err), CcDriveState::Done));
                            }
                        }
                        if let Some(item) = pending.pop_front() {
                            return Some((
                                item,
                                CcDriveState::Streaming {
                                    payload,
                                    accumulator,
                                    pending,
                                    finished: false,
                                },
                            ));
                        }
                        CcDriveState::Streaming {
                            payload,
                            accumulator,
                            pending,
                            finished: false,
                        }
                    }
                    Some(Ok(_)) => CcDriveState::Streaming {
                        payload,
                        accumulator,
                        pending,
                        finished: false,
                    },
                    Some(Err(err)) => return Some((Err(err), CcDriveState::Done)),
                    None => {
                        match accumulator.finish() {
                            Ok(events) => {
                                pending.extend(events.into_iter().map(Ok));
                            }
                            Err(err) => {
                                return Some((Err(err), CcDriveState::Done));
                            }
                        }
                        CcDriveState::Streaming {
                            payload,
                            accumulator,
                            pending,
                            finished: true,
                        }
                    }
                }
            }
            CcDriveState::Done => return None,
        };
    }
}

// ===========================================================================
// Tests (fixture SSE, no network)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ApiFamily;
    use aiden_core::{ContentBlock, TextContent, ToolDef, UserMessage};

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

    fn request(model: &str) -> StreamRequest {
        StreamRequest {
            provider_id: "custom:lmstudio".to_string(),
            api: ApiFamily::OpenAICompletions,
            model: model.to_string(),
            base_url: "http://127.0.0.1:1234/v1".to_string(),
            reasoning: true,
            thinking_level_map: None,
            force_adaptive_thinking: false,
            vision: true,
            context_window: 128_000,
            max_tokens_limit: 8192,
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text("hello".to_string()),
                timestamp: 1,
            })],
            system_prompt: Some("You are Aiden.".to_string()),
            max_tokens: Some(4096),
            thinking_level: Some(ThinkingLevel::High),
            tools: vec![ToolDef {
                name: "grep".into(),
                description: "Search files".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
            temperature: Some(0.7),
            session_id: None,
            reasoning_summary: None,
            text_verbosity: None,
            service_tier: None,
            tool_choice: None,
            model_headers: Default::default(),
        }
    }

    #[test]
    fn text_deltas_accumulate_with_usage_and_finish() {
        let fixture = br#"data: {"id":"chatcmpl_1","model":"llama-3.1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl_1","model":"llama-3.1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl_1","model":"llama-3.1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":1}}}

data: [DONE]
"#;
        let events = parse_openai_completions_sse_with_now(
            "custom:lmstudio",
            "llama-3.1-8b",
            "openai-completions",
            fixture,
            5,
        )
        .unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            ["text_start", "text_delta", "text_delta", "text_end", "done"]
        );
        let AssistantMessageEvent::TextEnd { content, .. } = &events[3] else {
            panic!();
        };
        assert_eq!(content, "Hello world");
        let AssistantMessageEvent::Done { reason, message } = &events[4] else {
            panic!();
        };
        assert_eq!(*reason, StopReason::Stop);
        assert_eq!(message.response_id.as_deref(), Some("chatcmpl_1"));
        assert_eq!(message.response_model.as_deref(), Some("llama-3.1"));
        assert_eq!(message.usage.input, 8); // prompt 12 - cached 4
        assert_eq!(message.usage.cache_read, 4);
        assert_eq!(message.usage.output, 3);
        assert_eq!(message.usage.reasoning, Some(1));
        assert_eq!(message.usage.total_tokens, 15);
    }

    #[test]
    fn reasoning_fields_map_to_thinking_blocks() {
        let fixture =
            br#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me think"}}]}

data: {"choices":[{"index":0,"delta":{"reasoning_content":" about it"}}]}

data: {"choices":[{"index":0,"delta":{"content":"Answer"}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
"#;
        let events = parse_openai_completions_sse_with_now(
            "custom:lmstudio",
            "m",
            "openai-completions",
            fixture,
            5,
        )
        .unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            [
                "thinking_start",
                "thinking_delta",
                "thinking_delta",
                "text_start",
                "text_delta",
                "thinking_end",
                "text_end",
                "done",
            ]
        );
        let AssistantMessageEvent::ThinkingEnd { content, .. } = &events[5] else {
            panic!();
        };
        assert_eq!(content, "Let me think about it");
        let AssistantMessageEvent::Done { message, .. } = &events[7] else {
            panic!();
        };
        let ContentBlock::Thinking(thinking) = &message.content[0] else {
            panic!();
        };
        // The thinking signature records the wire field name.
        assert_eq!(
            thinking.thinking_signature.as_deref(),
            Some("reasoning_content")
        );
    }

    #[test]
    fn tool_calls_are_assembled_from_partial_args() {
        let fixture = br#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"grep","arguments":""}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pattern\":"}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"foo\"}"}}]}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
"#;
        let events = parse_openai_completions_sse_with_now(
            "custom:lmstudio",
            "m",
            "openai-completions",
            fixture,
            5,
        )
        .unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            [
                "toolcall_start",
                "toolcall_delta",
                "toolcall_delta",
                "toolcall_delta",
                "toolcall_end",
                "done"
            ]
        );
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[4] else {
            panic!();
        };
        assert_eq!(tool_call.id, "call_1");
        assert_eq!(tool_call.name, "grep");
        assert_eq!(tool_call.arguments, serde_json::json!({"pattern": "foo"}));
        let AssistantMessageEvent::Done { reason, message } = &events[5] else {
            panic!();
        };
        assert_eq!(*reason, StopReason::ToolUse);
        assert!(matches!(message.content[0], ContentBlock::ToolCall(_)));
    }

    #[test]
    fn tool_calls_without_index_are_merged_by_id() {
        let fixture = br#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"grep","arguments":"{\"a\":"}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"arguments":"1}"}}]}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
"#;
        let events = parse_openai_completions_sse_with_now(
            "custom:lmstudio",
            "m",
            "openai-completions",
            fixture,
            5,
        )
        .unwrap();
        assert_eq!(events.len(), 5);
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[3] else {
            panic!();
        };
        assert_eq!(tool_call.arguments, serde_json::json!({"a": 1}));
    }

    #[test]
    fn encrypted_reasoning_details_attach_to_tool_calls() {
        let fixture = br#"data: {"choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","id":"call_1","data":"encrypted-blob"}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"grep","arguments":"{}"}}]}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
"#;
        let events = parse_openai_completions_sse_with_now(
            "custom:lmstudio",
            "m",
            "openai-completions",
            fixture,
            5,
        )
        .unwrap();
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[2] else {
            panic!();
        };
        let signature = tool_call
            .thought_signature
            .as_deref()
            .expect("thought signature");
        let parsed: serde_json::Value = serde_json::from_str(signature).unwrap();
        assert_eq!(parsed["type"], "reasoning.encrypted");
        assert_eq!(parsed["id"], "call_1");
    }

    #[test]
    fn content_filter_finish_is_a_terminal_error_event() {
        let fixture = br#"data: {"choices":[{"index":0,"delta":{"content":"nope"}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}
"#;
        let events = parse_openai_completions_sse_with_now(
            "custom:lmstudio",
            "m",
            "openai-completions",
            fixture,
            5,
        )
        .unwrap();
        let last = events.last().unwrap();
        let AssistantMessageEvent::Error { reason, error } = last else {
            panic!("expected error event, got {last:?}");
        };
        assert_eq!(*reason, StopReason::Error);
        assert_eq!(
            error.error_message.as_deref(),
            Some("Provider finish_reason: content_filter")
        );
    }

    #[test]
    fn missing_finish_reason_is_a_terminal_error_event() {
        let fixture = br#"data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}
"#;
        let events = parse_openai_completions_sse_with_now(
            "custom:lmstudio",
            "m",
            "openai-completions",
            fixture,
            5,
        )
        .unwrap();
        let AssistantMessageEvent::Error { reason, .. } = events.last().unwrap() else {
            panic!("expected error event");
        };
        assert_eq!(*reason, StopReason::Error);
    }

    #[test]
    fn malformed_frame_is_an_error_not_a_panic() {
        let fixture = br#"data: {broken
"#;
        let result = parse_openai_completions_sse_with_now(
            "custom:lmstudio",
            "m",
            "openai-completions",
            fixture,
            5,
        );
        assert!(result.is_err());
    }

    #[test]
    fn params_build_with_system_developer_and_tools() {
        let request = request("llama-3.1");
        let compat = detect_compat(&request.provider_id, &request.base_url, &request.model);
        let options = StreamOptions {
            api_key: Some("key".into()),
            temperature: Some(0.7),
            ..Default::default()
        };
        let params = build_openai_completions_params(&request, &options, &compat);
        assert_eq!(params["model"], "llama-3.1");
        assert_eq!(params["stream"], true);
        assert_eq!(params["stream_options"]["include_usage"], true);
        assert_eq!(params["messages"][0]["role"], "developer");
        assert_eq!(params["messages"][0]["content"], "You are Aiden.");
        assert_eq!(params["messages"][1]["role"], "user");
        assert_eq!(params["max_completion_tokens"], 4096);
        assert_eq!(params["temperature"], 0.7);
        assert_eq!(params["tools"][0]["function"]["name"], "grep");
        // High thinking on a plain openai-format model → reasoning_effort.
        assert_eq!(params["reasoning_effort"], "high");
    }

    #[test]
    fn deepseek_compat_uses_thinking_object_and_max_tokens_field() {
        let mut request = request("deepseek-reasoner");
        request.provider_id = "custom:deepseek".to_string();
        request.base_url = "https://api.deepseek.com".to_string();
        let compat = detect_compat(&request.provider_id, &request.base_url, &request.model);
        assert_eq!(compat.thinking_format, ThinkingFormat::Deepseek);
        assert_eq!(compat.max_tokens_field, MaxTokensField::MaxCompletionTokens);
        let params = build_openai_completions_params(&request, &StreamOptions::default(), &compat);
        assert_eq!(params["thinking"], serde_json::json!({"type": "enabled"}));
        assert!(params.get("max_completion_tokens").is_some());
    }

    #[test]
    fn deepseek_assistant_messages_carry_empty_reasoning_content() {
        let request = StreamRequest {
            provider_id: "custom:deepseek".to_string(),
            base_url: "https://api.deepseek.com".to_string(),
            messages: vec![Message::Assistant(AssistantMessage {
                content: vec![ContentBlock::Text(TextContent {
                    text: "done".into(),
                    text_signature: None,
                })],
                api: "openai-completions".into(),
                provider: "custom:deepseek".into(),
                model: "deepseek-reasoner".into(),
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
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: 2,
            })],
            ..request("deepseek-reasoner")
        };
        let compat = detect_compat(&request.provider_id, &request.base_url, &request.model);
        let messages =
            convert_openai_completions_messages(&request, &compat, request.messages.clone(), 1);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "done");
        assert_eq!(messages[1]["reasoning_content"], "");
    }

    #[test]
    fn lmstudio_compat_is_plain_openai() {
        let request = request("llama-3.1");
        let compat = detect_compat(&request.provider_id, &request.base_url, &request.model);
        assert_eq!(compat.thinking_format, ThinkingFormat::Openai);
        assert!(compat.supports_developer_role);
        assert!(compat.supports_store);
        assert_eq!(
            compat.session_affinity_format,
            SessionAffinityFormat::Openai
        );
    }

    #[test]
    fn openrouter_compat_uses_nested_reasoning() {
        let mut request = request("anthropic/claude-sonnet-5");
        request.provider_id = "custom:openrouter".to_string();
        request.base_url = "https://openrouter.ai/api/v1".to_string();
        let compat = detect_compat(&request.provider_id, &request.base_url, &request.model);
        assert_eq!(compat.thinking_format, ThinkingFormat::Openrouter);
        let params = build_openai_completions_params(&request, &StreamOptions::default(), &compat);
        assert_eq!(params["reasoning"]["effort"], "high");
        assert_eq!(
            compat.session_affinity_format,
            SessionAffinityFormat::Openrouter
        );
    }
}
