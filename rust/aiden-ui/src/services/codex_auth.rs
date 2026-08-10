//! Host-owned ChatGPT/Codex credential adapter.
//!
//! OAuth setup and request-time refresh deliberately share this adapter, so a
//! token can never be read from or written to a weaker UI-owned store.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aiden_data::pi_credential_store::{EncryptedPiCredentialStore, PiCredentialError};
use aiden_providers::codex::{
    extract_account_id, CodexAuthStore, OAuthCredential, OPENAI_CODEX_PROVIDER_ID,
};
use aiden_providers::ProviderError;

#[derive(Clone)]
pub struct PiCodexAuthStore {
    credentials: Arc<EncryptedPiCredentialStore>,
    mutation_revision: Arc<AtomicU64>,
    mutation_lock: Arc<Mutex<()>>,
}

pub struct CodexAuthAttemptGuard {
    cancelled: Arc<AtomicBool>,
    store: Arc<PiCodexAuthStore>,
    revision: u64,
}

impl CodexAuthAttemptGuard {
    pub fn new(store: Arc<PiCodexAuthStore>) -> Self {
        let revision = store.begin_auth_attempt();
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            store,
            revision,
        }
    }

    pub fn cancelled(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.store.invalidate_auth_attempts();
    }
}

impl Drop for CodexAuthAttemptGuard {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Clone, Default)]
pub struct CodexDialogLease {
    open: Arc<AtomicBool>,
    restore_focus: Arc<AtomicBool>,
}

impl CodexDialogLease {
    pub fn mark_open(&self) {
        self.open.store(true, Ordering::SeqCst);
    }

    pub fn mark_closed(&self) {
        self.open.store(false, Ordering::SeqCst);
    }

    pub fn request_focus_restore(&self) {
        self.restore_focus.store(true, Ordering::SeqCst);
    }

    pub fn should_restore_focus(&self) -> bool {
        self.restore_focus.load(Ordering::SeqCst)
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    pub fn is_same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.open, &other.open)
    }

    pub fn take_owned_dialog(&self) -> bool {
        self.open.swap(false, Ordering::SeqCst)
    }
}

impl PiCodexAuthStore {
    pub fn new(credentials: Arc<EncryptedPiCredentialStore>) -> Self {
        Self {
            credentials,
            mutation_revision: Arc::new(AtomicU64::new(0)),
            mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn is_configured(&self) -> Result<bool, ProviderError> {
        self.read().map(|credential| credential.is_some())
    }

    /// A display-safe account hint derived locally from the validated JWT.
    /// The complete account id and both OAuth tokens remain outside the UI.
    pub fn account_status(&self) -> Result<(Option<String>, bool), ProviderError> {
        let (credential, needs_attention) = self.auth_snapshot()?;
        let account = credential
            .map(|credential| {
                extract_account_id(&credential.access).map(|account_id| {
                    let suffix: String = account_id
                        .chars()
                        .rev()
                        .take(6)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    format!("Account ending in {suffix}")
                })
            })
            .transpose()?;
        Ok((account, needs_attention))
    }

    pub fn clear(&self) -> Result<(), ProviderError> {
        self.invalidate_auth_attempts();
        let _guard = self.lock_mutations()?;
        self.delete_credential()
    }

    /// Starts an explicit OAuth attempt and fences every older completion.
    pub fn begin_auth_attempt(&self) -> u64 {
        self.mutation_revision.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Prevents an in-flight OAuth completion from committing credentials.
    pub fn invalidate_auth_attempts(&self) {
        self.mutation_revision.fetch_add(1, Ordering::SeqCst);
    }

    /// Persists an OAuth result only while its explicit attempt is still current.
    pub fn commit_auth_attempt(
        &self,
        revision: u64,
        credential: &OAuthCredential,
    ) -> Result<bool, ProviderError> {
        let _guard = self.lock_mutations()?;
        if self.mutation_revision.load(Ordering::SeqCst) != revision {
            return Ok(false);
        }
        self.persist_credential(credential)?;
        Ok(true)
    }

    fn lock_mutations(&self) -> Result<std::sync::MutexGuard<'_, ()>, ProviderError> {
        self.mutation_lock
            .lock()
            .map_err(|_| oauth_error("ChatGPT credential storage is temporarily unavailable."))
    }

    fn persist_credential(&self, credential: &OAuthCredential) -> Result<(), ProviderError> {
        let value = serde_json::json!({
            "type": "oauth",
            "access": credential.access,
            "refresh": credential.refresh,
            "expires": credential.expires,
            "needsAttention": false,
        });
        self.credentials
            .modify(OPENAI_CODEX_PROVIDER_ID, |_| Ok(Some(value)))
            .map(|_| ())
            .map_err(map_store_error)
    }

    fn delete_credential(&self) -> Result<(), ProviderError> {
        self.credentials
            .delete(OPENAI_CODEX_PROVIDER_ID)
            .map_err(map_store_error)
    }
}

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_USER_CODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const DEVICE_VERIFICATION_URI: &str = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const DEVICE_CODE_TIMEOUT_SECONDS: u64 = 15 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexDeviceAuthorization {
    device_auth_id: String,
    pub user_code: String,
    pub interval_seconds: u64,
    pub expires_in_seconds: u64,
}

#[derive(Clone)]
pub struct CodexDeviceOAuth {
    client: reqwest::Client,
}

impl Default for CodexDeviceOAuth {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("fixed OAuth HTTP client configuration is valid"),
        }
    }
}

