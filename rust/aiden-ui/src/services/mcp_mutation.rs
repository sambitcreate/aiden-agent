//! App-owned MCP configuration authority.
//!
//! Portable MCP records, their bound preset credentials, and the process-wide
//! client manager must move together.  Keeping those operations here prevents
//! Settings (or a future onboarding flow) from publishing a record that chat
//! has not fenced.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};

use aiden_data::config_store::{ConfigStore, ConfigStoreError};
use aiden_data::portable_config::McpServer;
use aiden_data::secret_map::{ProviderKeysError, ProviderKeysStore};
use aiden_mcp::credential_cleanup::{
    mcp_credential_cleanup_after_config, mcp_credential_connection_snapshot,
    mcp_runtime_connection_snapshot, parse_pending_mcp_credential_cleanup,
    pending_mcp_credential_cleanup_for_remove, pending_mcp_credential_cleanup_for_save,
    McpCredentialCleanupResolution, PendingMcpCredentialCleanupV1,
};
use aiden_mcp::oauth::{
    authorize_mcp_server, oauth_status, resolve_noninteractive_oauth, McpOAuthDeps, McpOAuthHttp,
    McpOAuthOperationGate, McpOAuthStatus, McpOAuthStore, OAUTH_PORT,
};
#[cfg(test)]
use aiden_mcp::oauth::{MemoryMcpOAuthStore, ReqwestMcpOAuthHttp};
use aiden_mcp::{preset_secret_id, McpClientManager, McpError, McpStatus};
use tokio_util::sync::CancellationToken;

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
    #[error("{0}")]
    OAuth(#[from] McpError),
    #[error("The isolated MCP operation could not be completed safely.")]
    Remote(#[source] aiden_mcp::subagent_remote::SubagentRemoteError),
}

pub struct SubagentMcpRemoteLease {
    authority: std::sync::Weak<McpMutationAuthority>,
    server: McpServer,
    epoch: u64,
    credential_revision: String,
    redact_text: Box<dyn Fn(&str) -> String + Send + Sync>,
    client: aiden_mcp::subagent_remote::SubagentRemoteClient,
}

impl SubagentMcpRemoteLease {
    pub(crate) fn server(&self) -> &McpServer {
        &self.server
    }

    pub fn credential_revision(&self) -> &str {
        &self.credential_revision
    }

    pub fn redact_credential_text(&self, text: &str) -> String {
        (self.redact_text)(text)
    }

    pub async fn is_current(&self) -> bool {
        let Some(authority) = self.authority.upgrade() else {
            return false;
        };
        authority
            .subagent_lease_is_current(&self.server, self.epoch, &self.credential_revision)
            .await
    }

    pub async fn list_tools(&self) -> Result<Vec<aiden_mcp::McpToolInfo>, McpMutationError> {
        if !self.is_current().await {
            return Err(McpMutationError::Invalid);
        }
        let tools = self
            .client
            .list_tools()
            .await
            .map_err(McpMutationError::Remote)?;
        if !self.is_current().await {
            return Err(McpMutationError::Invalid);
        }
        Ok(tools)
    }

    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, McpMutationError> {
        if !self.is_current().await {
            return Err(McpMutationError::Invalid);
        }
        let result = self
            .client
            .call_tool(tool_name, arguments)
            .await
            .map_err(McpMutationError::Remote)?;
        if !self.is_current().await {
            return Err(McpMutationError::Invalid);
        }
        Ok(result)
    }

    pub async fn close(&self) {
        self.client.close().await;
    }
}

impl aiden_mcp::inventory::SubagentMcpClientPort for SubagentMcpRemoteLease {
    fn credential_revision(&self) -> &str {
        self.credential_revision()
    }

    fn credential_revision_is_current<'a>(
        &'a self,
        cancel: &'a CancellationToken,
    ) -> futures::future::BoxFuture<'a, bool> {
        Box::pin(async move { !cancel.is_cancelled() && self.is_current().await })
    }

    fn redact_credential_text(&self, text: &str) -> String {
        self.redact_credential_text(text)
    }

    fn list_tools<'a>(
        &'a self,
        cancel: &'a CancellationToken,
    ) -> futures::future::BoxFuture<'a, Result<Vec<aiden_mcp::McpToolInfo>, McpError>> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(McpError::Cancelled);
            }
            self.list_tools()
                .await
                .map_err(|_| McpError::Protocol("Isolated MCP inspection failed.".into()))
        })
    }
}

