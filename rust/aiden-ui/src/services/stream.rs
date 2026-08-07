//! Pure streaming reducer: folds `AssistantMessageEvent`s (or transport
//! errors) into an incremental assistant message and emits batched flush
//! updates, mirroring the renderer's `chat-pane.tsx` rAF-batched delta
//! accumulation. This module has no GPUI or tokio types so it is unit-testable
//! off the app runtime.
//!
//! The reducer owns the *authoritative* accumulated text/thinking while a
//! stream is live. The background driver calls [`StreamReducer::apply`] for
//! every event and drains [`StreamReducer::take_flush`] on a ~30ms cadence;
//! terminal events are converted with [`StreamReducer::finalize`].

use aiden_core::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, StopReason, TextContent, ThinkingContent,
};

/// Errors during streaming that should surface as a chat error banner.
#[derive(Debug, Clone)]
pub struct StreamFailure {
    /// The user-facing message (provider error text).
    pub message: String,
}

/// A batched incremental update sent to the foreground.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamFlush {
    /// Accumulated *delta* to append to the assistant text (may be empty).
    pub text: String,
    /// Accumulated *delta* to append to the thinking text (may be empty).
    pub thinking: String,
    /// `Some(true)` when thinking started, `Some(false)` when it ended.
    pub thinking_active: Option<bool>,
}

/// The terminal outcome of a stream.
#[derive(Debug, Clone)]
pub enum StreamTerminal {
    /// The provider finished a turn. `message` carries the final normalized
    /// assistant message (with complete content blocks).
    Done { message: Box<AssistantMessage> },
    /// The stream failed; `partial` text/thinking arrived before the failure.
    Error {
        message: String,
        partial_text: String,
        partial_thinking: String,
    },
}

#[derive(Debug)]
pub struct StreamReducer {
    pub text: String,
    pub thinking: String,
    pub thinking_active: bool,
    /// Pending, not-yet-flushed deltas.
    pending_text: String,
    pending_thinking: String,
    pending_thinking_active: Option<bool>,
    pub final_message: Option<AssistantMessage>,
    pub failure: Option<StreamFailure>,
}

impl Default for StreamReducer {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamReducer {
    pub fn new() -> Self {
        Self {
            text: String::new(),
            thinking: String::new(),
            thinking_active: false,
            pending_text: String::new(),
            pending_thinking: String::new(),
            pending_thinking_active: None,
            final_message: None,
            failure: None,
        }
    }

    /// Fold one normalized stream event into the accumulated message. Content
    /// is driven purely by `*_delta` events (like the renderer): `partial`
    /// payloads inside start events already reflect the deltas that follow, so
    /// seeding from them would double-count. Terminal events carry the
    /// authoritative content.
    pub fn apply(&mut self, event: AssistantMessageEvent) {
        match event {
            AssistantMessageEvent::Start { .. } => {}
            AssistantMessageEvent::TextStart { .. } => {}
            AssistantMessageEvent::TextDelta { delta, .. } => {
                self.pending_text.push_str(&delta);
            }
            AssistantMessageEvent::TextEnd { content, .. } => {
                // The block's final content replaces the accumulated tail
                // (single text block per turn in the phase-5 transcript).
                self.text = content;
                self.pending_text.clear();
            }
            AssistantMessageEvent::ThinkingStart { .. } => {
                self.set_thinking_active(true);
            }
            AssistantMessageEvent::ThinkingDelta { delta, .. } => {
                if !self.thinking_active {
                    self.set_thinking_active(true);
                }
                self.pending_thinking.push_str(&delta);
            }
            AssistantMessageEvent::ThinkingEnd { content, .. } => {
                self.thinking = content;
                self.pending_thinking.clear();
                self.set_thinking_active(false);
            }
            AssistantMessageEvent::ToolcallStart { .. }
            | AssistantMessageEvent::ToolcallDelta { .. }
            | AssistantMessageEvent::ToolcallEnd { .. } => {
                // Tool calls are not rendered in the phase-5 transcript; the
                // final `Done` message still carries them for persistence.
            }
            AssistantMessageEvent::Done { message, .. } => {
                let (text, thinking) = message_content(&message);
                self.text = text;
                self.thinking = thinking;
                self.thinking_active = false;
                self.final_message = Some(message);
            }
            AssistantMessageEvent::Error { error, .. } => {
                self.failure = Some(StreamFailure {
                    message: error
                        .error_message
                        .clone()
                        .unwrap_or_else(|| "Provider stream error".to_string()),
                });
            }
        }
    }