impl CodexDeviceOAuth {
    pub async fn begin(
        &self,
        cancelled: &AtomicBool,
    ) -> Result<CodexDeviceAuthorization, ProviderError> {
        let response = cancellable_request(
            cancelled,
            self.client
                .post(DEVICE_USER_CODE_URL)
                .json(&serde_json::json!({ "client_id": CLIENT_ID }))
                .send(),
        )
        .await
        .map_err(|error| request_error(error, "ChatGPT sign-in could not reach OpenAI."))?;
        if !response.status().is_success() {
            return Err(oauth_error("ChatGPT device sign-in is unavailable."));
        }
        let value: serde_json::Value = cancellable_request(cancelled, response.json())
            .await
            .map_err(|error| {
                request_error(error, "OpenAI returned an invalid sign-in response.")
            })?;
        let device_auth_id = value
            .get("device_auth_id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty());
        let user_code = value
            .get("user_code")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty());
        let interval_seconds = value
            .get("interval")
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
            })
            .unwrap_or(5)
            .clamp(1, 30);
        match (device_auth_id, user_code) {
            (Some(device_auth_id), Some(user_code)) if user_code.len() <= 256 => {
                Ok(CodexDeviceAuthorization {
                    device_auth_id: device_auth_id.to_string(),
                    user_code: user_code.to_string(),
                    interval_seconds,
                    expires_in_seconds: DEVICE_CODE_TIMEOUT_SECONDS,
                })
            }
            _ => Err(oauth_error("OpenAI returned an invalid sign-in response.")),
        }
    }

    pub async fn complete(
        &self,
        authorization: &CodexDeviceAuthorization,
        cancelled: &AtomicBool,
    ) -> Result<OAuthCredential, ProviderError> {
        let started = std::time::Instant::now();
        let mut interval = authorization.interval_seconds;
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err(oauth_error("ChatGPT sign-in was cancelled."));
            }
            if started.elapsed() >= Duration::from_secs(authorization.expires_in_seconds) {
                return Err(oauth_error(
                    "ChatGPT sign-in expired. Start a new sign-in attempt.",
                ));
            }
            wait_for_poll_interval(Duration::from_secs(interval), cancelled).await?;
            let response = cancellable_request(
                cancelled,
                self.client
                    .post(DEVICE_TOKEN_URL)
                    .json(&serde_json::json!({
                        "device_auth_id": authorization.device_auth_id,
                        "user_code": authorization.user_code,
                    }))
                    .send(),
            )
            .await
            .map_err(|error| request_error(error, "ChatGPT sign-in could not reach OpenAI."))?;
            if response.status().is_success() {
                let value: serde_json::Value = cancellable_request(cancelled, response.json())
                    .await
                    .map_err(|error| {
                        request_error(error, "OpenAI returned an invalid sign-in response.")
                    })?;
                let code = value
                    .get("authorization_code")
                    .and_then(serde_json::Value::as_str);
                let verifier = value
                    .get("code_verifier")
                    .and_then(serde_json::Value::as_str);
                let (Some(code), Some(verifier)) = (code, verifier) else {
                    return Err(oauth_error("OpenAI returned an invalid sign-in response."));
                };
                return self.exchange(code, verifier, cancelled).await;
            }
            if matches!(response.status().as_u16(), 403 | 404) {
                continue;
            }
            let value: serde_json::Value = cancellable_request(cancelled, response.json())
                .await
                .unwrap_or_default();
            let code = value
                .pointer("/error/code")
                .or_else(|| value.get("error"))
                .and_then(serde_json::Value::as_str);
            match code {
                Some("deviceauth_authorization_pending") => continue,
                Some("slow_down") => interval = interval.saturating_add(5).min(30),
                _ => return Err(oauth_error("ChatGPT sign-in was not accepted by OpenAI.")),
            }
        }
    }

    async fn exchange(
        &self,
        code: &str,
        verifier: &str,
        cancelled: &AtomicBool,
    ) -> Result<OAuthCredential, ProviderError> {
        let response = cancellable_request(
            cancelled,
            self.client
                .post(TOKEN_URL)
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", CLIENT_ID),
                    ("code", code),
                    ("code_verifier", verifier),
                    ("redirect_uri", DEVICE_REDIRECT_URI),
                ])
                .send(),
        )
        .await
        .map_err(|error| request_error(error, "ChatGPT sign-in could not reach OpenAI."))?;
        if !response.status().is_success() {
            return Err(oauth_error("ChatGPT sign-in was not accepted by OpenAI."));
        }
        let value: serde_json::Value = cancellable_request(cancelled, response.json())
            .await
            .map_err(|error| request_error(error, "OpenAI returned an invalid token response."))?;
        let access = value
            .get("access_token")
            .and_then(serde_json::Value::as_str);
        let refresh = value
            .get("refresh_token")
            .and_then(serde_json::Value::as_str);
        let expires_in = value.get("expires_in").and_then(serde_json::Value::as_u64);
        let (Some(access), Some(refresh), Some(expires_in)) = (access, refresh, expires_in) else {
            return Err(oauth_error("OpenAI returned an invalid token response."));
        };
        extract_account_id(access)
            .map_err(|_| oauth_error("OpenAI returned a token without a ChatGPT account."))?;
        Ok(OAuthCredential {
            access: access.to_string(),
            refresh: refresh.to_string(),
            expires: aiden_data::now_millis().saturating_add(expires_in.saturating_mul(1000)),
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum CancellableRequestError {
    Cancelled,
    Transport,
}

fn request_error(error: CancellableRequestError, fallback: &str) -> ProviderError {
    match error {
        CancellableRequestError::Cancelled => oauth_error("ChatGPT sign-in was cancelled."),
        CancellableRequestError::Transport => oauth_error(fallback),
    }
}

async fn cancellable_request<T>(
    cancelled: &AtomicBool,
    request: impl std::future::Future<Output = Result<T, reqwest::Error>>,
) -> Result<T, CancellableRequestError> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(CancellableRequestError::Cancelled);
    }
    tokio::pin!(request);
    loop {
        tokio::select! {
            result = &mut request => return result.map_err(|_| CancellableRequestError::Transport),
            () = tokio::time::sleep(Duration::from_millis(50)) => {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(CancellableRequestError::Cancelled);
                }
            }
        }
    }
}

