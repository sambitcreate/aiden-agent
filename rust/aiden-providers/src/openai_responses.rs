//! OpenAI Responses API transport (`/responses` streaming).
//!
//! Port of pi-ai `api/openai-responses.js` + `api/openai-responses-shared.js`:
//! request params (`input` items, tools, reasoning, include), the shared
//! [`crate::responses_shared::ResponsesAccumulator`], and the SSE transport.

use std::collections::HashMap;

use aiden_core::{AssistantMessageEvent, StopReason};
use futures::Stream;

use crate::estimate::clamp_max_tokens_to_context;
use crate::json::clamp_openai_prompt_cache_key;
use crate::responses_shared::{
    convert_responses_messages, convert_responses_tools, finish_responses, ResponsesAccumulator,
};
use crate::sse::data_payloads;
use crate::{
    now_ms, sse_payload_stream, EventStream, Provider, ProviderError, StreamOptions, StreamRequest,
};

/// OpenAI rejects max_output_tokens below this.
pub const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS: u32 = 16;

/// `convertResponsesMessages` bound to the Responses provider contract.
pub fn convert_responses_messages_for_request(
    request: &StreamRequest,
    include_system_prompt: bool,
    now: u64,
) -> Vec<serde_json::Value> {
    convert_responses_messages(
        &request.provider_id,
        request.api.as_str(),
        &request.model,
        request.reasoning,
        request.vision,
        true,
        include_system_prompt,
        request.system_prompt.as_deref(),
        request.messages.clone(),
        now,
    )
}

