//! Encrypted, device-local MCP OAuth session persistence.
//!
//! The JSON document contains only opaque Keychain markers, binding hashes,
//! and crash-recovery metadata. Dynamic registration data, PKCE verifiers,
//! access tokens, and refresh tokens live exclusively in revision-scoped
//! Keychain accounts. A durable pending record denies reads while a rotation
//! or revocation is between publications; reopening deterministically rolls a
//! partial rotation back and completes a partial revocation.

use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    secret_map::{SecretCipher, SecretCipherError},
    DataStore, DataStoreError, DataStoreOptions,
};

const STORE_VERSION: u8 = 1;
const MAX_SERVER_ID_LEN: usize = 128;

#[derive(Debug, Error)]
pub enum McpOAuthStoreError {
    #[error("Invalid MCP OAuth server identifier.")]
    InvalidServerId,
    #[error("Secure storage is unavailable; MCP OAuth credentials cannot be accessed.")]
    SecureStorageUnavailable,
    #[error("Stored MCP OAuth credentials need rotation.")]
    NeedsRotation,
    #[error("Stored MCP OAuth credentials are invalid or corrupted.")]
    InvalidOrCorrupted,
    #[error("MCP OAuth credential operation was superseded.")]
    Superseded,
    #[error("MCP OAuth store error: {0}")]
    Store(#[from] DataStoreError),
    #[error("MCP OAuth encryption error: {0}")]
    Cipher(String),
    #[error("MCP OAuth serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSession {
    account: String,
    ciphertext: String,
    binding_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PendingKind {
    Replace,
    CleanupPrevious,
    CleanupStaged,
    Revoke,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingMutation {
    kind: PendingKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<StoredSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    staged_account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuthDocument {
    version: u8,
    #[serde(default)]
    entries: BTreeMap<String, StoredSession>,
    #[serde(default)]
    pending: BTreeMap<String, PendingMutation>,
}

impl Default for OAuthDocument {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            entries: BTreeMap::new(),
            pending: BTreeMap::new(),
        }
    }
}

/// Construction options for [`EncryptedMcpOAuthStore`].
pub struct EncryptedMcpOAuthStoreOptions {
    pub root: PathBuf,
    pub cipher: Arc<dyn SecretCipher>,
}

/// Production MCP OAuth store backed by `mcp-oauth.json` plus the OS
/// Keychain. All public methods are serialized so reads observe every mutation
/// admitted before them.
pub struct EncryptedMcpOAuthStore {
    document: DataStore<OAuthDocument>,
    cipher: Arc<dyn SecretCipher>,
    gate: Mutex<()>,
}

impl EncryptedMcpOAuthStore {
    pub fn new(options: EncryptedMcpOAuthStoreOptions) -> Self {
        let document = DataStore::new(
            "mcp-oauth.json",
            OAuthDocument::default(),
            Some(options.root),
            DataStoreOptions {
                preserve_corrupt_file: false,
                normalize: None,
                is_safe: Some(Box::new(|value: &Value| {
                    serde_json::from_value::<OAuthDocument>(value.clone())
                        .ok()
                        .is_some_and(|document| {
                            document.version == STORE_VERSION
                                && document.entries.keys().all(|id| valid_server_id(id))
                                && document.pending.keys().all(|id| valid_server_id(id))
                        })
                })),
                reload_before_write: true,
                reject_corrupt_write: true,
                reject_unsafe_write: true,
                ..DataStoreOptions::default()
            },
        );
        Self {
            document,
            cipher: options.cipher,
            gate: Mutex::new(()),
        }
    }

    fn ensure_encryption(&self) -> Result<(), McpOAuthStoreError> {
        self.cipher
            .is_encryption_available()
            .then_some(())
            .ok_or(McpOAuthStoreError::SecureStorageUnavailable)
    }

    fn load_safe(&self) -> Result<OAuthDocument, McpOAuthStoreError> {
        let document = self.document.load()?;
        if self.document.loaded_from_corrupt_file()?
            || self.document.loaded_from_unsafe_file()?
            || document.version != STORE_VERSION
        {
            return Err(McpOAuthStoreError::InvalidOrCorrupted);
        }
        Ok(document)
    }

    fn recover_pending(&self, server_id: &str) -> Result<(), McpOAuthStoreError> {
        let document = self.load_safe()?;
        let Some(pending) = document.pending.get(server_id).cloned() else {
            return Ok(());
        };
        match pending.kind {
            PendingKind::Replace => {
                if let Some(account) = pending.staged_account.as_deref() {
                    self.cipher
                        .delete_entry(account)
                        .map_err(|error| McpOAuthStoreError::Cipher(error.to_string()))?;
                }
                let recoverable_previous = pending.previous.as_ref().is_some_and(|previous| {
                    crate::base64::decode(&previous.ciphertext).is_some_and(|ciphertext| {
                        self.cipher
                            .decrypt_string(&previous.account, &ciphertext)
                            .is_ok()
                    })
                });
                self.document.update(|document| {
                    if let Some(previous) =
                        pending.previous.clone().filter(|_| recoverable_previous)
                    {
                        document.entries.insert(server_id.to_string(), previous);
                    } else {
                        document.entries.remove(server_id);
                    }
                    document.pending.remove(server_id);
                })?;
            }
            PendingKind::CleanupPrevious => {
                if let Some(previous) = pending.previous.as_ref() {
                    self.cipher
                        .delete_entry(&previous.account)
                        .map_err(|error| McpOAuthStoreError::Cipher(error.to_string()))?;
                }
                self.document.update(|document| {
                    document.pending.remove(server_id);
                })?;
            }
            PendingKind::CleanupStaged => {
                if let Some(account) = pending.staged_account.as_deref() {
                    self.cipher
                        .delete_entry(account)
                        .map_err(|error| McpOAuthStoreError::Cipher(error.to_string()))?;
                }
                self.document.update(|document| {
                    document.pending.remove(server_id);
                })?;
            }
            PendingKind::Revoke => {
                if let Some(previous) = pending.previous.as_ref() {
                    self.cipher
                        .delete_entry(&previous.account)
                        .map_err(|error| McpOAuthStoreError::Cipher(error.to_string()))?;
                }
                self.document.update(|document| {
                    document.entries.remove(server_id);
                    document.pending.remove(server_id);
                })?;
            }
        }
        Ok(())
    }

    /// Read and decrypt one session. `expected_binding_hash`, when supplied,
    /// prevents credentials from being returned for a reconfigured endpoint.
    pub fn get(
        &self,
        server_id: &str,
        expected_binding_hash: Option<&str>,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<Option<Value>, McpOAuthStoreError> {
        validate_server_id(server_id)?;
        let _guard = self.gate.lock();
        assert_current(is_current)?;
        self.recover_pending(server_id)?;
        assert_current(is_current)?;
        let document = self.load_safe()?;
        let Some(entry) = document.entries.get(server_id) else {
            return Ok(None);
        };
        if expected_binding_hash.is_some_and(|expected| expected != entry.binding_hash) {
            return Ok(None);
        }
        self.ensure_encryption()?;
        let bytes = crate::base64::decode(&entry.ciphertext)
            .ok_or(McpOAuthStoreError::InvalidOrCorrupted)?;
        let plaintext = match self.cipher.decrypt_string(&entry.account, &bytes) {
            Ok(value) => value,
            Err(SecretCipherError::NeedsRotation) => return Err(McpOAuthStoreError::NeedsRotation),
            Err(error) => return Err(McpOAuthStoreError::Cipher(error.to_string())),
        };
        assert_current(is_current)?;
        let value =
            serde_json::from_str(&plaintext).map_err(|_| McpOAuthStoreError::InvalidOrCorrupted)?;
        Ok(Some(value))
    }

    /// Atomically replace a session. The previous revision remains recoverable
    /// until the new encrypted value and final document are both durable.
    pub fn set(
        &self,
        server_id: &str,
        binding: &str,
        session: &Value,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), McpOAuthStoreError> {
        validate_server_id(server_id)?;
        if binding.is_empty() || !session.is_object() {
            return Err(McpOAuthStoreError::InvalidOrCorrupted);
        }
        let _guard = self.gate.lock();
        assert_current(is_current)?;
        self.recover_pending(server_id)?;
        self.ensure_encryption()?;
        let previous = self.load_safe()?.entries.get(server_id).cloned();
        self.document
            .update_with_current(
                |document| {
                    document.pending.insert(
                        server_id.to_string(),
                        PendingMutation {
                            kind: PendingKind::Replace,
                            previous: previous.clone(),
                            staged_account: None,
                        },
                    );
                },
                is_current,
            )
            .map_err(map_current_store_error)?;
        assert_current(is_current)?;
        let account = format!("mcp-oauth:{server_id}:{}", crate::unique_id());
        if let Err(error) = self.document.update_with_current(
            |document| {
                if let Some(pending) = document.pending.get_mut(server_id) {
                    pending.staged_account = Some(account.clone());
                }
            },
            is_current,
        ) {
            self.recover_pending(server_id)?;
            return Err(map_current_store_error(error));
        }
        let plaintext = serde_json::to_string(session)?;
        let encrypted = match self.cipher.encrypt_string(&account, &plaintext) {
            Ok(encrypted) => encrypted,
            Err(error) => {
                self.recover_pending(server_id)?;
                return Err(McpOAuthStoreError::Cipher(error.to_string()));
            }
        };
        assert_current(is_current)?;
        let entry = StoredSession {
            account: account.clone(),
            ciphertext: crate::base64::encode(&encrypted),
            binding_hash: binding_hash(binding),
        };
        if let Err(error) = self.document.update_with_current(
            |document| {
                document
                    .entries
                    .insert(server_id.to_string(), entry.clone());
            },
            is_current,
        ) {
            self.recover_pending(server_id)?;
            return Err(map_current_store_error(error));
        }
        if let Err(error) = assert_current(is_current) {
            self.recover_pending(server_id)?;
            return Err(error);
        }
        if let Err(error) = self.document.update_with_current(
            |document| {
                if let Some(pending) = document.pending.get_mut(server_id) {
                    pending.kind = PendingKind::CleanupPrevious;
                }
            },
            is_current,
        ) {
            self.recover_pending(server_id)?;
            return Err(map_current_store_error(error));
        }
        if let Err(error) = assert_current(is_current) {
            self.document.update(|document| {
                if let Some(previous) = previous.clone() {
                    document.entries.insert(server_id.to_string(), previous);
                } else {
                    document.entries.remove(server_id);
                }
                document.pending.insert(
                    server_id.to_string(),
                    PendingMutation {
                        kind: PendingKind::CleanupStaged,
                        previous: None,
                        staged_account: Some(account.clone()),
                    },
                );
            })?;
            // The prior session is already authoritative again. Cleanup is
            // retried durably on reopen if the Keychain is unavailable now.
            let _ = self.recover_pending(server_id);
            return Err(error);
        }
        self.recover_pending(server_id)?;
        Ok(())
    }

    /// Durably revoke one session. Once admitted, a crash or cancellation can
    /// leave only a deny marker; restart recovery completes the revocation.
    pub fn clear(
        &self,
        server_id: &str,
        is_current: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), McpOAuthStoreError> {
        validate_server_id(server_id)?;
        let _guard = self.gate.lock();
        assert_current(is_current)?;
        self.recover_pending(server_id)?;
        let previous = self.load_safe()?.entries.get(server_id).cloned();
        self.document
            .update_with_current(
                |document| {
                    document.pending.insert(
                        server_id.to_string(),
                        PendingMutation {
                            kind: PendingKind::Revoke,
                            previous: previous.clone(),
                            staged_account: None,
                        },
                    );
                },
                is_current,
            )
            .map_err(map_current_store_error)?;
        // Revocation intentionally completes after admission even when the
        // initiating UI generation becomes stale.
        self.document.update(|document| {
            document.entries.remove(server_id);
        })?;
        if let Some(previous) = previous {
            self.cipher
                .delete_entry(&previous.account)
                .map_err(|error| McpOAuthStoreError::Cipher(error.to_string()))?;
        }
        self.document.update(|document| {
            document.pending.remove(server_id);
        })?;
        Ok(())
    }

    #[cfg(test)]
    fn raw_document(&self) -> Result<String, McpOAuthStoreError> {
        std::fs::read_to_string(self.document.path()?)
            .map_err(DataStoreError::Io)
            .map_err(McpOAuthStoreError::Store)
    }
}

fn valid_server_id(server_id: &str) -> bool {
    !server_id.is_empty()
        && server_id.len() <= MAX_SERVER_ID_LEN
        && server_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn validate_server_id(server_id: &str) -> Result<(), McpOAuthStoreError> {
    valid_server_id(server_id)
        .then_some(())
        .ok_or(McpOAuthStoreError::InvalidServerId)
}

fn assert_current(is_current: &(dyn Fn() -> bool + Send + Sync)) -> Result<(), McpOAuthStoreError> {
    is_current()
        .then_some(())
        .ok_or(McpOAuthStoreError::Superseded)
}

fn map_current_store_error(error: DataStoreError) -> McpOAuthStoreError {
    match error {
        DataStoreError::DocumentInactive => McpOAuthStoreError::Superseded,
        other => McpOAuthStoreError::Store(other),
    }
}

pub fn binding_hash(binding: &str) -> String {
    format!("{:x}", Sha256::digest(binding.as_bytes()))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex as StdMutex,
        },
    };

    use super::*;

    #[derive(Default)]
    struct TestCipher {
        values: StdMutex<HashMap<String, String>>,
        fail_delete: AtomicBool,
    }

    impl SecretCipher for TestCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.values
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(crate::secret_map::KEYRING_MARKER.to_vec())
        }

        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            if value != crate::secret_map::KEYRING_MARKER {
                return Err(SecretCipherError::NeedsRotation);
            }
            self.values
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .ok_or(SecretCipherError::UnrecognizedFormat)
        }

