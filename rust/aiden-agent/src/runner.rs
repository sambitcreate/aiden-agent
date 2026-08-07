//! The agent turn loop — the port of pi-agent-core's `runAgentLoop` as Aiden
//! wraps it in `llm-client.ts`.
//!
//! [`run_agent`] drives a [`Provider`] stream through its full lifecycle:
//!
//! - feed the system prompt + tool definitions on every provider request;
//! - stream text/thinking deltas as [`AgentEvent::Text`] /
//!   [`AgentEvent::Thinking`];
//! - on `toolcall_end` events, execute each tool through the injected
//!   [`ToolExecutor`] (sequential, mirroring the coding tools), gating
//!   mutating tools through the [`ApprovalPolicy`];
//! - append the assistant message + tool-result messages to the transcript and
//!   re-stream;
//! - on `done` with no tool calls, finish with [`AgentEvent::Done`];
//! - enforce the tool-loop guard rails: max tool iterations, repeated-identical
//!   call detection, and (for attended Assistant runs) the
//!   [`advance_attended_tool_error_state`] recovery turn.
//!
//! Streams-never-throw contract: every provider failure — a `stream_simple`
//! error, a stream item error, or a stream that ends without a terminal event —
//! surfaces as a terminal [`AgentEvent::Error`] followed by an
//! [`AgentOutcome`] with `status == Error`. The loop never panics on provider
//! input.

use std::collections::BTreeMap;

use aiden_core::{
    AssistantMessage, ContentBlock, Message, StopReason, TextContent, ToolCall, ToolDef,
    ToolResultMessage,
};
use aiden_providers::{provider_error_message, ApiFamily, Provider, StreamOptions, StreamRequest};
use async_trait::async_trait;
use futures::StreamExt;
use tokio::sync::mpsc;

use crate::approval::{ApprovalPolicy, ApprovalVerdict};
use crate::tool_loop_guard::{
    advance_attended_tool_error_state, recover_attended_tool_error_context, AgentContext,
    MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS,
};

/// Text (or image placeholder) produced by a tool execution.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutput {
    pub text: String,
    pub details: Option<serde_json::Value>,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            details: None,
        }
    }
}

/// A tool execution failure. The loop converts it into an error tool-result
/// message fed back to the model (mirroring pi's error tool results).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ToolExecutionError {
    #[error("{0}")]
    Message(String),
    #[error("Tool {0} not found")]
    NotFound(String),
}

/// The tool surface the loop dispatches to. `tool_defs` is what the provider
/// sees; `requires_approval` marks the mutating set gated by the approval
/// policy; `execute` runs a single call.
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Tool definitions exposed to the provider (name/description/schema).
    fn tool_defs(&self) -> Vec<ToolDef>;

    /// Whether a tool call must pause for approval before execution.
    fn requires_approval(&self, tool_name: &str) -> bool;

    /// Execute one tool call. Failures (including policy denials) are returned,
    /// never thrown across the loop boundary.
    async fn execute(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError>;
}

/// The unified event stream the runner emits over the mpsc channel.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    /// One assistant text delta.
    Text { delta: String },
    /// One thinking/reasoning delta.
    Thinking { delta: String },
    /// A tool call began executing (or was dispatched for approval).
    ToolStarted { name: String },
    /// A tool call finished, successfully or not.
    ToolFinished { name: String, ok: bool },
    /// A mutating tool paused for human approval. The details carry the
    /// renderer-safe approval facts; a UI-bound policy resolves it later.
    ApprovalRequired { details: serde_json::Value },
    /// The run finished with final assistant text.
    Done { content: String },
    /// The run failed terminally. Failures are always events — never panics.
    Error { message: String },
}

/// Why a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentOutcomeStatus {
    /// Finished normally with an assistant response.
    Done,
    /// Finished after the attended tool-error recovery turn.
    Recovered,
    /// A provider or stream failure.
    Error,
    /// Stopped by a loop guard (max iterations / repeated calls).
    GuardStopped,
}

/// The final result of [`run_agent`]: full transcript + outcome facts.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentOutcome {
    pub status: AgentOutcomeStatus,
    pub messages: Vec<Message>,
    pub final_text: String,
    pub error: Option<String>,
}

