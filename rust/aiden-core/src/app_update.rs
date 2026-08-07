//! Port of `renderer/shared/app-update.ts` — the update status contract.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Status the updater reports to the renderer. `idle` always carries
/// `version: null`; `ready` always carries the downloaded version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AppUpdateSnapshot {
    #[serde(rename = "idle")]
    Idle {
        #[serde(rename = "version")]
        version: Option<()>,
    },
    #[serde(rename = "ready")]
    Ready { version: String },
}

/// Outcome of a restart request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "accepted")]
pub enum AppUpdateRestartResult {
    #[serde(rename = "true")]
    Accepted {},
    #[serde(rename = "false")]
    Rejected { reason: AppUpdateRestartReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdateRestartReason {
    Busy,
    NotReady,
    Unavailable,
}

/// The idle snapshot every parse failure falls back to.
pub const IDLE_APP_UPDATE_SNAPSHOT: AppUpdateSnapshot = AppUpdateSnapshot::Idle { version: None };

/// Accept only trimmed, bounded, printable version strings.
pub fn normalize_app_update_version(value: &Value) -> Option<String> {
    let raw = value.as_str()?;
    for ch in raw.chars() {
        let code = ch as u32;
        if code <= 31 || code == 127 {
            return None;
        }
    }
    let version = raw.trim();
    if version.is_empty() || version.chars().count() > 128 {
        return None;
    }
    Some(version.to_string())
}

/// Fail closed: any malformed or non-ready payload becomes the idle snapshot.
pub fn parse_app_update_snapshot(value: &Value) -> AppUpdateSnapshot {
    let Some(record) = value.as_object() else {
        return IDLE_APP_UPDATE_SNAPSHOT;
    };
    let version = record.get("version").and_then(normalize_app_update_version);
    if record.get("status").and_then(Value::as_str) == Some("ready") && version.is_some() {
        return AppUpdateSnapshot::Ready {
            version: version.unwrap_or_default(),
        };
    }
    IDLE_APP_UPDATE_SNAPSHOT
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_a_bounded_downloaded_update_version() {
        assert_eq!(
            normalize_app_update_version(&json!(" 0.27.25 ")).unwrap(),
            "0.27.25"
        );
        assert_eq!(
            parse_app_update_snapshot(&json!({ "status": "ready", "version": "0.27.25" })),
            AppUpdateSnapshot::Ready {
                version: "0.27.25".into()
            }
        );
    }

    #[test]
    fn fails_closed_for_malformed_or_non_ready_snapshots() {
        assert_eq!(
            parse_app_update_snapshot(&Value::Null),
            IDLE_APP_UPDATE_SNAPSHOT
        );
        assert_eq!(
            parse_app_update_snapshot(
                &json!({ "status": "ready", "version": "0.27.25\nRestart now" })
            ),
            IDLE_APP_UPDATE_SNAPSHOT
        );
        assert_eq!(
            parse_app_update_snapshot(&json!({ "status": "ready", "version": "\n0.27.25" })),
            IDLE_APP_UPDATE_SNAPSHOT
        );
        assert_eq!(
            parse_app_update_snapshot(&json!({ "status": "downloading", "version": "0.27.25" })),
            IDLE_APP_UPDATE_SNAPSHOT
        );
    }

    #[test]
    fn ready_snapshot_serializes_status_tag_and_version() {
        let snapshot = AppUpdateSnapshot::Ready {
            version: "0.27.25".into(),
        };
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value["status"], "ready");
        assert_eq!(value["version"], "0.27.25");
    }
}
