//! The assistant's tool surface (the runner's `ToolExecutor`).
//!
//! Assembles the attended-dock tool set per `resolve_automation_tool_plan`
//! (`AgentToolMode::Assistant`): the identity tools (`list_mcp_servers`,
//! `list_projects`), the scheduling tools (`schedule_task` /
//! `edit_automation` / `list_scheduled_tasks`), and the enabled MCP connector
//! tools collected through [`crate::services::mcp_tools::collect_chat_mcp_tools`]
//! on the shared [`aiden_mcp::McpClientManager`]. Store-backed lister/schedule
//! adapters run on the background agent thread, never the GPUI foreground.
//!
//! `schedule_task` / `edit_automation` are the automation proposals: the
//! approval bridge gates them, and only an approved call reaches `execute`,
//! which persists through the [`ScheduleSource`]. All argument validation is
//! pure and unit-tested.

use std::sync::Arc;
use std::time::Duration;

use aiden_agent::mcp_tool::{AssistantMcpServerTool, McpServerRecord};
use aiden_agent::project_tool::{AssistantProjectTool, WorkspaceRecord};
use aiden_agent::runner::{ToolExecutionError, ToolExecutor, ToolOutput};
use aiden_core::ToolCall;
use aiden_core::ToolDef;
use aiden_data::config_store::ConfigStore;
use aiden_data::portable_config::McpServer;
use aiden_data::schedule_store::{
    next_scheduled_run, DataStorePersistence, ScheduledTask, ScheduledTaskInput,
    ScheduledTaskPermission,
};
use aiden_scheduler::runtime::SchedulerCore;
use async_trait::async_trait;

use crate::services::mcp_tools::{collect_chat_mcp_tools, ChatMcpTools, McpStreamContext};

/// The assistant's scheduling tool names (aligns with the system-prompt
/// handbook and the automation approval surface).
pub const SCHEDULE_TASK_TOOL: &str = "schedule_task";
pub const EDIT_AUTOMATION_TOOL: &str = "edit_automation";
pub const LIST_SCHEDULED_TASKS_TOOL: &str = "list_scheduled_tasks";

/// Per-call timeout for MCP connector tools.
pub const ASSISTANT_MCP_CALL_TIMEOUT_MS: u64 = 60_000;

// ===========================================================================
// Store-backed adapters (background I/O only)
// ===========================================================================

/// `McpServerLister` over the config store's MCP server records.
pub struct StoreMcpServerLister(pub Arc<ConfigStore>);

#[async_trait]
impl aiden_agent::mcp_tool::McpServerLister for StoreMcpServerLister {
    async fn list_mcp_servers(&self) -> Vec<McpServerRecord> {
        self.0
            .list_mcp_servers()
            .unwrap_or_default()
            .into_iter()
            .map(|server| McpServerRecord {
                id: server.id,
                name: server.name,
                enabled: server.enabled,
            })
            .collect()
    }
}

fn map_workspace_permission(
    permission: aiden_data::portable_config::WorkspacePermission,
) -> aiden_agent::automation::WorkspacePermission {
    match permission {
        aiden_data::portable_config::WorkspacePermission::Full => {
            aiden_agent::automation::WorkspacePermission::Full
        }
        aiden_data::portable_config::WorkspacePermission::Ask => {
            aiden_agent::automation::WorkspacePermission::Ask
        }
        aiden_data::portable_config::WorkspacePermission::None => {
            aiden_agent::automation::WorkspacePermission::None
        }
    }
}

/// `WorkspaceLister` over the config store's workspaces.
pub struct StoreWorkspaceLister(pub Arc<ConfigStore>);

#[async_trait]
impl aiden_agent::project_tool::WorkspaceLister for StoreWorkspaceLister {
    async fn list_workspaces(&self) -> Vec<WorkspaceRecord> {
        self.0
            .list_workspaces()
            .unwrap_or_default()
            .into_iter()
            .map(|workspace| WorkspaceRecord {
                id: workspace.id,
                name: workspace.name,
                folder_path: workspace.folder_path,
                permission: map_workspace_permission(workspace.permission),
            })
            .collect()
    }
}

