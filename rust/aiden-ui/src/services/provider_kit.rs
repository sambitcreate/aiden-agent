//! Provider catalog + streaming dispatch for the chat service.
//!
//! The catalog is built from the *portable config* (`ConfigStore::list_providers`)
//! — anthropic, openai, and `custom:` base-URL providers — plus the keychain
//! state attached to each (`hasKey`). Streaming dispatches through the
//! aiden-providers transports on the tokio runtime and forwards batched
//! updates over a channel to the GPUI foreground (see [`drive_stream`]).

use std::sync::Arc;

use aiden_agent::llm_client::{TerminalTimelineStatus, TimelineProjector, ToolFinishStatus};
use aiden_core::{
    AssistantMessage, AssistantMessageEvent, ChatMessage, ChatRole, ContentBlock,
    GenerationTimeline, Message, StopReason, TextContent, ToolResultMessage, Usage, UserContent,
    UserMessage,
};
use aiden_data::config_store::Provider as StoredProvider;
use aiden_data::portable_config::ProviderKind;
use aiden_providers::provider_error_message;
use aiden_providers::{
    anthropic::AnthropicProvider, openai_completions::OpenAICompletionsProvider, ApiFamily,
    Provider, StreamOptions, StreamRequest,
};

use crate::services::mcp_tools::{
    collect_chat_mcp_tools, ChatMcpTools, McpStreamContext, CHAT_MCP_CALL_TIMEOUT_MS,
};
use crate::services::stream::{
    message_content, tool_calls_of, zero_usage, zero_usage_message, StreamReducer, StreamTerminal,
};

/// Channel message sent from the streaming driver to the foreground.
#[derive(Debug)]
pub enum StreamMsg {
    /// Batched incremental append (text/thinking deltas since the last flush).
    Flush {
        text: String,
        thinking: String,
        thinking_active: Option<bool>,
    },
    /// A live generation-timeline snapshot (thinking/tool steps). Sent on
    /// every recorded transition; the foreground mirrors it onto the
    /// generation state so the live message renders tool activity.
    Timeline { timeline: Box<GenerationTimeline> },
    /// Terminal success: the final assistant message + full text/thinking.
    Done {
        message: Box<AssistantMessage>,
        full_text: String,
        full_thinking: String,
        usage: Usage,
    },
    /// Terminal failure.
    Error {
        message: String,
        partial_text: String,
        partial_thinking: String,
    },
}

/// One provider as configured on disk (the model-picker catalog entry).
#[derive(Debug, Clone, PartialEq)]
pub struct ConfiguredProvider {
    pub id: String,
    pub label: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub models: Vec<String>,
    pub default_model: Option<String>,
    pub needs_key: bool,
    pub has_key: bool,
}

impl ConfiguredProvider {
    /// The pi-ai API family this provider dispatches through.
    pub fn api_family(&self) -> ApiFamily {
        match self.kind {
            ProviderKind::Anthropic => ApiFamily::AnthropicMessages,
            ProviderKind::Openai => ApiFamily::OpenAICompletions,
        }
    }

    /// The concrete transport registered for this provider's API family. The
    /// transport's fixed info id (`anthropic`, `google`, `openai-completions`)
    /// is decoupled from the *configured* provider id so `custom:` providers
    /// work; the request still carries the configured id for auth + headers.
    pub fn transport(&self) -> Arc<dyn Provider> {
        match self.kind {
            ProviderKind::Anthropic => Arc::new(AnthropicProvider::new()),
            ProviderKind::Openai => Arc::new(OpenAICompletionsProvider::with_base_url(
                self.base_url.clone(),
            )),
        }
    }
}

impl From<&StoredProvider> for ConfiguredProvider {
    fn from(provider: &StoredProvider) -> Self {
        Self {
            id: provider.id.clone(),
            label: provider.label.clone(),
            kind: provider.kind,
            base_url: provider.base_url.clone(),
            models: provider.models.clone(),
            default_model: provider.default_model.clone(),
            needs_key: provider.needs_key,
            has_key: provider.has_key,
        }
    }
}

/// A fully-resolved selection: provider + model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSelection {
    pub provider_id: String,
    pub model: String,
}

