//! Construction of the aiden-data stores the chat service talks to, plus the
//! adapter implementations the config store needs (`SecretsPort`) and the
//! provider registry needs (`ApiKeyResolver`).
//!
//! Everything here is `Send + Sync`: stores are moved into background tasks and
//! never touch the GPUI foreground thread. The struct also owns the
//! app-lifetime background services that drive those stores:
//!
//! - the **scheduled-task runtime** (`aiden-scheduler`) — its 30 s tick loop
//!   evaluates due tasks and records runs through the shared schedule store;
//! - the **portable-config watcher** (`aiden_data::portable_watch`) — a
//!   background poll thread re-reads `~/.aiden/config.json` and announces real
//!   external edits on a version channel the shell's foreground watcher
//!   subscribes to;
//! - the **quit barrier** (`aiden_mac::quit_barrier`) — the app-wide
//!   in-flight-generation gate consulted by the shell's quit handler.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aiden_data::chat_store::{create_chat_store, ChatStore, ChatStoreDurability};
use aiden_data::config_store::{ConfigStore, ConfigStoreError, SecretsPort};
use aiden_data::mcp_oauth::{EncryptedMcpOAuthStore, EncryptedMcpOAuthStoreOptions};
use aiden_data::pi_credential_store::{
    EncryptedPiCredentialStore, EncryptedPiCredentialStoreOptions,
};
use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
use aiden_data::portable_watch::{
    create_last_safe_snapshot_reload, create_portable_config_watcher, PortableConfigWatcher,
};
#[cfg(test)]
use aiden_data::schedule_store::ScheduledTask;
use aiden_data::schedule_store::{create_schedule_store, DataStorePersistence, ScheduleStore};
use aiden_data::secret_map::{KeyringCredentialCipher, ProviderKeysError, ProviderKeysStore};
use aiden_data::usage_store::UsageStore;
use aiden_mcp::oauth::{McpOAuthOperationGate, ReqwestMcpOAuthHttp};
use aiden_mcp::McpClientManager;
use aiden_scheduler::runtime::SchedulerCore;
#[cfg(test)]
use aiden_scheduler::runtime::{TaskExecutor, TaskRunError, TaskRunOutcome};
use aiden_subagents::run_store_dispatcher::SubagentRunStoreSelection;
use aiden_subagents::run_store_production::{
    ProductionSubagentRunStore, ProductionSubagentRunStoreOptions,
};
#[cfg(test)]
use async_trait::async_trait;
use futures::FutureExt;

use crate::services::app_updates::AppUpdateAuthority;
use crate::services::codex_auth::PiCodexAuthStore;
use crate::services::computer_use::{
    production_controller_factory, production_status_dependencies, ComputerUseAuthority,
};
use crate::services::foundation_titles::production_foundation_models_connection;
use crate::services::mcp_mutation::McpMutationAuthority;
use crate::services::pi_provider_setup::PiProviderSetupAuthority;
use crate::services::scheduled_execution::{global_enabled, ProductionScheduledExecutor};
use crate::services::subagents::SubagentAuthority;
use crate::services::voice::VoiceAuthority;

/// The keychain service name used for provider credentials.
const KEYCHAIN_SERVICE: &str = "com.sambitcreate.aiden-agent.provider-keys";