/// Serializes MCP mutation publication and owns its shared connection fence.
pub struct McpMutationAuthority {
    config: Arc<ConfigStore>,
    keys: Arc<ProviderKeysStore>,
    manager: Arc<McpClientManager>,
    oauth_store: Arc<dyn McpOAuthStore>,
    oauth_gate: Arc<McpOAuthOperationGate>,
    oauth_http: Arc<dyn McpOAuthHttp>,
    subagent_revision_key: Option<Vec<u8>>,
    epoch: AtomicU64,
    gate: tokio::sync::Mutex<()>,
    #[cfg(test)]
    fail_cleanup: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    before_runtime_admission: std::sync::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

const CLEANUP_JOURNAL_KEY: &str = "pendingMcpCredentialCleanup";

fn preset_key_mutation_authority() -> &'static Mutex<()> {
    static AUTHORITY: OnceLock<Mutex<()>> = OnceLock::new();
    AUTHORITY.get_or_init(|| Mutex::new(()))
}

struct MutationFence<'a>(&'a McpMutationAuthority);

impl Drop for MutationFence<'_> {
    fn drop(&mut self) {
        self.0.invalidate();
    }
}

impl McpMutationAuthority {
    #[cfg(test)]
    pub fn new(
        config: Arc<ConfigStore>,
        keys: Arc<ProviderKeysStore>,
        manager: Arc<McpClientManager>,
    ) -> Self {
        Self::new_with_oauth(
            config,
            keys,
            manager,
            Arc::new(MemoryMcpOAuthStore::new()),
            Arc::new(McpOAuthOperationGate::new()),
            Arc::new(ReqwestMcpOAuthHttp::default()),
        )
    }

    pub fn new_with_oauth(
        config: Arc<ConfigStore>,
        keys: Arc<ProviderKeysStore>,
        manager: Arc<McpClientManager>,
        oauth_store: Arc<dyn McpOAuthStore>,
        oauth_gate: Arc<McpOAuthOperationGate>,
        oauth_http: Arc<dyn McpOAuthHttp>,
    ) -> Self {
        Self {
            config,
            keys,
            manager,
            oauth_store,
            oauth_gate,
            oauth_http,
            subagent_revision_key: aiden_mcp::subagent_credential_revision_key().ok(),
            epoch: AtomicU64::new(0),
            gate: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            fail_cleanup: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            before_runtime_admission: std::sync::Mutex::new(None),
        }
    }

    pub fn manager(&self) -> &Arc<McpClientManager> {
        &self.manager
    }