impl ModelSelection {
    /// `providerId`/`model` — the key used by the settings persistence.
    pub fn to_settings(&self) -> serde_json::Value {
        serde_json::json!({
            "providerId": self.provider_id,
            "model": self.model,
        })
    }

    pub fn from_settings(value: &serde_json::Value) -> Option<Self> {
        let provider_id = value.get("providerId")?.as_str()?.to_string();
        let model = value.get("model")?.as_str()?.to_string();
        if provider_id.is_empty() || model.is_empty() {
            return None;
        }
        Some(Self { provider_id, model })
    }
}

/// A snapshot of everything the background driver needs for one turn.
#[derive(Debug, Clone)]
pub struct TurnSnapshot {
    pub provider: ConfiguredProvider,
    pub selection: ModelSelection,
    pub messages: Vec<Message>,
    /// Optional MCP tool wiring: when enabled servers are configured, the
    /// driver collects their tools into the request and dispatches model tool
    /// calls through the manager (single tool round).
    pub mcp: Option<McpStreamContext>,
}

/// Map persisted chat history into the normalized `Message` union the
/// providers serialize onto the wire. System messages are dropped (the
/// phase-5 build has no system-prompt pipeline).
pub fn chat_history_to_messages(
    history: &[ChatMessage],
    default_model: &str,
    default_provider: &str,
) -> Vec<Message> {
    history
        .iter()
        .filter_map(|entry| match entry.role {
            ChatRole::User => Some(Message::User(UserMessage {
                content: UserContent::Text(entry.content.clone()),
                timestamp: entry.created_at,
            })),
            ChatRole::Assistant => Some(Message::Assistant(AssistantMessage {
                content: if entry.content.is_empty() {
                    Vec::new()
                } else {
                    vec![ContentBlock::Text(TextContent {
                        text: entry.content.clone(),
                        text_signature: None,
                    })]
                },
                api: "openai-completions".to_string(),
                provider: default_provider.to_string(),
                model: entry
                    .model
                    .clone()
                    .unwrap_or_else(|| default_model.to_string()),
                response_model: None,
                response_id: None,
                usage: zero_usage(),
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: entry.created_at,
            })),
            ChatRole::System => None,
        })
        .collect()
}

/// Build the normalized `StreamRequest` for one turn.
#[allow(dead_code)] // convenience wrapper; the driver uses the tools variant
pub fn build_stream_request(snapshot: &TurnSnapshot) -> StreamRequest {
    build_stream_request_with_tools(snapshot, &[], snapshot.messages.clone())
}

/// Build the normalized `StreamRequest` for one turn with an explicit tool
/// surface and message list (the driver re-invokes this after each tool round
/// with the appended tool results).
pub fn build_stream_request_with_tools(
    snapshot: &TurnSnapshot,
    tools: &[aiden_core::ToolDef],
    messages: Vec<Message>,
) -> StreamRequest {
    StreamRequest {
        provider_id: snapshot.selection.provider_id.clone(),
        api: snapshot.provider.api_family(),
        model: snapshot.selection.model.clone(),
        base_url: snapshot.provider.base_url.clone(),
        reasoning: false,
        thinking_level_map: None,
        vision: false,
        context_window: 32_768,
        max_tokens_limit: 4_096,
        messages,
        system_prompt: None,
        max_tokens: None,
        tools: tools.to_vec(),
        ..Default::default()
    }
}

/// The timeout for one provider turn.
const TURN_TIMEOUT_MS: u64 = 120_000;
/// Batched flush cadence, mirroring the renderer's rAF batching (~30ms).
const FLUSH_INTERVAL_MS: u64 = 30;