/// How often the portable-config poll thread re-reads `~/.aiden/config.json`
/// (metadata mtime + byte comparison — cheap, and catches hand-edits and
/// external tooling writes within one interval).
const CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Everything the chat service needs from the data layer, wrapped in `Arc`s so
/// cloned handles can be moved into background tasks.
#[derive(Clone)]
pub struct Stores {
    pub chat: Arc<ChatStore>,
    pub config: Arc<ConfigStore>,
    /// Process-lifetime Appearance publication sequence. Every window shares
    /// this fence, so a delayed write from a closed/replaced window can never
    /// publish after a newer reopened-window intent.
    pub appearance_intent_revision: Arc<AtomicU64>,
    pub keys: Arc<ProviderKeysStore>,
    /// Pi-native provider credentials. Values are encrypted into distinct
    /// Keychain accounts and never copied into portable provider config.
    /// The exact adapter shared by Codex setup and request-time token refresh.
    pub codex_auth: Arc<PiCodexAuthStore>,
    /// Pi-native provider inventory and encrypted setup authority. Codex keeps
    /// its separate OAuth authority while sharing the underlying store.
    pub pi_providers: Arc<PiProviderSetupAuthority>,
    /// Truthful Apple Foundation Models status/title connection. It probes the
    /// signed helper only when title routing asks for it.
    pub foundation_models: Arc<aiden_computer_use::FoundationModelsConnection>,
    /// The sole app-lifetime Computer Use authority. Settings, chat admission,
    /// approvals, and lifecycle cancellation must all share this exact value.
    pub computer_use: Arc<ComputerUseAuthority>,
    /// Sole runtime authority for local voice selection and recording fences.
    pub voice: Arc<VoiceAuthority>,
    /// Scheduled tasks + run history (machine-local `schedules.json` /
    /// `schedule-runs.json`). Shared with the settings surface and the
    /// scheduled-tasks panel so both see the same task list.
    pub schedules: Arc<ScheduleStore<DataStorePersistence, DataStorePersistence>>,
    /// Privacy-safe aggregate usage (machine-local `usage.json`).
    pub usage: Arc<UsageStore>,
    /// One shared MCP client manager (per-server connections with generations).
    /// Chat generations connect through it when enabled servers are configured.
    pub mcp: Arc<McpClientManager>,
    /// The sole configuration/credential mutation authority for MCP servers.
    pub mcp_mutation: Arc<McpMutationAuthority>,
    /// The scheduled-task runtime: a 30 s tokio tick loop that dispatches due
    /// tasks through a `TaskExecutor` and records runs in the schedule store.
    /// Started by the shell on boot; stopped on quit so no tokio task leaks.
    pub scheduler: Arc<SchedulerCore<DataStorePersistence, DataStorePersistence>>,
    /// Concrete executor retained for truthful readiness projection.
    pub scheduler_executor: Arc<ProductionScheduledExecutor>,
    /// The app-wide quit decision state (in-flight generations block quit
    /// unless forced). Consulted by the shell's quit handler.
    pub quit_barrier: Arc<aiden_mac::quit_barrier::QuitBarrier>,
    /// The portable-config watcher. The background poll thread owns a clone;
    /// the field keeps it reachable so the shell can also `refresh()` it on
    /// window focus later (mirroring the TS trigger set).
    #[allow(dead_code)]
    pub config_watcher: Option<Arc<PortableConfigWatcher>>,
    /// Version channel bumped by the watcher on every real external config
    /// change. The shell's foreground watcher subscribes and refreshes
    /// providers/MCP; subscribe via [`Stores::subscribe_config_changes`].
    pub config_changed: Arc<tokio::sync::watch::Sender<u64>>,
    /// The subagent run store (`subagent-runs` / `subagent-runs-v2` under the
    /// machine-local root). Chat deletion reconciles it so deleting a chat also
    /// removes its subagent runs and pending-deletion markers (parity audit
    /// item 8). Best-effort at boot: a broken subagent store logs a warning and
    /// yields `None` so it never blocks the chat app.
    pub runs: Option<Arc<ProductionSubagentRunStore>>,
    /// Sole app-lifetime native subagent admission/runtime/control authority.
    /// It owns the exact same production run store exposed above.
    pub subagents: Arc<SubagentAuthority>,
    /// One app-lifetime update authority. It is inert outside a signed,
    /// packaged macOS build with an embedded generic-feed marker.
    pub app_updates: Arc<AppUpdateAuthority>,
}

