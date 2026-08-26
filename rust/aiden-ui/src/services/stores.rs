//! Construction of the aiden-data stores the chat service talks to, plus the
//! adapter implementations the config store needs (`SecretsPort`) and the
//! provider registry needs (`ApiKeyResolver`).
//!
//! Everything here is `Send + Sync`: stores are moved into background tasks and
//! never touch the GPUI foreground thread.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aiden_data::chat_store::{create_chat_store, ChatStore, ChatStoreDurability};
use aiden_data::config_store::{ConfigStore, ConfigStoreError, SecretsPort};
use aiden_data::pi_credential_store::{
    EncryptedPiCredentialStore, EncryptedPiCredentialStoreOptions, PiCredentialError,
};
use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
use aiden_data::schedule_store::{create_schedule_store, DataStorePersistence, ScheduleStore};
use aiden_data::secret_map::{KeyringCredentialCipher, ProviderKeysError, ProviderKeysStore};
use aiden_data::usage_store::UsageStore;
use aiden_mcp::McpClientManager;
use aiden_providers::codex::{
    credential_revision, extract_account_id, CodexAuthStore, CodexAuthStoreStatus,
    CodexCredentialGate, CodexDispatchGuard, CodexRefreshCoordinator, OAuthCredential,
    OPENAI_CODEX_PROVIDER_ID,
};
use aiden_providers::list::{bundled_codex_provider_snapshot, CodexProviderSnapshot};
use aiden_providers::web_search::ExaClient;
use aiden_providers::ProviderError;

/// The keychain service name used for provider credentials.
const KEYCHAIN_SERVICE: &str = "com.sambitcreate.aiden-agent.provider-keys";
const PI_CREDENTIALS_FILE: &str = "pi-provider-credentials.json";

/// Generation-facing view of Pi's encrypted credential backend. Reads observe
/// the latest sign-in before every Codex request, while refresh writes use the
/// backend's per-provider serialization rather than replacing the credential
/// document directly.
pub struct StoreCodexAuth {
    credentials: Arc<EncryptedPiCredentialStore>,
    credential_gate: CodexCredentialGate,
    refresh_coordinator: Arc<CodexRefreshCoordinator>,
}

impl StoreCodexAuth {
    pub fn new(credentials: Arc<EncryptedPiCredentialStore>) -> Self {
        Self {
            credentials,
            credential_gate: CodexCredentialGate::default(),
            refresh_coordinator: Arc::new(CodexRefreshCoordinator::default()),
        }
    }

    fn map_err(error: PiCredentialError) -> ProviderError {
        ProviderError::Auth(format!("ChatGPT credential store: {error}"))
    }

    fn parse(value: serde_json::Value) -> Result<OAuthCredential, ProviderError> {
        let access = value
            .get("access")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ProviderError::Auth("Stored ChatGPT sign-in is invalid.".into()))?;
        let refresh = value
            .get("refresh")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ProviderError::Auth("Stored ChatGPT sign-in is invalid.".into()))?;
        let expires = value
            .get("expires")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| ProviderError::Auth("Stored ChatGPT sign-in is invalid.".into()))?;
        Ok(OAuthCredential {
            access: access.to_string(),
            refresh: refresh.to_string(),
            expires,
        })
    }

    fn credential_value(credential: &OAuthCredential) -> serde_json::Value {
        let mut value = serde_json::json!({
            "type": "oauth",
            "access": credential.access,
            "refresh": credential.refresh,
            "expires": credential.expires,
        });
        if let Ok(account_id) = extract_account_id(&credential.access) {
            value["accountId"] = serde_json::Value::String(account_id);
        }
        value
    }

    pub fn provider_snapshot(&self) -> CodexProviderSnapshot {
        let status = <Self as CodexAuthStore>::status(self).unwrap_or(CodexAuthStoreStatus {
            configured: false,
            needs_attention: false,
        });
        bundled_codex_provider_snapshot(status.configured, status.needs_attention)
    }
}

impl CodexAuthStore for StoreCodexAuth {
    fn read(&self) -> Result<Option<OAuthCredential>, ProviderError> {
        self.credentials
            .read(OPENAI_CODEX_PROVIDER_ID)
            .map_err(Self::map_err)?
            .map(Self::parse)
            .transpose()
    }

