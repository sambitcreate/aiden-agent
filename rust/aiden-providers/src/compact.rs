//! Context compaction — literal port of `main/services/generation-context.ts`.
//!
//! Deterministic, Electron-free: provider-usage-anchored estimation plus an
//! ordered degradation ladder (Computer Use image cap → tool-result
//! truncation → history dropping → current-turn tool-result stubbing →
//! history purge → assistant-batch drops → the fixed context-fallback notice).
//! The fallback notice text is byte-identical to the TS constant.

use std::collections::HashSet;
use std::ops::Range;

use aiden_core::{ContentBlock, Message, TextContent, ToolDef, UserContent, UserMessage};

use crate::estimate::{
    estimate_context_tokens, estimate_tokens, should_compact, ContextUsageEstimate,
};
use crate::json::group_digits;

const TOOL_RESULT_TEXT_LIMIT_CHARS: usize = 32_000;
const RECENT_TOOL_OUTPUT_BUDGET_TOKENS: usize = 40_000;
const MIN_RECENT_TOOL_RESULTS: usize = 2;
const RESPONSE_RESERVE_RATIO: f64 = 0.2;
const SAFETY_RESERVE_RATIO: f64 = 0.05;
const MIN_RESERVE_TOKENS: usize = 1_024;
/// pi-agent-core default compaction settings (`reserveTokens`).
const DEFAULT_RESERVE_TOKENS: usize = 16_384;
const CONTEXT_FALLBACK_TEXT: &str =
    "[Aiden context notice: The active conversation could not be safely retained within this model's context window. Explain that the user should retry with a larger-context model or fewer/lower-size attachments. Do not call tools for this notice.]";

#[derive(Debug, Clone)]
pub struct GenerationContextOptions {
    pub context_window: u32,
    pub system_prompt: String,
    pub tools: Vec<ToolDef>,
}

#[derive(Debug, Clone)]
pub struct GenerationContextCompaction {
    pub messages: Vec<Message>,
    pub compacted: bool,
    pub estimated_tokens_before: usize,
    pub estimated_tokens_after: usize,
    pub input_budget_tokens: usize,
    pub truncated_tool_results: usize,
    pub compacted_tool_results: usize,
    pub removed_history_messages: usize,
    pub removed_current_turn_messages: usize,
    pub used_context_fallback: bool,
}

fn safe_json_length(value: &serde_json::Value) -> usize {
    serde_json::to_string(value)
        .map(|text| text.len())
        .unwrap_or(0)
}

/// System prompt + serialized tool definitions, chars/4.
fn static_context_tokens(options: &GenerationContextOptions) -> usize {
    let mut chars = options.system_prompt.len();
    for tool in &options.tools {
        let serialized = safe_json_length(&serde_json::json!({
            "name": tool.name,
            "label": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }));
        chars += if serialized > 0 {
            serialized
        } else {
            tool.name.len()
                + tool.name.len()
                + tool.description.len()
                + safe_json_length(&tool.parameters)
                + 64
        };
    }
    (chars as f64 / 4.0).ceil() as usize
}

fn message_tokens(messages: &[Message]) -> usize {
    messages.iter().map(estimate_tokens).sum()
}

fn is_tool_result(message: &Message) -> bool {
    matches!(message, Message::ToolResult(_))
}

/// Keep only the newest Computer Use screenshots while preserving text.
pub fn limit_computer_use_images(messages: Vec<Message>, keep: usize) -> Vec<Message> {
    let image_indexes: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            if let Message::ToolResult(result) = message {
                if result.tool_name == "computer_use"
                    && result
                        .content
                        .iter()
                        .any(|part| matches!(part, ContentBlock::Image(_)))
                {
                    return Some(index);
                }
            }
            None
        })
        .collect();
    if image_indexes.len() <= keep {
        return messages;
    }
    let strip: HashSet<usize> = image_indexes
        .iter()
        .take(image_indexes.len().saturating_sub(keep))
        .copied()
        .collect();
    messages
        .into_iter()
        .enumerate()
        .map(|(index, message)| {
            if !strip.contains(&index) {
                return message;
            }
            let Message::ToolResult(mut result) = message else {
                return message;
            };
            result
                .content
                .retain(|part| !matches!(part, ContentBlock::Image(_)));
            Message::ToolResult(result)
        })
        .collect()
}