/// The scheduling lifecycle surface the executor drives.
#[async_trait]
pub trait ScheduleSource: Send + Sync {
    fn list(&self) -> Vec<ScheduledTask>;
    /// Upsert by input id (`None` creates a new task).
    async fn save(
        &self,
        input: &ScheduledTaskInput,
        expected_updated_at: Option<u64>,
    ) -> Result<ScheduledTask, String>;
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "reserved for the existing approval-gated removal lifecycle; not exposed while execution is unsupported"
        )
    )]
    async fn remove(&self, id: &str) -> Result<(), String>;
}

/// [`ScheduleSource`] over the app's shared scheduler authority.
pub struct StoreScheduleSource(pub Arc<SchedulerCore<DataStorePersistence, DataStorePersistence>>);

#[async_trait]
impl ScheduleSource for StoreScheduleSource {
    fn list(&self) -> Vec<ScheduledTask> {
        self.0.store().list().unwrap_or_default()
    }

    async fn save(
        &self,
        input: &ScheduledTaskInput,
        expected_updated_at: Option<u64>,
    ) -> Result<ScheduledTask, String> {
        let cancellation = tokio_util::sync::CancellationToken::new();
        self.0
            .save(input, expected_updated_at, &cancellation)
            .await
            .map_err(|error| error.to_string())
    }

    async fn remove(&self, id: &str) -> Result<(), String> {
        self.0.remove(id).await.map_err(|error| error.to_string())
    }
}

// ===========================================================================
// Pure scheduling-tool logic
// ===========================================================================

/// Validate + shape one `schedule_task` / `edit_automation` call into the
/// store input. `now` drives `nextRunAt` for deterministic tests. Returns a
/// renderer-safe error message on malformed proposals (the model sees it as a
/// failed tool result and must re-issue).
pub fn parse_schedule_input(call: &ToolCall, now: u64) -> Result<ScheduledTaskInput, String> {
    let args = call
        .arguments
        .as_object()
        .ok_or_else(|| "Arguments must be a JSON object.".to_string())?;
    let required = |key: &str| -> Result<String, String> {
        args.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("Missing string argument \"{key}\"."))
    };
    let name = required("name")?;
    let prompt = required("prompt")?;
    let cron = required("cron")?;
    let timezone = required("timezone")?;
    aiden_data::schedule_store::validate_timezone(&timezone)
        .map_err(|error| format!("Invalid timezone \"{timezone}\": {error}"))?;
    next_scheduled_run(&cron, &timezone, now)
        .map_err(|error| format!("Invalid cron \"{cron}\": {error}"))?;

    let permission = match args.get("permission").and_then(serde_json::Value::as_str) {
        Some("read-only") => ScheduledTaskPermission::ReadOnly,
        Some("full") => ScheduledTaskPermission::Full,
        _ => ScheduledTaskPermission::ReadOnly,
    };
    let workspace_id = args.get("workspaceId").and_then(serde_json::Value::as_str);
    let mcp_server_ids = args
        .get("mcpServerIds")
        .and_then(serde_json::Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    let provider_id = required("providerId")?;
    let model = required("model")?;

    let id = if call.name == EDIT_AUTOMATION_TOOL {
        if args
            .get("expectedUpdatedAt")
            .and_then(serde_json::Value::as_u64)
            .is_none()
        {
            return Err(
                "expectedUpdatedAt is required and must come from list_scheduled_tasks."
                    .to_string(),
            );
        }
        Some(required("taskId")?)
    } else {
        None
    };
    let enabled = if call.name == SCHEDULE_TASK_TOOL {
        Some(false)
    } else {
        args.get("enabled").and_then(serde_json::Value::as_bool)
    };

    Ok(ScheduledTaskInput {
        id,
        name,
        enabled,
        mode: aiden_data::schedule_store::ScheduledTaskMode::Llm,
        cron,
        timezone: Some(timezone),
        workspace_id: workspace_id.map(str::to_string),
        provider_id: Some(provider_id),
        model: Some(model),
        provider_fingerprint: None,
        prompt: Some(prompt),
        script: None,
        permission: Some(permission),
        mcp_server_ids,
        mcp_server_bindings: None,
        execution_profile: None,
        notify: Some(
            args.get("notify")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
        ),
    })
}