    /// Record a transport-level failure (no terminal event arrived).
    pub fn fail(&mut self, message: impl Into<String>) {
        self.failure = Some(StreamFailure {
            message: message.into(),
        });
    }

    /// Drain the pending batched deltas.
    pub fn take_flush(&mut self) -> Option<StreamFlush> {
        let has_deltas = !self.pending_text.is_empty() || !self.pending_thinking.is_empty();
        let active_change = self.pending_thinking_active.take();
        if !has_deltas && active_change.is_none() {
            return None;
        }
        self.text.push_str(&self.pending_text);
        self.thinking.push_str(&self.pending_thinking);
        Some(StreamFlush {
            text: std::mem::take(&mut self.pending_text),
            thinking: std::mem::take(&mut self.pending_thinking),
            thinking_active: active_change,
        })
    }

    /// The terminal message for the channel. Folds any unflushed deltas into
    /// the accumulated text/thinking first so partial content survives.
    pub fn finalize(&mut self) -> StreamTerminal {
        self.take_flush();
        match &self.failure {
            Some(failure) => StreamTerminal::Error {
                message: failure.message.clone(),
                partial_text: self.text.clone(),
                partial_thinking: self.thinking.clone(),
            },
            None => StreamTerminal::Done {
                message: Box::new(self.final_message.clone().unwrap_or_else(empty_message)),
            },
        }
    }

    fn set_thinking_active(&mut self, active: bool) {
        if self.thinking_active == active {
            return;
        }
        self.thinking_active = active;
        self.pending_thinking_active = Some(active);
    }
}

/// Project the text/thinking content blocks of a normalized message.
pub fn message_content(message: &AssistantMessage) -> (String, String) {
    let mut text = String::new();
    let mut thinking = String::new();
    for block in &message.content {
        match block {
            ContentBlock::Text(TextContent { text: t, .. }) => text.push_str(t),
            ContentBlock::Thinking(ThinkingContent { thinking: t, .. }) => thinking.push_str(t),
            _ => {}
        }
    }
    (text, thinking)
}
fn empty_message() -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: String::new(),
        provider: String::new(),
        model: String::new(),
        response_model: None,
        response_id: None,
        usage: zero_usage(),
        stop_reason: StopReason::Stop,
        error_message: None,
        timestamp: 0,
    }
}