fn compacted_tool_result(message: &Message) -> Message {
    let Message::ToolResult(result) = message else {
        return message.clone();
    };
    let outcome = if result.is_error {
        "error payload"
    } else {
        "result payload"
    };
    let text = format!(
        "[Earlier {} {} omitted to stay within the model context window. This tool call already completed; do not repeat it solely because its payload was omitted.]",
        result.tool_name, outcome
    );
    Message::ToolResult(aiden_core::ToolResultMessage {
        tool_call_id: result.tool_call_id.clone(),
        tool_name: result.tool_name.clone(),
        content: vec![ContentBlock::Text(TextContent {
            text,
            text_signature: None,
        })],
        details: result.details.clone(),
        added_tool_names: result.added_tool_names.clone(),
        is_error: result.is_error,
        timestamp: result.timestamp,
    })
}

fn context_fallback(messages: &[Message]) -> Message {
    let timestamp = messages.iter().fold(0u64, |latest, message| {
        let message_ts = match message {
            Message::User(user) => user.timestamp,
            Message::Assistant(assistant) => assistant.timestamp,
            Message::ToolResult(result) => result.timestamp,
        };
        latest.max(message_ts)
    });
    Message::User(UserMessage {
        content: UserContent::Text(CONTEXT_FALLBACK_TEXT.to_string()),
        timestamp: timestamp.max(crate::now_ms()),
    })
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    let omitted = text.len() - max_chars;
    let marker = format!(
        "\n\n[... {} characters compacted ...]\n\n",
        group_digits(omitted as u64)
    );
    let available = max_chars.saturating_sub(marker.len());
    let head = available.div_ceil(2);
    let tail = available / 2;
    let mut result = String::new();
    // Byte offsets may land inside a multi-byte character; snap to the nearest
    // char boundary so truncation never panics on non-ASCII tool output.
    let head = floor_char_boundary(text, head);
    let tail_start = floor_char_boundary(text, text.len().saturating_sub(tail));
    result.push_str(&text[..head]);
    result.push_str(&marker);
    if tail_start < text.len() {
        result.push_str(&text[tail_start..]);
    }
    result
}

/// The largest char boundary at or below `index` (MSRV-safe stand-in for
/// `str::floor_char_boundary`, which stabilized after the crate's MSRV).
fn floor_char_boundary(text: &str, index: usize) -> usize {
    let index = index.min(text.len());
    if text.is_char_boundary(index) {
        index
    } else {
        (0..index)
            .rev()
            .find(|&i| text.is_char_boundary(i))
            .unwrap_or(0)
    }
}

fn truncate_tool_result(message: &Message) -> (Message, bool) {
    let Message::ToolResult(result) = message else {
        return (message.clone(), false);
    };
    let text = result
        .content
        .iter()
        .filter_map(|part| match part {
            ContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.len() <= TOOL_RESULT_TEXT_LIMIT_CHARS {
        return (message.clone(), false);
    }
    let images: Vec<ContentBlock> = result
        .content
        .iter()
        .filter(|part| matches!(part, ContentBlock::Image(_)))
        .cloned()
        .collect();
    let mut content = vec![ContentBlock::Text(TextContent {
        text: truncate_text(&text, TOOL_RESULT_TEXT_LIMIT_CHARS),
        text_signature: None,
    })];
    content.extend(images);
    (
        Message::ToolResult(aiden_core::ToolResultMessage {
            tool_call_id: result.tool_call_id.clone(),
            tool_name: result.tool_name.clone(),
            content,
            details: result.details.clone(),
            added_tool_names: result.added_tool_names.clone(),
            is_error: result.is_error,
            timestamp: result.timestamp,
        }),
        true,
    )
}

fn last_user_index(messages: &[Message]) -> isize {
    for index in (0..messages.len()).rev() {
        if matches!(messages[index], Message::User(_)) {
            return index as isize;
        }
    }
    -1
}

/// Keep the provider-usage anchor attached to the same logical message while
/// deterministic compaction removes complete ranges around it.
fn adjust_usage_anchor_for_drain(anchor_index: &mut Option<usize>, range: Range<usize>) {
    let Some(index) = *anchor_index else {
        return;
    };
    *anchor_index = if index < range.start {
        Some(index)
    } else if index < range.end {
        None
    } else {
        Some(index - (range.end - range.start))
    };
}

fn drain_messages(
    messages: &mut Vec<Message>,
    range: Range<usize>,
    usage_anchor_index: &mut Option<usize>,
) -> usize {
    let removed = range.end.saturating_sub(range.start);
    adjust_usage_anchor_for_drain(usage_anchor_index, range.clone());
    messages.drain(range);
    removed
}

/// Drop the oldest historical turn, preserving the N newest user turns.
fn remove_old_historical_turn(
    messages: &mut Vec<Message>,
    preserve_user_turns: usize,
    usage_anchor_index: &mut Option<usize>,
) -> usize {
    let current_user = last_user_index(messages);
    if current_user <= 0 {
        return 0;
    }
    let user_indexes: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            if matches!(message, Message::User(_)) {
                Some(index)
            } else {
                None
            }
        })
        .collect();
    if user_indexes.len() <= preserve_user_turns {
        return 0;
    }
    let next_user = user_indexes[1];
    if next_user > current_user as usize {
        return 0;
    }
    drain_messages(messages, 0..next_user, usage_anchor_index)
}

