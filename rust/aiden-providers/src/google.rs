//! Google Generative AI transport (`:streamGenerateContent?alt=sse`).
//!
//! Port of pi-ai `api/google-generative-ai.js` + `api/google-shared.js` and
//! Aiden's `renderer/shared/google-thinking.ts`. The pure part
//! ([`GoogleAccumulator`], [`parse_google_sse`], message/tool conversion,
//! thinking-config selection) is fixture-tested; the live provider streams the
//! same parser over `reqwest` byte streams.

use std::collections::HashMap;

use aiden_core::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, Message, StopReason, TextContent,
    ThinkingContent, ToolCall, Usage, UserContent,
};
use futures::Stream;

use crate::json::safe_json_stringify;
use crate::sse::data_payloads;
use crate::transform::transform_messages;
use crate::{
    now_ms, sse_payload_stream, EventStream, Provider, ProviderError, StreamOptions, StreamRequest,
    ThinkingLevel,
};

/// Aiden's Google provider id and defaults (`google-provider.ts`).
pub const GOOGLE_PROVIDER_ID: &str = "google";
pub const GOOGLE_PROVIDER_LABEL: &str = "Google Gemini";
pub const GOOGLE_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const GOOGLE_DEFAULT_MODEL: &str = "gemini-2.5-flash";
/// Legacy preset id remapped during provider-identity migration.
pub const LEGACY_GEMINI_PROVIDER_ID: &str = "gemini";

/// Aiden's exposed Google thinking levels (`google-thinking.ts`).
pub const GOOGLE_THINKING_LEVELS: &[&str] = &["off", "low", "medium", "high"];
pub const DEFAULT_GOOGLE_THINKING_LEVEL: &str = "off";

/// Whether a model supports each Aiden Google thinking level.
pub fn google_thinking_levels_for_model(
    reasoning: Option<bool>,
    thinking_level_map: Option<&HashMap<String, Option<String>>>,
) -> Vec<String> {
    if reasoning != Some(true) {
        return Vec::new();
    }
    GOOGLE_THINKING_LEVELS
        .iter()
        .filter(|level| {
            if **level == "off" {
                return true;
            }
            thinking_level_map
                .and_then(|map| map.get(**level))
                .map(|mapped| mapped.is_some())
                .unwrap_or(true)
        })
        .map(|level| level.to_string())
        .collect()
}

/// Whether the model can fully disable thinking (`off` not nulled).
pub fn google_thinking_can_disable(
    reasoning: Option<bool>,
    thinking_level_map: Option<&HashMap<String, Option<String>>>,
) -> bool {
    reasoning == Some(true)
        && thinking_level_map
            .and_then(|map| map.get("off"))
            .map(|mapped| mapped.is_some())
            .unwrap_or(true)
}

/// `normalizeGoogleThinkingLevel` — fall back to the first supported level.
pub fn normalize_google_thinking_level(levels: &[String], value: Option<&str>) -> String {
    if let Some(value) = value {
        if GOOGLE_THINKING_LEVELS.contains(&value) && levels.iter().any(|l| l == value) {
            return value.to_string();
        }
    }
    levels
        .first()
        .cloned()
        .unwrap_or_else(|| DEFAULT_GOOGLE_THINKING_LEVEL.to_string())
}

/// Parse a device-local Google thinking preference map (bounded, validated).
pub fn parse_google_thinking_preferences(
    value: serde_json::Value,
) -> Result<HashMap<String, String>, ProviderError> {
    const MAX_PREFERENCES: usize = 256;
    const MAX_MODEL_ID_CHARS: usize = 256;
    let object = value
        .as_object()
        .ok_or_else(|| ProviderError::Config("Invalid Google thinking preferences.".into()))?;
    if object.len() > MAX_PREFERENCES {
        return Err(ProviderError::Config(
            "Too many Google thinking preferences.".into(),
        ));
    }
    let mut parsed = HashMap::new();
    for (model_id, level) in object {
        if model_id.is_empty() || model_id.chars().count() > MAX_MODEL_ID_CHARS {
            return Err(ProviderError::Config(
                "Invalid Google thinking preference.".into(),
            ));
        }
        let Some(level) = level.as_str() else {
            return Err(ProviderError::Config(
                "Invalid Google thinking preference.".into(),
            ));
        };
        if !GOOGLE_THINKING_LEVELS.contains(&level) {
            return Err(ProviderError::Config(
                "Invalid Google thinking preference.".into(),
            ));
        }
        parsed.insert(model_id.clone(), level.to_string());
    }
    Ok(parsed)
}

/// `mergeGoogleThinkingPreference` — replace one model's level, bounded.
pub fn merge_google_thinking_preference(
    current: serde_json::Value,
    model_id: &str,
    level: &str,
) -> Result<HashMap<String, String>, ProviderError> {
    const MAX_PREFERENCES: usize = 256;
    const MAX_MODEL_ID_CHARS: usize = 256;
    let mut entries: Vec<(String, String)> = Vec::new();
    if let Some(object) = current.as_object() {
        for (id, value) in object {
            let Some(value) = value.as_str() else {
                continue;
            };
            if id.is_empty()
                || id.chars().count() > MAX_MODEL_ID_CHARS
                || id == model_id
                || !GOOGLE_THINKING_LEVELS.contains(&value)
            {
                continue;
            }
            entries.push((id.clone(), value.to_string()));
        }
    }
    if entries.len() >= MAX_PREFERENCES {
        return Err(ProviderError::Config(
            "Too many Google thinking preferences.".into(),
        ));
    }
    entries.push((model_id.to_string(), level.to_string()));
    Ok(entries.into_iter().collect())
}

// ===========================================================================
// Message / tool conversion (google-shared.js)
// ===========================================================================

/// Models that require explicit tool-call ids in function calls.
fn requires_tool_call_id(model_id: &str) -> bool {
    model_id.starts_with("claude-") || model_id.starts_with("gpt-oss-")
}