impl Stores {
    /// Build the stores against the real user configuration directories
    /// (`~/.aiden` portable root, machine-local app-support data dir), then
    /// wire the app-lifetime background services (scheduler runtime +
    /// portable-config watch).
    pub fn open() -> anyhow::Result<Self> {
        let portable_root = aiden_data::aiden_config_dir()?;
        let local_root = aiden_data::machine_local_data_dir();
        let stores = create_portable_config_stores(
            portable_root.clone(),
            Some(local_root.clone()),
            PortableConfigTestHooks::default(),
        );

        let keys = Arc::new(ProviderKeysStore::new(
            local_root.clone(),
            KEYCHAIN_SERVICE,
            Arc::new(KeyringCredentialCipher::new(KEYCHAIN_SERVICE)),
        ));
        let pi_credentials = Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: local_root.join("pi-provider-credentials.json"),
                cipher: Arc::new(KeyringCredentialCipher::new(KEYCHAIN_SERVICE)),
                sync_directory: None,
                on_durability_warning: None,
                before_document_write: None,
            },
        ));
        let codex_auth = Arc::new(PiCodexAuthStore::new(pi_credentials.clone()));
        let pi_providers = PiProviderSetupAuthority::new(pi_credentials);
        let foundation_models = Arc::new(production_foundation_models_connection());
        let config = Arc::new(ConfigStore::new(
            stores,
            Arc::new(StoreSecretsPort::new(keys.clone())),
            None,
        ));
        let chat = Arc::new(create_chat_store(
            Box::new(chats_dir_or_local),
            None,
            ChatStoreDurability::default(),
        ));
        let computer_use = ComputerUseAuthority::new_with_controller_factory(
            config.clone(),
            chat.clone(),
            production_status_dependencies(config.clone()),
            production_controller_factory(),
        );
        let usage = Arc::new(UsageStore::new_data_store(Some(local_root.clone())));
        let voice = VoiceAuthority::new(config.clone(), pi_providers.clone(), usage.clone());
        if let Err(error) = voice.reconcile_boot() {
            tracing::warn!(%error, "voice settings migration failed; dictation remains fail-closed");
        }
        // The schedule store is the single authority for settings, the panel,
        // tools, and the runtime. Never construct another cached instance over
        // these files: a second cache can overwrite newer task state.
        let schedules = Arc::new(create_schedule_store(
            DataStorePersistence::new("schedules.json", Some(local_root.clone())),
            DataStorePersistence::new("schedule-runs.json", Some(local_root.clone())),
            Box::new(aiden_data::now_millis),
            None,
        ));
        let mcp = Arc::new(McpClientManager::new());
        let oauth_store = Arc::new(EncryptedMcpOAuthStore::new(EncryptedMcpOAuthStoreOptions {
            root: local_root.clone(),
            cipher: Arc::new(KeyringCredentialCipher::new(KEYCHAIN_SERVICE)),
        }));
        let mcp_mutation = Arc::new(McpMutationAuthority::new_with_oauth(
            config.clone(),
            keys.clone(),
            mcp.clone(),
            oauth_store,
            Arc::new(McpOAuthOperationGate::new()),
            Arc::new(ReqwestMcpOAuthHttp::default()),
        ));
        // A crash between portable publication and credential cleanup leaves a
        // durable journal. Reconcile it before any watcher/chat can reconnect.
        if let Err(error) = mcp_mutation.reconcile_boot() {
            tracing::warn!(%error, "MCP cleanup journal reconciliation failed; affected credentials remain unavailable");
        }

        let scheduler_executor = ProductionScheduledExecutor::new(
            config.clone(),
            schedules.clone(),
            chat.clone(),
            usage.clone(),
            codex_auth.clone(),
            mcp.clone(),
            mcp_mutation.clone(),
        );
        let enabled_config = config.clone();
        let scheduler = SchedulerCore::new(
            schedules.clone(),
            scheduler_executor.clone(),
            None,
            Box::new(aiden_data::now_millis),
            Box::new(move || {
                let config = enabled_config.clone();
                async move { global_enabled(&config) }.boxed()
            }),
            Box::new(|message| tracing::warn!("[schedule] {message}")),
            Box::new(|message| tracing::error!("[schedule] {message}")),
            aiden_scheduler::runtime::SchedulerConfig::default(),
        );

        let (config_changed, config_watcher) =
            Self::build_portable_config_watch(config.clone(), mcp_mutation.clone(), portable_root);
        let watcher = Arc::new(config_watcher);
        spawn_config_poll_thread(watcher.clone());

        // The subagent run store. Its V1/V2 selection mirrors the TS
        // canonical default-on Subagents V2 rollback flags; the dispatcher owns migration and
        // the V1 checkpoint so deletion stays rollback-safe. A broken store is
        // logged, never fatal — chat deletion skips run reconciliation then.
        let runs = open_subagent_run_store(local_root);
        let subagents = SubagentAuthority::new_with_mcp(runs.clone(), mcp_mutation.clone());
        let app_updates = AppUpdateAuthority::production();

        Ok(Self {
            chat,
            config,
            appearance_intent_revision: Arc::new(AtomicU64::new(0)),
            keys,
            codex_auth,
            pi_providers,
            foundation_models,
            computer_use,
            voice,
            schedules,
            usage,
            mcp,
            mcp_mutation,
            scheduler,
            scheduler_executor,
            quit_barrier: Arc::new(aiden_mac::quit_barrier::QuitBarrier::new()),
            config_watcher: Some(watcher),
            config_changed,
            runs,
            subagents,
            app_updates,
        })
    }

    /// Subscribe to external portable-config changes. The receiver yields a
    /// monotonically increasing version on every real change; the shell's
    /// foreground watcher refreshes providers/MCP when it fires.
    pub fn subscribe_config_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.config_changed.subscribe()
    }

    /// Build the portable-config watcher (port of
    /// `portable-config-watch-core.ts`). The snapshot is the provider + MCP
    /// intent read from the config store's cache; a reload forces the store
    /// to re-read `~/.aiden/config.json` from disk (byte comparison inside
    /// `DataStore::reload`) and the last-safe-snapshot tracker guarantees an
    /// unsafe (corrupt/malformed) file never replaces the reconciled baseline.
    ///
    /// `on_changed` bumps the version channel the shell watches. External
    /// credential/MCP reconciliation fences and disconnects changed server
    /// records before the shell announces the new snapshot.
    fn build_portable_config_watch(
        config: Arc<ConfigStore>,
        mcp_mutation: Arc<McpMutationAuthority>,
        portable_root: PathBuf,
    ) -> (Arc<tokio::sync::watch::Sender<u64>>, PortableConfigWatcher) {
        let (version_tx, _) = tokio::sync::watch::channel(0u64);
        let version_tx = Arc::new(version_tx);
        let counter = Arc::new(AtomicU64::new(0));

        // Snapshot: the provider + MCP intent an external edit can change.
        let snapshot = {
            let config = config.clone();
            Box::new(move || {
                let providers = config.list_providers().unwrap_or_default();
                let mcp_servers = config.list_mcp_servers().unwrap_or_default();
                serde_json::to_string(&(providers, mcp_servers)).unwrap_or_default()
            })
        };
        // Cached safety: never re-reads disk (the tracker calls this both
        // before and after the reload).
        let cached_safe = {
            let config = config.clone();
            Box::new(move || {
                config
                    .cached_portable_config_safe_for_credential_reconciliation()
                    .unwrap_or(false)
            })
        };
        // Reload: re-read `~/.aiden/config.json` from disk and force the
        // ConfigStore cache to follow. Byte comparison (not stat) decides
        // "changed", matching the TS watcher.
        let config_path = portable_root.join(aiden_data::portable_config::PORTABLE_CONFIG_FILENAME);
        let last_disk = Arc::new(std::sync::Mutex::new(std::fs::read(&config_path).ok()));
        let reload = {
            let config = config.clone();
            let last_disk = last_disk.clone();
            Box::new(move || {
                let disk = std::fs::read(&config_path).ok();
                let changed = disk != *last_disk.lock().unwrap();
                if changed {
                    *last_disk.lock().unwrap() = disk;
                    // Seeds/reloads the portable store from disk (guards
                    // corrupt/unsafe files); list_providers then reflects the
                    // edit.
                    let _ = config.portable_config_safe_for_credential_reconciliation();
                }
                changed
            })
        };
        // External edits bypass the mutation authority, so disconnect every
        // server whose runtime snapshot changed before announcing the edit.
        // The next chat turn reconnects only from the newly reloaded record.
        let reconcile = Box::new(move |previous: &String, current: &String| {
            let parse = |snapshot: &str| -> Vec<aiden_data::portable_config::McpServer> {
                serde_json::from_str::<(
                    Vec<aiden_data::config_store::Provider>,
                    Vec<aiden_data::portable_config::McpServer>,
                )>(snapshot)
                .map(|(_, servers)| servers)
                .unwrap_or_default()
            };
            let previous = parse(previous);
            let current = parse(current);
            let mut ids = std::collections::BTreeSet::new();
            ids.extend(previous.iter().map(|server| server.id.clone()));
            ids.extend(current.iter().map(|server| server.id.clone()));
            for id in ids {
                let before = previous.iter().find(|server| server.id == id);
                let after = current.iter().find(|server| server.id == id);
                if before.map(aiden_mcp::credential_cleanup::mcp_runtime_connection_snapshot)
                    != after.map(aiden_mcp::credential_cleanup::mcp_runtime_connection_snapshot)
                {
                    mcp_mutation
                        .reconcile_external(before, after)
                        .map_err(|error| {
                            aiden_data::portable_watch::PortableWatchError::Message(
                                error.to_string(),
                            )
                        })?;
                }
            }
            Ok(())
        });
        let reload =
            create_last_safe_snapshot_reload::<String>(cached_safe, snapshot, reload, reconcile);
        let watcher = create_portable_config_watcher(
            // `run()` already returns `Result<bool, PortableWatchError>` — the
            // exact contract the watcher's reload slot expects.
            Box::new(move || reload.run()),
            {
                let version_tx = version_tx.clone();
                let counter = counter.clone();
                Box::new(move || {
                    let version = counter.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = version_tx.send(version);
                })
            },
            Box::new(|error| {
                tracing::warn!("portable config watch error: {error}");
            }),
        );
        (version_tx, watcher)
    }
}

