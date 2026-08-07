//! Port of `main/services/subagents/forked-context.ts` — the positive context
//! projection for forked children. Private reasoning, timelines, approvals,
//! tool payloads, subagent references, and unknown fields are never copied;
//! credential/private-path redaction is applied before any text is retained.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::safe_text::sanitize_subagent_text;

pub type SubagentContextMode = &'static str;
pub const MAX_FORK_CONTEXT_MESSAGES: usize = 512;
pub const MAX_FORK_CONTEXT_TEXT_CHARS: usize = 2_000_000;
pub const MAX_FORK_CONTEXT_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_TEXT_CHARS: usize = 100_000;

const MAX_ATTACHMENTS_PER_MESSAGE: usize = 20;
const MAX_ATTACHMENT_ID_CHARS: usize = 256;
const MAX_ATTACHMENT_NAME_CHARS: usize = 512;
const MAX_MIME_TYPE_CHARS: usize = 128;
const MAX_LEGACY_TEXT_CHARS: usize = MAX_TEXT_CHARS + "… [truncated]".len();
const MAX_IMAGE_BASE64_CHARS: usize = (MAX_IMAGE_BYTES / 3) * 4;
const FORK_IMAGE_MIME_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/heic",
    "image/heif",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkTextAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub kind: String,
    pub size: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkImageAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub kind: String,
    pub size: u64,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForkContextAttachment {
    Text(ForkTextAttachment),
    Image(ForkImageAttachment),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkContextMessage {
    pub role: String,
    pub content: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<ForkContextAttachment>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentContextCapture {
    pub mode: String,
    pub revision_hash: String,
    pub chat_id: String,
    pub messages: Vec<ForkContextMessage>,
}

fn bounded_string(
    value: &Value,
    maximum: usize,
    field: &str,
    allow_empty: bool,
) -> Result<String, String> {
    let Some(value) = value.as_str() else {
        return Err(format!(
            "Forked subagent context contains an invalid {field}."
        ));
    };
    if (!allow_empty && value.is_empty()) || value.len() > maximum || value.contains('\0') {
        return Err(format!(
            "Forked subagent context contains an invalid {field}."
        ));
    }
    Ok(value.to_string())
}

fn is_base64(value: &str) -> bool {
    if value.is_empty() || !value.len().is_multiple_of(4) {
        return false;
    }
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        let is_alphabet = byte.is_ascii_alphanumeric() || matches!(*byte, b'+' | b'/');
        let is_padding = *byte == b'=' && index >= bytes.len() - 2;
        if !is_alphabet && !is_padding {
            return false;
        }
    }
    true
}

fn base64_decoded_len(value: &str) -> usize {
    let padding = value
        .bytes()
        .rev()
        .take(2)
        .filter(|byte| *byte == b'=')
        .count();
    value.len() / 4 * 3 - padding
}

fn parse_attachment(value: &Value) -> Result<ForkContextAttachment, String> {
    let Some(object) = value.as_object() else {
        return Err("Forked subagent context contains an invalid attachment.".to_string());
    };
    let id = bounded_string(
        object.get("id").expect("key"),
        MAX_ATTACHMENT_ID_CHARS,
        "attachment id",
        false,
    )?;
    let name = sanitize_subagent_text(&bounded_string(
        object.get("name").expect("key"),
        MAX_ATTACHMENT_NAME_CHARS,
        "attachment name",
        false,
    )?);
    let mime_type = bounded_string(
        object.get("mimeType").expect("key"),
        MAX_MIME_TYPE_CHARS,
        "attachment MIME type",
        false,
    )?;
    let size = object
        .get("size")
        .and_then(Value::as_u64)
        .filter(|size| *size <= MAX_FORK_CONTEXT_ATTACHMENT_BYTES as u64)
        .ok_or_else(|| {
            "Forked subagent context contains an invalid attachment size.".to_string()
        })?;
    match object.get("kind").and_then(Value::as_str) {
        Some("text") => {
            if mime_type != "text/plain" {
                return Err(
                    "Forked subagent context contains an unsupported text attachment.".to_string(),
                );
            }
            let text = sanitize_subagent_text(&bounded_string(
                object.get("text").expect("key"),
                MAX_LEGACY_TEXT_CHARS,
                "text attachment",
                true,
            )?);
            Ok(ForkContextAttachment::Text(ForkTextAttachment {
                id,
                name,
                mime_type,
                kind: "text".to_string(),
                size,
                text,
            }))
        }
        Some("image") => {
            if !FORK_IMAGE_MIME_TYPES.contains(&mime_type.as_str()) {
                return Err(
                    "Forked subagent context contains an unsupported attachment.".to_string(),
                );
            }
            let data = object.get("data").and_then(Value::as_str).ok_or_else(|| {
                "Forked subagent context contains an unsupported attachment.".to_string()
            })?;
            if data.is_empty() || data.len() > MAX_IMAGE_BASE64_CHARS || !is_base64(data) {
                return Err(
                    "Forked subagent context contains an unsupported attachment.".to_string(),
                );
            }
            let decoded_bytes = base64_decoded_len(data);
            if decoded_bytes != size as usize || decoded_bytes > MAX_IMAGE_BYTES {
                return Err(
                    "Forked subagent context contains an invalid image attachment size."
                        .to_string(),
                );
            }
            Ok(ForkContextAttachment::Image(ForkImageAttachment {
                id,
                name,
                mime_type,
                kind: "image".to_string(),
                size,
                data: data.to_string(),
            }))
        }
        _ => Err("Forked subagent context contains an unsupported attachment.".to_string()),
    }
}

fn parse_attachments(value: Option<&Value>) -> Result<Option<Vec<ForkContextAttachment>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(values) = value.as_array() else {
        return Err("Forked subagent context contains invalid message attachments.".to_string());
    };
    if values.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err("Forked subagent context contains invalid message attachments.".to_string());
    }
    Ok(Some(
        values
            .iter()
            .map(parse_attachment)
            .collect::<Result<_, _>>()?,
    ))
}