/// Runtime configuration for one agent run.
#[derive(Debug, Clone)]
pub struct RunnerConfig {
    pub provider_id: String,
    pub model: String,
    pub system_prompt: Option<String>,
    /// Provider credential passed through the stream options (resolved by the
    /// caller — keychain access never happens inside the loop).
    pub api_key: Option<String>,
    /// Maximum number of tool rounds (stream requests) before the guard stops
    /// the run.
    pub max_tool_iterations: usize,
    /// A tool-call signature (name + canonical arguments) repeated across this
    /// many consecutive rounds stops the run.
    pub max_repeated_calls: usize,
    /// Enables the attended Assistant tool-error guard: after
    /// [`MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS`] consecutive failing tool
    /// rounds, one host-directed text-only recovery turn runs, then the loop
    /// finishes.
    pub attended_tool_error_guard: bool,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            provider_id: String::new(),
            model: String::new(),
            system_prompt: None,
            api_key: None,
            max_tool_iterations: 10,
            max_repeated_calls: 3,
            attended_tool_error_guard: false,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn message_text(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn tool_result_message(call: &ToolCall, text: String, is_error: bool) -> ToolResultMessage {
    ToolResultMessage {
        tool_call_id: call.id.clone(),
        tool_name: call.name.clone(),
        content: vec![ContentBlock::Text(TextContent {
            text,
            text_signature: None,
        })],
        details: None,
        added_tool_names: None,
        is_error,
        timestamp: now_ms(),
    }
}

fn tool_calls_from_message(message: &AssistantMessage) -> Vec<ToolCall> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolCall(tool_call) => Some(tool_call.clone()),
            _ => None,
        })
        .collect()
}