fn get_gemini_major_version(model_id: &str) -> Option<u32> {
    let lower = model_id.to_lowercase();
    let rest = lower.strip_prefix("gemini")?;
    let rest = rest.strip_prefix("-live").unwrap_or(rest);
    let rest = rest.strip_prefix('-')?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

fn supports_multimodal_function_response(model_id: &str) -> bool {
    match get_gemini_major_version(model_id) {
        Some(version) => version >= 3,
        None => true,
    }
}

fn resolve_thought_signature(
    same_provider_and_model: bool,
    signature: Option<&str>,
) -> Option<String> {
    if !same_provider_and_model {
        return None;
    }
    let signature = signature?;
    if signature.is_empty() || signature.len() % 4 != 0 {
        return None;
    }
    if !signature
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
    {
        return None;
    }
    Some(signature.to_string())
}

/// Port of `convertMessages` (google-shared.js): `Message[]` → Gemini
/// `Content[]`. `now` stamps nothing here (Google has no synthetic results in
/// this path) but is threaded for parity.
pub fn convert_google_messages(
    request: &StreamRequest,
    messages: Vec<Message>,
    now: u64,
) -> Vec<serde_json::Value> {
    let model_id = request.model.clone();
    let needs_id = requires_tool_call_id(&model_id);
    let normalize_tool_call_id = move |id: &str, _provider: &str, _api: &str| -> String {
        if !needs_id {
            return id.to_string();
        }
        let sanitized: String = id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        sanitized.chars().take(64).collect()
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

    let mut contents: Vec<serde_json::Value> = Vec::new();
    for message in transformed {
        match message {
            Message::User(user) => match user.content {
                UserContent::Text(text) => contents.push(serde_json::json!({
                    "role": "user",
                    "parts": [{ "text": text }],
                })),
                UserContent::Blocks(blocks) => {
                    let parts: Vec<serde_json::Value> = blocks
                        .into_iter()
                        .map(|block| match block {
                            aiden_core::UserBlock::Text(text) => {
                                serde_json::json!({ "text": text.text })
                            }
                            aiden_core::UserBlock::Image(image) => serde_json::json!({
                                "inlineData": { "mimeType": image.mime_type, "data": image.data }
                            }),
                        })
                        .collect();
                    if parts.is_empty() {
                        continue;
                    }
                    contents.push(serde_json::json!({ "role": "user", "parts": parts }));
                }
            },
            Message::Assistant(assistant) => {
                let same_provider_and_model =
                    assistant.provider == request.provider_id && assistant.model == request.model;
                let mut parts: Vec<serde_json::Value> = Vec::new();
                for block in assistant.content {
                    match block {
                        ContentBlock::Text(text) => {
                            if text.text.trim().is_empty() {
                                continue;
                            }
                            let signature = resolve_thought_signature(
                                same_provider_and_model,
                                text.text_signature.as_deref(),
                            );
                            let mut part = serde_json::json!({ "text": text.text });
                            if let Some(signature) = signature {
                                part["thoughtSignature"] = serde_json::Value::String(signature);
                            }
                            parts.push(part);
                        }
                        ContentBlock::Thinking(thinking) => {
                            if thinking.thinking.trim().is_empty() {
                                continue;
                            }
                            if same_provider_and_model {
                                let signature = resolve_thought_signature(
                                    true,
                                    thinking.thinking_signature.as_deref(),
                                );
                                let mut part = serde_json::json!({
                                    "thought": true,
                                    "text": thinking.thinking,
                                });
                                if let Some(signature) = signature {
                                    part["thoughtSignature"] = serde_json::Value::String(signature);
                                }
                                parts.push(part);
                            } else {
                                parts.push(serde_json::json!({ "text": thinking.thinking }));
                            }
                        }
                        ContentBlock::ToolCall(tool_call) => {
                            let signature = resolve_thought_signature(
                                same_provider_and_model,
                                tool_call.thought_signature.as_deref(),
                            );
                            let mut function_call = serde_json::json!({
                                "name": tool_call.name,
                                "args": tool_call.arguments,
                            });
                            if requires_tool_call_id(&request.model) {
                                function_call["id"] = serde_json::Value::String(tool_call.id);
                            }
                            let mut part = serde_json::json!({ "functionCall": function_call });
                            if let Some(signature) = signature {
                                part["thoughtSignature"] = serde_json::Value::String(signature);
                            }
                            parts.push(part);
                        }
                        ContentBlock::Image(_) => {}
                    }
                }
                if parts.is_empty() {
                    continue;
                }
                contents.push(serde_json::json!({ "role": "model", "parts": parts }));
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
                let image_content: Vec<&aiden_core::ImageContent> = if request.vision {
                    result
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Image(image) => Some(image),
                            _ => None,
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                let has_text = !text_result.is_empty();
                let has_images = !image_content.is_empty();
                let model_supports_multimodal =
                    supports_multimodal_function_response(&request.model);
                let response_value = if has_text {
                    text_result.clone()
                } else if has_images {
                    "(see attached image)".to_string()
                } else {
                    String::new()
                };
                let image_parts: Vec<serde_json::Value> = image_content
                    .iter()
                    .map(|image| {
                        serde_json::json!({
                            "inlineData": { "mimeType": image.mime_type, "data": image.data }
                        })
                    })
                    .collect();
                let include_id = requires_tool_call_id(&request.model);
                let mut function_response = serde_json::json!({
                    "name": result.tool_name,
                    "response": if result.is_error {
                        serde_json::json!({ "error": response_value })
                    } else {
                        serde_json::json!({ "output": response_value })
                    },
                });
                if has_images && model_supports_multimodal {
                    function_response["parts"] = serde_json::Value::Array(image_parts.clone());
                }
                if include_id {
                    function_response["id"] = serde_json::Value::String(result.tool_call_id);
                }
                let function_response_part =
                    serde_json::json!({ "functionResponse": function_response });

                let merged = contents.last_mut().map(|last| {
                    if last["role"] == "user" {
                        if let Some(parts) = last["parts"].as_array_mut() {
                            if parts
                                .iter()
                                .any(|part| part.get("functionResponse").is_some())
                            {
                                parts.push(function_response_part.clone());
                                return true;
                            }
                        }
                    }
                    false
                });
                if merged != Some(true) {
                    contents.push(serde_json::json!({
                        "role": "user",
                        "parts": [function_response_part],
                    }));
                }
                if has_images && !model_supports_multimodal {
                    let mut image_message_parts =
                        vec![serde_json::json!({ "text": "Tool result image:" })];
                    image_message_parts.extend(image_parts);
                    contents.push(serde_json::json!({
                        "role": "user",
                        "parts": image_message_parts,
                    }));
                }
            }
        }
    }
    contents
}

/// Port of `convertTools` — `functionDeclarations` with `parametersJsonSchema`.
pub fn convert_google_tools(tools: &[aiden_core::ToolDef]) -> Option<serde_json::Value> {
    if tools.is_empty() {
        return None;
    }
    Some(serde_json::json!([{
        "functionDeclarations": tools.iter().map(|tool| serde_json::json!({
            "name": tool.name,
            "description": tool.description,
            "parametersJsonSchema": tool.parameters,
        })).collect::<Vec<_>>(),
    }]))
}

/// Map a Gemini finish-reason wire string to a normalized stop reason.
pub fn map_google_stop_reason(reason: &str) -> Result<StopReason, ProviderError> {
    match reason {
        "STOP" => Ok(StopReason::Stop),
        "MAX_TOKENS" => Ok(StopReason::Length),
        "BLOCKLIST"
        | "PROHIBITED_CONTENT"
        | "SPII"
        | "SAFETY"
        | "IMAGE_SAFETY"
        | "IMAGE_PROHIBITED_CONTENT"
        | "IMAGE_RECITATION"
        | "IMAGE_OTHER"
        | "RECITATION"
        | "FINISH_REASON_UNSPECIFIED"
        | "OTHER"
        | "LANGUAGE"
        | "MALFORMED_FUNCTION_CALL"
        | "UNEXPECTED_TOOL_CALL"
        | "NO_IMAGE" => Ok(StopReason::Error),
        other => Err(ProviderError::Protocol(format!(
            "unhandled Google finish reason `{other}`"
        ))),
    }
}

// ===========================================================================
// Thinking configuration (google-generative-ai.js)
// ===========================================================================

fn is_gemma4_model(model_id: &str) -> bool {
    let lower = model_id.to_lowercase();
    lower.contains("gemma-4") || lower.contains("gemma4")
}

fn is_gemini3_pro_model(model_id: &str) -> bool {
    let lower = model_id.to_lowercase();
    let Some(rest) = lower.strip_prefix("gemini-3") else {
        return false;
    };
    let rest = match rest.strip_prefix('.') {
        Some(minor) => match minor.strip_prefix(|c: char| c.is_ascii_digit()) {
            Some(minor) => minor,
            None => return false,
        },
        None => rest,
    };
    rest.starts_with("-pro")
}

fn is_gemini3_flash_model(model_id: &str) -> bool {
    let lower = model_id.to_lowercase();
    if lower == "gemini-flash-latest" || lower == "gemini-flash-lite-latest" {
        return true;
    }
    let Some(rest) = lower.strip_prefix("gemini-3") else {
        return false;
    };
    let rest = match rest.strip_prefix('.') {
        Some(minor) => match minor.strip_prefix(|c: char| c.is_ascii_digit()) {
            Some(minor) => minor,
            None => return false,
        },
        None => rest,
    };
    rest.starts_with("-flash")
}

fn get_disabled_thinking_config(model_id: &str) -> serde_json::Value {
    if is_gemini3_pro_model(model_id) {
        serde_json::json!({ "thinkingLevel": "LOW" })
    } else if is_gemini3_flash_model(model_id) || is_gemma4_model(model_id) {
        serde_json::json!({ "thinkingLevel": "MINIMAL" })
    } else {
        serde_json::json!({ "thinkingBudget": 0 })
    }
}

fn get_thinking_level(effort: ThinkingLevel, model_id: &str) -> &'static str {
    if is_gemini3_pro_model(model_id) {
        return match effort {
            ThinkingLevel::Minimal | ThinkingLevel::Low => "LOW",
            ThinkingLevel::Medium | ThinkingLevel::High => "HIGH",
            _ => "LOW",
        };
    }
    if is_gemma4_model(model_id) {
        return match effort {
            ThinkingLevel::Minimal | ThinkingLevel::Low => "MINIMAL",
            ThinkingLevel::Medium | ThinkingLevel::High => "HIGH",
            _ => "MINIMAL",
        };
    }
    match effort {
        ThinkingLevel::Minimal => "MINIMAL",
        ThinkingLevel::Low => "LOW",
        ThinkingLevel::Medium => "MEDIUM",
        ThinkingLevel::High => "HIGH",
        _ => "MEDIUM",
    }
}

fn get_google_budget(
    model_id: &str,
    effort: ThinkingLevel,
    custom_budgets: Option<&HashMap<String, u32>>,
) -> i64 {
    if let Some(budget) = custom_budgets.and_then(|map| map.get(effort.as_str())) {
        return i64::from(*budget);
    }
    let budgets: &[(&str, i64)] = if model_id.contains("2.5-pro") {
        &[
            ("minimal", 128),
            ("low", 2048),
            ("medium", 8192),
            ("high", 32768),
        ]
    } else if model_id.contains("2.5-flash-lite") {
        &[
            ("minimal", 512),
            ("low", 2048),
            ("medium", 8192),
            ("high", 24576),
        ]
    } else if model_id.contains("2.5-flash") {
        &[
            ("minimal", 128),
            ("low", 2048),
            ("medium", 8192),
            ("high", 24576),
        ]
    } else {
        &[]
    };
    budgets
        .iter()
        .find(|(name, _)| *name == effort.as_str())
        .map(|(_, budget)| *budget)
        .unwrap_or(-1)
}

/// Resolve the `thinkingConfig` for a request from the thinking level and
/// model metadata (port of `streamSimple`'s thinking branch + `buildParams`).
pub fn resolve_google_thinking_config(
    request: &StreamRequest,
    options: &StreamOptions,
) -> Option<serde_json::Value> {
    let reasoning = request.reasoning;
    let thinking = request.thinking_level;
    match thinking {
        None => Some(serde_json::json!({ "enabled": false })),
        Some(level) => {
            let clamped =
                crate::clamp_thinking_level(reasoning, request.thinking_level_map.as_ref(), level);
            let effort = clamped.unwrap_or(ThinkingLevel::High).clamped_for_budget();
            let model_id = request.model.clone();
            if is_gemini3_pro_model(&model_id)
                || is_gemini3_flash_model(&model_id)
                || is_gemma4_model(&model_id)
            {
                Some(serde_json::json!({
                    "enabled": true,
                    "level": get_thinking_level(effort, &model_id),
                }))
            } else {
                Some(serde_json::json!({
                    "enabled": true,
                    "budgetTokens": get_google_budget(&model_id, effort, options.thinking_budgets.as_ref()),
                }))
            }
        }
    }
}

// ===========================================================================
// Request building (buildParams)
// ===========================================================================

/// Port of `buildParams`: contents + config flattened for the REST body.
pub fn build_google_request(
    request: &StreamRequest,
    options: &StreamOptions,
    thinking_config: Option<&serde_json::Value>,
) -> serde_json::Value {
    let contents = convert_google_messages(request, request.messages.clone(), now_ms());
    let mut generation_config = serde_json::Map::new();
    if let Some(temperature) = options.temperature {
        generation_config.insert("temperature".into(), serde_json::json!(temperature));
    }
    if let Some(max_tokens) = request.max_tokens {
        generation_config.insert("maxOutputTokens".into(), serde_json::json!(max_tokens));
    }
    let mut config = serde_json::Map::new();
    if !generation_config.is_empty() {
        config.insert(
            "generationConfig".into(),
            serde_json::Value::Object(generation_config),
        );
    }
    if let Some(system_prompt) = &request.system_prompt {
        config.insert("systemInstruction".into(), serde_json::json!(system_prompt));
    }
    if let Some(tools) = convert_google_tools(&request.tools) {
        config.insert("tools".into(), tools);
    }
    if request.tools.is_empty() || options.tool_choice.is_none() {
        // `toolConfig` is only emitted when tools + toolChoice are present.
    } else {
        let mode = match options.tool_choice.as_deref() {
            Some("none") => "NONE",
            Some("any") => "ANY",
            _ => "AUTO",
        };
        config.insert(
            "toolConfig".into(),
            serde_json::json!({ "functionCallingConfig": { "mode": mode } }),
        );
    }
    if request.reasoning {
        if let Some(thinking_config) = thinking_config {
            if thinking_config.get("enabled") == Some(&serde_json::Value::Bool(true)) {
                let mut wire = serde_json::Map::new();
                wire.insert("includeThoughts".into(), serde_json::Value::Bool(true));
                if let Some(level) = thinking_config.get("level") {
                    wire.insert("thinkingLevel".into(), level.clone());
                } else if let Some(budget) = thinking_config.get("budgetTokens") {
                    wire.insert("thinkingBudget".into(), budget.clone());
                }
                config.insert("thinkingConfig".into(), serde_json::Value::Object(wire));
            } else if thinking_config.get("enabled") == Some(&serde_json::Value::Bool(false)) {
                config.insert(
                    "thinkingConfig".into(),
                    get_disabled_thinking_config(&request.model),
                );
            }
        }
    }
    serde_json::json!({
        "contents": contents,
        "config": serde_json::Value::Object(config),
    })
}

/// The REST request body (flat) sent to `:streamGenerateContent`.
pub fn build_google_request_body(
    request: &StreamRequest,
    options: &StreamOptions,
) -> serde_json::Value {
    let thinking_config = resolve_google_thinking_config(request, options);
    let params = build_google_request(request, options, thinking_config.as_ref());
    let mut body = serde_json::Map::new();
    body.insert("contents".into(), params["contents"].clone());
    if let Some(config) = params["config"].as_object() {
        for (key, value) in config {
            body.insert(key.clone(), value.clone());
        }
    }
    serde_json::Value::Object(body)
}

// ===========================================================================
// Streaming accumulator
// ===========================================================================

#[derive(Clone, Copy, PartialEq)]
enum GoogleBlockKind {
    Text,
    Thinking,
}

struct GoogleBlockState {
    kind: GoogleBlockKind,
    index: usize,
}

/// Accumulates one `GenerateContentResponse` stream into normalized events.
pub struct GoogleAccumulator {
    message: AssistantMessage,
    started: bool,
    current_block: Option<GoogleBlockState>,
    tool_call_counter: u64,
    now: u64,
}

fn empty_message(provider: &str, model: &str, now: u64) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: "google-generative-ai".to_string(),
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

impl GoogleAccumulator {
    pub fn new(provider: &str, model: &str) -> Self {
        Self::with_now(provider, model, now_ms())
    }

    pub fn with_now(provider: &str, model: &str, now: u64) -> Self {
        Self {
            message: empty_message(provider, model, now),
            started: false,
            current_block: None,
            tool_call_counter: 0,
            now,
        }
    }

    fn partial(&self) -> AssistantMessage {
        self.message.clone()
    }

    /// Process one `GenerateContentResponse` chunk (the `data:` payload).
    pub fn step(
        &mut self,
        chunk: &serde_json::Value,
    ) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
        if !self.started {
            self.started = true;
        }
        let mut events = Vec::new();
        if let Some(response_id) = chunk.get("responseId").and_then(|v| v.as_str()) {
            if self.message.response_id.is_none() {
                self.message.response_id = Some(response_id.to_string());
            }
        }
        let candidate = chunk
            .get("candidates")
            .and_then(|v| v.as_array())
            .and_then(|array| array.first());
        if let Some(parts) = candidate
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
        {
            for part in parts {
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    let is_thinking = part.get("thought") == Some(&serde_json::Value::Bool(true));
                    events.extend(self.part_text(text, is_thinking, part)?);
                }
                if let Some(function_call) = part.get("functionCall") {
                    events.extend(self.part_function_call(function_call)?);
                }
            }
        }
        if let Some(finish_reason) = candidate
            .and_then(|c| c.get("finishReason"))
            .and_then(|v| v.as_str())
        {
            self.message.stop_reason = map_google_stop_reason(finish_reason)?;
            if self
                .message
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolCall(_)))
            {
                self.message.stop_reason = StopReason::ToolUse;
            }
        }
        if let Some(usage) = chunk.get("usageMetadata") {
            let prompt = usage
                .get("promptTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cached = usage
                .get("cachedContentTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let candidates = usage
                .get("candidatesTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let thoughts = usage
                .get("thoughtsTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let total = usage
                .get("totalTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            self.message.usage = Usage {
                input: prompt.saturating_sub(cached),
                output: candidates + thoughts,
                cache_read: cached,
                cache_write: 0,
                cache_write_1h: None,
                reasoning: Some(thoughts),
                total_tokens: total,
                cost: aiden_core::UsageCost {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total: 0.0,
                },
            };
        }
        Ok(events)
    }

    fn end_current_block(&mut self, events: &mut Vec<AssistantMessageEvent>) {
        if let Some(state) = self.current_block.take() {
            match state.kind {
                GoogleBlockKind::Text => {
                    let content = match self.message.content.get(state.index) {
                        Some(ContentBlock::Text(TextContent { text, .. })) => text.clone(),
                        _ => String::new(),
                    };
                    events.push(AssistantMessageEvent::TextEnd {
                        content_index: state.index,
                        content,
                        partial: self.partial(),
                    });
                }
                GoogleBlockKind::Thinking => {
                    let content = match self.message.content.get(state.index) {
                        Some(ContentBlock::Thinking(ThinkingContent { thinking, .. })) => {
                            thinking.clone()
                        }
                        _ => String::new(),
                    };
                    events.push(AssistantMessageEvent::ThinkingEnd {
                        content_index: state.index,
                        content,
                        partial: self.partial(),
                    });
                }
            }
        }
    }

    fn part_text(
        &mut self,
        text: &str,
        is_thinking: bool,
        part: &serde_json::Value,
    ) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
        let mut events = Vec::new();
        let current_kind = self
            .current_block
            .as_ref()
            .map(|state| state.kind)
            .filter(|kind| {
                (is_thinking && *kind == GoogleBlockKind::Thinking)
                    || (!is_thinking && *kind == GoogleBlockKind::Text)
            });
        if current_kind.is_none() {
            self.end_current_block(&mut events);
            if is_thinking {
                let index = self.message.content.len();
                self.message
                    .content
                    .push(ContentBlock::Thinking(ThinkingContent {
                        thinking: String::new(),
                        thinking_signature: None,
                        redacted: None,
                    }));
                self.current_block = Some(GoogleBlockState {
                    kind: GoogleBlockKind::Thinking,
                    index,
                });
                events.push(AssistantMessageEvent::ThinkingStart {
                    content_index: index,
                    partial: self.partial(),
                });
            } else {
                let index = self.message.content.len();
                self.message.content.push(ContentBlock::Text(TextContent {
                    text: String::new(),
                    text_signature: None,
                }));
                self.current_block = Some(GoogleBlockState {
                    kind: GoogleBlockKind::Text,
                    index,
                });
                events.push(AssistantMessageEvent::TextStart {
                    content_index: index,
                    partial: self.partial(),
                });
            }
        }
        let Some(block_state) = self.current_block.as_ref() else {
            // Defensive: the transition above always installs a block; a
            // malformed stream should not panic the transport.
            return Ok(events);
        };
        let index = block_state.index;
        if is_thinking {
            if let Some(ContentBlock::Thinking(block)) = self.message.content.get_mut(index) {
                block.thinking.push_str(text);
                block.thinking_signature = retain_thought_signature(
                    block.thinking_signature.clone(),
                    part_thought_signature(part),
                );
            }
            events.push(AssistantMessageEvent::ThinkingDelta {
                content_index: index,
                delta: text.to_string(),
                partial: self.partial(),
            });
        } else {
            if let Some(ContentBlock::Text(block)) = self.message.content.get_mut(index) {
                block.text.push_str(text);
                block.text_signature = retain_thought_signature(
                    block.text_signature.clone(),
                    part_thought_signature(part),
                );
            }
            events.push(AssistantMessageEvent::TextDelta {
                content_index: index,
                delta: text.to_string(),
                partial: self.partial(),
            });
        }
        Ok(events)
    }

    fn part_function_call(
        &mut self,
        function_call: &serde_json::Value,
    ) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
        let mut events = Vec::new();
        self.end_current_block(&mut events);
        let provided_id = function_call
            .get("id")
            .and_then(|v| v.as_str())
            .map(String::from);
        let duplicate = match &provided_id {
            Some(id) => self
                .message
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolCall(tc) if &tc.id == id)),
            None => false,
        };
        let needs_new_id = provided_id.is_none() || duplicate;
        let tool_call_id = if needs_new_id {
            let name = function_call
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            self.tool_call_counter += 1;
            format!("{name}_{}_{}", self.now, self.tool_call_counter)
        } else {
            provided_id.clone().unwrap_or_default()
        };
        let name = function_call
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let arguments = function_call
            .get("args")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let thought_signature = part_thought_signature(function_call);
        let tool_call = ToolCall {
            id: tool_call_id,
            name,
            arguments: arguments.clone(),
            thought_signature,
        };
        let index = self.message.content.len();
        self.message
            .content
            .push(ContentBlock::ToolCall(tool_call.clone()));
        events.push(AssistantMessageEvent::ToolcallStart {
            content_index: index,
            partial: self.partial(),
        });
        events.push(AssistantMessageEvent::ToolcallDelta {
            content_index: index,
            delta: safe_json_stringify(&arguments),
            partial: self.partial(),
        });
        events.push(AssistantMessageEvent::ToolcallEnd {
            content_index: index,
            tool_call,
            partial: self.partial(),
        });
        Ok(events)
    }

    /// Finish the stream: close any open block and emit the terminal event.
    /// Mirrors the JS: an `error`/`aborted` stop reason produces a terminal
    /// `Error` event (the JS throws, the catch pushes `error`), otherwise a
    /// `done` event.
    pub fn finish(&mut self) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
        let mut events = Vec::new();
        self.end_current_block(&mut events);
        if self.message.stop_reason == StopReason::Error
            || self.message.stop_reason == StopReason::Aborted
        {
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

    /// Record a terminal transport failure as an error event.
    pub fn fail(&mut self, reason: StopReason, message: String) -> AssistantMessageEvent {
        self.message.stop_reason = reason;
        self.message.error_message = Some(message);
        AssistantMessageEvent::Error {
            reason,
            error: self.message.clone(),
        }
    }
}

