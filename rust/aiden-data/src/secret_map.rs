//! Encrypted secret map core (port of `main/services/secret-map-core.ts`) plus
//! the keychain-backed `provider-keys.json` store.
//!
//! `secret-map-core.ts` is the shared parser/mutator for Aiden's encrypted
//! maps: strict key validation, no prototype pollution (the TS code used
//! `Object.defineProperty` to keep `__proto__`-style keys as own entries), and
//! structured-binding future-proofing (unknown future entries are preserved
//! verbatim on normalize, never exposed as ciphertext).
//!
//! The map is a plain JSON object of `providerId -> base64 ciphertext` plus
//! endpoint **binding** entries under
//! `__aiden_internal_provider_binding_v1__:<id>`. On disk the map is
//! `<machine-local>/provider-keys.json` (mode 0600, staged write + fsync +
//! dir fsync — the `DataStore` protocol).
//!
//! ## safeStorage incompatibility
//!
//! The Electron app encrypted every value with Electron's `safeStorage` (the
//! macOS Keychain) and stored the ciphertext base64-encoded in the JSON file.
//! That ciphertext cannot be decrypted outside Electron: safeStorage keys are
//! OS-keychain-scoped and the encryption format is internal. The Rust port
//! therefore keeps the *exact file layout* but stores new secrets in the
//! `keyring` crate (Apple Keychain) under accounts derived from the TS key
//! names, writing a recognizable base64 marker
//! (`base64("aiden-k1:") == "YWlkZW4tazE6"`) into the JSON slot. Legacy
//! safeStorage blobs are still *readable as bytes* and are flagged
//! [`SecretEntryStatus::NeedsRotation`] so the UI can prompt re-entry; they
//! are never silently deleted or overwritten with garbage.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::{DataStore, DataStoreError};

/// The key prefix for endpoint-binding entries (secret-map-core / secrets.ts).
pub const PROVIDER_BINDING_KEY_PREFIX: &str = "__aiden_internal_provider_binding_v1__:";

/// The keychain-service marker written into JSON slots by the keyring cipher.
/// `base64("aiden-k1:")` — anything else in a slot is a legacy safeStorage blob.
pub const KEYRING_MARKER: &[u8] = b"aiden-k1:";

/// A secret map: `providerId -> unknown` (ciphertext strings today, unknown
/// future shapes tolerated on normalize).
pub type SecretKeyMap = Map<String, Value>;

#[derive(Debug, thiserror::Error)]
pub enum SecretMapError {
    #[error("Invalid encrypted secret map.")]
    InvalidMap,
    #[error("{0}")]
    Store(#[from] DataStoreError),
}

fn binding_id_for(value_id: &str) -> String {
    format!("{PROVIDER_BINDING_KEY_PREFIX}{value_id}")
}

/// Keychain account namespace for provider-keys.json slots. Kept distinct from
/// the pi-provider-credentials namespace so the two files never share a
/// keychain entry even when a provider id appears in both.
pub(crate) fn keychain_account_for(provider_id: &str) -> String {
    format!("provider-keys:{provider_id}")
}

pub(crate) fn keychain_binding_account_for(provider_id: &str) -> String {
    format!("provider-binding:{provider_id}")
}

/// A value-id / binding-id pair naming one bound credential slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretEntryPair {
    pub value_id: String,
    pub binding_id: String,
}

impl SecretEntryPair {
    /// Active slots used by the provider-key policy.
    pub fn active(value_id: impl Into<String>) -> Self {
        let value_id = value_id.into();
        Self {
            binding_id: binding_id_for(&value_id),
            value_id,
        }
    }

    /// Quarantine slots: externally rotated keys stay recoverable here.
    pub fn quarantine(value_id: impl Into<String>) -> Self {
        let value_id = value_id.into();
        Self {
            value_id: format!("quarantine:{value_id}"),
            binding_id: format!("quarantine-binding:{value_id}"),
        }
    }
}