/// Port of `buildParams` for `/responses`.
pub fn build_openai_responses_params(
    request: &StreamRequest,
    options: &StreamOptions,
) -> serde_json::Value {
    let messages = convert_responses_messages_for_request(request, true, now_ms());
    let mut params = serde_json::Map::new();
    params.insert(
        "model".into(),
        serde_json::Value::String(request.model.clone()),
    );
    params.insert("input".into(), serde_json::Value::Array(messages));
    params.insert("stream".into(), serde_json::Value::Bool(true));
    if let Some(session_id) = options
        .session_id
        .as_deref()
        .or(request.session_id.as_deref())
    {
        params.insert(
            "prompt_cache_key".into(),
            serde_json::Value::String(clamp_openai_prompt_cache_key(session_id)),
        );
    }
    params.insert("store".into(), serde_json::Value::Bool(false));
    let max_tokens = request
        .max_tokens
        .unwrap_or(request.max_tokens_limit)
        .max(1);
    let max_tokens =
        clamp_max_tokens_to_context(request.context_window, &request.messages, max_tokens);
    params.insert(
        "max_output_tokens".into(),
        serde_json::json!(max_tokens.max(OPENAI_RESPONSES_MIN_OUTPUT_TOKENS)),
    );
    if let Some(temperature) = options.temperature.or(request.temperature) {
        params.insert("temperature".into(), serde_json::json!(temperature));
    }
    if let Some(service_tier) = options
        .service_tier
        .clone()
        .or_else(|| request.service_tier.clone())
    {
        params.insert(
            "service_tier".into(),
            serde_json::Value::String(service_tier),
        );
    }
    if !request.tools.is_empty() {
        params.insert(
            "tools".into(),
            serde_json::Value::Array(convert_responses_tools(&request.tools, false, Some(false))),
        );
    }
    if let Some(tool_choice) = options
        .tool_choice
        .clone()
        .or_else(|| request.tool_choice.clone())
    {
        params.insert("tool_choice".into(), serde_json::Value::String(tool_choice));
    }
    if request.reasoning {
        let reasoning_effort = request.thinking_level;
        let clamped = reasoning_effort.and_then(|level| {
            crate::clamp_thinking_level(
                request.reasoning,
                request.thinking_level_map.as_ref(),
                level,
            )
        });
        let reasoning_summary = options
            .reasoning_summary
            .clone()
            .or_else(|| request.reasoning_summary.clone());
        if clamped.is_some() || reasoning_summary.is_some() {
            let effort = match clamped {
                Some(effort) => request
                    .thinking_level_map
                    .as_ref()
                    .and_then(|map| map.get(effort.as_str()))
                    .cloned()
                    .flatten()
                    .unwrap_or_else(|| effort.as_str().to_string()),
                None => "medium".to_string(),
            };
            params.insert(
                "reasoning".into(),
                serde_json::json!({
                    "effort": effort,
                    "summary": reasoning_summary.unwrap_or_else(|| "auto".to_string()),
                }),
            );
            params.insert(
                "include".into(),
                serde_json::json!(["reasoning.encrypted_content"]),
            );
        } else {
            let off_is_supported = request
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get("off"))
                .map(|value| value.is_some())
                .unwrap_or(true);
            if off_is_supported {
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
        if request.provider_id == "xai" {
            params.insert(
                "include".into(),
                serde_json::json!(["reasoning.encrypted_content"]),
            );
        }
    }
    serde_json::Value::Object(params)
}

/// Parse a complete `/responses` SSE byte stream into normalized events.
pub fn parse_openai_responses_sse(
    provider: &str,
    model: &str,
    input: &[u8],
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    parse_openai_responses_sse_with_now(provider, model, input, now_ms())
}

/// Fixture-friendly variant with a fixed timestamp. Provider `error` /
/// `response.failed` events surface as terminal `Error` events (the JS throws,
/// the catch pushes `error`).
pub fn parse_openai_responses_sse_with_now(
    provider: &str,
    model: &str,
    input: &[u8],
    now: u64,
) -> Result<Vec<AssistantMessageEvent>, ProviderError> {
    let mut accumulator = ResponsesAccumulator::with_now(provider, model, "openai-responses", now);
    let mut events = Vec::new();
    for payload in data_payloads(input) {
        if payload == crate::json::SSE_DONE {
            continue;
        }
        let event: serde_json::Value = serde_json::from_str(&payload)?;
        match accumulator.step(&event) {
            Ok(step_events) => events.extend(step_events),
            Err(err) => {
                accumulator.message.stop_reason = StopReason::Error;
                accumulator.message.error_message = Some(crate::provider_error_message(&err));
                events.push(AssistantMessageEvent::Error {
                    reason: StopReason::Error,
                    error: accumulator.message.clone(),
                });
                return Ok(events);
            }
        }
    }
    if let Err(err) = accumulator.require_terminal_event() {
        accumulator.message.stop_reason = StopReason::Error;
        accumulator.message.error_message = Some(crate::provider_error_message(&err));
        events.push(AssistantMessageEvent::Error {
            reason: StopReason::Error,
            error: accumulator.message.clone(),
        });
        return Ok(events);
    }
    events.extend(finish_responses(&mut accumulator)?);
    Ok(events)
}

// ===========================================================================
// OpenAIResponsesProvider (streaming)
// ===========================================================================

/// Provider for the OpenAI Responses API.
pub struct OpenAIResponsesProvider {
    base_url: String,
}

impl Default for OpenAIResponsesProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAIResponsesProvider {
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

    fn build_request(
        &self,
        request: &StreamRequest,
        options: &StreamOptions,
    ) -> Result<(reqwest::RequestBuilder, serde_json::Value), ProviderError> {
        let api_key =
            get_client_api_key(&request.provider_id, options.api_key.as_deref(), options)?;
        let body = build_openai_responses_params(request, options);
        let url = format!("{}/responses", self.base_url.trim_end_matches('/'));
        let mut headers: HashMap<String, String> = request.model_headers.clone();
        if let Some(session_id) = options
            .session_id
            .as_deref()
            .or(request.session_id.as_deref())
        {
            headers.insert("session_id".to_string(), session_id.to_string());
            headers.insert("x-client-request-id".to_string(), session_id.to_string());
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
            .header("content-type", "application/json")
            .header("Authorization", format!("Bearer {api_key}"));
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

/// `getClientApiKey` — shared with the completions provider semantics.
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

type ResponsesPayloadStream =
    std::pin::Pin<Box<dyn Stream<Item = Result<String, ProviderError>> + Send>>;

enum ResponsesDriveState {
    Idle(Option<reqwest::RequestBuilder>),
    Streaming {
        payload: ResponsesPayloadStream,
        accumulator: ResponsesAccumulator,
        pending: std::collections::VecDeque<Result<AssistantMessageEvent, ProviderError>>,
        finished: bool,
    },
    Done,
}

impl Provider for OpenAIResponsesProvider {
    fn info(&self) -> crate::ProviderInfo {
        crate::ProviderInfo {
            id: "openai-responses".to_string(),
            label: "OpenAI Responses".to_string(),
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
        let stream = futures::stream::unfold(
            ResponsesDriveState::Idle(Some(request_builder)),
            move |state| drive_responses(state, provider_id.clone(), model.clone()),
        );
        Ok(Box::pin(stream))
    }
}

async fn drive_responses(
    mut state: ResponsesDriveState,
    provider_id: String,
    model: String,
) -> Option<(
    Result<AssistantMessageEvent, ProviderError>,
    ResponsesDriveState,
)> {
    loop {
        state = match state {
            ResponsesDriveState::Idle(Some(request_builder)) => {
                match request_builder.send().await {
                    Ok(response) if response.status().is_success() => {
                        ResponsesDriveState::Streaming {
                            payload: Box::pin(sse_payload_stream(response)),
                            accumulator: ResponsesAccumulator::new(
                                &provider_id,
                                &model,
                                "openai-responses",
                            ),
                            pending: Default::default(),
                            finished: false,
                        }
                    }
                    Ok(response) => {
                        let status = response.status().as_u16();
                        let body = response.text().await.unwrap_or_default();
                        return Some((
                            Err(ProviderError::from_http_status(status, body)),
                            ResponsesDriveState::Done,
                        ));
                    }
                    Err(err) => {
                        return Some((
                            Err(ProviderError::Stream(err.to_string())),
                            ResponsesDriveState::Done,
                        ))
                    }
                }
            }
            ResponsesDriveState::Idle(None) => return None,
            ResponsesDriveState::Streaming {
                mut payload,
                mut accumulator,
                mut pending,
                finished,
            } => {
                if finished {
                    if let Some(item) = pending.pop_front() {
                        return Some((
                            item,
                            ResponsesDriveState::Streaming {
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
                        let event: serde_json::Value = match serde_json::from_str(&payload_text) {
                            Ok(event) => event,
                            Err(err) => {
                                return Some((
                                    Err(ProviderError::Json(err)),
                                    ResponsesDriveState::Done,
                                ))
                            }
                        };
                        match accumulator.step(&event) {
                            Ok(events) => {
                                pending.extend(events.into_iter().map(Ok));
                            }
                            Err(err) => {
                                // JS throws → catch → terminal error event.
                                accumulator.message.stop_reason = StopReason::Error;
                                accumulator.message.error_message =
                                    Some(crate::provider_error_message(&err));
                                let terminal = AssistantMessageEvent::Error {
                                    reason: StopReason::Error,
                                    error: accumulator.message.clone(),
                                };
                                pending.push_back(Ok(terminal));
                            }
                        }
                        if let Some(item) = pending.pop_front() {
                            return Some((
                                item,
                                ResponsesDriveState::Streaming {
                                    payload,
                                    accumulator,
                                    pending,
                                    finished: false,
                                },
                            ));
                        }
                        ResponsesDriveState::Streaming {
                            payload,
                            accumulator,
                            pending,
                            finished: false,
                        }
                    }
                    Some(Ok(_)) => ResponsesDriveState::Streaming {
                        payload,
                        accumulator,
                        pending,
                        finished: false,
                    },
                    Some(Err(err)) => {
                        accumulator.message.stop_reason = StopReason::Error;
                        accumulator.message.error_message = Some(err.to_string());
                        let terminal = AssistantMessageEvent::Error {
                            reason: StopReason::Error,
                            error: accumulator.message.clone(),
                        };
                        return Some((Ok(terminal), ResponsesDriveState::Done));
                    }
                    None => {
                        match accumulator.require_terminal_event() {
                            Ok(()) => match finish_responses(&mut accumulator) {
                                Ok(events) => {
                                    pending.extend(events.into_iter().map(Ok));
                                }
                                Err(err) => {
                                    return Some((Err(err), ResponsesDriveState::Done));
                                }
                            },
                            Err(err) => {
                                return Some((Err(err), ResponsesDriveState::Done));
                            }
                        }
                        ResponsesDriveState::Streaming {
                            payload,
                            accumulator,
                            pending,
                            finished: true,
                        }
                    }
                }
            }
            ResponsesDriveState::Done => return None,
        };
    }
}

// ===========================================================================
// Tests (fixture SSE, no network)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ApiFamily, ThinkingLevel};
    use aiden_core::{ContentBlock, Message, TextContent, ToolDef, UserContent, UserMessage};

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
            provider_id: "openai".to_string(),
            api: ApiFamily::OpenAIResponses,
            model: model.to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            reasoning: true,
            thinking_level_map: None,
            force_adaptive_thinking: false,
            vision: true,
            context_window: 200_000,
            max_tokens_limit: 32_768,
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text("hello".to_string()),
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
            temperature: None,
            session_id: Some("chat-123".into()),
            reasoning_summary: Some("concise".into()),
            text_verbosity: None,
            service_tier: None,
            tool_choice: None,
            model_headers: Default::default(),
        }
    }

    #[test]
    fn text_and_reasoning_deltas_map_to_blocks() {
        let fixture = br#"data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"content":[]}}

data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"Let me think"}

data: {"type":"response.reasoning_text.delta","output_index":0,"delta":" harder"}

data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[],"status":"in_progress"}}

data: {"type":"response.output_text.delta","output_index":1,"delta":"Hello"}

data: {"type":"response.output_text.delta","output_index":1,"delta":" world"}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"Let me think harder"}],"content":[]}}