/// Run one agent lifecycle over a provider stream, emitting [`AgentEvent`]s on
/// `tx`. The returned [`AgentOutcome`] carries the full transcript.
///
/// `initial_messages` is the conversation so far (typically ending with the
/// user's prompt).
pub async fn run_agent(
    provider: &dyn Provider,
    executor: &dyn ToolExecutor,
    policy: &dyn ApprovalPolicy,
    config: &RunnerConfig,
    initial_messages: Vec<Message>,
    tx: mpsc::Sender<AgentEvent>,
) -> AgentOutcome {
    let mut transcript = initial_messages;
    let mut consecutive_error_turns = 0usize;
    let mut recovery_pending = false;
    let mut tool_rounds = 0usize;
    let mut last_signatures: Option<Vec<(String, String)>> = None;
    let mut repeated_streak = 0usize;
    let mut final_text = String::new();

    loop {
        let tools = if recovery_pending {
            Vec::new()
        } else {
            executor.tool_defs()
        };
        let request = StreamRequest {
            provider_id: config.provider_id.clone(),
            api: ApiFamily::OpenAICompletions,
            model: config.model.clone(),
            system_prompt: config.system_prompt.clone(),
            messages: transcript.clone(),
            tools,
            ..Default::default()
        };
        let mut stream = match provider.stream_simple(
            &request,
            &StreamOptions {
                api_key: config.api_key.clone(),
                ..Default::default()
            },
        ) {
            Ok(stream) => stream,
            Err(err) => {
                let message = provider_error_message(&err);
                let _ = tx
                    .send(AgentEvent::Error {
                        message: message.clone(),
                    })
                    .await;
                return AgentOutcome {
                    status: AgentOutcomeStatus::Error,
                    messages: transcript,
                    final_text,
                    error: Some(message),
                };
            }
        };

        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut text_blocks: BTreeMap<usize, String> = BTreeMap::new();
        let mut thinking_blocks: BTreeMap<usize, String> = BTreeMap::new();
        let mut terminal: Option<(AssistantMessage, bool)> = None; // (message, is_error)

        while let Some(item) = stream.next().await {
            let event = match item {
                Ok(event) => event,
                Err(err) => {
                    let message = provider_error_message(&err);
                    let _ = tx
                        .send(AgentEvent::Error {
                            message: message.clone(),
                        })
                        .await;
                    return AgentOutcome {
                        status: AgentOutcomeStatus::Error,
                        messages: transcript,
                        final_text,
                        error: Some(message),
                    };
                }
            };
            match event {
                aiden_core::AssistantMessageEvent::Start { .. } => {}
                aiden_core::AssistantMessageEvent::TextStart { content_index, .. } => {
                    text_blocks.entry(content_index).or_default();
                }
                aiden_core::AssistantMessageEvent::TextDelta {
                    content_index,
                    delta,
                    ..
                } => {
                    text_blocks
                        .entry(content_index)
                        .or_default()
                        .push_str(&delta);
                    let _ = tx.send(AgentEvent::Text { delta }).await;
                }
                aiden_core::AssistantMessageEvent::TextEnd {
                    content_index,
                    content,
                    ..
                } => {
                    text_blocks.insert(content_index, content);
                }
                aiden_core::AssistantMessageEvent::ThinkingStart { content_index, .. } => {
                    thinking_blocks.entry(content_index).or_default();
                }
                aiden_core::AssistantMessageEvent::ThinkingDelta {
                    content_index,
                    delta,
                    ..
                } => {
                    thinking_blocks
                        .entry(content_index)
                        .or_default()
                        .push_str(&delta);
                    let _ = tx.send(AgentEvent::Thinking { delta }).await;
                }
                aiden_core::AssistantMessageEvent::ThinkingEnd {
                    content_index,
                    content,
                    ..
                } => {
                    thinking_blocks.insert(content_index, content);
                }
                aiden_core::AssistantMessageEvent::ToolcallStart { .. }
                | aiden_core::AssistantMessageEvent::ToolcallDelta { .. } => {}
                aiden_core::AssistantMessageEvent::ToolcallEnd { tool_call, .. } => {
                    tool_calls.push(tool_call);
                }
                aiden_core::AssistantMessageEvent::Done { message, .. } => {
                    terminal = Some((message, false));
                    break;
                }
                aiden_core::AssistantMessageEvent::Error { error, .. } => {
                    terminal = Some((error, true));
                    break;
                }
            }
        }

        let Some((message, is_error)) = terminal else {
            let message = "provider stream ended without a terminal event".to_string();
            let _ = tx
                .send(AgentEvent::Error {
                    message: message.clone(),
                })
                .await;
            return AgentOutcome {
                status: AgentOutcomeStatus::Error,
                messages: transcript,
                final_text,
                error: Some(message),
            };
        };

        if is_error
            || message.stop_reason == StopReason::Error
            || message.stop_reason == StopReason::Aborted
        {
            let error_text = message
                .error_message
                .clone()
                .unwrap_or_else(|| "provider stream error".to_string());
            let _ = tx
                .send(AgentEvent::Error {
                    message: error_text.clone(),
                })
                .await;
            return AgentOutcome {
                status: AgentOutcomeStatus::Error,
                messages: transcript,
                final_text,
                error: Some(error_text),
            };
        }

        let mut calls = tool_calls;
        if calls.is_empty() {
            calls = tool_calls_from_message(&message);
        }

        if recovery_pending {
            // One final text-only turn after the attended error guard tripped.
            final_text = message_text(&message);
            transcript.push(Message::Assistant(message));
            let _ = tx
                .send(AgentEvent::Done {
                    content: final_text.clone(),
                })
                .await;
            return AgentOutcome {
                status: AgentOutcomeStatus::Recovered,
                messages: transcript,
                final_text,
                error: None,
            };
        }

        if calls.is_empty() {
            final_text = message_text(&message);
            transcript.push(Message::Assistant(message));
            let _ = tx
                .send(AgentEvent::Done {
                    content: final_text.clone(),
                })
                .await;
            return AgentOutcome {
                status: AgentOutcomeStatus::Done,
                messages: transcript,
                final_text,
                error: None,
            };
        }

        // A tool round.
        tool_rounds += 1;
        if tool_rounds > config.max_tool_iterations {
            let error_text = "exceeded the maximum number of tool iterations".to_string();
            let _ = tx
                .send(AgentEvent::Error {
                    message: error_text.clone(),
                })
                .await;
            return AgentOutcome {
                status: AgentOutcomeStatus::GuardStopped,
                messages: transcript,
                final_text,
                error: Some(error_text),
            };
        }

        let signatures = call_signatures(&calls);
        if last_signatures.as_ref() == Some(&signatures) {
            repeated_streak += 1;
            if repeated_streak >= config.max_repeated_calls {
                let error_text =
                    "the model repeated the same tool calls without making progress".to_string();
                let _ = tx
                    .send(AgentEvent::Error {
                        message: error_text.clone(),
                    })
                    .await;
                return AgentOutcome {
                    status: AgentOutcomeStatus::GuardStopped,
                    messages: transcript,
                    final_text,
                    error: Some(error_text),
                };
            }
        } else {
            repeated_streak = 0;
        }
        last_signatures = Some(signatures);

        transcript.push(Message::Assistant(message.clone()));

        let mut results: Vec<ToolResultMessage> = Vec::new();
        if message.stop_reason == StopReason::Length {
            // A truncated response may carry silently incomplete arguments;
            // fail every call instead of executing potentially borked ones.
            for call in &calls {
                let _ = tx
                    .send(AgentEvent::ToolStarted {
                        name: call.name.clone(),
                    })
                    .await;
                let text = format!(
                    "Tool call \"{}\" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.",
                    call.name
                );
                let _ = tx
                    .send(AgentEvent::ToolFinished {
                        name: call.name.clone(),
                        ok: false,
                    })
                    .await;
                results.push(tool_result_message(call, text, true));
            }
        } else {
            for call in &calls {
                let _ = tx
                    .send(AgentEvent::ToolStarted {
                        name: call.name.clone(),
                    })
                    .await;
                let execution = match policy.evaluate(call) {
                    ApprovalVerdict::Allow => executor.execute(call).await,
                    ApprovalVerdict::Ask(request) => {
                        let details = request.details.clone();
                        let _ = tx.send(AgentEvent::ApprovalRequired { details }).await;
                        match policy.resolve(&request.approval_id).await {
                            Ok(()) => executor.execute(call).await,
                            Err(reason) => Err(ToolExecutionError::Message(reason)),
                        }
                    }
                    ApprovalVerdict::Deny { reason } => Err(ToolExecutionError::Message(reason)),
                };
                match execution {
                    Ok(output) => {
                        let _ = tx
                            .send(AgentEvent::ToolFinished {
                                name: call.name.clone(),
                                ok: true,
                            })
                            .await;
                        results.push(tool_result_message(call, output.text, false));
                    }
                    Err(err) => {
                        let _ = tx
                            .send(AgentEvent::ToolFinished {
                                name: call.name.clone(),
                                ok: false,
                            })
                            .await;
                        results.push(tool_result_message(call, err.to_string(), true));
                    }
                }
            }
        }

        for result in &results {
            transcript.push(Message::ToolResult(result.clone()));
        }

        if config.attended_tool_error_guard {
            let flags: Vec<bool> = results.iter().map(|result| result.is_error).collect();
            let state = advance_attended_tool_error_state(consecutive_error_turns, &flags);
            consecutive_error_turns = state.consecutive_error_turns;
            if state.should_stop {
                tracing::warn!(
                    "attended tool retries stopped after {MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS} consecutive failures; requesting a text-only recovery turn"
                );
                let context = AgentContext {
                    system_prompt: config.system_prompt.clone(),
                    messages: transcript.clone(),
                    tools: executor.tool_defs(),
                };
                let recovered = recover_attended_tool_error_context(context, now_ms());
                transcript = recovered.messages;
                recovery_pending = true;
            }
        }
    }
}

