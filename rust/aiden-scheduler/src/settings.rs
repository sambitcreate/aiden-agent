//! Port of `main/services/scheduled-settings-core.ts` — the sparse settings
//! patch the Schedules settings surface accepts.
//!
//! Unknown or future enum values are deliberately never projected into the
//! patch, matching the TS behavior of only copying known keys.

use serde_json::{Map, Value};

/// A settings patch key that maps to an `AppSettings` field in the Electron
/// app. Kept as plain camelCase strings to stay byte-compatible with
/// `settings.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledSettingsPatchKey {
    ScheduledTasksEnabled,
    ScheduledDefaultMode,
    ScheduledDefaultPermission,
    ScheduledDefaultMcpEnabled,
    ScheduledDefaultNotify,
    ScheduledDefaultTimezone,
}

impl ScheduledSettingsPatchKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ScheduledTasksEnabled => "scheduledTasksEnabled",
            Self::ScheduledDefaultMode => "scheduledDefaultMode",
            Self::ScheduledDefaultPermission => "scheduledDefaultPermission",
            Self::ScheduledDefaultMcpEnabled => "scheduledDefaultMcpEnabled",
            Self::ScheduledDefaultNotify => "scheduledDefaultNotify",
            Self::ScheduledDefaultTimezone => "scheduledDefaultTimezone",
        }
    }
}

/// `scheduledSettingsPatch` — project only recognized fields into a sparse
/// `Partial<AppSettings>` patch. The timezone validator is injected (the real
/// one lives in `aiden-data::schedule_store::validate_timezone`); a rejection
/// surfaces as an `Err(message)` mirroring the TS throw.
pub fn scheduled_settings_patch(
    input: &Value,
    validate_timezone: &dyn Fn(&str) -> Result<String, String>,
) -> Result<Value, String> {
    let mut patch = Map::new();
    if let Some(enabled) = input.get("enabled").and_then(Value::as_bool) {
        patch.insert(
            ScheduledSettingsPatchKey::ScheduledTasksEnabled
                .as_str()
                .into(),
            Value::Bool(enabled),
        );
    }
    if let Some(mode) = input.get("defaultMode").and_then(Value::as_str) {
        if mode == "llm" || mode == "script" {
            patch.insert(
                ScheduledSettingsPatchKey::ScheduledDefaultMode
                    .as_str()
                    .into(),
                Value::String(mode.to_string()),
            );
        }
    }
    if let Some(permission) = input.get("defaultPermission").and_then(Value::as_str) {
        if permission == "read-only" || permission == "full" {
            patch.insert(
                ScheduledSettingsPatchKey::ScheduledDefaultPermission
                    .as_str()
                    .into(),
                Value::String(permission.to_string()),
            );
        }
    }
    if let Some(mcp_enabled) = input.get("defaultMcpEnabled").and_then(Value::as_bool) {
        patch.insert(
            ScheduledSettingsPatchKey::ScheduledDefaultMcpEnabled
                .as_str()
                .into(),
            Value::Bool(mcp_enabled),
        );
    }
    if let Some(notify) = input.get("defaultNotify").and_then(Value::as_bool) {
        patch.insert(
            ScheduledSettingsPatchKey::ScheduledDefaultNotify
                .as_str()
                .into(),
            Value::Bool(notify),
        );
    }
    if input.get("defaultTimezone").is_some() {
        let timezone = input.get("defaultTimezone").and_then(Value::as_str);
        let timezone = match timezone {
            Some(value) if !value.trim().is_empty() => value.to_string(),
            _ => return Err("Expected a non-empty string for \"defaultTimezone\".".to_string()),
        };
        let validated = validate_timezone(&timezone)?;
        patch.insert(
            ScheduledSettingsPatchKey::ScheduledDefaultTimezone
                .as_str()
                .into(),
            Value::String(validated),
        );
    }
    Ok(Value::Object(patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(value: &str) -> Result<String, String> {
        Ok(value.to_string())
    }

    #[test]
    fn an_unrelated_scheduler_edit_produces_a_sparse_settings_patch() {
        let patch =
            scheduled_settings_patch(&serde_json::json!({ "enabled": true }), &identity).unwrap();
        assert_eq!(patch, serde_json::json!({ "scheduledTasksEnabled": true }));
    }

    #[test]
    fn unknown_future_scheduler_enum_values_are_never_projected() {
        let patch = scheduled_settings_patch(
            &serde_json::json!({
                "enabled": false,
                "defaultMode": "future-mode",
                "defaultPermission": "future-permission",
            }),
            &identity,
        )
        .unwrap();
        assert_eq!(patch, serde_json::json!({ "scheduledTasksEnabled": false }));
    }

    #[test]
    fn default_mcp_access_is_accepted_only_as_an_explicit_boolean() {
        let patch = scheduled_settings_patch(
            &serde_json::json!({
                "defaultMcpEnabled": true,
                "defaultNotify": false,
            }),
            &identity,
        )
        .unwrap();
        assert_eq!(
            patch,
            serde_json::json!({
                "scheduledDefaultMcpEnabled": true,
                "scheduledDefaultNotify": false,
            })
        );
        let patch = scheduled_settings_patch(
            &serde_json::json!({ "defaultMcpEnabled": "true" }),
            &identity,
        )
        .unwrap();
        assert_eq!(patch, serde_json::json!({}));
    }

    #[test]
    fn default_timezone_is_required_and_validated() {
        let patch = scheduled_settings_patch(
            &serde_json::json!({ "defaultTimezone": "America/New_York" }),
            &identity,
        )
        .unwrap();
        assert_eq!(
            patch,
            serde_json::json!({ "scheduledDefaultTimezone": "America/New_York" })
        );
        let error =
            scheduled_settings_patch(&serde_json::json!({ "defaultTimezone": "  " }), &identity)
                .unwrap_err();
        assert!(error.contains("non-empty string"));
        let error =
            scheduled_settings_patch(&serde_json::json!({ "defaultTimezone": "nope" }), &|_| {
                Err("Unknown timezone \"nope\".".to_string())
            })
            .unwrap_err();
        assert_eq!(error, "Unknown timezone \"nope\".");
    }
}