fn revision_hash(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(value).expect("json").as_bytes());
    crate::authority::hex(&hasher.finalize())
}

fn assert_private_identity(value: &Value, field: &str) -> Result<String, String> {
    let Some(value) = value.as_str() else {
        return Err(format!(
            "Forked subagent context contains an invalid {field}."
        ));
    };
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(format!(
            "Forked subagent context contains an invalid {field}."
        ));
    }
    Ok(value.to_string())
}

/// Live-capture redaction (the persisted projection path uses the snapshot
/// sanitizer instead; kept for the live-capture seam that the host wires).
#[allow(dead_code)]
fn redact_private_fork_text(value: &str) -> String {
    let sanitized = sanitize_subagent_text(value);
    // Private-key blocks, assignment forms, and sk- keys.
    let mut redacted = String::with_capacity(sanitized.len());
    let bytes = sanitized.as_bytes();
    let mut index = 0;
    while index < sanitized.len() {
        let rest = &sanitized[index..];
        let lower = rest.to_ascii_lowercase();
        if lower.starts_with("-----begin ") {
            if let Some(end) = lower.find("-----end ") {
                let end_index = index + end;
                if let Some(line_end) = sanitized[end_index..].find('\n') {
                    redacted.push_str("[credential redacted]");
                    index = end_index + line_end;
                    continue;
                }
            }
        }
        if lower.starts_with("authorization: bearer") {
            if let Some(space) = rest.find(' ') {
                let value_start = space + 1;
                if let Some(comma) = rest[value_start..].find([',', ';', '\n']) {
                    redacted.push_str("[credential redacted]");
                    index += value_start + comma;
                    continue;
                }
            }
        }
        // sk-[A-Za-z0-9_-]{16,}
        if lower.starts_with("sk-") {
            let rest_bytes = rest.as_bytes();
            let mut count = 3;
            while count < rest_bytes.len()
                && (rest_bytes[count].is_ascii_alphanumeric()
                    || matches!(rest_bytes[count], b'_' | b'-'))
            {
                count += 1;
            }
            if count >= 19 {
                redacted.push_str("[credential redacted]");
                index += count;
                continue;
            }
        }
        // Absolute paths /Users/x/... and /home/x/...
        if rest.starts_with("/Users/") || rest.starts_with("/home/") {
            let mut count = 0;
            let mut segments = 0;
            let rest_bytes = rest.as_bytes();
            while count < rest_bytes.len()
                && rest_bytes[count] != b' '
                && rest_bytes[count] != b'\n'
            {
                if rest_bytes[count] == b'/' {
                    segments += 1;
                }
                count += 1;
            }
            if segments >= 3 {
                redacted.push_str("[private path redacted]");
                index += count;
                continue;
            }
        }
        redacted.push(bytes[index] as char);
        index += 1;
    }
    redacted
}

