//! App-lifetime authority for local and explicit cloud voice transcription.
//!
//! Persisted selection, exact provider credential leases, recording lifecycle
//! fences, and privacy-safe usage accounting all converge here. Ordinary boot
//! and status reads remain local-only; cloud traffic begins only after an
//! explicit recording has finished capture.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use aiden_data::config_store::ConfigStore;
use aiden_data::usage_store::{
    UsageCostStatus, UsageRequestRecord, UsageRequestSource, UsageRequestStatus, UsageStore,
    UsageTokenBreakdown,
};
use aiden_mac::local_models::{is_model_installed, model_dir};
use serde_json::{Map, Value};
use tokio::sync::watch;

use super::pi_provider_setup::{PiApiKeyLease, PiProviderSetupAuthority};
use super::voice_cloud::{
    CloudUsage, CloudVoiceError, CloudVoiceProvider, CloudVoiceRequest, CloudVoiceResult,
    CloudVoiceTranscriber, ProductionCloudVoiceTranscriber, TRANSCRIPTION_TIMEOUT,
};

pub const VOICE_PROVIDER_KEY: &str = "voiceProvider";
pub const VOICE_MODEL_KEY: &str = "voiceModel";
pub const LOCAL_VOICE_MODEL_KEY: &str = "localVoiceModel";
pub const VOICE_MIGRATION_NOTICE_KEY: &str = "voiceLocalOnlyMigrationNoticePending";
pub const LOCAL_PROVIDER: &str = "local";
pub const OPENAI_PROVIDER: &str = "openai";
pub const GEMINI_PROVIDER: &str = "gemini";

pub const OPENAI_MODELS: &[&str] = &["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"];
pub const GEMINI_MODELS: &[&str] = &["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"];

const SAMPLE_RATE: usize = 16_000;
const MAX_CLOUD_SAMPLES: usize = SAMPLE_RATE * 60 * 5;
const MAX_WAV_BYTES: usize = MAX_CLOUD_SAMPLES * 2 + 44;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum VoiceProvider {
    #[default]
    Local,
    OpenAi,
    Gemini,
}

impl VoiceProvider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Local => LOCAL_PROVIDER,
            Self::OpenAi => OPENAI_PROVIDER,
            Self::Gemini => GEMINI_PROVIDER,
        }
    }

    fn pi_provider_id(self) -> Option<&'static str> {
        match self {
            Self::Local => None,
            Self::OpenAi => Some("openai"),
            Self::Gemini => Some("google"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudVoiceOption {
    pub provider: VoiceProvider,
    pub configured: bool,
    pub models: &'static [&'static str],
    pub setup_provider_id: &'static str,
    pub setup_label: &'static str,
    pub authority_revision: u64,
}

#[derive(Clone)]
pub struct VoiceRecordingLease {
    pub model_id: String,
    pub provider: VoiceProvider,
    generation: u64,
    credential: Option<PiApiKeyLease>,
}

impl std::fmt::Debug for VoiceRecordingLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VoiceRecordingLease")
            .field("model_id", &self.model_id)
            .field("provider", &self.provider)
            .field("generation", &self.generation)
            .field("credential", &self.credential.as_ref().map(|_| "bound"))
            .finish()
    }
}

impl PartialEq for VoiceRecordingLease {
    fn eq(&self, other: &Self) -> bool {
        self.model_id == other.model_id
            && self.provider == other.provider
            && self.generation == other.generation
            && self.credential.is_some() == other.credential.is_some()
    }
}

impl Eq for VoiceRecordingLease {}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VoiceError {
    #[error("Set up this voice provider in Settings → Providers before dictating.")]
    MissingCloudCredential,
    #[error("Choose a supported transcription model in Settings → Voice.")]
    InvalidCloudModel,
    #[error("Choose an installed on-device model in Settings → Voice before dictating.")]
    ModelNotSelected,
    #[error("The selected voice model isn't recognized by this build.")]
    UnknownModel,
    #[error("The selected voice model isn't downloaded. Download it in Settings → Voice.")]
    ModelNotInstalled,
    #[error("Voice settings could not be saved.")]
    Persistence,
    #[error("This dictation was cancelled because voice settings changed.")]
    StaleRecording,
    #[error("The recording is empty.")]
    EmptyRecording,
    #[error("Cloud recordings are limited to five minutes.")]
    RecordingTooLong,
    #[error("The captured audio is invalid.")]
    InvalidAudio,
    #[error("The transcription service could not be reached.")]
    CloudUnavailable,
    #[error("The transcription service rejected the recording.")]
    CloudRejected,
    #[error("The transcription service returned an invalid response.")]
    InvalidCloudResponse,
    #[error("Cloud transcription timed out.")]
    CloudTimedOut,
}