fn replace_tool_result(messages: &mut [Message], index: usize) -> bool {
    if !is_tool_result(&messages[index]) {
        return false;
    }
    let replacement = compacted_tool_result(&messages[index]);
    messages[index] = replacement;
    true
}

fn current_turn_tool_result_indexes(messages: &[Message]) -> Vec<usize> {
    let current_user = last_user_index(messages);
    if current_user < 0 {
        return Vec::new();
    }
    let mut indexes = Vec::new();
    for (index, message) in messages.iter().enumerate().skip(current_user as usize + 1) {
        if is_tool_result(message) {
            indexes.push(index);
        }
    }
    indexes
}

fn protected_recent_tool_results(
    messages: &[Message],
    indexes: &[usize],
    budget_tokens: usize,
) -> HashSet<usize> {
    let mut protected = HashSet::new();
    let mut tokens = 0usize;
    for position in (0..indexes.len()).rev() {
        let index = indexes[position];
        let Some(message) = messages.get(index) else {
            continue;
        };
        if !is_tool_result(message) {
            continue;
        }
        let next_tokens = tokens + estimate_tokens(message);
        if protected.len() < MIN_RECENT_TOOL_RESULTS || next_tokens <= budget_tokens {
            protected.insert(index);
            tokens = next_tokens;
            continue;
        }
        break;
    }
    protected
}

fn remove_oldest_current_turn_batch(
    messages: &mut Vec<Message>,
    usage_anchor_index: &mut Option<usize>,
) -> usize {
    let current_user = last_user_index(messages);
    if current_user < 0 {
        return 0;
    }
    let assistant_indexes: Vec<usize> = ((current_user as usize + 1)..messages.len())
        .filter(|index| matches!(messages[*index], Message::Assistant(_)))
        .collect();
    if assistant_indexes.len() <= 1 {
        return 0;
    }
    let start = assistant_indexes[0];
    let end = assistant_indexes[1];
    drain_messages(messages, start..end, usage_anchor_index)
}

struct GenerationContextLimits {
    context_window: usize,
    reserve_tokens: usize,
    static_tokens: usize,
    input_budget_tokens: usize,
}

fn context_limits(options: &GenerationContextOptions) -> GenerationContextLimits {
    let context_window = if options.context_window > 0 {
        (options.context_window as usize).max(1)
    } else {
        1
    };
    let response_reserve = DEFAULT_RESERVE_TOKENS.min(
        MIN_RESERVE_TOKENS.max((context_window as f64 * RESPONSE_RESERVE_RATIO).floor() as usize),
    );
    let safety_reserve =
        MIN_RESERVE_TOKENS.max((context_window as f64 * SAFETY_RESERVE_RATIO).floor() as usize);
    let reserve_tokens = (context_window - 1).min(response_reserve + safety_reserve);
    GenerationContextLimits {
        context_window,
        reserve_tokens,
        static_tokens: static_context_tokens(options),
        input_budget_tokens: context_window.saturating_sub(reserve_tokens),
    }
}