/// Poll the portable-config watcher on a dedicated background thread. The
/// thread holds its own `Arc` clone, so it outlives any `Stores` drop and
/// stops only at process exit.
fn spawn_config_poll_thread(watcher: Arc<PortableConfigWatcher>) {
    let thread = std::thread::Builder::new()
        .name("aiden-portable-config-watch".to_string())
        .spawn(move || loop {
            std::thread::sleep(CONFIG_POLL_INTERVAL);
            watcher.refresh();
        });
    match thread {
        Ok(_) => {}
        Err(error) => tracing::warn!("could not spawn the portable config watch thread: {error}"),
    }
}

fn chats_dir_or_local() -> PathBuf {
    aiden_data::chats_dir().unwrap_or_else(|_| aiden_data::machine_local_data_dir().join("chats"))
}

/// The subagent run-store selection (port of `subagentV2Enabled`): V2 is the
/// default and exact `AIDEN_SUBAGENTS_ENABLED=0` or
/// `AIDEN_SUBAGENTS_V2_ENABLED=0` selects the rollback-readable V1 store.
fn subagent_run_selection() -> SubagentRunStoreSelection {
    let environment: std::collections::HashMap<String, String> = std::env::vars().collect();
    if ProductionSubagentRunStore::subagent_v2_enabled(&environment) {
        SubagentRunStoreSelection::V2
    } else {
        SubagentRunStoreSelection::V1
    }
}