    fn status(&self) -> Result<CodexAuthStoreStatus, ProviderError> {
        let configured = self
            .credentials
            .list()
            .map_err(Self::map_err)?
            .iter()
            .any(|entry| entry.provider_id == OPENAI_CODEX_PROVIDER_ID);
        let needs_attention = configured && self.read().is_err();
        Ok(CodexAuthStoreStatus {
            configured,
            needs_attention,
        })
    }

    fn write(&self, credential: Option<&OAuthCredential>) -> Result<(), ProviderError> {
        self.credential_gate
            .mutate(|| {
                match credential {
                    Some(credential) => {
                        let value = Self::credential_value(credential);
                        self.credentials.replace(OPENAI_CODEX_PROVIDER_ID, value)?;
                    }
                    None => self.credentials.delete(OPENAI_CODEX_PROVIDER_ID)?,
                }
                Ok(((), true))
            })
            .map_err(Self::map_err)
    }

    fn write_if_revision(
        &self,
        expected_revision: &str,
        credential: &OAuthCredential,
    ) -> Result<bool, ProviderError> {
        let value = Self::credential_value(credential);
        self.credential_gate
            .mutate(|| {
                let mut replaced = false;
                self.credentials
                    .modify(OPENAI_CODEX_PROVIDER_ID, |current| {
                        let current = current
                            .cloned()
                            .map(Self::parse)
                            .transpose()
                            .map_err(|_| PiCredentialError::InvalidOrCorrupted)?;
                        if credential_revision(current.as_ref()).as_deref()
                            != Some(expected_revision)
                        {
                            return Ok(None);
                        }
                        replaced = true;
                        Ok(Some(value))
                    })?;
                Ok((replaced, replaced))
            })
            .map_err(Self::map_err)
    }

    fn refresh_coordinator(&self) -> Arc<CodexRefreshCoordinator> {
        self.refresh_coordinator.clone()
    }

    fn begin_dispatch(
        &self,
        expected_revision: &str,
    ) -> Result<Option<CodexDispatchGuard>, ProviderError> {
        self.credential_gate
            .begin_dispatch(|| {
                let current = self
                    .credentials
                    .read(OPENAI_CODEX_PROVIDER_ID)?
                    .map(Self::parse)
                    .transpose()
                    .map_err(|_| PiCredentialError::InvalidOrCorrupted)?;
                Ok(credential_revision(current.as_ref()).as_deref() == Some(expected_revision))
            })
            .map_err(Self::map_err)
    }
}

/// Everything the chat service needs from the data layer, wrapped in `Arc`s so
/// cloned handles can be moved into background tasks.
#[derive(Clone)]
pub struct Stores {
    pub chat: Arc<ChatStore>,
    pub config: Arc<ConfigStore>,
    pub keys: Arc<ProviderKeysStore>,
    /// Pi OAuth credentials used by the Codex request-time auth/refresh path.
    pub codex_auth: Arc<StoreCodexAuth>,
    /// Scheduled tasks + run history (machine-local `schedules.json` /
    /// `schedule-runs.json`). Shared with the settings surface and the
    /// scheduled-tasks panel so both see the same task list.
    pub schedules: Arc<ScheduleStore<DataStorePersistence, DataStorePersistence>>,
    /// Privacy-safe aggregate usage (machine-local `usage.json`).
    pub usage: Arc<UsageStore>,
    /// One shared MCP client manager (per-server connections with generations).
    /// Chat generations connect through it when enabled servers are configured.
    pub mcp: Arc<McpClientManager>,
    /// Shared bounded Exa HTTP client. A generation still receives its own
    /// enabled/key snapshot; sharing only reuses the transport connection pool.
    pub web_search: Arc<ExaClient>,
    /// Serializes the two-store Web Search capability snapshot (portable
    /// enable bit + machine-local key) with Settings mutations. All holders
    /// acquire it only on background executors.
    pub web_search_state: Arc<Mutex<()>>,
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