/// A zeroed usage snapshot for synthesized turns (persisted history replays).
pub fn zero_usage() -> aiden_core::Usage {
    aiden_core::Usage {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{
        AssistantMessage, ContentBlock, StopReason, TextContent, ThinkingContent, Usage, UsageCost,
    };

    fn partial(text: &str, thinking: &str) -> AssistantMessage {
        let mut content = Vec::new();
        if !thinking.is_empty() {
            content.push(ContentBlock::Thinking(ThinkingContent {
                thinking: thinking.to_string(),
                thinking_signature: None,
                redacted: None,
            }));
        }
        content.push(ContentBlock::Text(TextContent {
            text: text.to_string(),
            text_signature: None,
        }));
        AssistantMessage {
            content,
            api: "anthropic-messages".into(),
            provider: "anthropic".into(),
            model: "claude-sonnet-5".into(),
            response_model: None,
            response_id: Some("resp_1".into()),
            usage: Usage {
                input: 10,
                output: 5,
                cache_read: 0,
                cache_write: 0,
                cache_write_1h: None,
                reasoning: None,
                total_tokens: 15,
                cost: UsageCost {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total: 0.0,
                },
            },
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 1_700_000_000_000,
        }
    }

    #[test]
    fn accumulates_text_and_thinking_deltas_with_batched_flushes() {
        let mut reducer = StreamReducer::new();
        reducer.apply(AssistantMessageEvent::Start {
            partial: partial("", ""),
        });
        reducer.apply(AssistantMessageEvent::TextStart {
            content_index: 0,
            partial: partial("", ""),
        });
        reducer.apply(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "Hel".into(),
            partial: partial("Hel", ""),
        });
        reducer.apply(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "lo".into(),
            partial: partial("Hello", ""),
        });
        reducer.apply(AssistantMessageEvent::ThinkingStart {
            content_index: 0,
            partial: partial("Hello", "Let me"),
        });
        reducer.apply(AssistantMessageEvent::ThinkingDelta {
            content_index: 0,
            delta: " think".into(),
            partial: partial("Hello", "Let me think"),
        });

        // Deltas are batched; the first flush carries both pending chunks.
        let flush = reducer.take_flush().expect("batched flush");
        assert_eq!(flush.text, "Hello");
        assert_eq!(
            flush.thinking, " think",
            "deltas are forwarded, not re-seeded"
        );
        assert_eq!(flush.thinking_active, Some(true));
        assert!(
            reducer.take_flush().is_none(),
            "no second flush for empty pending"
        );

        // Thinking ends and the terminal content replaces the accumulated tail.
        reducer.apply(AssistantMessageEvent::ThinkingEnd {
            content_index: 0,
            content: "Let me think it through".into(),
            partial: partial("Hello", "Let me think it through"),
        });
        let flush = reducer.take_flush().expect("thinking-end flush");
        assert_eq!(flush.thinking_active, Some(false));
        assert_eq!(reducer.thinking, "Let me think it through");
        assert_eq!(reducer.text, "Hello");
    }

    #[test]
    fn done_finalizes_with_full_content() {
        let mut reducer = StreamReducer::new();
        reducer.apply(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "partial".into(),
            partial: partial("partial", ""),
        });
        let final_message = partial("The answer.", "I checked the docs");
        reducer.apply(AssistantMessageEvent::Done {
            reason: StopReason::Stop,
            message: final_message.clone(),
        });
        match reducer.finalize() {
            StreamTerminal::Done { message } => {
                assert_eq!(message_content(&message).0, "The answer.");
                assert_eq!(
                    message_content(&message).1,
                    "I checked the docs",
                    "thinking survives in the final message"
                );
            }
            other => panic!("expected done, got {other:?}"),
        }
    }

    #[test]
    fn error_terminal_keeps_partial_text() {
        let mut reducer = StreamReducer::new();
        reducer.apply(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "So far so".into(),
            partial: partial("So far so", ""),
        });
        reducer.apply(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: " good".into(),
            partial: partial("So far so good", ""),
        });
        let mut failing = partial("So far so good", "");
        failing.error_message = Some("overloaded".into());
        reducer.apply(AssistantMessageEvent::Error {
            reason: StopReason::Error,
            error: failing,
        });
        match reducer.finalize() {
            StreamTerminal::Error {
                message,
                partial_text,
                ..
            } => {
                assert_eq!(message, "overloaded");
                assert_eq!(partial_text, "So far so good");
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn transport_failure_maps_to_terminal_error() {
        let mut reducer = StreamReducer::new();
        reducer.fail("connection refused");
        match reducer.finalize() {
            StreamTerminal::Error { message, .. } => assert_eq!(message, "connection refused"),
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn flush_after_final_done_is_empty() {
        let mut reducer = StreamReducer::new();
        reducer.apply(AssistantMessageEvent::Done {
            reason: StopReason::Stop,
            message: partial("full", ""),
        });
        assert!(reducer.take_flush().is_none());
        assert_eq!(reducer.text, "full");
    }
}