pub(crate) type InstalledModel = dyn Fn(&str) -> bool + Send + Sync;

pub struct VoiceAuthority {
    config: Arc<ConfigStore>,
    mutation: Mutex<()>,
    generation: AtomicU64,
    changed: watch::Sender<u64>,
    installed_model: Arc<InstalledModel>,
    pi_providers: Arc<PiProviderSetupAuthority>,
    cloud: Arc<dyn CloudVoiceTranscriber>,
    usage: Arc<UsageStore>,
}

impl VoiceAuthority {
    pub fn new(
        config: Arc<ConfigStore>,
        pi_providers: Arc<PiProviderSetupAuthority>,
        usage: Arc<UsageStore>,
    ) -> Arc<Self> {
        Self::new_with_dependencies(
            config,
            Arc::new(is_model_installed),
            pi_providers,
            ProductionCloudVoiceTranscriber::new(),
            usage,
        )
    }

    pub(crate) fn new_with_dependencies(
        config: Arc<ConfigStore>,
        installed_model: Arc<InstalledModel>,
        pi_providers: Arc<PiProviderSetupAuthority>,
        cloud: Arc<dyn CloudVoiceTranscriber>,
        usage: Arc<UsageStore>,
    ) -> Arc<Self> {
        let (changed, _) = watch::channel(0);
        Arc::new(Self {
            config,
            mutation: Mutex::new(()),
            generation: AtomicU64::new(0),
            changed,
            installed_model,
            pi_providers,
            cloud,
            usage,
        })
    }