fn part_thought_signature(part: &serde_json::Value) -> Option<String> {
    part.get("thoughtSignature")
        .and_then(|v| v.as_str())
        .map(String::from)
}

fn retain_thought_signature(existing: Option<String>, incoming: Option<String>) -> Option<String> {
    match incoming {
        Some(incoming) if !incoming.is_empty() => Some(incoming),
        _ => existing,
    }
}

/// Parse a complete Google SSE byte stream into normalized events.
pub fn parse_google_sse(
    provider: &str,
    model: &str,
    input: &[u8],
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    parse_google_sse_with_now(provider, model, input, now_ms())
}

/// Fixture-friendly variant with a fixed timestamp (deterministic tool ids).
pub fn parse_google_sse_with_now(
    provider: &str,
    model: &str,
    input: &[u8],
    now: u64,
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    let mut accumulator = GoogleAccumulator::with_now(provider, model, now);
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
// GoogleProvider (streaming)
// ===========================================================================

/// Provider for the Google Generative AI streaming API.
pub struct GoogleProvider {
    base_url: String,
}

impl Default for GoogleProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl GoogleProvider {
    pub fn new() -> Self {
        Self {
            base_url: GOOGLE_BASE_URL.to_string(),
        }
    }

    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
        }
    }

    fn build_request(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        let api_key = options.api_key.clone().ok_or_else(|| {
            ProviderError::Auth(format!("No API key for provider: {}", request.provider_id))
        })?;
        let model = request.model.clone();
        let url = format!(
            "{}/models/{}:streamGenerateContent?alt=sse",
            self.base_url.trim_end_matches('/'),
            model
        );
        let body = build_google_request_body(request, options);
        let mut builder = reqwest::Client::new()
            .post(url)
            .header("x-goog-api-key", api_key)
            .header("content-type", "application/json")
            .json(&body);
        if let Some(timeout_ms) = options.timeout_ms {
            builder = builder.timeout(std::time::Duration::from_millis(timeout_ms));
        }
        for (name, value) in &options.headers {
            builder = match value {
                Some(value) => builder.header(name, value),
                None => builder.header(name, ""),
            };
        }
        Ok(builder)
    }
}