async fn wait_for_poll_interval(
    duration: Duration,
    cancelled: &AtomicBool,
) -> Result<(), ProviderError> {
    let deadline = tokio::time::Instant::now() + duration;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(oauth_error("ChatGPT sign-in was cancelled."));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
    }
}

fn oauth_error(message: &str) -> ProviderError {
    ProviderError::Auth(message.to_string())
}

pub fn auth_revision_is_current(current: u64, completion: u64) -> bool {
    current == completion
}

impl CodexAuthStore for PiCodexAuthStore {
    fn read(&self) -> Result<Option<OAuthCredential>, ProviderError> {
        let value = self
            .credentials
            .read(OPENAI_CODEX_PROVIDER_ID)
            .map_err(map_store_error)?;
        value.map(parse_oauth_credential).transpose()
    }

    fn write(&self, credential: Option<&OAuthCredential>) -> Result<(), ProviderError> {
        let _guard = self.lock_mutations()?;
        self.invalidate_auth_attempts();
        match credential {
            Some(credential) => self.persist_credential(credential)?,
            None => self.delete_credential()?,
        }
        Ok(())
    }

    fn compare_and_swap(
        &self,
        expected: Option<&OAuthCredential>,
        replacement: Option<&OAuthCredential>,
    ) -> Result<bool, ProviderError> {
        let _guard = self.lock_mutations()?;
        if self.read()?.as_ref() != expected {
            return Ok(false);
        }
        self.invalidate_auth_attempts();
        match replacement {
            Some(credential) => self.persist_credential(credential)?,
            None => self.delete_credential()?,
        }
        Ok(true)
    }

