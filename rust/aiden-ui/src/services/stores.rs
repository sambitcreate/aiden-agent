//! Construction of the aiden-data stores the chat service talks to, plus the
//! adapter implementations the config store needs (`SecretsPort`) and the
//! provider registry needs (`ApiKeyResolver`).
//!
//! Everything here is `Send + Sync`: stores are moved into background tasks and
//! never touch the GPUI foreground thread.

use std::path::PathBuf;
use std::sync::Arc;

use aiden_data::chat_store::{create_chat_store, ChatStore, ChatStoreDurability};
use aiden_data::config_store::{ConfigStore, ConfigStoreError, SecretsPort};
use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
use aiden_data::schedule_store::{create_schedule_store, DataStorePersistence, ScheduleStore};
use aiden_data::secret_map::{KeyringCredentialCipher, ProviderKeysError, ProviderKeysStore};
use aiden_data::usage_store::UsageStore;
use aiden_mcp::McpClientManager;

/// The keychain service name used for provider credentials.
const KEYCHAIN_SERVICE: &str = "com.sambitcreate.aiden-agent.provider-keys";

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
}

impl Stores {
    /// Build the stores against the real user configuration directories
    /// (`~/.aiden` portable root, machine-local app-support data dir).
    pub fn open() -> anyhow::Result<Self> {
        let portable_root = aiden_data::aiden_config_dir()?;
        let local_root = aiden_data::machine_local_data_dir();
        let stores = create_portable_config_stores(
            portable_root,
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
        let schedules = Arc::new(create_schedule_store(
            DataStorePersistence::new("schedules.json", Some(local_root.clone())),
            DataStorePersistence::new("schedule-runs.json", Some(local_root.clone())),
            Box::new(aiden_data::now_millis),
            None,
        ));
        let usage = Arc::new(UsageStore::new_data_store(Some(local_root.clone())));
        let mcp = Arc::new(McpClientManager::new());

        Ok(Self {
            chat,
            config,
            keys,
            schedules,
            usage,
            mcp,
        })
    }
}

fn chats_dir_or_local() -> PathBuf {
    aiden_data::chats_dir().unwrap_or_else(|_| aiden_data::machine_local_data_dir().join("chats"))
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
