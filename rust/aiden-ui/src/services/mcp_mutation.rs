//! App-owned MCP configuration authority.
//!
//! Portable MCP records, their bound preset credentials, and the process-wide
//! client manager must move together.  Keeping those operations here prevents
//! Settings (or a future onboarding flow) from publishing a record that chat
//! has not fenced.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_data::config_store::{ConfigStore, ConfigStoreError};
use aiden_data::portable_config::McpServer;
use aiden_data::secret_map::{ProviderKeysError, ProviderKeysStore};
use aiden_mcp::credential_cleanup::{
    mcp_credential_cleanup_after_config, mcp_credential_connection_snapshot,
    mcp_runtime_connection_snapshot, parse_pending_mcp_credential_cleanup,
    pending_mcp_credential_cleanup_for_remove, pending_mcp_credential_cleanup_for_save,
    McpCredentialCleanupResolution, PendingMcpCredentialCleanupV1,
};
use aiden_mcp::{preset_secret_id, McpClientManager, McpStatus};

/// Errors intentionally contain no endpoint headers, arguments, or secrets.
#[derive(Debug, thiserror::Error)]
pub enum McpMutationError {
    #[error("MCP configuration could not be read or saved.")]
    Config(#[source] ConfigStoreError),
    #[error("MCP credential storage is unavailable.")]
    Credentials(#[source] ProviderKeysError),
    #[error("The requested MCP server no longer exists.")]
    Missing,
    #[error("The MCP server record is invalid.")]
    Invalid,
}

/// Serializes MCP mutation publication and owns its shared connection fence.
pub struct McpMutationAuthority {
    config: Arc<ConfigStore>,
    keys: Arc<ProviderKeysStore>,
    manager: Arc<McpClientManager>,
    epoch: AtomicU64,
    gate: tokio::sync::Mutex<()>,
    #[cfg(test)]
    fail_cleanup: std::sync::atomic::AtomicBool,
}

const CLEANUP_JOURNAL_KEY: &str = "pendingMcpCredentialCleanup";

struct MutationFence<'a>(&'a McpMutationAuthority);

impl Drop for MutationFence<'_> {
    fn drop(&mut self) {
        self.0.invalidate();
    }
}