    fn auth_snapshot(&self) -> Result<(Option<OAuthCredential>, bool), ProviderError> {
        let _guard = self.lock_mutations()?;
        let value = self
            .credentials
            .read(OPENAI_CODEX_PROVIDER_ID)
            .map_err(map_store_error)?;
        let needs_attention = value
            .as_ref()
            .and_then(|value| value.get("needsAttention"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        Ok((
            value.map(parse_oauth_credential).transpose()?,
            needs_attention,
        ))
    }

    fn compare_and_set_needs_attention(
        &self,
        expected: &OAuthCredential,
        needs_attention: bool,
    ) -> Result<bool, ProviderError> {
        let _guard = self.lock_mutations()?;
        let mut matched = false;
        self.credentials
            .modify(OPENAI_CODEX_PROVIDER_ID, |current| {
                let Some(mut current) = current.cloned() else {
                    return Ok(None);
                };
                let current_credential = oauth_credential_from_value(&current)
                    .ok_or(PiCredentialError::InvalidOAuthCredential)?;
                if &current_credential != expected {
                    return Ok(None);
                }
                matched = true;
                current
                    .as_object_mut()
                    .ok_or(PiCredentialError::InvalidOAuthCredential)?
                    .insert(
                        "needsAttention".to_string(),
                        serde_json::Value::Bool(needs_attention),
                    );
                Ok(Some(current))
            })
            .map_err(map_store_error)?;
        Ok(matched)
    }
}

fn oauth_credential_from_value(value: &serde_json::Value) -> Option<OAuthCredential> {
    Some(OAuthCredential {
        access: value.get("access")?.as_str()?.to_string(),
        refresh: value.get("refresh")?.as_str()?.to_string(),
        expires: value.get("expires")?.as_u64()?,
    })
}

fn parse_oauth_credential(value: serde_json::Value) -> Result<OAuthCredential, ProviderError> {
    let access = value
        .get("access")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty());
    let refresh = value
        .get("refresh")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty());
    let expires = value.get("expires").and_then(serde_json::Value::as_u64);
    match (access, refresh, expires) {
        (Some(access), Some(refresh), Some(expires)) => Ok(OAuthCredential {
            access: access.to_string(),
            refresh: refresh.to_string(),
            expires,
        }),
        _ => Err(ProviderError::Auth(
            "The stored ChatGPT sign-in is invalid. Sign in again.".to_string(),
        )),
    }
}

