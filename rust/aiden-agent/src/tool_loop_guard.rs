//! Port of `main/services/assistant/tool-loop-guard.ts` — attended tool-error
//! recovery that prevents infinite tool loops.

use aiden_core::{Message, ToolDef, UserContent, UserMessage};

/// One correction turn is allowed; a second consecutive error ends the loop.
pub const MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS: usize = 2;

pub const ATTENDED_TOOL_FAILURE_RECOVERY_REPLY: &str =
    "I couldn't complete that action after two tool attempts. Review the requested details and try again.";

/// The host-directed text-only turn injected after repeated attended tool
/// errors. Mirrors `attendedToolRecoveryMessage`.
pub fn attended_tool_recovery_message() -> String {
    [
        "[Aiden host guard] Two consecutive tool attempts failed. Do not call or imitate any tool",
        &format!(
            "again in this response. Reply with exactly this text and nothing else: \"{ATTENDED_TOOL_FAILURE_RECOVERY_REPLY}\""
        ),
    ]
    .join(" ")
}

/// State returned by [`advance_attended_tool_error_state`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttendedToolErrorState {
    pub consecutive_error_turns: usize,
    pub should_stop: bool,
}

/// Bounds an attended Assistant generation when a model keeps retrying
/// malformed or rejected tool calls. One correction turn is allowed; a second
/// consecutive error ends the loop before it can spam the dock or consume
/// tokens forever. A successful or text-only turn resets the streak.
///
/// `tool_results` holds the `isError` flag of each tool result of the turn
/// (true = error), mirroring `toolResults: readonly { isError?: boolean }[]`.
pub fn advance_attended_tool_error_state(
    current: usize,
    tool_results: &[bool],
) -> AttendedToolErrorState {
    if !tool_results.iter().any(|is_error| *is_error) {
        return AttendedToolErrorState {
            consecutive_error_turns: 0,
            should_stop: false,
        };
    }
    let consecutive_error_turns = current + 1;
    AttendedToolErrorState {
        consecutive_error_turns,
        should_stop: consecutive_error_turns >= MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS,
    }
}

/// The transcript + tool-set snapshot the attended loop mutates, mirroring
/// pi's `AgentContext` (`systemPrompt`, `messages`, `tools`).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentContext {
    pub system_prompt: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDef>,
}

/// Converts a repeated tool failure into one final text-only turn. Removing
/// every tool matters: some OpenAI-compatible local providers ignore a tool
/// error and emit the same invalid call again even when the system prompt
/// explicitly forbids it. Mirrors `recoverAttendedToolErrorContext`.
pub fn recover_attended_tool_error_context(
    mut context: AgentContext,
    timestamp: u64,
) -> AgentContext {
    context.messages.push(Message::User(UserMessage {
        content: UserContent::Text(attended_tool_recovery_message()),
        timestamp,
    }));
    context.tools = vec![];
    context
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{AssistantMessage, ContentBlock, StopReason, TextContent, Usage, UsageCost};

    #[test]
    fn attended_tool_errors_allow_one_correction_and_stop_the_second_failed_turn() {
        let first = advance_attended_tool_error_state(0, &[true]);
        assert_eq!(
            first,
            AttendedToolErrorState {
                consecutive_error_turns: 1,
                should_stop: false,
            }
        );

        let second = advance_attended_tool_error_state(first.consecutive_error_turns, &[true]);
        assert_eq!(
            second,
            AttendedToolErrorState {
                consecutive_error_turns: MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS,
                should_stop: true,
            }
        );
    }

    #[test]
    fn a_successful_or_text_only_turn_resets_the_attended_tool_error_streak() {
        assert_eq!(
            advance_attended_tool_error_state(1, &[false]),
            AttendedToolErrorState {
                consecutive_error_turns: 0,
                should_stop: false,
            }
        );
        assert_eq!(
            advance_attended_tool_error_state(1, &[]),
            AttendedToolErrorState {
                consecutive_error_turns: 0,
                should_stop: false,
            }
        );
    }

    #[test]
    fn repeated_attended_tool_errors_recover_with_one_host_directed_text_only_turn() {
        let context = AgentContext {
            system_prompt: Some("Aiden".to_string()),
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text("Create a briefing".to_string()),
                timestamp: 1,
            })],
            tools: vec![ToolDef {
                name: "schedule_task".to_string(),
                description: String::new(),
                parameters: serde_json::json!({}),
            }],
        };
        let recovered = recover_attended_tool_error_context(context, 2);
        assert!(recovered.tools.is_empty());
        match recovered.messages.last().unwrap() {
            Message::User(user) => {
                assert_eq!(user.timestamp, 2);
                assert_eq!(
                    user.content,
                    UserContent::Text(attended_tool_recovery_message())
                );
            }
            other => panic!("expected a trailing user message, got {other:?}"),
        }
        assert!(attended_tool_recovery_message().contains("exactly this text"));
        assert!(attended_tool_recovery_message().contains(ATTENDED_TOOL_FAILURE_RECOVERY_REPLY));
        assert!(!attended_tool_recovery_message()
            .to_lowercase()
            .contains("mcp"));
        assert!(!attended_tool_recovery_message()
            .to_lowercase()
            .contains("automation"));
        assert!(!attended_tool_recovery_message()
            .to_lowercase()
            .contains("project"));
        assert!(!attended_tool_recovery_message()
            .to_lowercase()
            .contains("validation"));
    }

    #[allow(dead_code)]
    fn message_fixture() -> Message {
        Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::Text(TextContent {
                text: "hi".to_string(),
                text_signature: None,
            })],
            api: "anthropic-messages".to_string(),
            provider: "anthropic".to_string(),
            model: "claude-sonnet-5".to_string(),
            response_model: None,
            response_id: None,
            usage: Usage {
                input: 1,
                output: 1,
                cache_read: 0,
                cache_write: 0,
                cache_write_1h: None,
                reasoning: None,
                total_tokens: 2,
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
            timestamp: 1,
        })
    }
}
