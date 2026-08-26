//! Encrypted Pi credential store (port of
//! `main/services/pi-credential-store-core.ts`).
//!
//! Aiden stores one credential per provider in
//! `<userData>/pi-provider-credentials.json`:
//!
//! ```json
//! { "version": 2, "entries": { "<providerId>": { "type": "api_key", "ciphertext": "<base64>", "account": "<versioned-keychain-account>" } } }
//! ```
//!
//! The Electron app encrypted the credential JSON with `safeStorage`; those
//! blobs are **not decryptable outside Electron**. This port keeps the exact
//! file layout but writes credentials through the injected
//! [`SecretCipher`] seam (production: the `keyring` crate, macOS Keychain),
//! whose ciphertext slot holds a fixed base64 marker (`base64("aiden-k1:")`)
//! while the plaintext lives in the Keychain under the versioned account named
//! by the document entry. Older Rust entries without `account` continue to use
//! the original fixed provider account and migrate on their next successful
//! write. Version 2 is deliberate: Electron only understands version 1, so it
//! fails closed instead of silently dropping Rust's account references.
//! Reading a legacy safeStorage blob fails with
//! [`PiCredentialError::NeedsRotation`] so the UI can prompt re-entry.
//!
//! Serialized read-modify-write is preserved: a per-provider mutex (shared
//! process-wide across store instances by resolved file path, exactly like the
//! TS `sharedMutexes`) serializes `modify`/`delete` for one provider, and a
//! single document mutex serializes the whole-file RMW so concurrent updates
//! to different providers never lose entries.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use crate::secret_map::{SecretCipher, SecretCipherError, KEYRING_MARKER};

