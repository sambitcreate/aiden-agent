//! Port of pi-ai `api/transform-messages.js`: cross-provider message
//! normalization shared by every transport.
//!
//! - Unsupported-image downgrade to placeholders for non-vision models.
//! - Thinking-block rules: redacted blocks and signature-bearing blocks only
//!   survive for the same provider+api+model; otherwise thinking becomes plain
//!   text and empty blocks are dropped.
//! - Tool-call id normalization with a recorded mapping applied to the
//!   matching tool results.
//! - Orphaned tool calls get synthetic `"No result provided"` error results so
//!   providers that reject unbalanced tool protocols stay happy.
//! - Errored/aborted assistant messages are skipped entirely (never replayed).

use aiden_core::{
    AssistantMessage, ContentBlock, Message, StopReason, TextContent, ToolCall, ToolResultMessage,
    UserContent,
};

const NON_VISION_USER_IMAGE_PLACEHOLDER: &str = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER: &str =
    "(tool image omitted: model does not support images)";

/// `replaceImagesWithPlaceholder` — consecutive images collapse to one
/// placeholder.
fn replace_images_with_placeholder(
    content: &[ContentBlock],
    placeholder: &str,
) -> Vec<ContentBlock> {
    let mut result = Vec::with_capacity(content.len());
    let mut previous_was_placeholder = false;
    for block in content {
        match block {
            ContentBlock::Image(_) => {
                if !previous_was_placeholder {
                    result.push(ContentBlock::Text(TextContent {
                        text: placeholder.to_string(),
                        text_signature: None,
                    }));
                }
                previous_was_placeholder = true;
            }
            other => {
                result.push(other.clone());
                let is_placeholder_text = match other {
                    ContentBlock::Text(TextContent { text, .. }) => text == placeholder,
                    _ => false,
                };
                previous_was_placeholder = is_placeholder_text;
            }
        }
    }
    result
}

fn downgrade_unsupported_images(messages: Vec<Message>, vision: bool) -> Vec<Message> {
    if vision {
        return messages;
    }
    messages
        .into_iter()
        .map(|message| match message {
            Message::User(mut user) => {
                if let UserContent::Blocks(blocks) = user.content {
                    let blocks: Vec<ContentBlock> =
                        blocks.into_iter().map(content_from_user_block).collect();
                    user.content = UserContent::Blocks(
                        replace_images_with_placeholder(&blocks, NON_VISION_USER_IMAGE_PLACEHOLDER)
                            .into_iter()
                            .filter_map(user_block_from_content)
                            .collect(),
                    );
                }
                Message::User(user)
            }
            Message::ToolResult(mut result) => {
                result.content = replace_images_with_placeholder(
                    &result.content,
                    NON_VISION_TOOL_IMAGE_PLACEHOLDER,
                );
                Message::ToolResult(result)
            }
            other => other,
        })
        .collect()
}