type PayloadStream = std::pin::Pin<Box<dyn Stream<Item = Result<String, ProviderError>> + Send>>;

enum DriveState {
    Idle(Option<reqwest::RequestBuilder>),
    Streaming {
        payload: PayloadStream,
        accumulator: GoogleAccumulator,
        pending: std::collections::VecDeque<Result<AssistantMessageEvent, ProviderError>>,
        finished: bool,
    },
    Done,
}

impl Provider for GoogleProvider {
    fn info(&self) -> crate::ProviderInfo {
        crate::ProviderInfo {
            id: GOOGLE_PROVIDER_ID.to_string(),
            label: GOOGLE_PROVIDER_LABEL.to_string(),
        }
    }

    fn stream_simple(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<EventStream, ProviderError> {
        let request_builder = self.build_request(request, options)?;
        let provider_id = request.provider_id.clone();
        let model = request.model.clone();
        let stream =
            futures::stream::unfold(DriveState::Idle(Some(request_builder)), move |state| {
                drive_google(state, provider_id.clone(), model.clone())
            });
        Ok(Box::pin(stream))
    }
}

async fn drive_google(
    mut state: DriveState,
    provider_id: String,
    model: String,
) -> Option<(Result<AssistantMessageEvent, ProviderError>, DriveState)> {
    loop {
        state = match state {
            DriveState::Idle(Some(request_builder)) => match request_builder.send().await {
                Ok(response) if response.status().is_success() => DriveState::Streaming {
                    payload: Box::pin(sse_payload_stream(response)),
                    accumulator: GoogleAccumulator::new(&provider_id, &model),
                    pending: Default::default(),
                    finished: false,
                },
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_default();
                    return Some((
                        Err(ProviderError::from_http_status(status, body)),
                        DriveState::Done,
                    ));
                }
                Err(err) => {
                    return Some((
                        Err(ProviderError::Stream(err.to_string())),
                        DriveState::Done,
                    ))
                }
            },
            DriveState::Idle(None) => return None,
            DriveState::Streaming {
                mut payload,
                mut accumulator,
                mut pending,
                finished,
            } => {
                if finished {
                    if let Some(item) = pending.pop_front() {
                        return Some((
                            item,
                            DriveState::Streaming {
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
                                return Some((Err(ProviderError::Json(err)), DriveState::Done))
                            }
                        };
                        match accumulator.step(&chunk) {
                            Ok(events) => {
                                pending.extend(events.into_iter().map(Ok));
                            }
                            Err(err) => {
                                return Some((Err(err), DriveState::Done));
                            }
                        }
                        if let Some(item) = pending.pop_front() {
                            return Some((
                                item,
                                DriveState::Streaming {
                                    payload,
                                    accumulator,
                                    pending,
                                    finished: false,
                                },
                            ));
                        }
                        DriveState::Streaming {
                            payload,
                            accumulator,
                            pending,
                            finished: false,
                        }
                    }
                    Some(Ok(_)) => {
                        // [DONE] or empty payload: keep pulling.
                        DriveState::Streaming {
                            payload,
                            accumulator,
                            pending,
                            finished: false,
                        }
                    }
                    Some(Err(err)) => return Some((Err(err), DriveState::Done)),
                    None => {
                        match accumulator.finish() {
                            Ok(events) => {
                                pending.extend(events.into_iter().map(Ok));
                            }
                            Err(err) => {
                                return Some((Err(err), DriveState::Done));
                            }
                        }
                        DriveState::Streaming {
                            payload,
                            accumulator,
                            pending,
                            finished: true,
                        }
                    }
                }
            }
            DriveState::Done => return None,
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
    use aiden_core::{ContentBlock, ToolDef, UserMessage};

    const NOW: u64 = 1_700_000_000_000;

    fn request(model: &str) -> StreamRequest {
        StreamRequest {
            provider_id: GOOGLE_PROVIDER_ID.to_string(),
            api: ApiFamily::GoogleGenerativeAi,
            model: model.to_string(),
            base_url: GOOGLE_BASE_URL.to_string(),
            reasoning: true,
            thinking_level_map: None,
            vision: true,
            context_window: 1_000_000,
            max_tokens_limit: 8192,
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text("hi".to_string()),
                timestamp: 1,
            })],
            system_prompt: Some("You are Aiden.".to_string()),
            max_tokens: Some(1024),
            thinking_level: Some(ThinkingLevel::Medium),
            tools: vec![ToolDef {
                name: "grep".into(),
                description: "Search files".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
            temperature: Some(0.5),
            session_id: None,
            reasoning_summary: None,
            text_verbosity: None,
            service_tier: None,
            tool_choice: None,
            model_headers: Default::default(),
        }
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

    #[test]
    fn text_and_thinking_deltas_accumulate_into_blocks() {
        let fixture = br#"data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}

data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}

data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"hmm,"}]}}]}