/// Construct + initialize the production subagent run store (V1/V2 selection
/// with migration + checkpoint coordination). Best-effort: any failure logs a
/// warning and yields `None` so a broken subagent history store never blocks
/// the chat app.
fn open_subagent_run_store(local_root: PathBuf) -> Option<Arc<ProductionSubagentRunStore>> {
    let user_data = local_root.clone();
    let result = ProductionSubagentRunStore::create(ProductionSubagentRunStoreOptions {
        selection: subagent_run_selection(),
        resolve_user_data_directory: Box::new(move || user_data.clone()),
        now: None,
    })
    .and_then(|mut store| {
        store.initialize()?;
        Ok(store)
    });
    match result {
        Ok(store) => Some(Arc::new(store)),
        Err(error) => {
            tracing::warn!("subagent run store unavailable: {error}");
            None
        }
    }
}

/// Explicitly fail closed until the app wires a bounded, cancellation-aware
/// executor. In particular, a scheduled task must never report success merely
/// because a placeholder saw it.
#[cfg(test)]
pub struct TestFailClosedTaskExecutor;

#[cfg(test)]
#[async_trait]
impl TaskExecutor for TestFailClosedTaskExecutor {
    async fn run(
        &self,
        task: &aiden_data::schedule_store::ScheduledTask,
    ) -> Result<TaskRunOutcome, TaskRunError> {
        Err(TaskRunError(format!(
            "Scheduled execution is unavailable for task {} until a real executor is configured.",
            task.id
        )))
    }

    fn cancel(&self, _task_id: &str) -> bool {
        false
    }

    fn cancel_all(&self) {}
}

/// The slice of [`ProviderKeysStore`] the config store needs. Missing or
/// unreadable keys degrade to `None`/`false` rather than blocking the app.
pub struct StoreSecretsPort {
    keys: Arc<ProviderKeysStore>,
}

impl StoreSecretsPort {
    pub fn new(keys: Arc<ProviderKeysStore>) -> Self {
        Self { keys }
    }

    fn map_err(error: ProviderKeysError) -> ConfigStoreError {
        ConfigStoreError::SecretMigration(error.to_string())
    }
}

