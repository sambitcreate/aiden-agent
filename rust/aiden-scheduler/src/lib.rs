//! Aiden scheduler — scaffold.
//!
//! Phase 3 placeholder. This crate will port `main/services/schedule-*.ts`:
//!
//! - **Task records** — `ScheduledTask` / `ScheduledRun` persisted in
//!   `<userData>/schedules.json` + `schedule-runs.json` (DataStore-backed, ≤50
//!   runs/task).
//! - **Runtime** — one `cron::Schedule` job per task (the TS side used
//!   croner's "5-or-6-parts" — verified against the `cron` crate's parsing
//!   during the port), per-task lifecycle serialization, global enable gate,
//!   workspace-blocked set, `advanceBeforeRun` crash-safe claim of the next
//!   run.
//! - **Execution** — LLM tasks run a background generation with a synthetic
//!   owner; script tasks run files from `~/.aiden/scripts/`; macOS
//!   notifications with click-to-open-chat deep links.
//! - **Fingerprint binding** — provider/MCP connection fingerprints captured at
//!   save time and asserted at run time.
//!
//! The task record shape is part of the on-disk contract, so it is defined now.

use serde::{Deserialize, Serialize};

/// A saved scheduled task (schedules.json entry).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(rename = "mode")]
    pub mode: TaskMode,
    /// croner "5-or-6-parts" expression, e.g. "0 9 * * *".
    pub cron: String,
    /// IANA timezone name.
    pub timezone: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Filename under `~/.aiden/scripts` for script mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(rename = "permission")]
    pub permission: TaskPermission,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_server_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    pub notify: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_result: Option<TaskResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskMode {
    Llm,
    Script,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskPermission {
    ReadOnly,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskResult {
    Success,
    Error,
    Silent,
    Blocked,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_task_roundtrips() {
        let task = ScheduledTask {
            id: "task-1".into(),
            name: "nightly summary".into(),
            enabled: true,
            mode: TaskMode::Llm,
            cron: "0 9 * * *".into(),
            timezone: "UTC".into(),
            next_run_at: Some(1_700_000_000_000),
            last_run_at: None,
            workspace_id: Some("w1".into()),
            provider_id: Some("anthropic".into()),
            model: Some("claude-sonnet-5".into()),
            prompt: Some("Summarize yesterday".into()),
            script: None,
            permission: TaskPermission::ReadOnly,
            mcp_server_ids: None,
            chat_id: None,
            notify: true,
            last_result: Some(TaskResult::Success),
            last_error: None,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
        };
        let json = serde_json::to_value(&task).unwrap();
        assert_eq!(json["mode"], "llm");
        assert_eq!(json["permission"], "read-only");
        assert_eq!(json["nextRunAt"], 1_700_000_000_000i64);
        let back: ScheduledTask = serde_json::from_value(json).unwrap();
        assert_eq!(back, task);
    }
}