/// Drive one provider turn on the tokio runtime, forwarding batched updates
/// into `tx`. Never panics: transport failures become a terminal
/// [`StreamMsg::Error`].
///
/// When [`TurnSnapshot::mcp`] is set, the driver first collects the enabled
/// servers' tools (bounded), passes them into the provider request, and — if
/// the model emits tool calls — dispatches each through
/// [`McpClientManager::call_tool`], appends the normalized result, and runs
/// **one** follow-up provider pass. Multi-round agent loops are out of scope
/// for the chat driver; a turn that keeps asking for tools after the round
/// settles with whatever text it produced and the recorded timeline.
pub async fn drive_stream(
    snapshot: TurnSnapshot,
    api_key: Option<String>,
    tx: tokio::sync::mpsc::UnboundedSender<StreamMsg>,
) {
    // MCP tool collection (bounded, never fails the turn).
    let mcp = match &snapshot.mcp {
        Some(context) => {
            let tools =
                collect_chat_mcp_tools(&context.manager, &context.servers, &context.preset_key)
                    .await;
            Some(McpExecution {
                manager: context.manager.clone(),
                tools,
            })
        }
        None => None,
    };
    let tool_defs: Vec<aiden_core::ToolDef> = mcp
        .as_ref()
        .map(|execution| execution.tools.defs.clone())
        .unwrap_or_default();

    // The live activity timeline for this turn; every transition is pushed to
    // the foreground so the streaming bubble renders thinking/tool steps.
    let timeline_tx = tx.clone();
    let mut projector = TimelineProjector::new(
        aiden_data::chat_store::new_uuid_like(),
        Box::new(move |timeline| {
            let _ = timeline_tx.send(StreamMsg::Timeline {
                timeline: Box::new(timeline.clone()),
            });
        }),
    );

    let transport = snapshot.provider.transport();
    let options = StreamOptions {
        api_key,
        timeout_ms: Some(TURN_TIMEOUT_MS),
        ..Default::default()
    };
    let mut messages = snapshot.messages.clone();
    let mut tool_round_done = false;

    // At most two passes: the initial turn, then one pass after the model's
    // tool calls are dispatched and their results are appended.
    loop {
        let request = build_stream_request_with_tools(&snapshot, &tool_defs, messages.clone());
        let mut reducer = StreamReducer::new();
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));

        match transport.stream_simple(&request, &options) {
            Ok(mut stream) => {
                use futures::StreamExt;
                loop {
                    tokio::select! {
                        maybe_event = stream.next() => match maybe_event {
                            Some(Ok(event)) => {
                                project_timeline_event(&mut projector, &event);
                                reducer.apply(event);
                            }
                            Some(Err(error)) => {
                                reducer.fail(provider_error_message(&error));
                                break;
                            }
                            None => break,
                        },
                        _ = interval.tick() => {
                            send_flush(&mut reducer, &tx);
                        }
                    }
                }
            }
            Err(error) => {
                reducer.fail(provider_error_message(&error));
            }
        }
        send_flush(&mut reducer, &tx);

        if reducer.failure.is_some() {
            let timeline = projector.finish(TerminalTimelineStatus::Failed);
            let _ = tx.send(StreamMsg::Timeline {
                timeline: Box::new(timeline),
            });
            match reducer.finalize() {
                StreamTerminal::Error {
                    message,
                    partial_text,
                    partial_thinking,
                    ..
                } => {
                    let _ = tx.send(StreamMsg::Error {
                        message,
                        partial_text,
                        partial_thinking,
                    });
                }
                StreamTerminal::Done { .. } => unreachable!("a failing reducer finalizes as Error"),
            }
            return;
        }

        let final_message = reducer
            .final_message
            .clone()
            .unwrap_or_else(zero_usage_message);
        let tool_calls = tool_calls_of(&final_message);
        let dispatch_ready = mcp.as_ref().is_some_and(|execution| {
            !execution.tools.dispatch.is_empty() && !tool_calls.is_empty()
        });
        if dispatch_ready && !tool_round_done {
            tool_round_done = true;
            let mut executed = false;
            if let Some(execution) = mcp.as_ref() {
                for call in &tool_calls {
                    let result = execute_tool_call(&mut projector, execution, call).await;
                    executed = true;
                    messages.push(Message::ToolResult(ToolResultMessage {
                        tool_call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        content: vec![ContentBlock::Text(TextContent {
                            text: result.text,
                            text_signature: None,
                        })],
                        details: None,
                        added_tool_names: None,
                        is_error: result.is_error,
                        timestamp: aiden_data::now_millis(),
                    }));
                }
            }
            if executed {
                continue;
            }
        }

        // Settled success: the turn produced a final assistant message (with
        // or without tool calls the single-pass driver does not re-dispatch).
        let terminal = reducer.finalize();
        match terminal {
            StreamTerminal::Done { message } => {
                let timeline = projector.finish(TerminalTimelineStatus::Completed);
                let _ = tx.send(StreamMsg::Timeline {
                    timeline: Box::new(timeline),
                });
                let usage = message.usage;
                let (full_text, full_thinking) = message_content(&message);
                let _ = tx.send(StreamMsg::Done {
                    message,
                    full_text,
                    full_thinking,
                    usage,
                });
            }
            StreamTerminal::Error { .. } => unreachable!("failure handled above"),
        }
        return;
    }
}

