//! App-lifetime authority for Pi-native provider inventory and credentials.
//!
//! The release-pinned descriptor table is local-only. It is combined with the
//! bundled model-capabilities snapshot at read time; ordinary boot/status reads
//! never contact a provider or open a browser.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_data::pi_credential_store::{EncryptedPiCredentialStore, PiCredentialError};
use aiden_data::portable_config::{ProviderDeployment, ProviderKind, ProviderModelMetadata};
use aiden_providers::model_capabilities::{
    load_default_capabilities, lookup_provider, ModelCapabilitiesCatalog,
};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::services::provider_kit::ConfiguredProvider;

const MAX_API_KEY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiNativeApi {
    Anthropic,
    Google,
    OpenAiCompletions,
    OpenAiResponses,
}

#[derive(Debug, Clone, Copy)]
pub struct PiProviderDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub base_url: &'static str,
    pub api: Option<PiNativeApi>,
    pub oauth_label: Option<&'static str>,
}

macro_rules! provider {
    ($id:literal, $label:literal, $url:literal, $api:expr) => {
        PiProviderDescriptor {
            id: $id,
            label: $label,
            base_url: $url,
            api: $api,
            oauth_label: None,
        }
    };
}

/// Exact provider inventory from the pinned `@earendil-works/pi-ai` 0.80.10
/// `builtinProviders()` list, excluding Codex (which has a separate accepted
/// OAuth authority).
pub const PI_PROVIDER_DESCRIPTORS: &[PiProviderDescriptor] = &[
    provider!("amazon-bedrock", "Amazon Bedrock", "", None),
    provider!(
        "ant-ling",
        "Ant Ling",
        "https://api.ant-ling.com/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    PiProviderDescriptor {
        id: "anthropic",
        label: "Anthropic",
        base_url: "https://api.anthropic.com",
        api: Some(PiNativeApi::Anthropic),
        oauth_label: Some("Anthropic (Claude Pro/Max)"),
    },
    provider!("azure-openai-responses", "Azure OpenAI", "", None),
    provider!(
        "cerebras",
        "Cerebras",
        "https://api.cerebras.ai/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!("cloudflare-ai-gateway", "Cloudflare AI Gateway", "", None),
    provider!("cloudflare-workers-ai", "Cloudflare Workers AI", "", None),
    provider!(
        "deepseek",
        "DeepSeek",
        "https://api.deepseek.com",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "fireworks",
        "Fireworks",
        "https://api.fireworks.ai/inference",
        None
    ),
    provider!(
        "github-copilot",
        "GitHub Copilot",
        "https://api.individual.githubcopilot.com",
        None
    ),
    provider!(
        "google",
        "Google",
        "https://generativelanguage.googleapis.com/v1beta",
        Some(PiNativeApi::Google)
    ),
    provider!("google-vertex", "Google Vertex AI", "", None),
    provider!(
        "groq",
        "Groq",
        "https://api.groq.com/openai/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "huggingface",
        "Hugging Face",
        "https://router.huggingface.co/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "kimi-coding",
        "Kimi For Coding",
        "https://api.kimi.com/coding",
        None
    ),
    provider!(
        "minimax",
        "MiniMax",
        "https://api.minimax.io/anthropic",
        None
    ),
    provider!(
        "minimax-cn",
        "MiniMax CN",
        "https://api.minimaxi.com/anthropic",
        None
    ),
    provider!("mistral", "Mistral", "https://api.mistral.ai", None),
    provider!(
        "moonshotai",
        "Moonshot AI",
        "https://api.moonshot.ai/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "moonshotai-cn",
        "Moonshot AI CN",
        "https://api.moonshot.cn/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "nvidia",
        "NVIDIA",
        "https://integrate.api.nvidia.com/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "openai",
        "OpenAI",
        "https://api.openai.com/v1",
        Some(PiNativeApi::OpenAiResponses)
    ),
    provider!("opencode", "OpenCode Zen", "", None),
    provider!("opencode-go", "OpenCode Zen Go", "", None),
    provider!(
        "openrouter",
        "OpenRouter",
        "https://openrouter.ai/api/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!("radius", "Radius", "", None),
    provider!(
        "together",
        "Together",
        "https://api.together.ai/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "vercel-ai-gateway",
        "Vercel AI Gateway",
        "https://ai-gateway.vercel.sh",
        None
    ),
    provider!("xai", "xAI", "https://api.x.ai/v1", None),
    provider!(
        "xiaomi",
        "Xiaomi",
        "https://api.xiaomimimo.com/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "xiaomi-token-plan-ams",
        "Xiaomi Token Plan AMS",
        "https://token-plan-ams.xiaomimimo.com/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "xiaomi-token-plan-cn",
        "Xiaomi Token Plan CN",
        "https://token-plan-cn.xiaomimimo.com/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "xiaomi-token-plan-sgp",
        "Xiaomi Token Plan SGP",
        "https://token-plan-sgp.xiaomimimo.com/v1",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "zai",
        "Z.AI",
        "https://api.z.ai/api/coding/paas/v4",
        Some(PiNativeApi::OpenAiCompletions)
    ),
    provider!(
        "zai-coding-cn",
        "Z.AI Coding CN",
        "https://open.bigmodel.cn/api/coding/paas/v4",
        Some(PiNativeApi::OpenAiCompletions)
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiAuthMethodStatus {
    pub id: &'static str,
    pub label: String,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PiProviderStatus {
    pub provider: ConfiguredProvider,
    pub configured: bool,
    pub revision: u64,
    pub auth_methods: Vec<PiAuthMethodStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PiSetupLease {
    revision: u64,
}

/// Process-only credential snapshot for a single provider operation.
///
/// The secret deliberately has no public accessor. Callers inside the app
/// services layer may borrow it only while constructing the exact request, and
/// must revalidate the lease before applying a response.
#[derive(Clone)]
pub(crate) struct PiApiKeyLease {
    provider_id: String,
    api_key: String,
    binding: String,
    revision: u64,
}

impl PiApiKeyLease {
    pub(crate) fn secret(&self) -> &str {
        &self.api_key
    }
}

#[cfg(test)]
impl PiSetupLease {
    pub(crate) fn for_test(revision: u64) -> Self {
        Self { revision }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PiProviderSetupError {
    #[error("This Pi provider is not part of the current release.")]
    UnknownProvider,
    #[error("This provider's Pi-native request transport is not available in the Rust app yet.")]
    TransportUnavailable,
    #[error("Enter an API key between 1 and 65536 bytes.")]
    InvalidApiKey,
    #[error("Provider setup changed while this operation was running. Try again.")]
    Stale,
    #[error("Secure provider storage is unavailable. No credential was changed.")]
    SecureStorage,
}

impl From<PiCredentialError> for PiProviderSetupError {
    fn from(_: PiCredentialError) -> Self {
        Self::SecureStorage
    }
}

pub struct PiProviderSetupAuthority {
    credentials: Arc<EncryptedPiCredentialStore>,
    catalog: ModelCapabilitiesCatalog,
    revision: AtomicU64,
    mutation: Mutex<()>,
    changed: tokio::sync::watch::Sender<u64>,
}

impl PiProviderSetupAuthority {
    pub fn new(credentials: Arc<EncryptedPiCredentialStore>) -> Arc<Self> {
        let catalog = load_default_capabilities().unwrap_or_default();
        let (changed, _) = tokio::sync::watch::channel(0);
        Arc::new(Self {
            credentials,
            catalog,
            revision: AtomicU64::new(0),
            mutation: Mutex::new(()),
            changed,
        })
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changed.subscribe()
    }

    pub fn begin_setup(&self) -> PiSetupLease {
        PiSetupLease {
            revision: self.revision.load(Ordering::SeqCst),
        }
    }

    pub fn list(&self) -> Vec<PiProviderStatus> {
        PI_PROVIDER_DESCRIPTORS
            .iter()
            .map(|descriptor| self.status_for(descriptor))
            .collect()
    }

    pub fn configured_providers(&self) -> Vec<ConfiguredProvider> {
        self.list()
            .into_iter()
            .filter(|status| status.configured)
            .map(|status| status.provider)
            .collect()
    }

    pub fn api_key(&self, provider_id: &str) -> Option<String> {
        let descriptor = descriptor(provider_id)?;
        let credential = self.credentials.read(provider_id).ok()??;
        let object = credential.as_object()?;
        if object.get("binding")?.as_str()? != self.binding(descriptor) {
            return None;
        }
        object.get("key")?.as_str().map(str::to_string)
    }

    /// Resolve one exact release/catalog-bound credential under the setup
    /// mutation lock. The returned secret remains process-only.
    pub(crate) fn resolve_api_key_lease(&self, provider_id: &str) -> Option<PiApiKeyLease> {
        let _guard = self.mutation.lock();
        let descriptor = descriptor(provider_id)?;
        let binding = self.binding(descriptor);
        let api_key = self.api_key(provider_id)?;
        Some(PiApiKeyLease {
            provider_id: provider_id.to_string(),
            api_key,
            binding,
            revision: self.revision.load(Ordering::SeqCst),
        })
    }

    /// Revalidate a credential immediately before request admission and again
    /// before a response is allowed to affect UI/runtime state.
    pub(crate) fn ensure_api_key_lease(&self, lease: &PiApiKeyLease) -> bool {
        let _guard = self.mutation.lock();
        if self.revision.load(Ordering::SeqCst) != lease.revision {
            return false;
        }
        let Some(descriptor) = descriptor(&lease.provider_id) else {
            return false;
        };
        self.binding(descriptor) == lease.binding
            && self.api_key(&lease.provider_id).as_deref() == Some(lease.api_key.as_str())
    }

    pub fn commit_api_key(
        &self,
        provider_id: &str,
        key: &str,
        lease: PiSetupLease,
    ) -> Result<(), PiProviderSetupError> {
        let key = key.trim();
        if key.is_empty() || key.len() > MAX_API_KEY_BYTES {
            return Err(PiProviderSetupError::InvalidApiKey);
        }
        let descriptor = descriptor(provider_id).ok_or(PiProviderSetupError::UnknownProvider)?;
        if descriptor.api.is_none() {
            return Err(PiProviderSetupError::TransportUnavailable);
        }
        let _guard = self.mutation.lock();
        if self.revision.load(Ordering::SeqCst) != lease.revision {
            return Err(PiProviderSetupError::Stale);
        }
        let credential = serde_json::json!({ "type": "api_key", "key": key, "binding": self.binding(descriptor) });
        self.credentials
            .modify(provider_id, |_| Ok(Some(credential)))?;
        self.publish();
        Ok(())
    }

    pub fn sign_out(&self, provider_id: &str) -> Result<(), PiProviderSetupError> {
        descriptor(provider_id).ok_or(PiProviderSetupError::UnknownProvider)?;
        let _guard = self.mutation.lock();
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.credentials.delete(provider_id)?;
        let _ = self.changed.send(self.revision.load(Ordering::SeqCst));
        Ok(())
    }

    fn publish(&self) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.changed.send(revision);
    }

    fn status_for(&self, descriptor: &PiProviderDescriptor) -> PiProviderStatus {
        let provider = self.provider(descriptor);
        let configured = self.api_key(descriptor.id).is_some();
        let unavailable = descriptor.api.is_none().then(|| {
            "This provider uses a Pi transport that is not available in the Rust app yet."
                .to_string()
        });
        let mut auth_methods = vec![PiAuthMethodStatus {
            id: "api_key",
            label: "API key".to_string(),
            available: descriptor.api.is_some(),
            unavailable_reason: unavailable,
        }];
        if let Some(label) = descriptor.oauth_label {
            auth_methods.push(PiAuthMethodStatus {
                id: "oauth",
                label: label.to_string(),
                available: false,
                unavailable_reason: Some(
                    "This provider's Pi OAuth backend is Node-only in this release.".to_string(),
                ),
            });
        }
        PiProviderStatus {
            provider,
            configured,
            revision: self.revision.load(Ordering::SeqCst),
            auth_methods,
        }
    }

    fn provider(&self, descriptor: &PiProviderDescriptor) -> ConfiguredProvider {
        let catalog = lookup_provider(&self.catalog, descriptor.id);
        let mut models = catalog
            .map(|entry| entry.models.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        models.sort();
        let kind = if descriptor.api == Some(PiNativeApi::Anthropic) {
            ProviderKind::Anthropic
        } else {
            ProviderKind::Openai
        };
        ConfiguredProvider {
            id: descriptor.id.to_string(),
            label: descriptor.label.to_string(),
            kind,
            base_url: descriptor.base_url.to_string(),
            deployment: Some(ProviderDeployment::Hosted),
            default_model: models.first().cloned(),
            models,
            model_metadata: HashMap::<String, ProviderModelMetadata>::new(),
            catalog_models: Vec::new(),
            needs_key: true,
            has_key: self.api_key(descriptor.id).is_some(),
        }
    }

    fn binding(&self, descriptor: &PiProviderDescriptor) -> String {
        let mut models = lookup_provider(&self.catalog, descriptor.id)
            .map(|entry| entry.models.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        models.sort();
        let value = serde_json::json!({ "release": "pi-ai@0.80.10", "id": descriptor.id, "baseUrl": descriptor.base_url, "api": format!("{:?}", descriptor.api), "models": models });
        format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
    }
}

fn descriptor(provider_id: &str) -> Option<&'static PiProviderDescriptor> {
    PI_PROVIDER_DESCRIPTORS
        .iter()
        .find(|descriptor| descriptor.id == provider_id)
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use aiden_data::pi_credential_store::EncryptedPiCredentialStoreOptions;
    use aiden_data::secret_map::{SecretCipher, SecretCipherError};

    use super::*;

    #[derive(Default)]
    struct MemoryCipher {
        values: Mutex<HashMap<String, String>>,
        encryptions: AtomicUsize,
        decryptions: AtomicUsize,
    }

    impl SecretCipher for MemoryCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }

        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.encryptions.fetch_add(1, Ordering::SeqCst);
            self.values
                .lock()
                .insert(account.to_string(), value.to_string());
            Ok(format!("vault:{account}").into_bytes())
        }

        fn decrypt_string(
            &self,
            account: &str,
            _value: &[u8],
        ) -> Result<String, SecretCipherError> {
            self.decryptions.fetch_add(1, Ordering::SeqCst);
            self.values
                .lock()
                .get(account)
                .cloned()
                .ok_or(SecretCipherError::UnrecognizedFormat)
        }
    }

    fn authority(directory: &Path, cipher: Arc<MemoryCipher>) -> Arc<PiProviderSetupAuthority> {
        PiProviderSetupAuthority::new(Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: directory.join("pi-provider-credentials.json"),
                cipher,
                sync_directory: Some(Box::new(|_| Ok(()))),
                on_durability_warning: None,
                before_document_write: None,
            },
        )))
    }

    #[test]
    fn boot_inventory_is_local_only_and_all_release_descriptors_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let cipher = Arc::new(MemoryCipher::default());
        let authority = authority(directory.path(), cipher.clone());

        let statuses = authority.list();
        assert_eq!(statuses.len(), 35);
        assert_eq!(cipher.encryptions.load(Ordering::SeqCst), 0);
        assert_eq!(cipher.decryptions.load(Ordering::SeqCst), 0);

        let mut ids = HashSet::new();
        for status in statuses {
            assert!(ids.insert(status.provider.id.clone()));
            assert!(!status.provider.id.is_empty() && status.provider.id.len() <= 64);
            assert!(!status.provider.label.is_empty() && status.provider.label.len() <= 128);
            assert!(status.provider.base_url.len() <= 2_048);
            let descriptor = descriptor(&status.provider.id).unwrap();
            assert!(descriptor.api.is_none() || status.provider.base_url.starts_with("https://"));
            assert!(status.provider.models.len() <= 1_024);
            assert!(status
                .provider
                .models
                .iter()
                .all(|model| !model.is_empty() && model.len() <= 256));
            assert!(!status.auth_methods.is_empty());
        }
    }

    #[test]
    fn encrypted_key_is_exactly_bound_and_never_written_in_plaintext() {
        let directory = tempfile::tempdir().unwrap();
        let cipher = Arc::new(MemoryCipher::default());
        let authority = authority(directory.path(), cipher.clone());
        let lease = authority.begin_setup();
        let secret = "sk-sensitive-provider-secret";

        authority
            .commit_api_key("anthropic", secret, lease)
            .unwrap();
        assert_eq!(authority.api_key("anthropic").as_deref(), Some(secret));
        let disk =
            std::fs::read_to_string(directory.path().join("pi-provider-credentials.json")).unwrap();
        assert!(!disk.contains(secret));

        let stored = cipher
            .values
            .lock()
            .get("pi-provider-credentials:anthropic")
            .cloned()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&stored).unwrap();
        let descriptor = descriptor("anthropic").unwrap();
        assert_eq!(
            value.get("binding").and_then(serde_json::Value::as_str),
            Some(authority.binding(descriptor).as_str())
        );
        let endpoint_changed = PiProviderDescriptor {
            base_url: "https://different.example/v1",
            ..*descriptor
        };
        assert_ne!(
            authority.binding(descriptor),
            authority.binding(&endpoint_changed)
        );
        let api_changed = PiProviderDescriptor {
            api: Some(PiNativeApi::Google),
            ..*descriptor
        };
        assert_ne!(
            authority.binding(descriptor),
            authority.binding(&api_changed)
        );
    }

    #[test]
    fn newer_setup_and_sign_out_fence_stale_commits_and_publish_offline_inventory() {
        let directory = tempfile::tempdir().unwrap();
        let authority = authority(directory.path(), Arc::new(MemoryCipher::default()));
        let changes = authority.subscribe();
        let initial = authority.begin_setup();
        authority
            .commit_api_key("anthropic", "first-key", initial)
            .unwrap();
        assert!(changes.has_changed().unwrap());
        assert_eq!(authority.configured_providers().len(), 1);
        assert!(matches!(
            authority.commit_api_key("anthropic", "late-key", initial),
            Err(PiProviderSetupError::Stale)
        ));

        let before_sign_out = authority.begin_setup();
        authority.sign_out("anthropic").unwrap();
        assert!(authority
            .list()
            .iter()
            .find(|status| status.provider.id == "anthropic")
            .is_some_and(|status| !status.configured));
        assert!(authority.configured_providers().is_empty());
        assert!(matches!(
            authority.commit_api_key("anthropic", "late-after-sign-out", before_sign_out),
            Err(PiProviderSetupError::Stale)
        ));
    }

    #[test]
    fn process_only_api_key_leases_are_exact_bound_and_revision_fenced() {
        let directory = tempfile::tempdir().unwrap();
        let authority = authority(directory.path(), Arc::new(MemoryCipher::default()));
        authority
            .commit_api_key("openai", "key-a", authority.begin_setup())
            .unwrap();
        let lease_a = authority.resolve_api_key_lease("openai").unwrap();
        assert_eq!(lease_a.secret(), "key-a");
        assert!(authority.ensure_api_key_lease(&lease_a));

        authority
            .commit_api_key("openai", "key-b", authority.begin_setup())
            .unwrap();
        assert!(!authority.ensure_api_key_lease(&lease_a));
        let lease_b = authority.resolve_api_key_lease("openai").unwrap();
        assert_eq!(lease_b.secret(), "key-b");
        assert!(authority.ensure_api_key_lease(&lease_b));
        assert!(authority.resolve_api_key_lease("google").is_none());
    }

    #[test]
    fn storage_failures_are_sanitized_and_never_echo_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let secret = "sk-do-not-echo-this";
        let store = Arc::new(EncryptedPiCredentialStore::new(
            EncryptedPiCredentialStoreOptions {
                file_path: directory.path().join("pi-provider-credentials.json"),
                cipher: Arc::new(MemoryCipher::default()),
                sync_directory: Some(Box::new(|_| Ok(()))),
                on_durability_warning: None,
                before_document_write: Some(Box::new(move |_| {
                    Err(std::io::Error::other(format!("disk failed near {secret}")))
                })),
            },
        ));
        let authority = PiProviderSetupAuthority::new(store);
        let error = authority
            .commit_api_key("anthropic", secret, authority.begin_setup())
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "Secure provider storage is unavailable. No credential was changed."
        );
        assert!(!error.contains(secret));
    }
}
