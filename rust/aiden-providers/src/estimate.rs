//! Token estimation — port of pi-ai `utils/estimate.js` and the message-level
//! estimator from `pi-agent-core/dist/harness/compaction/compaction.js`.
//!
//! Deterministic heuristic (chars/4) corrected by the last provider-reported
//! usage anchor, plus the compaction threshold helpers used by
//! [`crate::compact`]. No tokenizer dependency; no IO.

use aiden_core::{ContentBlock, Message, ToolDef, Usage, UserContent};

const CHARS_PER_TOKEN: f64 = 4.0;
/// Estimated chars for one image block (`ESTIMATED_IMAGE_CHARS`).
pub const ESTIMATED_IMAGE_CHARS: usize = 4800;
/// Context safety headroom used by `clamp_max_tokens_to_context`.
pub const CONTEXT_SAFETY_TOKENS: usize = 4096;

/// `calculateContextTokens` — total tokens from a usage block.
pub fn calculate_context_tokens(usage: &Usage) -> u64 {
    if usage.total_tokens > 0 {
        usage.total_tokens
    } else {
        usage.input + usage.output + usage.cache_read + usage.cache_write
    }
}

fn safe_json_stringify(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[unserializable]".to_string())
}

/// Chars of a text-or-image content value (`estimateTextAndImageContentChars`).
pub fn estimate_text_and_image_content_chars(content: &UserContent) -> usize {
    match content {
        UserContent::Text(text) => text.len(),
        UserContent::Blocks(blocks) => blocks.iter().fold(0, |total, block| match block {
            aiden_core::UserBlock::Text(text) => total + text.text.len(),
            aiden_core::UserBlock::Image(_) => total + ESTIMATED_IMAGE_CHARS,
        }),
    }
}

/// Chars of a content-block list (tool results, assistant blocks).
pub fn content_blocks_chars(content: &[ContentBlock]) -> usize {
    content.iter().fold(0, |total, block| match block {
        ContentBlock::Text(text) => total + text.text.len(),
        ContentBlock::Thinking(thinking) => total + thinking.thinking.len(),
        ContentBlock::Image(_) => total + ESTIMATED_IMAGE_CHARS,
        ContentBlock::ToolCall(tool_call) => {
            total + tool_call.name.len() + safe_json_stringify(&tool_call.arguments).len()
        }
    })
}

/// `estimateTextTokens`.
pub fn estimate_text_tokens(text: &str) -> usize {
    (text.len() as f64 / CHARS_PER_TOKEN).ceil() as usize
}

/// `estimateTextAndImageContentTokens`.
pub fn estimate_text_and_image_content_tokens(content: &UserContent) -> usize {
    (estimate_text_and_image_content_chars(content) as f64 / CHARS_PER_TOKEN).ceil() as usize
}

/// `estimateMessageTokens` (pi-ai utils): user/toolResult by content; assistant
/// by block text; used for trailing tokens after a usage anchor.
pub fn estimate_message_tokens(message: &Message) -> usize {
    match message {
        Message::User(user) => estimate_text_and_image_content_tokens(&user.content),
        Message::ToolResult(result) => {
            (content_blocks_chars(&result.content) as f64 / CHARS_PER_TOKEN).ceil() as usize
        }
        Message::Assistant(assistant) => {
            (content_blocks_chars(&assistant.content) as f64 / CHARS_PER_TOKEN).ceil() as usize
        }
    }
}

/// `estimateTokens` (pi-agent-core): conservative per-message heuristic.
pub fn estimate_tokens(message: &Message) -> usize {
    match message {
        Message::User(user) => (estimate_text_and_image_content_chars(&user.content) as f64
            / CHARS_PER_TOKEN)
            .ceil() as usize,
        Message::Assistant(assistant) => {
            (content_blocks_chars(&assistant.content) as f64 / CHARS_PER_TOKEN).ceil() as usize
        }
        Message::ToolResult(result) => {
            (content_blocks_chars(&result.content) as f64 / CHARS_PER_TOKEN).ceil() as usize
        }
    }
}

/// A valid usage anchor: assistant message, not aborted/errored, with positive
/// context tokens.
fn assistant_usage(message: &Message) -> Option<&Usage> {
    if let Message::Assistant(assistant) = message {
        if assistant.stop_reason != aiden_core::StopReason::Aborted
            && assistant.stop_reason != aiden_core::StopReason::Error
            && calculate_context_tokens(&assistant.usage) > 0
        {
            return Some(&assistant.usage);
        }
    }
    None
}

/// Result of an anchored context estimate.
#[derive(Debug, Clone, Copy)]
pub struct ContextUsageEstimate {
    /// Estimated total context tokens.
    pub tokens: usize,
    /// Tokens reported by the most recent assistant usage block.
    pub usage_tokens: u64,
    /// Estimated tokens after the most recent assistant usage block.
    pub trailing_tokens: usize,
    /// Index of the usage-bearing message, or `None`.
    pub last_usage_index: Option<usize>,
}