/// The manager + collected tool surface the driver executes tool calls with.
struct McpExecution {
    manager: Arc<aiden_mcp::McpClientManager>,
    tools: ChatMcpTools,
}

/// Project stream events onto the live timeline: thinking stretches and tool
/// step lifecycle (start when the model begins emitting a call, running once
/// the call is complete, terminal status set by the executor).
fn project_timeline_event(projector: &mut TimelineProjector, event: &AssistantMessageEvent) {
    match event {
        AssistantMessageEvent::ThinkingStart { .. } => projector.thinking_started(),
        AssistantMessageEvent::ThinkingEnd { .. } => projector.thinking_ended(),
        AssistantMessageEvent::ToolcallStart { partial, .. } => {
            if let Some(call) = first_tool_call(partial) {
                if !call.id.is_empty() && !call.name.is_empty() {
                    projector.tool_started(&call.id, &call.name, &call.arguments);
                }
            }
        }
        AssistantMessageEvent::ToolcallEnd { tool_call, .. } if !tool_call.id.is_empty() => {
            projector.tool_running(&tool_call.id);
        }
        _ => {}
    }
}

fn first_tool_call(message: &AssistantMessage) -> Option<aiden_core::ToolCall> {
    message.content.iter().find_map(|block| match block {
        ContentBlock::ToolCall(call) => Some(call.clone()),
        _ => None,
    })
}

fn send_flush(reducer: &mut StreamReducer, tx: &tokio::sync::mpsc::UnboundedSender<StreamMsg>) {
    if let Some(flush) = reducer.take_flush() {
        let _ = tx.send(StreamMsg::Flush {
            text: flush.text,
            thinking: flush.thinking,
            thinking_active: flush.thinking_active,
        });
    }
}

/// The normalized text result of a dispatched MCP tool call.
struct DispatchedToolResult {
    text: String,
    is_error: bool,
}

/// Dispatch one model tool call through the connected MCP server and settle
/// its timeline step. Unknown namespaced names fail closed.
async fn execute_tool_call(
    projector: &mut TimelineProjector,
    execution: &McpExecution,
    call: &aiden_core::ToolCall,
) -> DispatchedToolResult {
    let Some(target) = execution.tools.dispatch.get(&call.name) else {
        projector.tool_finished(&call.id, ToolFinishStatus::Failed);
        return DispatchedToolResult {
            text: format!("Unknown tool \"{}\".", call.name),
            is_error: true,
        };
    };
    let outcome = execution
        .manager
        .call_tool(
            &target.server_id,
            &target.tool_name,
            call.arguments.clone(),
            std::time::Duration::from_millis(CHAT_MCP_CALL_TIMEOUT_MS),
        )
        .await;
    match outcome {
        Ok(result) => {
            projector.tool_finished(&call.id, ToolFinishStatus::Completed);
            DispatchedToolResult {
                text: result.text,
                is_error: false,
            }
        }
        Err(error) => {
            projector.tool_finished(&call.id, ToolFinishStatus::Failed);
            DispatchedToolResult {
                text: error.to_string(),
                is_error: true,
            }
        }
    }
}