/// Strict parse: a non-object root is an error — a write must never replace it.
pub fn parse_secret_key_map(value: &Value) -> Result<SecretKeyMap, SecretMapError> {
    match value {
        Value::Object(entries) => Ok(entries.clone()),
        _ => Err(SecretMapError::InvalidMap),
    }
}

/// Tolerant normalize: a non-object root becomes an empty map, and unknown
/// future entries are preserved verbatim (they are not ciphertext strings).
pub fn normalize_secret_key_map(value: &Value) -> SecretKeyMap {
    match value {
        Value::Object(entries) => entries.clone(),
        _ => SecretKeyMap::new(),
    }
}

/// The ciphertext string for `provider_id`, or `None` when the slot is absent
/// or holds a non-string future value.
pub fn secret_key_entry<'a>(map: &'a SecretKeyMap, provider_id: &str) -> Option<&'a str> {
    match map.get(provider_id) {
        Some(Value::String(value)) => Some(value.as_str()),
        _ => None,
    }
}

pub fn set_secret_key_entry(map: &mut SecretKeyMap, provider_id: &str, value: String) {
    map.insert(provider_id.to_string(), Value::String(value));
}

pub fn delete_secret_key_entry(map: &mut SecretKeyMap, provider_id: &str) -> bool {
    map.remove(provider_id).is_some()
}

/// Move a value + create its binding, only into vacant slots.
pub fn move_secret_entry_with_binding_if_vacant(
    map: &mut SecretKeyMap,
    value_id: &str,
    to: &SecretEntryPair,
    encrypted_binding: String,
) -> bool {
    let Some(value) = secret_key_entry(map, value_id) else {
        return false;
    };
    if map.contains_key(&to.value_id) || map.contains_key(&to.binding_id) {
        return false;
    }
    set_secret_key_entry(map, &to.value_id, value.to_string());
    set_secret_key_entry(map, &to.binding_id, encrypted_binding);
    delete_secret_key_entry(map, value_id);
    true
}

/// Bind an existing value only when no binding record exists yet.
pub fn bind_secret_entry_if_unbound(
    map: &mut SecretKeyMap,
    value_id: &str,
    binding_id: &str,
    encrypted_binding: String,
) -> bool {
    if secret_key_entry(map, value_id).is_none() || map.contains_key(binding_id) {
        return false;
    }
    set_secret_key_entry(map, binding_id, encrypted_binding);
    true
}

fn complete_secret_pair(map: &SecretKeyMap, pair: &SecretEntryPair) -> Option<(String, String)> {
    let value = secret_key_entry(map, &pair.value_id)?;
    let binding = secret_key_entry(map, &pair.binding_id)?;
    Some((value.to_string(), binding.to_string()))
}

/// Move a complete bound pair into vacant slots.
pub fn move_secret_entry_pair_if_vacant(
    map: &mut SecretKeyMap,
    from: &SecretEntryPair,
    to: &SecretEntryPair,
) -> bool {
    let source = match complete_secret_pair(map, from) {
        Some(source) => source,
        None => return false,
    };
    if map.contains_key(&to.value_id) || map.contains_key(&to.binding_id) {
        return false;
    }
    set_secret_key_entry(map, &to.value_id, source.0);
    set_secret_key_entry(map, &to.binding_id, source.1);
    delete_secret_key_entry(map, &from.value_id);
    delete_secret_key_entry(map, &from.binding_id);
    true
}