data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[]}],"status":"completed"}}

data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":20,"output_tokens":7,"total_tokens":27,"input_tokens_details":{"cached_tokens":3,"cache_write_tokens":2},"output_tokens_details":{"reasoning_tokens":4}}}}
"#;
        let events = parse_openai_responses_sse_with_now("openai", "gpt-5.4", fixture, 9).unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            [
                "thinking_start",
                "thinking_delta",
                "thinking_delta",
                "text_start",
                "text_delta",
                "text_delta",
                "thinking_end",
                "text_end",
                "done",
            ]
        );
        let AssistantMessageEvent::ThinkingEnd { content, .. } = &events[6] else {
            panic!();
        };
        assert_eq!(content, "Let me think harder");
        let AssistantMessageEvent::TextEnd { content, .. } = &events[7] else {
            panic!();
        };
        assert_eq!(content, "Hello world");
        let AssistantMessageEvent::Done { reason, message } = &events[8] else {
            panic!();
        };
        assert_eq!(*reason, StopReason::Stop);
        assert_eq!(message.response_id.as_deref(), Some("resp_1"));
        // input 20 - cached 3 - write 2 = 15
        assert_eq!(message.usage.input, 15);
        assert_eq!(message.usage.cache_read, 3);
        assert_eq!(message.usage.cache_write, 2);
        assert_eq!(message.usage.output, 7);
        assert_eq!(message.usage.reasoning, Some(4));
        assert_eq!(message.usage.total_tokens, 27);
        // Message blocks carry the v1 id signature for replay.
        let ContentBlock::Text(text) = &message.content[1] else {
            panic!();
        };
        let signature = text.text_signature.as_deref().expect("text signature");
        assert!(signature.contains("\"v\":1"));
        assert!(signature.contains("\"id\":\"msg_1\""));
        // Reasoning block keeps its signature for replay.
        let ContentBlock::Thinking(thinking) = &message.content[0] else {
            panic!();
        };
        let signature: serde_json::Value =
            serde_json::from_str(thinking.thinking_signature.as_deref().unwrap()).unwrap();
        assert_eq!(signature["id"], "rs_1");
        assert_eq!(signature["summary"][0]["text"], "Let me think harder");
    }

    #[test]
    fn function_call_arguments_are_assembled() {
        let fixture = br#"data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"grep","arguments":""}}

data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"pat"}