#[derive(Debug, thiserror::Error)]
pub enum PiCredentialError {
    #[error("Invalid provider credential identifier.")]
    InvalidProviderId,
    #[error("Stored provider credential is invalid.")]
    InvalidCredential,
    #[error("Stored API-key credential is invalid.")]
    InvalidApiKeyCredential,
    #[error("Stored API-key credential environment is invalid.")]
    InvalidApiKeyCredentialEnv,
    #[error("Stored OAuth credential is invalid.")]
    InvalidOAuthCredential,
    #[error("Provider credential store is not valid JSON.")]
    NotJson,
    #[error("Provider credential store has an invalid shape.")]
    InvalidShape,
    #[error("Provider credential store version is unsupported.")]
    UnsupportedVersion,
    #[error("Provider credential store contains an invalid entry.")]
    InvalidEntry,
    #[error("Secure storage is unavailable; provider credentials cannot be accessed.")]
    SecureStorageUnavailable,
    #[error("Stored provider credential could not be decrypted.")]
    CouldNotDecrypt,
    #[error("stored provider credential is a legacy Electron safeStorage blob and needs rotation")]
    NeedsRotation,
    #[error("Stored provider credential is invalid or corrupted.")]
    InvalidOrCorrupted,
    #[error("Stored provider credential metadata does not match its encrypted value.")]
    MetadataMismatch,
    #[error("provider credential write failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

/// Keychain account namespace for pi-provider-credentials.json slots, kept
/// distinct from the provider-keys.json namespace.
fn legacy_keychain_account(provider_id: &str) -> String {
    format!("pi-provider-credentials:{provider_id}")
}

fn versioned_keychain_account(provider_id: &str) -> String {
    format!(
        "pi-provider-credentials:{provider_id}:{}",
        crate::unique_id()
    )
}

fn is_versioned_keychain_account(provider_id: &str, account: &str) -> bool {
    let prefix = format!("pi-provider-credentials:{provider_id}:");
    account.strip_prefix(&prefix).is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 128
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn is_provider_keychain_account(provider_id: &str, account: &str) -> bool {
    account == legacy_keychain_account(provider_id)
        || is_versioned_keychain_account(provider_id, account)
}

/// A validated stored credential: the same loose JSON shape TS validates with
/// `validateCredential` (an `api_key` with optional `key`/`env`, or an `oauth`
/// with string `access`/`refresh` and a finite numeric `expires`).
pub type Credential = serde_json::Value;

/// Metadata listing item: provider id + stored credential kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialInfo {
    pub provider_id: String,
    pub r#type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    pub r#type: String,
    pub ciphertext: String,
    /// Absent only for credentials written by the first Rust implementation,
    /// which used one fixed account per provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialDocument {
    pub version: u8,
    pub entries: BTreeMap<String, StoredCredential>,
    /// Superseded versioned secrets awaiting best-effort Keychain deletion.
    /// Keeping the cleanup intent durable prevents a transient Keychain error
    /// from turning an old token into a permanently forgotten orphan.
    #[serde(
        default,
        rename = "orphanedSecrets",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub orphaned_secrets: Vec<OrphanedSecret>,
    /// Accounts reserved durably before their Keychain value is created. A
    /// crash or failed rollback can therefore never lose the cleanup target.
    #[serde(
        default,
        rename = "pendingSecrets",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub pending_secrets: Vec<PendingSecret>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrphanedSecret {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub account: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingSecret {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub account: String,
}

impl CredentialDocument {
    fn empty() -> Self {
        Self {
            version: 2,
            entries: BTreeMap::new(),
            orphaned_secrets: Vec::new(),
            pending_secrets: Vec::new(),
        }
    }
}

// -- global per-file mutex registry (mirrors the TS sharedMutexes map) --------

fn shared_mutex(path: PathBuf, scope: &str) -> Arc<parking_lot::Mutex<()>> {
    type MutexKey = (PathBuf, String);
    static REGISTRY: OnceLock<StdMutex<BTreeMap<MutexKey, Arc<parking_lot::Mutex<()>>>>> =
        OnceLock::new();
    let registry = REGISTRY.get_or_init(|| StdMutex::new(BTreeMap::new()));
    let mut guard = registry.lock().unwrap();
    guard
        .entry((path, scope.to_string()))
        .or_insert_with(|| Arc::new(parking_lot::Mutex::new(())))
        .clone()
}

fn lexical_absolute(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

/// Resolve every existing ancestor so relative paths, `..`, and symlinked
/// directory aliases share one process-wide mutation lock even before the
/// credential file itself exists.
fn normalized_lock_identity(path: &Path) -> PathBuf {
    let absolute = lexical_absolute(path);
    let mut cursor = absolute.as_path();
    let mut suffix = Vec::<OsString>::new();
    loop {
        if let Ok(mut resolved) = fs::canonicalize(cursor) {
            for part in suffix.iter().rev() {
                resolved.push(part);
            }
            return resolved;
        }
        let Some(name) = cursor.file_name() else {
            return absolute;
        };
        suffix.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            return absolute;
        };
        cursor = parent;
    }
}

fn validate_provider_id(provider_id: &str) -> Result<(), PiCredentialError> {
    let mut chars = provider_id.chars();
    let first = chars.next();
    let ok = match first {
        Some(first) => {
            first.is_ascii_alphanumeric()
                && provider_id.len() <= 128
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
        }
        None => false,
    };
    if ok {
        Ok(())
    } else {
        Err(PiCredentialError::InvalidProviderId)
    }
}

/// Mirror of `validateCredential` in pi-credential-store-core.ts.
pub fn validate_credential(value: &serde_json::Value) -> Result<(), PiCredentialError> {
    let object = match value {
        serde_json::Value::Object(object) => object,
        _ => return Err(PiCredentialError::InvalidCredential),
    };
    match object.get("type").and_then(|value| value.as_str()) {
        Some("api_key") => {
            if let Some(key) = object.get("key") {
                if !key.is_string() {
                    return Err(PiCredentialError::InvalidApiKeyCredential);
                }
            }
            if let Some(env) = object.get("env") {
                if !env.is_object() {
                    return Err(PiCredentialError::InvalidApiKeyCredentialEnv);
                }
            }
            Ok(())
        }
        Some("oauth") => {
            let access = object.get("access").and_then(|value| value.as_str());
            let refresh = object.get("refresh").and_then(|value| value.as_str());
            let expires = object.get("expires").and_then(|value| value.as_f64());
            if access.is_some() && refresh.is_some() && expires.is_some() {
                Ok(())
            } else {
                Err(PiCredentialError::InvalidOAuthCredential)
            }
        }
        _ => Err(PiCredentialError::InvalidOAuthCredential),
    }
}

fn parse_document(text: &str) -> Result<CredentialDocument, PiCredentialError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| PiCredentialError::NotJson)?;
    let object = match &value {
        serde_json::Value::Object(object) => object,
        _ => return Err(PiCredentialError::InvalidShape),
    };
    let version = match object.get("version") {
        Some(serde_json::Value::Number(version)) => match version.as_u64() {
            Some(version @ (1 | 2)) => version as u8,
            _ => return Err(PiCredentialError::UnsupportedVersion),
        },
        _ => return Err(PiCredentialError::UnsupportedVersion),
    };
    let entries = match object.get("entries") {
        Some(serde_json::Value::Object(entries)) => entries,
        _ => return Err(PiCredentialError::UnsupportedVersion),
    };
    let mut parsed = BTreeMap::new();
    for (provider_id, raw_entry) in entries {
        validate_provider_id(provider_id)?;
        let entry = match raw_entry {
            serde_json::Value::Object(entry) => entry,
            _ => return Err(PiCredentialError::InvalidEntry),
        };
        let r#type = match entry.get("type").and_then(|value| value.as_str()) {
            Some(r#type @ ("api_key" | "oauth")) => r#type.to_string(),
            _ => return Err(PiCredentialError::InvalidEntry),
        };
        let ciphertext = match entry.get("ciphertext").and_then(|value| value.as_str()) {
            Some(ciphertext) if !ciphertext.is_empty() => ciphertext.to_string(),
            _ => return Err(PiCredentialError::InvalidEntry),
        };
        let account = match entry.get("account") {
            None => None,
            Some(serde_json::Value::String(account))
                if version == 2 && is_versioned_keychain_account(provider_id, account) =>
            {
                Some(account.clone())
            }
            Some(_) => return Err(PiCredentialError::InvalidEntry),
        };
        parsed.insert(
            provider_id.clone(),
            StoredCredential {
                r#type,
                ciphertext,
                account,
            },
        );
    }
    let orphaned_secrets = match object.get("orphanedSecrets") {
        None => Vec::new(),
        Some(serde_json::Value::Array(entries)) if version == 2 => {
            let mut parsed_orphans = Vec::with_capacity(entries.len());
            for entry in entries {
                let entry = entry.as_object().ok_or(PiCredentialError::InvalidEntry)?;
                let provider_id = entry
                    .get("providerId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(PiCredentialError::InvalidEntry)?;
                validate_provider_id(provider_id)?;
                let account = entry
                    .get("account")
                    .and_then(serde_json::Value::as_str)
                    .filter(|account| is_provider_keychain_account(provider_id, account))
                    .ok_or(PiCredentialError::InvalidEntry)?;
                parsed_orphans.push(OrphanedSecret {
                    provider_id: provider_id.to_string(),
                    account: account.to_string(),
                });
            }
            parsed_orphans
        }
        Some(_) => return Err(PiCredentialError::InvalidEntry),
    };
    let pending_secrets = match object.get("pendingSecrets") {
        None => Vec::new(),
        Some(serde_json::Value::Array(entries)) if version == 2 => {
            let mut parsed_pending = Vec::with_capacity(entries.len());
            for entry in entries {
                let entry = entry.as_object().ok_or(PiCredentialError::InvalidEntry)?;
                let provider_id = entry
                    .get("providerId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(PiCredentialError::InvalidEntry)?;
                validate_provider_id(provider_id)?;
                let account = entry
                    .get("account")
                    .and_then(serde_json::Value::as_str)
                    .filter(|account| is_versioned_keychain_account(provider_id, account))
                    .ok_or(PiCredentialError::InvalidEntry)?;
                parsed_pending.push(PendingSecret {
                    provider_id: provider_id.to_string(),
                    account: account.to_string(),
                });
            }
            parsed_pending
        }
        Some(_) => return Err(PiCredentialError::InvalidEntry),
    };
    Ok(CredentialDocument {
        version,
        entries: parsed,
        orphaned_secrets,
        pending_secrets,
    })
}

fn read_regular_file_after_open(
    path: &Path,
    after_open: impl FnOnce(),
) -> Result<Option<Vec<u8>>, std::io::Error> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);

    let mut handle = match options.open(path) {
        Ok(handle) => handle,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    // This is descriptor metadata (fstat), not another pathname lookup. A
    // concurrent rename/symlink swap therefore cannot change what is read.
    if !handle.metadata()?.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "credential store is not a regular file",
        ));
    }
    after_open();
    let mut bytes = Vec::new();
    handle.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn read_regular_file(path: &Path) -> Result<Option<Vec<u8>>, std::io::Error> {
    read_regular_file_after_open(path, || {})
}

