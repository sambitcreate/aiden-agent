//! Encrypted Pi credential store (port of
//! `main/services/pi-credential-store-core.ts`).
//!
//! Aiden stores one credential per provider in
//! `<userData>/pi-provider-credentials.json`:
//!
//! ```json
//! { "version": 1, "entries": { "<providerId>": { "type": "api_key", "ciphertext": "<base64>" } } }
//! ```
//!
//! The Electron app encrypted the credential JSON with `safeStorage`; those
//! blobs are **not decryptable outside Electron**. This port keeps the exact
//! file layout but writes credentials through the injected
//! [`SecretCipher`] seam (production: the `keyring` crate, macOS Keychain),
//! whose ciphertext slot holds a fixed base64 marker (`base64("aiden-k1:")`)
//! while the plaintext lives in the Keychain under the provider key name.
//! Reading a legacy safeStorage blob fails with
//! [`PiCredentialError::NeedsRotation`] so the UI can prompt re-entry.
//!
//! Serialized read-modify-write is preserved: a per-provider mutex (shared
//! process-wide across store instances by resolved file path, exactly like the
//! TS `sharedMutexes`) serializes `modify`/`delete` for one provider, and a
//! single document mutex serializes the whole-file RMW so concurrent updates
//! to different providers never lose entries.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::{Deserialize, Serialize};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use crate::secret_map::{SecretCipher, SecretCipherError};

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
fn keychain_account(provider_id: &str) -> String {
    format!("pi-provider-credentials:{provider_id}")
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialDocument {
    pub version: u8,
    pub entries: BTreeMap<String, StoredCredential>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub pending: BTreeSet<String>,
}

impl CredentialDocument {
    fn empty() -> Self {
        Self {
            version: 1,
            entries: BTreeMap::new(),
            pending: BTreeSet::new(),
        }
    }
}

// -- global per-file mutex registry (mirrors the TS sharedMutexes map) --------

fn shared_mutex(key: String) -> Arc<parking_lot::Mutex<()>> {
    static REGISTRY: OnceLock<StdMutex<BTreeMap<String, Arc<parking_lot::Mutex<()>>>>> =
        OnceLock::new();
    let registry = REGISTRY.get_or_init(|| StdMutex::new(BTreeMap::new()));
    let mut guard = registry.lock().unwrap();
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(parking_lot::Mutex::new(())))
        .clone()
}

fn shared_authority(key: String) -> Arc<StdMutex<HashSet<String>>> {
    static REGISTRY: OnceLock<StdMutex<HashMap<String, Arc<StdMutex<HashSet<String>>>>>> =
        OnceLock::new();
    let registry = REGISTRY.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut guard = registry.lock().unwrap();
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(StdMutex::new(HashSet::new())))
        .clone()
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
            Some(1) => 1,
            _ => return Err(PiCredentialError::UnsupportedVersion),
        },
        _ => return Err(PiCredentialError::UnsupportedVersion),
    };
    let entries = match object.get("entries") {
        Some(serde_json::Value::Object(entries)) => entries,
        _ => return Err(PiCredentialError::UnsupportedVersion),
    };
    let mut pending = BTreeSet::new();
    if let Some(raw_pending) = object.get("pending") {
        let values = raw_pending
            .as_array()
            .ok_or(PiCredentialError::InvalidShape)?;
        for value in values {
            let provider_id = value.as_str().ok_or(PiCredentialError::InvalidShape)?;
            validate_provider_id(provider_id)?;
            pending.insert(provider_id.to_string());
        }
    }
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
        parsed.insert(provider_id.clone(), StoredCredential { r#type, ciphertext });
    }
    Ok(CredentialDocument {
        version,
        entries: parsed,
        pending,
    })
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
    /// Test-only failure injection before a document publication.
    pub before_document_write:
        Option<Box<dyn Fn(&CredentialDocument) -> Result<(), std::io::Error> + Send + Sync>>,
}

/// The `pi-provider-credentials.json` store (see module docs).
pub struct EncryptedPiCredentialStore {
    options: EncryptedPiCredentialStoreOptions,
    authority: Arc<StdMutex<HashSet<String>>>,
}