data: {"candidates":[{"content":{"parts":[{"thought":true,"text":" let me think"}]}}]}

data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":2,"candidatesTokenCount":8,"thoughtsTokenCount":3,"totalTokenCount":18}}
"#;
        let events =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture, NOW)
                .unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            [
                "text_start",
                "text_delta",
                "text_delta",
                "text_end",
                "thinking_start",
                "thinking_delta",
                "thinking_delta",
                "thinking_end",
                "done",
            ]
        );
        // text blocks carry accumulated content; content indices track blocks.
        let AssistantMessageEvent::TextEnd {
            content_index,
            content,
            ..
        } = &events[3]
        else {
            panic!("expected text_end");
        };
        assert_eq!(*content_index, 0);
        assert_eq!(content, "Hello world");
        let AssistantMessageEvent::ThinkingEnd {
            content_index,
            content,
            ..
        } = &events[7]
        else {
            panic!("expected thinking_end");
        };
        assert_eq!(*content_index, 1);
        assert_eq!(content, "hmm, let me think");

        let AssistantMessageEvent::Done { reason, message } = &events[8] else {
            panic!("expected done");
        };
        assert_eq!(*reason, StopReason::Stop);
        assert_eq!(message.usage.input, 8); // prompt - cached
        assert_eq!(message.usage.cache_read, 2);
        assert_eq!(message.usage.output, 11); // candidates + thoughts
        assert_eq!(message.usage.reasoning, Some(3));
        assert_eq!(message.usage.total_tokens, 18);
    }

    #[test]
    fn function_calls_are_assembled_with_deterministic_ids() {
        let fixture = br#"data: {"candidates":[{"content":{"parts":[{"text":"Checking files"}]}}]}

data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"grep","args":{"pattern":"foo"}}}]}}]}

