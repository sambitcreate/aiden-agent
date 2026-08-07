//! Pure assistant view state + the AgentEvent → view-state mapping (port of
//! `renderer/components/assistant/use-assistant-chat.ts` and the
//! `assistant-ui.test.tsx` expectations).
//!
//! The panel renders only [`AssistantViewState`]; the runner's `AgentEvent`
//! stream is folded in by [`AssistantViewState::apply_event`]. Everything here
//! is pure and unit-tested so the turn-accounting rules (optimistic
//! placeholders, terminal settle, fail-closed approvals) are provable without
//! a window.

use aiden_agent::AgentEvent;
use aiden_core::{
    AssistantMessage as CoreAssistantMessage, ContentBlock, Message, StopReason, TextContent,
    ThinkingContent, UserContent, UserMessage,
};

use crate::approvals::queue::{enqueue_approval, PendingApproval};

/// Who produced a message in the assistant transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssistantRole {
    User,
    Assistant,
}

/// One transcript entry. `thinking` renders as a muted block above the
/// assistant text (folded into the same bubble).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantMessage {
    pub role: AssistantRole,
    pub content: String,
    pub thinking: String,
}

impl AssistantMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: AssistantRole::User,
            content: content.into(),
            thinking: String::new(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: AssistantRole::Assistant,
            content: content.into(),
            thinking: String::new(),
        }
    }
}

/// The generation phase, mirroring `AssistantGenerationPhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AssistantPhase {
    #[default]
    Idle,
    Streaming,
    /// Settled by [`phase_after_stop`] (renderer-contract port; the panel
    /// resolves stops to `Idle` directly after cancelling the driver).
    #[allow(dead_code)]
    Stopping,
}

/// The full panel view state.
#[derive(Debug, Clone, Default)]
pub struct AssistantViewState {
    pub messages: Vec<AssistantMessage>,
    pub phase: AssistantPhase,
    pub stream_complete: bool,
    pub error: Option<String>,
    /// Pending approvals, FIFO; only the head is rendered.
    pub approvals: Vec<PendingApproval>,
    /// The approval the user is currently deciding (buttons disabled).
    pub deciding_approval_id: Option<String>,
}

impl AssistantViewState {
    /// Append one assistant text delta to the running reply, creating the
    /// bubble on first delta.
    fn push_text(&mut self, delta: &str) {
        match self.messages.last_mut() {
            Some(last) if last.role == AssistantRole::Assistant => last.content.push_str(delta),
            _ => self.messages.push(AssistantMessage::assistant(delta)),
        }
    }

    /// Append one thinking delta to the running reply's muted block.
    fn push_thinking(&mut self, delta: &str) {
        match self.messages.last_mut() {
            Some(last) if last.role == AssistantRole::Assistant => last.thinking.push_str(delta),
            _ => {
                let mut message = AssistantMessage::assistant("");
                message.thinking.push_str(delta);
                self.messages.push(message);
            }
        }
    }

    /// Fold one runner event into the view state (the event→view-state
    /// mapping). Idempotent for the runner's guard rails: tool progress does
    /// not disturb the transcript.
    pub fn apply_event(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::Text { delta } => self.push_text(delta),
            AgentEvent::Thinking { delta } => self.push_thinking(delta),
            AgentEvent::ApprovalRequired { details } => {
                if let Some(prompt) = PendingApproval::from_details(details) {
                    self.approvals = enqueue_approval(self.approvals.clone(), prompt);
                }
            }
            AgentEvent::Done { content } => {
                self.phase = AssistantPhase::Idle;
                self.stream_complete = true;
                self.error = None;
                self.messages = settle_messages(self.messages.clone(), content);
            }
            AgentEvent::Error { message } => {
                self.phase = AssistantPhase::Idle;
                self.stream_complete = false;
                self.error = Some(message.clone());
                // Keep the best partial reply, dropping a bare placeholder.
                self.messages = settle_failed_messages(self.messages.clone(), None, "");
            }
            AgentEvent::ToolStarted { .. } | AgentEvent::ToolFinished { .. } => {}
        }
    }

    /// Whether a new turn may start: not streaming, no in-flight approval
    /// decision, no stuck rendering state.
    pub fn can_start_turn(&self) -> bool {
        self.phase == AssistantPhase::Idle
            && !self.stream_complete
            && self.deciding_approval_id.is_none()
    }

    /// Begin a user turn: append the optimistic user message + empty assistant
    /// placeholder, clear stale approvals/errors, and enter the streaming
    /// phase. Mirrors the renderer's `send` optimistic state.
    pub fn start_turn(&mut self, content: &str) {
        self.error = None;
        self.stream_complete = false;
        self.approvals = Vec::new();
        self.deciding_approval_id = None;
        self.phase = AssistantPhase::Streaming;
        self.messages.push(AssistantMessage::user(content));
        self.messages.push(AssistantMessage::assistant(""));
    }

    /// Abandon the in-flight turn (stop / drop): mark the phase idle, keep any
    /// partial reply, and clear approvals so stale cards cannot be decided.
    pub fn stop_turn(&mut self) {
        self.phase = AssistantPhase::Idle;
        self.stream_complete = false;
        self.approvals = crate::approvals::queue::clear_approvals(self.approvals.clone());
        self.deciding_approval_id = None;
    }
}