impl SecretsPort for StoreSecretsPort {
    fn has_key(&self, provider_id: &str) -> Result<bool, ConfigStoreError> {
        self.keys.has_key(provider_id).map_err(Self::map_err)
    }

    fn get_provider_key(
        &self,
        provider_id: &str,
        binding: &str,
    ) -> Result<Option<String>, ConfigStoreError> {
        // The binding is a JSON snapshot of the provider connection the
        // credential was issued for (base URL, kind, needs-key posture). A
        // stored key is usable only when that snapshot matches the caller's
        // current connection (TS `secrets.getProviderKey`): a missing or
        // mismatched binding means the credential belongs to a DIFFERENT
        // provider config (e.g. the base URL changed), so the key is refused
        // and the user must re-authenticate.
        self.keys
            .get_bound(provider_id, binding)
            .map_err(Self::map_err)
    }

    fn delete_key(&self, provider_id: &str) -> Result<(), ConfigStoreError> {
        self.keys.delete(provider_id).map_err(Self::map_err)
    }

    fn migrate_keys(
        &self,
        migrate: &dyn Fn(&mut aiden_data::secret_map::SecretKeyMap) -> bool,
    ) -> Result<(), ConfigStoreError> {
        self.keys
            .migrate(migrate)
            .map(|_| ())
            .map_err(Self::map_err)
    }