impl EncryptedPiCredentialStore {
    pub fn new(options: EncryptedPiCredentialStoreOptions) -> Self {
        let authority = shared_authority(options.file_path.to_string_lossy().into_owned());
        Self { options, authority }
    }

    fn mutex(&self, scope: &str) -> Arc<parking_lot::Mutex<()>> {
        shared_mutex(format!("{}\0{scope}", self.options.file_path.display()))
    }

    fn read_document(&self) -> Result<CredentialDocument, PiCredentialError> {
        match fs::read(&self.options.file_path) {
            Ok(bytes) => {
                let text = String::from_utf8(bytes).map_err(|_| PiCredentialError::NotJson)?;
                parse_document(&text)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(CredentialDocument::empty())
            }
            Err(error) => Err(PiCredentialError::Io(error)),
        }
    }

    fn write_document(&self, document: &CredentialDocument) -> Result<(), PiCredentialError> {
        if let Some(before_write) = &self.options.before_document_write {
            before_write(document)?;
        }
        write_document_durably(
            &self.options.file_path,
            document,
            self.options.sync_directory.as_deref(),
            self.options.on_durability_warning.as_deref(),
        )
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
        let plaintext = match self
            .options
            .cipher
            .decrypt_string(&keychain_account(provider_id), &bytes)
        {
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

    fn encrypt_credential(
        &self,
        provider_id: &str,
        credential: &Credential,
    ) -> Result<StoredCredential, PiCredentialError> {
        self.ensure_encryption()?;
        validate_credential(credential)?;
        let r#type = credential
            .get("type")
            .and_then(|value| value.as_str())
            .ok_or(PiCredentialError::InvalidCredential)?
            .to_string();
        let plaintext = serde_json::to_string(credential)?;
        let encrypted = self
            .options
            .cipher
            .encrypt_string(&keychain_account(provider_id), &plaintext)
            .map_err(|_| PiCredentialError::SecureStorageUnavailable)?;
        Ok(StoredCredential {
            r#type,
            ciphertext: crate::base64::encode(&encrypted),
        })
    }

    fn read_unlocked(&self, provider_id: &str) -> Result<Option<Credential>, PiCredentialError> {
        let authority = self
            .authority
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if authority.contains(provider_id) {
            return Ok(None);
        }
        let document = self.read_document()?;
        if document.pending.contains(provider_id) {
            return Ok(None);
        }
        let entry = document.entries.get(provider_id).cloned();
        match entry {
            Some(entry) => Ok(Some(self.decrypt_entry(provider_id, &entry)?)),
            None => Ok(None),
        }
    }

    pub fn read(&self, provider_id: &str) -> Result<Option<Credential>, PiCredentialError> {
        validate_provider_id(provider_id)?;
        let provider_mutex = self.mutex(&format!("provider:{provider_id}"));
        let _provider_guard = provider_mutex.lock();
        self.read_unlocked(provider_id)
    }

    pub fn list(&self) -> Result<Vec<CredentialInfo>, PiCredentialError> {
        let document = self.read_document()?;
        let mut entries: Vec<CredentialInfo> = document
            .entries
            .into_iter()
            .filter(|(provider_id, _)| !document.pending.contains(provider_id))
            .map(|(provider_id, entry)| CredentialInfo {
                provider_id,
                r#type: entry.r#type,
            })
            .collect();
        entries.sort_by(|left, right| left.provider_id.cmp(&right.provider_id));
        Ok(entries)
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
        let current = self.read_unlocked(provider_id)?;
        let next = modifier(current.as_ref())?;
        let Some(next) = next else {
            return Ok(current);
        };
        let mut authority = self
            .authority
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let document_mutex = self.mutex("document");
        let _document_guard = document_mutex.lock();
        let mut document = self.read_document()?;
        authority.insert(provider_id.to_string());
        document.pending.insert(provider_id.to_string());
        self.write_document(&document)?;
        let encrypted = self.encrypt_credential(provider_id, &next)?;
        document.entries.insert(provider_id.to_string(), encrypted);
        document.pending.remove(provider_id);
        self.write_document(&document)?;
        authority.remove(provider_id);
        Ok(Some(next))
    }

    pub fn delete(&self, provider_id: &str) -> Result<(), PiCredentialError> {
        validate_provider_id(provider_id)?;
        let provider_mutex = self.mutex(&format!("provider:{provider_id}"));
        let _provider_guard = provider_mutex.lock();
        let mut authority = self
            .authority
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        authority.insert(provider_id.to_string());
        let document_mutex = self.mutex("document");
        let _document_guard = document_mutex.lock();
        let mut document = self.read_document()?;
        document.pending.insert(provider_id.to_string());
        self.write_document(&document)?;
        document.entries.remove(provider_id);
        document.pending.remove(provider_id);
        let removal_result = self.write_document(&document);
        let _ = self
            .options
            .cipher
            .delete_entry(&keychain_account(provider_id));
        removal_result?;
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
    }

    #[derive(Clone, Default)]
    struct FixedMarkerCipher {
        vault: Arc<StdMutex<HashMap<String, String>>>,
        deleted: Arc<StdMutex<Vec<String>>>,
    }

    impl SecretCipher for FixedMarkerCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.vault
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(crate::secret_map::KEYRING_MARKER.to_vec())
        }

        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            if value != crate::secret_map::KEYRING_MARKER {
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
            self.vault.lock().unwrap().remove(account);
            self.deleted.lock().unwrap().push(account.to_string());
            Ok(())
        }
    }