/// Swap two bound pairs atomically; an absent first pair clears the second's
/// slots rather than leaving a half-move.
pub fn swap_secret_entry_pairs(
    map: &mut SecretKeyMap,
    first: &SecretEntryPair,
    second: &SecretEntryPair,
) -> bool {
    let first_values = complete_secret_pair(map, first);
    let second_values = match complete_secret_pair(map, second) {
        Some(second_values) => second_values,
        None => return false,
    };
    set_secret_key_entry(map, &first.value_id, second_values.0);
    set_secret_key_entry(map, &first.binding_id, second_values.1);
    match first_values {
        Some(first_values) => {
            set_secret_key_entry(map, &second.value_id, first_values.0);
            set_secret_key_entry(map, &second.binding_id, first_values.1);
        }
        None => {
            delete_secret_key_entry(map, &second.value_id);
            delete_secret_key_entry(map, &second.binding_id);
        }
    }
    true
}

// ===========================================================================
// Keychain-backed provider-keys.json store
// ===========================================================================

/// The encryption seam, mirroring `CredentialCipher` in
/// pi-credential-store-core.ts. `account` is the TS key name (provider id or
/// binding id); the production impl uses it as the keychain account so a file
/// slot never holds the secret itself.
pub trait SecretCipher: Send + Sync {
    fn is_encryption_available(&self) -> bool;
    /// Returns the bytes that will be base64-encoded into the JSON slot.
    fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError>;
    fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError>;
    /// Best-effort removal of any backing keychain entry (default: no-op).
    fn delete_entry(&self, _account: &str) -> Result<(), SecretCipherError> {
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SecretCipherError {
    #[error("Secure storage is unavailable; provider credentials cannot be accessed.")]
    SecureStorageUnavailable,
    #[error(
        "stored value is a legacy Electron safeStorage blob that cannot be decrypted outside Electron"
    )]
    NeedsRotation,
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("stored value has an unrecognized format")]
    UnrecognizedFormat,
}

/// The `keyring` crate (macOS Keychain) replacement for Electron safeStorage.
///
/// The JSON slot keeps a fixed base64 marker; the plaintext lives in the
/// Keychain under `service`/account. Legacy safeStorage blobs (any bytes other
/// than the marker) are reported as [`SecretCipherError::NeedsRotation`].
#[derive(Debug, Clone)]
pub struct KeyringCredentialCipher {
    pub service: String,
}

impl KeyringCredentialCipher {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }
}

impl SecretCipher for KeyringCredentialCipher {
    fn is_encryption_available(&self) -> bool {
        // Probe with a throwaway entry; the real Keychain on macOS is nearly
        // always reachable, but a locked/unavailable keychain must fail closed.
        let entry = keyring::Entry::new(&self.service, "__aiden_probe__");
        match entry {
            Ok(entry) => entry
                .set_password("probe")
                .and_then(|()| entry.delete_credential())
                .is_ok(),
            Err(_) => false,
        }
    }

    fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| SecretCipherError::Keychain(err.to_string()))?;
        entry
            .set_password(value)
            .map_err(|err| SecretCipherError::Keychain(err.to_string()))?;
        Ok(KEYRING_MARKER.to_vec())
    }

    fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
        if value != KEYRING_MARKER {
            return Err(SecretCipherError::NeedsRotation);
        }
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| SecretCipherError::Keychain(err.to_string()))?;
        match entry.get_password() {
            Ok(secret) => Ok(secret),
            Err(keyring::Error::NoEntry) => Err(SecretCipherError::UnrecognizedFormat),
            Err(err) => Err(SecretCipherError::Keychain(err.to_string())),
        }
    }

    fn delete_entry(&self, account: &str) -> Result<(), SecretCipherError> {
        let entry = keyring::Entry::new(&self.service, account)
            .map_err(|err| SecretCipherError::Keychain(err.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(SecretCipherError::Keychain(err.to_string())),
        }
    }
}