    fn migrate_provider_keys_with_bindings(
        &self,
        migrations: &[aiden_data::config_store::ProviderKeyMigration],
    ) -> Result<bool, ConfigStoreError> {
        self.keys
            .migrate_provider_keys_with_bindings(migrations)
            .map_err(Self::map_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::portable_config::{McpServer, McpTransport, PORTABLE_CONFIG_FILENAME};
    use aiden_data::schedule_store::{ScheduledTaskMode, ScheduledTaskPermission};
    use aiden_data::secret_map::{SecretCipher, SecretCipherError};
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    /// An in-memory cipher mirroring the TS test seam (`encrypted:<value>`
    /// bytes with a per-account vault), so `ProviderKeysStore` is testable
    /// without touching the macOS Keychain.
    #[derive(Default)]
    struct MemoryCipher {
        vault: StdMutex<HashMap<String, String>>,
    }

    impl SecretCipher for MemoryCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }
        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.vault
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(format!("encrypted:{value}").into_bytes())
        }
        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            let text = String::from_utf8_lossy(value);
            if !text.starts_with("encrypted:") {
                return Err(SecretCipherError::NeedsRotation);
            }
            let plaintext = text.trim_start_matches("encrypted:").to_string();
            let vaulted = self.vault.lock().unwrap().get(account).cloned();
            match vaulted {
                Some(stored) if stored == plaintext => Ok(plaintext),
                _ => Err(SecretCipherError::UnrecognizedFormat),
            }
        }
    }

    fn keys_with_cipher() -> (tempfile::TempDir, Arc<ProviderKeysStore>) {
        let dir = tempfile::tempdir().unwrap();
        let cipher: Arc<dyn SecretCipher> = Arc::new(MemoryCipher::default());
        let store = Arc::new(ProviderKeysStore::new(
            dir.path().to_path_buf(),
            "aiden-test",
            cipher,
        ));
        (dir, store)
    }

    fn mcp_watch_fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<ConfigStore>,
        Arc<McpMutationAuthority>,
    ) {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let cipher: Arc<dyn SecretCipher> = Arc::new(MemoryCipher::default());
        let keys = Arc::new(ProviderKeysStore::new(
            local.path().to_path_buf(),
            "aiden-mcp-watch-test",
            cipher,
        ));
        let config = Arc::new(ConfigStore::new(
            create_portable_config_stores(
                portable.path().to_path_buf(),
                Some(local.path().to_path_buf()),
                PortableConfigTestHooks::default(),
            ),
            Arc::new(StoreSecretsPort::new(keys.clone())),
            None,
        ));
        let authority = Arc::new(McpMutationAuthority::new(
            config.clone(),
            keys,
            Arc::new(McpClientManager::new()),
        ));
        (portable, local, config, authority)
    }

    fn watched_server() -> McpServer {
        McpServer {
            id: "mcp-watch".into(),
            name: "Watch".into(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some("https://first.example/mcp".into()),
            headers: None,
            oauth: None,
            preset_id: None,
            enabled: true,
        }
    }

    fn edit_portable_mcp(portable: &tempfile::TempDir, edit: impl FnOnce(&mut serde_json::Value)) {
        let path = portable.path().join(PORTABLE_CONFIG_FILENAME);
        let mut document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        edit(&mut document["mcpServers"][0]);
        std::fs::write(path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    }

    #[test]
    fn malformed_mcp_args_stay_unsafe_without_reconciliation_or_credential_revoke() {
        let (portable, _local, config, authority) = mcp_watch_fixture();
        config.save_mcp_server(&watched_server(), &|| true).unwrap();
        let (changed, watcher) = Stores::build_portable_config_watch(
            config.clone(),
            authority.clone(),
            portable.path().to_path_buf(),
        );
        let version = changed.subscribe();
        watcher.refresh();
        let epoch = authority.epoch();

        edit_portable_mcp(&portable, |server| {
            server["args"] = serde_json::json!("--not-an-array");
        });
        watcher.refresh();

        assert!(config
            .cached_portable_config_safe_for_credential_reconciliation()
            .is_err());
        assert_eq!(authority.epoch(), epoch, "unsafe input cannot revoke");
        assert_eq!(*version.borrow(), 0, "unsafe input is not announced");
        assert!(!config
            .get_settings()
            .unwrap()
            .contains_key("pendingMcpCredentialCleanup"));

        edit_portable_mcp(&portable, |server| {
            server.as_object_mut().unwrap().remove("args");
        });
        watcher.refresh();
        assert!(config
            .cached_portable_config_safe_for_credential_reconciliation()
            .unwrap());
        assert_eq!(authority.epoch(), epoch);
        assert_eq!(*version.borrow(), 1);
    }

    #[test]
    fn watcher_cleanup_failure_keeps_baseline_pending_and_unchanged_retry_commits() {
        let (portable, _local, config, authority) = mcp_watch_fixture();
        config.save_mcp_server(&watched_server(), &|| true).unwrap();
        let (changed, watcher) = Stores::build_portable_config_watch(
            config.clone(),
            authority.clone(),
            portable.path().to_path_buf(),
        );
        let version = changed.subscribe();
        watcher.refresh();

        edit_portable_mcp(&portable, |server| {
            server["url"] = serde_json::json!("https://second.example/mcp");
        });
        authority.set_cleanup_failure_for_test(true);
        watcher.refresh();
        assert_eq!(
            *version.borrow(),
            0,
            "failed cleanup cannot commit baseline"
        );
        assert!(config
            .get_settings()
            .unwrap()
            .contains_key("pendingMcpCredentialCleanup"));

        authority.set_cleanup_failure_for_test(false);
        watcher.refresh();
        assert_eq!(
            *version.borrow(),
            1,
            "the unchanged disk transition is retried and committed"
        );
        assert!(!config
            .get_settings()
            .unwrap()
            .contains_key("pendingMcpCredentialCleanup"));
        watcher.refresh();
        assert_eq!(*version.borrow(), 1, "committed baseline is not replayed");
    }

    #[tokio::test]
    async fn test_only_fail_closed_executor_never_reports_success() {
        let task = ScheduledTask {
            id: "task-1".to_string(),
            name: "Test".to_string(),
            enabled: true,
            mode: ScheduledTaskMode::Llm,
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
            next_run_at: None,
            last_run_at: None,
            workspace_id: None,
            provider_id: None,
            model: None,
            provider_fingerprint: None,
            prompt: Some("test".to_string()),
            script: None,
            permission: ScheduledTaskPermission::ReadOnly,
            mcp_server_ids: None,
            mcp_server_bindings: None,
            execution_profile: None,
            chat_id: None,
            notify: false,
            last_result: None,
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };

        let result = TestFailClosedTaskExecutor.run(&task).await;

        assert!(result.is_err());
    }

    fn binding_for(id: &str, base_url: &str) -> String {
        serde_json::json!({
            "id": id,
            "kind": "openai",
            "baseUrl": base_url,
            "needsKey": true,
        })
        .to_string()
    }

    #[test]
    fn bound_key_is_returned_only_when_the_binding_matches() {
        let (_dir, keys) = keys_with_cipher();
        let port = StoreSecretsPort::new(keys.clone());
        keys.set("openai", "sk-test").unwrap();
        keys.set_binding(
            "openai",
            &binding_for("openai", "https://api.openai.com/v1"),
        )
        .unwrap();

        // The key is usable against the connection it was issued for…
        assert_eq!(
            port.get_provider_key(
                "openai",
                &binding_for("openai", "https://api.openai.com/v1")
            )
            .unwrap()
            .as_deref(),
            Some("sk-test")
        );
        // …and refused the moment the connection snapshot differs (base URL).
        assert_eq!(
            port.get_provider_key("openai", &binding_for("openai", "https://other.example/v1"))
                .unwrap(),
            None
        );
    }

    #[test]
    fn unbound_legacy_keys_fail_closed() {
        let (_dir, keys) = keys_with_cipher();
        let port = StoreSecretsPort::new(keys.clone());
        // A key saved before binding records existed must not be handed out:
        // its endpoint provenance cannot be verified.
        keys.set("openai", "sk-legacy").unwrap();
        assert_eq!(
            port.get_provider_key(
                "openai",
                &binding_for("openai", "https://api.openai.com/v1")
            )
            .unwrap(),
            None
        );
        // hasKey still reports the slot (the renderer shows "key exists" and
        // the settings surface flags rotation), matching TS providerCredentialState.
        assert!(port.has_key("openai").unwrap());
    }

    #[test]
    fn migrate_keys_rehomes_alias_keys_through_the_port() {
        let (_dir, keys) = keys_with_cipher();
        let port = StoreSecretsPort::new(keys.clone());
        keys.set("gemini", "sk-gemini").unwrap();

        port.migrate_keys(&|map| {
            // Mirrors the config store's alias closure: re-home the slot and
            // drop the legacy id so the backing keychain secret moves too.
            let Some(serde_json::Value::String(legacy)) = map.get("gemini").cloned() else {
                return false;
            };
            if map.contains_key("google") {
                return false;
            }
            aiden_data::secret_map::set_secret_key_entry(map, "google", legacy);
            map.remove("gemini");
            true
        })
        .unwrap();

        assert!(keys.has_key("google").unwrap());
        assert_eq!(keys.get("google").unwrap().as_deref(), Some("sk-gemini"));
        assert!(!keys.has_key("gemini").unwrap());
    }

    #[test]
    fn migrate_provider_keys_with_bindings_binds_rehomed_keys_through_the_port() {
        let (_dir, keys) = keys_with_cipher();
        let port = StoreSecretsPort::new(keys.clone());
        keys.set("openai-legacy", "sk-openai").unwrap();
        let binding = binding_for("openai", "https://api.openai.com/v1");

        let migrated = port
            .migrate_provider_keys_with_bindings(&[
                aiden_data::config_store::ProviderKeyMigration {
                    legacy_provider_id: "openai-legacy".to_string(),
                    provider_id: "openai".to_string(),
                    binding: binding.clone(),
                },
            ])
            .unwrap();
        assert!(migrated);

        // Re-homed key is bound to the target connection snapshot and usable…
        assert_eq!(
            port.get_provider_key("openai", &binding)
                .unwrap()
                .as_deref(),
            Some("sk-openai")
        );
        // …but refused against any other connection.
        assert_eq!(
            port.get_provider_key("openai", &binding_for("openai", "https://x.test/v1"))
                .unwrap(),
            None
        );
        assert!(!keys.has_key("openai-legacy").unwrap());
    }

    #[test]
    fn the_subagent_run_store_reconciles_chat_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let user_data = dir.path().to_path_buf();
        let mut store = ProductionSubagentRunStore::create(ProductionSubagentRunStoreOptions {
            selection: SubagentRunStoreSelection::V1,
            resolve_user_data_directory: Box::new(move || user_data.clone()),
            now: None,
        })
        .unwrap();
        store.initialize().unwrap();

        assert!(store
            .dispatcher
            .pending_chat_deletions()
            .unwrap()
            .is_empty());
        store
            .dispatcher
            .delete_chat("chat-00000000-0000-4000-8000-000000000001")
            .unwrap();
        assert_eq!(
            store.dispatcher.pending_chat_deletions().unwrap(),
            vec!["chat-00000000-0000-4000-8000-000000000001".to_string()]
        );
        store
            .dispatcher
            .complete_chat_deletion("chat-00000000-0000-4000-8000-000000000001")
            .unwrap();
        assert!(store
            .dispatcher
            .pending_chat_deletions()
            .unwrap()
            .is_empty());
    }
}