/// `capturePersistedSubagentContext` — project one persisted chat revision
/// into immutable, user-visible context.
pub fn capture_persisted_subagent_context(value: &Value) -> Result<SubagentContextCapture, String> {
    let Some(object) = value.as_object() else {
        return Err(
            "Forked subagent context could not read the persisted chat revision.".to_string(),
        );
    };
    let Some(messages_value) = object.get("messages").and_then(Value::as_array) else {
        return Err(
            "Forked subagent context could not read the persisted chat revision.".to_string(),
        );
    };
    let chat_id = assert_private_identity(object.get("id").expect("key"), "chat id")?;
    let updated_at = object
        .get("updatedAt")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Forked subagent context contains an invalid chat revision.".to_string())?;
    if messages_value.len() > MAX_FORK_CONTEXT_MESSAGES {
        return Err("Forked subagent context exceeds the persisted message limit.".to_string());
    }
    let mut messages = Vec::new();
    let mut text_chars = 0usize;
    let mut attachment_bytes = 0usize;
    for candidate in messages_value {
        let Some(candidate) = candidate.as_object() else {
            return Err(
                "Forked subagent context contains an invalid persisted message.".to_string(),
            );
        };
        let role = candidate.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let content = sanitize_subagent_text(&bounded_string(
            candidate.get("content").expect("key"),
            MAX_FORK_CONTEXT_TEXT_CHARS,
            "message content",
            true,
        )?);
        let created_at = candidate
            .get("createdAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                "Forked subagent context contains an invalid message timestamp.".to_string()
            })?;
        let attachments = if role == "user" {
            parse_attachments(candidate.get("attachments"))?
        } else {
            None
        };
        let attachment_count = attachments
            .as_ref()
            .map(|attachments| attachments.len())
            .unwrap_or(0);
        if content.is_empty() && attachment_count == 0 {
            continue;
        }
        text_chars += content.len();
        if let Some(attachments) = &attachments {
            for attachment in attachments {
                match attachment {
                    ForkContextAttachment::Text(attachment) => text_chars += attachment.text.len(),
                    ForkContextAttachment::Image(_attachment) => {}
                }
                attachment_bytes += attachment_size(attachment);
            }
        }
        if text_chars > MAX_FORK_CONTEXT_TEXT_CHARS {
            return Err("Forked subagent context exceeds the text limit.".to_string());
        }
        if attachment_bytes > MAX_FORK_CONTEXT_ATTACHMENT_BYTES {
            return Err("Forked subagent context exceeds the attachment limit.".to_string());
        }
        messages.push(ForkContextMessage {
            role: role.to_string(),
            content,
            created_at,
            attachments,
        });
    }
    let hash = revision_hash(&serde_json::json!({
        "chatId": chat_id,
        "updatedAt": updated_at,
        "messages": messages,
    }));
    Ok(SubagentContextCapture {
        mode: "fork".to_string(),
        revision_hash: hash,
        chat_id,
        messages,
    })
}

fn attachment_size(attachment: &ForkContextAttachment) -> usize {
    match attachment {
        ForkContextAttachment::Text(attachment) => attachment.size as usize,
        ForkContextAttachment::Image(attachment) => attachment.size as usize,
    }
}

pub fn create_fresh_subagent_context(
    input: &FreshContextInput,
) -> Result<SubagentContextCapture, String> {
    let chat_id = assert_private_identity(&Value::String(input.chat_id.clone()), "chat id")?;
    let generation_id =
        assert_private_identity(&Value::String(input.generation_id.clone()), "generation id")?;
    let hash = revision_hash(&serde_json::json!({
        "mode": "fresh",
        "chatId": chat_id,
        "generationId": generation_id,
    }));
    Ok(SubagentContextCapture {
        mode: "fresh".to_string(),
        revision_hash: hash,
        chat_id,
        messages: Vec::new(),
    })
}

pub struct FreshContextInput {
    pub chat_id: String,
    pub generation_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persisted_capture_is_a_positive_projection() {
        let value = json!({
            "id": "chat-1",
            "updatedAt": 100,
            "messages": [
                { "role": "system", "content": "hidden", "createdAt": 1 },
                { "role": "user", "content": "hello", "createdAt": 10 },
                {
                    "role": "assistant",
                    "content": "world",
                    "createdAt": 20,
                    "timeline": { "version": 2, "generationId": "g", "status": "completed", "startedAt": 1, "steps": [] },
                },
                { "role": "user", "content": "secret token=abc123def456ghi", "createdAt": 30 },
            ],
        });
        let capture = capture_persisted_subagent_context(&value).unwrap();
        assert_eq!(capture.mode, "fork");
        assert_eq!(capture.chat_id, "chat-1");
        assert_eq!(capture.messages.len(), 3);
        // Timeline/private protocol fields never copied.
        assert!(capture
            .messages
            .iter()
            .all(|message| message.attachments.is_none()));
        // Credential text is redacted.
        assert!(capture.messages[2].content.contains("[REDACTED]"));
        // Revision hash changes with content.
        let mut changed = value.clone();
        changed["updatedAt"] = json!(101);
        let changed_capture = capture_persisted_subagent_context(&changed).unwrap();
        assert_ne!(capture.revision_hash, changed_capture.revision_hash);
    }

    #[test]
    fn invalid_persisted_chats_fail_closed() {
        assert!(capture_persisted_subagent_context(&json!({ "id": "chat-1" })).is_err());
        assert!(capture_persisted_subagent_context(
            &json!({ "id": "chat-1", "updatedAt": 1, "messages": [] })
        )
        .is_ok());
        // Over the message limit.
        let messages: Vec<Value> = (0..513)
            .map(|index| json!({ "role": "user", "content": "x", "createdAt": index }))
            .collect();
        assert!(capture_persisted_subagent_context(&json!({
            "id": "chat-1",
            "updatedAt": 1,
            "messages": messages,
        }))
        .is_err());
    }

    #[test]
    fn fresh_context_is_empty_and_bounded() {
        let capture = create_fresh_subagent_context(&FreshContextInput {
            chat_id: "chat-1".into(),
            generation_id: "generation-1".into(),
        })
        .unwrap();
        assert_eq!(capture.mode, "fresh");
        assert!(capture.messages.is_empty());
        assert_eq!(capture.revision_hash.len(), 64);
    }
}