fn write_document_durably(
    destination: &Path,
    document: &CredentialDocument,
    sync_directory: Option<&(dyn Fn(&Path) -> Result<(), std::io::Error> + Send + Sync)>,
    on_durability_warning: Option<&(dyn Fn(&std::io::Error) + Send + Sync)>,
) -> Result<(), PiCredentialError> {
    let directory = destination
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent dir"))?;
    // TS: `fs.mkdir(directory, { recursive: true, mode: 0o700 })` — the mode
    // applies only to directories this store actually creates.
    if !directory.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(directory)?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(directory)?;
    }
    let staged = directory.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        crate::unique_id()
    ));
    let serialized = serde_json::to_string_pretty(document)?;
    let result = (|| -> Result<(), PiCredentialError> {
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staged)?;
        handle.write_all(serialized.as_bytes())?;
        handle.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&staged, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result?;
    // Directory fsync is best-effort: a committed write stays successful when
    // the platform cannot fsync directories.
    let sync_result = match sync_directory {
        Some(sync) => sync(directory),
        None => {
            crate::sync_directory(directory).map_err(|err| std::io::Error::other(err.to_string()))
        }
    };
    if let Err(error) = sync_result {
        if let Some(report) = on_durability_warning {
            report(&error);
        }
    }
    Ok(())
}

/// Constructor options mirroring `EncryptedPiCredentialStoreOptions`.
pub struct EncryptedPiCredentialStoreOptions {
    pub file_path: PathBuf,
    pub cipher: Arc<dyn SecretCipher>,
    /// Test/diagnostic hooks.
    pub sync_directory: Option<Box<dyn Fn(&Path) -> Result<(), std::io::Error> + Send + Sync>>,
    pub on_durability_warning: Option<Box<dyn Fn(&std::io::Error) + Send + Sync>>,
}

/// The `pi-provider-credentials.json` store (see module docs).
pub struct EncryptedPiCredentialStore {
    options: EncryptedPiCredentialStoreOptions,
    lock_identity: PathBuf,
    #[cfg(test)]
    fail_document_write_countdown: AtomicUsize,
}

impl EncryptedPiCredentialStore {
    pub fn new(options: EncryptedPiCredentialStoreOptions) -> Self {
        let lock_identity = normalized_lock_identity(&options.file_path);
        Self {
            options,
            lock_identity,
            #[cfg(test)]
            fail_document_write_countdown: AtomicUsize::new(usize::MAX),
        }
    }

    fn mutex(&self, scope: &str) -> Arc<parking_lot::Mutex<()>> {
        shared_mutex(self.lock_identity.clone(), scope)
    }

    fn read_document_file(&self) -> Result<CredentialDocument, PiCredentialError> {
        match read_regular_file(&self.options.file_path) {
            Ok(Some(bytes)) => {
                let text = String::from_utf8(bytes).map_err(|_| PiCredentialError::NotJson)?;
                parse_document(&text)
            }
            Ok(None) => Ok(CredentialDocument::empty()),
            Err(error) => Err(PiCredentialError::Io(error)),
        }
    }

    fn write_document(&self, document: &CredentialDocument) -> Result<(), PiCredentialError> {
        #[cfg(test)]
        {
            let countdown = self.fail_document_write_countdown.load(Ordering::Acquire);
            if countdown != usize::MAX {
                if countdown == 0 {
                    self.fail_document_write_countdown
                        .store(usize::MAX, Ordering::Release);
                    return Err(PiCredentialError::Io(std::io::Error::other(
                        "injected document write failure",
                    )));
                }
                self.fail_document_write_countdown
                    .fetch_sub(1, Ordering::AcqRel);
            }
        }
        write_document_durably(
            &self.options.file_path,
            document,
            self.options.sync_directory.as_deref(),
            self.options.on_durability_warning.as_deref(),
        )
    }

    #[cfg(test)]
    fn fail_document_write_after(&self, successful_writes: usize) {
        self.fail_document_write_countdown
            .store(successful_writes, Ordering::Release);
    }

    fn ensure_encryption(&self) -> Result<(), PiCredentialError> {
        if self.options.cipher.is_encryption_available() {
            Ok(())
        } else {
            Err(PiCredentialError::SecureStorageUnavailable)
        }
    }