    fn subagent_credential_boundary(
        &self,
        spec: &aiden_mcp::McpServerSpec,
    ) -> Result<aiden_subagents::mcp::SubagentMcpCredentialBoundary, McpMutationError> {
        let revision_key = self
            .subagent_revision_key
            .clone()
            .ok_or(McpMutationError::Invalid)?;
        let configured_headers = spec
            .remote
            .as_ref()
            .map(|remote| {
                remote
                    .headers
                    .iter()
                    .map(|(name, value)| (name.clone(), value.clone()))
                    .collect::<std::collections::BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        aiden_subagents::mcp::create_subagent_mcp_credential_boundary(
            aiden_subagents::mcp::CreateSubagentMcpCredentialBoundaryInput {
                revision_key,
                configured_headers: Some(configured_headers),
                endpoint_credentials: None,
                preset_api_key: None,
                oauth_authorization_binding: None,
                oauth_client_id: None,
                oauth_token_type: None,
                oauth_scope: None,
                oauth_code_verifier: None,
                oauth_client_secret: None,
                oauth_tokens: None,
                oauth_generation: None,
            },
        )
        .map_err(|_| McpMutationError::Invalid)
    }

    pub fn subagent_remote_servers(&self) -> Result<Vec<McpServer>, McpMutationError> {
        Ok(self
            .config
            .list_mcp_servers()
            .map_err(McpMutationError::Config)?
            .into_iter()
            .filter(|server| {
                server.enabled
                    && matches!(
                        server.transport,
                        aiden_data::portable_config::McpTransport::Http
                            | aiden_data::portable_config::McpTransport::Sse
                    )
            })
            .collect())
    }

    pub async fn open_subagent_remote(
        self: &Arc<Self>,
        server_id: &str,
        cancelled: CancellationToken,
    ) -> Result<SubagentMcpRemoteLease, McpMutationError> {
        self.open_subagent_remote_inner(server_id, None, cancelled)
            .await
    }

    pub async fn open_bound_subagent_remote(
        self: &Arc<Self>,
        server_id: &str,
        expected_connection_fingerprint: &str,
        cancelled: CancellationToken,
    ) -> Result<SubagentMcpRemoteLease, McpMutationError> {
        self.open_subagent_remote_inner(server_id, Some(expected_connection_fingerprint), cancelled)
            .await
    }

    async fn open_subagent_remote_inner(
        self: &Arc<Self>,
        server_id: &str,
        expected_connection_fingerprint: Option<&str>,
        cancelled: CancellationToken,
    ) -> Result<SubagentMcpRemoteLease, McpMutationError> {
        let epoch = self.epoch();
        let server = self
            .subagent_remote_servers()?
            .into_iter()
            .find(|server| server.id == server_id)
            .ok_or(McpMutationError::Missing)?;
        let spec = self.resolve_runtime_spec_at_epoch(&server, epoch).await?;
        let credential_boundary = self.subagent_credential_boundary(&spec)?;
        let credential_revision = credential_boundary.revision.clone();
        if expected_connection_fingerprint.is_some_and(|expected| {
            aiden_mcp::inventory::subagent_mcp_connection_fingerprint(&server, &credential_revision)
                .map_or(true, |actual| actual != expected)
        }) {
            return Err(McpMutationError::Invalid);
        }
        let client = aiden_mcp::subagent_remote::SubagentRemoteClient::connect(&spec, cancelled)
            .await
            .map_err(McpMutationError::Remote)?;
        let lease = SubagentMcpRemoteLease {
            authority: Arc::downgrade(self),
            server,
            epoch,
            credential_revision,
            redact_text: credential_boundary.redact_text,
            client,
        };
        if !lease.is_current().await {
            lease.close().await;
            return Err(McpMutationError::Invalid);
        }
        Ok(lease)
    }

    pub async fn subagent_credential_revision(
        &self,
        server: &McpServer,
        cancelled: &CancellationToken,
    ) -> Result<String, McpMutationError> {
        if cancelled.is_cancelled() {
            return Err(McpMutationError::OAuth(McpError::Cancelled));
        }
        let epoch = self.epoch();
        let current = self
            .subagent_remote_servers()?
            .into_iter()
            .find(|candidate| candidate.id == server.id)
            .ok_or(McpMutationError::Missing)?;
        if mcp_runtime_connection_snapshot(&current) != mcp_runtime_connection_snapshot(server) {
            return Err(McpMutationError::Invalid);
        }
        let spec = self.resolve_runtime_spec_at_epoch(&current, epoch).await?;
        if self.epoch() != epoch || cancelled.is_cancelled() {
            return Err(McpMutationError::Invalid);
        }
        Ok(self.subagent_credential_boundary(&spec)?.revision)
    }

    async fn subagent_lease_is_current(
        &self,
        server: &McpServer,
        epoch: u64,
        credential_revision: &str,
    ) -> bool {
        if self.epoch() != epoch {
            return false;
        }
        let current = self.config.list_mcp_servers().ok().and_then(|servers| {
            servers
                .into_iter()
                .find(|candidate| candidate.id == server.id)
        });
        let Some(current) = current.filter(|candidate| {
            candidate.enabled
                && candidate.transport == server.transport
                && mcp_runtime_connection_snapshot(candidate)
                    == mcp_runtime_connection_snapshot(server)
        }) else {
            return false;
        };
        let Ok(spec) = self.resolve_runtime_spec_at_epoch(&current, epoch).await else {
            return false;
        };
        self.epoch() == epoch
            && self
                .subagent_credential_boundary(&spec)
                .is_ok_and(|boundary| boundary.revision == credential_revision)
    }
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn set_cleanup_failure_for_test(&self, fail: bool) {
        self.fail_cleanup.store(fail, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn set_before_runtime_admission_for_test(&self, hook: Option<Arc<dyn Fn() + Send + Sync>>) {
        *self.before_runtime_admission.lock().unwrap() = hook;
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
        self.oauth_gate.invalidate(&server.id);
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
        self.oauth_gate.invalidate(server_id);
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
        match self.ensure_runtime_connected(server).await {
            Ok(spec) => match self.manager.list_tools(&spec.server.id).await {
                Ok(tools) => McpStatus {
                    connected: true,
                    tool_count: tools.len(),
                    tools: tools.into_iter().map(|tool| tool.name).collect(),
                    error: None,
                },
                Err(error) => McpStatus {
                    connected: false,
                    tool_count: 0,
                    tools: Vec::new(),
                    error: Some(error.to_string()),
                },
            },
            Err(error) => McpStatus {
                connected: false,
                tool_count: 0,
                tools: Vec::new(),
                error: Some(error.to_string()),
            },
        }
    }

    pub fn oauth_status(&self, server: &McpServer) -> Result<McpOAuthStatus, McpMutationError> {
        let spec = aiden_mcp::resolve_mcp_server(server).map_err(|_| McpMutationError::Invalid)?;
        oauth_status(&spec, self.oauth_store.as_ref()).map_err(McpMutationError::OAuth)
    }

    pub async fn authorize(
        &self,
        server_id: &str,
        open_browser: &aiden_mcp::oauth::OpenBrowserFn,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), McpMutationError> {
        let server = self
            .config
            .list_mcp_servers()
            .map_err(McpMutationError::Config)?
            .into_iter()
            .find(|server| server.id == server_id)
            .ok_or(McpMutationError::Missing)?;
        let spec = aiden_mcp::resolve_mcp_server(&server).map_err(|_| McpMutationError::Invalid)?;
        if !server.oauth.unwrap_or(false) {
            return Err(McpMutationError::Invalid);
        }
        authorize_mcp_server(
            &spec,
            McpOAuthDeps {
                store: self.oauth_store.as_ref(),
                gate: self.oauth_gate.as_ref(),
                http: self.oauth_http.as_ref(),
                verifier: self.manager.as_ref(),
                is_current,
                open_browser: Some(open_browser),
                port: OAUTH_PORT,
            },
        )
        .await?;
        self.manager.disconnect(server_id).await;
        self.invalidate();
        Ok(())
    }

    pub async fn cancel_authorization(&self, server_id: &str) {
        self.oauth_gate.invalidate(server_id);
        self.manager.disconnect(server_id).await;
        self.invalidate();
    }

    pub async fn revoke_oauth(&self, server_id: &str) -> Result<(), McpMutationError> {
        let _guard = self.gate.lock().await;
        let _final_fence = MutationFence(self);
        self.oauth_gate.invalidate(server_id);
        self.invalidate();
        self.manager.disconnect(server_id).await;
        self.oauth_store.clear(server_id)?;
        self.invalidate();
        Ok(())
    }

    pub async fn ensure_runtime_connected(
        &self,
        server: &McpServer,
    ) -> Result<aiden_mcp::McpServerSpec, McpMutationError> {
        let epoch = self.epoch();
        let spec = self.resolve_runtime_spec_at_epoch(server, epoch).await?;
        #[cfg(test)]
        if let Some(hook) = self.before_runtime_admission.lock().unwrap().clone() {
            hook();
        }
        self.manager
            .ensure_connected_with_current(&spec, &|| self.epoch() == epoch)
            .await
            .map_err(McpMutationError::OAuth)?;
        Ok(spec)
    }

    async fn resolve_runtime_spec_at_epoch(
        &self,
        server: &McpServer,
        epoch: u64,
    ) -> Result<aiden_mcp::McpServerSpec, McpMutationError> {
        let spec = self.resolve_bound_spec(server)?;
        resolve_noninteractive_oauth(
            spec,
            self.oauth_store.as_ref(),
            self.oauth_gate.as_ref(),
            self.oauth_http.as_ref(),
            &|| self.epoch() == epoch,
        )
        .await
        .map_err(McpMutationError::OAuth)
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
        if let Ok(servers) = self.config.list_mcp_servers() {
            for server in servers {
                self.oauth_gate.invalidate(&server.id);
            }
        }
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
        self.oauth_gate.invalidate(id);
        self.invalidate();
        self.manager.disconnect_blocking(id);
        if previous.map(mcp_credential_connection_snapshot)
            != current.map(mcp_credential_connection_snapshot)
        {
            self.delete_preset_slot(id)?;
        }
        self.reconcile_oauth(previous, current)?;
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
                    self.oauth_gate.invalidate(&server.id);
                    self.oauth_store.clear(&server.id)?;
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
        self.oauth_gate.invalidate(&pending.server_id);
        self.manager.disconnect_blocking(&pending.server_id);
        let resolution = mcp_credential_cleanup_after_config(&pending, current.as_ref());
        if let McpCredentialCleanupResolution::Resolved {
            clear_oauth,
            clear_preset_key,
        } = resolution
        {
            if clear_preset_key {
                self.keys
                    .delete(&preset_secret_id(&pending.server_id))
                    .map_err(McpMutationError::Credentials)?;
            }
            if clear_oauth {
                self.oauth_store.clear(&pending.server_id)?;
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
        self.reconcile_oauth(previous, current)?;
        Ok(())
    }

    fn reconcile_oauth(
        &self,
        previous: Option<&McpServer>,
        current: Option<&McpServer>,
    ) -> Result<(), McpMutationError> {
        let Some(previous) = previous.filter(|server| server.oauth.unwrap_or(false)) else {
            return Ok(());
        };
        let still_same_binding = current.is_some_and(|current| {
            current.oauth.unwrap_or(false)
                && current.url.as_deref() == previous.url.as_deref()
                && current.transport == previous.transport
        });
        if !still_same_binding {
            self.oauth_gate.invalidate(&previous.id);
            self.oauth_store.clear(&previous.id)?;
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
        // Settings may issue a clear while a replacement save is settling.
        // Serialize the key operations themselves so a late clear cannot
        // delete the replacement written by the next editor revision.
        let _key_guard = preset_key_mutation_authority().lock().map_err(|_| {
            McpMutationError::Credentials(ProviderKeysError::SecureStorage(
                "MCP credential coordinator unavailable".into(),
            ))
        })?;
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
        self.invalidate();
        self.manager.disconnect_blocking(server_id);
        let slot = preset_secret_id(server_id);
        let result = match key.filter(|key| !key.trim().is_empty()) {
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
        };
        self.invalidate();
        result
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

    #[derive(Default)]
    struct FailClearOAuthStore {
        inner: MemoryMcpOAuthStore,
    }

    impl McpOAuthStore for FailClearOAuthStore {
        fn get(&self, server_id: &str) -> Result<aiden_mcp::oauth::McpOAuthSession, McpError> {
            self.inner.get(server_id)
        }

        fn set(
            &self,
            server_id: &str,
            session: &aiden_mcp::oauth::McpOAuthSession,
        ) -> Result<(), McpError> {
            self.inner.set(server_id, session)
        }

        fn clear(&self, _server_id: &str) -> Result<(), McpError> {
            Err(McpError::OAuthStore("injected clear failure".into()))
        }
    }
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

    fn authority_fixture_with_oauth() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        McpMutationAuthority,
        Arc<MemoryMcpOAuthStore>,
    ) {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let keys = Arc::new(ProviderKeysStore::new(
            local.path().to_path_buf(),
            "aiden-mcp-oauth-test",
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
        let oauth = Arc::new(MemoryMcpOAuthStore::new());
        let authority = McpMutationAuthority::new_with_oauth(
            config,
            keys,
            Arc::new(McpClientManager::new()),
            oauth.clone(),
            Arc::new(McpOAuthOperationGate::new()),
            Arc::new(ReqwestMcpOAuthHttp::default()),
        );
        (portable, local, authority, oauth)
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
    fn preset_clear_then_replacement_keeps_the_latest_bound_key() {
        let (_portable, _local, authority) = authority_fixture();
        let preset = aiden_mcp::get_mcp_preset("composio").unwrap();
        let server = aiden_mcp::server_from_preset(preset, None).unwrap();
        authority.config.save_mcp_server(&server, &|| true).unwrap();
        authority
            .set_or_clear_preset_key(&server.id, Some("old-key"))
            .unwrap();
        authority.set_or_clear_preset_key(&server.id, None).unwrap();
        authority
            .set_or_clear_preset_key(&server.id, Some("replacement-key"))
            .unwrap();
        assert_eq!(
            authority.bound_preset_key(&server).unwrap().as_deref(),
            Some("replacement-key")
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
        let authority = Arc::new(authority);
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

        authority.set_cleanup_failure_for_test(false);
        let recovery = authority.clone();
        tokio::task::spawn_blocking(move || recovery.reconcile_boot())
            .await
            .unwrap()
            .unwrap();
        assert!(!authority
            .config
            .get_settings()
            .unwrap()
            .contains_key(CLEANUP_JOURNAL_KEY));
    }

    #[tokio::test]
    async fn oauth_revoke_failure_still_advances_authority_fence() {
        let (_portable, _local, base) = authority_fixture();
        let authority = McpMutationAuthority::new_with_oauth(
            base.config.clone(),
            base.keys.clone(),
            base.manager.clone(),
            Arc::new(FailClearOAuthStore::default()),
            Arc::new(McpOAuthOperationGate::new()),
            Arc::new(ReqwestMcpOAuthHttp::default()),
        );
        let before = authority.epoch();

        assert!(authority.revoke_oauth("mcp-test").await.is_err());
        assert!(authority.epoch() > before);
    }

    #[test]
    fn boot_recovery_revokes_oauth_when_the_connection_reached_its_replacement() {
        let (_portable, _local, authority, oauth) = authority_fixture_with_oauth();
        let mut previous = server();
        previous.oauth = Some(true);
        previous.url = Some("https://mcp.example/old".into());
        authority
            .config
            .save_mcp_server(&previous, &|| true)
            .unwrap();
        oauth
            .set(
                &previous.id,
                &aiden_mcp::oauth::McpOAuthSession {
                    authorization_binding: previous.url.clone(),
                    tokens: Some(aiden_mcp::oauth::McpOAuthTokens {
                        access_token: "secret-access".into(),
                        token_type: "Bearer".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut target = previous.clone();
        target.url = Some("https://mcp.example/new".into());
        let pending = pending_mcp_credential_cleanup_for_save(Some(&previous), &target).unwrap();
        authority.write_journal(Some(&pending)).unwrap();
        authority.config.save_mcp_server(&target, &|| true).unwrap();

        authority.reconcile_boot().unwrap();
        assert_eq!(
            oauth.get(&previous.id).unwrap(),
            aiden_mcp::oauth::McpOAuthSession::default()
        );
        assert!(!authority
            .config
            .get_settings()
            .unwrap()
            .contains_key(CLEANUP_JOURNAL_KEY));
    }

    #[tokio::test]
    async fn removal_aborts_an_inflight_oauth_generation_before_publication() {
        let (_portable, _local, authority, _oauth) = authority_fixture_with_oauth();
        let record = server();
        authority.config.save_mcp_server(&record, &|| true).unwrap();
        let operation = authority.oauth_gate.begin(&record.id).unwrap();

        authority.remove(&record.id).await.unwrap();
        assert!(operation.aborted());
        assert!(authority.config.list_mcp_servers().unwrap().is_empty());
    }

    #[test]
    fn mutation_between_oauth_resolution_and_manager_admission_rejects_stale_spec() {
        let (_portable, _local, authority) = authority_fixture();
        let authority = Arc::new(authority);
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        authority.set_before_runtime_admission_for_test(Some(Arc::new({
            let entered = entered.clone();
            let release = release.clone();
            move || {
                entered.wait();
                release.wait();
            }
        })));
        let record = server();
        let worker = {
            let authority = authority.clone();
            std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(authority.ensure_runtime_connected(&record))
            })
        };

        entered.wait();
        authority.invalidate();
        release.wait();

        assert!(matches!(
            worker.join().unwrap(),
            Err(McpMutationError::OAuth(McpError::StaleGeneration))
        ));
    }
}
