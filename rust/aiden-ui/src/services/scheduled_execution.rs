//! Production scheduled-task execution owned by [`Stores`](super::stores::Stores).
//!
//! The executor never consults the mutable chat picker. Every LLM run uses the
//! provider, model, credential, workspace, and MCP bindings persisted on the
//! task. Workspace prompts are intentionally plain-provider turns: the native
//! headless driver has no Electron-equivalent coding-tool registry, so it does
//! not advertise or dispatch filesystem/shell tools. Script mode is the only
//! scheduled path that mutates a workspace.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use aiden_core::ChatRole;
use aiden_data::chat_store::{AppendMessageMeta, ChatMessageInput, ChatStore, ChatStoreInput};
use aiden_data::config_store::ConfigStore;
use aiden_data::portable_config::{ProviderDeployment, WorkspacePermission};
use aiden_data::schedule_store::{
    assert_assistant_schedule_execution_boundary, DataStorePersistence, ScheduleStore,
    ScheduledRunResult, ScheduledTask, ScheduledTaskExecutionBoundary, ScheduledTaskMode,
    ScheduledTaskPermission,
};
use aiden_data::usage_store::{UsageRequestSource, UsageRequestStatus, UsageStore};
use aiden_mcp::McpClientManager;
use aiden_scheduler::binding::{
    assert_scheduled_mcp_server_bindings, assert_scheduled_provider_fingerprint,
    McpServer as BindingMcpServer, StoredProviderLike,
};
use aiden_scheduler::runtime::{TaskExecutor, TaskRunError, TaskRunOutcome};
use aiden_scheduler::script::{
    resolve_scheduled_script, run_scheduled_script_with_cancel, SCRIPT_OUTPUT_LIMIT,
    SCRIPT_TIMEOUT_MS,
};
use async_trait::async_trait;
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::services::codex_auth::PiCodexAuthStore;
use crate::services::mcp_mutation::McpMutationAuthority;
use crate::services::mcp_tools::McpStreamContext;
use crate::services::provider_kit::{
    chat_history_to_messages, drive_stream, enrich_provider, load_capabilities, resolve_api_key,
    ConfiguredProvider, ModelSelection, StreamMsg, TurnSnapshot,
};
use crate::services::stream::{chat_usage_record, zero_usage};

const STORED_OUTPUT_LIMIT: usize = 64 * 1024;
const STORED_ERROR_LIMIT: usize = 4 * 1024;
pub const SCHEDULED_TASKS_ENABLED_KEY: &str = "scheduledTasksEnabled";

