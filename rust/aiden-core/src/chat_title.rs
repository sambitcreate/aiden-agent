//! Port of `main/services/chat-title-policy.ts` (pure title seeding, prompting,
//! and output normalization) plus `main/services/chat-title-routing.ts`.

use serde::{Deserialize, Serialize};

use crate::Attachment;
use crate::ChatMessage;
use crate::ChatRole;

/// The placeholder title every new chat starts with.
pub const DEFAULT_CHAT_TITLE: &str = "New agent";
/// Prior default kept replaceable so existing untitled chats still auto-rename.
const LEGACY_DEFAULT_CHAT_TITLES: &[&str] = &["new chat"];
pub const MAX_CHAT_TITLE_LENGTH: usize = 50;
const CHAT_RENAME_ORIGINAL_BUDGET: usize = 3_500;
const CHAT_RENAME_RECENT_BUDGET: usize = 8_500;
const CHAT_RENAME_RECENT_MESSAGES: usize = 8;

/// The header sizes cap the generated-title prompt so background title
/// generation can never send an unbounded native request.
pub const CHAT_TITLE_PROMPT_MAX_CONTENT_CHARS: usize = 8_000;

pub fn is_default_chat_title(title: &str) -> bool {
    let normalized = title.trim().to_ascii_lowercase();
    normalized == DEFAULT_CHAT_TITLE.to_ascii_lowercase()
        || LEGACY_DEFAULT_CHAT_TITLES.contains(&normalized.as_str())
}

fn compact(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut pending_space = false;
    for ch in value.trim().chars() {
        if ch.is_whitespace() {
            pending_space = true;
        } else {
            if pending_space && !result.is_empty() {
                result.push(' ');
            }
            pending_space = false;
            result.push(ch);
        }
    }
    result
}

fn truncate(value: &str) -> String {
    if value.chars().count() <= MAX_CHAT_TITLE_LENGTH {
        return value.to_string();
    }
    let head: String = value.chars().take(MAX_CHAT_TITLE_LENGTH - 3).collect();
    format!("{}...", head.trim_end())
}

/// Byte-bounded truncation that appends a single ellipsis character.
fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if maximum_bytes == 0 {
        return String::new();
    }
    if value.len() <= maximum_bytes {
        return value.to_string();
    }
    let suffix = "…";
    let suffix_bytes = suffix.len();
    if maximum_bytes < suffix_bytes {
        return String::new();
    }
    let content_budget = maximum_bytes - suffix_bytes;
    let mut bytes = 0;
    let mut result = String::new();
    for ch in value.chars() {
        let ch_bytes = ch.len_utf8();
        if bytes + ch_bytes > content_budget {
            break;
        }
        result.push(ch);
        bytes += ch_bytes;
    }
    format!("{}{}", result.trim_end(), suffix)
}