/// `getLastAssistantUsageInfo` — newest usage whose timestamp is not older than
/// a later prefix message (a compaction summary invalidates earlier anchors).
fn get_last_assistant_usage_info(messages: &[Message]) -> Option<(usize, &Usage)> {
    let mut latest_prefix_timestamp: i64 = i64::MIN;
    let mut usage_info: Option<(usize, &Usage)> = None;
    for (index, message) in messages.iter().enumerate() {
        if let Message::Assistant(assistant) = message {
            let usage_applies_to_prefix = assistant.timestamp as i64 >= latest_prefix_timestamp;
            if usage_applies_to_prefix {
                if let Some(usage) = assistant_usage(message) {
                    usage_info = Some((index, usage));
                }
            }
        }
        let timestamp = match message {
            Message::User(user) => user.timestamp as i64,
            Message::Assistant(assistant) => assistant.timestamp as i64,
            Message::ToolResult(result) => result.timestamp as i64,
        };
        latest_prefix_timestamp = latest_prefix_timestamp.max(timestamp);
    }
    usage_info
}

/// `estimateMessages` — anchored estimate over a message list.
pub fn estimate_messages(messages: &[Message]) -> ContextUsageEstimate {
    if let Some((last_index, usage)) = get_last_assistant_usage_info(messages) {
        let usage_tokens = calculate_context_tokens(usage);
        let mut trailing_tokens = 0;
        for message in &messages[last_index + 1..] {
            trailing_tokens += estimate_message_tokens(message);
        }
        return ContextUsageEstimate {
            tokens: usage_tokens as usize + trailing_tokens,
            usage_tokens,
            trailing_tokens,
            last_usage_index: Some(last_index),
        };
    }
    let tokens: usize = messages.iter().map(estimate_message_tokens).sum();
    ContextUsageEstimate {
        tokens,
        usage_tokens: 0,
        trailing_tokens: tokens,
        last_usage_index: None,
    }
}

/// `estimateToolsTokens`.
pub fn estimate_tools_tokens(tools: Option<&[ToolDef]>) -> usize {
    let Some(tools) = tools else {
        return 0;
    };
    if tools.is_empty() {
        return 0;
    }
    let value = serde_json::json!(tools);
    estimate_text_tokens(&safe_json_stringify(&value))
}

/// `estimateContextTokens` (message-array overload) — the anchored estimate
/// used by Aiden's compaction.
pub fn estimate_context_tokens(messages: &[Message]) -> ContextUsageEstimate {
    estimate_messages(messages)
}

/// `estimateContextTokens` (context-object overload): adds system prompt +
/// deferred tool tokens when no anchor exists.
pub fn estimate_context_tokens_with_prefix(
    system_prompt: Option<&str>,
    tools: Option<&[ToolDef]>,
    messages: &[Message],
) -> ContextUsageEstimate {
    let estimate = estimate_messages(messages);
    if estimate.last_usage_index.is_some() {
        return estimate;
    }
    let prefix_tokens =
        system_prompt.map(estimate_text_tokens).unwrap_or(0) + estimate_tools_tokens(tools);
    ContextUsageEstimate {
        tokens: estimate.tokens + prefix_tokens,
        usage_tokens: estimate.usage_tokens,
        trailing_tokens: estimate.trailing_tokens + prefix_tokens,
        last_usage_index: None,
    }
}

/// `shouldCompact` (pi-agent-core): context exceeds window minus reserve.
pub fn should_compact(context_tokens: usize, context_window: usize, reserve_tokens: usize) -> bool {
    context_tokens > context_window.saturating_sub(reserve_tokens)
}