pub fn global_enabled(config: &ConfigStore) -> bool {
    config
        .get_settings()
        .ok()
        .and_then(|settings| settings.get(SCHEDULED_TASKS_ENABLED_KEY).cloned())
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

#[derive(Clone)]
struct ActiveRun {
    cancellation: CancellationToken,
    provider_cancel: Arc<AtomicBool>,
}

/// App-owned executor shared by automatic dispatch, Run Now, Settings, and
/// Assistant-created tasks.
pub struct ProductionScheduledExecutor {
    config: Arc<ConfigStore>,
    schedules: Arc<ScheduleStore<DataStorePersistence, DataStorePersistence>>,
    chats: Arc<ChatStore>,
    usage: Arc<UsageStore>,
    codex_auth: Arc<PiCodexAuthStore>,
    mcp: Arc<McpClientManager>,
    mcp_authority: Arc<McpMutationAuthority>,
    active: Mutex<HashMap<String, ActiveRun>>,
}

impl ProductionScheduledExecutor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<ConfigStore>,
        schedules: Arc<ScheduleStore<DataStorePersistence, DataStorePersistence>>,
        chats: Arc<ChatStore>,
        usage: Arc<UsageStore>,
        codex_auth: Arc<PiCodexAuthStore>,
        mcp: Arc<McpClientManager>,
        mcp_authority: Arc<McpMutationAuthority>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            schedules,
            chats,
            usage,
            codex_auth,
            mcp,
            mcp_authority,
            active: Mutex::new(HashMap::new()),
        })
    }

    /// Construction is synchronous and has no network or permission side
    /// effects. Individual task dependencies remain exact run-time gates.
    pub fn is_ready(&self) -> bool {
        true
    }

    fn begin(&self, task_id: &str) -> Result<ActiveRun, TaskRunError> {
        let run = ActiveRun {
            cancellation: CancellationToken::new(),
            provider_cancel: Arc::new(AtomicBool::new(false)),
        };
        {
            let mut active = self.active.lock();
            if active.contains_key(task_id) {
                return Err(TaskRunError(
                    "This scheduled task already has an active executor.".into(),
                ));
            }
            active.insert(task_id.to_string(), run.clone());
        }
        Ok(run)
    }

    fn finish(&self, task_id: &str) {
        self.active.lock().remove(task_id);
    }

    fn ensure_chat(&self, task: &ScheduledTask) -> Result<String, TaskRunError> {
        self.schedules
            .ensure_chat_id(&task.id, &|| {
                self.chats
                    .create(ChatStoreInput {
                        title: Some(&task.name),
                        workspace_id: task.workspace_id.as_deref(),
                        provider_id: task.provider_id.as_deref(),
                        model: task.model.as_deref(),
                    })
                    .map(|chat| chat.id)
                    .map_err(|error| {
                        aiden_data::schedule_store::ScheduleError::Store(
                            aiden_data::DataStoreError::Io(std::io::Error::other(
                                error.to_string(),
                            )),
                        )
                    })
            })
            .map_err(|_| TaskRunError("Could not create the scheduled task's chat.".into()))
    }

    fn workspace(
        &self,
        task: &ScheduledTask,
    ) -> Result<Option<aiden_data::portable_config::Workspace>, TaskRunError> {
        let Some(id) = task.workspace_id.as_deref() else {
            return Ok(None);
        };
        let workspace = self
            .config
            .get_workspace(id)
            .map_err(|_| TaskRunError("The task workspace could not be read.".into()))?
            .ok_or_else(|| TaskRunError("The task workspace no longer exists.".into()))?;
        if workspace.permission == WorkspacePermission::None {
            return Err(TaskRunError("The task workspace has No Access.".into()));
        }
        Ok(Some(workspace))
    }

    async fn assert_managed_worktree(
        &self,
        workspace: Option<&aiden_data::portable_config::Workspace>,
    ) -> Result<(), TaskRunError> {
        let Some(workspace) = workspace else {
            return Ok(());
        };
        let Some(managed) = workspace.managed_worktree.as_ref() else {
            return Ok(());
        };
        let service = aiden_git::GitService::new(aiden_git::GitServiceOptions::default());
        let usable = aiden_git::worktree::managed_worktree_usable(
            &service,
            std::path::Path::new(&managed.repository_path),
            &managed.worktree_path,
            &managed.branch,
            managed.worktree_git_dir.as_deref(),
            managed.ownership_token.as_deref(),
            managed.worktree_device,
            managed.worktree_inode,
            None,
        )
        .await
        .map_err(|_| TaskRunError("The task's managed worktree could not be verified.".into()))?;
        if !usable {
            return Err(TaskRunError(
                "The task's managed worktree is no longer owned by Aiden.".into(),
            ));
        }
        Ok(())
    }

    async fn run_script(
        &self,
        task: &ScheduledTask,
        run: &ActiveRun,
        chat_id: String,
    ) -> Result<TaskRunOutcome, TaskRunError> {
        if task.permission != ScheduledTaskPermission::Full {
            return Err(TaskRunError("Script tasks require Full permission.".into()));
        }
        let workspace = self.workspace(task)?;
        self.assert_managed_worktree(workspace.as_ref()).await?;
        if workspace
            .as_ref()
            .is_some_and(|value| value.permission != WorkspacePermission::Full)
        {
            return Err(TaskRunError(
                "The task workspace is not authorized for unattended Full access.".into(),
            ));
        }
        let workspace_root = workspace
            .as_ref()
            .and_then(|workspace| workspace.folder_path.as_deref())
            .map(PathBuf::from);
        let script = resolve_scheduled_script(
            task.script.as_deref().unwrap_or_default(),
            workspace_root.as_deref(),
            None,
        )
        .await
        .map_err(|error| TaskRunError(error.to_string()))?;
        let cwd = workspace_root
            .as_deref()
            .or_else(|| script.parent())
            .ok_or_else(|| TaskRunError("The scheduled script has no working directory.".into()))?;
        let result = run_scheduled_script_with_cancel(
            &script,
            cwd,
            Some(SCRIPT_TIMEOUT_MS),
            Some(SCRIPT_OUTPUT_LIMIT),
            run.cancellation.clone(),
        )
        .await
        .map_err(|error| TaskRunError(error.to_string()))?;
        let output = bounded(&result.stdout, STORED_OUTPUT_LIMIT);
        let (run_result, error) = if result.cancelled {
            (
                ScheduledRunResult::Blocked,
                Some("Scheduled task was cancelled.".into()),
            )
        } else if result.timed_out {
            (
                ScheduledRunResult::Error,
                Some("Script timed out after 60 seconds.".into()),
            )
        } else if result.output_limit_exceeded {
            (
                ScheduledRunResult::Error,
                Some("Script exceeded the 1 MB output limit.".into()),
            )
        } else if result.exit_code != Some(0) {
            let detail = if result.stderr.trim().is_empty() {
                format!("Process exited with code {:?}.", result.exit_code)
            } else {
                bounded(result.stderr.trim(), STORED_ERROR_LIMIT)
            };
            (ScheduledRunResult::Error, Some(detail))
        } else if output.trim().is_empty() {
            (ScheduledRunResult::Silent, None)
        } else {
            (ScheduledRunResult::Success, None)
        };
        self.append_assistant(&chat_id, error.as_deref().unwrap_or(&output), task)?;
        Ok(TaskRunOutcome {
            result: run_result,
            output,
            error,
            chat_id: Some(chat_id),
        })
    }

    async fn run_llm(
        &self,
        task: &ScheduledTask,
        run: &ActiveRun,
        chat_id: String,
    ) -> Result<TaskRunOutcome, TaskRunError> {
        assert_assistant_schedule_execution_boundary(&ScheduledTaskExecutionBoundary::from(task))
            .map_err(|error| TaskRunError(error.to_string()))?;
        let workspace = self.workspace(task)?;
        self.assert_managed_worktree(workspace.as_ref()).await?;
        if task.permission == ScheduledTaskPermission::Full && workspace.is_some() {
            return Err(TaskRunError(
                "Full project automations are unavailable because native scheduled prompts do not expose filesystem or shell tools."
                    .into(),
            ));
        }
        let provider_id = task
            .provider_id
            .as_deref()
            .ok_or_else(|| TaskRunError("Choose a provider for this scheduled task.".into()))?;
        let model = task
            .model
            .as_deref()
            .ok_or_else(|| TaskRunError("Choose a model for this scheduled task.".into()))?;
        let stored = self
            .config
            .get_provider(provider_id)
            .map_err(|_| TaskRunError("The task provider could not be read.".into()))?
            .ok_or_else(|| TaskRunError("The task provider no longer exists.".into()))?;
        if !stored.models.iter().any(|candidate| candidate == model) {
            return Err(TaskRunError(
                "The selected scheduled model is unavailable.".into(),
            ));
        }
        let binding = provider_binding_for_schedule(&stored);
        assert_scheduled_provider_fingerprint(&binding, task.provider_fingerprint.as_deref())
            .map_err(|error| TaskRunError(error.to_string()))?;
        let row = self
            .config
            .list_providers()
            .map_err(|_| TaskRunError("The task provider could not be read.".into()))?
            .into_iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| TaskRunError("The task provider no longer exists.".into()))?;
        let mut provider = ConfiguredProvider::from(&row);
        let catalog = load_capabilities();
        if let Some(catalog) = catalog.as_deref() {
            provider = enrich_provider(provider, catalog);
        }
        let api_key = resolve_api_key(&self.config, &provider);
        if api_key.is_none() {
            return Err(TaskRunError(
                "The scheduled provider needs authentication.".into(),
            ));
        }
        let mcp = self.scheduled_mcp(task).await?;
        let prompt = task.prompt.as_deref().unwrap_or_default().trim();
        self.append_user(&chat_id, prompt, task)?;
        let chat = self
            .chats
            .get(&chat_id)
            .map_err(|_| TaskRunError("The scheduled task chat could not be read.".into()))?
            .ok_or_else(|| TaskRunError("The scheduled task chat no longer exists.".into()))?;
        let snapshot = TurnSnapshot {
            messages: chat_history_to_messages(
                &chat.messages,
                model,
                provider_id,
                provider.api_family(),
            ),
            provider: provider.clone(),
            selection: ModelSelection {
                provider_id: provider_id.to_string(),
                model: model.to_string(),
            },
            catalog,
            mcp,
            skills: None,
            skill_invocation: None,
            computer_use: None,
            subagents: None,
            workspace,
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let driver = tokio::spawn(drive_stream(
            snapshot,
            api_key,
            self.codex_auth.clone(),
            run.provider_cancel.clone(),
            tx,
        ));
        let terminal = loop {
            match rx.recv().await {
                Some(StreamMsg::Done {
                    full_text,
                    full_thinking,
                    usage,
                    message,
                }) => {
                    break Ok((full_text, full_thinking, usage, Some(message)));
                }
                Some(StreamMsg::Error {
                    message: _, usage, ..
                }) => {
                    break Err(("Scheduled model request failed.".to_string(), usage, false));
                }
                Some(StreamMsg::Cancelled { usage, .. }) => {
                    break Err(("Scheduled task was cancelled.".to_string(), usage, true));
                }
                Some(_) => {}
                None => {
                    break Err((
                        "Scheduled model request ended unexpectedly.".into(),
                        zero_usage(),
                        false,
                    ))
                }
            }
        };
        let _ = driver.await;
        match terminal {
            Ok((text, thinking, usage, message)) => {
                if run.provider_cancel.load(Ordering::SeqCst) {
                    self.record_usage(&provider, model, UsageRequestStatus::Cancelled, &usage);
                    return Err(TaskRunError("Scheduled task was cancelled.".into()));
                }
                self.record_usage(&provider, model, UsageRequestStatus::Completed, &usage);
                self.append_assistant_message(
                    &chat_id,
                    &text,
                    &thinking,
                    task,
                    message.as_deref(),
                )?;
                let output = bounded(&text, STORED_OUTPUT_LIMIT);
                Ok(TaskRunOutcome {
                    result: if output.trim().is_empty() {
                        ScheduledRunResult::Silent
                    } else {
                        ScheduledRunResult::Success
                    },
                    output,
                    error: None,
                    chat_id: Some(chat_id),
                })
            }
            Err((error, usage, cancelled)) => {
                self.record_usage(
                    &provider,
                    model,
                    if cancelled {
                        UsageRequestStatus::Cancelled
                    } else {
                        UsageRequestStatus::Failed
                    },
                    &usage,
                );
                Err(TaskRunError(error))
            }
        }
    }

    async fn scheduled_mcp(
        &self,
        task: &ScheduledTask,
    ) -> Result<Option<McpStreamContext>, TaskRunError> {
        let ids = task.mcp_server_ids.as_deref().unwrap_or_default();
        if ids.is_empty() {
            return Ok(None);
        }
        if task.permission != ScheduledTaskPermission::Full {
            return Err(TaskRunError(
                "Scheduled MCP access requires Full permission.".into(),
            ));
        }
        let configured = self
            .config
            .list_mcp_servers()
            .map_err(|_| TaskRunError("Scheduled MCP configuration could not be read.".into()))?;
        let mut servers = Vec::with_capacity(ids.len());
        for id in ids {
            let server = configured
                .iter()
                .find(|server| &server.id == id && server.enabled)
                .cloned()
                .ok_or_else(|| TaskRunError("An approved MCP server is unavailable.".into()))?;
            servers.push(server);
        }
        let binding_servers = servers
            .iter()
            .map(|server| {
                serde_json::to_value(server).and_then(serde_json::from_value::<BindingMcpServer>)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| TaskRunError("An approved MCP server binding is invalid.".into()))?;
        assert_scheduled_mcp_server_bindings(
            &binding_servers,
            task.mcp_server_bindings.as_deref().unwrap_or_default(),
        )
        .map_err(|error| TaskRunError(error.to_string()))?;
        for server in &servers {
            self.mcp_authority
                .ensure_runtime_connected(server)
                .await
                .map_err(|_| TaskRunError("An approved MCP server could not connect.".into()))?;
        }
        Ok(Some(McpStreamContext {
            manager: self.mcp.clone(),
            authority: Some(self.mcp_authority.clone()),
            servers,
            preset_key: None,
        }))
    }

    fn append_user(
        &self,
        chat_id: &str,
        content: &str,
        task: &ScheduledTask,
    ) -> Result<(), TaskRunError> {
        self.append(chat_id, ChatRole::User, content, task, None, None)
    }

    fn append_assistant(
        &self,
        chat_id: &str,
        content: &str,
        task: &ScheduledTask,
    ) -> Result<(), TaskRunError> {
        self.append(chat_id, ChatRole::Assistant, content, task, None, None)
    }

    fn append_assistant_message(
        &self,
        chat_id: &str,
        text: &str,
        thinking: &str,
        task: &ScheduledTask,
        message: Option<&aiden_core::AssistantMessage>,
    ) -> Result<(), TaskRunError> {
        self.append(
            chat_id,
            ChatRole::Assistant,
            text,
            task,
            (!thinking.trim().is_empty()).then_some(thinking),
            message.and_then(|value| value.response_id.as_deref()),
        )
    }

    fn append(
        &self,
        chat_id: &str,
        role: ChatRole,
        content: &str,
        task: &ScheduledTask,
        reasoning: Option<&str>,
        id: Option<&str>,
    ) -> Result<(), TaskRunError> {
        self.chats
            .append_message(
                chat_id,
                ChatMessageInput {
                    id: id.map(str::to_string),
                    role,
                    content: content.to_string(),
                    model: task.model.clone(),
                    reasoning: reasoning.map(str::to_string),
                    attachments: None,
                    timeline: None,
                    subagents: None,
                    created_at: None,
                },
                Some(AppendMessageMeta {
                    provider_id: task.provider_id.as_deref(),
                    model: task.model.as_deref(),
                    auto_title: false,
                    expected_workspace_id: None,
                }),
            )
            .map(|_| ())
            .map_err(|_| TaskRunError("The scheduled task chat could not be updated.".into()))
    }

    fn record_usage(
        &self,
        provider: &ConfiguredProvider,
        model: &str,
        status: UsageRequestStatus,
        usage: &aiden_core::Usage,
    ) {
        let mut record = chat_usage_record(
            usage,
            &provider.id,
            &provider.label,
            model,
            model,
            provider.deployment == Some(ProviderDeployment::Local),
            status,
            aiden_data::now_millis(),
        );
        record.source = UsageRequestSource::Scheduled;
        let _ = self.usage.record(&record);
    }
}

