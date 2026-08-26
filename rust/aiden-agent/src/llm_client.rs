//! Chat generation orchestration — port of `main/services/llm-client.ts`.
//!
//! ## What `llm-client.ts` turned out to be
//!
//! Reading the 1,860-line TS file: it is the **Pi agent-loop glue** — not an
//! LLM client itself. One `Agent` (pi-agent-core) runs per generation and owns
//! the multi-step tool loop; `llm-client.ts` composes it: per-stream admission
//! gates (turn lease, deletion/workspace/computer-use mutation gates), system
//! prompt + tool assembly, the streaming subscribe handler that feeds the
//! renderer (`chat:delta` / `chat:reasoning-delta` / `chat:tool` /
//! `chat:timeline` / `chat:status`), approval coordination, usage accounting,
//! terminal persistence, cancellation, and the two-phase shutdown drain. The
//! agent loop itself is already ported in this crate's `runner` module, so
//! this module ports the **essential orchestration** around it:
//!
//! - [`ChatStartParams`] + [`to_pi_messages`] (message assembly,
//!   `generation-messages.ts`);
//! - the pure `generation-runtime.ts` contract the driver needs (thinking
//!   resolution, image gating, terminal-message handling, bounded cleanup);
//! - [`TimelineProjector`] — renderer-safe tool/thinking activity recording
//!   against `aiden-core::GenerationTimeline` (`generation-timeline.ts`);
//! - [`ChatTurnAdmission`] + [`start_generation_and_maybe_title`] +
//!   [`is_explicit_user_stop`] (`chat-turn-admission.ts`, `chat-generation-start.ts`,
//!   `chat-cancel.ts`);
//! - [`GenerationManager`] — generation start/stop/cancel/shutdown with the
//!   stream/chat admission gates, a terminal-message **usage capture hook**,
//!   and the settled-notification hook. The Electron-specific renderer-owner,
//!   deletion/workspace/computer-use mutation gates, and subagent wiring are
//!   intentionally out of scope for this module (separate services in the
//!   TS; their gates are noted where the manager admits work).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use aiden_core::anthropic_thinking::{
    anthropic_thinking_levels_for_model, is_anthropic_thinking_level,
    normalize_anthropic_thinking_level, AnthropicThinkingModelCapabilities,
};
use aiden_core::codex_thinking::{
    codex_thinking_levels_for_model, is_codex_thinking_level, normalize_codex_thinking_level,
    CodexThinkingModelCapabilities,
};
use aiden_core::google_thinking::{
    google_thinking_levels_for_model, is_google_thinking_level, GoogleThinkingModelCapabilities,
};
use aiden_core::{
    AgentStep, AgentStepStatus, AgentThinkingStep, AgentToolStep, AssistantMessage, AttachmentKind,
    ChatMessage, ChatRole, ContentBlock, GenerationThinkingLevel, GenerationTimeline,
    GenerationTimelineStatus, ImageContent, Message, StopReason, TextContent, ThinkingContent,
    Usage, UsageCost, UserBlock, UserContent, UserMessage, GENERATION_TIMELINE_VERSION,
};
use aiden_providers::catalog::{Modality, Model};
use aiden_providers::codex::OPENAI_CODEX_PROVIDER_ID;
use aiden_providers::google::GOOGLE_PROVIDER_ID;
use async_trait::async_trait;
use serde::Serialize;

use crate::tool_approval::AbortSignal;

/// `ANTHROPIC_PROVIDER_ID` (`main/services/anthropic-provider.ts`). Defined
/// here until the anthropic provider module exports it.
pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";

/// `isExplicitUserStop` — only the visible Stop control may produce
/// packaged-acceptance Stop evidence.
pub fn is_explicit_user_stop(value: Option<&str>) -> bool {
    value == Some("user_stop")
}

// ===========================================================================
// ChatStartParams + message assembly (generation-messages.ts)
// ===========================================================================

/// `ChatStartParams` in `main/services/types.ts` (the fields the Rust driver
/// needs; attachments are carried by the [`ChatMessage`]s).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStartParams {
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub provider_id: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<ChatStartMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<GenerationThinkingLevel>,
    pub messages: Vec<ChatMessage>,
}

/// The `mode` union; absent means the normal workspace chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatStartMode {
    Assistant,
    AssistantUnattended,
    AssistantAutomation,
}

const ZERO_USAGE: Usage = Usage {
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
};