        fn delete_entry(&self, account: &str) -> Result<(), SecretCipherError> {
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(SecretCipherError::Keychain(
                    "injected delete failure".into(),
                ));
            }
            self.values.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn fixture() -> (tempfile::TempDir, Arc<TestCipher>, EncryptedMcpOAuthStore) {
        let directory = tempfile::tempdir().unwrap();
        let cipher = Arc::new(TestCipher::default());
        let store = EncryptedMcpOAuthStore::new(EncryptedMcpOAuthStoreOptions {
            root: directory.path().to_path_buf(),
            cipher: cipher.clone(),
        });
        (directory, cipher, store)
    }

    #[test]
    fn encrypted_session_reopens_without_plaintext_and_requires_exact_binding() {
        let (directory, cipher, store) = fixture();
        let session = serde_json::json!({
            "authorizationBinding": "https://mcp.example.test/mcp",
            "tokens": { "access_token": "access-secret", "refresh_token": "refresh-secret" }
        });
        store
            .set("docs", "https://mcp.example.test/mcp", &session, &|| true)
            .unwrap();
        let raw = store.raw_document().unwrap();
        assert!(!raw.contains("access-secret"));
        assert!(!raw.contains("refresh-secret"));
        assert!(!raw.contains("https://mcp.example.test"));

        let reopened = EncryptedMcpOAuthStore::new(EncryptedMcpOAuthStoreOptions {
            root: directory.path().to_path_buf(),
            cipher,
        });
        assert_eq!(
            reopened
                .get(
                    "docs",
                    Some(&binding_hash("https://mcp.example.test/mcp")),
                    &|| true
                )
                .unwrap(),
            Some(session)
        );
        assert!(reopened
            .get(
                "docs",
                Some(&binding_hash("https://other.example.test/mcp")),
                &|| true
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn rotation_replaces_keychain_revision_and_revoke_survives_reopen() {
        let (directory, cipher, store) = fixture();
        let first = serde_json::json!({"authorizationBinding":"https://mcp.example","tokens":{"access_token":"one"}});
        let second = serde_json::json!({"authorizationBinding":"https://mcp.example","tokens":{"access_token":"two"}});
        store
            .set("docs", "https://mcp.example", &first, &|| true)
            .unwrap();
        store
            .set("docs", "https://mcp.example", &second, &|| true)
            .unwrap();
        assert_eq!(cipher.values.lock().unwrap().len(), 1);
        store.clear("docs", &|| true).unwrap();

        let reopened = EncryptedMcpOAuthStore::new(EncryptedMcpOAuthStoreOptions {
            root: directory.path().to_path_buf(),
            cipher: cipher.clone(),
        });
        assert!(reopened.get("docs", None, &|| true).unwrap().is_none());
        assert!(cipher.values.lock().unwrap().is_empty());
    }

    #[test]
    fn stale_rotation_never_replaces_the_previous_session() {
        let (_directory, _cipher, store) = fixture();
        let first = serde_json::json!({"authorizationBinding":"https://mcp.example","tokens":{"access_token":"one"}});
        let second = serde_json::json!({"authorizationBinding":"https://mcp.example","tokens":{"access_token":"two"}});
        store
            .set("docs", "https://mcp.example", &first, &|| true)
            .unwrap();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let current = || calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 < 3;
        assert!(matches!(
            store.set("docs", "https://mcp.example", &second, &current),
            Err(McpOAuthStoreError::Superseded)
        ));
        assert_eq!(store.get("docs", None, &|| true).unwrap(), Some(first));
    }

    #[test]
    fn ownership_loss_after_replacement_publication_restores_exact_previous_session() {
        let (directory, cipher, store) = fixture();
        let first = serde_json::json!({"authorizationBinding":"https://mcp.example","tokens":{"access_token":"one"}});
        let second = serde_json::json!({"authorizationBinding":"https://mcp.example","tokens":{"access_token":"two"}});
        store
            .set("docs", "https://mcp.example", &first, &|| true)
            .unwrap();
        let path = directory.path().join("mcp-oauth.json");
        let current = || {
            std::fs::read_to_string(&path)
                .map(|document| !document.contains("cleanup_previous"))
                .unwrap_or(true)
        };

        assert!(matches!(
            store.set("docs", "https://mcp.example", &second, &current),
            Err(McpOAuthStoreError::Superseded)
        ));
        assert_eq!(store.get("docs", None, &|| true).unwrap(), Some(first));
        assert_eq!(cipher.values.lock().unwrap().len(), 1);
        let raw = store.raw_document().unwrap();
        assert!(!raw.contains("cleanup_previous"));
        assert!(!raw.contains("cleanup_staged"));
    }

    #[test]
    fn committed_replacement_cleanup_failure_retries_without_reviving_previous_session() {
        let (_directory, cipher, store) = fixture();
        let first = serde_json::json!({"authorizationBinding":"https://mcp.example","tokens":{"access_token":"one"}});
        let second = serde_json::json!({"authorizationBinding":"https://mcp.example","tokens":{"access_token":"two"}});
        store
            .set("docs", "https://mcp.example", &first, &|| true)
            .unwrap();
        cipher.fail_delete.store(true, Ordering::SeqCst);

        assert!(store
            .set("docs", "https://mcp.example", &second, &|| true)
            .is_err());
        assert!(store.raw_document().unwrap().contains("cleanup_previous"));
        assert!(store.get("docs", None, &|| true).is_err());

        cipher.fail_delete.store(false, Ordering::SeqCst);
        assert_eq!(store.get("docs", None, &|| true).unwrap(), Some(second));
        assert!(!store.raw_document().unwrap().contains("cleanup_previous"));
        assert_eq!(cipher.values.lock().unwrap().len(), 1);
    }

    #[test]
    fn corrupt_and_future_documents_fail_closed_without_overwrite() {
        for contents in ["{broken", r#"{"version":2,"entries":{},"pending":{}}"#] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("mcp-oauth.json");
            std::fs::write(&path, contents).unwrap();
            let store = EncryptedMcpOAuthStore::new(EncryptedMcpOAuthStoreOptions {
                root: directory.path().to_path_buf(),
                cipher: Arc::new(TestCipher::default()),
            });
            assert!(matches!(
                store.get("docs", None, &|| true),
                Err(McpOAuthStoreError::InvalidOrCorrupted)
            ));
            assert!(store
                .set(
                    "docs",
                    "https://mcp.example",
                    &serde_json::json!({"tokens": {"access_token": "new"}}),
                    &|| true,
                )
                .is_err());
            assert_eq!(std::fs::read_to_string(path).unwrap(), contents);
        }
    }

    #[test]
    fn revoke_deny_marker_survives_cleanup_failure_and_retries() {
        let (_directory, cipher, store) = fixture();
        store
            .set(
                "docs",
                "https://mcp.example",
                &serde_json::json!({"tokens": {"access_token": "secret"}}),
                &|| true,
            )
            .unwrap();
        cipher.fail_delete.store(true, Ordering::SeqCst);
        assert!(store.clear("docs", &|| true).is_err());
        let pending = store.raw_document().unwrap();
        assert!(pending.contains("revoke"));
        assert!(store.get("docs", None, &|| true).is_err());

        cipher.fail_delete.store(false, Ordering::SeqCst);
        assert!(store.get("docs", None, &|| true).unwrap().is_none());
        assert!(!store.raw_document().unwrap().contains("revoke"));
        assert!(cipher.values.lock().unwrap().is_empty());
    }
}