/// `clampMaxTokensToContext` (pi-ai simple-options): fit max tokens inside the
/// window with 4096 safety headroom; at least 1.
pub fn clamp_max_tokens_to_context(
    context_window: u32,
    messages: &[Message],
    max_tokens: u32,
) -> u32 {
    if context_window == 0 {
        return max_tokens.max(1);
    }
    let estimated = estimate_context_tokens(messages).tokens as u32;
    let available = (context_window as i64) - (estimated as i64) - (CONTEXT_SAFETY_TOKENS as i64);
    let available = available.max(1) as u32;
    max_tokens.min(available)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{
        AssistantMessage, ImageContent, StopReason, TextContent, ToolCall, ToolResultMessage,
        UserBlock, UserMessage,
    };

    fn usage(total: u64) -> Usage {
        Usage {
            input: 10,
            output: 20,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: None,
            reasoning: Some(4),
            total_tokens: total,
            cost: aiden_core::UsageCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total: 0.0,
            },
        }
    }

    fn assistant(text: &str, total: u64, timestamp: u64) -> Message {
        Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
            })],
            api: "openai-completions".into(),
            provider: "test".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage: usage(total),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp,
        })
    }

    fn user(text: &str, timestamp: u64) -> Message {
        Message::User(UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp,
        })
    }

    #[test]
    fn text_estimate_is_chars_over_four() {
        assert_eq!(estimate_text_tokens("abcd"), 1);
        assert_eq!(estimate_text_tokens("abcde"), 2);
        assert_eq!(estimate_text_tokens(""), 0);
    }

    #[test]
    fn images_are_4800_chars() {
        let content = UserContent::Blocks(vec![
            UserBlock::Image(ImageContent {
                data: "AA".into(),
                mime_type: "image/png".into(),
            }),
            UserBlock::Text(TextContent {
                text: "hi".into(),
                text_signature: None,
            }),
        ]);
        assert_eq!(estimate_text_and_image_content_chars(&content), 4802);
        assert_eq!(estimate_text_and_image_content_tokens(&content), 1201);
    }

    #[test]
    fn usage_anchor_replaces_heuristic() {
        let messages = vec![
            user("12345678", 1),                 // 2 tokens heuristic
            assistant(&"x".repeat(400), 500, 2), // 100 tokens heuristic, but usage says 500
            user("abcdefgh", 3),                 // 2 tokens trailing
        ];
        let estimate = estimate_context_tokens(&messages);
        assert_eq!(estimate.last_usage_index, Some(1));
        assert_eq!(estimate.usage_tokens, 500);
        assert_eq!(estimate.trailing_tokens, 2);
        assert_eq!(estimate.tokens, 502);
    }

    #[test]
    fn errored_aborted_anchors_are_ignored() {
        let mut message = assistant(&"x".repeat(400), 500, 1);
        let Message::Assistant(assistant) = &mut message else {
            unreachable!()
        };
        assistant.stop_reason = StopReason::Error;
        let messages = vec![user("12345678", 2), message];
        let estimate = estimate_context_tokens(&messages);
        assert_eq!(estimate.last_usage_index, None);
        // Heuristic fallback: user (2 tokens) + assistant (100 tokens).
        assert_eq!(estimate.tokens, 102);
    }

    #[test]
    fn newer_prefix_message_invalidates_older_anchor() {
        // A prefix message inserted after the response (e.g. a compaction
        // summary) carries a newer timestamp; the older anchor no longer
        // describes the prefix, so the heuristic fallback is used.
        let messages = vec![
            user("summary", 5000),
            assistant(&"x".repeat(400), 500, 1),
            user("12345678", 6000),
        ];
        let estimate = estimate_context_tokens(&messages);
        assert_eq!(estimate.last_usage_index, None);
        assert_eq!(estimate.usage_tokens, 0);
    }

    #[test]
    fn tool_result_tokens_include_text_only() {
        let result = Message::ToolResult(ToolResultMessage {
            tool_call_id: "c".into(),
            tool_name: "grep".into(),
            content: vec![ContentBlock::Text(TextContent {
                text: "0123456789".into(), // 3 tokens
                text_signature: None,
            })],
            details: None,
            added_tool_names: None,
            is_error: false,
            timestamp: 1,
        });
        assert_eq!(estimate_tokens(&result), 3);
    }

    #[test]
    fn tool_call_blocks_count_name_and_arguments() {
        let message = Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::ToolCall(ToolCall {
                id: "c".into(),
                name: "grep".into(),
                arguments: serde_json::json!({"pattern": "abcdefghijklmno"}), // 15 chars
                thought_signature: None,
            })],
            api: "openai-completions".into(),
            provider: "test".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage: usage(0),
            stop_reason: StopReason::ToolUse,
            error_message: None,
            timestamp: 1,
        });
        // "grep" (4) + serialized args `{"pattern":"abcdefghijklmno"}` (29)
        // = 33 chars → 9 tokens.
        assert_eq!(estimate_tokens(&message), 9);
    }

    #[test]
    fn should_compact_uses_window_minus_reserve() {
        assert!(!should_compact(1000, 100_000, 16_384));
        assert!(should_compact(100_000, 100_000, 16_384));
        assert!(!should_compact(83_616, 100_000, 16_384));
        assert!(should_compact(83_617, 100_000, 16_384));
    }

    #[test]
    fn clamp_max_tokens_leaves_headroom() {
        // window 1000, 4-token message, 4096 headroom → available = 0 → clamp 1.
        let messages = vec![user("1234", 1)];
        assert_eq!(clamp_max_tokens_to_context(1000, &messages, 8192), 1);
        // Large window: no clamp.
        assert_eq!(
            clamp_max_tokens_to_context(1_000_000, &messages, 8192),
            8192
        );
    }
}