/// `canSendAssistantMessage` — the pure send guard.
pub fn can_send(draft: &str, streaming: bool, ready: bool) -> bool {
    !draft.trim().is_empty() && !streaming && ready
}

/// `assistantGenerationPhaseAfterStop`.
#[allow(dead_code)] // renderer-contract port; exercised by unit tests
pub fn phase_after_stop(phase: AssistantPhase, has_active_generation: bool) -> AssistantPhase {
    if phase == AssistantPhase::Streaming && has_active_generation {
        AssistantPhase::Stopping
    } else {
        phase
    }
}

/// `canChangeAssistantThread`.
#[allow(dead_code)] // renderer-contract port; exercised by unit tests
pub fn can_change_thread(
    conversation_loading: bool,
    streaming: bool,
    rendering: bool,
    turn_saving: bool,
) -> bool {
    !conversation_loading && !streaming && !rendering && !turn_saving
}

/// `settleAssistantMessages` — reconcile the terminal response into the
/// transcript: append a reply when the last entry is not assistant, replace
/// when it differs, keep when identical.
pub fn settle_messages(
    messages: Vec<AssistantMessage>,
    full_content: &str,
) -> Vec<AssistantMessage> {
    if full_content.trim().is_empty() {
        return messages;
    }
    let mut next = messages;
    match next.last() {
        Some(last) if last.role == AssistantRole::Assistant => {
            if last.content == full_content {
                return next;
            }
            // `last` is `&AssistantMessage` borrowed from `next`; clone the
            // fields we need so the borrow ends before the mutable `pop`.
            let thinking = last.thinking.clone();
            next.pop();
            next.push(AssistantMessage {
                role: AssistantRole::Assistant,
                content: full_content.to_string(),
                thinking,
            });
        }
        _ => next.push(AssistantMessage::assistant(full_content)),
    }
    next
}

/// `settleFailedAssistantMessages` — preserve the best partial reply when a
/// generation terminates with an error.
pub fn settle_failed_messages(
    messages: Vec<AssistantMessage>,
    partial_content: Option<&str>,
    buffered_delta: &str,
) -> Vec<AssistantMessage> {
    if let Some(content) = partial_content {
        if !content.trim().is_empty() {
            return settle_messages(messages, content);
        }
    }
    let mut next = messages;
    if !buffered_delta.is_empty() {
        if let Some(last) = next.last_mut() {
            if last.role == AssistantRole::Assistant {
                last.content.push_str(buffered_delta);
                return next;
            }
        }
    }
    match next.last() {
        Some(last) if last.role == AssistantRole::Assistant && last.content.is_empty() => {
            next.pop();
        }
        _ => {}
    }
    next
}

/// `rollbackOptimisticAssistantTurn` — remove a user turn that never reached
/// durable chat history and its empty placeholder.
#[allow(dead_code)] // renderer-contract port; exercised by unit tests
pub fn rollback_optimistic_turn(
    messages: Vec<AssistantMessage>,
    user_content: &str,
) -> Vec<AssistantMessage> {
    let mut next = messages;
    if next
        .last()
        .is_some_and(|last| last.role == AssistantRole::Assistant && last.content.is_empty())
    {
        next.pop();
    }
    if next
        .last()
        .is_some_and(|last| last.role == AssistantRole::User && last.content == user_content)
    {
        next.pop();
    }
    next
}