fn task_json(task: &ScheduledTask) -> serde_json::Value {
    serde_json::json!({
        "id": task.id,
        "name": task.name,
        "enabled": task.enabled,
        "cron": task.cron,
        "timezone": task.timezone,
        "nextRunAt": task.next_run_at,
        "updatedAt": task.updated_at,
        "executionStatus": "unsupported",
        "permission": match task.permission {
            ScheduledTaskPermission::ReadOnly => "read-only",
            ScheduledTaskPermission::Full => "full",
        },
    })
}

// ===========================================================================
// The executor
// ===========================================================================

/// The assembled assistant tool surface for one run. Cheap to rebuild per run
/// with a fresh MCP inventory snapshot.
pub struct AssistantToolExecutor {
    identity: AssistantMcpServerTool,
    projects: AssistantProjectTool,
    mcp: Arc<aiden_mcp::McpClientManager>,
    mcp_tools: ChatMcpTools,
    schedule: Arc<dyn ScheduleSource>,
    mcp_timeout: Duration,
}

impl AssistantToolExecutor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        lister: Arc<dyn aiden_agent::mcp_tool::McpServerLister>,
        projects: Arc<dyn aiden_agent::project_tool::WorkspaceLister>,
        mcp: Arc<aiden_mcp::McpClientManager>,
        mcp_tools: ChatMcpTools,
        schedule: Arc<dyn ScheduleSource>,
    ) -> Self {
        Self {
            identity: AssistantMcpServerTool::new(lister),
            projects: AssistantProjectTool::new(projects),
            mcp,
            mcp_tools,
            schedule,
            mcp_timeout: Duration::from_millis(ASSISTANT_MCP_CALL_TIMEOUT_MS),
        }
    }

    fn scheduling_defs() -> Vec<ToolDef> {
        vec![
            ToolDef {
                name: SCHEDULE_TASK_TOOL.to_string(),
                description: "Propose one dormant LLM automation. Scheduled execution is currently unsupported, so a saved proposal remains disabled. The user must confirm the proposal; never claim it is active or will run. Pass an exact project ID from list_projects as workspaceId and exact server IDs from list_mcp_servers as mcpServerIds.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Short display name." },
                        "prompt": { "type": "string", "description": "The unattended instruction." },
                        "cron": { "type": "string", "description": "5-field cron in `timezone`." },
                        "timezone": { "type": "string", "description": "IANA timezone." },
                        "permission": { "type": "string", "enum": ["read-only", "full"] },
                        "workspaceId": { "type": "string", "description": "Exact project ID." },
                        "mcpServerIds": { "type": "array", "items": { "type": "string" } },
                        "providerId": { "type": "string" },
                        "model": { "type": "string" },
                        "notify": { "type": "boolean" }
                    },
                    "required": ["name", "prompt", "cron", "timezone", "providerId", "model"],
                    "additionalProperties": false,
                }),
            },
            ToolDef {
                name: EDIT_AUTOMATION_TOOL.to_string(),
                description: "Change one exact existing automation. The user must confirm the edit; never claim it was saved until the tool result confirms it.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "taskId": { "type": "string", "description": "Exact task id from list_scheduled_tasks." },
                        "name": { "type": "string" },
                        "prompt": { "type": "string" },
                        "cron": { "type": "string" },
                        "timezone": { "type": "string" },
                        "enabled": { "type": "boolean" },
                        "permission": { "type": "string", "enum": ["read-only", "full"] },
                        "workspaceId": { "type": "string" },
                        "mcpServerIds": { "type": "array", "items": { "type": "string" } },
                        "providerId": { "type": "string" },
                        "model": { "type": "string" },
                        "expectedUpdatedAt": { "type": "integer", "minimum": 0 }
                    },
                    "required": ["taskId", "expectedUpdatedAt"],
                    "additionalProperties": false,
                }),
            },
            ToolDef {
                name: LIST_SCHEDULED_TASKS_TOOL.to_string(),
                description: "List saved automations before editing one. Returns exact task ids.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false,
                }),
            },
        ]
    }

    /// The full provider-facing tool surface (identity + scheduling + MCP).
    pub fn tool_defs(&self) -> Vec<ToolDef> {
        let mut defs = vec![self.identity.tool_def(), self.projects.tool_def()];
        defs.extend(Self::scheduling_defs());
        defs.extend(self.mcp_tools.defs.clone());
        defs
    }

    /// Remove a saved automation through the same lifecycle authority. This
    /// is intentionally not exposed as an Assistant tool while scheduled
    /// execution is unsupported.
    #[expect(
        dead_code,
        reason = "keeps removal on the shared authority without advertising a dormant Assistant tool"
    )]
    pub async fn remove_schedule(&self, id: &str) -> Result<(), ToolExecutionError> {
        self.schedule
            .remove(id)
            .await
            .map_err(ToolExecutionError::Message)
    }

    async fn list_scheduled_tasks(&self) -> Result<ToolOutput, ToolExecutionError> {
        let tasks = self.schedule.list();
        let payload = serde_json::json!({
            "status": "ok",
            "tasks": tasks.iter().map(task_json).collect::<Vec<_>>(),
        });
        Ok(ToolOutput::text(
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()),
        ))
    }

    async fn create_automation(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let input = parse_schedule_input(call, aiden_data::now_millis())
            .map_err(ToolExecutionError::Message)?;
        let task = self
            .schedule
            .save(&input, None)
            .await
            .map_err(ToolExecutionError::Message)?;
        let payload = serde_json::json!({
            "status": "created",
            "schedulerEnabled": false,
            "task": task_json(&task),
        });
        Ok(ToolOutput::text(
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()),
        ))
    }

    async fn edit_automation(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        let input = parse_schedule_input(call, aiden_data::now_millis())
            .map_err(ToolExecutionError::Message)?;
        let expected_updated_at = call
            .arguments
            .get("expectedUpdatedAt")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                ToolExecutionError::Message(
                    "expectedUpdatedAt is required and must come from list_scheduled_tasks."
                        .to_string(),
                )
            })?;
        let task = self
            .schedule
            .save(&input, Some(expected_updated_at))
            .await
            .map_err(ToolExecutionError::Message)?;
        let payload = serde_json::json!({
            "status": "updated",
            "schedulerEnabled": false,
            "task": task_json(&task),
        });
        Ok(ToolOutput::text(
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()),
        ))
    }
}