#[async_trait]
impl TaskExecutor for ProductionScheduledExecutor {
    async fn run(&self, task: &ScheduledTask) -> Result<TaskRunOutcome, TaskRunError> {
        let active = self.begin(&task.id)?;
        let result = match self.ensure_chat(task) {
            Ok(chat_id) => match task.mode {
                ScheduledTaskMode::Script => self.run_script(task, &active, chat_id).await,
                ScheduledTaskMode::Llm => self.run_llm(task, &active, chat_id).await,
            },
            Err(error) => Err(error),
        };
        self.finish(&task.id);
        result
    }

    fn cancel(&self, task_id: &str) -> bool {
        let Some(active) = self.active.lock().get(task_id).cloned() else {
            return false;
        };
        active.cancellation.cancel();
        active.provider_cancel.store(true, Ordering::SeqCst);
        true
    }

    fn cancel_all(&self) {
        for active in self.active.lock().values() {
            active.cancellation.cancel();
            active.provider_cancel.store(true, Ordering::SeqCst);
        }
    }
}

pub fn provider_binding_for_schedule(
    provider: &aiden_data::portable_config::StoredProvider,
) -> StoredProviderLike {
    StoredProviderLike {
        id: provider.id.clone(),
        kind: match provider.kind {
            aiden_data::portable_config::ProviderKind::Openai => "openai",
            aiden_data::portable_config::ProviderKind::Anthropic => "anthropic",
        }
        .into(),
        label: provider.label.clone(),
        base_url: provider.base_url.clone(),
        needs_key: provider.needs_key,
        deployment: provider.deployment.map(|value| {
            match value {
                ProviderDeployment::Local => "local",
                ProviderDeployment::Hosted => "hosted",
            }
            .to_string()
        }),
        is_builtin: provider.is_builtin,
    }
}