/// Rehydrate Aiden chat history using the generation's exact image gate
/// (`toPiMessages`).
pub fn project_user_chat_message(
    message: &ChatMessage,
    supports_images: bool,
    timestamp: u64,
) -> UserMessage {
    let attachments = message.attachments.clone().unwrap_or_default();
    if attachments.is_empty() {
        return UserMessage {
            content: UserContent::Text(message.content.clone()),
            timestamp,
        };
    }
    let text_files = attachments
        .iter()
        .filter(|attachment| attachment.kind == AttachmentKind::Text && attachment.text.is_some())
        .collect::<Vec<_>>();
    let text_prefix = text_files
        .iter()
        .map(|attachment| {
            format!(
                "Attached file: {}\n```\n{}\n```",
                attachment.name,
                attachment.text.as_ref().unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let combined = [text_prefix, message.content.clone()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut parts: Vec<UserBlock> = Vec::new();
    if !combined.is_empty() {
        parts.push(UserBlock::Text(TextContent {
            text: combined,
            text_signature: None,
        }));
    }
    if supports_images {
        for attachment in &attachments {
            if attachment.kind == AttachmentKind::Image && attachment.data.is_some() {
                parts.push(UserBlock::Image(ImageContent {
                    data: attachment.data.clone().unwrap(),
                    mime_type: attachment.mime_type.clone(),
                }));
            }
        }
    }
    let content = if parts.is_empty() {
        UserContent::Text(message.content.clone())
    } else {
        UserContent::Blocks(parts)
    };
    UserMessage { content, timestamp }
}

pub fn to_pi_messages(
    params: &ChatStartParams,
    api: &str,
    provider: &str,
    model: &str,
    supports_images: bool,
) -> Vec<Message> {
    let now = now_ms();
    params
        .messages
        .iter()
        .map(|message| match message.role {
            ChatRole::Assistant => Message::Assistant(AssistantMessage {
                content: vec![ContentBlock::Text(TextContent {
                    text: message.content.clone(),
                    text_signature: None,
                })],
                api: api.to_string(),
                provider: provider.to_string(),
                model: model.to_string(),
                response_model: None,
                response_id: None,
                usage: ZERO_USAGE,
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: now,
            }),
            _ => Message::User(project_user_chat_message(message, supports_images, now)),
        })
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

// ===========================================================================
// generation-runtime.ts pure contract
// ===========================================================================

/// `runtimeSupportsImages` — the connection-bound runtime model is the sole
/// request-time image authority.
pub fn runtime_supports_images(model: &Model) -> bool {
    model.input.contains(&Modality::Image)
}

fn capabilities(
    reasoning: bool,
    thinking_level_map: Option<&HashMap<String, Option<String>>>,
) -> (
    GoogleThinkingModelCapabilities,
    CodexThinkingModelCapabilities,
    AnthropicThinkingModelCapabilities,
) {
    let thinking_level_map =
        thinking_level_map.map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
    (
        GoogleThinkingModelCapabilities {
            reasoning: Some(reasoning),
            thinking_level_map: thinking_level_map.clone(),
        },
        CodexThinkingModelCapabilities {
            reasoning: Some(reasoning),
            thinking_level_map: thinking_level_map.clone(),
        },
        AnthropicThinkingModelCapabilities {
            reasoning: Some(reasoning),
            thinking_level_map,
        },
    )
}

/// `resolveGenerationThinkingLevel` — fail closed outside Aiden's native,
/// reasoning-capable provider contracts.
pub fn resolve_generation_thinking_level(
    provider_id: &str,
    model: &Model,
    requested: Option<GenerationThinkingLevel>,
) -> GenerationThinkingLevel {
    let (google, codex, anthropic) =
        capabilities(model.reasoning, model.thinking_level_map.as_ref());
    if provider_id == GOOGLE_PROVIDER_ID {
        let levels = google_thinking_levels_for_model(&google);
        let accepted = requested.is_some_and(|requested| {
            is_google_thinking_level(&serde_json::json!(requested.as_str()))
                && levels
                    .iter()
                    .any(|level| level.as_str() == requested.as_str())
        });
        return if accepted {
            requested.unwrap()
        } else {
            GenerationThinkingLevel::Off
        };
    }
    if provider_id == OPENAI_CODEX_PROVIDER_ID {
        let levels = codex_thinking_levels_for_model(&codex);
        if levels.is_empty() {
            return GenerationThinkingLevel::Off;
        }
        let accepted = requested.is_some_and(|requested| {
            is_codex_thinking_level(&serde_json::json!(requested.as_str()))
                && levels
                    .iter()
                    .any(|level| level.as_str() == requested.as_str())
        });
        return if accepted {
            requested.unwrap()
        } else {
            to_generation_level(
                normalize_codex_thinking_level(&levels, &serde_json::Value::Null).as_str(),
            )
        };
    }
    if provider_id == ANTHROPIC_PROVIDER_ID {
        let levels = anthropic_thinking_levels_for_model(&anthropic);
        if levels.is_empty() {
            return GenerationThinkingLevel::Off;
        }
        let accepted = requested.is_some_and(|requested| {
            is_anthropic_thinking_level(&serde_json::json!(requested.as_str()))
                && levels
                    .iter()
                    .any(|level| level.as_str() == requested.as_str())
        });
        return if accepted {
            requested.unwrap()
        } else {
            to_generation_level(
                normalize_anthropic_thinking_level(&levels, &serde_json::Value::Null).as_str(),
            )
        };
    }
    GenerationThinkingLevel::Off
}

fn to_generation_level(level: &str) -> GenerationThinkingLevel {
    GenerationThinkingLevel::from_str(level).unwrap_or(GenerationThinkingLevel::Off)
}

/// `terminalGenerationError` — extract a Pi protocol-level terminal error.
pub fn terminal_generation_error(message: &AssistantMessage) -> Option<String> {
    if message.stop_reason != StopReason::Error {
        return None;
    }
    let trimmed = message
        .error_message
        .as_ref()
        .map(|message| message.trim())
        .filter(|message| !message.is_empty());
    Some(
        trimmed
            .map(str::to_string)
            .unwrap_or_else(|| "The model couldn't complete this response.".to_string()),
    )
}

/// `terminalGenerationWasAborted` — Pi reports user-initiated stops as a
/// terminal assistant message as well.
pub fn terminal_generation_was_aborted(message: &AssistantMessage) -> bool {
    message.stop_reason == StopReason::Aborted
}

/// `terminalGenerationInterruptionError` — only app-owned cancellation is a
/// successful stop; dependency aborts are interruptions.
pub fn terminal_generation_interruption_error(
    was_aborted: bool,
    cancel_requested: bool,
) -> Option<String> {
    if was_aborted && !cancel_requested {
        Some("The response was interrupted before it finished. Try again.".to_string())
    } else {
        None
    }
}

/// `terminalAssistantText` — return final text when a provider completes
/// without emitting text deltas.
pub fn terminal_assistant_text(message: &AssistantMessage) -> String {
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

/// `terminalAssistantTextFallback` — add terminal text only when this turn did
/// not already stream it.
pub fn terminal_assistant_text_fallback(
    message: &AssistantMessage,
    received_text_delta: bool,
) -> String {
    if received_text_delta {
        String::new()
    } else {
        terminal_assistant_text(message)
    }
}

/// `terminalAssistantReasoning` — visible, non-redacted thinking blocks.
pub fn terminal_assistant_reasoning(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Thinking(ThinkingContent {
                thinking,
                redacted: Some(true),
                ..
            }) => {
                let _ = thinking;
                None
            }
            ContentBlock::Thinking(ThinkingContent { thinking, .. }) => Some(thinking.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `terminalAssistantReasoningFallback`.
pub fn terminal_assistant_reasoning_fallback(
    message: &AssistantMessage,
    received_reasoning_delta: bool,
) -> String {
    if received_reasoning_delta {
        String::new()
    } else {
        terminal_assistant_reasoning(message)
    }
}

/// A synchronous transcript reset.
pub type CleanupReset = Box<dyn FnOnce() + Send>;
/// A helper/process close producing an async teardown future.
pub type CleanupClose = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;
/// A pending completion future (agent loop, provider drain).
pub type CleanupCompletion = Pin<Box<dyn Future<Output = ()> + Send>>;

/// One generation's cleanup entry (`GenerationCleanupEntry`): synchronous
/// transcript reset, optional helper/process close, optional completion.
pub struct GenerationCleanupEntry {
    pub reset: CleanupReset,
    pub close: Option<CleanupClose>,
    pub completion: Option<CleanupCompletion>,
}

impl GenerationCleanupEntry {
    pub fn new(reset: impl FnOnce() + Send + 'static) -> Self {
        Self {
            reset: Box::new(reset),
            close: None,
            completion: None,
        }
    }
}

/// `settleGenerationCleanup` — clear in-memory transcripts synchronously,
/// then bound all slower helper/process and provider-loop teardown behind one
/// deadline.
pub async fn settle_generation_cleanup(
    entries: Vec<GenerationCleanupEntry>,
    grace_ms: u64,
    on_reset_error: &dyn Fn(&str),
) -> bool {
    let mut operations: Vec<CleanupCompletion> = Vec::new();
    for entry in entries {
        let reset = entry.reset;
        let reset_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(reset));
        if let Err(payload) = reset_result {
            on_reset_error(&panic_message(&payload));
        }
        if let Some(close) = entry.close {
            operations.push(close());
        }
        if let Some(completion) = entry.completion {
            operations.push(completion);
        }
    }
    if operations.is_empty() {
        return true;
    }
    let all = futures::future::join_all(operations);
    tokio::time::timeout(std::time::Duration::from_millis(grace_ms), all)
        .await
        .is_ok()
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "agent reset panicked".to_string()
    }
}

/// `waitForGenerationStateClear` — an aborted generation can still be in setup
/// when shutdown starts, or hand off to active state during that abort. Wait
/// for both maps to clear under the caller's existing deadline.
pub async fn wait_for_generation_state_clear<B, C>(
    is_busy: B,
    completions: C,
    deadline_ms: u64,
) -> bool
where
    B: Fn() -> bool,
    C: Fn() -> Vec<Pin<Box<dyn Future<Output = ()> + Send>>>,
{
    while is_busy() {
        let now = now_ms();
        let remaining = deadline_ms.saturating_sub(now);
        if remaining == 0 {
            return false;
        }
        let pending = completions();
        let pause = tokio::time::sleep(std::time::Duration::from_millis(remaining.min(25)));
        if pending.is_empty() {
            pause.await;
            continue;
        }
        let all = futures::future::join_all(pending);
        tokio::select! {
            _ = all => {}
            _ = pause => {}
        }
    }
    true
}

// ===========================================================================
// Timeline projector (generation-timeline.ts)
// ===========================================================================

const MAX_TOOL_NAME_LENGTH: usize = 80;
const MAX_TARGET_LENGTH: usize = 240;
const MAX_DETAIL_LENGTH: usize = 120;

/// The renderer-safe descriptor of one tool call
/// (`SafeToolDescriptor`): label + optional relative target + optional
/// one-line detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeToolDescriptor {
    pub label: String,
    pub target: Option<String>,
    pub detail: Option<String>,
}

fn safe_tool_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_alphabetic()
                || character.is_numeric()
                || matches!(character, '_' | ':' | '.' | '-')
            {
                character
            } else {
                ' '
            }
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "tool".to_string()
    } else {
        cleaned.chars().take(MAX_TOOL_NAME_LENGTH).collect()
    }
}

/// Collapse backslashes and drop non-printable code points before the
/// relative-target validation.
fn safe_relative_target(value: &serde_json::Value) -> Option<String> {
    let value = value.as_str()?;
    let cleaned: String = value
        .replace('\\', "/")
        .chars()
        .filter(|character| {
            let code = *character as u32;
            code > 31 && code != 127
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty()
        || cleaned.starts_with('/')
        || cleaned.starts_with('~')
        || windows_absolute_path(cleaned)
    {
        return None;
    }
    let segments: Vec<&str> = cleaned
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    if segments.contains(&"..") {
        return None;
    }
    let joined = segments.join("/");
    if joined.is_empty() {
        None
    } else {
        Some(joined.chars().take(MAX_TARGET_LENGTH).collect())
    }
}

fn windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// One printable feed line; control characters collapse to spaces.
fn safe_detail(value: &serde_json::Value) -> Option<String> {
    let value = value.as_str()?;
    let collapsed: String = value
        .chars()
        .map(|character| {
            let code = character as u32;
            if code < 32 || code == 127 {
                ' '
            } else {
                character
            }
        })
        .collect();
    let normalized = collapsed.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(
            trimmed
                .chars()
                .take(MAX_DETAIL_LENGTH)
                .collect::<String>()
                .trim()
                .to_string(),
        )
    }
}

fn title_case_tool_name(tool_name: &str) -> String {
    safe_tool_name(tool_name)
        .split(['_', ':', '.', '-'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `safeToolDescriptor` — project a tool call onto the renderer-safe fields
/// the activity feed reads. `detail` is opt-in per tool; shell commands and
/// file contents never qualify.
pub fn safe_tool_descriptor(tool_name: &str, args: &serde_json::Value) -> SafeToolDescriptor {
    let values = args.as_object().cloned().unwrap_or_default();
    let path = values
        .get("path")
        .or_else(|| values.get("filePath"))
        .or_else(|| values.get("directory"))
        .and_then(safe_relative_target);
    match tool_name {
        "read_file" => SafeToolDescriptor {
            label: "Read file".to_string(),
            target: path,
            detail: None,
        },
        "list_dir" => SafeToolDescriptor {
            label: "List directory".to_string(),
            target: path,
            detail: None,
        },
        "glob" => SafeToolDescriptor {
            label: "Find files".to_string(),
            target: None,
            detail: values.get("pattern").and_then(safe_detail),
        },
        "grep" => SafeToolDescriptor {
            label: "Search files".to_string(),
            target: path,
            detail: values.get("pattern").and_then(safe_detail),
        },
        "write_file" => SafeToolDescriptor {
            label: "Write file".to_string(),
            target: path,
            detail: None,
        },
        "edit_file" => SafeToolDescriptor {
            label: "Edit file".to_string(),
            target: path,
            detail: None,
        },
        "run_command" => SafeToolDescriptor {
            label: "Run command".to_string(),
            target: None,
            detail: values.get("description").and_then(safe_detail),
        },
        "web_search" => SafeToolDescriptor {
            label: "Web search".to_string(),
            target: None,
            detail: values.get("query").and_then(safe_detail),
        },
        "schedule_task" => SafeToolDescriptor {
            label: "Schedule task".to_string(),
            target: None,
            detail: values.get("action").and_then(safe_detail),
        },
        "computer_use" => SafeToolDescriptor {
            label: "Use Mac".to_string(),
            target: None,
            detail: values.get("action").and_then(safe_detail),
        },
        _ => {
            let label = title_case_tool_name(tool_name);
            SafeToolDescriptor {
                label: if label.is_empty() {
                    "Use tool".to_string()
                } else {
                    label
                },
                target: None,
                detail: None,
            }
        }
    }
}

/// `GenerationTimelineProjector` — records tool and thinking activity as
/// renderer-safe [`GenerationTimeline`] milestones and publishes a snapshot on
/// every transition.
pub struct TimelineProjector {
    publish: Box<dyn Fn(&GenerationTimeline) + Send + Sync>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    timeline: GenerationTimeline,
    step_index: HashMap<String, usize>,
    tool_sequence: usize,
    thinking_sequence: usize,
    open_thinking: Option<(usize, u64)>,
}

impl TimelineProjector {
    pub fn new(
        generation_id: impl Into<String>,
        publish: Box<dyn Fn(&GenerationTimeline) + Send + Sync>,
    ) -> Self {
        Self::with_clock(generation_id, publish, Box::new(now_ms))
    }

    pub fn with_clock(
        generation_id: impl Into<String>,
        publish: Box<dyn Fn(&GenerationTimeline) + Send + Sync>,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        let generation_id = generation_id.into();
        let started_at = now();
        Self {
            publish,
            now,
            timeline: GenerationTimeline {
                version: GENERATION_TIMELINE_VERSION,
                generation_id,
                status: GenerationTimelineStatus::Running,
                started_at,
                finished_at: None,
                steps: Vec::new(),
                claim_check: None,
            },
            step_index: HashMap::new(),
            tool_sequence: 0,
            thinking_sequence: 0,
            open_thinking: None,
        }
    }

    /// `toolStarted` — a tool call began (provider call id → public step id).
    pub fn tool_started(&mut self, tool_call_id: &str, tool_name: &str, args: &serde_json::Value) {
        if self.timeline.status != GenerationTimelineStatus::Running
            || self.step_index.contains_key(tool_call_id)
        {
            return;
        }
        let timestamp = (self.now)();
        let descriptor = safe_tool_descriptor(tool_name, args);
        self.tool_sequence += 1;
        let step = AgentToolStep {
            id: format!("tool-{}", self.tool_sequence),
            order: self.timeline.steps.len(),
            tool_call_id: format!("call-{}", self.tool_sequence),
            tool_name: safe_tool_name(tool_name),
            label: descriptor.label,
            status: AgentStepStatus::Pending,
            started_at: timestamp,
            updated_at: timestamp,
            finished_at: None,
            target: descriptor.target,
            detail: descriptor.detail,
        };
        self.step_index
            .insert(tool_call_id.to_string(), self.timeline.steps.len());
        self.timeline.steps.push(AgentStep::Tool(step));
        self.emit();
    }

    /// `thinkingStarted` — consecutive reasoning blocks merge into the single
    /// stretch the user perceives, timed against the host clock.
    pub fn thinking_started(&mut self) {
        if self.timeline.status != GenerationTimelineStatus::Running || self.open_thinking.is_some()
        {
            return;
        }
        let timestamp = (self.now)();
        let last_is_thinking = self
            .timeline
            .steps
            .last()
            .is_some_and(|step| matches!(step, AgentStep::Thinking(_)));
        if last_is_thinking {
            self.open_thinking = Some((self.timeline.steps.len() - 1, timestamp));
            return;
        }
        self.thinking_sequence += 1;
        let step = AgentThinkingStep {
            id: format!("think-{}", self.thinking_sequence),
            order: self.timeline.steps.len(),
            started_at: timestamp,
            updated_at: timestamp,
            finished_at: None,
            duration_ms: Some(0),
        };
        self.open_thinking = Some((self.timeline.steps.len(), timestamp));
        self.timeline.steps.push(AgentStep::Thinking(step));
        self.emit();
    }

    /// `thinkingEnded` — settle the open reasoning stretch.
    pub fn thinking_ended(&mut self) {
        if self.timeline.status != GenerationTimelineStatus::Running || self.open_thinking.is_none()
        {
            return;
        }
        self.settle_thinking((self.now)());
        self.emit();
    }

    /// `publicToolCallId` — map a provider call id to the renderer-safe one.
    pub fn public_tool_call_id(&self, tool_call_id: &str) -> Option<String> {
        let index = self.step_index.get(tool_call_id)?;
        match self.timeline.steps.get(*index)? {
            AgentStep::Tool(step) => Some(step.tool_call_id.clone()),
            AgentStep::Thinking(_) => None,
        }
    }

    /// `toolAwaitingApproval`.
    pub fn tool_awaiting_approval(&mut self, tool_call_id: &str) {
        self.update_tool(tool_call_id, AgentStepStatus::AwaitingApproval, false);
    }

    /// `toolRunning`.
    pub fn tool_running(&mut self, tool_call_id: &str) {
        self.update_tool(tool_call_id, AgentStepStatus::Running, false);
    }

    /// `toolFinished` — terminal status for one tool step.
    pub fn tool_finished(&mut self, tool_call_id: &str, status: ToolFinishStatus) {
        self.update_tool(tool_call_id, status.into(), true);
    }

    /// `finish` — settle open reasoning and any in-flight steps, then set the
    /// terminal status.
    pub fn finish(&mut self, status: TerminalTimelineStatus) -> GenerationTimeline {
        if self.timeline.status == GenerationTimelineStatus::Running {
            let timestamp = (self.now)();
            self.settle_thinking(timestamp);
            self.timeline.status = status.into();
            self.timeline.finished_at = Some(timestamp);
            for step in &mut self.timeline.steps {
                if let AgentStep::Tool(tool) = step {
                    if matches!(
                        tool.status,
                        AgentStepStatus::Pending
                            | AgentStepStatus::AwaitingApproval
                            | AgentStepStatus::Running
                    ) {
                        tool.status = if status == TerminalTimelineStatus::Cancelled {
                            AgentStepStatus::Cancelled
                        } else {
                            AgentStepStatus::Failed
                        };
                        tool.updated_at = timestamp;
                        tool.finished_at = Some(timestamp);
                    }
                }
            }
            self.emit();
        }
        self.snapshot()
    }

    /// A deep-enough clone of the current timeline for renderer payloads.
    pub fn snapshot(&self) -> GenerationTimeline {
        GenerationTimeline {
            version: self.timeline.version,
            generation_id: self.timeline.generation_id.clone(),
            status: self.timeline.status,
            started_at: self.timeline.started_at,
            finished_at: self.timeline.finished_at,
            steps: self.timeline.steps.clone(),
            claim_check: self.timeline.claim_check.clone(),
        }
    }

    fn settle_thinking(&mut self, timestamp: u64) {
        let Some((index, started_at)) = self.open_thinking.take() else {
            return;
        };
        let Some(AgentStep::Thinking(step)) = self.timeline.steps.get_mut(index) else {
            return;
        };
        step.duration_ms =
            Some(step.duration_ms.unwrap_or(0) + timestamp.saturating_sub(started_at));
        step.updated_at = timestamp;
        step.finished_at = Some(timestamp);
    }

    fn update_tool(&mut self, tool_call_id: &str, status: AgentStepStatus, terminal: bool) {
        if self.timeline.status != GenerationTimelineStatus::Running {
            return;
        }
        let Some(index) = self.step_index.get(tool_call_id).copied() else {
            return;
        };
        let Some(AgentStep::Tool(step)) = self.timeline.steps.get_mut(index) else {
            return;
        };
        if is_terminal_agent_step(step.status) {
            return;
        }
        let timestamp = (self.now)();
        step.status = status;
        step.updated_at = timestamp;
        if terminal {
            step.finished_at = Some(timestamp);
        }
        self.emit();
    }

    fn emit(&self) {
        (self.publish)(&self.snapshot());
    }
}

fn is_terminal_agent_step(status: AgentStepStatus) -> bool {
    matches!(
        status,
        AgentStepStatus::Completed
            | AgentStepStatus::Failed
            | AgentStepStatus::Blocked
            | AgentStepStatus::Cancelled
    )
}

/// The terminal per-tool statuses accepted by `toolFinished`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolFinishStatus {
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

impl From<ToolFinishStatus> for AgentStepStatus {
    fn from(status: ToolFinishStatus) -> Self {
        match status {
            ToolFinishStatus::Completed => AgentStepStatus::Completed,
            ToolFinishStatus::Failed => AgentStepStatus::Failed,
            ToolFinishStatus::Blocked => AgentStepStatus::Blocked,
            ToolFinishStatus::Cancelled => AgentStepStatus::Cancelled,
        }
    }
}

/// The terminal timeline statuses accepted by `finish`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalTimelineStatus {
    Completed,
    Failed,
    Cancelled,
}

impl From<TerminalTimelineStatus> for GenerationTimelineStatus {
    fn from(status: TerminalTimelineStatus) -> Self {
        match status {
            TerminalTimelineStatus::Completed => GenerationTimelineStatus::Completed,
            TerminalTimelineStatus::Failed => GenerationTimelineStatus::Failed,
            TerminalTimelineStatus::Cancelled => GenerationTimelineStatus::Cancelled,
        }
    }
}

// ===========================================================================
// Chat turn admission (chat-turn-admission.ts)
// ===========================================================================

/// `ChatTurnLease` — owns the append-to-generation critical section for one
/// chat. A lease can cross awaits while a user message is persisted, then hand
/// off synchronously to generation registration.
#[derive(Clone)]
pub struct ChatTurnLease(Arc<TurnLeaseInner>);

struct TurnLeaseInner {
    chat_id: String,
    turn_id: String,
    owner_id: String,
    released: AtomicBool,
    cleanups: std::sync::Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    admission: std::sync::Weak<std::sync::Mutex<HashMap<String, Arc<TurnRecord>>>>,
}

struct TurnRecord {
    lease: Arc<TurnLeaseInner>,
}

impl ChatTurnLease {
    pub fn chat_id(&self) -> &str {
        &self.0.chat_id
    }

    pub fn turn_id(&self) -> &str {
        &self.0.turn_id
    }

    pub fn owner_id(&self) -> &str {
        &self.0.owner_id
    }

    /// Register a cleanup run on release (immediately if already released).
    pub fn on_released(&self, cleanup: impl FnOnce() + Send + 'static) {
        if self.0.released.load(Ordering::SeqCst) {
            cleanup();
            return;
        }
        self.0.cleanups.lock().unwrap().push(Box::new(cleanup));
    }

    /// Idempotent release: removes this lease from the admission map (if it is
    /// still current) and runs registered cleanups.
    pub fn release(&self) {
        self.0.release();
    }
}

impl TurnLeaseInner {
    fn release(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(admission) = self.admission.upgrade() {
            let mut turns = admission.lock().unwrap();
            if let Some(record) = turns.get(&self.chat_id) {
                if std::ptr::eq(Arc::as_ptr(&record.lease), self) {
                    turns.remove(&self.chat_id);
                }
            }
        }
        let cleanups = std::mem::take(&mut *self.cleanups.lock().unwrap());
        for cleanup in cleanups {
            cleanup();
        }
    }
}

/// `ChatTurnAdmission` — serialized renderer/scheduler turn claims per chat.
#[derive(Clone, Default)]
pub struct ChatTurnAdmission {
    turns: Arc<std::sync::Mutex<HashMap<String, Arc<TurnRecord>>>>,
}

impl ChatTurnAdmission {
    pub fn new() -> Self {
        Self::default()
    }

    /// `tryBegin` — claim the chat when no generation is busy and no other
    /// lease is outstanding.
    pub fn try_begin(
        &self,
        chat_id: &str,
        turn_id: &str,
        owner_id: &str,
        generation_busy: bool,
    ) -> Option<ChatTurnLease> {
        let mut turns = self.turns.lock().unwrap();
        if generation_busy || turns.contains_key(chat_id) {
            return None;
        }
        let inner = Arc::new(TurnLeaseInner {
            chat_id: chat_id.to_string(),
            turn_id: turn_id.to_string(),
            owner_id: owner_id.to_string(),
            released: AtomicBool::new(false),
            cleanups: std::sync::Mutex::new(Vec::new()),
            admission: Arc::downgrade(&self.turns),
        });
        let lease = ChatTurnLease(inner.clone());
        turns.insert(chat_id.to_string(), Arc::new(TurnRecord { lease: inner }));
        Some(lease)
    }

    pub fn is_admitted(&self, chat_id: &str) -> bool {
        self.turns.lock().unwrap().contains_key(chat_id)
    }

    pub fn owns(&self, chat_id: &str, turn_id: &str, owner_id: &str) -> bool {
        let turns = self.turns.lock().unwrap();
        match turns.get(chat_id).map(|record| &record.lease) {
            Some(lease) => lease.turn_id == turn_id && lease.owner_id == owner_id,
            None => false,
        }
    }

    pub fn release_matching(&self, chat_id: &str, turn_id: &str, owner_id: &str) -> bool {
        let lease = {
            let turns = self.turns.lock().unwrap();
            match turns.get(chat_id).map(|record| &record.lease) {
                Some(lease) if lease.turn_id == turn_id && lease.owner_id == owner_id => {
                    Some(lease.clone())
                }
                _ => None,
            }
        };
        match lease {
            Some(lease) => {
                lease.release();
                true
            }
            None => false,
        }
    }

    /// `handoff` — register generation ownership and release the matching
    /// append lease as one operation. A failing registration keeps the lease
    /// intact so the caller can fail closed or release it deliberately.
    pub fn handoff<R, E>(
        &self,
        chat_id: &str,
        turn_id: &str,
        owner_id: &str,
        register_generation: impl FnOnce() -> Result<R, E>,
    ) -> Result<R, TurnHandoffError<E>> {
        let lease = {
            let turns = self.turns.lock().unwrap();
            match turns.get(chat_id).map(|record| &record.lease) {
                Some(lease) if lease.turn_id == turn_id && lease.owner_id == owner_id => {
                    Some(lease.clone())
                }
                _ => None,
            }
        };
        let Some(lease) = lease else {
            return Err(TurnHandoffError::NotOwned);
        };
        match register_generation() {
            Ok(result) => {
                lease.release();
                Ok(result)
            }
            Err(error) => Err(TurnHandoffError::Registration(error)),
        }
    }
}

/// Why a `handoff` failed.
#[derive(Debug)]
pub enum TurnHandoffError<E> {
    /// No matching lease (wrong turn/owner or already released).
    NotOwned,
    /// The registration callback failed; the lease remains admitted.
    Registration(E),
}

impl<E: std::fmt::Debug> std::fmt::Display for TurnHandoffError<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TurnHandoffError::NotOwned => formatter.write_str("no matching turn lease"),
            TurnHandoffError::Registration(error) => {
                write!(formatter, "{error:?}")
            }
        }
    }
}

// ===========================================================================
// startGenerationAndMaybeTitle (chat-generation-start.ts)
// ===========================================================================

/// The title input handed to `start_title`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatTitleStartInput {
    pub chat_id: String,
    pub provider_id: String,
    pub model: String,
}

/// The dependencies for [`start_generation_and_maybe_title`]
/// (`ChatGenerationStartDependencies`).
#[async_trait]
pub trait ChatGenerationStartDependencies: Send + Sync {
    /// Start the generation; `Ok(true)` means it was registered.
    async fn start(&self, stream_id: &str, params: &ChatStartParams) -> Result<bool, String>;
    /// Kick off a background first-turn title (never when the start was
    /// cancelled).
    fn start_title(&self, input: &ChatTitleStartInput);
}

/// Keep a stopped initialization from starting a second, background model
/// request (`startGenerationAndMaybeTitle`).
pub async fn start_generation_and_maybe_title<D: ChatGenerationStartDependencies>(
    dependencies: &D,
    stream_id: &str,
    params: &ChatStartParams,
) -> Result<bool, String> {
    let started = dependencies.start(stream_id, params).await?;
    if started {
        dependencies.start_title(&ChatTitleStartInput {
            chat_id: params.chat_id.clone(),
            provider_id: params.provider_id.clone(),
            model: params.model.clone(),
        });
    }
    Ok(started)
}

// ===========================================================================
// GenerationManager — essential llm-client orchestration
// ===========================================================================

/// The per-stream driver hook the manager runs. The `runner` module implements
/// the actual agent loop; the manager holds admission + lifecycle around it.
#[async_trait]
pub trait GenerationDriver: Send + Sync {
    /// Run one generation to completion. The manager passes a signal that is
    /// aborted on cancel/shutdown; the driver should stop promptly. Return
    /// the terminal assistant message for usage capture, or an error.
    async fn run(
        &self,
        stream_id: &str,
        params: &ChatStartParams,
        signal: AbortSignal,
    ) -> Result<AssistantMessage, String>;
}

/// A privacy-safe usage capture hook (`assistantUsageRecord` + `usageStore` in
/// the TS). Called once per settled generation with the terminal assistant
/// message.
pub trait UsageRecorder: Send + Sync {
    fn record_assistant_message(&self, stream_id: &str, message: &AssistantMessage);
}

/// The default usage recorder: drops everything (fail-open).
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopUsageRecorder;

impl UsageRecorder for NoopUsageRecorder {
    fn record_assistant_message(&self, _stream_id: &str, _message: &AssistantMessage) {}
}

/// A callback broadcast when a chat's generation settles
/// (`broadcastChatSettled`).
pub type ChatSettledNotifier = Arc<dyn Fn(&str, Option<&str>, Option<&str>) + Send + Sync>;

/// A generation in flight (either setting up or actively running).
struct InFlightGeneration {
    chat_id: String,
    signal: AbortSignal,
    cancel_requested: AtomicBool,
}

struct GenerationManagerInner {
    driver: Arc<dyn GenerationDriver>,
    usage: Arc<dyn UsageRecorder>,
    on_chat_settled: Option<ChatSettledNotifier>,
    admission: ChatTurnAdmission,
    state: std::sync::Mutex<HashMap<String, Arc<InFlightGeneration>>>,
    notify: tokio::sync::Notify,
}

/// The generation orchestrator: start/stop/cancel/shutdown with the stream-id
/// and chat-busy admission gates, terminal usage capture, and settled
/// notifications. This is the essential llm-client orchestration; the heavy
/// cross-service gates (chat deletion, workspace mutation, computer-use
/// mutation) remain separate services in a later phase.
#[derive(Clone)]
pub struct GenerationManager {
    inner: Arc<GenerationManagerInner>,
}

/// Configuration for [`GenerationManager`].
pub struct GenerationManagerConfig {
    pub driver: Arc<dyn GenerationDriver>,
    pub usage: Arc<dyn UsageRecorder>,
    pub on_chat_settled: Option<ChatSettledNotifier>,
}

impl GenerationManager {
    pub fn new(config: GenerationManagerConfig) -> Self {
        Self {
            inner: Arc::new(GenerationManagerInner {
                driver: config.driver,
                usage: config.usage,
                on_chat_settled: config.on_chat_settled,
                admission: ChatTurnAdmission::new(),
                state: std::sync::Mutex::new(HashMap::new()),
                notify: tokio::sync::Notify::new(),
            }),
        }
    }

    fn chat_has_generation_ownership(
        state: &HashMap<String, Arc<InFlightGeneration>>,
        chat_id: &str,
    ) -> bool {
        state.values().any(|entry| entry.chat_id == chat_id)
    }

    /// `llmClient.start` — admission gates plus driver registration. The
    /// caller may hold a turn lease (from
    /// [`GenerationManager::admission`]); it is handed off synchronously when
    /// the generation registers.
    pub async fn start(
        &self,
        stream_id: &str,
        params: &ChatStartParams,
        turn_lease: Option<&ChatTurnLease>,
    ) -> Result<bool, String> {
        let signal = AbortSignal::new();
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.contains_key(stream_id) {
                return Err("A generation with this stream id is already running.".to_string());
            }
            if Self::chat_has_generation_ownership(&state, &params.chat_id) {
                return Err("This chat already has a response in progress.".to_string());
            }
            // Hand the append lease off synchronously with registration. A
            // failed handoff keeps the lease admitted so the caller can fail
            // closed or release it deliberately.
            if let Some(lease) = turn_lease {
                if lease.chat_id() != params.chat_id
                    || !self.inner.admission.owns(
                        &params.chat_id,
                        lease.turn_id(),
                        lease.owner_id(),
                    )
                {
                    return Err(
                        "This message turn expired before generation could start.".to_string()
                    );
                }
                self.inner
                    .admission
                    .handoff::<(), ()>(
                        &params.chat_id,
                        lease.turn_id(),
                        lease.owner_id(),
                        || Ok(()),
                    )
                    .map_err(|_| {
                        "This message turn expired before generation could start.".to_string()
                    })?;
            }
            state.insert(
                stream_id.to_string(),
                Arc::new(InFlightGeneration {
                    chat_id: params.chat_id.clone(),
                    signal: signal.clone(),
                    cancel_requested: AtomicBool::new(false),
                }),
            );
        }

        let manager = self.clone();
        let stream_id = stream_id.to_string();
        let params = params.clone();
        let driver = self.inner.driver.clone();
        let usage = self.inner.usage.clone();
        let on_chat_settled = self.inner.on_chat_settled.clone();

        tokio::spawn(async move {
            let outcome = driver.run(&stream_id, &params, signal).await;
            let cancel_requested = {
                let state = manager.inner.state.lock().unwrap();
                state
                    .get(&stream_id)
                    .map(|entry| entry.cancel_requested.load(Ordering::SeqCst))
                    .unwrap_or(false)
            };
            if let Ok(message) = outcome {
                usage.record_assistant_message(&stream_id, &message);
            }
            manager.inner.state.lock().unwrap().remove(&stream_id);
            manager.inner.notify.notify_waiters();
            if let Some(notifier) = on_chat_settled.as_ref() {
                notifier(&params.chat_id, params.workspace_id.as_deref(), None);
            }
            let _ = cancel_requested;
        });
        Ok(true)
    }

    /// `llmClient.cancel` — stop one generation (aborts its signal).
    pub fn cancel(&self, stream_id: &str) -> bool {
        let mut state = self.inner.state.lock().unwrap();
        let Some(entry) = state.get_mut(stream_id) else {
            return false;
        };
        entry.cancel_requested.store(true, Ordering::SeqCst);
        entry.signal.abort();
        true
    }

    /// `llmClient.isChatBusy` — turn lease admitted or generation ownership.
    pub fn is_chat_busy(&self, chat_id: &str) -> bool {
        self.inner.admission.is_admitted(chat_id)
            || Self::chat_has_generation_ownership(&self.inner.state.lock().unwrap(), chat_id)
    }

    /// Whether any generation is currently in flight.
    pub fn has_active_generations(&self) -> bool {
        !self.inner.state.lock().unwrap().is_empty()
    }

    /// `llmClient.abortAll` — cancel every generation.
    pub fn abort_all(&self) {
        let stream_ids: Vec<String> = self.inner.state.lock().unwrap().keys().cloned().collect();
        for stream_id in stream_ids {
            self.cancel(&stream_id);
        }
    }

    /// `llmClient.waitForChatIdle` — wait (bounded) for a chat's generations
    /// to settle. Returns `false` on deadline.
    pub async fn wait_for_chat_idle(&self, chat_id: &str, grace_ms: u64) -> bool {
        let deadline = now_ms() + grace_ms;
        while self.is_chat_busy(chat_id) {
            let remaining = deadline.saturating_sub(now_ms());
            if remaining == 0 {
                return false;
            }
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.is_chat_busy(chat_id) {
                break;
            }
            tokio::select! {
                _ = notified.as_mut() => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(remaining.min(25))) => {}
            }
        }
        true
    }

    /// `llmClient.shutdown` (simplified) — abort all and wait for the in-flight
    /// map to clear within the grace window.
    pub async fn shutdown(&self, grace_ms: u64) -> bool {
        self.abort_all();
        let deadline = now_ms() + grace_ms;
        while self.has_active_generations() {
            let remaining = deadline.saturating_sub(now_ms());
            if remaining == 0 {
                return false;
            }
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.has_active_generations() {
                break;
            }
            tokio::select! {
                _ = notified.as_mut() => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(remaining.min(25))) => {}
            }
        }
        true
    }

    /// Access to the turn-admission critical section (the caller persists the
    /// user message under the lease, then passes it to
    /// [`GenerationManager::start`]).
    pub fn admission(&self) -> &ChatTurnAdmission {
        &self.inner.admission
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{Attachment, AttachmentKind};

    fn assistant_message(stop_reason: StopReason) -> AssistantMessage {
        AssistantMessage {
            content: vec![ContentBlock::Text(TextContent {
                text: "final text".to_string(),
                text_signature: None,
            })],
            api: "anthropic-messages".to_string(),
            provider: "anthropic".to_string(),
            model: "claude".to_string(),
            response_model: None,
            response_id: None,
            usage: ZERO_USAGE,
            stop_reason,
            error_message: None,
            timestamp: 1,
        }
    }

    fn chat_message(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: "m-1".to_string(),
            role,
            content: content.to_string(),
            created_at: 1,
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        }
    }

    fn model(
        reasoning: bool,
        thinking_level_map: Option<HashMap<String, Option<String>>>,
    ) -> Model {
        Model {
            id: "m".to_string(),
            name: "M".to_string(),
            api: aiden_providers::ApiFamily::OpenAIResponses,
            provider: "openai".to_string(),
            base_url: "https://example.com".to_string(),
            reasoning,
            thinking_level_map,
            input: vec![Modality::Text, Modality::Image],
            cost: aiden_providers::catalog::ModelCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
            context_window: 128_000,
            max_tokens: 8_192,
            headers: HashMap::new(),
        }
    }

    fn params(messages: Vec<ChatMessage>) -> ChatStartParams {
        ChatStartParams {
            chat_id: "chat-1".to_string(),
            workspace_id: Some("workspace-1".to_string()),
            provider_id: "openai-codex".to_string(),
            model: "gpt-5.4".to_string(),
            mode: None,
            thinking_level: None,
            messages,
        }
    }

    // =================================================================
    // is_explicit_user_stop + chat-generation-start
    // =================================================================

    #[test]
    fn only_an_explicit_visible_user_stop_origin_is_acceptance_evidence() {
        assert!(is_explicit_user_stop(Some("user_stop")));
        for origin in [
            Some("lifecycle"),
            Some("navigation"),
            Some("unmount"),
            Some("stop"),
            Some(""),
            None,
        ] {
            assert!(!is_explicit_user_stop(origin));
        }
    }

    #[tokio::test]
    async fn start_generation_and_maybe_title_does_not_start_title_when_start_failed() {
        struct Deps {
            title_starts: Arc<std::sync::atomic::AtomicUsize>,
        }
        #[async_trait]
        impl ChatGenerationStartDependencies for Deps {
            async fn start(
                &self,
                _stream_id: &str,
                _params: &ChatStartParams,
            ) -> Result<bool, String> {
                Ok(false)
            }
            fn start_title(&self, _input: &ChatTitleStartInput) {
                self.title_starts.fetch_add(1, Ordering::SeqCst);
            }
        }
        let deps = Deps {
            title_starts: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let started = start_generation_and_maybe_title(
            &deps,
            "stream-1",
            &params(vec![chat_message(ChatRole::User, "Help me")]),
        )
        .await
        .unwrap();
        assert!(!started);
        assert_eq!(deps.title_starts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn start_generation_and_maybe_title_starts_one_title_only_after_success() {
        struct Deps {
            title_inputs: Arc<std::sync::Mutex<Vec<ChatTitleStartInput>>>,
        }
        #[async_trait]
        impl ChatGenerationStartDependencies for Deps {
            async fn start(
                &self,
                _stream_id: &str,
                _params: &ChatStartParams,
            ) -> Result<bool, String> {
                Ok(true)
            }
            fn start_title(&self, input: &ChatTitleStartInput) {
                self.title_inputs.lock().unwrap().push(input.clone());
            }
        }
        let deps = Deps {
            title_inputs: Arc::new(std::sync::Mutex::new(Vec::new())),
        };
        let started = start_generation_and_maybe_title(
            &deps,
            "stream-1",
            &params(vec![chat_message(ChatRole::User, "Help me")]),
        )
        .await
        .unwrap();
        assert!(started);
        let inputs = deps.title_inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].chat_id, "chat-1");
        assert_eq!(inputs[0].provider_id, "openai-codex");
        assert_eq!(inputs[0].model, "gpt-5.4");
    }

    // =================================================================
    // ChatTurnAdmission (chat-turn-admission.ts via chat-generation-start.test.ts)
    // =================================================================

    #[test]
    fn rapid_navigation_cannot_append_a_newer_user_turn_while_generation_drains() {
        let admission = ChatTurnAdmission::new();
        let mut messages: Vec<&str> = vec!["user-1"];
        let mut generation_busy = true;
        fn append_user(
            admission: &ChatTurnAdmission,
            messages: &mut Vec<&'static str>,
            generation_busy: bool,
            message: &'static str,
        ) -> bool {
            let Some(turn) = admission.try_begin("chat-a", message, "renderer", generation_busy)
            else {
                return false;
            };
            messages.push(message);
            turn.release();
            true
        }
        assert!(!append_user(
            &admission,
            &mut messages,
            generation_busy,
            "user-2"
        ));
        assert_eq!(messages, vec!["user-1"]);

        messages.push("assistant-1");
        generation_busy = false;
        assert!(append_user(
            &admission,
            &mut messages,
            generation_busy,
            "user-2"
        ));
        assert_eq!(messages, vec!["user-1", "assistant-1", "user-2"]);

        let append = admission.try_begin("chat-a", "turn-3", "renderer", false);
        assert!(append.is_some());
        assert!(admission.is_admitted("chat-a"));
        assert!(admission
            .try_begin("chat-a", "turn-4", "scheduler", false)
            .is_none());
        assert!(!admission.is_admitted("chat-b"));

        let append = append.unwrap();
        append.release();
        append.release(); // idempotent
        assert!(!admission.is_admitted("chat-a"));
        assert!(admission
            .try_begin("chat-a", "turn-4", "scheduler", false)
            .is_some());
    }

    #[test]
    fn turn_lease_hands_off_only_to_the_exact_owner_after_generation_is_registered() {
        let admission = ChatTurnAdmission::new();
        let lease = admission
            .try_begin("chat-a", "turn-1", "renderer-document-1", false)
            .unwrap();
        let mut events = Vec::new();

        assert!(admission
            .handoff::<(), ()>("chat-a", "wrong-turn", "renderer-document-1", || Ok(()))
            .is_err());
        assert!(!admission.release_matching("chat-a", "turn-1", "renderer-document-2"));
        assert!(admission.is_admitted("chat-a"));

        assert!(admission
            .handoff::<(), ()>("chat-a", "turn-1", "renderer-document-1", || {
                assert!(admission.is_admitted("chat-a"));
                events.push("generation-registered");
                Ok(())
            })
            .is_ok());
        assert_eq!(events, vec!["generation-registered"]);
        assert!(!admission.is_admitted("chat-a"));
        let _ = lease;
    }

    #[test]
    fn renderer_and_scheduler_turns_cannot_interleave_or_orphan_their_transcript_order() {
        let admission = ChatTurnAdmission::new();
        let mut messages: Vec<&str> = Vec::new();
        let mut generation_busy = false;

        let _renderer = admission
            .try_begin("chat-a", "renderer-1", "renderer-document", generation_busy)
            .unwrap();
        messages.push("renderer-user");
        assert!(admission
            .try_begin("chat-a", "schedule-1", "scheduled-owner", generation_busy)
            .is_none());

        assert!(admission
            .handoff::<(), ()>("chat-a", "renderer-1", "renderer-document", || {
                generation_busy = true;
                Ok(())
            })
            .is_ok());
        assert!(admission
            .try_begin("chat-a", "schedule-1", "scheduled-owner", generation_busy)
            .is_none());
        messages.push("renderer-assistant");
        generation_busy = false;

        let scheduled = admission
            .try_begin("chat-a", "schedule-1", "scheduled-owner", generation_busy)
            .unwrap();
        messages.push("scheduled-output");
        scheduled.release();
        assert_eq!(
            messages,
            vec!["renderer-user", "renderer-assistant", "scheduled-output"]
        );
    }

    #[test]
    fn throwing_generation_registration_fails_closed_until_the_owner_releases() {
        let admission = ChatTurnAdmission::new();
        let lease = admission
            .try_begin("chat-a", "turn-1", "renderer", false)
            .unwrap();
        let error = admission
            .handoff::<(), String>("chat-a", "turn-1", "renderer", || {
                Err("registration failed".to_string())
            })
            .unwrap_err();
        assert!(error.to_string().contains("registration failed"));
        assert!(admission.is_admitted("chat-a"));
        lease.release();
        assert!(!admission.is_admitted("chat-a"));
    }

    // =================================================================
    // toPiMessages (generation-messages.ts)
    // =================================================================

    #[test]
    fn to_pi_messages_rehydrates_chat_history_with_the_image_gate() {
        let messages = vec![
            chat_message(ChatRole::User, "Hello"),
            chat_message(ChatRole::Assistant, "Hi there"),
        ];
        let converted = to_pi_messages(
            &params(messages),
            "openai-responses",
            "openai-codex",
            "gpt-5.4",
            true,
        );
        assert_eq!(converted.len(), 2);
        match &converted[0] {
            Message::User(user) => assert_eq!(user.content, UserContent::Text("Hello".to_string())),
            other => panic!("expected user message, got {other:?}"),
        }
        match &converted[1] {
            Message::Assistant(assistant) => {
                assert_eq!(assistant.api, "openai-responses");
                assert_eq!(assistant.model, "gpt-5.4");
                assert_eq!(assistant.stop_reason, StopReason::Stop);
                assert_eq!(assistant.usage, ZERO_USAGE);
            }
            other => panic!("expected assistant message, got {other:?}"),
        }
    }

    #[test]
    fn to_pi_messages_inlines_text_attachments_and_gates_images() {
        let mut user = chat_message(ChatRole::User, "Summarize");
        user.attachments = Some(vec![
            Attachment {
                id: "a1".to_string(),
                name: "notes.md".to_string(),
                mime_type: "text/markdown".to_string(),
                kind: AttachmentKind::Text,
                size: 5,
                data: None,
                text: Some("hello file".to_string()),
            },
            Attachment {
                id: "a2".to_string(),
                name: "shot.png".to_string(),
                mime_type: "image/png".to_string(),
                kind: AttachmentKind::Image,
                size: 9,
                data: Some("base64".to_string()),
                text: None,
            },
        ]);
        let converted = to_pi_messages(
            &params(vec![user]),
            "openai-responses",
            "openai-codex",
            "gpt-5.4",
            true,
        );
        let Message::User(user_message) = &converted[0] else {
            panic!("expected user message");
        };
        match &user_message.content {
            UserContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                match &blocks[0] {
                    UserBlock::Text(text) => {
                        assert!(text.text.contains("Attached file: notes.md"))
                    }
                    other => panic!("expected text block, got {other:?}"),
                }
                assert!(matches!(blocks[1], UserBlock::Image(_)));
            }
            other => panic!("expected blocks, got {other:?}"),
        }
        // Without the image gate, only the text part survives.
        let converted = to_pi_messages(
            &params(vec![chat_message(ChatRole::User, "x")]),
            "openai-responses",
            "openai-codex",
            "gpt-5.4",
            false,
        );
        match &converted[0] {
            Message::User(user) => match &user.content {
                UserContent::Text(text) => assert!(text.contains("x")),
                other => panic!("expected text, got {other:?}"),
            },
            other => panic!("expected user message, got {other:?}"),
        }
    }

    // =================================================================
    // generation-runtime pure contract
    // =================================================================

    #[test]
    fn runtime_supports_images_uses_the_connection_bound_model() {
        assert!(runtime_supports_images(&model(true, None)));
        let mut text_only = model(true, None);
        text_only.input = vec![Modality::Text];
        assert!(!runtime_supports_images(&text_only));
    }

    #[test]
    fn resolve_generation_thinking_level_fails_closed_outside_native_contracts() {
        let mut m = model(true, None);
        // google: requested level honored when supported, else off.
        assert_eq!(
            resolve_generation_thinking_level("google", &m, Some(GenerationThinkingLevel::High)),
            GenerationThinkingLevel::High
        );
        assert_eq!(
            resolve_generation_thinking_level("google", &m, None),
            GenerationThinkingLevel::Off
        );
        // openai (not codex): always off.
        assert_eq!(
            resolve_generation_thinking_level("openai", &m, Some(GenerationThinkingLevel::High)),
            GenerationThinkingLevel::Off
        );
        // openai-codex with a xhigh-only map.
        m.thinking_level_map = Some(HashMap::from([(
            "xhigh".to_string(),
            Some("xhigh".to_string()),
        )]));
        assert_eq!(
            resolve_generation_thinking_level(
                "openai-codex",
                &m,
                Some(GenerationThinkingLevel::Xhigh)
            ),
            GenerationThinkingLevel::Xhigh
        );
        assert_eq!(
            resolve_generation_thinking_level("openai-codex", &m, None),
            GenerationThinkingLevel::Medium,
            "codex normalizes an absent request to its first supported level"
        );
        assert_eq!(
            resolve_generation_thinking_level(
                "openai-codex",
                &m,
                Some(GenerationThinkingLevel::Max)
            ),
            GenerationThinkingLevel::Medium,
            "an unsupported request falls back to the normalized default"
        );
        m.thinking_level_map = Some(HashMap::from([
            ("xhigh".to_string(), Some("xhigh".to_string())),
            ("max".to_string(), Some("max".to_string())),
        ]));
        assert_eq!(
            resolve_generation_thinking_level(
                "openai-codex",
                &m,
                Some(GenerationThinkingLevel::Max)
            ),
            GenerationThinkingLevel::Max
        );
        // Non-reasoning models are off everywhere.
        let mut no_reasoning = model(false, None);
        no_reasoning.thinking_level_map = Some(HashMap::from([
            ("xhigh".to_string(), Some("xhigh".to_string())),
            ("max".to_string(), Some("max".to_string())),
        ]));
        assert_eq!(
            resolve_generation_thinking_level(
                "openai-codex",
                &no_reasoning,
                Some(GenerationThinkingLevel::High)
            ),
            GenerationThinkingLevel::Off
        );
        // anthropic: absent request normalizes to high (the default).
        let anthropic = model(
            true,
            Some(HashMap::from([
                ("xhigh".to_string(), Some("xhigh".to_string())),
                ("max".to_string(), Some("max".to_string())),
            ])),
        );
        assert_eq!(
            resolve_generation_thinking_level("anthropic", &anthropic, None),
            GenerationThinkingLevel::High
        );
        assert_eq!(
            resolve_generation_thinking_level(
                "anthropic",
                &anthropic,
                Some(GenerationThinkingLevel::Xhigh)
            ),
            GenerationThinkingLevel::Xhigh,
            "an explicitly mapped level is honored"
        );
        // Map that omits xhigh: requested xhigh falls back to high.
        let anthropic_max = model(
            true,
            Some(HashMap::from([(
                "max".to_string(),
                Some("max".to_string()),
            )])),
        );
        assert_eq!(
            resolve_generation_thinking_level(
                "anthropic",
                &anthropic_max,
                Some(GenerationThinkingLevel::Xhigh)
            ),
            GenerationThinkingLevel::High
        );
        assert_eq!(
            resolve_generation_thinking_level(
                "anthropic",
                &anthropic_max,
                Some(GenerationThinkingLevel::Max)
            ),
            GenerationThinkingLevel::Max
        );
        // google map with off nulled: medium request normalizes to off.
        let google = model(
            true,
            Some(HashMap::from([
                ("off".to_string(), None),
                ("low".to_string(), Some("LOW".to_string())),
                ("medium".to_string(), None),
                ("high".to_string(), Some("HIGH".to_string())),
            ])),
        );
        assert_eq!(
            resolve_generation_thinking_level(
                "google",
                &google,
                Some(GenerationThinkingLevel::Medium)
            ),
            GenerationThinkingLevel::Off
        );
    }

    #[test]
    fn terminal_message_helpers() {
        let mut error_message = assistant_message(StopReason::Error);
        error_message.error_message = Some("  boom  ".to_string());
        assert_eq!(
            terminal_generation_error(&error_message).as_deref(),
            Some("boom")
        );
        let error_message = assistant_message(StopReason::Error);
        assert_eq!(
            terminal_generation_error(&error_message).as_deref(),
            Some("The model couldn't complete this response.")
        );
        assert_eq!(
            terminal_generation_error(&assistant_message(StopReason::Stop)),
            None
        );
        assert!(terminal_generation_was_aborted(&assistant_message(
            StopReason::Aborted
        )));
        assert!(!terminal_generation_was_aborted(&assistant_message(
            StopReason::Stop
        )));
        assert_eq!(
            terminal_generation_interruption_error(true, false).as_deref(),
            Some("The response was interrupted before it finished. Try again.")
        );
        assert_eq!(terminal_generation_interruption_error(true, true), None);
        assert_eq!(terminal_generation_interruption_error(false, false), None);
    }

    #[test]
    fn terminal_text_and_reasoning_fallbacks() {
        let message = assistant_message(StopReason::Stop);
        assert_eq!(terminal_assistant_text(&message), "final text");
        assert_eq!(terminal_assistant_text_fallback(&message, true), "");
        assert_eq!(
            terminal_assistant_text_fallback(&message, false),
            "final text"
        );

        let mut reasoning = message.clone();
        reasoning.content = vec![
            ContentBlock::Thinking(ThinkingContent {
                thinking: "think one".to_string(),
                thinking_signature: None,
                redacted: Some(false),
            }),
            ContentBlock::Thinking(ThinkingContent {
                thinking: "think two".to_string(),
                thinking_signature: None,
                redacted: None,
            }),
            ContentBlock::Thinking(ThinkingContent {
                thinking: "secret".to_string(),
                thinking_signature: None,
                redacted: Some(true),
            }),
        ];
        assert_eq!(
            terminal_assistant_reasoning(&reasoning),
            "think one\n\nthink two"
        );
        assert_eq!(terminal_assistant_reasoning_fallback(&reasoning, true), "");
        assert_eq!(
            terminal_assistant_reasoning_fallback(&reasoning, false),
            "think one\n\nthink two"
        );
    }

    #[tokio::test]
    async fn settle_generation_cleanup_runs_resets_then_bounds_teardown_behind_the_deadline() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let cleared = Arc::new(std::sync::Mutex::new(Some("sensitive-image".to_string())));
        let close_never = std::future::pending();
        let completion_never = std::future::pending();
        let entry_events = events.clone();
        let entry_cleared = cleared.clone();
        let close_events = events.clone();
        let completed = settle_generation_cleanup(
            vec![GenerationCleanupEntry {
                reset: Box::new(move || {
                    entry_events.lock().unwrap().push("reset".to_string());
                    *entry_cleared.lock().unwrap() = None;
                }),
                close: Some(Box::new(move || {
                    close_events.lock().unwrap().push("close".to_string());
                    Box::pin(close_never) as Pin<Box<dyn Future<Output = ()> + Send>>
                })),
                completion: Some(Box::pin(completion_never)),
            }],
            20,
            &|_| {},
        )
        .await;
        assert!(!completed, "a never-settling helper must time out");
        assert_eq!(*cleared.lock().unwrap(), None);
        assert_eq!(
            *events.lock().unwrap(),
            vec!["reset".to_string(), "close".to_string()]
        );
    }

    #[tokio::test]
    async fn settle_generation_cleanup_with_no_operations_is_immediately_true() {
        let completed = settle_generation_cleanup(Vec::new(), 100, &|_| {}).await;
        assert!(completed);
    }

    #[tokio::test]
    async fn wait_for_generation_state_clear_bounds_a_non_settling_parent() {
        let cleared = wait_for_generation_state_clear(
            || true,
            || {
                let never = std::future::pending::<()>();
                vec![Box::pin(never) as Pin<Box<dyn Future<Output = ()> + Send>>]
            },
            now_ms() + 20,
        )
        .await;
        assert!(!cleared);
    }

    // =================================================================
    // TimelineProjector (generation-timeline.test.ts)
    // =================================================================

    #[test]
    fn keeps_tool_order_stable_when_parallel_calls_finish_out_of_order() {
        let now = Arc::new(std::sync::atomic::AtomicU64::new(100));
        let snapshots: Arc<std::sync::Mutex<Vec<GenerationTimeline>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let snapshot_sink = snapshots.clone();
        let clock = now.clone();
        let mut projector = TimelineProjector::with_clock(
            "generation-1",
            Box::new(move |timeline| snapshot_sink.lock().unwrap().push(timeline.clone())),
            Box::new(move || {
                clock.fetch_add(1, Ordering::SeqCst);
                clock.load(Ordering::SeqCst)
            }),
        );
        projector.tool_started(
            "call-a",
            "read_file",
            &serde_json::json!({"path": "src/a.ts"}),
        );
        projector.tool_started(
            "call-b",
            "grep",
            &serde_json::json!({"path": "src", "query": "secret-search-value"}),
        );
        projector.tool_running("call-a");
        projector.tool_running("call-b");
        projector.tool_finished("call-b", ToolFinishStatus::Completed);
        projector.tool_finished("call-a", ToolFinishStatus::Completed);
        let final_timeline = projector.finish(TerminalTimelineStatus::Completed);

        let tools: Vec<(String, usize, AgentStepStatus)> = final_timeline
            .steps
            .iter()
            .filter_map(|step| match step {
                AgentStep::Tool(tool) => Some((tool.tool_call_id.clone(), tool.order, tool.status)),
                _ => None,
            })
            .collect();
        assert_eq!(
            tools,
            vec![
                ("call-1".to_string(), 0, AgentStepStatus::Completed),
                ("call-2".to_string(), 1, AgentStepStatus::Completed),
            ]
        );
        assert_eq!(
            snapshots.lock().unwrap().last().unwrap().status,
            GenerationTimelineStatus::Completed
        );
    }

    #[test]
    fn does_not_expose_raw_command_search_content_or_absolute_path_arguments() {
        let snapshots: Arc<std::sync::Mutex<Vec<GenerationTimeline>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let snapshot_sink = snapshots.clone();
        let mut projector = TimelineProjector::new(
            "generation-1",
            Box::new(move |timeline| snapshot_sink.lock().unwrap().push(timeline.clone())),
        );
        projector.tool_started(
            "command",
            "run_command",
            &serde_json::json!({"command": "echo SUPER_SECRET_TOKEN"}),
        );
        projector.tool_started(
            "search",
            "grep",
            &serde_json::json!({"path": "/Users/person/private", "query": "SUPER_SECRET_QUERY"}),
        );
        projector.tool_started(
            "write",
            "write_file",
            &serde_json::json!({"path": "../outside.txt", "content": "SUPER_SECRET_CONTENT"}),
        );
        let serialized = serde_json::to_string(&*snapshots.lock().unwrap()).unwrap();
        assert!(!serialized.contains("SUPER_SECRET"));
        assert!(!serialized.contains("/Users/person"));
        assert!(!serialized.contains("../outside"));
    }

    #[test]
    fn terminal_cancellation_settles_active_steps() {
        let mut projector = TimelineProjector::new("generation-1", Box::new(|_| {}));
        projector.tool_started(
            "call-a",
            "read_file",
            &serde_json::json!({"path": "README.md"}),
        );
        projector.tool_running("call-a");
        let final_timeline = projector.finish(TerminalTimelineStatus::Cancelled);
        assert_eq!(final_timeline.status, GenerationTimelineStatus::Cancelled);
        match &final_timeline.steps[0] {
            AgentStep::Tool(tool) => {
                assert_eq!(tool.status, AgentStepStatus::Cancelled);
                assert!(tool.finished_at.is_some());
            }
            _ => panic!("expected tool step"),
        }
        assert!(final_timeline.finished_at.is_some());
    }

    #[test]
    fn terminal_steps_and_timelines_ignore_replayed_lifecycle_events() {
        let mut projector = TimelineProjector::new("generation-1", Box::new(|_| {}));
        projector.tool_started(
            "provider-call-id",
            "read_file",
            &serde_json::json!({"path": "README.md"}),
        );
        projector.tool_running("provider-call-id");
        projector.tool_finished("provider-call-id", ToolFinishStatus::Completed);
        projector.tool_running("provider-call-id");
        projector.tool_finished("provider-call-id", ToolFinishStatus::Failed);
        projector.finish(TerminalTimelineStatus::Completed);
        projector.tool_started(
            "late-call-id",
            "read_file",
            &serde_json::json!({"path": "late.txt"}),
        );
        let snapshot = projector.snapshot();
        assert_eq!(snapshot.steps.len(), 1);
        match &snapshot.steps[0] {
            AgentStep::Tool(tool) => assert_eq!(tool.status, AgentStepStatus::Completed),
            _ => panic!("expected tool step"),
        }
    }

    #[test]
    fn provider_call_ids_never_cross_the_safe_timeline_boundary() {
        let mut projector = TimelineProjector::new("generation-1", Box::new(|_| {}));
        let hostile = format!("provider-private-{}", "x".repeat(1_000));
        projector.tool_started(
            &hostile,
            "read_file",
            &serde_json::json!({"path": "README.md"}),
        );
        let serialized = serde_json::to_string(&projector.snapshot()).unwrap();
        assert!(!serialized.contains("provider-private"));
        assert_eq!(
            projector.public_tool_call_id(&hostile).as_deref(),
            Some("call-1")
        );
    }

    #[test]
    fn safe_tool_descriptors_retain_only_relative_targets() {
        assert_eq!(
            safe_tool_descriptor("read_file", &serde_json::json!({"path": "src/index.ts"}))
                .target
                .as_deref(),
            Some("src/index.ts")
        );
        assert_eq!(
            safe_tool_descriptor("run_command", &serde_json::json!({"command": "npm test"})).detail,
            None
        );
        assert_eq!(
            safe_tool_descriptor(
                "read_file",
                &serde_json::json!({"path": "/tmp/private.txt"})
            )
            .target,
            None
        );
        assert_eq!(
            safe_tool_descriptor(
                "run_command",
                &serde_json::json!({
                    "command": "curl -H 'Authorization: SUPER_SECRET' https://example.com",
                    "description": "Fetch the release manifest",
                })
            )
            .detail
            .as_deref(),
            Some("Fetch the release manifest")
        );
        assert_eq!(
            safe_tool_descriptor(
                "grep",
                &serde_json::json!({"path": "services", "pattern": "export (const|class)"})
            )
            .detail
            .as_deref(),
            Some("export (const|class)")
        );
        assert_eq!(
            safe_tool_descriptor("glob", &serde_json::json!({"pattern": "  src/**/*.ts\n\n"}))
                .detail
                .as_deref(),
            Some("src/**/*.ts")
        );
        assert_eq!(
            safe_tool_descriptor(
                "web_search",
                &serde_json::json!({"query": "line one\nline two"})
            )
            .detail
            .as_deref(),
            Some("line one line two")
        );
        assert_eq!(
            safe_tool_descriptor("glob", &serde_json::json!({"pattern": "   "})).detail,
            None
        );
        assert_eq!(
            safe_tool_descriptor("glob", &serde_json::json!({"pattern": 42})).detail,
            None
        );
        assert_eq!(
            safe_tool_descriptor("glob", &serde_json::json!({"pattern": "x".repeat(400)}))
                .detail
                .as_deref()
                .unwrap()
                .len(),
            120
        );
    }

    #[test]
    fn consecutive_reasoning_blocks_merge_into_one_timed_stretch() {
        let now = Arc::new(std::sync::atomic::AtomicU64::new(1_000));
        let clock = now.clone();
        let mut projector = TimelineProjector::with_clock(
            "generation-1",
            Box::new(|_| {}),
            Box::new(move || {
                clock.fetch_add(500, Ordering::SeqCst);
                clock.load(Ordering::SeqCst)
            }),
        );
        projector.thinking_started();
        projector.thinking_ended();
        projector.thinking_started();
        projector.thinking_ended();
        projector.tool_started(
            "call-a",
            "read_file",
            &serde_json::json!({"path": "README.md"}),
        );
        projector.tool_finished("call-a", ToolFinishStatus::Completed);
        projector.thinking_started();
        let final_timeline = projector.finish(TerminalTimelineStatus::Completed);

        let ids: Vec<(String, String)> = final_timeline
            .steps
            .iter()
            .map(|step| match step {
                AgentStep::Thinking(t) => (t.id.clone(), "thinking".to_string()),
                AgentStep::Tool(t) => (t.id.clone(), "tool".to_string()),
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                ("think-1".to_string(), "thinking".to_string()),
                ("tool-1".to_string(), "tool".to_string()),
                ("think-2".to_string(), "thinking".to_string()),
            ]
        );
        let AgentStep::Thinking(merged) = &final_timeline.steps[0] else {
            panic!("expected merged thinking step");
        };
        assert_eq!(merged.duration_ms, Some(1_000));
        let AgentStep::Thinking(trailing) = &final_timeline.steps[2] else {
            panic!("expected trailing thinking step");
        };
        assert_eq!(
            trailing.duration_ms,
            Some(500),
            "finish() settles open reasoning"
        );
        assert!(trailing.finished_at.is_some());
    }

    // =================================================================
    // GenerationManager
    // =================================================================

    struct BlockingDriver {
        started: std::sync::Mutex<Vec<String>>,
        released: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl GenerationDriver for BlockingDriver {
        async fn run(
            &self,
            stream_id: &str,
            _params: &ChatStartParams,
            signal: AbortSignal,
        ) -> Result<AssistantMessage, String> {
            self.started.lock().unwrap().push(stream_id.to_string());
            // Wait for cancellation or a release.
            loop {
                if signal.is_aborted() {
                    return Err("cancelled".to_string());
                }
                let is_released = self
                    .released
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|id| id == stream_id);
                if is_released {
                    self.released.lock().unwrap().retain(|id| id != stream_id);
                    return Ok(assistant_message(StopReason::Stop));
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }
    }

    impl BlockingDriver {
        fn release(&self, stream_id: &str) {
            self.released.lock().unwrap().push(stream_id.to_string());
        }
    }

    struct RecordingUsage(Arc<std::sync::Mutex<Vec<String>>>);

    impl UsageRecorder for RecordingUsage {
        fn record_assistant_message(&self, stream_id: &str, _message: &AssistantMessage) {
            self.0.lock().unwrap().push(stream_id.to_string());
        }
    }

    type TestRecorder = Arc<std::sync::Mutex<Vec<String>>>;

    fn manager_with(
        driver: Arc<dyn GenerationDriver>,
    ) -> (GenerationManager, TestRecorder, TestRecorder) {
        let usage = Arc::new(std::sync::Mutex::new(Vec::new()));
        let settled = Arc::new(std::sync::Mutex::new(Vec::new()));
        let settled_hook = settled.clone();
        let manager = GenerationManager::new(GenerationManagerConfig {
            driver,
            usage: Arc::new(RecordingUsage(usage.clone())),
            on_chat_settled: Some(Arc::new(move |chat_id, workspace_id, _| {
                settled_hook
                    .lock()
                    .unwrap()
                    .push(format!("{chat_id}:{}", workspace_id.unwrap_or("none")));
            })),
        });
        (manager, usage, settled)
    }

    #[tokio::test]
    async fn manager_admits_one_generation_per_chat_and_rejects_duplicate_streams() {
        let driver = Arc::new(BlockingDriver {
            started: std::sync::Mutex::new(Vec::new()),
            released: std::sync::Mutex::new(Vec::new()),
        });
        let (manager, _, _) = manager_with(driver.clone());
        let params = params(vec![chat_message(ChatRole::User, "hi")]);
        assert!(manager.start("stream-1", &params, None).await.is_ok());
        // Duplicate stream id rejected.
        let error = manager.start("stream-1", &params, None).await.unwrap_err();
        assert!(error.contains("stream id is already running"));
        // Same chat under another stream rejected.
        let error = manager.start("stream-2", &params, None).await.unwrap_err();
        assert!(error.contains("already has a response in progress"));
        assert!(manager.is_chat_busy("chat-1"));
        assert!(!manager.is_chat_busy("chat-2"));
        driver.release("stream-1");
        assert!(manager.wait_for_chat_idle("chat-1", 2_000).await);
    }

    #[tokio::test]
    async fn manager_cancel_aborts_the_run_and_shutdown_waits_for_clearance() {
        let driver = Arc::new(BlockingDriver {
            started: std::sync::Mutex::new(Vec::new()),
            released: std::sync::Mutex::new(Vec::new()),
        });
        let (manager, usage, settled) = manager_with(driver.clone());
        let params = params(vec![chat_message(ChatRole::User, "hi")]);
        assert!(manager.start("stream-1", &params, None).await.is_ok());
        assert!(manager.cancel("stream-1"));
        assert!(manager.wait_for_chat_idle("chat-1", 2_000).await);
        assert!(!manager.has_active_generations());
        // Cancelled runs are not usage-captured as assistant turns.
        assert!(usage.lock().unwrap().is_empty());
        assert_eq!(settled.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn manager_records_usage_and_settlement_for_completed_runs() {
        let driver = Arc::new(BlockingDriver {
            started: std::sync::Mutex::new(Vec::new()),
            released: std::sync::Mutex::new(Vec::new()),
        });
        let (manager, usage, settled) = manager_with(driver.clone());
        let params = params(vec![chat_message(ChatRole::User, "hi")]);
        assert!(manager.start("stream-1", &params, None).await.is_ok());
        driver.release("stream-1");
        assert!(manager.wait_for_chat_idle("chat-1", 2_000).await);
        assert_eq!(&*usage.lock().unwrap(), &["stream-1".to_string()]);
        assert_eq!(
            &*settled.lock().unwrap(),
            &["chat-1:workspace-1".to_string()]
        );
    }

    #[tokio::test]
    async fn manager_turn_lease_handoff_gates_start() {
        let driver = Arc::new(BlockingDriver {
            started: std::sync::Mutex::new(Vec::new()),
            released: std::sync::Mutex::new(Vec::new()),
        });
        let (manager, _, _) = manager_with(driver.clone());
        let params = params(vec![chat_message(ChatRole::User, "hi")]);
        // Without a turn lease, start proceeds (the TS treats turnId as
        // optional for background/scheduler runs).
        assert!(manager.start("stream-1", &params, None).await.is_ok());
        assert!(manager.is_chat_busy("chat-1"));
        driver.release("stream-1");
        assert!(manager.wait_for_chat_idle("chat-1", 2_000).await);

        // A mismatched lease fails closed; the exact lease hands off.
        let wrong_lease = manager
            .admission()
            .try_begin("chat-other", "turn-x", "renderer", false)
            .unwrap();
        let error = manager
            .start("stream-2", &params, Some(&wrong_lease))
            .await
            .unwrap_err();
        assert!(error.contains("turn expired"));
        assert!(manager.admission().is_admitted("chat-other"));

        let lease = manager
            .admission()
            .try_begin("chat-1", "turn-1", "renderer", false)
            .unwrap();
        assert!(manager
            .start("stream-3", &params, Some(&lease))
            .await
            .is_ok());
        assert!(
            !manager.admission().is_admitted("chat-1"),
            "lease handed off"
        );
        assert!(manager.is_chat_busy("chat-1"));
        driver.release("stream-3");
        assert!(manager.wait_for_chat_idle("chat-1", 2_000).await);
    }
}
