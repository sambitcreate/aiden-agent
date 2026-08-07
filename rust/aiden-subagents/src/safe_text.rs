//! Shared text-safety boundary (port of `renderer/shared/subagent-safe-text.ts`
//! surface used by the subagent modules; the core sanitizer lives in aiden-core
//! `subagent_safe_text`). Also exposes the string form of
//! `isSafeSubagentIdentifier` from `renderer/shared/subagent-runs.ts`.

use aiden_core::subagent_safe_text::sanitize_subagent_snapshot_text as core_sanitize;
use aiden_core::subagent_safe_text::sanitize_subagent_text as core_sanitize_text;

/// `sanitizeSubagentText` — full text sanitizer.
pub fn sanitize_subagent_text(value: &str) -> String {
    core_sanitize_text(value)
}

/// `sanitizeSubagentSnapshotText` — snapshot field sanitizer.
pub fn sanitize_subagent_snapshot_text(value: &str) -> String {
    core_sanitize(value)
}

/// `isSafeSubagentIdentifier` for a `&str` — the shared privacy and syntax
/// boundary for every identifier that can be persisted or rendered.
pub fn is_safe_subagent_identifier_str(value: &str) -> bool {
    if value.is_empty()
        || value.chars().count() > 160
        || !value.is_ascii()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
        || sanitize_subagent_snapshot_text(value) != value
    {
        return false;
    }
    true
}

/// `isSafeSubagentIdentifier` for an unknown JSON value.
pub fn is_safe_subagent_identifier_value(value: &serde_json::Value) -> bool {
    match value.as_str() {
        Some(value) => is_safe_subagent_identifier_str(value),
        None => false,
    }
}