impl McpMutationAuthority {
    pub fn new(
        config: Arc<ConfigStore>,
        keys: Arc<ProviderKeysStore>,
        manager: Arc<McpClientManager>,
    ) -> Self {
        Self {
            config,
            keys,
            manager,
            epoch: AtomicU64::new(0),
            gate: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            fail_cleanup: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn manager(&self) -> &Arc<McpClientManager> {
        &self.manager
    }
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn set_cleanup_failure_for_test(&self, fail: bool) {
        self.fail_cleanup.store(fail, Ordering::SeqCst);
    }

    fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.manager.invalidate_config();
    }

    /// Save an exact portable record after fencing the old connection.
    pub async fn save(&self, server: McpServer) -> Result<McpServer, McpMutationError> {
        validate_portable_server(&server)?;
        let _guard = self.gate.lock().await;
        let current = self
            .config
            .list_mcp_servers()
            .map_err(McpMutationError::Config)?
            .into_iter()
            .find(|candidate| candidate.id == server.id);
        let pending = pending_mcp_credential_cleanup_for_save(current.as_ref(), &server);
        self.write_journal(pending.as_ref())?;
        self.invalidate();
        let _final_fence = MutationFence(self);
        self.manager.disconnect(&server.id).await;
        let publication_epoch = self.epoch();
        let saved = self
            .config
            .save_mcp_server(&server, &|| self.epoch() == publication_epoch)
            .map_err(McpMutationError::Config)?;
        self.reconcile_credentials(current.as_ref(), Some(&saved))?;
        self.clear_journal()?;
        self.invalidate();
        Ok(saved)
    }

    pub async fn remove(&self, server_id: &str) -> Result<(), McpMutationError> {
        let _guard = self.gate.lock().await;
        let current = self
            .config
            .list_mcp_servers()
            .map_err(McpMutationError::Config)?
            .into_iter()
            .find(|candidate| candidate.id == server_id);
        let Some(current) = current else {
            return Err(McpMutationError::Missing);
        };
        let pending = pending_mcp_credential_cleanup_for_remove(Some(&current), server_id);
        self.write_journal(pending.as_ref())?;
        self.invalidate();
        let _final_fence = MutationFence(self);
        self.manager.disconnect(server_id).await;
        let publication_epoch = self.epoch();
        self.config
            .remove_mcp_server(server_id, &|| self.epoch() == publication_epoch)
            .map_err(McpMutationError::Config)?;
        self.reconcile_credentials(Some(&current), None)?;
        self.clear_journal()?;
        self.invalidate();
        Ok(())
    }

    pub async fn toggle(
        &self,
        server_id: &str,
        enabled: bool,
    ) -> Result<McpServer, McpMutationError> {
        let current = self
            .config
            .list_mcp_servers()
            .map_err(McpMutationError::Config)?
            .into_iter()
            .find(|candidate| candidate.id == server_id)
            .ok_or(McpMutationError::Missing)?;
        let mut target = current;
        target.enabled = enabled;
        self.save(target).await
    }

    pub async fn status(&self, server: &McpServer) -> McpStatus {
        match self.resolve_bound_spec(server) {
            Ok(spec) => self.manager.status(&spec).await,
            Err(error) => McpStatus {
                connected: false,
                tool_count: 0,
                tools: Vec::new(),
                error: Some(error.to_string()),
            },
        }
    }

    fn resolve_bound_spec(
        &self,
        server: &McpServer,
    ) -> Result<aiden_mcp::McpServerSpec, McpMutationError> {
        let spec = aiden_mcp::resolve_mcp_server(server).map_err(|_| McpMutationError::Invalid)?;
        if !spec.requires_preset_api_key() {
            return Ok(spec);
        }
        let key = self
            .bound_preset_key(server)?
            .ok_or(McpMutationError::Invalid)?;
        spec.with_preset_api_key(key)
            .map_err(|_| McpMutationError::Invalid)
    }

    pub async fn reset_connections(&self) {
        self.invalidate();
        self.manager.close_all().await;
        self.invalidate();
    }

    /// Reconcile a hand-edited portable record on the watcher thread.  There
    /// is no trustworthy transaction or credential binding across that edit,
    /// so an uncertain changed connection is revoked before it can reconnect.
    pub fn reconcile_external(
        &self,
        previous: Option<&McpServer>,
        current: Option<&McpServer>,
    ) -> Result<(), McpMutationError> {
        let id = previous.or(current).map(|server| server.id.as_str());
        let Some(id) = id else { return Ok(()) };
        if previous.map(mcp_runtime_connection_snapshot)
            == current.map(mcp_runtime_connection_snapshot)
        {
            return Ok(());
        }
        let pending = match current {
            Some(current) => pending_mcp_credential_cleanup_for_save(previous, current),
            None => pending_mcp_credential_cleanup_for_remove(previous, id),
        };
        self.write_journal(pending.as_ref())?;
        self.invalidate();
        self.manager.disconnect_blocking(id);
        if previous.map(mcp_credential_connection_snapshot)
            != current.map(mcp_credential_connection_snapshot)
        {
            self.delete_preset_slot(id)?;
        }
        self.clear_journal()?;
        self.invalidate();
        Ok(())
    }

    /// Replay a journal left by a crash. Any malformed or uncertain entry is
    /// cleared only after its affected bound credential has been revoked.
    pub fn reconcile_boot(&self) -> Result<(), McpMutationError> {
        let settings = self
            .config
            .get_settings()
            .map_err(McpMutationError::Config)?;
        let Some(value) = settings.get(CLEANUP_JOURNAL_KEY) else {
            return Ok(());
        };
        let servers = self
            .config
            .list_mcp_servers()
            .map_err(McpMutationError::Config)?;
        let pending = match parse_pending_mcp_credential_cleanup(value) {
            Ok(pending) => pending,
            Err(_) => {
                // There is no safe identity to preserve from a malformed
                // journal, so fail closed for every configured MCP slot.
                for server in &servers {
                    self.keys
                        .delete(&preset_secret_id(&server.id))
                        .map_err(McpMutationError::Credentials)?;
                    self.manager.disconnect_blocking(&server.id);
                }
                self.clear_journal()?;
                self.invalidate();
                return Err(McpMutationError::Invalid);
            }
        };
        let current = servers
            .into_iter()
            .find(|server| server.id == pending.server_id);
        self.invalidate();
        self.manager.disconnect_blocking(&pending.server_id);
        let resolution = mcp_credential_cleanup_after_config(&pending, current.as_ref());
        if let McpCredentialCleanupResolution::Resolved {
            clear_preset_key, ..
        } = resolution
        {
            if clear_preset_key {
                self.keys
                    .delete(&preset_secret_id(&pending.server_id))
                    .map_err(McpMutationError::Credentials)?;
            }
        }
        self.clear_journal()?;
        self.invalidate();
        Ok(())
    }

    fn write_journal(
        &self,
        pending: Option<&PendingMcpCredentialCleanupV1>,
    ) -> Result<(), McpMutationError> {
        let Some(pending) = pending else {
            return Ok(());
        };
        let mut patch = serde_json::Map::new();
        patch.insert(
            CLEANUP_JOURNAL_KEY.into(),
            serde_json::to_value(pending)
                .map_err(|error| McpMutationError::Config(ConfigStoreError::Json(error)))?,
        );
        let epoch = self.epoch();
        self.config
            .set_settings(&patch, &|| self.epoch() == epoch)
            .map_err(McpMutationError::Config)?;
        Ok(())
    }

    fn clear_journal(&self) -> Result<(), McpMutationError> {
        let epoch = self.epoch();
        self.config
            .remove_setting(CLEANUP_JOURNAL_KEY, &|| self.epoch() == epoch)
            .map_err(McpMutationError::Config)?;
        Ok(())
    }

    fn reconcile_credentials(
        &self,
        previous: Option<&McpServer>,
        current: Option<&McpServer>,
    ) -> Result<(), McpMutationError> {
        let changed = previous.map(mcp_credential_connection_snapshot)
            != current.map(mcp_credential_connection_snapshot);
        if !changed {
            return Ok(());
        }
        if let Some(previous) = previous {
            // Bound slots are keyed by the portable server id and the complete
            // connection snapshot. Any endpoint/auth/preset edit therefore
            // makes the former key unreadable before it is removed.
            self.delete_preset_slot(&previous.id)?;
        }
        Ok(())
    }

    fn delete_preset_slot(&self, server_id: &str) -> Result<(), McpMutationError> {
        #[cfg(test)]
        if self.fail_cleanup.load(Ordering::SeqCst) {
            return Err(McpMutationError::Credentials(
                ProviderKeysError::SecureStorage("injected cleanup failure".into()),
            ));
        }
        self.keys
            .delete(&preset_secret_id(server_id))
            .map_err(McpMutationError::Credentials)
    }

    #[allow(dead_code)] // OAuth/preset editor is the follow-on slice.
    pub fn set_or_clear_preset_key(
        &self,
        server_id: &str,
        key: Option<&str>,
    ) -> Result<(), McpMutationError> {
        let server = self
            .config
            .list_mcp_servers()
            .map_err(McpMutationError::Config)?
            .into_iter()
            .find(|candidate| candidate.id == server_id)
            .ok_or(McpMutationError::Missing)?;
        if !aiden_mcp::config::preset_requires_api_key(&server)
            .map_err(|_| McpMutationError::Invalid)?
        {
            return Err(McpMutationError::Invalid);
        }
        let slot = preset_secret_id(server_id);
        match key.filter(|key| !key.trim().is_empty()) {
            Some(key) => self
                .keys
                .set_bound(
                    &slot,
                    key,
                    &serde_json::to_string(&mcp_credential_connection_snapshot(&server))
                        .unwrap_or_default(),
                )
                .map_err(McpMutationError::Credentials),
            None => self
                .keys
                .delete(&slot)
                .map_err(McpMutationError::Credentials),
        }
    }

    pub fn bound_preset_key(&self, server: &McpServer) -> Result<Option<String>, McpMutationError> {
        let slot = preset_secret_id(&server.id);
        self.keys
            .get_bound(
                &slot,
                &serde_json::to_string(&mcp_credential_connection_snapshot(server))
                    .unwrap_or_default(),
            )
            .map_err(McpMutationError::Credentials)
    }
}

fn validate_portable_server(server: &McpServer) -> Result<(), McpMutationError> {
    let valid_text = |value: &str, maximum: usize| {
        !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
    };
    if !valid_text(&server.id, 256) || !valid_text(&server.name, 256) {
        return Err(McpMutationError::Invalid);
    }
    if server
        .url
        .as_deref()
        .is_some_and(|value| !valid_text(value, 4096))
        || server
            .command
            .as_deref()
            .is_some_and(|value| !valid_text(value, 4096))
        || server.args.as_ref().is_some_and(|args| {
            args.len() > 128
                || args
                    .iter()
                    .any(|value| value.len() > 4096 || value.contains('\0'))
        })
        || [server.env.as_ref(), server.headers.as_ref()]
            .into_iter()
            .flatten()
            .any(|map| {
                map.len() > 64
                    || map.iter().any(|(key, value)| {
                        key.is_empty()
                            || key.len() > 256
                            || value.len() > 4096
                            || key.chars().any(char::is_control)
                            || value.contains('\0')
                    })
            })
    {
        return Err(McpMutationError::Invalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::portable_config::McpTransport;
    use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
    use aiden_data::secret_map::{SecretCipher, SecretCipherError};
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryCipher(Mutex<HashMap<String, String>>);

    impl SecretCipher for MemoryCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }
        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(format!("encrypted:{value}").into_bytes())
        }
        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            let value = String::from_utf8_lossy(value)
                .trim_start_matches("encrypted:")
                .to_string();
            (self.0.lock().unwrap().get(account) == Some(&value))
                .then_some(value)
                .ok_or(SecretCipherError::UnrecognizedFormat)
        }
    }

    fn authority_fixture() -> (tempfile::TempDir, tempfile::TempDir, McpMutationAuthority) {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let keys = Arc::new(ProviderKeysStore::new(
            local.path().to_path_buf(),
            "aiden-mcp-test",
            Arc::new(MemoryCipher::default()),
        ));
        let stores = create_portable_config_stores(
            portable.path().to_path_buf(),
            Some(local.path().to_path_buf()),
            PortableConfigTestHooks::default(),
        );
        let config = Arc::new(ConfigStore::new(
            stores,
            Arc::new(crate::services::stores::StoreSecretsPort::new(keys.clone())),
            None,
        ));
        (
            portable,
            local,
            McpMutationAuthority::new(config, keys, Arc::new(McpClientManager::new())),
        )
    }

    fn server() -> McpServer {
        McpServer {
            id: "mcp-test".into(),
            name: "Test".into(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some("https://mcp.example".into()),
            headers: None,
            oauth: None,
            preset_id: None,
            enabled: true,
        }
    }

    #[test]
    fn portable_mutations_reject_oversized_headers() {
        let mut server = server();
        server.headers = Some(std::collections::BTreeMap::from([(
            "authorization".into(),
            "x".repeat(4097),
        )]));
        assert!(matches!(
            validate_portable_server(&server),
            Err(McpMutationError::Invalid)
        ));
    }

    #[test]
    fn portable_mutations_accept_a_bounded_server() {
        assert!(validate_portable_server(&server()).is_ok());
    }

    #[test]
    fn preset_binding_excludes_runtime_name_and_enablement() {
        let first = server();
        let mut renamed_disabled = first.clone();
        renamed_disabled.name = "Renamed".into();
        renamed_disabled.enabled = false;
        assert_eq!(
            mcp_credential_connection_snapshot(&first),
            mcp_credential_connection_snapshot(&renamed_disabled)
        );
    }

    #[test]
    fn status_resolution_requires_bound_key_and_rotations_change_fingerprint() {
        let (_portable, _local, authority) = authority_fixture();
        let preset = aiden_mcp::get_mcp_preset("composio").unwrap();
        let server = aiden_mcp::server_from_preset(preset, None).unwrap();
        authority.config.save_mcp_server(&server, &|| true).unwrap();
        assert!(authority.resolve_bound_spec(&server).is_err());
        authority
            .set_or_clear_preset_key(&server.id, Some("key-a"))
            .unwrap();
        let keyed_a = authority.resolve_bound_spec(&server).unwrap();
        authority
            .set_or_clear_preset_key(&server.id, Some("key-b"))
            .unwrap();
        let keyed_b = authority.resolve_bound_spec(&server).unwrap();
        assert_ne!(
            aiden_mcp::client::spec_fingerprint(&keyed_a),
            aiden_mcp::client::spec_fingerprint(&keyed_b)
        );
    }

    #[test]
    fn malformed_boot_journal_revokes_credentials_and_is_removed() {
        let (_portable, _local, authority) = authority_fixture();
        let preset = aiden_mcp::get_mcp_preset("composio").unwrap();
        let server = aiden_mcp::server_from_preset(preset, None).unwrap();
        authority.config.save_mcp_server(&server, &|| true).unwrap();
        authority
            .set_or_clear_preset_key(&server.id, Some("secret"))
            .unwrap();
        let mut patch = serde_json::Map::new();
        patch.insert(
            CLEANUP_JOURNAL_KEY.into(),
            serde_json::json!({"version": 1}),
        );
        authority.config.set_settings(&patch, &|| true).unwrap();
        assert!(matches!(
            authority.reconcile_boot(),
            Err(McpMutationError::Invalid)
        ));
        assert!(authority.bound_preset_key(&server).unwrap().is_none());
        assert!(!authority
            .config
            .get_settings()
            .unwrap()
            .contains_key(CLEANUP_JOURNAL_KEY));
    }

    #[tokio::test]
    async fn cleanup_failure_after_publication_still_advances_final_fence() {
        let (_portable, _local, authority) = authority_fixture();
        let mut initial = server();
        initial.url = Some("https://first.example".into());
        authority
            .config
            .save_mcp_server(&initial, &|| true)
            .unwrap();
        let mut target = initial.clone();
        target.url = Some("https://second.example".into());
        authority.fail_cleanup.store(true, Ordering::SeqCst);
        let before = authority.epoch();
        assert!(matches!(
            authority.save(target.clone()).await,
            Err(McpMutationError::Credentials(_))
        ));
        assert!(authority.epoch() > before);
        assert_eq!(
            authority.config.list_mcp_servers().unwrap()[0].url,
            target.url
        );
        assert!(authority
            .config
            .get_settings()
            .unwrap()
            .contains_key(CLEANUP_JOURNAL_KEY));
    }
}