#[async_trait]
impl ToolExecutor for AssistantToolExecutor {
    fn tool_defs(&self) -> Vec<ToolDef> {
        self.tool_defs()
    }

    fn requires_approval(&self, tool_name: &str) -> bool {
        crate::approvals::approval_bridge::bridge_requires_approval(tool_name)
    }

    async fn execute(&self, call: &ToolCall) -> Result<ToolOutput, ToolExecutionError> {
        match call.name.as_str() {
            "list_mcp_servers" => self.identity.run(call).await,
            "list_projects" => self.projects.run(call).await,
            LIST_SCHEDULED_TASKS_TOOL => self.list_scheduled_tasks().await,
            SCHEDULE_TASK_TOOL => self.create_automation(call).await,
            EDIT_AUTOMATION_TOOL => self.edit_automation(call).await,
            name => match self.mcp_tools.dispatch.get(name) {
                Some(target) => {
                    let result = self
                        .mcp
                        .call_tool(
                            &target.server_id,
                            &target.tool_name,
                            call.arguments.clone(),
                            self.mcp_timeout,
                        )
                        .await
                        .map_err(|error| ToolExecutionError::Message(error.to_string()))?;
                    Ok(ToolOutput::text(result.text))
                }
                None => Err(ToolExecutionError::NotFound(call.name.clone())),
            },
        }
    }
}

/// Collect the MCP connector surface for the assistant: the bounded tool defs
/// and dispatch map over the enabled servers (skipping unreachable servers,
/// never failing the panel open or the run).
///
/// Mirrors the chat driver's collection with the assistant's call timeout.
pub async fn collect_assistant_mcp_tools(context: &McpStreamContext) -> ChatMcpTools {
    collect_chat_mcp_tools(&context.manager, &context.servers, &context.preset_key).await
}