/// `transformMessages` — the deterministic normalization pipeline.
///
/// `normalize_tool_call_id` receives `(id, source_provider, source_api)` and
/// returns the replacement id. `now` stamps synthetic tool results.
pub fn transform_messages(
    messages: Vec<Message>,
    provider: &str,
    api: &str,
    model_id: &str,
    vision: bool,
    normalize_tool_call_id: &dyn Fn(&str, &str, &str) -> String,
    now: u64,
) -> Vec<Message> {
    let image_aware = downgrade_unsupported_images(messages, vision);
    let mut tool_call_id_map: std::collections::HashMap<String, String> = Default::default();

    // First pass: transform assistant/tool-result messages.
    let transformed: Vec<Message> = image_aware
        .into_iter()
        .map(|message| match message {
            Message::User(_) => message,
            Message::ToolResult(result) => {
                if let Some(normalized) = tool_call_id_map.get(&result.tool_call_id) {
                    if *normalized != result.tool_call_id {
                        return Message::ToolResult(ToolResultMessage {
                            tool_call_id: normalized.clone(),
                            ..result
                        });
                    }
                }
                Message::ToolResult(result)
            }
            Message::Assistant(assistant) => {
                let is_same_model = assistant.provider == provider
                    && assistant.api == api
                    && assistant.model == model_id;
                let transformed_content = assistant
                    .content
                    .into_iter()
                    .flat_map(|block| match block {
                        ContentBlock::Thinking(thinking) => {
                            if thinking.redacted == Some(true) {
                                // Redacted thinking is opaque encrypted content,
                                // only valid for the same model.
                                return if is_same_model {
                                    vec![ContentBlock::Thinking(thinking)]
                                } else {
                                    Vec::new()
                                };
                            }
                            if is_same_model && thinking.thinking_signature.is_some() {
                                // Same model: keep signature-bearing blocks even
                                // when the thinking text is empty (OpenAI
                                // encrypted reasoning).
                                return vec![ContentBlock::Thinking(thinking)];
                            }
                            if thinking.thinking.trim().is_empty() {
                                return Vec::new();
                            }
                            if is_same_model {
                                vec![ContentBlock::Thinking(thinking)]
                            } else {
                                // Convert to plain text; no tags to avoid the
                                // model mimicking them.
                                vec![ContentBlock::Text(TextContent {
                                    text: thinking.thinking,
                                    text_signature: None,
                                })]
                            }
                        }
                        ContentBlock::Text(text) => {
                            if is_same_model {
                                vec![ContentBlock::Text(text)]
                            } else {
                                vec![ContentBlock::Text(TextContent {
                                    text: text.text,
                                    text_signature: None,
                                })]
                            }
                        }
                        ContentBlock::ToolCall(tool_call) => {
                            let mut normalized = tool_call.clone();
                            if !is_same_model && normalized.thought_signature.is_some() {
                                normalized.thought_signature = None;
                            }
                            if !is_same_model {
                                let normalized_id = normalize_tool_call_id(
                                    &tool_call.id,
                                    &assistant.provider,
                                    &assistant.api,
                                );
                                if normalized_id != tool_call.id {
                                    tool_call_id_map
                                        .insert(tool_call.id.clone(), normalized_id.clone());
                                    normalized.id = normalized_id;
                                }
                            }
                            vec![ContentBlock::ToolCall(normalized)]
                        }
                        other => vec![other],
                    })
                    .collect();
                Message::Assistant(AssistantMessage {
                    content: transformed_content,
                    ..assistant
                })
            }
        })
        .collect();

    // Second pass: insert synthetic empty tool results for orphaned tool calls.
    let mut result: Vec<Message> = Vec::with_capacity(transformed.len());
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut existing_tool_result_ids: std::collections::HashSet<String> = Default::default();

    for message in transformed {
        match &message {
            Message::Assistant(assistant) => {
                insert_synthetic_tool_results(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut existing_tool_result_ids,
                    now,
                );
                // Skip errored/aborted assistant messages entirely — they are
                // incomplete turns that must not be replayed.
                if assistant.stop_reason == StopReason::Error
                    || assistant.stop_reason == StopReason::Aborted
                {
                    continue;
                }
                let tool_calls: Vec<ToolCall> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolCall(tool_call) => Some(tool_call.clone()),
                        _ => None,
                    })
                    .collect();
                if !tool_calls.is_empty() {
                    pending_tool_calls = tool_calls;
                    existing_tool_result_ids.clear();
                }
                result.push(message);
            }
            Message::ToolResult(tool_result) => {
                existing_tool_result_ids.insert(tool_result.tool_call_id.clone());
                result.push(message);
            }
            Message::User(_) => {
                // A user message interrupts the tool flow — synthesize results
                // for any orphaned calls first.
                insert_synthetic_tool_results(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut existing_tool_result_ids,
                    now,
                );
                result.push(message);
            }
        }
    }
    insert_synthetic_tool_results(
        &mut result,
        &mut pending_tool_calls,
        &mut existing_tool_result_ids,
        now,
    );
    result
}