data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"tern\":\"foo\"}"}

data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\"pattern\":\"foo\"}"}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"grep","arguments":"{\"pattern\":\"foo\"}"}}

data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}
"#;
        let events = parse_openai_responses_sse_with_now("openai", "gpt-5.4", fixture, 9).unwrap();
        let kinds: Vec<&str> = events.iter().map(kind).collect();
        assert_eq!(
            kinds,
            [
                "toolcall_start",
                "toolcall_delta",
                "toolcall_delta",
                "toolcall_end",
                "done",
            ]
        );
        let AssistantMessageEvent::ToolcallEnd { tool_call, .. } = &events[3] else {
            panic!();
        };
        assert_eq!(tool_call.id, "call_1|fc_1");
        assert_eq!(tool_call.name, "grep");
        assert_eq!(tool_call.arguments, serde_json::json!({"pattern": "foo"}));
        let AssistantMessageEvent::Done { reason, .. } = &events[4] else {
            panic!();
        };
        assert_eq!(*reason, StopReason::ToolUse);
    }

    #[test]
    fn incomplete_status_maps_to_length() {
        let fixture = br#"data: {"type":"response.created","response":{"id":"r","status":"in_progress"}}

data: {"type":"response.incomplete","response":{"id":"r","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}
"#;
        let events = parse_openai_responses_sse_with_now("openai", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::Done { reason, .. } = events.last().unwrap() else {
            panic!();
        };
        assert_eq!(*reason, StopReason::Length);
    }

    #[test]
    fn response_failed_is_a_terminal_error_event() {
        let fixture = br#"data: {"type":"response.failed","response":{"id":"r","status":"failed","error":{"code":"rate_limit_exceeded","message":"slow down"}}}
"#;
        let events = parse_openai_responses_sse_with_now("openai", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::Error { reason, error } = events.last().unwrap() else {
            panic!("expected error");
        };
        assert_eq!(*reason, StopReason::Error);
        assert_eq!(
            error.error_message.as_deref(),
            Some("rate_limit_exceeded: slow down")
        );
    }

    #[test]
    fn error_event_is_a_terminal_error_event() {
        let fixture = br#"data: {"type":"error","code":"invalid_api_key","message":"bad key"}
"#;
        let events = parse_openai_responses_sse_with_now("openai", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::Error { error, .. } = events.last().unwrap() else {
            panic!("expected error");
        };
        assert_eq!(
            error.error_message.as_deref(),
            Some("Error Code invalid_api_key: bad key")
        );
    }

    #[test]
    fn stream_without_terminal_event_is_an_error() {
        let fixture =
            br#"data: {"type":"response.created","response":{"id":"r","status":"in_progress"}}

data: {"type":"response.output_text.delta","output_index":0,"delta":"hi"}
"#;
        let events = parse_openai_responses_sse_with_now("openai", "gpt-5.4", fixture, 9).unwrap();
        let AssistantMessageEvent::Error { error, .. } = events.last().unwrap() else {
            panic!("expected error");
        };
        assert!(error
            .error_message
            .as_deref()
            .unwrap()
            .contains("terminal response event"));
    }

    #[test]
    fn malformed_frame_is_an_error_not_a_panic() {
        let fixture = br#"data: {broken
"#;
        let result = parse_openai_responses_sse_with_now("openai", "gpt-5.4", fixture, 9);
        assert!(result.is_err());
    }

    #[test]
    fn params_build_input_items_and_reasoning() {
        let request = request("gpt-5.4");
        let options = StreamOptions {
            api_key: Some("key".into()),
            session_id: Some("chat-123".into()),
            reasoning_summary: Some("concise".into()),
            ..Default::default()
        };
        let params = build_openai_responses_params(&request, &options);
        assert_eq!(params["model"], "gpt-5.4");
        assert_eq!(params["stream"], true);
        assert_eq!(params["store"], false);
        assert_eq!(params["input"][0]["role"], "developer");
        assert_eq!(params["input"][0]["content"], "You are Aiden.");
        assert_eq!(params["input"][1]["role"], "user");
        assert_eq!(params["input"][1]["content"][0]["type"], "input_text");
        assert_eq!(params["max_output_tokens"], 1024);
        assert_eq!(params["tools"][0]["type"], "function");
        assert_eq!(params["reasoning"]["effort"], "medium");
        assert_eq!(params["reasoning"]["summary"], "concise");
        assert_eq!(
            params["include"],
            serde_json::json!(["reasoning.encrypted_content"])
        );
        assert_eq!(params["prompt_cache_key"], "chat-123");
    }

    #[test]
    fn image_input_uses_input_image_items() {
        let mut request = request("gpt-5.4");
        request.messages = vec![Message::User(UserMessage {
            content: UserContent::Blocks(vec![aiden_core::UserBlock::Image(
                aiden_core::ImageContent {
                    data: "AAAA".into(),
                    mime_type: "image/png".into(),
                },
            )]),
            timestamp: 1,
        })];
        let messages = convert_responses_messages_for_request(&request, false, 1);
        assert_eq!(messages[0]["content"][0]["type"], "input_image");
        assert_eq!(
            messages[0]["content"][0]["image_url"],
            "data:image/png;base64,AAAA"
        );
    }

    #[test]
    fn tool_results_become_function_call_output() {
        let request = request("gpt-5.4");
        let messages = vec![
            Message::Assistant(aiden_core::AssistantMessage {
                content: vec![ContentBlock::ToolCall(aiden_core::ToolCall {
                    id: "call_1|fc_1".into(),
                    name: "grep".into(),
                    arguments: serde_json::json!({}),
                    thought_signature: None,
                })],
                api: "openai-responses".into(),
                provider: "openai".into(),
                model: "gpt-5.4".into(),
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
                tool_call_id: "call_1|fc_1".into(),
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
        let request = StreamRequest {
            messages: messages.clone(),
            ..request
        };
        let items = convert_responses_messages_for_request(&request, true, 1);
        // system + assistant function_call + function_call_output
        assert_eq!(items[0]["role"], "developer");
        assert_eq!(items[1]["type"], "function_call");
        assert_eq!(items[1]["call_id"], "call_1");
        assert_eq!(items[1]["id"], "fc_1");
        assert_eq!(items[2]["type"], "function_call_output");
        assert_eq!(items[2]["call_id"], "call_1");
        assert_eq!(items[2]["output"], "one match");
    }
}