    struct PausingFixedMarkerCipher {
        vault: Arc<StdMutex<HashMap<String, String>>>,
        read_started: StdMutex<Option<std::sync::mpsc::Sender<()>>>,
        resume_read: StdMutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    impl SecretCipher for PausingFixedMarkerCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.vault
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(crate::secret_map::KEYRING_MARKER.to_vec())
        }

        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            if value != crate::secret_map::KEYRING_MARKER {
                return Err(SecretCipherError::NeedsRotation);
            }
            if let Some(started) = self.read_started.lock().unwrap().take() {
                let _ = started.send(());
                if let Some(resume) = self.resume_read.lock().unwrap().take() {
                    let _ = resume.recv();
                }
            }
            self.vault
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .ok_or(SecretCipherError::UnrecognizedFormat)
        }
    }

    impl TestCipher {
        fn unavailable() -> Self {
            Self {
                vault: StdMutex::new(HashMap::new()),
                unavailable: true,
            }
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
            before_document_write: None,
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
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
                before_document_write: None,
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
        assert_eq!(warnings.lock().unwrap().len(), 2);
        assert!(warnings
            .lock()
            .unwrap()
            .iter()
            .all(|warning| warning.contains("unsupported")));
    }

    #[test]
    fn undefined_and_rejected_modifiers_leave_the_current_credential_intact() {
        let (_dir, _file, store) = fixture(Arc::new(TestCipher::default()));
        store
            .modify("openai-codex", |_| Ok(Some(oauth("current"))))
            .unwrap();
        assert_eq!(
            store.modify("openai-codex", |_| Ok(None)).unwrap(),
            Some(oauth("current"))
        );
        assert!(store
            .modify("openai-codex", |_| Err(
                PiCredentialError::InvalidOAuthCredential
            ))
            .is_err());
        assert_eq!(store.read("openai-codex").unwrap(), Some(oauth("current")));
    }

    #[test]
    fn delete_is_serialized_with_modify_and_removes_the_entry() {
        let (_dir, _file, store) = fixture(Arc::new(TestCipher::default()));
        store
            .modify("openai-codex", |_| Ok(Some(oauth("current"))))
            .unwrap();
        store.delete("openai-codex").unwrap();
        assert_eq!(store.read("openai-codex").unwrap(), None);
        assert!(store.list().unwrap().is_empty());
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
            before_document_write: None,
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
    fn provider_id_validation_matches_the_ts_regex() {
        let store = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: PathBuf::from("/nonexistent"),
            cipher: Arc::new(TestCipher::default()),
            sync_directory: None,
            on_durability_warning: None,
            before_document_write: None,
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

    #[test]
    fn fixed_marker_rotation_failure_reopens_durably_denied() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("credentials.json");
        let cipher = FixedMarkerCipher::default();
        let initial = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: file.clone(),
            cipher: Arc::new(cipher.clone()),
            sync_directory: None,
            on_durability_warning: None,
            before_document_write: None,
        });
        initial
            .modify("openai-codex", |_| Ok(Some(oauth("old-access"))))
            .unwrap();

        let writes = Arc::new(AtomicUsize::new(0));
        let writes_for_hook = writes.clone();
        let failing = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: file.clone(),
            cipher: Arc::new(cipher.clone()),
            sync_directory: None,
            on_durability_warning: None,
            before_document_write: Some(Box::new(move |_| {
                if writes_for_hook.fetch_add(1, Ordering::SeqCst) == 1 {
                    Err(std::io::Error::other("forced active publication failure"))
                } else {
                    Ok(())
                }
            })),
        });
        assert!(failing
            .modify("openai-codex", |_| Ok(Some(oauth("new-access"))))
            .is_err());
        let persisted = parse_document(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(persisted.pending.contains("openai-codex"));

        let reopened = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
            file_path: file,
            cipher: Arc::new(cipher),
            sync_directory: None,
            on_durability_warning: None,
            before_document_write: None,
        });
        assert_eq!(reopened.read("openai-codex").unwrap(), None);
        assert!(reopened.list().unwrap().is_empty());
    }

    #[test]
    fn fixed_marker_reader_cannot_cross_a_pending_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("credentials.json");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let cipher = Arc::new(PausingFixedMarkerCipher {
            vault: Arc::new(StdMutex::new(HashMap::new())),
            read_started: StdMutex::new(Some(started_tx)),
            resume_read: StdMutex::new(Some(resume_rx)),
        });
        let options = |cipher: Arc<dyn SecretCipher>| EncryptedPiCredentialStoreOptions {
            file_path: file.clone(),
            cipher,
            sync_directory: None,
            on_durability_warning: None,
            before_document_write: None,
        };
        let seed = EncryptedPiCredentialStore::new(options(cipher.clone()));
        seed.modify("openai-codex", |_| Ok(Some(oauth("old-access"))))
            .unwrap();

        let reader = Arc::new(EncryptedPiCredentialStore::new(options(cipher.clone())));
        let reader_task = {
            let reader = reader.clone();
            std::thread::spawn(move || reader.read("openai-codex").unwrap())
        };
        started_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();

        let writer = EncryptedPiCredentialStore::new(options(cipher.clone()));
        let (writer_done_tx, writer_done_rx) = std::sync::mpsc::channel();
        let writer_task = std::thread::spawn(move || {
            let result = writer.modify("openai-codex", |_| Ok(Some(oauth("new-access"))));
            let _ = writer_done_tx.send(());
            result
        });
        assert!(matches!(
            writer_done_rx.recv_timeout(std::time::Duration::from_millis(50)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        let vaulted = cipher.vault.lock().unwrap();
        assert!(vaulted
            .get(&keychain_account("openai-codex"))
            .unwrap()
            .contains("old-access"));
        drop(vaulted);

        resume_tx.send(()).unwrap();
        let observed = reader_task.join().unwrap().unwrap();
        assert_eq!(observed["access"], "old-access");
        writer_task.join().unwrap().unwrap();
        assert_eq!(
            reader.read("openai-codex").unwrap().unwrap()["access"],
            "new-access"
        );
    }

    #[test]
    fn delete_durably_removes_marker_and_best_effort_keychain_entry() {
        let cipher = FixedMarkerCipher::default();
        let deleted = cipher.deleted.clone();
        let (_dir, file, store) = fixture(Arc::new(cipher));
        store
            .modify("openai-codex", |_| Ok(Some(oauth("access"))))
            .unwrap();

        store.delete("openai-codex").unwrap();

        assert_eq!(store.read("openai-codex").unwrap(), None);
        let document = parse_document(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert!(!document.entries.contains_key("openai-codex"));
        assert!(!document.pending.contains("openai-codex"));
        assert!(deleted
            .lock()
            .unwrap()
            .contains(&keychain_account("openai-codex")));
    }
}