data: {"candidates":[{"finishReason":"STOP"}]}
"#;
        let events =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture, NOW)
                .unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            [
                "text_start",
                "text_delta",
                "text_end",
                "toolcall_start",
                "toolcall_delta",
                "toolcall_end",
                "done",
            ]
        );
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[5] else {
            panic!("expected toolcall_end");
        };
        assert_eq!(tool_call.name, "grep");
        assert_eq!(tool_call.arguments, serde_json::json!({"pattern": "foo"}));
        // Ids are generated deterministically: name_now_1.
        assert_eq!(tool_call.id, "grep_1700000000000_1");

        // A second generated call increments the counter.
        let fixture2 = br#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a"}}}]}}]}

data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"b"}}}]}}]}

data: {"candidates":[{"finishReason":"STOP"}]}
"#;
        let events =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture2, NOW)
                .unwrap();
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[2] else {
            panic!();
        };
        assert_eq!(tool_call.id, "read_file_1700000000000_1");
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[5] else {
            panic!();
        };
        assert_eq!(tool_call.id, "read_file_1700000000000_2");
    }

    #[test]
    fn provided_tool_call_ids_are_preserved_and_deduped() {
        let fixture = br#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc_1","name":"grep","args":{"pattern":"a"}}}]}}]}

data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc_1","name":"grep","args":{"pattern":"b"}}}]}}]}

data: {"candidates":[{"finishReason":"STOP"}]}
"#;
        let events =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture, NOW)
                .unwrap();
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[2] else {
            panic!();
        };
        // First occurrence keeps the provider id.
        assert_eq!(tool_call.id, "fc_1");
        // Second occurrence is a duplicate → regenerated.
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[5] else {
            panic!();
        };
        assert_eq!(tool_call.id, "grep_1700000000000_1");
    }

    #[test]
    fn tool_calls_force_tool_use_stop_reason() {
        let fixture = br#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"grep","args":{}}}]}}]}

data: {"candidates":[{"finishReason":"STOP"}]}
"#;
        let events =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture, NOW)
                .unwrap();
        let AssistantMessageEvent::Done { reason, message } = &events[3] else {
            panic!("expected done");
        };
        assert_eq!(*reason, StopReason::ToolUse);
        assert_eq!(message.stop_reason, StopReason::ToolUse);
    }

    #[test]
    fn safety_finish_reason_maps_to_terminal_error() {
        let fixture = br#"data: {"candidates":[{"content":{"parts":[{"text":"blocked"}]}}]}

data: {"candidates":[{"finishReason":"SAFETY"}]}
"#;
        let events =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture, NOW)
                .unwrap();
        let AssistantMessageEvent::Error { reason, error } = &events[3] else {
            panic!("expected error event");
        };
        assert_eq!(*reason, StopReason::Error);
        assert_eq!(error.stop_reason, StopReason::Error);
    }

    #[test]
    fn unknown_finish_reason_is_a_protocol_error() {
        let fixture = br#"data: {"candidates":[{"finishReason":"WIBBLE"}]}
"#;
        let result =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture, NOW);
        assert!(result.is_err());
    }

    #[test]
    fn malformed_payload_is_an_error_not_a_panic() {
        let fixture = br#"data: {not json
"#;
        let result =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture, NOW);
        assert!(result.is_err());
    }

    #[test]
    fn response_id_is_captured_from_first_chunk() {
        let fixture = br#"data: {"responseId":"resp_abc","candidates":[{"content":{"parts":[{"text":"hi"}]}}]}

data: {"responseId":"resp_abc","candidates":[{"finishReason":"STOP"}]}
"#;
        let events =
            parse_google_sse_with_now(GOOGLE_PROVIDER_ID, "gemini-2.5-flash", fixture, NOW)
                .unwrap();
        let AssistantMessageEvent::Done { message, .. } = &events[3] else {
            panic!();
        };
        assert_eq!(message.response_id.as_deref(), Some("resp_abc"));
    }

    #[test]
    fn request_body_builds_flat_rest_payload() {
        let request = request("gemini-2.5-flash");
        let options = StreamOptions {
            temperature: Some(0.5),
            ..Default::default()
        };
        let body = build_google_request_body(&request, &options);
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "hi");
        assert_eq!(body["systemInstruction"], "You are Aiden.");
        assert_eq!(body["generationConfig"]["temperature"], 0.5);
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "grep");
        assert!(body["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"].is_object());
        // Medium thinking on a 2.5 model → budgetTokens.
        assert_eq!(body["thinkingConfig"]["includeThoughts"], true);
        assert_eq!(body["thinkingConfig"]["thinkingBudget"], 8192);
    }

    #[test]
    fn gemini_3_models_use_thinking_level_not_budget() {
        let request = request("gemini-3-pro-preview");
        let options = StreamOptions::default();
        let body = build_google_request_body(&request, &options);
        assert_eq!(body["thinkingConfig"]["thinkingLevel"], "HIGH");
    }

    #[test]
    fn thinking_off_sends_disabled_config() {
        let request = StreamRequest {
            thinking_level: None,
            ..request("gemini-2.5-flash")
        };
        let options = StreamOptions::default();
        let body = build_google_request_body(&request, &options);
        assert_eq!(
            body["thinkingConfig"],
            serde_json::json!({ "thinkingBudget": 0 })
        );
    }

    #[test]
    fn message_conversion_merges_function_responses_into_one_user_turn() {
        let request = request("gemini-2.5-flash");
        let messages = vec![
            Message::Assistant(AssistantMessage {
                content: vec![ContentBlock::ToolCall(ToolCall {
                    id: "fc_1".into(),
                    name: "grep".into(),
                    arguments: serde_json::json!({"pattern": "foo"}),
                    thought_signature: None,
                })],
                api: "google-generative-ai".into(),
                provider: GOOGLE_PROVIDER_ID.into(),
                model: "gemini-2.5-flash".into(),
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
                stop_reason: StopReason::ToolUse,
                error_message: None,
                timestamp: 2,
            }),
            Message::ToolResult(aiden_core::ToolResultMessage {
                tool_call_id: "fc_1".into(),
                tool_name: "grep".into(),
                content: vec![ContentBlock::Text(TextContent {
                    text: "one match".into(),
                    text_signature: None,
                })],
                details: None,
                added_tool_names: None,
                is_error: false,
                timestamp: 3,
            }),
        ];
        let contents = convert_google_messages(&request, messages, NOW);
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[0]["role"], "model");
        assert_eq!(contents[0]["parts"][0]["functionCall"]["name"], "grep");
        assert_eq!(contents[1]["role"], "user");
        assert_eq!(
            contents[1]["parts"][0]["functionResponse"]["response"]["output"],
            "one match"
        );
    }

    #[test]
    fn thinking_helpers_match_aiden_contract() {
        let reasoning = true;
        let map: HashMap<String, Option<String>> = HashMap::new();
        let levels = google_thinking_levels_for_model(Some(reasoning), Some(&map));
        assert_eq!(levels, vec!["off", "low", "medium", "high"]);
        assert!(google_thinking_can_disable(Some(reasoning), Some(&map)));

        // An explicit null for a level excludes it.
        let mut map: HashMap<String, Option<String>> = HashMap::new();
        map.insert("low".to_string(), None);
        let levels = google_thinking_levels_for_model(Some(reasoning), Some(&map));
        assert_eq!(levels, vec!["off", "medium", "high"]);

        // Non-reasoning models support nothing and cannot disable.
        assert!(google_thinking_levels_for_model(Some(false), Some(&map)).is_empty());
        assert!(!google_thinking_can_disable(Some(false), Some(&map)));

        assert_eq!(normalize_google_thinking_level(&levels, Some("low")), "off");
        assert_eq!(
            normalize_google_thinking_level(&levels, Some("high")),
            "high"
        );
        assert_eq!(normalize_google_thinking_level(&[], Some("high")), "off");
    }

    #[test]
    fn parse_and_merge_thinking_preferences_are_bounded() {
        let parsed = parse_google_thinking_preferences(serde_json::json!({
            "gemini-2.5-flash": "medium",
            "gemini-2.5-pro": "high",
        }))
        .unwrap();
        assert_eq!(parsed["gemini-2.5-flash"], "medium");
        assert!(parse_google_thinking_preferences(serde_json::json!({"a": "bogus"})).is_err());
        assert!(parse_google_thinking_preferences(serde_json::json!([1, 2])).is_err());

        let merged = merge_google_thinking_preference(
            serde_json::json!({"gemini-2.5-flash": "low"}),
            "gemini-2.5-pro",
            "high",
        )
        .unwrap();
        assert_eq!(merged.len(), 2);
        assert_eq!(merged["gemini-2.5-pro"], "high");
    }
}