fn insert_synthetic_tool_results(
    result: &mut Vec<Message>,
    pending_tool_calls: &mut Vec<ToolCall>,
    existing_tool_result_ids: &mut std::collections::HashSet<String>,
    now: u64,
) {
    if pending_tool_calls.is_empty() {
        return;
    }
    for tool_call in pending_tool_calls.drain(..) {
        if !existing_tool_result_ids.contains(&tool_call.id) {
            result.push(Message::ToolResult(ToolResultMessage {
                tool_call_id: tool_call.id,
                tool_name: tool_call.name,
                content: vec![ContentBlock::Text(TextContent {
                    text: "No result provided".to_string(),
                    text_signature: None,
                })],
                details: None,
                added_tool_names: None,
                is_error: true,
                timestamp: now,
            }));
        }
    }
    existing_tool_result_ids.clear();
}

fn content_from_user_block(block: aiden_core::UserBlock) -> ContentBlock {
    match block {
        aiden_core::UserBlock::Text(text) => ContentBlock::Text(text),
        aiden_core::UserBlock::Image(image) => ContentBlock::Image(image),
    }
}

fn user_block_from_content(block: ContentBlock) -> Option<aiden_core::UserBlock> {
    match block {
        ContentBlock::Text(text) => Some(aiden_core::UserBlock::Text(text)),
        ContentBlock::Image(image) => Some(aiden_core::UserBlock::Image(image)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{ImageContent, ThinkingContent, UserBlock, UserMessage};

    fn user(text: &str) -> Message {
        Message::User(UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 1,
        })
    }

    fn assistant_with(content: Vec<ContentBlock>) -> Message {
        Message::Assistant(AssistantMessage {
            content,
            api: "openai-completions".into(),
            provider: "custom:test".into(),
            model: "model-a".into(),
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
        })
    }

    #[test]
    fn non_vision_model_downgrades_images_to_placeholder() {
        let messages = vec![Message::User(UserMessage {
            content: UserContent::Blocks(vec![
                UserBlock::Image(ImageContent {
                    data: "AAAA".into(),
                    mime_type: "image/png".into(),
                }),
                UserBlock::Image(ImageContent {
                    data: "BBBB".into(),
                    mime_type: "image/png".into(),
                }),
                UserBlock::Text(TextContent {
                    text: "hi".into(),
                    text_signature: None,
                }),
            ]),
            timestamp: 1,
        })];
        let transformed = transform_messages(
            messages,
            "custom:test",
            "openai-completions",
            "model-a",
            false,
            &|id, _, _| id.to_string(),
            5,
        );
        let Message::User(user_msg) = &transformed[0] else {
            panic!("expected user");
        };
        let UserContent::Blocks(blocks) = &user_msg.content else {
            panic!("expected blocks");
        };
        assert_eq!(blocks.len(), 2, "two images collapse to one placeholder");
        assert!(
            matches!(&blocks[0], UserBlock::Text(t) if t.text == NON_VISION_USER_IMAGE_PLACEHOLDER)
        );
    }

    #[test]
    fn thinking_becomes_text_across_models_and_is_dropped_when_empty() {
        let messages = vec![assistant_with(vec![
            ContentBlock::Thinking(ThinkingContent {
                thinking: "think about it".into(),
                thinking_signature: None,
                redacted: None,
            }),
            ContentBlock::Thinking(ThinkingContent {
                thinking: "".into(),
                thinking_signature: None,
                redacted: None,
            }),
        ])];
        let transformed = transform_messages(
            messages,
            "custom:test", // same provider, different model id
            "openai-completions",
            "other-model",
            false,
            &|id, _, _| id.to_string(),
            5,
        );
        let Message::Assistant(assistant) = &transformed[0] else {
            panic!("expected assistant");
        };
        assert_eq!(assistant.content.len(), 1);
        assert!(
            matches!(&assistant.content[0], ContentBlock::Text(t) if t.text == "think about it")
        );
    }

    #[test]
    fn redacted_thinking_is_dropped_for_other_models() {
        let messages = vec![assistant_with(vec![ContentBlock::Thinking(
            ThinkingContent {
                thinking: "".into(),
                thinking_signature: Some("encrypted".into()),
                redacted: Some(true),
            },
        )])];
        let transformed = transform_messages(
            messages,
            "custom:test",
            "openai-completions",
            "other-model",
            false,
            &|id, _, _| id.to_string(),
            5,
        );
        let Message::Assistant(assistant) = &transformed[0] else {
            panic!("expected assistant");
        };
        assert!(assistant.content.is_empty());
    }

    #[test]
    fn errored_assistant_messages_are_skipped() {
        let mut message = assistant_with(vec![ContentBlock::Text(TextContent {
            text: "partial".into(),
            text_signature: None,
        })]);
        let Message::Assistant(assistant) = &mut message else {
            unreachable!()
        };
        assistant.stop_reason = StopReason::Error;
        let transformed = transform_messages(
            vec![message, user("continue")],
            "custom:test",
            "openai-completions",
            "model-a",
            false,
            &|id, _, _| id.to_string(),
            5,
        );
        assert_eq!(transformed.len(), 1);
        assert!(matches!(transformed[0], Message::User(_)));
    }

    #[test]
    fn orphaned_tool_calls_get_synthetic_error_results() {
        let messages = vec![
            assistant_with(vec![ContentBlock::ToolCall(ToolCall {
                id: "call_1".into(),
                name: "grep".into(),
                arguments: serde_json::json!({"pattern": "foo"}),
                thought_signature: None,
            })]),
            user("next turn"),
        ];
        let transformed = transform_messages(
            messages,
            "custom:test",
            "openai-completions",
            "model-a",
            false,
            &|id, _, _| id.to_string(),
            5,
        );
        assert_eq!(transformed.len(), 3);
        assert!(
            matches!(transformed[1], Message::ToolResult(ref r) if r.is_error && r.tool_call_id == "call_1" && matches!(&r.content[0], ContentBlock::Text(t) if t.text == "No result provided"))
        );
    }

    #[test]
    fn tool_call_ids_are_normalized_and_applied_to_results() {
        let messages = vec![
            assistant_with(vec![ContentBlock::ToolCall(ToolCall {
                id: "fc|long-item-12345678901234567890123456789012345678901234567890extra".into(),
                name: "grep".into(),
                arguments: serde_json::json!({}),
                thought_signature: None,
            })]),
            Message::ToolResult(ToolResultMessage {
                tool_call_id:
                    "fc|long-item-12345678901234567890123456789012345678901234567890extra".into(),
                tool_name: "grep".into(),
                content: vec![ContentBlock::Text(TextContent {
                    text: "result".into(),
                    text_signature: None,
                })],
                details: None,
                added_tool_names: None,
                is_error: false,
                timestamp: 3,
            }),
        ];
        let transformed = transform_messages(
            messages,
            "other-provider",
            "openai-completions",
            "model-a",
            false,
            &|id, _, _| {
                if let Some((call_id, _)) = id.split_once('|') {
                    call_id.to_string()
                } else {
                    id.to_string()
                }
            },
            5,
        );
        let Message::Assistant(assistant) = &transformed[0] else {
            panic!()
        };
        let ContentBlock::ToolCall(tool_call) = &assistant.content[0] else {
            panic!()
        };
        assert_eq!(tool_call.id, "fc");
        let Message::ToolResult(result) = &transformed[1] else {
            panic!()
        };
        assert_eq!(result.tool_call_id, "fc");
    }
}