    fn decrypt_entry(
        &self,
        provider_id: &str,
        entry: &StoredCredential,
    ) -> Result<Credential, PiCredentialError> {
        self.ensure_encryption()?;
        let bytes =
            crate::base64::decode(&entry.ciphertext).ok_or(PiCredentialError::CouldNotDecrypt)?;
        // The injected cipher owns the format decision: the production
        // keyring cipher treats anything but its marker as a legacy Electron
        // safeStorage blob (NeedsRotation).
        let account = entry
            .account
            .as_deref()
            .map(str::to_owned)
            .unwrap_or_else(|| legacy_keychain_account(provider_id));
        let plaintext = match self.options.cipher.decrypt_string(&account, &bytes) {
            Ok(plaintext) => plaintext,
            Err(SecretCipherError::NeedsRotation) => return Err(PiCredentialError::NeedsRotation),
            Err(_) => return Err(PiCredentialError::CouldNotDecrypt),
        };
        let credential: serde_json::Value =
            serde_json::from_str(&plaintext).map_err(|_| PiCredentialError::InvalidOrCorrupted)?;
        validate_credential(&credential).map_err(|_| PiCredentialError::InvalidOrCorrupted)?;
        if credential
            .get("type")
            .and_then(|value| value.as_str())
            .map(|r#type| r#type != entry.r#type)
            .unwrap_or(true)
        {
            return Err(PiCredentialError::MetadataMismatch);
        }
        Ok(credential)
    }

    fn delete_secret(&self, account: &str) -> Result<(), PiCredentialError> {
        self.options
            .cipher
            .delete_entry(account)
            .map_err(|_| PiCredentialError::SecureStorageUnavailable)
    }

    fn entry_account(
        provider_id: &str,
        entry: &StoredCredential,
    ) -> Result<Option<String>, PiCredentialError> {
        if let Some(account) = &entry.account {
            return Ok(Some(account.clone()));
        }
        let marker =
            crate::base64::decode(&entry.ciphertext).ok_or(PiCredentialError::CouldNotDecrypt)?;
        // An account-less Keyring marker is the first Rust format. Any other
        // bytes are an Electron safeStorage blob: there is no Rust Keychain
        // secret to delete, so logout may safely remove only its document slot.
        Ok((marker == KEYRING_MARKER).then(|| legacy_keychain_account(provider_id)))
    }

    fn cleanup_orphans(&self, document: &mut CredentialDocument) -> bool {
        let live_accounts: BTreeSet<_> = document
            .entries
            .iter()
            .filter_map(|(provider_id, entry)| {
                entry.account.clone().or_else(|| {
                    crate::base64::decode(&entry.ciphertext)
                        .filter(|marker| marker == KEYRING_MARKER)
                        .map(|_| legacy_keychain_account(provider_id))
                })
            })
            .collect();
        let before = document.orphaned_secrets.len();
        document.orphaned_secrets.retain(|orphan| {
            live_accounts.contains(&orphan.account) || self.delete_secret(&orphan.account).is_err()
        });
        document.orphaned_secrets.len() != before
    }

    fn cleanup_pending(&self, document: &mut CredentialDocument) -> bool {
        let live_accounts: BTreeSet<_> = document
            .entries
            .iter()
            .filter_map(|(provider_id, entry)| {
                entry.account.clone().or_else(|| {
                    crate::base64::decode(&entry.ciphertext)
                        .filter(|marker| marker == KEYRING_MARKER)
                        .map(|_| legacy_keychain_account(provider_id))
                })
            })
            .collect();
        let before = document.pending_secrets.len();
        document.pending_secrets.retain(|pending| {
            !live_accounts.contains(&pending.account)
                && self.delete_secret(&pending.account).is_err()
        });
        document.pending_secrets.len() != before
    }

    /// Load while holding the document mutex and sweep crash-left pending
    /// accounts. A failed cleanup publication remains safe: the durable intent
    /// is retried later and Keychain deletion is idempotent.
    fn read_document_locked(&self) -> Result<CredentialDocument, PiCredentialError> {
        let mut document = self.read_document_file()?;
        if self.cleanup_pending(&mut document) {
            let _ = self.write_document(&document);
        }
        Ok(document)
    }

    fn rollback_pending_locked(&self, document: &mut CredentialDocument, pending: &PendingSecret) {
        if self.delete_secret(&pending.account).is_ok() {
            document
                .pending_secrets
                .retain(|candidate| candidate != pending);
            // If this rewrite fails, the old durable intent remains and a
            // later idempotent cleanup removes it.
            let _ = self.write_document(document);
        }
    }

    /// Publish a new version while the caller holds this provider's mutex.
    fn commit_replacement(
        &self,
        provider_id: &str,
        next: Credential,
    ) -> Result<Credential, PiCredentialError> {
        self.ensure_encryption()?;
        validate_credential(&next)?;
        let next_type = next
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or(PiCredentialError::InvalidCredential)?
            .to_string();
        let plaintext = serde_json::to_string(&next)?;
        let next_account = versioned_keychain_account(provider_id);
        let pending = PendingSecret {
            provider_id: provider_id.to_string(),
            account: next_account.clone(),
        };
        let document_mutex = self.mutex("document");
        let _document_guard = document_mutex.lock();
        let mut intent_document = self.read_document_locked()?;
        let previous_account = match intent_document.entries.get(provider_id) {
            Some(previous) => Self::entry_account(provider_id, previous)?,
            None => None,
        };
        intent_document.version = 2;
        intent_document.pending_secrets.push(pending.clone());
        self.write_document(&intent_document)?;

        let encrypted = match self
            .options
            .cipher
            .encrypt_string(&next_account, &plaintext)
        {
            Ok(encrypted) => StoredCredential {
                r#type: next_type,
                ciphertext: crate::base64::encode(&encrypted),
                account: Some(next_account.clone()),
            },
            Err(_) => {
                self.rollback_pending_locked(&mut intent_document, &pending);
                return Err(PiCredentialError::SecureStorageUnavailable);
            }
        };

        let mut promoted = intent_document.clone();
        promoted.entries.insert(provider_id.to_string(), encrypted);
        promoted
            .pending_secrets
            .retain(|candidate| candidate != &pending);
        if let Some(previous_account) = previous_account {
            if previous_account != next_account {
                promoted.orphaned_secrets.push(OrphanedSecret {
                    provider_id: provider_id.to_string(),
                    account: previous_account,
                });
            }
        }
        if let Err(error) = self.write_document(&promoted) {
            self.rollback_pending_locked(&mut intent_document, &pending);
            return Err(error);
        }
        if self.cleanup_orphans(&mut promoted) {
            // A crash here only leaves already-deleted accounts in the queue;
            // Keychain NoEntry is idempotent and the next write sweeps them.
            let _ = self.write_document(&promoted);
        }
        Ok(next)
    }

    pub fn read(&self, provider_id: &str) -> Result<Option<Credential>, PiCredentialError> {
        validate_provider_id(provider_id)?;
        let document_mutex = self.mutex("document");
        let _document_guard = document_mutex.lock();
        let entry = self
            .read_document_locked()?
            .entries
            .get(provider_id)
            .cloned();
        drop(_document_guard);
        match entry {
            Some(entry) => Ok(Some(self.decrypt_entry(provider_id, &entry)?)),
            None => Ok(None),
        }
    }

    pub fn list(&self) -> Result<Vec<CredentialInfo>, PiCredentialError> {
        let document_mutex = self.mutex("document");
        let _document_guard = document_mutex.lock();
        let document = self.read_document_locked()?;
        let mut entries: Vec<CredentialInfo> = document
            .entries
            .into_iter()
            .map(|(provider_id, entry)| CredentialInfo {
                provider_id,
                r#type: entry.r#type,
            })
            .collect();
        entries.sort_by(|left, right| left.provider_id.cmp(&right.provider_id));
        Ok(entries)
    }

    /// Unconditionally replace one provider slot without decrypting its old
    /// value. This is the re-auth path for an Electron safeStorage marker that
    /// Rust deliberately cannot decrypt.
    pub fn replace(
        &self,
        provider_id: &str,
        credential: Credential,
    ) -> Result<Credential, PiCredentialError> {
        validate_provider_id(provider_id)?;
        validate_credential(&credential)?;
        let provider_mutex = self.mutex(&format!("provider:{provider_id}"));
        let _provider_guard = provider_mutex.lock();
        self.commit_replacement(provider_id, credential)
    }

    /// Serialized read-modify-write for one provider. A `None` return from the
    /// modifier leaves the current credential untouched.
    pub fn modify(
        &self,
        provider_id: &str,
        modifier: impl FnOnce(Option<&Credential>) -> Result<Option<Credential>, PiCredentialError>,
    ) -> Result<Option<Credential>, PiCredentialError> {
        validate_provider_id(provider_id)?;
        let provider_mutex = self.mutex(&format!("provider:{provider_id}"));
        let _provider_guard = provider_mutex.lock();
        let document_mutex = self.mutex("document");
        let _document_guard = document_mutex.lock();
        let current_entry = self
            .read_document_locked()?
            .entries
            .get(provider_id)
            .cloned();
        drop(_document_guard);
        let current = current_entry
            .as_ref()
            .map(|entry| self.decrypt_entry(provider_id, entry))
            .transpose()?;
        let next = modifier(current.as_ref())?;
        let Some(next) = next else {
            return Ok(current);
        };
        self.commit_replacement(provider_id, next).map(Some)
    }

    pub fn delete(&self, provider_id: &str) -> Result<(), PiCredentialError> {
        validate_provider_id(provider_id)?;
        let provider_mutex = self.mutex(&format!("provider:{provider_id}"));
        let _provider_guard = provider_mutex.lock();
        let document_mutex = self.mutex("document");
        let _document_guard = document_mutex.lock();
        let mut document = self.read_document_locked()?;
        document.version = 2;
        if let Some(entry) = document.entries.remove(provider_id) {
            // Delete the secret first. If publication then fails, the stale
            // document reference is unusable and therefore fails closed.
            if let Some(account) = Self::entry_account(provider_id, &entry)? {
                self.delete_secret(&account)?;
            }
            self.write_document(&document)?;
        }
        if self.cleanup_orphans(&mut document) {
            let _ = self.write_document(&document);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// TS `CredentialCipher` test seam: `encrypted:<value>` bytes, with an
    /// in-memory vault and optional unavailability.
    #[derive(Default)]
    struct TestCipher {
        vault: StdMutex<HashMap<String, String>>,
        unavailable: bool,
        fail_delete: AtomicBool,
    }

    impl TestCipher {
        fn unavailable() -> Self {
            Self {
                vault: StdMutex::new(HashMap::new()),
                unavailable: true,
                fail_delete: AtomicBool::new(false),
            }
        }

        fn accounts(&self) -> Vec<String> {
            let mut accounts: Vec<_> = self.vault.lock().unwrap().keys().cloned().collect();
            accounts.sort();
            accounts
        }

        fn contains_account(&self, account: &str) -> bool {
            self.vault.lock().unwrap().contains_key(account)
        }

        fn set_fail_delete(&self, fail: bool) {
            self.fail_delete.store(fail, Ordering::Release);
        }
    }

    impl SecretCipher for TestCipher {
        fn is_encryption_available(&self) -> bool {
            !self.unavailable
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.vault
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(KEYRING_MARKER.to_vec())
        }

        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            if value != KEYRING_MARKER {
                return Err(SecretCipherError::NeedsRotation);
            }
            self.vault
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .ok_or(SecretCipherError::UnrecognizedFormat)
        }

        fn delete_entry(&self, account: &str) -> Result<(), SecretCipherError> {
            if self.fail_delete.load(Ordering::Acquire) {
                return Err(SecretCipherError::Keychain(
                    "injected deletion failure".into(),
                ));
            }
            self.vault.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn oauth(access: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "oauth",
            "access": access,
            "refresh": format!("refresh-{access}"),
            "expires": 2_000_000_000_000f64,
            "accountId": "account-test",
        })
    }

    fn fixture(
        cipher: Arc<dyn SecretCipher>,
    ) -> (tempfile::TempDir, PathBuf, EncryptedPiCredentialStore) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pi-provider-credentials.json");
        let store = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: file.clone(),
            cipher,
            sync_directory: None,
            on_durability_warning: None,
        });
        (dir, file, store)
    }

    #[test]
    fn stores_full_credentials_encrypted_and_lists_metadata_only() {
        let (_dir, file, store) = fixture(Arc::new(TestCipher::default()));
        store
            .modify("openai-codex", |_| Ok(Some(oauth("access-secret"))))
            .unwrap();
        assert_eq!(
            store.read("openai-codex").unwrap(),
            Some(oauth("access-secret"))
        );
        assert_eq!(
            store.list().unwrap(),
            vec![CredentialInfo {
                provider_id: "openai-codex".into(),
                r#type: "oauth".into(),
            }]
        );
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(!raw.contains("access-secret"));
        assert!(!raw.contains("account-test"));
        assert!(raw.contains("pi-provider-credentials:openai-codex:"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn failed_document_commit_removes_new_secret_and_keeps_old_reference() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        store
            .modify("openai-codex", |_| Ok(Some(oauth("old"))))
            .unwrap();
        let old_document = std::fs::read_to_string(&file).unwrap();
        let old_accounts = cipher.accounts();
        assert_eq!(old_accounts.len(), 1);

        // The durable intent publishes first; fail promotion after the new
        // Keychain entry exists so rollback is exercised.
        store.fail_document_write_after(1);
        assert!(matches!(
            store.modify("openai-codex", |_| Ok(Some(oauth("new")))),
            Err(PiCredentialError::Io(_))
        ));

        assert_eq!(std::fs::read_to_string(&file).unwrap(), old_document);
        assert_eq!(cipher.accounts(), old_accounts);
        assert_eq!(store.read("openai-codex").unwrap(), Some(oauth("old")));
    }

    struct IntentCheckingCipher {
        inner: TestCipher,
        document: PathBuf,
        saw_intent: AtomicBool,
    }

    impl SecretCipher for IntentCheckingCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            let document =
                parse_document(&std::fs::read_to_string(&self.document).unwrap()).unwrap();
            self.saw_intent.store(
                document
                    .pending_secrets
                    .iter()
                    .any(|pending| pending.account == account),
                Ordering::Release,
            );
            self.inner.encrypt_string(account, value)
        }

        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            self.inner.decrypt_string(account, value)
        }

        fn delete_entry(&self, account: &str) -> Result<(), SecretCipherError> {
            self.inner.delete_entry(account)
        }
    }

    #[test]
    fn pending_intent_is_durable_before_keychain_creation_and_removed_on_promotion() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("pi-provider-credentials.json");
        let cipher = Arc::new(IntentCheckingCipher {
            inner: TestCipher::default(),
            document: file.clone(),
            saw_intent: AtomicBool::new(false),
        });
        let store = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: file.clone(),
            cipher: cipher.clone(),
            sync_directory: None,
            on_durability_warning: None,
        });

        store.replace("openai-codex", oauth("new")).unwrap();

        assert!(cipher.saw_intent.load(Ordering::Acquire));
        let document = parse_document(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert!(document.pending_secrets.is_empty());
        assert!(document.entries["openai-codex"].account.is_some());
    }

    #[test]
    fn failed_promotion_and_failed_rollback_are_cleaned_after_restart() {
        let cipher = Arc::new(TestCipher::default());
        let (_directory, file, store) = fixture(cipher.clone());
        store.replace("openai-codex", oauth("old")).unwrap();
        let old_account = cipher.accounts().pop().unwrap();
        cipher.set_fail_delete(true);
        store.fail_document_write_after(1);

        assert!(matches!(
            store.replace("openai-codex", oauth("new")),
            Err(PiCredentialError::Io(_))
        ));
        let pending = parse_document(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(pending.pending_secrets.len(), 1);
        let pending_account = pending.pending_secrets[0].account.clone();
        assert!(cipher.contains_account(&old_account));
        assert!(cipher.contains_account(&pending_account));

        cipher.set_fail_delete(false);
        let restarted = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: file.clone(),
            cipher: cipher.clone(),
            sync_directory: None,
            on_durability_warning: None,
        });
        assert_eq!(restarted.read("openai-codex").unwrap(), Some(oauth("old")));
        let cleaned = parse_document(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert!(cleaned.pending_secrets.is_empty());
        assert!(cipher.contains_account(&old_account));
        assert!(!cipher.contains_account(&pending_account));
        assert_eq!(cipher.accounts(), vec![old_account]);
    }

    #[test]
    fn successful_rotation_removes_the_superseded_secret() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        store
            .modify("openai-codex", |_| Ok(Some(oauth("old"))))
            .unwrap();
        let old_account = cipher.accounts().pop().unwrap();

        store
            .modify("openai-codex", |_| Ok(Some(oauth("new"))))
            .unwrap();

        let document = parse_document(&std::fs::read_to_string(file).unwrap()).unwrap();
        let new_account = document.entries["openai-codex"].account.as_deref().unwrap();
        assert_ne!(new_account, old_account);
        assert!(!cipher.contains_account(&old_account));
        assert!(cipher.contains_account(new_account));
        assert_eq!(cipher.accounts().len(), 1);
    }

    #[test]
    fn failed_superseded_cleanup_is_durable_and_retried() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        store
            .modify("openai-codex", |_| Ok(Some(oauth("first"))))
            .unwrap();
        let first_account = cipher.accounts().pop().unwrap();

        cipher.set_fail_delete(true);
        store
            .modify("openai-codex", |_| Ok(Some(oauth("second"))))
            .unwrap();
        let pending = parse_document(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(pending.orphaned_secrets.len(), 1);
        assert_eq!(pending.orphaned_secrets[0].account, first_account);
        assert_eq!(cipher.accounts().len(), 2);

        cipher.set_fail_delete(false);
        store
            .modify("openai-codex", |_| Ok(Some(oauth("third"))))
            .unwrap();
        let cleaned = parse_document(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert!(cleaned.orphaned_secrets.is_empty());
        assert_eq!(cipher.accounts().len(), 1);
        assert_eq!(store.read("openai-codex").unwrap(), Some(oauth("third")));
    }

    #[test]
    fn already_deleted_queued_orphan_is_swept_idempotently() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        store.replace("openai-codex", oauth("first")).unwrap();
        let mut document = parse_document(&std::fs::read_to_string(&file).unwrap()).unwrap();
        document.orphaned_secrets.push(OrphanedSecret {
            provider_id: "openai-codex".into(),
            account: versioned_keychain_account("openai-codex"),
        });
        write_document_durably(&file, &document, None, None).unwrap();

        store.replace("openai-codex", oauth("second")).unwrap();

        let cleaned = parse_document(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert!(cleaned.orphaned_secrets.is_empty());
        assert_eq!(cipher.accounts().len(), 1);
    }

    #[test]
    fn a_post_commit_directory_sync_failure_warns_without_rejecting_the_committed_credential() {
        let warnings = Arc::new(StdMutex::new(Vec::<String>::new()));
        let (_dir, _file, store) = {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("credentials.json");
            let warnings = warnings.clone();
            let store = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
                file_path: file.clone(),
                cipher: Arc::new(TestCipher::default()),
                sync_directory: Some(Box::new(|_| {
                    Err(std::io::Error::other("directory sync unsupported"))
                })),
                on_durability_warning: Some(Box::new(move |error| {
                    warnings.lock().unwrap().push(error.to_string());
                })),
            });
            (dir, file, store)
        };
        store
            .modify("artificial-analysis", |_| {
                Ok(Some(
                    serde_json::json!({ "type": "api_key", "key": "secret" }),
                ))
            })
            .unwrap();
        assert_eq!(
            store.read("artificial-analysis").unwrap(),
            Some(serde_json::json!({ "type": "api_key", "key": "secret" }))
        );
        // Intent and promotion are separately durable publications.
        assert_eq!(warnings.lock().unwrap().len(), 2);
        assert!(warnings.lock().unwrap()[0].contains("unsupported"));
    }

    #[test]
    fn undefined_and_rejected_modifiers_leave_the_current_credential_intact() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, _file, store) = fixture(cipher.clone());
        store
            .modify("openai-codex", |_| Ok(Some(oauth("current"))))
            .unwrap();
        let accounts = cipher.accounts();
        assert_eq!(
            store.modify("openai-codex", |_| Ok(None)).unwrap(),
            Some(oauth("current"))
        );
        assert_eq!(cipher.accounts(), accounts);
        assert!(store
            .modify("openai-codex", |_| Err(
                PiCredentialError::InvalidOAuthCredential
            ))
            .is_err());
        assert_eq!(store.read("openai-codex").unwrap(), Some(oauth("current")));
    }

    #[test]
    fn delete_is_serialized_with_modify_and_removes_the_entry() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, _file, store) = fixture(cipher.clone());
        store
            .modify("openai-codex", |_| Ok(Some(oauth("current"))))
            .unwrap();
        let account = cipher.accounts().pop().unwrap();
        store.delete("openai-codex").unwrap();
        assert_eq!(store.read("openai-codex").unwrap(), None);
        assert!(store.list().unwrap().is_empty());
        assert!(!cipher.contains_account(&account));
        assert!(cipher.accounts().is_empty());
    }

    #[test]
    fn referenced_secret_deletion_failure_keeps_the_document_entry() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        store
            .modify("openai-codex", |_| Ok(Some(oauth("current"))))
            .unwrap();
        let original_document = std::fs::read_to_string(&file).unwrap();
        cipher.set_fail_delete(true);

        assert!(matches!(
            store.delete("openai-codex"),
            Err(PiCredentialError::SecureStorageUnavailable)
        ));
        assert_eq!(std::fs::read_to_string(file).unwrap(), original_document);
        assert_eq!(store.read("openai-codex").unwrap(), Some(oauth("current")));
    }

    #[test]
    fn legacy_fixed_account_reads_and_migrates_on_next_write() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        let provider_id = "openai-codex";
        let legacy_account = legacy_keychain_account(provider_id);
        let credential = oauth("legacy");
        let plaintext = serde_json::to_string(&credential).unwrap();
        let marker = cipher.encrypt_string(&legacy_account, &plaintext).unwrap();
        std::fs::write(
            &file,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "entries": {
                    (provider_id): {
                        "type": "oauth",
                        "ciphertext": crate::base64::encode(&marker)
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(store.read(provider_id).unwrap(), Some(credential));
        store
            .modify(provider_id, |current| Ok(current.cloned()))
            .unwrap();

        let document = parse_document(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert_eq!(document.version, 2);
        let migrated_account = document.entries[provider_id].account.as_deref().unwrap();
        assert!(is_versioned_keychain_account(provider_id, migrated_account));
        assert!(!cipher.contains_account(&legacy_account));
        assert!(cipher.contains_account(migrated_account));
        assert_eq!(store.read(provider_id).unwrap(), Some(oauth("legacy")));
    }

    #[test]
    fn different_providers_update_concurrently_without_losing_entries() {
        let cipher: Arc<dyn SecretCipher> = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        let other = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: file.clone(),
            cipher,
            sync_directory: None,
            on_durability_warning: None,
        });
        store
            .modify("openai-codex", |_| Ok(Some(oauth("codex"))))
            .unwrap();
        other
            .modify("anthropic", |_| {
                Ok(Some(
                    serde_json::json!({ "type": "api_key", "key": "anthropic-secret" }),
                ))
            })
            .unwrap();
        assert_eq!(
            store.read("openai-codex").unwrap().unwrap()["type"],
            "oauth"
        );
        assert_eq!(
            store.read("anthropic").unwrap(),
            Some(serde_json::json!({ "type": "api_key", "key": "anthropic-secret" }))
        );
    }

    #[cfg(unix)]
    #[test]
    fn alias_paths_share_locks_and_concurrent_writes_preserve_both_providers() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let alias = directory.path().join("alias");
        symlink(&real, &alias).unwrap();
        let cipher: Arc<dyn SecretCipher> = Arc::new(TestCipher::default());
        let first = Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: real.join("credentials.json"),
                cipher: cipher.clone(),
                sync_directory: None,
                on_durability_warning: None,
            },
        ));
        let second = Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: alias.join("./credentials.json"),
                cipher,
                sync_directory: None,
                on_durability_warning: None,
            },
        ));
        assert_eq!(first.lock_identity, second.lock_identity);
        assert!(Arc::ptr_eq(
            &first.mutex("document"),
            &second.mutex("document")
        ));

        let first_task = {
            let first = first.clone();
            std::thread::spawn(move || first.replace("openai-codex", oauth("codex")))
        };
        let second_task = {
            let second = second.clone();
            std::thread::spawn(move || {
                second.replace(
                    "anthropic",
                    serde_json::json!({ "type": "api_key", "key": "anthropic-secret" }),
                )
            })
        };
        first_task.join().unwrap().unwrap();
        second_task.join().unwrap().unwrap();
        assert_eq!(first.read("openai-codex").unwrap(), Some(oauth("codex")));
        assert_eq!(
            second.read("anthropic").unwrap(),
            Some(serde_json::json!({ "type": "api_key", "key": "anthropic-secret" }))
        );
    }

    #[cfg(unix)]
    #[test]
    fn credential_reads_reject_symlinks_and_fifos_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        std::fs::write(&target, r#"{"version":2,"entries":{}}"#).unwrap();
        let symlink_path = directory.path().join("symlink.json");
        symlink(&target, &symlink_path).unwrap();
        let symlink_store = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: symlink_path,
            cipher: Arc::new(TestCipher::default()),
            sync_directory: None,
            on_durability_warning: None,
        });
        assert!(matches!(
            symlink_store.list(),
            Err(PiCredentialError::Io(_))
        ));

        let fifo_path = directory.path().join("credentials.fifo");
        let fifo = CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let fifo_store = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: fifo_path,
            cipher: Arc::new(TestCipher::default()),
            sync_directory: None,
            on_durability_warning: None,
        });
        assert!(matches!(fifo_store.list(), Err(PiCredentialError::Io(_))));
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_read_is_not_redirected_by_a_post_open_path_swap() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        let held = directory.path().join("held.json");
        let replacement = directory.path().join("replacement.json");
        let original = br#"{"version":2,"entries":{}}"#;
        std::fs::write(&path, original).unwrap();
        std::fs::write(&replacement, b"attacker-controlled").unwrap();

        let bytes = read_regular_file_after_open(&path, || {
            std::fs::rename(&path, &held).unwrap();
            symlink(&replacement, &path).unwrap();
        })
        .unwrap()
        .unwrap();
        assert_eq!(bytes, original);
    }

    #[test]
    fn fails_closed_for_unavailable_secure_storage_corrupt_files_and_bad_ciphertext() {
        let (_dir, _file, store) = fixture(Arc::new(TestCipher::unavailable()));
        assert!(matches!(
            store.modify("openai-codex", |_| Ok(Some(oauth("secret")))),
            Err(PiCredentialError::SecureStorageUnavailable)
        ));

        let (_dir, file, corrupt_store) = fixture(Arc::new(TestCipher::default()));
        std::fs::write(&file, "not json").unwrap();
        assert!(matches!(
            corrupt_store.list(),
            Err(PiCredentialError::NotJson)
        ));
    }

    #[test]
    fn legacy_safe_storage_blobs_are_flagged_needs_rotation() {
        let (_dir, file, store) = fixture(Arc::new(TestCipher::default()));
        std::fs::write(
            &file,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "entries": {
                    "openai-codex": {
                        "type": "oauth",
                        "ciphertext": "dGhpcyBpcyBub3Qgb3VyIG1hcmtlcg=="
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            store.read("openai-codex"),
            Err(PiCredentialError::NeedsRotation)
        ));
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn delete_removes_legacy_electron_marker_without_a_rust_keychain_entry() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        std::fs::write(
            &file,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "entries": {
                    "openai-codex": {
                        "type": "oauth",
                        "ciphertext": "dGhpcyBpcyBub3Qgb3VyIG1hcmtlcg=="
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        // Proves this path does not touch the nonexistent fixed Rust account.
        cipher.set_fail_delete(true);
        store.delete("openai-codex").unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(cipher.accounts().is_empty());
    }

    #[test]
    fn explicit_reauth_replaces_undecryptable_electron_marker() {
        let cipher = Arc::new(TestCipher::default());
        let (_dir, file, store) = fixture(cipher.clone());
        std::fs::write(
            &file,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "entries": {
                    "openai-codex": {
                        "type": "oauth",
                        "ciphertext": "dGhpcyBpcyBub3Qgb3VyIG1hcmtlcg=="
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            store.read("openai-codex"),
            Err(PiCredentialError::NeedsRotation)
        ));

        store
            .replace("openai-codex", oauth("signed-in-again"))
            .unwrap();

        assert_eq!(
            store.read("openai-codex").unwrap(),
            Some(oauth("signed-in-again"))
        );
        let document = parse_document(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert_eq!(document.version, 2);
        assert!(document.entries["openai-codex"].account.is_some());
        assert_eq!(cipher.accounts().len(), 1);
    }

    #[test]
    fn rejects_cross_provider_or_malformed_secret_references() {
        let (_dir, file, store) = fixture(Arc::new(TestCipher::default()));
        for account in [
            "pi-provider-credentials:anthropic:123-1-abc",
            "pi-provider-credentials:openai-codex:",
            "provider-keys:openai-codex",
        ] {
            std::fs::write(
                &file,
                serde_json::to_string(&serde_json::json!({
                    "version": 2,
                    "entries": {
                        "openai-codex": {
                            "type": "oauth",
                            "ciphertext": crate::base64::encode(KEYRING_MARKER),
                            "account": account
                        }
                    }
                }))
                .unwrap(),
            )
            .unwrap();
            assert!(matches!(
                store.read("openai-codex"),
                Err(PiCredentialError::InvalidEntry)
            ));
        }
    }

    #[test]
    fn v2_rejects_cross_provider_and_malformed_orphan_references() {
        let (_directory, file, store) = fixture(Arc::new(TestCipher::default()));
        for (orphan, invalid_provider_id) in [
            (
                serde_json::json!({
                    "providerId": "openai-codex",
                    "account": "pi-provider-credentials:anthropic:123-1-abc"
                }),
                false,
            ),
            (
                serde_json::json!({
                    "providerId": "openai-codex",
                    "account": "pi-provider-credentials:openai-codex:"
                }),
                false,
            ),
            (
                serde_json::json!({
                    "providerId": "bad provider",
                    "account": "pi-provider-credentials:bad provider:123-1-abc"
                }),
                true,
            ),
        ] {
            std::fs::write(
                &file,
                serde_json::to_string(&serde_json::json!({
                    "version": 2,
                    "entries": {},
                    "orphanedSecrets": [orphan]
                }))
                .unwrap(),
            )
            .unwrap();
            let result = store.list();
            if invalid_provider_id {
                assert!(matches!(result, Err(PiCredentialError::InvalidProviderId)));
            } else {
                assert!(matches!(result, Err(PiCredentialError::InvalidEntry)));
            }
        }
    }

    #[test]
    fn v1_rejects_v2_reference_fields_instead_of_silently_dropping_them() {
        let (_dir, file, store) = fixture(Arc::new(TestCipher::default()));
        std::fs::write(
            file,
            serde_json::to_string(&serde_json::json!({
                "version": 1,
                "entries": {
                    "openai-codex": {
                        "type": "oauth",
                        "ciphertext": crate::base64::encode(KEYRING_MARKER),
                        "account": "pi-provider-credentials:openai-codex:123-1-abc"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(matches!(
            store.read("openai-codex"),
            Err(PiCredentialError::InvalidEntry)
        ));
    }

    #[test]
    fn provider_id_validation_matches_the_ts_regex() {
        let store = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: PathBuf::from("/nonexistent"),
            cipher: Arc::new(TestCipher::default()),
            sync_directory: None,
            on_durability_warning: None,
        });
        for invalid in ["", "no spaces", "bad!", "x".repeat(129).as_str()] {
            assert!(matches!(
                store.read(invalid),
                Err(PiCredentialError::InvalidProviderId)
            ));
        }
        // The TS regex is case-insensitive: uppercase ids are valid.
        assert!(store.read("OpenAI").is_ok());
    }
}