/// Project the in-memory transcript into the normalized `Message` union the
/// runner feeds to the provider (mirrors `chat_history_to_messages`, keeping
/// thinking as a muted block).
pub fn history_to_messages(
    history: &[AssistantMessage],
    provider_id: &str,
    model: &str,
) -> Vec<Message> {
    history
        .iter()
        .map(|entry| match entry.role {
            AssistantRole::User => Message::User(UserMessage {
                content: UserContent::Text(entry.content.clone()),
                timestamp: aiden_data::now_millis(),
            }),
            AssistantRole::Assistant => {
                let mut content = Vec::new();
                if !entry.content.is_empty() {
                    content.push(ContentBlock::Text(TextContent {
                        text: entry.content.clone(),
                        text_signature: None,
                    }));
                }
                if !entry.thinking.is_empty() {
                    content.push(ContentBlock::Thinking(ThinkingContent {
                        thinking: entry.thinking.clone(),
                        thinking_signature: None,
                        redacted: None,
                    }));
                }
                Message::Assistant(CoreAssistantMessage {
                    content,
                    api: "openai-completions".to_string(),
                    provider: provider_id.to_string(),
                    model: model.to_string(),
                    response_model: None,
                    response_id: None,
                    usage: crate::services::stream::zero_usage(),
                    stop_reason: StopReason::Stop,
                    error_message: None,
                    timestamp: aiden_data::now_millis(),
                })
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_text(delta: &str) -> AgentEvent {
        AgentEvent::Text {
            delta: delta.to_string(),
        }
    }

    #[test]
    fn can_send_requires_a_non_blank_draft_an_idle_stream_and_readiness() {
        assert!(!can_send("  ", false, true));
        assert!(can_send("hello", false, true));
        assert!(!can_send("hello", true, true));
        assert!(!can_send("hello", false, false));
    }

    #[test]
    fn phase_after_stop_marks_stopping_only_with_an_active_generation() {
        assert_eq!(
            phase_after_stop(AssistantPhase::Streaming, true),
            AssistantPhase::Stopping
        );
        assert_eq!(
            phase_after_stop(AssistantPhase::Streaming, false),
            AssistantPhase::Streaming
        );
        assert_eq!(
            phase_after_stop(AssistantPhase::Idle, true),
            AssistantPhase::Idle
        );
    }

    #[test]
    fn text_and_thinking_deltas_accumulate_on_the_running_bubble() {
        let mut state = AssistantViewState::default();
        state.start_turn("List the files");
        state.apply_event(&event_text("Here "));
        state.apply_event(&event_text("are "));
        state.apply_event(&AgentEvent::Thinking {
            delta: "scanning".to_string(),
        });
        state.apply_event(&event_text("the files."));
        assert_eq!(state.messages.len(), 2);
        assert_eq!(state.messages[0].role, AssistantRole::User);
        assert_eq!(state.messages[0].content, "List the files");
        assert_eq!(state.messages[1].role, AssistantRole::Assistant);
        assert_eq!(state.messages[1].content, "Here are the files.");
        assert_eq!(state.messages[1].thinking, "scanning");
    }

    #[test]
    fn done_settles_the_terminal_content_and_stops_streaming() {
        let mut state = AssistantViewState::default();
        state.start_turn("hi");
        state.apply_event(&event_text("partial"));
        state.apply_event(&AgentEvent::Done {
            content: "the full reply".to_string(),
        });
        assert_eq!(state.phase, AssistantPhase::Idle);
        assert!(state.stream_complete);
        assert_eq!(state.messages.last().unwrap().content, "the full reply");
    }

    #[test]
    fn error_preserves_the_partial_reply_and_surfaces_the_message() {
        let mut state = AssistantViewState::default();
        state.start_turn("hi");
        state.apply_event(&event_text("so far"));
        state.apply_event(&AgentEvent::Error {
            message: "boom".to_string(),
        });
        assert_eq!(state.phase, AssistantPhase::Idle);
        assert_eq!(state.error.as_deref(), Some("boom"));
        assert_eq!(state.messages.last().unwrap().content, "so far");
    }

    #[test]
    fn error_drops_a_bare_placeholder() {
        let mut state = AssistantViewState::default();
        state.start_turn("hi");
        state.apply_event(&AgentEvent::Error {
            message: "boom".to_string(),
        });
        // User message survives; the empty assistant placeholder is dropped.
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].role, AssistantRole::User);
    }

    #[test]
    fn approval_required_enqueues_fifo_and_stop_clears() {
        let mut state = AssistantViewState::default();
        state.start_turn("create");
        state.apply_event(&AgentEvent::ApprovalRequired {
            details: serde_json::json!({
                "kind": "assistant-automation",
                "approvalId": "a-1",
                "toolCallId": "call-1",
                "toolName": "schedule_task",
                "summary": "Create",
            }),
        });
        state.apply_event(&AgentEvent::ApprovalRequired {
            details: serde_json::json!({
                "kind": "assistant-automation",
                "approvalId": "a-2",
                "toolCallId": "call-2",
                "toolName": "schedule_task",
                "summary": "Create",
            }),
        });
        assert_eq!(state.approvals.len(), 2);
        assert_eq!(state.approvals[0].approval_id, "a-1");
        // A duplicate id is ignored.
        state.apply_event(&AgentEvent::ApprovalRequired {
            details: serde_json::json!({
                "kind": "assistant-automation",
                "approvalId": "a-1",
                "toolCallId": "call-1",
                "toolName": "schedule_task",
                "summary": "Create",
            }),
        });
        assert_eq!(state.approvals.len(), 2);
        state.stop_turn();
        assert!(state.approvals.is_empty());
        assert_eq!(state.phase, AssistantPhase::Idle);
    }

    #[test]
    fn settle_messages_appends_replaces_or_keeps() {
        let messages = vec![
            AssistantMessage::user("q"),
            AssistantMessage::assistant("partial"),
        ];
        let settled = settle_messages(messages.clone(), "full reply");
        assert_eq!(settled.last().unwrap().content, "full reply");
        assert_eq!(settled.len(), 2);

        let same = settle_messages(settled.clone(), "full reply");
        assert_eq!(same, settled);

        let appended = settle_messages(vec![AssistantMessage::user("q")], "first reply");
        assert_eq!(appended.len(), 2);
        assert_eq!(appended.last().unwrap().content, "first reply");

        // Empty content leaves the transcript untouched.
        assert_eq!(settle_messages(messages.clone(), "  ").len(), 2);
    }

    #[test]
    fn settle_messages_preserves_thinking_when_replacing_the_last_reply() {
        // Regression guard for the borrow-safe rewrite of the replace branch:
        // the prior assistant entry's `thinking` must survive the pop + push.
        let messages = vec![
            AssistantMessage::user("q"),
            AssistantMessage {
                role: AssistantRole::Assistant,
                content: "partial".to_string(),
                thinking: "reasoning that must survive".to_string(),
            },
        ];
        let settled = settle_messages(messages, "the final reply");
        assert_eq!(settled.len(), 2);
        let last = &settled[1];
        assert_eq!(last.role, AssistantRole::Assistant);
        assert_eq!(last.content, "the final reply");
        assert_eq!(last.thinking, "reasoning that must survive");
    }

    #[test]
    fn settle_failed_messages_routes_non_empty_partial_through_settle() {
        // Guards the unwrap-free partial branch: a non-empty partial reply is
        // settled into the transcript; an all-whitespace partial is ignored.
        let settled = settle_failed_messages(vec![AssistantMessage::user("q")], Some("   "), "");
        assert_eq!(settled.len(), 1, "whitespace-only partial is not settled");
        let settled =
            settle_failed_messages(vec![AssistantMessage::user("q")], Some("real partial"), "");
        assert_eq!(settled.last().unwrap().content, "real partial");
    }

    #[test]
    fn settle_failed_and_rollback_keep_the_best_partial_state() {
        let messages = vec![AssistantMessage::user("q")];
        let with_partial = settle_failed_messages(messages.clone(), Some("partial"), "");
        assert_eq!(with_partial.last().unwrap().content, "partial");

        let buffered = settle_failed_messages(
            vec![AssistantMessage::user("q"), AssistantMessage::assistant("")],
            None,
            "delta",
        );
        assert_eq!(buffered.last().unwrap().content, "delta");

        let bare = settle_failed_messages(
            vec![AssistantMessage::user("q"), AssistantMessage::assistant("")],
            None,
            "",
        );
        assert_eq!(bare.len(), 1);

        let rolled = rollback_optimistic_turn(
            vec![AssistantMessage::user("q"), AssistantMessage::assistant("")],
            "q",
        );
        assert!(rolled.is_empty());
    }

    #[test]
    fn history_projects_to_the_provider_message_union() {
        let history = vec![
            AssistantMessage::user("q"),
            AssistantMessage {
                role: AssistantRole::Assistant,
                content: "a".to_string(),
                thinking: "t".to_string(),
            },
        ];
        let messages = history_to_messages(&history, "provider", "model");
        assert_eq!(messages.len(), 2);
        assert!(matches!(
            &messages[0],
            Message::User(user) if matches!(&user.content, UserContent::Text(t) if t == "q")
        ));
        let Message::Assistant(assistant) = &messages[1] else {
            panic!("expected assistant message");
        };
        assert_eq!(assistant.provider, "provider");
        assert!(matches!(&assistant.content[0], ContentBlock::Text(t) if t.text == "a"));
        assert!(matches!(
            &assistant.content[1],
            ContentBlock::Thinking(t) if t.thinking == "t"
        ));
    }
}