/// Fail before provider I/O when even the recovery notice cannot fit.
pub fn assert_generation_context_capacity(
    options: &GenerationContextOptions,
) -> Result<(), String> {
    if options.context_window == 0 {
        return Err("The selected model does not report a usable context window.".to_string());
    }
    let limits = context_limits(options);
    let fallback_tokens = estimate_tokens(&context_fallback(&[]));
    if limits.static_tokens + fallback_tokens > limits.input_budget_tokens {
        return Err(format!(
            "The selected model's {}-token context window is too small for Aiden's active system prompt and tools. Choose a larger-context model or disable integrations that add tools.",
            group_digits(limits.context_window as u64)
        ));
    }
    Ok(())
}

fn estimated_total_tokens(
    candidate: &[Message],
    usage_anchor_index: Option<usize>,
    provider_prefix_ratio: f64,
    static_tokens: usize,
) -> usize {
    let estimated_messages = message_tokens(candidate);
    let heuristic_total = static_tokens + estimated_messages;
    let Some(anchor_index) = usage_anchor_index.filter(|index| *index < candidate.len()) else {
        return (heuristic_total as f64).ceil() as usize;
    };
    let retained_prefix_tokens = message_tokens(&candidate[..anchor_index + 1]);
    let trailing_tokens = message_tokens(&candidate[anchor_index + 1..]);
    let anchored = static_tokens as f64
        + retained_prefix_tokens as f64 * provider_prefix_ratio
        + trailing_tokens as f64;
    (heuristic_total as f64).max(anchored).ceil() as usize
}

