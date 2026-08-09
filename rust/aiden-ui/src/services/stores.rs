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
use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
use aiden_data::portable_watch::{
    create_last_safe_snapshot_reload, create_portable_config_watcher, PortableConfigWatcher,
};
use aiden_data::schedule_store::{
    create_schedule_store, DataStorePersistence, ScheduleStore, ScheduledRunResult, ScheduledTask,
};
use aiden_data::secret_map::{KeyringCredentialCipher, ProviderKeysError, ProviderKeysStore};
use aiden_data::usage_store::UsageStore;
use aiden_mcp::McpClientManager;
use aiden_scheduler::runtime::{
    create_scheduler, SchedulerCore, TaskExecutor, TaskRunError, TaskRunOutcome,
};
use async_trait::async_trait;

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
    pub keys: Arc<ProviderKeysStore>,
    /// Scheduled tasks + run history (machine-local `schedules.json` /
    /// `schedule-runs.json`). Shared with the settings surface and the
    /// scheduled-tasks panel so both see the same task list.
    pub schedules: Arc<ScheduleStore<DataStorePersistence, DataStorePersistence>>,
    /// Privacy-safe aggregate usage (machine-local `usage.json`).
    pub usage: Arc<UsageStore>,
    /// One shared MCP client manager (per-server connections with generations).
    /// Chat generations connect through it when enabled servers are configured.
    pub mcp: Arc<McpClientManager>,
    /// The scheduled-task runtime: a 30 s tokio tick loop that dispatches due
    /// tasks through a `TaskExecutor` and records runs in the schedule store.
    /// Started by the shell on boot; stopped on quit so no tokio task leaks.
    pub scheduler: Arc<SchedulerCore<DataStorePersistence, DataStorePersistence>>,
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
        // The schedule store shared by settings + the scheduled panel. The
        // scheduler runtime gets its own instance over the same persistence
        // files (its mutations are runtime patches + run records; the store's
        // own tail lock serializes within each instance).
        let schedules = Arc::new(create_schedule_store(
            DataStorePersistence::new("schedules.json", Some(local_root.clone())),
            DataStorePersistence::new("schedule-runs.json", Some(local_root.clone())),
            Box::new(aiden_data::now_millis),
            None,
        ));
        let usage = Arc::new(UsageStore::new_data_store(Some(local_root.clone())));
        let mcp = Arc::new(McpClientManager::new());

        let scheduler = create_scheduler(
            create_schedule_store(
                DataStorePersistence::new("schedules.json", Some(local_root.clone())),
                DataStorePersistence::new("schedule-runs.json", Some(local_root.clone())),
                Box::new(aiden_data::now_millis),
                None,
            ),
            Arc::new(LoggingTaskExecutor),
            None,
            Box::new(aiden_data::now_millis),
        );

        let (config_changed, config_watcher) =
            Self::build_portable_config_watch(config.clone(), portable_root);
        let watcher = Arc::new(config_watcher);
        spawn_config_poll_thread(watcher.clone());

        Ok(Self {
            chat,
            config,
            keys,
            schedules,
            usage,
            mcp,
            scheduler,
            quit_barrier: Arc::new(aiden_mac::quit_barrier::QuitBarrier::new()),
            config_watcher: Some(watcher),
            config_changed,
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
    /// credential/MCP reconciliation (items 5 + 7 of the parity audit) is a
    /// follow-up; the shell already re-reads providers per turn and MCP
    /// connections are fingerprint-checked on reconnect, so a change is
    /// observed at least as fast as the next turn.
    fn build_portable_config_watch(
        config: Arc<ConfigStore>,
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
        // Reconcile: for now the change is announced and the shell refreshes
        // providers. The credential/MCP reconcile side effects land with the
        // rotation-journal port (parity audit item 5/7).
        let reconcile = Box::new(|_previous: &String, current: &String| {
            tracing::info!(
                snapshot = %current,
                "reconciling externally changed portable config"
            );
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

/// The scheduler's execution seam until real chat generation lands: logs what
/// would run and returns a success outcome so the schedule store records a
/// run for every due task the tick loop dispatches (parity audit item 4:
/// "evaluate due tasks and record runs").
pub struct LoggingTaskExecutor;

#[async_trait]
impl TaskExecutor for LoggingTaskExecutor {
    async fn run(&self, task: &ScheduledTask) -> Result<TaskRunOutcome, TaskRunError> {
        tracing::info!(
            "scheduled task would execute: {task:?} (real chat execution lands with the scheduler executor follow-up)"
        );
        Ok(TaskRunOutcome {
            result: ScheduledRunResult::Success,
            output: "Evaluated by the scheduler runtime; execution lands in a follow-up."
                .to_string(),
            error: None,
            chat_id: None,
        })
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
        _binding: &str,
    ) -> Result<Option<String>, ConfigStoreError> {
        self.keys.get(provider_id).map_err(Self::map_err)
    }

    fn delete_key(&self, provider_id: &str) -> Result<(), ConfigStoreError> {
        self.keys.delete(provider_id).map_err(Self::map_err)
    }

    fn migrate_keys(
        &self,
        _migrate: &dyn Fn(&mut aiden_data::secret_map::SecretKeyMap) -> bool,
    ) -> Result<(), ConfigStoreError> {
        Ok(())
    }

    fn migrate_provider_keys_with_bindings(
        &self,
        _migrations: &[aiden_data::config_store::ProviderKeyMigration],
    ) -> Result<bool, ConfigStoreError> {
        Ok(true)
    }
}