fn title_message_excerpt(message: &ChatMessage) -> String {
    let label = if message.role == ChatRole::Assistant {
        "Assistant"
    } else {
        "User"
    };
    let content = compact(&message.content);
    let attachments = message
        .attachments
        .as_ref()
        .map(|attachments| {
            attachments
                .iter()
                .map(|attachment| {
                    let kind = match attachment.kind {
                        crate::AttachmentKind::Image => "Image",
                        crate::AttachmentKind::Text => "File",
                    };
                    format!("{kind}: {}", compact(&attachment.name))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut body: Vec<String> = Vec::with_capacity(1 + attachments.len());
    if !content.is_empty() {
        body.push(content);
    }
    body.extend(attachments);
    let body = body.join(" | ");
    if body.is_empty() {
        String::new()
    } else {
        format!("{label}: {body}")
    }
}

/// Derive the immediate sidebar-safe title from the first prompt.
pub fn derive_chat_title_seed(input: &ChatTitleInput) -> String {
    let message = compact(&input.content);
    if !message.is_empty() {
        return truncate(&message);
    }
    let Some(first_attachment) = input.attachments.as_ref().and_then(|a| a.first()) else {
        return DEFAULT_CHAT_TITLE.to_string();
    };
    let prefix = match first_attachment.kind {
        crate::AttachmentKind::Image => "Image",
        crate::AttachmentKind::Text => "File",
    };
    let name = compact(&first_attachment.name);
    let name = if name.is_empty() {
        "Attachment".to_string()
    } else {
        name
    };
    truncate(&format!("{prefix}: {name}"))
}

pub fn can_replace_generated_chat_title(current_title: &str, title_seed: &str) -> bool {
    let current = current_title.trim();
    is_default_chat_title(current) || current == title_seed.trim()
}

fn title_from_json(value: &str) -> Option<String> {
    if !value.trim_start().starts_with('{') {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(value).ok()?;
    match parsed.get("title") {
        Some(serde_json::Value::String(title)) => Some(title.clone()),
        _ => None,
    }
}

fn strip_bullet_markers(line: &str) -> &str {
    let mut rest = line;
    loop {
        let Some(ch) = rest.chars().next() else {
            return rest;
        };
        if matches!(ch, '-' | '*' | '#') {
            rest = &rest[ch.len_utf8()..];
        } else {
            break;
        }
    }
    rest.trim_start()
}

fn strip_title_prefix(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let Some(title_index) = lower.find("title") else {
        return line.to_string();
    };
    // The text before "title" must be empty, whitespace, or the words
    // "chat"/"thread" (optionally surrounded by whitespace).
    let before = &lower[..title_index];
    let before_trimmed = before.trim();
    if !before_trimmed.is_empty() && before_trimmed != "chat" && before_trimmed != "thread" {
        return line.to_string();
    }
    // After "title": optional whitespace, a colon, optional whitespace.
    let after = &line[title_index + "title".len()..];
    let after = after.trim_start();
    let Some(rest) = after.strip_prefix(':') else {
        return line.to_string();
    };
    rest.trim_start().to_string()
}

fn strip_surrounding_quotes(value: &str) -> String {
    value
        .trim_matches(|ch: char| ch.is_whitespace() || ch == '\'' || ch == '"' || ch == '`')
        .to_string()
}

fn strip_trailing_punctuation(value: &str) -> &str {
    value.trim_end_matches(['.', '!', '?', ';', ':'])
}

/// Normalize plain, prefixed, JSON, and fenced title responses.
pub fn sanitize_generated_chat_title(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let unfenced = trim_fence(trimmed);
    let candidate = title_from_json(&unfenced).unwrap_or_else(|| unfenced.clone());
    let first_line = candidate
        .trim()
        .lines()
        .next()
        .map(|line| line.trim())
        .unwrap_or_default();
    if first_line.is_empty() {
        return None;
    }
    let bullet_free = strip_bullet_markers(first_line);
    let title_free = strip_title_prefix(bullet_free);
    let quote_free = strip_surrounding_quotes(&title_free);
    let normalized = compact(strip_trailing_punctuation(&quote_free));
    if normalized.is_empty() {
        None
    } else {
        Some(truncate(&normalized))
    }
}

/// Remove a single leading ```` ```json|text ```` fence and a trailing one.
fn trim_fence(value: &str) -> String {
    let mut unfenced = value.to_string();
    let lower = unfenced.to_ascii_lowercase();
    let prefix_len = if lower.starts_with("```json") {
        "```json".len()
    } else if lower.starts_with("```text") {
        "```text".len()
    } else if lower.starts_with("```") {
        "```".len()
    } else {
        0
    };
    if prefix_len > 0 {
        unfenced = unfenced[prefix_len..].trim_start().to_string();
    }
    let trimmed = unfenced.trim_end();
    if let Some(rest) = trimmed.strip_suffix("```") {
        unfenced = rest.trim_end().to_string();
    }
    unfenced
}

/// Inputs to title seeding and prompting.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatTitleInput {
    pub content: String,
    pub attachments: Option<Vec<Attachment>>,
}

/// Build the concise coding-title prompt with attachment metadata.
pub fn build_chat_title_prompt(input: &ChatTitleInput) -> String {
    let attachment_lines = input
        .attachments
        .as_ref()
        .map(|attachments| {
            attachments
                .iter()
                .map(|attachment| {
                    format!(
                        "- {} ({}, {} bytes)",
                        attachment.name, attachment.mime_type, attachment.size
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut lines = vec![
        "Write a concise title for this coding conversation.".to_string(),
        "Return only the title, with no JSON, Markdown, quotes, or prefix.".to_string(),
        "Rules:".to_string(),
        "- Summarize the user's request instead of repeating it verbatim.".to_string(),
        "- Keep it short and specific, ideally 3-8 words.".to_string(),
        "- Do not end with punctuation.".to_string(),
        "- If an image is attached, use it as primary context for visual or UI issues.".to_string(),
        String::new(),
        "User message:".to_string(),
        input
            .content
            .chars()
            .take(CHAT_TITLE_PROMPT_MAX_CONTENT_CHARS)
            .collect(),
    ];
    if !attachment_lines.is_empty() {
        lines.push(String::new());
        lines.push("Attachment metadata:".to_string());
        lines.extend(attachment_lines);
    }
    lines.join("\n")
}

/// Build a bounded prompt for an explicit rename: the first user request
/// anchors the subject while a small recent transcript captures where the work
/// evolved. System messages and attachment contents stay out of the request.
pub fn build_chat_rename_prompt(messages: &[ChatMessage]) -> String {
    let conversational: Vec<&ChatMessage> = messages
        .iter()
        .filter(|message| message.role == ChatRole::User || message.role == ChatRole::Assistant)
        .collect();
    let first_user_index = conversational
        .iter()
        .position(|message| message.role == ChatRole::User)
        .unwrap_or(0);
    let original_message = conversational.get(first_user_index);
    let original = original_message
        .map(|message| truncate_utf8(&title_message_excerpt(message), CHAT_RENAME_ORIGINAL_BUDGET))
        .unwrap_or_default();

    let recent_candidates: Vec<&&ChatMessage> = conversational
        .iter()
        .filter(|message| Some(**message) != original_message.copied())
        .collect::<Vec<_>>();
    let recent_candidates = recent_candidates
        .as_slice()
        .get(
            recent_candidates
                .len()
                .saturating_sub(CHAT_RENAME_RECENT_MESSAGES)..,
        )
        .unwrap_or(&[]);

    let mut recent: Vec<String> = Vec::new();
    let mut recent_bytes = 0usize;
    for candidate in recent_candidates.iter().rev() {
        let excerpt = title_message_excerpt(candidate);
        if excerpt.is_empty() {
            continue;
        }
        let separator_bytes = if recent.is_empty() { 0 } else { 2 };
        let remaining = CHAT_RENAME_RECENT_BUDGET
            .saturating_sub(recent_bytes)
            .saturating_sub(separator_bytes);
        if remaining == 0 {
            break;
        }
        let bounded = truncate_utf8(&excerpt, remaining.min(2_000));
        if bounded.is_empty() {
            break;
        }
        recent_bytes += bounded.len() + separator_bytes;
        recent.insert(0, bounded);
    }

    let mut lines = vec![
        "Create a new title for this existing coding conversation.".to_string(),
        "Return only the title, with no JSON, Markdown, quotes, or prefix.".to_string(),
        "Rules:".to_string(),
        "- Summarize the actual task or outcome instead of repeating a message verbatim."
            .to_string(),
        "- Keep it short and specific, ideally 3-8 words.".to_string(),
        "- Do not end with punctuation.".to_string(),
        "- Use only facts in the conversation excerpts.".to_string(),
        String::new(),
        "Original user request:".to_string(),
        if original.is_empty() {
            "No user request was recorded.".to_string()
        } else {
            original
        },
    ];
    if !recent.is_empty() {
        lines.push(String::new());
        lines.push("Recent conversation:".to_string());
        lines.push(recent.join("\n\n"));
    }
    lines.join("\n")
}

// ===========================================================================
// Chat title routing (chat-title-routing.ts)
// ===========================================================================

/// How background title generation obtains a title.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatTitleRoute {
    AppleFoundationModels,
    ChatModel,
    SeedOnly,
}

impl ChatTitleRoute {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatTitleRoute::AppleFoundationModels => "apple-foundation-models",
            ChatTitleRoute::ChatModel => "chat-model",
            ChatTitleRoute::SeedOnly => "seed-only",
        }
    }
}

/// Which title provider the user selected for chat naming.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatTitleProviderId {
    Automatic,
    AppleFoundationModels,
    ChatModel,
}

impl ChatTitleProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatTitleProviderId::Automatic => "automatic",
            ChatTitleProviderId::AppleFoundationModels => "apple-foundation-models",
            ChatTitleProviderId::ChatModel => "chat-model",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "automatic" => Some(ChatTitleProviderId::Automatic),
            "apple-foundation-models" => Some(ChatTitleProviderId::AppleFoundationModels),
            "chat-model" => Some(ChatTitleProviderId::ChatModel),
            _ => None,
        }
    }
}

/// Connection state of Apple Foundation Models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FoundationModelsConnectionState {
    Ready,
    UnsupportedOs,
    DeviceNotEligible,
    AppleIntelligenceDisabled,
    ModelPreparing,
    HelperUnavailable,
    Unavailable,
    Error,
}

impl FoundationModelsConnectionState {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "ready" => Some(FoundationModelsConnectionState::Ready),
            "unsupported_os" => Some(FoundationModelsConnectionState::UnsupportedOs),
            "device_not_eligible" => Some(FoundationModelsConnectionState::DeviceNotEligible),
            "apple_intelligence_disabled" => {
                Some(FoundationModelsConnectionState::AppleIntelligenceDisabled)
            }
            "model_preparing" => Some(FoundationModelsConnectionState::ModelPreparing),
            "helper_unavailable" => Some(FoundationModelsConnectionState::HelperUnavailable),
            "unavailable" => Some(FoundationModelsConnectionState::Unavailable),
            "error" => Some(FoundationModelsConnectionState::Error),
            _ => None,
        }
    }
}