fn bounded(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::config_store::{ConfigStoreError, ProviderKeyMigration, SecretsPort};
    use aiden_data::portable_config::{
        create_portable_config_stores, PortableConfigTestHooks, ProviderKind, StoredProvider,
    };

    struct NoSecrets;

    impl SecretsPort for NoSecrets {
        fn has_key(&self, _: &str) -> Result<bool, ConfigStoreError> {
            Ok(false)
        }
        fn get_provider_key(&self, _: &str, _: &str) -> Result<Option<String>, ConfigStoreError> {
            Ok(None)
        }
        fn delete_key(&self, _: &str) -> Result<(), ConfigStoreError> {
            Ok(())
        }
        fn migrate_keys(
            &self,
            _: &dyn Fn(&mut aiden_data::secret_map::SecretKeyMap) -> bool,
        ) -> Result<(), ConfigStoreError> {
            Ok(())
        }
        fn migrate_provider_keys_with_bindings(
            &self,
            _: &[ProviderKeyMigration],
        ) -> Result<bool, ConfigStoreError> {
            Ok(false)
        }
    }

    fn config() -> (tempfile::TempDir, tempfile::TempDir, ConfigStore) {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(
            create_portable_config_stores(
                portable.path().to_path_buf(),
                Some(local.path().to_path_buf()),
                PortableConfigTestHooks::default(),
            ),
            Arc::new(NoSecrets),
            None,
        );
        (portable, local, store)
    }

    #[test]
    fn global_gate_is_default_off_and_only_exact_true_enables() {
        let (_portable, _local, store) = config();
        assert!(!global_enabled(&store));
        let mut patch = serde_json::Map::new();
        patch.insert(
            SCHEDULED_TASKS_ENABLED_KEY.into(),
            serde_json::Value::String("true".into()),
        );
        store.set_settings(&patch, &|| true).unwrap();
        assert!(!global_enabled(&store));
        let (_portable, _local, enabled_config) = config();
        patch.insert(
            SCHEDULED_TASKS_ENABLED_KEY.into(),
            serde_json::Value::Bool(true),
        );
        enabled_config.set_settings(&patch, &|| true).unwrap();
        assert!(global_enabled(&enabled_config));
    }

    #[test]
    fn provider_binding_excludes_models_but_pins_endpoint_and_identity() {
        let provider = StoredProvider {
            id: "p".into(),
            kind: ProviderKind::Openai,
            label: "Provider".into(),
            base_url: "https://one.example/v1".into(),
            models: vec!["a".into()],
            model_metadata: None,
            default_model: Some("a".into()),
            needs_key: true,
            deployment: Some(ProviderDeployment::Hosted),
            is_preset: None,
            is_builtin: Some(false),
            extra: serde_json::Map::new(),
        };
        let first = provider_binding_for_schedule(&provider);
        let mut model_change = provider.clone();
        model_change.models = vec!["b".into()];
        assert_eq!(
            aiden_scheduler::binding::scheduled_provider_fingerprint(&first),
            aiden_scheduler::binding::scheduled_provider_fingerprint(
                &provider_binding_for_schedule(&model_change)
            ),
        );
        let mut endpoint_change = provider;
        endpoint_change.base_url = "https://two.example/v1".into();
        assert_ne!(
            aiden_scheduler::binding::scheduled_provider_fingerprint(&first),
            aiden_scheduler::binding::scheduled_provider_fingerprint(
                &provider_binding_for_schedule(&endpoint_change)
            ),
        );
    }

    #[test]
    fn bounded_output_preserves_utf8_boundaries() {
        assert_eq!(bounded("aéz", 2), "a");
        assert_eq!(bounded("small", 64), "small");
    }
}