    /// Normalize absent/unknown provider state without touching the network,
    /// secure credentials, local models, or microphone permission.
    pub fn reconcile_boot(&self) -> Result<bool, VoiceError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let settings = self
            .config
            .get_settings()
            .map_err(|_| VoiceError::Persistence)?;
        let provider = settings.get(VOICE_PROVIDER_KEY).and_then(Value::as_str);
        if matches!(
            provider,
            Some(LOCAL_PROVIDER | OPENAI_PROVIDER | GEMINI_PROVIDER)
        ) {
            return Ok(false);
        }
        let mut patch = Map::new();
        patch.insert(
            VOICE_PROVIDER_KEY.into(),
            Value::String(LOCAL_PROVIDER.into()),
        );
        patch.insert(VOICE_MODEL_KEY.into(), Value::String(String::new()));
        self.config
            .set_settings(&patch, &|| true)
            .map_err(|_| VoiceError::Persistence)?;
        self.advance_generation();
        Ok(false)
    }

    pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    pub fn subscribe_credential_changes(&self) -> watch::Receiver<u64> {
        self.pi_providers.subscribe()
    }

    /// Local-only status projection for Settings. This may decrypt the two
    /// exact credentials, but never opens a browser or contacts a provider.
    pub fn cloud_options(&self) -> Vec<CloudVoiceOption> {
        let statuses = self.pi_providers.list();
        [
            (VoiceProvider::OpenAi, OPENAI_MODELS, "openai", "OpenAI"),
            (VoiceProvider::Gemini, GEMINI_MODELS, "google", "Google"),
        ]
        .into_iter()
        .map(|(provider, models, setup_provider_id, setup_label)| {
            let status = statuses
                .iter()
                .find(|status| status.provider.id == setup_provider_id);
            CloudVoiceOption {
                provider,
                configured: status.as_ref().is_some_and(|status| status.configured),
                models,
                setup_provider_id,
                setup_label,
                authority_revision: status.map_or(0, |status| status.revision),
            }
        })
        .collect()
    }

    pub fn resolve_recording(&self) -> Result<VoiceRecordingLease, VoiceError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let settings = self
            .config
            .get_settings()
            .map_err(|_| VoiceError::Persistence)?;
        let provider = match settings.get(VOICE_PROVIDER_KEY).and_then(Value::as_str) {
            Some(LOCAL_PROVIDER) => VoiceProvider::Local,
            Some(OPENAI_PROVIDER) => VoiceProvider::OpenAi,
            Some(GEMINI_PROVIDER) => VoiceProvider::Gemini,
            _ => VoiceProvider::Local,
        };
        let generation = self.generation.load(Ordering::Acquire);
        if provider == VoiceProvider::Local {
            let model_id = settings
                .get(LOCAL_VOICE_MODEL_KEY)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or(VoiceError::ModelNotSelected)?;
            if model_dir(model_id).is_none() {
                return Err(VoiceError::UnknownModel);
            }
            if !(self.installed_model)(model_id) {
                return Err(VoiceError::ModelNotInstalled);
            }
            return Ok(VoiceRecordingLease {
                model_id: model_id.to_string(),
                provider,
                generation,
                credential: None,
            });
        }

        let model_id = settings
            .get(VOICE_MODEL_KEY)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|model| cloud_model_allowed(provider, model))
            .ok_or(VoiceError::InvalidCloudModel)?;
        let provider_id = provider
            .pi_provider_id()
            .ok_or(VoiceError::MissingCloudCredential)?;
        let credential = self
            .pi_providers
            .resolve_api_key_lease(provider_id)
            .ok_or(VoiceError::MissingCloudCredential)?;
        Ok(VoiceRecordingLease {
            model_id: model_id.to_string(),
            provider,
            generation,
            credential: Some(credential),
        })
    }

    pub fn ensure_current(&self, lease: &VoiceRecordingLease) -> Result<(), VoiceError> {
        if self.generation.load(Ordering::Acquire) != lease.generation {
            return Err(VoiceError::StaleRecording);
        }
        if let Some(credential) = &lease.credential {
            if !self.pi_providers.ensure_api_key_lease(credential) {
                return Err(VoiceError::StaleRecording);
            }
        }
        Ok(())
    }

    pub fn select_local_model(&self, model_id: &str) -> Result<(), VoiceError> {
        if model_dir(model_id).is_none() {
            return Err(VoiceError::UnknownModel);
        }
        if !(self.installed_model)(model_id) {
            return Err(VoiceError::ModelNotInstalled);
        }
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut patch = Map::new();
        patch.insert(
            VOICE_PROVIDER_KEY.into(),
            Value::String(LOCAL_PROVIDER.into()),
        );
        patch.insert(VOICE_MODEL_KEY.into(), Value::String(String::new()));
        patch.insert(LOCAL_VOICE_MODEL_KEY.into(), Value::String(model_id.into()));
        patch.insert(VOICE_MIGRATION_NOTICE_KEY.into(), Value::Bool(false));
        self.config
            .set_settings(&patch, &|| true)
            .map_err(|_| VoiceError::Persistence)?;
        self.advance_generation();
        Ok(())
    }

    /// Select the local runtime without inventing an installed model. This is
    /// used when a cloud user intentionally returns to on-device Settings.
    pub fn select_local(&self) -> Result<(), VoiceError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut patch = Map::new();
        patch.insert(
            VOICE_PROVIDER_KEY.into(),
            Value::String(LOCAL_PROVIDER.into()),
        );
        patch.insert(VOICE_MODEL_KEY.into(), Value::String(String::new()));
        patch.insert(VOICE_MIGRATION_NOTICE_KEY.into(), Value::Bool(false));
        self.config
            .set_settings(&patch, &|| true)
            .map_err(|_| VoiceError::Persistence)?;
        self.advance_generation();
        Ok(())
    }

    /// Select a configured cloud provider/model. Credential setup stays in the
    /// Pi provider authority and is never copied into portable voice settings.
    pub fn select_cloud_model(
        &self,
        provider: VoiceProvider,
        model_id: &str,
    ) -> Result<(), VoiceError> {
        let provider_id = provider
            .pi_provider_id()
            .ok_or(VoiceError::InvalidCloudModel)?;
        if !cloud_model_allowed(provider, model_id) {
            return Err(VoiceError::InvalidCloudModel);
        }
        if self
            .pi_providers
            .resolve_api_key_lease(provider_id)
            .is_none()
        {
            return Err(VoiceError::MissingCloudCredential);
        }
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut patch = Map::new();
        patch.insert(
            VOICE_PROVIDER_KEY.into(),
            Value::String(provider.id().into()),
        );
        patch.insert(VOICE_MODEL_KEY.into(), Value::String(model_id.into()));
        patch.insert(VOICE_MIGRATION_NOTICE_KEY.into(), Value::Bool(false));
        self.config
            .set_settings(&patch, &|| true)
            .map_err(|_| VoiceError::Persistence)?;
        self.advance_generation();
        Ok(())
    }

    /// Transcribe a completed explicit cloud recording. The exact credential
    /// lease is checked before admission and after the response; a sign-out or
    /// rotation cancels/fences the result rather than switching providers.
    pub async fn transcribe_cloud(
        &self,
        lease: &VoiceRecordingLease,
        samples: Vec<f32>,
    ) -> Result<String, VoiceError> {
        self.ensure_current(lease)?;
        let provider = match lease.provider {
            VoiceProvider::Local => return Err(VoiceError::InvalidCloudModel),
            VoiceProvider::OpenAi => CloudVoiceProvider::OpenAi,
            VoiceProvider::Gemini => CloudVoiceProvider::Gemini,
        };
        let credential = lease
            .credential
            .as_ref()
            .ok_or(VoiceError::MissingCloudCredential)?;
        let wav = encode_mono_wav(&samples)?;
        let request = CloudVoiceRequest {
            provider,
            model: lease.model_id.clone(),
            api_key: credential.secret().to_string(),
            wav,
        };
        let mut voice_changes = self.subscribe_changes();
        let mut provider_changes = self.pi_providers.subscribe();
        let result = tokio::select! {
            result = self.cloud.transcribe(request) => result.map_err(VoiceError::from),
            _ = voice_changes.changed() => Err(VoiceError::StaleRecording),
            _ = provider_changes.changed() => Err(VoiceError::StaleRecording),
            _ = tokio::time::sleep(TRANSCRIPTION_TIMEOUT) => Err(VoiceError::CloudTimedOut),
        };
        let result = match result {
            Ok(value) => self.ensure_current(lease).map(|()| value),
            Err(error) => Err(error),
        };
        self.record_cloud_usage(lease, &result);
        let result = result?;
        self.ensure_current(lease)?;
        Ok(result.transcript)
    }

    /// Fence any active recording before deleting its selected model.
    pub fn clear_selected_model(&self, model_id: &str) -> Result<bool, VoiceError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let settings = self
            .config
            .get_settings()
            .map_err(|_| VoiceError::Persistence)?;
        let selected =
            settings.get(LOCAL_VOICE_MODEL_KEY).and_then(Value::as_str) == Some(model_id);
        if selected {
            let mut patch = Map::new();
            patch.insert(LOCAL_VOICE_MODEL_KEY.into(), Value::String(String::new()));
            self.config
                .set_settings(&patch, &|| true)
                .map_err(|_| VoiceError::Persistence)?;
            self.advance_generation();
        }
        Ok(selected)
    }

    /// Cancel/fence recording on window close, explicit stop, or app quit.
    pub fn cancel(&self) {
        self.advance_generation();
    }

    fn advance_generation(&self) {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let _ = self.changed.send(generation);
    }

    fn record_cloud_usage(
        &self,
        lease: &VoiceRecordingLease,
        result: &Result<CloudVoiceResult, VoiceError>,
    ) {
        let status = match result {
            Ok(_) => UsageRequestStatus::Completed,
            Err(VoiceError::StaleRecording) => UsageRequestStatus::Cancelled,
            Err(_) => UsageRequestStatus::Failed,
        };
        let tokens = result
            .as_ref()
            .ok()
            .and_then(|result| result.usage)
            .map(usage_tokens);
        let provider_label = match lease.provider {
            VoiceProvider::OpenAi => "OpenAI",
            VoiceProvider::Gemini => "Google Gemini",
            VoiceProvider::Local => "On-device",
        };
        let _ = self.usage.record(&UsageRequestRecord {
            timestamp: None,
            source: UsageRequestSource::VoiceTranscription,
            provider_id: lease.provider.id().to_string(),
            provider_label: provider_label.to_string(),
            model_id: lease.model_id.clone(),
            model_label: lease.model_id.clone(),
            local: false,
            status,
            tokens,
            cost_status: UsageCostStatus::Unavailable,
            cost_usd: None,
        });
    }
}

