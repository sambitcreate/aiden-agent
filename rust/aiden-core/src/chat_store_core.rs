//! Port of the dependency-free parts of `main/services/chat-store-core.ts`:
//! canonical chat-id validation, index-entry validation, the metadata
//! projection (`metaOf`), and the crash-recovery filename contracts. The
//! durable filesystem store itself lives in `aiden-data`.

use serde_json::Value;

use crate::{Chat, ChatMeta};

pub const INDEX: &str = "index.json";
pub const DEFAULT_WORKSPACE_ID: &str = "default";

/// Canonical chat ids: 1-160 chars from a safe ASCII set, already
/// NFKC-normalized (which is always true for that ASCII set).
const SAFE_CHAT_ID_CHARS: &[char] = &[
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S',
    'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l',
    'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4',
    '5', '6', '7', '8', '9', '.', '_', ':', '-',
];

/// Reject empty, oversized, or non-canonical chat ids before they become
/// filenames or directory entries.
pub fn is_valid_chat_id(id: &str) -> bool {
    if id.is_empty() || id.chars().count() > 160 {
        return false;
    }
    id.chars().all(|ch| SAFE_CHAT_ID_CHARS.contains(&ch))
}

/// The id validation applied by `chatPath` in the Electron store.
pub fn validate_chat_id(id: &str) -> Result<(), String> {
    if is_valid_chat_id(id) {
        Ok(())
    } else {
        Err("Invalid chat id.".to_string())
    }
}

/// Schema validation for one `index.json` entry.
pub fn is_valid_meta(value: &Value) -> bool {
    let Some(meta) = value.as_object() else {
        return false;
    };
    let id_ok = meta
        .get("id")
        .and_then(Value::as_str)
        .map(is_valid_chat_id)
        .unwrap_or(false);
    if !id_ok {
        return false;
    }
    if !meta.get("title").and_then(Value::as_str).is_some() {
        return false;
    }
    let finite_non_negative = |value: Option<&Value>| {
        matches!(
            value.and_then(Value::as_f64),
            Some(number) if number.is_finite() && number >= 0.0
        )
    };
    if !finite_non_negative(meta.get("createdAt")) || !finite_non_negative(meta.get("updatedAt")) {
        return false;
    }
    let optional_string = |value: Option<&Value>| match value {
        None => true,
        Some(Value::String(_)) => true,
        Some(_) => false,
    };
    optional_string(meta.get("workspaceId"))
        && optional_string(meta.get("providerId"))
        && optional_string(meta.get("model"))
}

/// Metadata projection for one chat payload; legacy chats without a workspace
/// fall under the default one.
pub fn meta_of(chat: &Chat) -> ChatMeta {
    ChatMeta {
        id: chat.id.clone(),
        title: chat.title.clone(),
        workspace_id: Some(
            chat.workspace_id
                .clone()
                .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string()),
        ),
        provider_id: chat.provider_id.clone(),
        model: chat.model.clone(),
        created_at: chat.created_at,
        updated_at: chat.updated_at,
    }
}

// ---------------------------------------------------------------------------
// Crash-recovery staging filename contracts
// ---------------------------------------------------------------------------

fn is_hex_run(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| b.is_ascii_hexdigit())
}

/// `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`
fn is_uuid_v4(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    is_hex_run(&bytes[0..8])
        && bytes[8] == b'-'
        && is_hex_run(&bytes[9..13])
        && bytes[13] == b'-'
        && bytes[14] == b'4'
        && is_hex_run(&bytes[15..18])
        && bytes[18] == b'-'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && is_hex_run(&bytes[20..23])
        && bytes[23] == b'-'
        && is_hex_run(&bytes[24..36])
}

/// `^\.index\.json\.[uuid]\.chat-delete\.tmp$`
pub fn is_chat_delete_staging(name: &str) -> bool {
    staging_uuid(name, "chat-delete")
}

/// `^\.index\.json\.[uuid]\.index-write\.tmp$`
pub fn is_index_write_staging(name: &str) -> bool {
    staging_uuid(name, "index-write")
}

fn staging_uuid(name: &str, purpose: &str) -> bool {
    let Some(rest) = name.strip_prefix(".index.json.") else {
        return false;
    };
    let Some(uuid) = rest.strip_suffix(&format!(".{purpose}.tmp")) else {
        return false;
    };
    is_uuid_v4(uuid)
}

/// `^\.[A-Za-z0-9._:-]+\.json\.[uuid]\.chat-write\.tmp$`
pub fn is_chat_write_staging(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    let Some(tail) = rest.strip_suffix(".tmp") else {
        return false;
    };
    let Some(chat_part) = tail.strip_suffix(".chat-write") else {
        return false;
    };
    let Some((chat_id, purpose)) = chat_part.rsplit_once(".json.") else {
        return false;
    };
    if !is_uuid_v4(purpose) {
        return false;
    }
    !chat_id.is_empty() && is_valid_chat_id(chat_id)
}