/// The native title-only connection status the router consults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FoundationModelsConnectionStatus {
    pub id: String,
    pub label: String,
    pub state: FoundationModelsConnectionState,
    pub detail: String,
    pub local: bool,
    pub title_only: bool,
    pub retryable: bool,
}

pub fn resolve_chat_title_route(
    provider_id: ChatTitleProviderId,
    foundation_models_status: Option<&FoundationModelsConnectionStatus>,
) -> ChatTitleRoute {
    match provider_id {
        ChatTitleProviderId::ChatModel => ChatTitleRoute::ChatModel,
        ChatTitleProviderId::AppleFoundationModels => {
            if foundation_models_status
                .map(|status| status.state == FoundationModelsConnectionState::Ready)
                .unwrap_or(false)
            {
                ChatTitleRoute::AppleFoundationModels
            } else {
                ChatTitleRoute::SeedOnly
            }
        }
        ChatTitleProviderId::Automatic => {
            if foundation_models_status
                .map(|status| status.state == FoundationModelsConnectionState::Ready)
                .unwrap_or(false)
            {
                ChatTitleRoute::AppleFoundationModels
            } else {
                ChatTitleRoute::ChatModel
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Attachment, AttachmentKind, ChatMessage, ChatRole};

    fn attachment(kind: AttachmentKind, name: &str) -> Attachment {
        Attachment {
            id: format!("attachment-{kind:?}"),
            name: name.to_string(),
            mime_type: if kind == AttachmentKind::Image {
                "image/png".into()
            } else {
                "text/plain".into()
            },
            kind,
            size: 123,
            data: None,
            text: None,
        }
    }

    #[test]
    fn derives_an_immediate_sidebar_safe_title_from_the_first_prompt() {
        assert_eq!(
            derive_chat_title_seed(&ChatTitleInput {
                content: "  Fix   reconnect\n failures after restart  ".into(),
                attachments: None,
            }),
            "Fix reconnect failures after restart"
        );
        let long = derive_chat_title_seed(&ChatTitleInput {
            content: "a".repeat(80),
            attachments: None,
        });
        assert_eq!(long.chars().count(), MAX_CHAT_TITLE_LENGTH);
        assert!(long.ends_with("..."));
    }

    #[test]
    fn uses_attachment_names_when_the_first_prompt_has_no_text() {
        assert_eq!(
            derive_chat_title_seed(&ChatTitleInput {
                content: String::new(),
                attachments: Some(vec![attachment(AttachmentKind::Image, "dashboard.png")]),
            }),
            "Image: dashboard.png"
        );
        assert_eq!(
            derive_chat_title_seed(&ChatTitleInput {
                content: String::new(),
                attachments: Some(vec![attachment(AttachmentKind::Text, "trace.txt")]),
            }),
            "File: trace.txt"
        );
        assert_eq!(
            derive_chat_title_seed(&ChatTitleInput {
                content: String::new(),
                attachments: None,
            }),
            "New agent"
        );
    }

    #[test]
    fn only_considers_the_default_or_original_seed_replaceable() {
        assert!(can_replace_generated_chat_title(
            "New agent",
            "Investigate reconnects"
        ));
        assert!(can_replace_generated_chat_title(
            "New Agent",
            "Investigate reconnects"
        ));
        assert!(can_replace_generated_chat_title(
            "New chat",
            "Investigate reconnects"
        ));
        assert!(can_replace_generated_chat_title(
            "Investigate reconnects",
            "Investigate reconnects"
        ));
        assert!(!can_replace_generated_chat_title(
            "Keep my title",
            "Investigate reconnects"
        ));
    }

    #[test]
    fn normalizes_plain_prefixed_json_and_fenced_title_responses() {
        assert_eq!(
            sanitize_generated_chat_title("\"Reconnect Failures After Restart.\""),
            Some("Reconnect Failures After Restart".to_string())
        );
        assert_eq!(
            sanitize_generated_chat_title("Title: Fix reconnect spinner!"),
            Some("Fix reconnect spinner".to_string())
        );
        assert_eq!(
            sanitize_generated_chat_title("{\"title\":\"Improve chat naming\"}"),
            Some("Improve chat naming".to_string())
        );
        assert_eq!(
            sanitize_generated_chat_title("```json\n{\"title\":\"Improve chat naming\"}\n```"),
            Some("Improve chat naming".to_string())
        );
        assert_eq!(
            sanitize_generated_chat_title("Primary title\nExtra explanation"),
            Some("Primary title".to_string())
        );
        assert_eq!(sanitize_generated_chat_title("  ```  "), None);
    }

    #[test]
    fn builds_the_concise_coding_title_prompt_with_attachment_metadata() {
        let prompt = build_chat_title_prompt(&ChatTitleInput {
            content: "Tighten the chat sidebar".into(),
            attachments: Some(vec![attachment(AttachmentKind::Image, "sidebar.png")]),
        });
        assert!(prompt.contains("3-8 words"));
        assert!(prompt.contains("Tighten the chat sidebar"));
        assert!(prompt.contains("sidebar.png (image/png, 123 bytes)"));
    }

    fn message(id: &str, role: ChatRole, content: &str, created_at: u64) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            role,
            content: content.into(),
            created_at,
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        }
    }

    #[test]
    fn builds_a_bounded_rename_prompt_from_the_original_request_and_recent_conversation() {
        let mut messages: Vec<ChatMessage> = vec![message(
            "system",
            ChatRole::System,
            "Hidden system instructions",
            1,
        )];
        let mut first_user = message(
            "user-1",
            ChatRole::User,
            "Add an on-device chat rename action",
            2,
        );
        first_user.attachments = Some(vec![attachment(AttachmentKind::Image, "sidebar.png")]);
        messages.push(first_user);
        for index in 0..10 {
            messages.push(message(
                &format!("assistant-{index}"),
                ChatRole::Assistant,
                &format!("Implementation detail {index} 🧩 ").repeat(1_000),
                3 + index,
            ));
        }
        messages.push(message(
            "user-2",
            ChatRole::User,
            "Keep manual renames safe when generation finishes",
            20,
        ));

        let prompt = build_chat_rename_prompt(&messages);
        assert!(prompt.contains("Add an on-device chat rename action"));
        assert!(prompt.contains("Image: sidebar.png"));
        assert!(prompt.contains("Keep manual renames safe when generation finishes"));
        assert!(!prompt.contains("Hidden system instructions"));
        assert!(prompt.len() <= 16_384);
    }

    #[test]
    fn automatic_prefers_apple_only_while_the_native_connection_is_ready() {
        let status = |state: &str| FoundationModelsConnectionStatus {
            id: "apple-foundation-models".into(),
            label: "Apple Foundation Models".into(),
            state: FoundationModelsConnectionState::from_str(state).unwrap(),
            detail: state.into(),
            local: true,
            title_only: true,
            retryable: state == "model_preparing",
        };
        assert_eq!(
            resolve_chat_title_route(ChatTitleProviderId::Automatic, Some(&status("ready"))),
            ChatTitleRoute::AppleFoundationModels
        );
        assert_eq!(
            resolve_chat_title_route(
                ChatTitleProviderId::Automatic,
                Some(&status("model_preparing"))
            ),
            ChatTitleRoute::ChatModel
        );
        assert_eq!(
            resolve_chat_title_route(ChatTitleProviderId::Automatic, None),
            ChatTitleRoute::ChatModel
        );
    }

    #[test]
    fn apple_only_mode_never_falls_through_to_a_network_chat_model() {
        let status = |state: &str| FoundationModelsConnectionStatus {
            id: "apple-foundation-models".into(),
            label: "Apple Foundation Models".into(),
            state: FoundationModelsConnectionState::from_str(state).unwrap(),
            detail: state.into(),
            local: true,
            title_only: true,
            retryable: state == "model_preparing",
        };
        assert_eq!(
            resolve_chat_title_route(
                ChatTitleProviderId::AppleFoundationModels,
                Some(&status("ready"))
            ),
            ChatTitleRoute::AppleFoundationModels
        );
        assert_eq!(
            resolve_chat_title_route(
                ChatTitleProviderId::AppleFoundationModels,
                Some(&status("error"))
            ),
            ChatTitleRoute::SeedOnly
        );
        assert_eq!(
            resolve_chat_title_route(ChatTitleProviderId::AppleFoundationModels, None),
            ChatTitleRoute::SeedOnly
        );
    }

    #[test]
    fn chat_model_mode_ignores_the_native_connection() {
        let status = FoundationModelsConnectionStatus {
            id: "apple-foundation-models".into(),
            label: "Apple Foundation Models".into(),
            state: FoundationModelsConnectionState::Ready,
            detail: "ready".into(),
            local: true,
            title_only: true,
            retryable: false,
        };
        assert_eq!(
            resolve_chat_title_route(ChatTitleProviderId::ChatModel, Some(&status)),
            ChatTitleRoute::ChatModel
        );
    }
}