impl From<CloudVoiceError> for VoiceError {
    fn from(error: CloudVoiceError) -> Self {
        match error {
            CloudVoiceError::RequestTooLarge => Self::RecordingTooLong,
            CloudVoiceError::Unavailable => Self::CloudUnavailable,
            CloudVoiceError::Rejected => Self::CloudRejected,
            CloudVoiceError::InvalidResponse => Self::InvalidCloudResponse,
            CloudVoiceError::TimedOut => Self::CloudTimedOut,
        }
    }
}

fn cloud_model_allowed(provider: VoiceProvider, model: &str) -> bool {
    match provider {
        VoiceProvider::OpenAi => OPENAI_MODELS.contains(&model),
        VoiceProvider::Gemini => GEMINI_MODELS.contains(&model),
        VoiceProvider::Local => false,
    }
}

fn encode_mono_wav(samples: &[f32]) -> Result<Vec<u8>, VoiceError> {
    if samples.is_empty() {
        return Err(VoiceError::EmptyRecording);
    }
    if samples.len() > MAX_CLOUD_SAMPLES {
        return Err(VoiceError::RecordingTooLong);
    }
    let data_bytes = samples
        .len()
        .checked_mul(2)
        .ok_or(VoiceError::RecordingTooLong)?;
    let total = data_bytes
        .checked_add(44)
        .filter(|total| *total <= MAX_WAV_BYTES)
        .ok_or(VoiceError::RecordingTooLong)?;
    let data_bytes_u32 = u32::try_from(data_bytes).map_err(|_| VoiceError::RecordingTooLong)?;
    let mut wav = Vec::with_capacity(total);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32 + data_bytes_u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    wav.extend_from_slice(&((SAMPLE_RATE as u32) * 2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes_u32.to_le_bytes());
    for sample in samples {
        if !sample.is_finite() {
            return Err(VoiceError::InvalidAudio);
        }
        let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        wav.extend_from_slice(&pcm.to_le_bytes());
    }
    Ok(wav)
}

fn usage_tokens(usage: CloudUsage) -> UsageTokenBreakdown {
    UsageTokenBreakdown {
        input: usage.input,
        output: usage.output,
        cache_read: usage.cache_read,
        cache_write: 0,
        reasoning: usage.reasoning,
        total: usage.total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::pi_credential_store::{
        EncryptedPiCredentialStore, EncryptedPiCredentialStoreOptions,
    };
    use aiden_data::portable_config::{create_portable_config_stores, PortableConfigTestHooks};
    use aiden_data::secret_map::{ProviderKeysStore, SecretCipher, SecretCipherError};
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct MemoryCipher(Mutex<HashMap<String, String>>);

    struct UnavailableCloud;

    impl CloudVoiceTranscriber for UnavailableCloud {
        fn transcribe(
            &self,
            _request: CloudVoiceRequest,
        ) -> futures::future::BoxFuture<'static, Result<CloudVoiceResult, CloudVoiceError>>
        {
            Box::pin(async { Err(CloudVoiceError::Unavailable) })
        }
    }

    struct RecordingCloud {
        calls: Arc<Mutex<Vec<RecordedCloudCall>>>,
        result: Mutex<Option<Result<CloudVoiceResult, CloudVoiceError>>>,
    }

    struct RecordedCloudCall {
        provider: CloudVoiceProvider,
        model: String,
        api_key: String,
        wav: Vec<u8>,
    }

    impl CloudVoiceTranscriber for RecordingCloud {
        fn transcribe(
            &self,
            request: CloudVoiceRequest,
        ) -> futures::future::BoxFuture<'static, Result<CloudVoiceResult, CloudVoiceError>>
        {
            self.calls.lock().unwrap().push(RecordedCloudCall {
                provider: request.provider,
                model: request.model,
                api_key: request.api_key,
                wav: request.wav,
            });
            let result = self.result.lock().unwrap().take().unwrap();
            Box::pin(async move { result })
        }
    }

    struct SlowCloud {
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    impl CloudVoiceTranscriber for SlowCloud {
        fn transcribe(
            &self,
            _request: CloudVoiceRequest,
        ) -> futures::future::BoxFuture<'static, Result<CloudVoiceResult, CloudVoiceError>>
        {
            let started = self.started.clone();
            let release = self.release.clone();
            Box::pin(async move {
                started.notify_one();
                release.notified().await;
                Ok(CloudVoiceResult {
                    transcript: "late".into(),
                    usage: None,
                })
            })
        }
    }

    impl SecretCipher for MemoryCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }
        fn encrypt_string(&self, account: &str, value: &str) -> Result<Vec<u8>, SecretCipherError> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(value.as_bytes().to_vec())
        }
        fn decrypt_string(&self, account: &str, value: &[u8]) -> Result<String, SecretCipherError> {
            let value = String::from_utf8_lossy(value).to_string();
            (self.0.lock().unwrap().get(account) == Some(&value))
                .then_some(value)
                .ok_or(SecretCipherError::UnrecognizedFormat)
        }
    }

    fn fixture(
        installed: impl Fn(&str) -> bool + Send + Sync + 'static,
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<ConfigStore>,
        Arc<VoiceAuthority>,
    ) {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let cipher = Arc::new(MemoryCipher::default());
        let keys = Arc::new(ProviderKeysStore::new(
            local.path().into(),
            "voice-test",
            cipher.clone(),
        ));
        let config = Arc::new(ConfigStore::new(
            create_portable_config_stores(
                portable.path().into(),
                Some(local.path().into()),
                PortableConfigTestHooks::default(),
            ),
            Arc::new(crate::services::stores::StoreSecretsPort::new(keys)),
            None,
        ));
        let pi_providers = PiProviderSetupAuthority::new(Arc::new(
            EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
                file_path: local.path().join("pi-provider-credentials.json"),
                cipher,
                sync_directory: Some(Box::new(|_| Ok(()))),
                on_durability_warning: None,
                before_document_write: None,
            }),
        ));
        let usage = Arc::new(UsageStore::new_data_store(Some(local.path().into())));
        let authority = VoiceAuthority::new_with_dependencies(
            config.clone(),
            Arc::new(installed),
            pi_providers,
            Arc::new(UnavailableCloud),
            usage,
        );
        (portable, local, config, authority)
    }

    fn replace_cloud(
        config: Arc<ConfigStore>,
        authority: &VoiceAuthority,
        local: &tempfile::TempDir,
        cloud: Arc<dyn CloudVoiceTranscriber>,
    ) -> Arc<VoiceAuthority> {
        VoiceAuthority::new_with_dependencies(
            config,
            Arc::new(|_| true),
            authority.pi_providers.clone(),
            cloud,
            Arc::new(UsageStore::new_data_store(Some(local.path().into()))),
        )
    }

    fn configure_cloud(
        authority: &VoiceAuthority,
        provider: VoiceProvider,
        key: &str,
        model: &str,
    ) {
        let provider_id = provider.pi_provider_id().unwrap();
        authority
            .pi_providers
            .commit_api_key(provider_id, key, authority.pi_providers.begin_setup())
            .unwrap();
        authority.select_cloud_model(provider, model).unwrap();
    }

    fn set(config: &ConfigStore, values: &[(&str, Value)]) {
        let patch = values
            .iter()
            .map(|(key, value)| ((*key).into(), value.clone()))
            .collect();
        config.set_settings(&patch, &|| true).unwrap();
    }

    #[test]
    fn boot_preserves_an_explicit_cloud_selection_without_network_or_model_probes() {
        let (_portable, _local, config, authority) = fixture(|_| true);
        set(
            &config,
            &[
                (VOICE_PROVIDER_KEY, Value::String("openai".into())),
                (VOICE_MODEL_KEY, Value::String("whisper-1".into())),
            ],
        );
        assert_eq!(authority.reconcile_boot(), Ok(false));
        let settings = config.get_settings().unwrap();
        assert_eq!(
            settings.get(VOICE_PROVIDER_KEY),
            Some(&Value::String("openai".into()))
        );
        assert_eq!(
            authority.resolve_recording(),
            Err(VoiceError::MissingCloudCredential)
        );
    }

    #[test]
    fn cloud_provider_requires_a_supported_model_before_credential_resolution() {
        let (_portable, _local, config, authority) = fixture(|_| true);
        set(
            &config,
            &[(VOICE_PROVIDER_KEY, Value::String("gemini".into()))],
        );
        assert_eq!(
            authority.resolve_recording(),
            Err(VoiceError::InvalidCloudModel)
        );
    }

    #[test]
    fn exact_installed_selection_is_runtime_authoritative_and_fenced() {
        let (_portable, _local, config, authority) = fixture(|id| id == "parakeet-v2");
        authority.reconcile_boot().unwrap();
        authority.select_local_model("parakeet-v2").unwrap();
        let lease = authority.resolve_recording().unwrap();
        assert_eq!(lease.model_id, "parakeet-v2");
        authority.cancel();
        assert_eq!(
            authority.ensure_current(&lease),
            Err(VoiceError::StaleRecording)
        );
        set(
            &config,
            &[(LOCAL_VOICE_MODEL_KEY, Value::String("parakeet-v3".into()))],
        );
        assert_eq!(
            authority.resolve_recording(),
            Err(VoiceError::ModelNotInstalled)
        );
    }

    #[test]
    fn unknown_model_cannot_be_selected() {
        let (_portable, _local, _config, authority) = fixture(|_| true);
        assert_eq!(
            authority.select_local_model("invented"),
            Err(VoiceError::UnknownModel)
        );
    }

    #[test]
    fn boot_migration_never_probes_models_or_microphone() {
        let probes = Arc::new(AtomicU64::new(0));
        let observed = probes.clone();
        let (_portable, _local, config, authority) = fixture(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            true
        });
        set(
            &config,
            &[(VOICE_PROVIDER_KEY, Value::String("gemini".into()))],
        );
        authority.reconcile_boot().unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn boot_and_status_never_call_the_cloud_transport() {
        struct CountingCloud(Arc<AtomicUsize>);
        impl CloudVoiceTranscriber for CountingCloud {
            fn transcribe(
                &self,
                _request: CloudVoiceRequest,
            ) -> futures::future::BoxFuture<'static, Result<CloudVoiceResult, CloudVoiceError>>
            {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Err(CloudVoiceError::Unavailable) })
            }
        }

        let (_portable, local, config, base) = fixture(|_| true);
        let calls = Arc::new(AtomicUsize::new(0));
        let authority = replace_cloud(
            config.clone(),
            &base,
            &local,
            Arc::new(CountingCloud(calls.clone())),
        );
        set(
            &config,
            &[
                (VOICE_PROVIDER_KEY, Value::String("openai".into())),
                (VOICE_MODEL_KEY, Value::String("whisper-1".into())),
            ],
        );
        authority.reconcile_boot().unwrap();
        let _ = authority.cloud_options();
        let _ = authority.resolve_recording();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn exact_cloud_selection_binds_the_key_and_wav_before_microphone_use() {
        let (_portable, local, config, base) = fixture(|_| true);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let cloud = Arc::new(RecordingCloud {
            calls: calls.clone(),
            result: Mutex::new(Some(Ok(CloudVoiceResult {
                transcript: "hello".into(),
                usage: Some(CloudUsage {
                    input: 2,
                    output: 1,
                    total: 3,
                    ..CloudUsage::default()
                }),
            }))),
        });
        let authority = replace_cloud(config, &base, &local, cloud);
        configure_cloud(
            &authority,
            VoiceProvider::OpenAi,
            "exact-openai-key",
            "whisper-1",
        );
        let lease = authority.resolve_recording().unwrap();
        assert_eq!(lease.provider, VoiceProvider::OpenAi);
        assert_eq!(lease.model_id, "whisper-1");
        assert!(!format!("{lease:?}").contains("exact-openai-key"));
        assert_eq!(
            authority
                .transcribe_cloud(&lease, vec![0.25; SAMPLE_RATE])
                .await,
            Ok("hello".into())
        );
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].provider, CloudVoiceProvider::OpenAi);
        assert_eq!(calls[0].model, "whisper-1");
        assert_eq!(calls[0].api_key, "exact-openai-key");
        assert!(calls[0].wav.starts_with(b"RIFF"));
        assert_eq!(&calls[0].wav[8..12], b"WAVE");
        let usage = authority
            .usage
            .summary(aiden_data::usage_store::UsageDateRange::All)
            .unwrap();
        assert_eq!(usage.totals.requests, 1);
        assert_eq!(usage.totals.completed_requests, 1);
        assert_eq!(usage.totals.reported_token_requests, 1);
        assert_eq!(usage.totals.tokens.total, 3);
        for entry in std::fs::read_dir(local.path()).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                assert!(!std::fs::read(path)
                    .unwrap_or_default()
                    .windows(4)
                    .any(|window| window == b"RIFF"));
            }
        }
    }

    #[tokio::test]
    async fn sign_out_or_rotation_rejects_old_leases_and_late_responses() {
        let (_portable, local, config, base) = fixture(|_| true);
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let authority = replace_cloud(
            config,
            &base,
            &local,
            Arc::new(SlowCloud {
                started: started.clone(),
                release: release.clone(),
            }),
        );
        configure_cloud(
            &authority,
            VoiceProvider::Gemini,
            "key-a",
            "gemini-2.5-flash",
        );
        let lease = authority.resolve_recording().unwrap();
        let running = {
            let authority = authority.clone();
            let lease = lease.clone();
            tokio::spawn(async move {
                authority
                    .transcribe_cloud(&lease, vec![0.1; SAMPLE_RATE])
                    .await
            })
        };
        started.notified().await;
        authority.pi_providers.sign_out("google").unwrap();
        release.notify_waiters();
        assert_eq!(running.await.unwrap(), Err(VoiceError::StaleRecording));
        let usage = authority
            .usage
            .summary(aiden_data::usage_store::UsageDateRange::All)
            .unwrap();
        assert_eq!(usage.totals.cancelled_requests, 1);
        assert_eq!(
            authority.resolve_recording(),
            Err(VoiceError::MissingCloudCredential)
        );

        authority
            .pi_providers
            .commit_api_key("google", "key-b", authority.pi_providers.begin_setup())
            .unwrap();
        let new_lease = authority.resolve_recording().unwrap();
        assert_eq!(
            authority.ensure_current(&lease),
            Err(VoiceError::StaleRecording)
        );
        assert_eq!(authority.ensure_current(&new_lease), Ok(()));
    }

    #[tokio::test]
    async fn sanitized_cloud_failures_are_recorded_as_unmetered() {
        let (_portable, _local, _config, authority) = fixture(|_| true);
        configure_cloud(
            &authority,
            VoiceProvider::OpenAi,
            "never-persist-this-key",
            "whisper-1",
        );
        let lease = authority.resolve_recording().unwrap();
        let error = authority
            .transcribe_cloud(&lease, vec![0.0; 160])
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "The transcription service could not be reached.");
        assert!(!error.contains("never-persist-this-key"));
        let usage = authority
            .usage
            .summary(aiden_data::usage_store::UsageDateRange::All)
            .unwrap();
        assert_eq!(usage.totals.failed_requests, 1);
        assert_eq!(usage.totals.unmetered_requests, 1);
    }

    #[test]
    fn cloud_wav_is_exact_bounded_and_finite() {
        let (_portable, local, _config, _authority) = fixture(|_| true);
        assert_eq!(encode_mono_wav(&[]), Err(VoiceError::EmptyRecording));
        assert_eq!(encode_mono_wav(&[f32::NAN]), Err(VoiceError::InvalidAudio));
        assert_eq!(
            encode_mono_wav(&vec![0.0; MAX_CLOUD_SAMPLES + 1]),
            Err(VoiceError::RecordingTooLong)
        );
        let wav = encode_mono_wav(&[0.0, 1.0, -1.0]).unwrap();
        assert_eq!(wav.len(), 50);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[36..40], b"data");
        for entry in std::fs::read_dir(local.path()).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                assert!(!std::fs::read(path)
                    .unwrap_or_default()
                    .windows(4)
                    .any(|window| window == b"RIFF"));
            }
        }
    }
}