/// `compactGenerationContext` — the full degradation ladder.
pub fn compact_generation_context(
    messages: Vec<Message>,
    options: &GenerationContextOptions,
) -> GenerationContextCompaction {
    let retained = limit_computer_use_images(messages, 3);
    // The fallback notice is derived from the retained (pre-truncation) turn
    // timestamps; build it before the transformation consumes `retained`.
    let fallback_notice = context_fallback(&retained);
    let limits = context_limits(options);
    let estimated_message_tokens_before = message_tokens(&retained);
    let provider_estimate: ContextUsageEstimate = estimate_context_tokens(&retained);
    let provider_aware_tokens = provider_estimate.tokens;
    let estimated_tokens_before =
        provider_aware_tokens.max(estimated_message_tokens_before + limits.static_tokens);
    // Preserve the exact occurrence selected by the estimator. Structural
    // equality is insufficient here: two byte-identical assistant messages
    // can have different positions, while Pi's `indexOf` uses object identity.
    // Every drain below updates this index alongside the transformed vector.
    let mut usage_anchor_index = provider_estimate.last_usage_index;
    let estimated_prefix_tokens = match provider_estimate.last_usage_index {
        Some(index) => message_tokens(&retained[..index + 1]),
        None => 0,
    };
    let provider_prefix_ratio = if provider_estimate.usage_tokens > 0 && estimated_prefix_tokens > 0
    {
        let raw = (provider_estimate.usage_tokens as f64 - limits.static_tokens as f64)
            / estimated_prefix_tokens as f64;
        raw.max(1.0)
    } else {
        1.0
    };

    let message_budget_tokens = if provider_prefix_ratio > 0.0 {
        ((limits.input_budget_tokens as f64 - limits.static_tokens as f64) / provider_prefix_ratio)
            .floor()
            .max(0.0) as usize
    } else {
        0
    };
    let reserve_tokens = limits.reserve_tokens;

    if !should_compact(
        estimated_tokens_before,
        limits.context_window,
        reserve_tokens,
    ) {
        return GenerationContextCompaction {
            messages: retained,
            compacted: false,
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
            input_budget_tokens: limits.input_budget_tokens,
            truncated_tool_results: 0,
            compacted_tool_results: 0,
            removed_history_messages: 0,
            removed_current_turn_messages: 0,
            used_context_fallback: false,
        };
    }

    let mut truncated_tool_results = 0;
    let mut transformed: Vec<Message> = retained
        .into_iter()
        .map(|message| {
            if !is_tool_result(&message) {
                return message;
            }
            let (truncated_message, truncated) = truncate_tool_result(&message);
            if truncated {
                truncated_tool_results += 1;
            }
            truncated_message
        })
        .collect();
    let over_budget = |transformed: &[Message], anchor_index: Option<usize>| {
        estimated_total_tokens(
            transformed,
            anchor_index,
            provider_prefix_ratio,
            limits.static_tokens,
        ) > limits.input_budget_tokens
    };
    let mut removed_history_messages = 0;
    let mut compacted_tool_results = 0;
    let mut removed_current_turn_messages = 0;
    let mut used_context_fallback = false;

    // Match OpenCode's preference for keeping the two newest user turns.
    while over_budget(&transformed, usage_anchor_index) {
        let removed = remove_old_historical_turn(&mut transformed, 2, &mut usage_anchor_index);
        if removed == 0 {
            break;
        }
        removed_history_messages += removed;
    }

    if over_budget(&transformed, usage_anchor_index) {
        let tool_indexes = current_turn_tool_result_indexes(&transformed);
        let recent_budget = RECENT_TOOL_OUTPUT_BUDGET_TOKENS
            .min(MIN_RESERVE_TOKENS.max((message_budget_tokens as f64 * 0.45).floor() as usize));
        let protected_indexes =
            protected_recent_tool_results(&transformed, &tool_indexes, recent_budget);

        for &index in &tool_indexes {
            if !over_budget(&transformed, usage_anchor_index) {
                break;
            }
            if protected_indexes.contains(&index) {
                continue;
            }
            if replace_tool_result(&mut transformed, index) {
                compacted_tool_results += 1;
            }
        }

        let mut newest_protected: Vec<usize> = protected_indexes.iter().copied().collect();
        newest_protected.sort_unstable();
        while over_budget(&transformed, usage_anchor_index)
            && newest_protected.len() > MIN_RECENT_TOOL_RESULTS
        {
            let index = newest_protected.remove(0);
            if replace_tool_result(&mut transformed, index) {
                compacted_tool_results += 1;
            }
        }
    }

    // Prefer the active request over rehydrated transcript history.
    if over_budget(&transformed, usage_anchor_index) {
        let current_user = last_user_index(&transformed);
        if current_user > 0 {
            removed_history_messages += drain_messages(
                &mut transformed,
                0..current_user as usize,
                &mut usage_anchor_index,
            );
        }
    }

    while over_budget(&transformed, usage_anchor_index) {
        let removed = remove_oldest_current_turn_batch(&mut transformed, &mut usage_anchor_index);
        if removed == 0 {
            break;
        }
        removed_current_turn_messages += removed;
    }

    // Keep the latest tool-call protocol intact; make even its result
    // re-fetchable.
    if over_budget(&transformed, usage_anchor_index) {
        let tool_indexes = current_turn_tool_result_indexes(&transformed);
        for index in tool_indexes {
            if !over_budget(&transformed, usage_anchor_index) {
                break;
            }
            let message = &transformed[index];
            let already_compacted = match message {
                Message::ToolResult(result) => match result.content.first() {
                    Some(ContentBlock::Text(text)) => {
                        text.text.contains("payload omitted to stay within")
                    }
                    _ => false,
                },
                _ => false,
            };
            if !already_compacted
                && is_tool_result(message)
                && replace_tool_result(&mut transformed, index)
            {
                compacted_tool_results += 1;
            }
        }
    }

    // Never knowingly pass an over-window request to the provider.
    if over_budget(&transformed, usage_anchor_index) {
        removed_current_turn_messages += transformed.len();
        transformed.splice(0.., std::iter::once(fallback_notice));
        usage_anchor_index = None;
        used_context_fallback = true;
    }

    let estimated_tokens_after = estimated_total_tokens(
        &transformed,
        usage_anchor_index,
        provider_prefix_ratio,
        limits.static_tokens,
    );
    GenerationContextCompaction {
        messages: transformed,
        compacted: true,
        estimated_tokens_before,
        estimated_tokens_after,
        input_budget_tokens: limits.input_budget_tokens,
        truncated_tool_results,
        compacted_tool_results,
        removed_history_messages,
        removed_current_turn_messages,
        used_context_fallback,
    }
}