/// Canonical (name, arguments) signature of a tool-call batch, sorted, so that
/// identical repeated batches are detected regardless of order.
fn call_signatures(calls: &[ToolCall]) -> Vec<(String, String)> {
    let mut signatures: Vec<(String, String)> = calls
        .iter()
        .map(|call| {
            let arguments = aiden_core::canonical_parsed_json(&call.arguments)
                .unwrap_or_else(|_| "{}".to_string());
            (call.name.clone(), arguments)
        })
        .collect();
    signatures.sort();
    signatures
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{AllowAllApprovalPolicy, DenyAllApprovalPolicy};
    use aiden_core::{
        AssistantMessageEvent, StopReason, Usage, UsageCost, UserContent, UserMessage,
    };
    use aiden_providers::{ProviderError, ProviderInfo};
    use std::collections::VecDeque;

    // ---- fixtures ----------------------------------------------------------

    fn empty_message(stop_reason: StopReason) -> AssistantMessage {
        AssistantMessage {
            content: Vec::new(),
            api: "mock".to_string(),
            provider: "mock".to_string(),
            model: "mock-model".to_string(),
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
                cost: UsageCost {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total: 0.0,
                },
            },
            stop_reason,
            error_message: None,
            timestamp: 1,
        }
    }

    fn message_with_blocks(stop_reason: StopReason, blocks: Vec<ContentBlock>) -> AssistantMessage {
        let mut message = empty_message(stop_reason);
        message.content = blocks;
        message
    }

    fn text_event(text: &str) -> AssistantMessageEvent {
        AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: text.to_string(),
            partial: empty_message(StopReason::Stop),
        }
    }

    fn tool_call_block(id: &str, name: &str, args: serde_json::Value) -> ContentBlock {
        ContentBlock::ToolCall(ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: args,
            thought_signature: None,
        })
    }

    fn toolcall_end(id: &str, name: &str, args: serde_json::Value) -> AssistantMessageEvent {
        AssistantMessageEvent::ToolcallEnd {
            content_index: 0,
            tool_call: ToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments: args,
                thought_signature: None,
            },
            partial: empty_message(StopReason::ToolUse),
        }
    }

    fn done_event(message: AssistantMessage) -> AssistantMessageEvent {
        AssistantMessageEvent::Done {
            reason: message.stop_reason,
            message,
        }
    }

    fn error_event(message: &str) -> AssistantMessageEvent {
        let mut error = empty_message(StopReason::Error);
        error.error_message = Some(message.to_string());
        AssistantMessageEvent::Error {
            reason: StopReason::Error,
            error,
        }
    }

    /// A provider playing back a scripted queue of event sequences, one per
    /// `stream_simple` call. Optionally injects a stream-item error on the next
    /// call.
    struct MockProvider {
        info: ProviderInfo,
        scripts: std::sync::Mutex<VecDeque<Vec<AssistantMessageEvent>>>,
        next_failure: std::sync::Mutex<Option<String>>,
    }

    impl MockProvider {
        fn new(scripts: Vec<Vec<AssistantMessageEvent>>) -> Self {
            Self {
                info: ProviderInfo {
                    id: "mock".to_string(),
                    label: "Mock".to_string(),
                },
                scripts: std::sync::Mutex::new(scripts.into()),
                next_failure: std::sync::Mutex::new(None),
            }
        }

        fn fail_next(&self, message: &str) {
            *self.next_failure.lock().unwrap() = Some(message.to_string());
        }
    }

    impl Provider for MockProvider {
        fn info(&self) -> ProviderInfo {
            self.info.clone()
        }

        fn stream_simple(
            &self,
            _request: &StreamRequest,
            _options: &StreamOptions,
        ) -> Result<aiden_providers::EventStream, ProviderError> {
            if let Some(message) = self.next_failure.lock().unwrap().take() {
                return Ok(Box::pin(futures::stream::iter(vec![Err(
                    ProviderError::Stream(message),
                )])));
            }
            let events = self
                .scripts
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| vec![done_event(empty_message(StopReason::Stop))]);
            let stream = futures::stream::iter(events.into_iter().map(Ok));
            Ok(Box::pin(stream))
        }
    }

    /// An executor with a scripted result queue.
    struct MockExecutor {
        results: std::sync::Mutex<VecDeque<Result<ToolOutput, ToolExecutionError>>>,
    }

    impl MockExecutor {
        fn new(results: Vec<Result<ToolOutput, ToolExecutionError>>) -> Self {
            Self {
                results: std::sync::Mutex::new(results.into()),
            }
        }
    }

    #[async_trait]
    impl ToolExecutor for MockExecutor {
        fn tool_defs(&self) -> Vec<ToolDef> {
            vec![ToolDef {
                name: "read_file".to_string(),
                description: "Read a file.".to_string(),
                parameters: serde_json::json!({}),
            }]
        }

        fn requires_approval(&self, tool_name: &str) -> bool {
            crate::approval::requires_approval(tool_name)
        }

        async fn execute(&self, _call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
            self.results
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| ToolExecutionError::Message("no scripted result".to_string()))?
        }
    }

    fn config() -> RunnerConfig {
        RunnerConfig {
            provider_id: "mock".to_string(),
            model: "mock-model".to_string(),
            system_prompt: Some("You are Aiden.".to_string()),
            ..Default::default()
        }
    }

    fn initial_messages() -> Vec<Message> {
        vec![Message::User(UserMessage {
            content: UserContent::Text("Read src/main.rs".to_string()),
            timestamp: 1,
        })]
    }

    async fn collect(
        provider: &MockProvider,
        executor: &MockExecutor,
        policy: &dyn ApprovalPolicy,
        config: &RunnerConfig,
    ) -> (AgentOutcome, Vec<AgentEvent>) {
        let (tx, mut rx) = mpsc::channel(64);
        let outcome = run_agent(provider, executor, policy, config, initial_messages(), tx).await;
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        (outcome, events)
    }

    // ---- tests -------------------------------------------------------------

    #[tokio::test]
    async fn tool_call_then_result_then_done() {
        let tool_message = message_with_blocks(
            StopReason::ToolUse,
            vec![tool_call_block(
                "call-1",
                "read_file",
                serde_json::json!({"path": "src/main.rs"}),
            )],
        );
        let final_message = message_with_blocks(
            StopReason::Stop,
            vec![ContentBlock::Text(TextContent {
                text: "The file is empty.".to_string(),
                text_signature: None,
            })],
        );
        let provider = MockProvider::new(vec![
            vec![
                text_event("Let me check."),
                toolcall_end(
                    "call-1",
                    "read_file",
                    serde_json::json!({"path": "src/main.rs"}),
                ),
                done_event(tool_message),
            ],
            vec![text_event("The file is empty."), done_event(final_message)],
        ]);
        let executor = MockExecutor::new(vec![Ok(ToolOutput::text("result"))]);
        let policy = AllowAllApprovalPolicy::new();

        let (outcome, events) = collect(&provider, &executor, &policy, &config()).await;

        assert_eq!(outcome.status, AgentOutcomeStatus::Done);
        assert_eq!(outcome.final_text, "The file is empty.");
        assert_eq!(
            events,
            vec![
                AgentEvent::Text {
                    delta: "Let me check.".to_string()
                },
                AgentEvent::ToolStarted {
                    name: "read_file".to_string()
                },
                AgentEvent::ToolFinished {
                    name: "read_file".to_string(),
                    ok: true
                },
                AgentEvent::Text {
                    delta: "The file is empty.".to_string()
                },
                AgentEvent::Done {
                    content: "The file is empty.".to_string()
                },
            ]
        );
        // Transcript: user, assistant(tool call), toolResult, assistant.
        let roles: Vec<&str> = outcome
            .messages
            .iter()
            .map(|message| match message {
                Message::User(_) => "user",
                Message::Assistant(_) => "assistant",
                Message::ToolResult(_) => "toolResult",
            })
            .collect();
        assert_eq!(roles, ["user", "assistant", "toolResult", "assistant"]);
        match &outcome.messages[2] {
            Message::ToolResult(result) => {
                assert_eq!(result.tool_name, "read_file");
                assert!(!result.is_error);
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn repeated_tool_errors_trip_the_attended_recovery_guard() {
        let tool_message = message_with_blocks(
            StopReason::ToolUse,
            vec![tool_call_block(
                "call-1",
                "read_file",
                serde_json::json!({"path": "x"}),
            )],
        );
        let recovery_message = message_with_blocks(
            StopReason::Stop,
            vec![ContentBlock::Text(TextContent {
                text: "I couldn't complete that action after two tool attempts.".to_string(),
                text_signature: None,
            })],
        );
        let provider = MockProvider::new(vec![
            vec![
                toolcall_end("call-1", "read_file", serde_json::json!({"path": "x"})),
                done_event(tool_message.clone()),
            ],
            vec![
                toolcall_end("call-1", "read_file", serde_json::json!({"path": "x"})),
                done_event(tool_message.clone()),
            ],
            vec![text_event("Recovered."), done_event(recovery_message)],
        ]);
        let executor = MockExecutor::new(vec![
            Err(ToolExecutionError::Message("boom".to_string())),
            Err(ToolExecutionError::Message("boom".to_string())),
        ]);
        let policy = AllowAllApprovalPolicy::new();
        let mut cfg = config();
        cfg.attended_tool_error_guard = true;

        let (outcome, events) = collect(&provider, &executor, &policy, &cfg).await;

        assert_eq!(outcome.status, AgentOutcomeStatus::Recovered);
        let finished: Vec<bool> = events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::ToolFinished { ok, .. } => Some(*ok),
                _ => None,
            })
            .collect();
        assert_eq!(finished, [false, false]);
        // The recovery user message was appended to the transcript.
        let recovery_present = outcome.messages.iter().any(|message| match message {
            Message::User(user) => {
                matches!(&user.content, UserContent::Text(text) if text.contains("[Aiden host guard]"))
            }
            _ => false,
        });
        assert!(recovery_present);
        // The final Done carries the recovery turn's text.
        let done_events: Vec<&AgentEvent> = events
            .iter()
            .filter(|event| matches!(event, AgentEvent::Done { .. }))
            .collect();
        assert_eq!(done_events.len(), 1);
    }

    #[tokio::test]
    async fn provider_error_is_a_terminal_error_event() {
        let provider = MockProvider::new(vec![vec![error_event("boom")]]);
        let executor = MockExecutor::new(vec![]);
        let policy = AllowAllApprovalPolicy::new();

        let (outcome, events) = collect(&provider, &executor, &policy, &config()).await;

        assert_eq!(outcome.status, AgentOutcomeStatus::Error);
        assert_eq!(outcome.error.as_deref(), Some("boom"));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::Error { message }) if message == "boom"
        ));
    }

    #[tokio::test]
    async fn a_stream_item_error_is_also_terminal() {
        let provider = MockProvider::new(vec![]);
        provider.fail_next("transport broke");
        let executor = MockExecutor::new(vec![]);
        let policy = AllowAllApprovalPolicy::new();

        let (outcome, events) = collect(&provider, &executor, &policy, &config()).await;

        assert_eq!(outcome.status, AgentOutcomeStatus::Error);
        assert_eq!(outcome.error.as_deref(), Some("transport broke"));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::Error { message }) if message == "transport broke"
        ));
    }

    #[tokio::test]
    async fn max_tool_iterations_stops_the_loop() {
        let tool_message = message_with_blocks(
            StopReason::ToolUse,
            vec![tool_call_block(
                "call-1",
                "read_file",
                serde_json::json!({"path": "x"}),
            )],
        );
        let provider = MockProvider::new(vec![
            vec![
                toolcall_end("call-1", "read_file", serde_json::json!({"path": "x"})),
                done_event(tool_message.clone()),
            ],
            vec![
                toolcall_end("call-2", "read_file", serde_json::json!({"path": "y"})),
                done_event(tool_message),
            ],
        ]);
        let executor =
            MockExecutor::new(vec![Ok(ToolOutput::text("r1")), Ok(ToolOutput::text("r2"))]);
        let policy = AllowAllApprovalPolicy::new();
        let mut cfg = config();
        cfg.max_tool_iterations = 1;

        let (outcome, events) = collect(&provider, &executor, &policy, &cfg).await;

        assert_eq!(outcome.status, AgentOutcomeStatus::GuardStopped);
        assert!(outcome
            .error
            .as_deref()
            .unwrap()
            .contains("tool iterations"));
        assert!(matches!(events.last(), Some(AgentEvent::Error { .. })));
    }

    #[tokio::test]
    async fn repeated_identical_calls_stop_the_loop() {
        let tool_message = message_with_blocks(
            StopReason::ToolUse,
            vec![tool_call_block(
                "call-1",
                "read_file",
                serde_json::json!({"path": "x"}),
            )],
        );
        let provider = MockProvider::new(vec![
            vec![
                toolcall_end("call-1", "read_file", serde_json::json!({"path": "x"})),
                done_event(tool_message.clone()),
            ],
            vec![
                toolcall_end("call-1", "read_file", serde_json::json!({"path": "x"})),
                done_event(tool_message.clone()),
            ],
            vec![
                toolcall_end("call-1", "read_file", serde_json::json!({"path": "x"})),
                done_event(tool_message.clone()),
            ],
        ]);
        let executor = MockExecutor::new(vec![
            Ok(ToolOutput::text("r1")),
            Ok(ToolOutput::text("r2")),
            Ok(ToolOutput::text("r3")),
        ]);
        let policy = AllowAllApprovalPolicy::new();
        let mut cfg = config();
        cfg.max_repeated_calls = 2;

        let (outcome, events) = collect(&provider, &executor, &policy, &cfg).await;

        assert_eq!(outcome.status, AgentOutcomeStatus::GuardStopped);
        assert!(outcome
            .error
            .as_deref()
            .unwrap()
            .contains("repeated the same tool calls"));
        assert!(matches!(events.last(), Some(AgentEvent::Error { .. })));
    }

    #[tokio::test]
    async fn denied_tools_become_error_results_without_execution() {
        let tool_message = message_with_blocks(
            StopReason::ToolUse,
            vec![tool_call_block(
                "call-1",
                "write_file",
                serde_json::json!({"path": "x"}),
            )],
        );
        let final_message = message_with_blocks(
            StopReason::Stop,
            vec![ContentBlock::Text(TextContent {
                text: "Blocked, I will not write.".to_string(),
                text_signature: None,
            })],
        );
        let provider = MockProvider::new(vec![
            vec![
                toolcall_end("call-1", "write_file", serde_json::json!({"path": "x"})),
                done_event(tool_message),
            ],
            vec![
                text_event("Blocked, I will not write."),
                done_event(final_message),
            ],
        ]);
        // No results scripted: the deny-all policy must block before execute.
        let executor = MockExecutor::new(vec![]);
        let policy = DenyAllApprovalPolicy::new();

        let (outcome, events) = collect(&provider, &executor, &policy, &config()).await;

        assert_eq!(outcome.status, AgentOutcomeStatus::Done);
        let tool_finished: Vec<bool> = events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::ToolFinished { ok, .. } => Some(*ok),
                _ => None,
            })
            .collect();
        assert_eq!(tool_finished, [false]);
        // The transcript carries an error tool result with the denial reason.
        match &outcome.messages[2] {
            Message::ToolResult(result) => {
                assert!(result.is_error);
                match &result.content[0] {
                    ContentBlock::Text(text_block) => {
                        assert!(text_block.text.contains("requires approval"));
                    }
                    other => panic!("expected text block, got {other:?}"),
                }
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn approval_required_is_emitted_before_an_ask_policy_resolves() {
        let tool_message = message_with_blocks(
            StopReason::ToolUse,
            vec![tool_call_block(
                "call-1",
                "write_file",
                serde_json::json!({"path": "x"}),
            )],
        );
        let final_message = message_with_blocks(
            StopReason::Stop,
            vec![ContentBlock::Text(TextContent {
                text: "Done.".to_string(),
                text_signature: None,
            })],
        );
        let provider = MockProvider::new(vec![
            vec![
                toolcall_end("call-1", "write_file", serde_json::json!({"path": "x"})),
                done_event(tool_message),
            ],
            vec![text_event("Done."), done_event(final_message)],
        ]);
        let executor = MockExecutor::new(vec![Ok(ToolOutput::text("written"))]);

        struct AskThenAllow;
        #[async_trait]
        impl ApprovalPolicy for AskThenAllow {
            fn evaluate(&self, call: &ToolCall) -> ApprovalVerdict {
                if call.name == "write_file" {
                    ApprovalVerdict::Ask(crate::approval::ApprovalRequest {
                        approval_id: "approval-1".to_string(),
                        tool_name: call.name.clone(),
                        summary: "Create or replace file: x".to_string(),
                        details: serde_json::json!({ "tool": "write_file", "path": "x" }),
                    })
                } else {
                    ApprovalVerdict::Allow
                }
            }
            async fn resolve(&self, approval_id: &str) -> Result<(), String> {
                assert_eq!(approval_id, "approval-1");
                Ok(())
            }
        }

        let (outcome, events) = collect(&provider, &executor, &AskThenAllow, &config()).await;

        assert_eq!(outcome.status, AgentOutcomeStatus::Done);
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::ApprovalRequired { details } if details["tool"] == "write_file")));
        let tool_finished: Vec<bool> = events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::ToolFinished { ok, .. } => Some(*ok),
                _ => None,
            })
            .collect();
        assert_eq!(tool_finished, [true]);
    }
}