/// `^\.chat-transaction\.([A-Za-z0-9._:-]+)\.pending$` — returns the captured
/// chat id.
pub fn chat_transaction_id(name: &str) -> Option<String> {
    let id = name.strip_prefix(".chat-transaction.")?;
    let id = id.strip_suffix(".pending")?;
    if id.is_empty() || !is_valid_chat_id(id) {
        return None;
    }
    Some(id.to_string())
}

/// Port of the Electron store's id generator:
/// `Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)`.
/// The suffix is derived from a process-wide atomic counter hashed into base36
/// so ids stay unique within a process without a runtime RNG dependency.
pub fn new_chat_id(now_ms: u64, counter: u64) -> String {
    let timestamp = to_base36(now_ms);
    let mut state = 0xcbf29ce484222325u64;
    state ^= now_ms;
    state = state.wrapping_mul(0x100000001b3);
    state ^= counter;
    state = state.wrapping_mul(0x100000001b3);
    let suffix = to_base36(state);
    let suffix = format!("{suffix:0>6}");
    let suffix = suffix[suffix.len() - 6..].to_string();
    format!("{timestamp}-{suffix}")
}

fn to_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_traversal_shaped_and_invalid_chat_ids() {
        assert!(is_valid_chat_id("chat-1"));
        assert!(is_valid_chat_id("a.b_c:d"));
        assert!(!is_valid_chat_id(""));
        assert!(!is_valid_chat_id("../outside"));
        assert!(!is_valid_chat_id("a/b"));
        assert!(!is_valid_chat_id("a\\b"));
        assert!(!is_valid_chat_id(&"a".repeat(161)));
        assert!(validate_chat_id("../outside").is_err());
        assert_eq!(
            validate_chat_id("../outside").unwrap_err(),
            "Invalid chat id."
        );
        assert!(validate_chat_id("chat-1").is_ok());
    }

    #[test]
    fn staging_filenames_match_the_electron_contracts() {
        let uuid = "01234567-89ab-4def-8abc-0123456789ab";
        assert!(is_chat_delete_staging(&format!(
            ".index.json.{uuid}.chat-delete.tmp"
        )));
        assert!(is_index_write_staging(&format!(
            ".index.json.{uuid}.index-write.tmp"
        )));
        assert!(is_chat_write_staging(&format!(
            ".chat-1.json.{uuid}.chat-write.tmp"
        )));
        assert!(!is_chat_delete_staging(&format!(
            ".index.json.{uuid}.index-write.tmp"
        )));
        assert!(!is_chat_delete_staging("index.json"));
        assert!(!is_chat_write_staging(&format!(
            ".chat-1.json.{uuid}.chat-write"
        )));
        assert_eq!(
            chat_transaction_id(".chat-transaction.chat-1.pending"),
            Some("chat-1".to_string())
        );
        assert_eq!(chat_transaction_id(".chat-transaction..pending"), None);
        // A single safe character is a canonical id; an unsafe one is not.
        assert_eq!(
            chat_transaction_id(".chat-transaction.x.pending"),
            Some("x".to_string())
        );
        assert_eq!(chat_transaction_id(".chat-transaction.x/y.pending"), None);
        assert_eq!(chat_transaction_id(".chat-transaction.pending"), None);
    }

    #[test]
    fn meta_of_binds_payload_metadata_with_default_workspace() {
        let chat = Chat {
            id: "chat-1".into(),
            title: "Fix reconnect".into(),
            workspace_id: None,
            provider_id: Some("anthropic".into()),
            model: Some("claude-sonnet-5".into()),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_100,
            computer_use_enabled: None,
            messages: vec![],
        };
        let meta = meta_of(&chat);
        assert_eq!(meta.workspace_id.as_deref(), Some("default"));
        assert_eq!(meta.provider_id.as_deref(), Some("anthropic"));
        assert!(is_valid_meta(&serde_json::to_value(&meta).unwrap()));
    }

    #[test]
    fn index_entry_validation_is_schema_strict() {
        let good = json!({
            "id": "chat-1",
            "title": "Fix reconnect",
            "workspaceId": "default",
            "providerId": "anthropic",
            "model": "claude-sonnet-5",
            "createdAt": 1_700_000_000_000_i64,
            "updatedAt": 1_700_000_000_100_i64,
        });
        assert!(is_valid_meta(&good));
        assert!(!is_valid_meta(
            &json!({ "id": "chat-1", "title": "x", "createdAt": 1, "updatedAt": "now" })
        ));
        assert!(!is_valid_meta(
            &json!({ "id": "chat-1", "title": 1, "createdAt": 1, "updatedAt": 2 })
        ));
        assert!(!is_valid_meta(
            &json!({ "id": "chat-1", "title": "x", "createdAt": 1, "updatedAt": 2, "providerId": 3 })
        ));
    }

    #[test]
    fn new_chat_ids_are_unique_and_url_safe() {
        let ids: Vec<String> = (0..100)
            .map(|index| new_chat_id(1_700_000_000_000, index))
            .collect();
        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), 100);
        for id in &ids {
            assert!(is_valid_chat_id(id));
        }
    }
}