/// `createGenerationContextTransform` — the never-rejecting transform Pi
/// requires (returns the input untouched on any failure).
pub fn create_generation_context_transform(
    options: &GenerationContextOptions,
) -> impl Fn(Vec<Message>) -> (Vec<Message>, Option<GenerationContextCompaction>) {
    let options = options.clone();
    move |messages: Vec<Message>| {
        let result = compact_generation_context(messages, &options);
        (result.messages.clone(), result.compacted.then_some(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{
        AssistantMessage, ImageContent, StopReason, ToolCall, ToolResultMessage, Usage,
    };

    fn options(window: u32) -> GenerationContextOptions {
        GenerationContextOptions {
            context_window: window,
            system_prompt: "You are Aiden.".to_string(),
            tools: Vec::new(),
        }
    }

    fn user(text: &str, timestamp: u64) -> Message {
        Message::User(UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp,
        })
    }

    fn assistant(text: &str, timestamp: u64) -> Message {
        Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
            })],
            api: "openai-completions".into(),
            provider: "custom:x".into(),
            model: "m".into(),
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
            timestamp,
        })
    }

    fn assistant_tool_call(id: &str, tool_name: &str, timestamp: u64) -> Message {
        let Message::Assistant(mut assistant) = assistant("", timestamp) else {
            unreachable!()
        };
        assistant.content = vec![ContentBlock::ToolCall(ToolCall {
            id: id.to_string(),
            name: tool_name.to_string(),
            arguments: serde_json::json!({ "path": format!("src/{id}.rs") }),
            thought_signature: None,
        })];
        assistant.stop_reason = StopReason::ToolUse;
        Message::Assistant(assistant)
    }

    fn tool_result(tool_name: &str, text: &str, timestamp: u64, with_image: bool) -> Message {
        let mut content = vec![ContentBlock::Text(TextContent {
            text: text.to_string(),
            text_signature: None,
        })];
        if with_image {
            content.push(ContentBlock::Image(ImageContent {
                data: "AAAA".into(),
                mime_type: "image/png".into(),
            }));
        }
        Message::ToolResult(ToolResultMessage {
            tool_call_id: format!("call-{timestamp}"),
            tool_name: tool_name.to_string(),
            content,
            details: None,
            added_tool_names: None,
            is_error: false,
            timestamp,
        })
    }

    #[test]
    fn small_context_does_not_compact() {
        let messages = vec![user("hi", 1), assistant("hello", 2)];
        let result = compact_generation_context(messages.clone(), &options(128_000));
        assert!(!result.compacted);
        assert_eq!(result.messages, messages);
        assert_eq!(result.truncated_tool_results, 0);
    }

    #[test]
    fn tiny_context_triggers_fallback_notice() {
        let messages = vec![
            user(&"a".repeat(1000), 1),
            assistant(&"b".repeat(1000), 2),
            user(&"c".repeat(1000), 3),
        ];
        let result = compact_generation_context(messages, &options(1024));
        assert!(result.compacted);
        assert!(result.used_context_fallback);
        assert_eq!(result.messages.len(), 1);
        let Message::User(user_msg) = &result.messages[0] else {
            panic!("expected user");
        };
        let UserContent::Text(text) = &user_msg.content else {
            panic!();
        };
        assert_eq!(text, CONTEXT_FALLBACK_TEXT);
    }

    #[test]
    fn computer_use_images_are_capped_to_newest_three() {
        let messages = vec![
            user("go", 1),
            tool_result("computer_use", "shot 1", 2, true),
            tool_result("computer_use", "shot 2", 3, true),
            tool_result("computer_use", "shot 3", 4, true),
            tool_result("computer_use", "shot 4", 5, true),
        ];
        let retained = limit_computer_use_images(messages, 3);
        let images: Vec<usize> = retained
            .iter()
            .filter_map(|message| match message {
                Message::ToolResult(result) => result
                    .content
                    .iter()
                    .any(|part| matches!(part, ContentBlock::Image(_)))
                    .then_some(result.timestamp as usize),
                _ => None,
            })
            .collect();
        assert_eq!(images, vec![3, 4, 5]);
        // Text results outside computer_use are untouched.
        let messages = vec![tool_result("grep", "match", 1, true)];
        assert_eq!(limit_computer_use_images(messages, 3).len(), 1);
    }

    #[test]
    fn oversized_tool_results_are_truncated_with_marker() {
        let big = "x".repeat(40_000);
        let result = truncate_tool_result(&tool_result("grep", &big, 1, false));
        assert!(result.1);
        let Message::ToolResult(truncated) = result.0 else {
            panic!();
        };
        let ContentBlock::Text(text) = &truncated.content[0] else {
            panic!();
        };
        assert!(text.text.len() <= 32_000);
        assert!(text.text.contains("characters compacted"));
        assert!(text.text.starts_with('x'));
        assert!(text.text.ends_with('x'));
    }

    #[test]
    fn truncate_text_matches_ts_marker_format() {
        let text = "a".repeat(100);
        let truncated = truncate_text(&text, 50);
        assert!(truncated.contains("[... 50 characters compacted ...]"));
        assert_eq!(truncated.len(), 50);
    }

    #[test]
    fn truncate_text_never_panics_on_multibyte_boundaries() {
        // A >32KB tool result made of 2-byte chars: the byte-offset head/tail
        // math must land on char boundaries, not panic the compaction path.
        // (Snapping to char boundaries may overshoot the budget by one char.)
        let text = "é".repeat(40_000);
        let truncated = truncate_text(&text, 32_000);
        assert!(truncated.len() <= 32_000 + 4);
        assert!(truncated.contains("characters compacted"));
        assert!(truncated.starts_with('é'));
        assert!(truncated.ends_with('é'));

        // The 4-byte emoji variant.
        let emoji = "\u{1F600}".repeat(20_000);
        let truncated = truncate_text(&emoji, 16_000);
        assert!(truncated.len() <= 16_000 + 8);
        assert!(truncated.contains("characters compacted"));

        // A tiny budget where the marker itself exceeds the budget must not
        // underflow into an invalid slice.
        let truncated = truncate_text("hello world", 5);
        assert!(truncated.len() >= 5);
    }

    #[test]
    fn old_history_is_dropped_keeping_newest_two_user_turns() {
        let messages = vec![
            user(&"turn 1 big history ".repeat(400), 1), // ~1400 tokens
            assistant("a1", 2),
            user("turn 2", 3),
            assistant("a2", 4),
            user("turn 3", 5),
            assistant("a3", 6),
        ];
        // Window 3000 → budget 952; the oversized history forces compaction.
        let result = compact_generation_context(messages, &options(3_000));
        assert!(result.compacted);
        assert!(result.removed_history_messages > 0);
        // The two newest user turns survive.
        let user_texts: Vec<String> = result
            .messages
            .iter()
            .filter_map(|message| match message {
                Message::User(user) => match &user.content {
                    UserContent::Text(text) => Some(text.clone()),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert!(user_texts.contains(&"turn 3".to_string()));
        assert!(!user_texts.iter().any(|text| text.starts_with("turn 1")));
    }

    #[test]
    fn history_is_dropped_before_current_turn_is_attacked() {
        let messages = vec![
            user(&"old turn history ".repeat(400), 1), // ~1700 tokens
            assistant("old answer", 2),
            user("mid", 3),
            assistant("mid answer", 4),
            user("current", 5),
            assistant(&"x".repeat(200), 6),
        ];
        let result = compact_generation_context(messages, &options(3_000));
        assert!(result.compacted);
        // The oldest history turn is dropped; the current turn survives whole.
        let texts: Vec<&str> = result
            .messages
            .iter()
            .filter_map(|message| match message {
                Message::User(user) => match &user.content {
                    UserContent::Text(text) => Some(text.as_str()),
                    _ => None,
                },
                Message::Assistant(assistant) => match &assistant.content[0] {
                    ContentBlock::Text(text) => Some(text.text.as_str()),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert!(!texts.iter().any(|text| text.starts_with("old turn")));
        assert!(texts.contains(&"current"));
        assert!(result.removed_history_messages > 0);
        assert!(!result.used_context_fallback);
    }

    #[test]
    fn tool_results_are_compacted_after_history_drop() {
        let messages = vec![
            user("current", 1),
            tool_result("grep", &"x".repeat(30_000), 2, false),
            tool_result("grep", &"y".repeat(30_000), 3, false),
            assistant("done", 4),
        ];
        let result = compact_generation_context(messages, &options(4_000));
        assert!(result.compacted);
        assert!(result.compacted_tool_results > 0);
        for message in &result.messages {
            if let Message::ToolResult(tool_result) = message {
                let ContentBlock::Text(text) = &tool_result.content[0] else {
                    continue;
                };
                if text.text.contains("omitted to stay within") {
                    assert!(text.text.contains("do not repeat it solely"));
                }
            }
        }
    }

    #[test]
    fn usage_anchor_estimation_drives_budget() {
        // A usage-bearing assistant message anchors the estimate.
        let mut anchored = assistant("response", 2);
        let Message::Assistant(assistant) = &mut anchored else {
            unreachable!()
        };
        assistant.usage.total_tokens = 130_000;
        let messages = vec![user("hi", 1), anchored, user("continue", 3)];
        let result = compact_generation_context(messages, &options(128_000));
        // 130k usage anchor > 105,216 budget → must compact.
        assert!(result.compacted);
        assert!(result.estimated_tokens_before >= 130_000);
    }

    #[test]
    fn duplicate_assistant_values_keep_the_exact_usage_anchor_occurrence() {
        let mut duplicate = assistant(&"x".repeat(400), 2);
        let Message::Assistant(assistant) = &mut duplicate else {
            unreachable!()
        };
        assistant.usage.total_tokens = 2_000;
        let messages = vec![duplicate.clone(), duplicate, user("tail", 3)];
        let ratio = 2.0;

        let anchored = estimated_total_tokens(&messages, Some(1), ratio, 0);
        let expected_prefix = message_tokens(&messages[..2]);
        let expected_tail = message_tokens(&messages[2..]);

        assert_eq!(anchored, expected_prefix * 2 + expected_tail);
        assert!(anchored > estimated_total_tokens(&messages, Some(0), ratio, 0));
    }

    #[test]
    fn paired_tool_history_is_compacted_without_mutating_or_orphaning_protocol() {
        let mut messages = vec![user("Inspect the provider runtime.", 1)];
        for index in 0..24u64 {
            let id = format!("read-{index}");
            messages.push(assistant_tool_call(&id, "read_file", index * 2 + 2));
            messages.push(Message::ToolResult(ToolResultMessage {
                tool_call_id: id.clone(),
                tool_name: "read_file".to_string(),
                content: vec![ContentBlock::Text(TextContent {
                    text: format!("{id}\n{}", "x".repeat(20_000)),
                    text_signature: None,
                })],
                details: None,
                added_tool_names: None,
                is_error: false,
                timestamp: index * 2 + 3,
            }));
        }
        let original = messages.clone();
        let result = compact_generation_context(messages, &options(64_000));

        assert!(result.compacted);
        assert!(result.estimated_tokens_after <= result.input_budget_tokens);
        assert_eq!(original.len(), 49);
        let call_ids: HashSet<String> = result
            .messages
            .iter()
            .flat_map(|message| match message {
                Message::Assistant(assistant) => assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolCall(call) => Some(call.id.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
                _ => Vec::new(),
            })
            .collect();
        let result_ids: HashSet<String> = result
            .messages
            .iter()
            .filter_map(|message| match message {
                Message::ToolResult(result) => Some(result.tool_call_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(call_ids, result_ids);
        assert!(result_ids.contains("read-23"));

        let Message::ToolResult(original_first_result) = &original[2] else {
            panic!("expected original tool result")
        };
        let ContentBlock::Text(original_text) = &original_first_result.content[0] else {
            panic!("expected original text result")
        };
        assert_eq!(original_text.text.len(), 20_007);
    }

    #[test]
    fn capacity_assertion_fails_for_tiny_windows() {
        let options = options(256);
        let err = assert_generation_context_capacity(&options).unwrap_err();
        assert!(err.contains("context window is too small"));
    }

    #[test]
    fn capacity_assertion_passes_for_realistic_windows() {
        assert!(assert_generation_context_capacity(&options(128_000)).is_ok());
    }

    #[test]
    fn transform_never_rejects() {
        let transform = create_generation_context_transform(&options(128_000));
        let (messages, result) = transform(vec![user("hi", 1), assistant("yo", 2)]);
        assert_eq!(messages.len(), 2);
        assert!(result.is_none());
    }
}