/// The enabled MCP servers from the config store (the inventory the assistant
/// collects).
pub fn enabled_mcp_servers(config: &Arc<ConfigStore>) -> Vec<McpServer> {
    config
        .list_mcp_servers()
        .unwrap_or_default()
        .into_iter()
        .filter(|server| server.enabled)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::schedule_store::create_schedule_store;

    struct FakeMcpLister;
    #[async_trait]
    impl aiden_agent::mcp_tool::McpServerLister for FakeMcpLister {
        async fn list_mcp_servers(&self) -> Vec<McpServerRecord> {
            Vec::new()
        }
    }

    struct FakeWorkspaceLister;
    #[async_trait]
    impl aiden_agent::project_tool::WorkspaceLister for FakeWorkspaceLister {
        async fn list_workspaces(&self) -> Vec<WorkspaceRecord> {
            Vec::new()
        }
    }

    struct NoopScheduleSource;

    #[async_trait]
    impl ScheduleSource for NoopScheduleSource {
        fn list(&self) -> Vec<ScheduledTask> {
            Vec::new()
        }

        async fn save(
            &self,
            _input: &ScheduledTaskInput,
            _expected_updated_at: Option<u64>,
        ) -> Result<ScheduledTask, String> {
            Err("noop".to_string())
        }

        async fn remove(&self, _id: &str) -> Result<(), String> {
            Err("noop".to_string())
        }
    }

    fn executor() -> AssistantToolExecutor {
        AssistantToolExecutor::new(
            Arc::new(FakeMcpLister),
            Arc::new(FakeWorkspaceLister),
            Arc::new(aiden_mcp::McpClientManager::new()),
            ChatMcpTools::default(),
            Arc::new(NoopScheduleSource),
        )
    }

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call-1".to_string(),
            name: name.to_string(),
            arguments: args,
            thought_signature: None,
        }
    }

    #[test]
    fn schedule_input_validates_and_shapes_a_proposal() {
        let input = parse_schedule_input(
            &call(
                "schedule_task",
                serde_json::json!({
                    "name": "Morning brief",
                    "prompt": "Summarize updates.",
                    "cron": "0 9 * * *",
                    "timezone": "America/New_York",
                    "permission": "full",
                    "workspaceId": "w-1",
                    "providerId": "local-provider",
                    "model": "local-model",
                    "notify": false,
                }),
            ),
            1_700_000_000_000,
        )
        .expect("valid proposal");
        assert_eq!(input.name, "Morning brief");
        assert_eq!(input.cron, "0 9 * * *");
        assert_eq!(input.workspace_id.as_deref(), Some("w-1"));
        assert_eq!(input.permission, Some(ScheduledTaskPermission::Full));
        assert_eq!(input.notify, Some(false));
        assert_eq!(input.enabled, Some(false));
        assert!(input.id.is_none());
    }

    #[test]
    fn schedule_input_rejects_bad_cron_timezone_and_missing_fields() {
        let base = |args: serde_json::Value| call("schedule_task", args);
        // Bad cron.
        assert!(parse_schedule_input(
            &base(serde_json::json!({
                "name": "x",
                "prompt": "y",
                "cron": "not-a-cron",
                "timezone": "UTC",
                "providerId": "p",
                "model": "m",
            })),
            1_700_000_000_000,
        )
        .is_err());
        // Unknown timezone.
        assert!(parse_schedule_input(
            &base(serde_json::json!({
                "name": "x",
                "prompt": "y",
                "cron": "0 9 * * *",
                "timezone": "Not/AZone",
                "providerId": "p",
                "model": "m",
            })),
            1_700_000_000_000,
        )
        .is_err());
        // Missing provider/model.
        assert!(parse_schedule_input(
            &base(serde_json::json!({
                "name": "x",
                "prompt": "y",
                "cron": "0 9 * * *",
                "timezone": "UTC",
            })),
            1_700_000_000_000,
        )
        .is_err());
    }

    #[test]
    fn edit_input_requires_a_task_id_and_carries_enabled() {
        let input = parse_schedule_input(
            &call(
                "edit_automation",
                serde_json::json!({
                    "taskId": "task-1",
                    "name": "Morning brief",
                    "prompt": "Updated.",
                    "cron": "30 7 * * *",
                    "timezone": "UTC",
                    "expectedUpdatedAt": 42,
                    "enabled": false,
                    "providerId": "p",
                    "model": "m",
                }),
            ),
            1_700_000_000_000,
        )
        .expect("valid edit");
        assert_eq!(input.id.as_deref(), Some("task-1"));
        assert_eq!(input.enabled, Some(false));
        // Without a task id the edit is malformed.
        assert!(parse_schedule_input(
            &call(
                "edit_automation",
                serde_json::json!({
                    "name": "x",
                    "prompt": "y",
                    "cron": "0 9 * * *",
                    "timezone": "UTC",
                    "providerId": "p",
                    "model": "m",
                }),
            ),
            1_700_000_000_000,
        )
        .is_err());
    }

    #[test]
    fn executor_surfaces_identity_scheduling_and_mcp_defs() {
        let executor = executor();
        let names: Vec<String> = executor
            .tool_defs()
            .iter()
            .map(|def| def.name.clone())
            .collect();
        assert!(names.contains(&"list_mcp_servers".to_string()));
        assert!(names.contains(&"list_projects".to_string()));
        assert!(names.contains(&SCHEDULE_TASK_TOOL.to_string()));
        assert!(names.contains(&EDIT_AUTOMATION_TOOL.to_string()));
        assert!(names.contains(&LIST_SCHEDULED_TASKS_TOOL.to_string()));
        // Gated surface mirrors the bridge.
        assert!(executor.requires_approval(SCHEDULE_TASK_TOOL));
        assert!(executor.requires_approval("write_file"));
        assert!(!executor.requires_approval("list_projects"));
    }

    #[tokio::test]
    async fn unknown_tools_resolve_to_not_found_without_panicking() {
        let executor = executor();
        let outcome = executor.execute(&call("nope", serde_json::json!({}))).await;
        assert_eq!(
            outcome,
            Err(ToolExecutionError::NotFound("nope".to_string()))
        );
    }

    #[tokio::test]
    async fn assistant_and_settings_share_revision_checked_schedule_authority() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(create_schedule_store(
            DataStorePersistence::new("schedules.json", Some(directory.path().to_path_buf())),
            DataStorePersistence::new("schedule-runs.json", Some(directory.path().to_path_buf())),
            Box::new(aiden_data::now_millis),
            None,
        ));
        let scheduler = aiden_scheduler::runtime::create_scheduler(
            store,
            Arc::new(crate::services::stores::DisabledTaskExecutor),
            None,
            Box::new(aiden_data::now_millis),
        );
        let assistant = StoreScheduleSource(scheduler.clone());
        let input = ScheduledTaskInput {
            name: "Dormant task".to_string(),
            enabled: Some(false),
            mode: aiden_data::schedule_store::ScheduledTaskMode::Llm,
            cron: "0 9 * * *".to_string(),
            timezone: Some("UTC".to_string()),
            provider_id: Some("provider".to_string()),
            model: Some("model".to_string()),
            prompt: Some("Summarize updates.".to_string()),
            permission: Some(ScheduledTaskPermission::ReadOnly),
            ..ScheduledTaskInput::default()
        };
        let created = assistant.save(&input, None).await.unwrap();
        let mut settings_edit = input.clone();
        settings_edit.id = Some(created.id.clone());
        settings_edit.name = "Settings edit".to_string();
        let cancellation = tokio_util::sync::CancellationToken::new();
        scheduler
            .save(&settings_edit, Some(created.updated_at), &cancellation)
            .await
            .unwrap();

        let stale = assistant
            .save(&settings_edit, Some(created.updated_at))
            .await;

        assert!(stale
            .unwrap_err()
            .contains("changed before the edit was saved"));
        assistant.remove(&created.id).await.unwrap();
        assert!(scheduler.store().get(&created.id).unwrap().is_none());
    }
}