/// The state of one encrypted provider-key slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretEntryStatus {
    /// No value stored for this provider.
    Missing,
    /// A keychain-backed entry this build can decrypt.
    KeyringBacked,
    /// A legacy safeStorage blob: readable as bytes but not decryptable
    /// outside Electron. Re-entry rotates it.
    NeedsRotation,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderKeysError {
    #[error("provider API key for {provider_id} needs rotation (legacy safeStorage blob)")]
    NeedsRotation { provider_id: String },
    #[error("secure storage: {0}")]
    SecureStorage(String),
    #[error("{0}")]
    Store(#[from] DataStoreError),
}

/// The `<machine-local>/provider-keys.json` store: `Record<providerId,
/// base64>` plus binding slots. The file layout is byte-compatible with the
/// Electron app; only the ciphertext convention differs (see module docs).
pub struct ProviderKeysStore {
    store: DataStore<SecretKeyMap>,
    cipher: Arc<dyn SecretCipher>,
    keychain: crate::KeychainSecretStore,
}

impl ProviderKeysStore {
    pub fn new(root: PathBuf, service: impl Into<String>, cipher: Arc<dyn SecretCipher>) -> Self {
        let service = service.into();
        Self {
            store: DataStore::new(
                "provider-keys.json",
                SecretKeyMap::new(),
                Some(root),
                crate::DataStoreOptions {
                    preserve_corrupt_file: true,
                    reject_corrupt_write: true,
                    ..crate::DataStoreOptions::new()
                },
            ),
            cipher,
            keychain: crate::KeychainSecretStore::new(service),
        }
    }

    fn slot_status(
        cipher: &dyn SecretCipher,
        provider_id: &str,
        value: Option<&str>,
    ) -> SecretEntryStatus {
        match value {
            None => SecretEntryStatus::Missing,
            Some(encoded) => {
                let Some(bytes) = crate::base64::decode(encoded) else {
                    return SecretEntryStatus::NeedsRotation;
                };
                match cipher.decrypt_string(&keychain_account_for(provider_id), &bytes) {
                    Ok(_) => SecretEntryStatus::KeyringBacked,
                    // A legacy Electron safeStorage blob (or anything the
                    // cipher cannot open) needs rotation.
                    Err(_) => SecretEntryStatus::NeedsRotation,
                }
            }
        }
    }

    /// Non-destructive slot inspection (the renderer-facing `hasKey` uses this).
    pub fn status(&self, provider_id: &str) -> Result<SecretEntryStatus, ProviderKeysError> {
        let map = self.store.load()?;
        Ok(Self::slot_status(
            self.cipher.as_ref(),
            provider_id,
            secret_key_entry(&map, provider_id),
        ))
    }

    /// Whether a string value is stored (regardless of decryptability).
    pub fn has_key(&self, provider_id: &str) -> Result<bool, ProviderKeysError> {
        let map = self.store.load()?;
        Ok(secret_key_entry(&map, provider_id).is_some())
    }

    /// The decrypted key, or `None` when absent. A legacy safeStorage blob is
    /// surfaced as [`ProviderKeysError::NeedsRotation`].
    pub fn get(&self, provider_id: &str) -> Result<Option<String>, ProviderKeysError> {
        let map = self.store.load()?;
        let Some(encoded) = secret_key_entry(&map, provider_id) else {
            return Ok(None);
        };
        let account = keychain_account_for(provider_id);
        let bytes =
            crate::base64::decode(encoded).ok_or_else(|| ProviderKeysError::NeedsRotation {
                provider_id: provider_id.to_string(),
            })?;
        match self.cipher.decrypt_string(&account, &bytes) {
            Ok(key) => Ok(Some(key)),
            Err(SecretCipherError::NeedsRotation) => Err(ProviderKeysError::NeedsRotation {
                provider_id: provider_id.to_string(),
            }),
            Err(err) => Err(ProviderKeysError::SecureStorage(err.to_string())),
        }
    }

    /// Encrypt into the keychain and publish the marker into the JSON map.
    pub fn set(&self, provider_id: &str, key: &str) -> Result<(), ProviderKeysError> {
        if !self.cipher.is_encryption_available() {
            return Err(ProviderKeysError::SecureStorage(
                "secure storage is unavailable".into(),
            ));
        }
        let account = keychain_account_for(provider_id);
        let marker = self
            .cipher
            .encrypt_string(&account, key)
            .map_err(|err| ProviderKeysError::SecureStorage(err.to_string()))?;
        let encoded = crate::base64::encode(&marker);
        self.store.update(|map| {
            set_secret_key_entry(map, provider_id, encoded);
        })?;
        Ok(())
    }

    /// The endpoint binding slot, encrypted like a key. Binding records are
    /// stored so a key can never be silently redirected to another host.
    pub fn set_binding(&self, provider_id: &str, binding: &str) -> Result<(), ProviderKeysError> {
        let binding_id = binding_id_for(provider_id);
        let account = keychain_binding_account_for(provider_id);
        let marker = self
            .cipher
            .encrypt_string(&account, binding)
            .map_err(|err| ProviderKeysError::SecureStorage(err.to_string()))?;
        let encoded = crate::base64::encode(&marker);
        self.store.update(|map| {
            set_secret_key_entry(map, &binding_id, encoded);
        })?;
        Ok(())
    }

    pub fn get_binding(&self, provider_id: &str) -> Result<Option<String>, ProviderKeysError> {
        let binding_id = binding_id_for(provider_id);
        let account = keychain_binding_account_for(provider_id);
        let map = self.store.load()?;
        let Some(encoded) = secret_key_entry(&map, &binding_id) else {
            return Ok(None);
        };
        let bytes =
            crate::base64::decode(encoded).ok_or_else(|| ProviderKeysError::NeedsRotation {
                provider_id: binding_id.clone(),
            })?;
        match self.cipher.decrypt_string(&account, &bytes) {
            Ok(binding) => Ok(Some(binding)),
            Err(SecretCipherError::NeedsRotation) => Err(ProviderKeysError::NeedsRotation {
                provider_id: binding_id,
            }),
            Err(err) => Err(ProviderKeysError::SecureStorage(err.to_string())),
        }
    }

    /// Remove a provider's value slot and its keychain entry.
    pub fn delete(&self, provider_id: &str) -> Result<(), ProviderKeysError> {
        let _ = self.cipher.delete_entry(&keychain_account_for(provider_id));
        let _ = self.keychain.delete(&keychain_account_for(provider_id));
        self.store.update(|map| {
            delete_secret_key_entry(map, provider_id);
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    /// A test cipher that behaves like the TS `CredentialCipher` test seam:
    /// `encrypted:<value>` bytes with an in-memory vault.
    #[derive(Default)]
    struct MemoryCipher {
        vault: StdMutex<HashMap<String, String>>,
        unavailable: bool,
    }

    impl SecretCipher for MemoryCipher {
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

    #[test]
    fn prototype_sensitive_provider_ids_round_trip_as_own_entries() {
        for provider_id in ["__proto__", "constructor", "toString"] {
            let mut map = normalize_secret_key_map(&Value::Object(Map::new()));
            assert_eq!(secret_key_entry(&map, provider_id), None);

            set_secret_key_entry(&mut map, provider_id, format!("ciphertext:{provider_id}"));
            let restarted = normalize_secret_key_map(&serde_json::to_value(&map).unwrap());

            assert_eq!(
                secret_key_entry(&restarted, provider_id),
                Some(format!("ciphertext:{provider_id}").as_str())
            );
            assert!(delete_secret_key_entry(&mut map, provider_id));
            assert_eq!(secret_key_entry(&map, provider_id), None);
        }
    }

    #[test]
    fn strict_secret_map_parsing_rejects_roots_that_a_write_must_never_replace() {
        for value in [
            Value::Null,
            Value::Array(vec![]),
            Value::String("ciphertext".into()),
            Value::Number(1.into()),
        ] {
            assert!(matches!(
                parse_secret_key_map(&value),
                Err(SecretMapError::InvalidMap)
            ));
        }
        let parsed = parse_secret_key_map(&serde_json::json!({
            "provider": "ciphertext",
            "future": {}
        }))
        .unwrap();
        assert_eq!(parsed["provider"], "ciphertext");
        assert_eq!(parsed["future"], serde_json::json!({}));
    }

    #[test]
    fn secret_maps_preserve_unknown_future_entries_without_exposing_them_as_ciphertext() {
        let normalized = normalize_secret_key_map(&serde_json::json!({
            "valid": "ciphertext",
            "invalid": {},
            "empty": ""
        }));
        assert_eq!(normalized["valid"], "ciphertext");
        assert_eq!(normalized["invalid"], serde_json::json!({}));
        assert_eq!(normalized["empty"], "");
        let future = normalize_secret_key_map(&serde_json::json!({
            "future": { "ciphertext": "value" }
        }));
        assert_eq!(secret_key_entry(&future, "future"), None);
    }

    #[test]
    fn bound_credential_pairs_move_to_quarantine_without_losing_ciphertext() {
        let active = SecretEntryPair::active("provider");
        let quarantine = SecretEntryPair::quarantine("provider");
        let mut map = normalize_secret_key_map(&serde_json::json!({
            "provider": "encrypted-key-a",
            "__aiden_internal_provider_binding_v1__:provider": "encrypted-binding-a",
        }));
        assert!(move_secret_entry_pair_if_vacant(
            &mut map,
            &active,
            &quarantine
        ));
        assert_eq!(secret_key_entry(&map, "provider"), None);
        assert_eq!(
            secret_key_entry(&map, "quarantine:provider"),
            Some("encrypted-key-a")
        );
        assert_eq!(
            secret_key_entry(&map, "quarantine-binding:provider"),
            Some("encrypted-binding-a")
        );
    }

    #[test]
    fn unbound_legacy_credentials_move_to_quarantine_without_deleting_ciphertext() {
        let quarantine = SecretEntryPair::quarantine("provider");
        let mut map =
            normalize_secret_key_map(&serde_json::json!({ "provider": "encrypted-legacy-key" }));
        assert!(move_secret_entry_with_binding_if_vacant(
            &mut map,
            "provider",
            &quarantine,
            "encrypted-legacy-marker".to_string(),
        ));
        assert_eq!(secret_key_entry(&map, "provider"), None);
        assert_eq!(
            secret_key_entry(&map, "quarantine:provider"),
            Some("encrypted-legacy-key")
        );
        assert_eq!(
            secret_key_entry(&map, "quarantine-binding:provider"),
            Some("encrypted-legacy-marker")
        );
    }

    #[test]
    fn an_occupied_quarantine_never_destroys_an_unbound_legacy_credential() {
        let quarantine = SecretEntryPair::quarantine("provider");
        let mut map = normalize_secret_key_map(&serde_json::json!({
            "provider": "encrypted-legacy-key",
            "quarantine:provider": "encrypted-quarantined-key",
            "quarantine-binding:provider": "encrypted-quarantined-binding",
        }));
        assert!(!move_secret_entry_with_binding_if_vacant(
            &mut map,
            "provider",
            &quarantine,
            "encrypted-legacy-marker".to_string(),
        ));
        assert_eq!(
            secret_key_entry(&map, "provider"),
            Some("encrypted-legacy-key")
        );
        assert_eq!(
            secret_key_entry(&map, "quarantine:provider"),
            Some("encrypted-quarantined-key")
        );
    }

    #[test]
    fn a_legacy_secret_gains_a_binding_only_when_no_binding_record_exists() {
        let mut map = normalize_secret_key_map(&serde_json::json!({ "legacy": "encrypted-key" }));
        assert!(bind_secret_entry_if_unbound(
            &mut map,
            "legacy",
            &binding_id_for("legacy"),
            "encrypted-binding".to_string(),
        ));
        assert_eq!(secret_key_entry(&map, "legacy"), Some("encrypted-key"));
        assert_eq!(
            secret_key_entry(&map, &binding_id_for("legacy")),
            Some("encrypted-binding")
        );
        assert!(!bind_secret_entry_if_unbound(
            &mut map,
            "legacy",
            &binding_id_for("legacy"),
            "replacement-binding".to_string(),
        ));
    }

    #[test]
    fn returning_endpoints_swap_active_and_quarantined_bound_credentials_atomically() {
        let active = SecretEntryPair::active("provider");
        let quarantine = SecretEntryPair::quarantine("provider");
        let mut map = normalize_secret_key_map(&serde_json::json!({
            "provider": "encrypted-key-c",
            "__aiden_internal_provider_binding_v1__:provider": "encrypted-binding-c",
            "quarantine:provider": "encrypted-key-b",
            "quarantine-binding:provider": "encrypted-binding-b",
        }));
        assert!(swap_secret_entry_pairs(&mut map, &active, &quarantine));
        assert_eq!(secret_key_entry(&map, "provider"), Some("encrypted-key-b"));
        assert_eq!(
            secret_key_entry(&map, "__aiden_internal_provider_binding_v1__:provider"),
            Some("encrypted-binding-b")
        );
        assert_eq!(
            secret_key_entry(&map, "quarantine:provider"),
            Some("encrypted-key-c")
        );
    }

    #[test]
    fn base64_round_trip_long_payloads() {
        for payload in [
            br#"encrypted:{"type":"oauth","access":"access-secret","refresh":"refresh-access-secret","expires":2e12,"accountId":"account-test"}"#.as_slice(),
            br#"encrypted:{"type":"api_key","key":"secret"}"#.as_slice(),
            br#"encrypted:{"type":"oauth","access":"codex","refresh":"refresh-codex","expires":2e12,"accountId":"account-test"}"#.as_slice(),
        ] {
            let encoded = crate::base64::encode(payload);
            assert_eq!(
                crate::base64::decode(&encoded).unwrap(),
                payload,
                "round trip failed for {encoded}"
            );
        }
    }

    #[test]
    fn provider_keys_store_round_trips_through_the_injected_cipher() {
        let dir = tempfile::tempdir().unwrap();
        let cipher: Arc<dyn SecretCipher> = Arc::new(MemoryCipher::default());
        let store = ProviderKeysStore::new(dir.path().to_path_buf(), "aiden-agent", cipher.clone());
        store.set("anthropic", "sk-test").unwrap();
        assert!(store.has_key("anthropic").unwrap());
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("sk-test"));
        assert_eq!(
            store.status("anthropic").unwrap(),
            SecretEntryStatus::KeyringBacked
        );
        store
            .set_binding(
                "anthropic",
                r#"{"id":"anthropic","baseUrl":"https://api.anthropic.com/v1"}"#,
            )
            .unwrap();
        assert!(store.get_binding("anthropic").unwrap().is_some());
        store.delete("anthropic").unwrap();
        assert_eq!(store.get("anthropic").unwrap(), None);
    }

    #[test]
    fn legacy_safe_storage_blobs_are_flagged_needs_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let cipher: Arc<dyn SecretCipher> = Arc::new(MemoryCipher::default());
        let store = ProviderKeysStore::new(dir.path().to_path_buf(), "aiden-agent", cipher.clone());
        // Simulate an Electron-era install: a slot holding base64 safeStorage
        // ciphertext (which does not match our marker).
        std::fs::write(
            dir.path().join("provider-keys.json"),
            "{\n  \"legacy-provider\": \"dGhpcyBpcyBub3Qgb3VyIG1hcmtlcg==\"\n}\n",
        )
        .unwrap();
        assert_eq!(
            store.status("legacy-provider").unwrap(),
            SecretEntryStatus::NeedsRotation
        );
        assert!(matches!(
            store.get("legacy-provider"),
            Err(ProviderKeysError::NeedsRotation { .. })
        ));
        assert!(store.has_key("legacy-provider").unwrap());
    }
}