        let cipher = Arc::new(KeyringCredentialCipher::new(KEYCHAIN_SERVICE));
        let keys = Arc::new(ProviderKeysStore::new(
            local_root.clone(),
            KEYCHAIN_SERVICE,
            cipher.clone(),
        ));
        let pi_credentials = Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: local_root.join(PI_CREDENTIALS_FILE),
                cipher,
                sync_directory: None,
                on_durability_warning: None,
            },
        ));
        let codex_auth = Arc::new(StoreCodexAuth::new(pi_credentials));
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
        let web_search = Arc::new(ExaClient::new());
        let web_search_state = Arc::new(Mutex::new(()));

        Ok(Self {
            chat,
            config,
            keys,
            codex_auth,
            schedules,
            usage,
            mcp,
            web_search,
            web_search_state,
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

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::secret_map::{SecretCipher, SecretCipherError, KEYRING_MARKER};
    use aiden_providers::codex::{CodexProvider, CodexRuntimeErrorCode};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct TestCipher {
        entries: Mutex<HashMap<String, String>>,
        deleted: AtomicBool,
        fail_publish_path: Mutex<Option<PathBuf>>,
    }

    impl TestCipher {
        fn fail_next_document_publish(&self, path: PathBuf) {
            *self.fail_publish_path.lock().unwrap() = Some(path);
        }
    }

    impl SecretCipher for TestCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.entries
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(KEYRING_MARKER.to_vec())
        }

        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            if value != KEYRING_MARKER {
                return Err(SecretCipherError::UnrecognizedFormat);
            }
            self.entries
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .ok_or(SecretCipherError::SecureStorageUnavailable)
        }

        fn delete_entry(&self, account: &str) -> Result<(), SecretCipherError> {
            self.entries.lock().unwrap().remove(account);
            self.deleted.store(true, Ordering::Release);
            if let Some(path) = self.fail_publish_path.lock().unwrap().take() {
                std::fs::remove_file(&path).unwrap();
                std::fs::create_dir(&path).unwrap();
            }
            Ok(())
        }
    }

    fn auth_store() -> (tempfile::TempDir, Arc<StoreCodexAuth>) {
        let (directory, auth, _) = auth_store_with_cipher();
        (directory, auth)
    }

    fn auth_store_with_cipher() -> (tempfile::TempDir, Arc<StoreCodexAuth>, Arc<TestCipher>) {
        let directory = tempfile::tempdir().unwrap();
        let cipher = Arc::new(TestCipher::default());
        let credentials = Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: directory.path().join(PI_CREDENTIALS_FILE),
                cipher: cipher.clone(),
                sync_directory: Some(Box::new(|_| Ok(()))),
                on_durability_warning: None,
            },
        ));
        (
            directory,
            Arc::new(StoreCodexAuth::new(credentials)),
            cipher,
        )
    }

    fn signed_in_credential() -> OAuthCredential {
        // Header and signature are intentionally inert; Codex only decodes the
        // JWT payload to recover the ChatGPT account id before sending.
        OAuthCredential {
            access: "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xMjMifX0.sig".into(),
            refresh: "refresh-token".into(),
            // The encrypted credential document uses a signed millisecond
            // timestamp on disk; keep the fixture inside that wire range.
            expires: 4_000_000_000_000,
        }
    }

    #[tokio::test]
    async fn configured_codex_oauth_reaches_request_time_auth() {
        let (_directory, auth, cipher) = auth_store_with_cipher();
        let credential = signed_in_credential();
        auth.write(Some(&credential)).unwrap();

        let durable_values = cipher.entries.lock().unwrap().clone();
        assert!(durable_values
            .values()
            .any(|value| value.contains("\"accountId\":\"acct_123\"")));

        assert_eq!(auth.read().unwrap(), Some(credential));
        assert_eq!(
            <StoreCodexAuth as CodexAuthStore>::status(auth.as_ref()).unwrap(),
            CodexAuthStoreStatus {
                configured: true,
                needs_attention: false,
            }
        );
        let snapshot = auth.provider_snapshot();
        assert!(snapshot.configured);
        assert!(!snapshot.needs_attention);
        assert!(snapshot.models.iter().any(|model| model.id == "gpt-5.4"));
        CodexProvider::new(auth)
            .prepare_runtime_model("gpt-5.4")
            .await
            .expect("a configured Codex sign-in should pass request-time auth");
    }

    #[tokio::test]
    async fn missing_codex_oauth_fails_closed_with_sign_in_required() {
        let (_directory, auth) = auth_store();
        assert_eq!(
            <StoreCodexAuth as CodexAuthStore>::status(auth.as_ref()).unwrap(),
            CodexAuthStoreStatus {
                configured: false,
                needs_attention: false,
            }
        );
        assert!(!auth.provider_snapshot().configured);
        let error = CodexProvider::new(auth)
            .prepare_runtime_model("gpt-5.4")
            .await
            .expect_err("a missing credential must never produce an unsigned request");

        assert_eq!(error.code, CodexRuntimeErrorCode::SignInRequired);
        assert!(error.message.contains("Sign in with ChatGPT"));
    }

    #[test]
    fn legacy_marker_is_configured_and_attention_while_status_failure_is_not_attention() {
        let (directory, auth) = auth_store();
        std::fs::write(
            directory.path().join(PI_CREDENTIALS_FILE),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "entries": {
                    "openai-codex": {
                        "type": "oauth",
                        "ciphertext": "ZWxlY3Ryb24tc2FmZS1zdG9yYWdl"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let legacy = auth.provider_snapshot();
        assert!(legacy.configured);
        assert!(legacy.needs_attention);

        std::fs::remove_file(directory.path().join(PI_CREDENTIALS_FILE)).unwrap();
        std::fs::create_dir(directory.path().join(PI_CREDENTIALS_FILE)).unwrap();
        let unavailable = auth.provider_snapshot();
        assert!(!unavailable.configured);
        assert!(!unavailable.needs_attention);
    }

    #[test]
    fn stale_refresh_cannot_replace_a_newer_sign_in() {
        let (_directory, auth) = auth_store();
        let original = signed_in_credential();
        auth.write(Some(&original)).unwrap();
        let original_revision = credential_revision(Some(&original)).unwrap();

        let replacement = OAuthCredential {
            access: original.access.clone(),
            refresh: "replacement-refresh".into(),
            expires: original.expires - 1,
        };
        auth.write(Some(&replacement)).unwrap();
        let stale_refresh = OAuthCredential {
            access: original.access,
            refresh: "stale-refresh".into(),
            expires: original.expires - 2,
        };

        assert!(!auth
            .write_if_revision(&original_revision, &stale_refresh)
            .unwrap());
        assert_eq!(auth.read().unwrap(), Some(replacement));
    }

    #[test]
    fn stale_refresh_cannot_restore_a_logout() {
        let (_directory, auth) = auth_store();
        let original = signed_in_credential();
        auth.write(Some(&original)).unwrap();
        let original_revision = credential_revision(Some(&original)).unwrap();
        auth.write(None).unwrap();
        let stale_refresh = OAuthCredential {
            access: original.access,
            refresh: "stale-refresh".into(),
            expires: original.expires - 1,
        };

        assert!(!auth
            .write_if_revision(&original_revision, &stale_refresh)
            .unwrap());
        assert_eq!(auth.read().unwrap(), None);
    }

    #[tokio::test]
    async fn dispatch_guard_is_atomically_invalidated_by_a_credential_mutation() {
        let (_directory, auth) = auth_store();
        let original = signed_in_credential();
        auth.write(Some(&original)).unwrap();
        let original_revision = credential_revision(Some(&original)).unwrap();
        let mut guard = auth
            .begin_dispatch(&original_revision)
            .unwrap()
            .expect("the current revision should receive a dispatch guard");

        let replacement = OAuthCredential {
            access: original.access,
            refresh: "replacement-refresh".into(),
            expires: original.expires - 1,
        };
        auth.write(Some(&replacement)).unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(1), guard.changed())
            .await
            .expect("the old generation guard should be cancelled");
        assert!(auth.begin_dispatch(&original_revision).unwrap().is_none());
        let replacement_revision = credential_revision(Some(&replacement)).unwrap();
        assert!(auth
            .begin_dispatch(&replacement_revision)
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn failed_logout_document_publish_still_invalidates_active_guard() {
        let (directory, auth, cipher) = auth_store_with_cipher();
        let original = signed_in_credential();
        auth.write(Some(&original)).unwrap();
        let revision = credential_revision(Some(&original)).unwrap();
        let mut guard = auth
            .begin_dispatch(&revision)
            .unwrap()
            .expect("the current revision should receive a dispatch guard");

        // Sabotage the destination from the Keychain deletion callback, which
        // runs after the document read but before its replacement is published.
        // A directory at the file path makes the staged-file rename fail on
        // every supported platform, independent of process permissions.
        cipher.fail_next_document_publish(directory.path().join(PI_CREDENTIALS_FILE));
        let logout = auth.write(None);

        assert!(logout.is_err(), "document publication should be rejected");
        assert!(
            cipher.deleted.load(Ordering::Acquire),
            "the Keychain-backed secret must be deleted before document publication"
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), guard.changed())
            .await
            .expect("a partial logout must cancel the old credential generation");
    }
}