fn map_store_error(error: PiCredentialError) -> ProviderError {
    tracing::warn!(
        error_kind = std::any::type_name_of_val(&error),
        "ChatGPT credential storage operation failed"
    );
    ProviderError::Auth(
        "ChatGPT secure storage is unavailable. Check Keychain access and try again.".to_string(),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;

    use aiden_data::pi_credential_store::EncryptedPiCredentialStoreOptions;
    use aiden_data::secret_map::{SecretCipher, SecretCipherError};

    use super::*;

    #[derive(Default)]
    struct MemoryCipher(Mutex<HashMap<String, String>>);

    impl SecretCipher for MemoryCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.0
                .lock()
                .map_err(|_| SecretCipherError::Keychain("memory cipher poisoned".to_string()))?
                .insert(account.to_string(), value.to_string());
            Ok(b"vault".to_vec())
        }

        fn decrypt_string(&self, account: &str, _: &[u8]) -> Result<String, SecretCipherError> {
            self.0
                .lock()
                .map_err(|_| SecretCipherError::Keychain("memory cipher poisoned".to_string()))?
                .get(account)
                .cloned()
                .ok_or_else(|| SecretCipherError::Keychain("missing memory value".to_string()))
        }
    }

    fn store(root: &Path) -> PiCodexAuthStore {
        store_with_cipher(root, Arc::new(MemoryCipher::default()))
    }

    fn store_with_cipher(root: &Path, cipher: Arc<dyn SecretCipher>) -> PiCodexAuthStore {
        PiCodexAuthStore::new(Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: root.join("pi-provider-credentials.json"),
                cipher,
                sync_directory: Some(Box::new(|_| Ok(()))),
                on_durability_warning: None,
                before_document_write: None,
            },
        )))
    }

    #[test]
    fn credential_round_trip_keeps_tokens_out_of_the_document() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let credential = OAuthCredential {
            access: "access-secret".to_string(),
            refresh: "refresh-secret".to_string(),
            expires: 42,
        };

        store.write(Some(&credential)).unwrap();

        assert_eq!(store.read().unwrap(), Some(credential));
        let disk =
            std::fs::read_to_string(root.path().join("pi-provider-credentials.json")).unwrap();
        assert!(!disk.contains("access-secret"));
        assert!(!disk.contains("refresh-secret"));
    }

    #[test]
    fn clear_removes_the_codex_credential() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        store
            .write(Some(&OAuthCredential {
                access: "access".to_string(),
                refresh: "refresh".to_string(),
                expires: 42,
            }))
            .unwrap();

        store.clear().unwrap();

        assert_eq!(store.read().unwrap(), None);
    }

    #[tokio::test]
    async fn device_flow_cancels_before_any_poll_request() {
        let authorization = CodexDeviceAuthorization {
            device_auth_id: "device".to_string(),
            user_code: "CODE".to_string(),
            interval_seconds: 1,
            expires_in_seconds: 60,
        };
        let cancelled = AtomicBool::new(true);

        let error = CodexDeviceOAuth::default()
            .complete(&authorization, &cancelled)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
    }

    #[tokio::test]
    async fn poll_wait_observes_cancellation_promptly() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation = cancelled.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancellation.store(true, Ordering::SeqCst);
        });

        let result = wait_for_poll_interval(Duration::from_secs(30), &cancelled).await;

        assert!(result.unwrap_err().to_string().contains("cancelled"));
    }

    #[test]
    fn cancelled_auth_attempt_cannot_commit_a_credential() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let revision = store.begin_auth_attempt();
        store.invalidate_auth_attempts();

        let committed = store
            .commit_auth_attempt(
                revision,
                &OAuthCredential {
                    access: "stale-access".to_string(),
                    refresh: "stale-refresh".to_string(),
                    expires: 42,
                },
            )
            .unwrap();

        assert!(!committed);
        assert_eq!(store.read().unwrap(), None);
    }

    #[test]
    fn sign_out_fences_an_older_auth_completion() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let revision = store.begin_auth_attempt();
        store.clear().unwrap();

        assert!(!store
            .commit_auth_attempt(
                revision,
                &OAuthCredential {
                    access: "stale-access".to_string(),
                    refresh: "stale-refresh".to_string(),
                    expires: 42,
                },
            )
            .unwrap());
        assert_eq!(store.read().unwrap(), None);
    }

    #[test]
    fn separate_store_instances_cannot_apply_old_attention_to_a_new_login() {
        let root = tempfile::tempdir().unwrap();
        let cipher: Arc<dyn SecretCipher> = Arc::new(MemoryCipher::default());
        let old_writer = store_with_cipher(root.path(), Arc::clone(&cipher));
        let new_writer = store_with_cipher(root.path(), cipher);
        let old = OAuthCredential {
            access: "old".into(),
            refresh: "old-refresh".into(),
            expires: 1,
        };
        let new = OAuthCredential {
            access: "new".into(),
            refresh: "new-refresh".into(),
            expires: 2,
        };
        old_writer.write(Some(&old)).unwrap();
        new_writer.write(Some(&new)).unwrap();

        assert!(!old_writer
            .compare_and_set_needs_attention(&old, true)
            .unwrap());
        assert_eq!(new_writer.auth_snapshot().unwrap(), (Some(new), false));
    }

    #[test]
    fn stale_auth_completion_is_rejected() {
        assert!(!auth_revision_is_current(8, 7));
        assert!(auth_revision_is_current(8, 8));
    }

    #[test]
    fn dialog_lease_never_closes_or_restores_after_external_replacement() {
        let lease = CodexDialogLease::default();
        lease.mark_open();
        lease.mark_closed();

        assert!(!lease.take_owned_dialog());
        assert!(!lease.should_restore_focus());
    }

    #[test]
    fn owned_dialog_completion_is_one_shot_and_requests_focus_restore() {
        let lease = CodexDialogLease::default();
        lease.mark_open();

        assert!(lease.take_owned_dialog());
        lease.request_focus_restore();
        assert!(lease.should_restore_focus());
        assert!(!lease.take_owned_dialog());
    }
}