/// Resolve a stored API key for the provider (keychain access — call on a
/// background thread, never the GPUI foreground).
pub fn resolve_api_key(
    keys: &aiden_data::secret_map::ProviderKeysStore,
    provider: &ConfiguredProvider,
) -> Option<String> {
    if !provider.needs_key {
        return None;
    }
    keys.get(&provider.id).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn user(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: "m1".into(),
            role,
            content: content.into(),
            created_at: 1_700_000_000_000,
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        }
    }

    #[test]
    fn history_maps_user_and_assistant_turns() {
        let history = vec![
            user(ChatRole::User, "hi"),
            user(ChatRole::Assistant, "hello there"),
            user(ChatRole::System, "you are a helper"),
        ];
        let messages = chat_history_to_messages(&history, "claude-sonnet-5", "anthropic");
        assert_eq!(messages.len(), 2, "system messages are dropped");
        assert!(
            matches!(messages[0], Message::User(ref u) if matches!(&u.content, UserContent::Text(t) if t == "hi"))
        );
        let Message::Assistant(ref a) = messages[1] else {
            panic!("expected assistant turn");
        };
        assert_eq!(a.provider, "anthropic");
        assert_eq!(a.model, "claude-sonnet-5");
        assert!(matches!(&a.content[0], ContentBlock::Text(t) if t.text == "hello there"));
    }

    #[test]
    fn history_keeps_per_message_model() {
        let mut assistant = user(ChatRole::Assistant, "hi");
        assistant.model = Some("claude-haiku-4".into());
        let messages = chat_history_to_messages(&[assistant], "claude-sonnet-5", "anthropic");
        let Message::Assistant(ref a) = messages[0] else {
            panic!();
        };
        assert_eq!(a.model, "claude-haiku-4");
    }

    #[test]
    fn empty_assistant_history_produces_no_text_block() {
        let assistant = user(ChatRole::Assistant, "");
        let messages = chat_history_to_messages(&[assistant], "m", "p");
        let Message::Assistant(ref a) = messages[0] else {
            panic!();
        };
        assert!(a.content.is_empty());
    }

    #[test]
    fn custom_provider_resolves_to_openai_completions_transport() {
        let provider = ConfiguredProvider {
            id: "custom:lmstudio".into(),
            label: "LM Studio".into(),
            kind: ProviderKind::Openai,
            base_url: "http://127.0.0.1:1234/v1".into(),
            models: vec!["qwen2.5-coder".into()],
            default_model: None,
            needs_key: false,
            has_key: false,
        };
        assert_eq!(provider.api_family(), ApiFamily::OpenAICompletions);
        // The transport is constructible and reports its fixed info id.
        let transport = provider.transport();
        assert_eq!(transport.info().id, "openai-completions");
    }

    #[test]
    fn selection_settings_roundtrip() {
        let selection = ModelSelection {
            provider_id: "anthropic".into(),
            model: "claude-sonnet-5".into(),
        };
        let value = selection.to_settings();
        assert_eq!(value["providerId"], "anthropic");
        let back = ModelSelection::from_settings(&value).expect("parses back");
        assert_eq!(back, selection);
        assert!(ModelSelection::from_settings(&serde_json::json!({})).is_none());
    }

    /// An assistant message whose only content block is a tool call.
    fn tool_use_message(id: &str, name: &str, args: serde_json::Value) -> AssistantMessage {
        AssistantMessage {
            content: vec![ContentBlock::ToolCall(aiden_core::ToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments: args,
                thought_signature: None,
            })],
            api: "anthropic-messages".into(),
            provider: "anthropic".into(),
            model: "claude".into(),
            response_model: None,
            response_id: None,
            usage: aiden_core::Usage {
                input: 5,
                output: 2,
                cache_read: 0,
                cache_write: 0,
                cache_write_1h: None,
                reasoning: None,
                total_tokens: 7,
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
            timestamp: 1_700_000_000_000,
        }
    }

    #[test]
    fn stream_events_project_onto_the_live_timeline() {
        // The driver folds normalized events into the TimelineProjector; the
        // projected steps must be renderer-safe (public `tool-N` / `think-N`
        // ids, resolved statuses, settled on finish).
        let mut projector = TimelineProjector::new("generation-1", Box::new(|_| {}));
        projector.thinking_started();
        let thinking_partial = AssistantMessage {
            content: vec![ContentBlock::Thinking(aiden_core::ThinkingContent {
                thinking: "hmm".into(),
                thinking_signature: None,
                redacted: None,
            })],
            ..tool_use_message("unused", "unused", serde_json::json!({}))
        };
        project_timeline_event(
            &mut projector,
            &AssistantMessageEvent::ThinkingDelta {
                content_index: 0,
                delta: "hmm".into(),
                partial: thinking_partial,
            },
        );
        project_timeline_event(
            &mut projector,
            &AssistantMessageEvent::ThinkingEnd {
                content_index: 0,
                content: "hmm".into(),
                partial: tool_use_message("unused", "unused", serde_json::json!({})),
            },
        );

        // The model emits a tool call: start (partial carries id+name), end.
        project_timeline_event(
            &mut projector,
            &AssistantMessageEvent::ToolcallStart {
                content_index: 0,
                partial: tool_use_message(
                    "toolu_abc",
                    "Docs__lookup_fb4b3e0873c6",
                    serde_json::json!({ "query": "ports" }),
                ),
            },
        );
        project_timeline_event(
            &mut projector,
            &AssistantMessageEvent::ToolcallEnd {
                content_index: 0,
                tool_call: aiden_core::ToolCall {
                    id: "toolu_abc".into(),
                    name: "Docs__lookup_fb4b3e0873c6".into(),
                    arguments: serde_json::json!({ "query": "ports" }),
                    thought_signature: None,
                },
                partial: tool_use_message(
                    "toolu_abc",
                    "Docs__lookup_fb4b3e0873c6",
                    serde_json::json!({}),
                ),
            },
        );
        // The dispatcher settles the executed step before the turn finishes.
        projector.tool_finished("toolu_abc", ToolFinishStatus::Completed);
        let timeline = projector.finish(TerminalTimelineStatus::Completed);

        assert_eq!(timeline.steps.len(), 2);
        match &timeline.steps[0] {
            aiden_core::AgentStep::Thinking(thinking) => {
                assert_eq!(thinking.id, "think-1");
                assert!(thinking.finished_at.is_some());
                assert!(thinking.duration_ms.is_some());
            }
            other => panic!("expected thinking step, got {other:?}"),
        }
        match &timeline.steps[1] {
            aiden_core::AgentStep::Tool(tool) => {
                assert_eq!(tool.id, "tool-1");
                assert_eq!(tool.tool_call_id, "call-1");
                assert_eq!(tool.tool_name, "Docs__lookup_fb4b3e0873c6");
                assert_eq!(tool.status, aiden_core::AgentStepStatus::Completed);
                // Provider call ids never cross the safe boundary.
                let serialized = serde_json::to_string(&timeline).unwrap();
                assert!(!serialized.contains("toolu_abc"));
            }
            other => panic!("expected tool step, got {other:?}"),
        }
    }

    #[test]
    fn executed_tool_calls_settle_running_steps_as_completed_or_failed() {
        let mut projector = TimelineProjector::new("generation-1", Box::new(|_| {}));
        let call = aiden_core::ToolCall {
            id: "toolu_1".into(),
            name: "Docs__lookup_fb4b3e0873c6".into(),
            arguments: serde_json::json!({ "query": "ports" }),
            thought_signature: None,
        };
        projector.tool_started(&call.id, &call.name, &call.arguments);
        projector.tool_running(&call.id);

        // Unknown namespaced name fails closed.
        let unknown = aiden_core::ToolCall {
            id: "toolu_2".into(),
            name: "Missing__tool_000000000000".into(),
            arguments: serde_json::json!({}),
            thought_signature: None,
        };
        projector.tool_started(&unknown.id, &unknown.name, &unknown.arguments);
        projector.tool_running(&unknown.id);
        projector.tool_finished(&unknown.id, ToolFinishStatus::Failed);

        let execution = McpExecution {
            manager: Arc::new(aiden_mcp::McpClientManager::new()),
            tools: ChatMcpTools {
                defs: Vec::new(),
                dispatch: HashMap::new(),
            },
        };
        let snapshot =
            futures::executor::block_on(execute_tool_call(&mut projector, &execution, &call));
        assert!(snapshot.is_error);
        let timeline = projector.finish(TerminalTimelineStatus::Completed);
        let statuses: Vec<&str> = timeline
            .steps
            .iter()
            .filter_map(|step| match step {
                aiden_core::AgentStep::Tool(tool) => Some(match tool.status {
                    aiden_core::AgentStepStatus::Completed => "completed",
                    aiden_core::AgentStepStatus::Failed => "failed",
                    _ => "other",
                }),
                _ => None,
            })
            .collect();
        assert_eq!(statuses, vec!["failed", "failed"]);
    }
}
