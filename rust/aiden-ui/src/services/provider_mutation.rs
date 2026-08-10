//! Recoverable custom-provider configuration and credential mutations.

use std::sync::{Arc, Mutex, OnceLock};

use aiden_data::config_store::{provider_connection_snapshot, ConfigStore};
use aiden_data::portable_config::StoredProvider;
use aiden_data::secret_map::{ProviderKeysError, ProviderKeysStore};

use aiden_providers::catalog;
use aiden_providers::codex::OPENAI_CODEX_PROVIDER_ID;

use crate::services::provider_kit::ModelSelection;

const MODEL_SELECTION_KEY: &str = "modelSelection";

fn mutation_authority() -> &'static Mutex<()> {
    static AUTHORITY: OnceLock<Mutex<()>> = OnceLock::new();
    AUTHORITY.get_or_init(|| Mutex::new(()))
}

/// A provider mutation rejected before any durable write occurs.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderMutationError {
    /// Pi-native and reserved providers cannot enter the custom editor path.
    #[error("This built-in provider is managed through its native setup flow.")]
    ImmutableProvider,
    /// An old credential cannot be redirected to a changed connection.
    #[error("Re-enter the API key after changing the provider connection.")]
    CredentialReentryRequired,
    /// A durable step failed; the previous state was restored or fails closed.
    #[error("The provider change could not be saved: {0}")]
    Persistence(String),
}

#[derive(Clone)]
pub struct ProviderMutationService {
    config: Arc<ConfigStore>,
    keys: Arc<ProviderKeysStore>,
}

impl ProviderMutationService {
    pub fn new(config: Arc<ConfigStore>, keys: Arc<ProviderKeysStore>) -> Self {
        Self { config, keys }
    }

    /// Save a custom provider, its exact-bound credential, and default model.
    ///
    /// The credential is staged first. Until the matching config lands its new
    /// binding cannot authorize the old connection. Any later failure restores
    /// the previous config, credential slots, and settings best-effort; a failed
    /// restore remains fail-closed because mismatched bindings are unusable.
    pub fn save_custom(
        &self,
        provider: &StoredProvider,
        key_draft: Option<&str>,
        selection: Option<&ModelSelection>,
    ) -> Result<(), ProviderMutationError> {
        let _authority = mutation_authority().lock().map_err(|_| {
            ProviderMutationError::Persistence("provider mutation coordinator unavailable".into())
        })?;
        save_custom_with(
            &ProductionBackend {
                config: self.config.as_ref(),
                keys: self.keys.as_ref(),
            },
            provider,
            key_draft,
            selection,
        )
    }

    /// Replace only the offline discovered-model inventory of a custom record.
    pub fn save_discovered_models(
        &self,
        provider_id: &str,
        models: Vec<String>,
    ) -> Result<(), ProviderMutationError> {
        let _authority = mutation_authority().lock().map_err(|_| {
            ProviderMutationError::Persistence("provider mutation coordinator unavailable".into())
        })?;
        let backend = ProductionBackend {
            config: self.config.as_ref(),
            keys: self.keys.as_ref(),
        };
        let mut provider = backend
            .get_provider(provider_id)
            .map_err(ProviderMutationError::Persistence)?
            .ok_or_else(|| {
                ProviderMutationError::Persistence("The provider record could not be read.".into())
            })?;
        ensure_mutable(&provider, Some(&provider))?;
        provider.models = models;
        save_custom_with(&backend, &provider, None, None)
    }

    /// Remove a custom provider through the same mutation authority.
    pub fn remove_custom(&self, provider_id: &str) -> Result<(), ProviderMutationError> {
        let _authority = mutation_authority().lock().map_err(|_| {
            ProviderMutationError::Persistence("provider mutation coordinator unavailable".into())
        })?;
        let backend = ProductionBackend {
            config: self.config.as_ref(),
            keys: self.keys.as_ref(),
        };
        let provider = backend
            .get_provider(provider_id)
            .map_err(ProviderMutationError::Persistence)?
            .ok_or_else(|| {
                ProviderMutationError::Persistence("The provider record could not be read.".into())
            })?;
        remove_custom_with(&backend, &provider)
    }
}

trait MutationBackend {
    fn get_provider(&self, id: &str) -> Result<Option<StoredProvider>, String>;
    fn get_settings(&self) -> Result<serde_json::Map<String, serde_json::Value>, String>;
    fn read_secret(&self, provider_id: &str) -> SecretSnapshot;
    fn write_bound_secret(&self, provider: &StoredProvider, key: &str) -> Result<(), String>;
    fn activate_bound_secret(&self, provider_id: &str) -> Result<(), String>;
    fn revoke_bound_secret(&self, provider_id: &str) -> Result<(), String>;
    fn restore_secret(&self, provider_id: &str, snapshot: &SecretSnapshot) -> Result<(), String>;
    fn delete_secret(&self, provider_id: &str) -> Result<(), String>;
    fn save_provider(&self, provider: &StoredProvider) -> Result<(), String>;
    fn remove_provider(&self, provider_id: &str) -> Result<(), String>;
    fn set_selection(&self, value: serde_json::Value) -> Result<(), String>;
}

struct ProductionBackend<'a> {
    config: &'a ConfigStore,
    keys: &'a ProviderKeysStore,
}

impl MutationBackend for ProductionBackend<'_> {
    fn get_provider(&self, id: &str) -> Result<Option<StoredProvider>, String> {
        self.config
            .get_provider(id)
            .map_err(|error| error.to_string())
    }

    fn get_settings(&self) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        self.config
            .get_settings()
            .map_err(|error| error.to_string())
    }

    fn read_secret(&self, provider_id: &str) -> SecretSnapshot {
        SecretSnapshot::read(self.keys, provider_id)
    }

    fn write_bound_secret(&self, provider: &StoredProvider, key: &str) -> Result<(), String> {
        stage_bound_key(self.keys, provider, key).map_err(|error| error.to_string())
    }

    fn activate_bound_secret(&self, provider_id: &str) -> Result<(), String> {
        self.keys
            .activate_bound(provider_id)
            .map_err(|error| error.to_string())
    }

    fn revoke_bound_secret(&self, provider_id: &str) -> Result<(), String> {
        self.keys
            .revoke_bound(provider_id)
            .map_err(|error| error.to_string())
    }

    fn restore_secret(&self, provider_id: &str, snapshot: &SecretSnapshot) -> Result<(), String> {
        snapshot
            .restore(self.keys, provider_id)
            .map_err(|error| error.to_string())
    }

    fn delete_secret(&self, provider_id: &str) -> Result<(), String> {
        self.keys
            .delete(provider_id)
            .map_err(|error| error.to_string())
    }

    fn save_provider(&self, provider: &StoredProvider) -> Result<(), String> {
        self.config
            .save_provider(provider, &|| true)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn remove_provider(&self, provider_id: &str) -> Result<(), String> {
        self.config
            .remove_provider(provider_id, &|| true)
            .map_err(|error| error.to_string())
    }

    fn set_selection(&self, value: serde_json::Value) -> Result<(), String> {
        let mut patch = serde_json::Map::new();
        patch.insert(MODEL_SELECTION_KEY.into(), value);
        self.config
            .set_settings(&patch, &|| true)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

fn save_custom_with(
    backend: &dyn MutationBackend,
    provider: &StoredProvider,
    key_draft: Option<&str>,
    selection: Option<&ModelSelection>,
) -> Result<(), ProviderMutationError> {
    let previous = backend
        .get_provider(&provider.id)
        .map_err(ProviderMutationError::Persistence)?;
    ensure_mutable(provider, previous.as_ref())?;

    let previous_settings = backend
        .get_settings()
        .map_err(ProviderMutationError::Persistence)?;
    let previous_secret = backend.read_secret(&provider.id);
    let connection_changed = previous.as_ref().is_some_and(|current| {
        provider_connection_snapshot(current) != provider_connection_snapshot(provider)
    });
    let key_draft = key_draft.map(str::trim).filter(|key| !key.is_empty());
    if provider.needs_key && connection_changed && key_draft.is_none() {
        return Err(ProviderMutationError::CredentialReentryRequired);
    }

    if let Some(key) = key_draft {
        if let Err(error) = backend.write_bound_secret(provider, key) {
            let restored = backend.restore_secret(&provider.id, &previous_secret);
            return Err(rollback_error(error, restored));
        }
    } else if provider.needs_key && previous.is_none() {
        // A new keyed connection may be configured without a key, but it
        // remains visibly unavailable and cannot dispatch.
    } else if !provider.needs_key {
        backend
            .delete_secret(&provider.id)
            .map_err(ProviderMutationError::Persistence)?;
    }

    if let Err(error) = backend.save_provider(provider) {
        return Err(rollback_error(
            error,
            rollback(
                backend,
                previous.as_ref(),
                &previous_settings,
                &previous_secret,
                &provider.id,
            ),
        ));
    }

    if let Some(selection) = selection {
        if let Err(error) = backend.set_selection(selection.to_settings()) {
            let rollback = rollback(
                backend,
                previous.as_ref(),
                &previous_settings,
                &previous_secret,
                &provider.id,
            );
            return Err(rollback_error(error, rollback));
        }
    }
    if key_draft.is_some() {
        if let Err(error) = backend.activate_bound_secret(&provider.id) {
            return Err(rollback_error(
                error,
                rollback(
                    backend,
                    previous.as_ref(),
                    &previous_settings,
                    &previous_secret,
                    &provider.id,
                ),
            ));
        }
    }
    Ok(())
}

fn remove_custom_with(
    backend: &dyn MutationBackend,
    provider: &StoredProvider,
) -> Result<(), ProviderMutationError> {
    ensure_mutable(provider, Some(provider))?;
    let previous_secret = backend.read_secret(&provider.id);
    backend
        .revoke_bound_secret(&provider.id)
        .map_err(ProviderMutationError::Persistence)?;
    if let Err(error) = backend.remove_provider(&provider.id) {
        let provider_still_exists = backend
            .get_provider(&provider.id)
            .map_err(ProviderMutationError::Persistence)?
            .is_some();
        if !provider_still_exists {
            // Config removal crossed its commit point. Never restore an orphan
            // credential; retain the durable deny marker if cleanup still
            // cannot complete.
            let cleanup = backend.delete_secret(&provider.id);
            return Err(rollback_error(error, cleanup));
        }
        let restored = backend.restore_secret(&provider.id, &previous_secret);
        return Err(rollback_error(error, restored));
    }
    // ConfigStore performs the same cleanup, but this authoritative second
    // pass also covers alternate backends and remains idempotent.
    backend
        .delete_secret(&provider.id)
        .map_err(ProviderMutationError::Persistence)
}

fn rollback(
    backend: &dyn MutationBackend,
    previous: Option<&StoredProvider>,
    previous_settings: &serde_json::Map<String, serde_json::Value>,
    previous_secret: &SecretSnapshot,
    provider_id: &str,
) -> Result<(), String> {
    // Invalidate first. If restoring the previous connection fails, no
    // credential may remain available to the still-current new endpoint.
    backend
        .delete_secret(provider_id)
        .map_err(|error| format!("credential invalidation failed: {error}"))?;
    match previous {
        Some(provider) => {
            backend
                .save_provider(provider)
                .map_err(|error| format!("provider rollback failed: {error}"))?;
        }
        None => {
            backend
                .remove_provider(provider_id)
                .map_err(|error| format!("provider rollback failed: {error}"))?;
        }
    }
    let previous_selection = previous_settings
        .get(MODEL_SELECTION_KEY)
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    backend
        .set_selection(previous_selection)
        .map_err(|error| format!("selection rollback failed: {error}"))?;
    backend
        .restore_secret(provider_id, previous_secret)
        .map_err(|error| format!("credential rollback failed: {error}"))?;
    Ok(())
}

fn rollback_error(original: String, rollback: Result<(), String>) -> ProviderMutationError {
    match rollback {
        Ok(()) => ProviderMutationError::Persistence(original),
        Err(rollback) => ProviderMutationError::Persistence(format!(
            "{original}; rollback failed closed: {rollback}"
        )),
    }
}

fn ensure_mutable(
    candidate: &StoredProvider,
    previous: Option<&StoredProvider>,
) -> Result<(), ProviderMutationError> {
    let protected = candidate.id == OPENAI_CODEX_PROVIDER_ID
        || !catalog::is_custom_provider_id(&candidate.id)
        || candidate.is_builtin.unwrap_or(false)
        || candidate.is_preset.unwrap_or(false)
        || previous.is_some_and(|provider| {
            provider.is_builtin.unwrap_or(false) || provider.is_preset.unwrap_or(false)
        });
    if protected {
        Err(ProviderMutationError::ImmutableProvider)
    } else {
        Ok(())
    }
}

fn stage_bound_key(
    keys: &ProviderKeysStore,
    provider: &StoredProvider,
    key: &str,
) -> Result<(), ProviderKeysError> {
    keys.stage_bound(&provider.id, key, &provider_connection_snapshot(provider))
}

#[derive(Clone)]
enum SecretSnapshot {
    Missing,
    Present {
        key: String,
        binding: Option<String>,
    },
    Unreadable,
}

impl SecretSnapshot {
    fn read(keys: &ProviderKeysStore, provider_id: &str) -> Self {
        match keys.get(provider_id) {
            Ok(Some(key)) => Self::Present {
                key,
                binding: keys.get_binding(provider_id).ok().flatten(),
            },
            Ok(None) => Self::Missing,
            Err(_) => Self::Unreadable,
        }
    }

    fn restore(
        &self,
        keys: &ProviderKeysStore,
        provider_id: &str,
    ) -> Result<(), ProviderKeysError> {
        match self {
            Self::Missing => keys.delete(provider_id),
            Self::Present { key, binding } => {
                if let Some(binding) = binding {
                    keys.set_bound(provider_id, key, binding)
                } else {
                    // An unbound key has no safe endpoint provenance.
                    keys.delete(provider_id)
                }
            }
            // Never replace an unreadable legacy credential with a newly
            // entered value during a failed transaction.
            Self::Unreadable => keys.delete(provider_id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::portable_config::{ProviderDeployment, ProviderKind};
    use std::cell::{Cell, RefCell};

    fn provider(id: &str) -> StoredProvider {
        StoredProvider {
            id: id.into(),
            kind: ProviderKind::Openai,
            label: "Test".into(),
            base_url: "https://example.test/v1".into(),
            models: vec!["model".into()],
            model_metadata: None,
            default_model: Some("model".into()),
            needs_key: true,
            deployment: Some(ProviderDeployment::Hosted),
            is_preset: Some(false),
            is_builtin: Some(false),
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn builtin_preset_and_codex_records_are_immutable() {
        for mut candidate in [
            provider("builtin"),
            provider("preset"),
            provider(OPENAI_CODEX_PROVIDER_ID),
        ] {
            if candidate.id == "builtin" {
                candidate.is_builtin = Some(true);
            }
            if candidate.id == "preset" {
                candidate.is_preset = Some(true);
            }
            assert_eq!(
                ensure_mutable(&candidate, None),
                Err(ProviderMutationError::ImmutableProvider)
            );
        }
    }

    #[test]
    fn an_existing_protected_record_cannot_be_demoted_by_the_candidate() {
        let candidate = provider("custom:test");
        let mut previous = candidate.clone();
        previous.is_builtin = Some(true);
        assert_eq!(
            ensure_mutable(&candidate, Some(&previous)),
            Err(ProviderMutationError::ImmutableProvider)
        );
    }

    #[test]
    fn generic_mutation_rejects_non_custom_provider_ids() {
        assert_eq!(
            ensure_mutable(&provider("openai"), None),
            Err(ProviderMutationError::ImmutableProvider)
        );
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum FailStage {
        Secret,
        Provider,
        Selection,
        Activation,
        Removal,
        RemovalAfterCommit,
    }

    struct FakeBackend {
        provider: RefCell<Option<StoredProvider>>,
        settings: RefCell<serde_json::Map<String, serde_json::Value>>,
        secret: RefCell<SecretSnapshot>,
        fail: Cell<Option<FailStage>>,
        fail_rollback: Cell<bool>,
    }

    impl FakeBackend {
        fn seeded(fail: FailStage) -> Self {
            let mut previous = provider("custom:test");
            previous.base_url = "https://old.example/v1".into();
            let binding = provider_connection_snapshot(&previous);
            let mut settings = serde_json::Map::new();
            settings.insert(
                MODEL_SELECTION_KEY.into(),
                serde_json::json!({"providerId":"custom:test","model":"old-model"}),
            );
            Self {
                provider: RefCell::new(Some(previous)),
                settings: RefCell::new(settings),
                secret: RefCell::new(SecretSnapshot::Present {
                    key: "old-secret".into(),
                    binding: Some(binding),
                }),
                fail: Cell::new(Some(fail)),
                fail_rollback: Cell::new(false),
            }
        }

        fn fail_once(&self, stage: FailStage) -> Result<(), String> {
            if self.fail.get() == Some(stage) {
                self.fail.set(None);
                Err("injected persistence failure".into())
            } else {
                Ok(())
            }
        }

        fn assert_previous_state(&self) {
            assert_eq!(
                self.provider.borrow().as_ref().unwrap().base_url,
                "https://old.example/v1"
            );
            assert_eq!(
                self.settings.borrow()[MODEL_SELECTION_KEY]["model"],
                "old-model"
            );
            match &*self.secret.borrow() {
                SecretSnapshot::Present { key, binding } => {
                    assert_eq!(key, "old-secret");
                    assert!(binding
                        .as_deref()
                        .is_some_and(|value| value.contains("old.example")));
                }
                SecretSnapshot::Missing | SecretSnapshot::Unreadable => {
                    panic!("previous bound secret was not restored")
                }
            }
        }
    }

    impl MutationBackend for FakeBackend {
        fn get_provider(&self, _id: &str) -> Result<Option<StoredProvider>, String> {
            Ok(self.provider.borrow().clone())
        }

        fn get_settings(&self) -> Result<serde_json::Map<String, serde_json::Value>, String> {
            Ok(self.settings.borrow().clone())
        }

        fn read_secret(&self, _provider_id: &str) -> SecretSnapshot {
            self.secret.borrow().clone()
        }

        fn write_bound_secret(&self, provider: &StoredProvider, key: &str) -> Result<(), String> {
            self.fail_once(FailStage::Secret)?;
            *self.secret.borrow_mut() = SecretSnapshot::Present {
                key: key.into(),
                binding: Some(provider_connection_snapshot(provider)),
            };
            Ok(())
        }

        fn activate_bound_secret(&self, _provider_id: &str) -> Result<(), String> {
            self.fail_once(FailStage::Activation)
        }

        fn revoke_bound_secret(&self, _provider_id: &str) -> Result<(), String> {
            *self.secret.borrow_mut() = SecretSnapshot::Missing;
            Ok(())
        }

        fn restore_secret(
            &self,
            _provider_id: &str,
            snapshot: &SecretSnapshot,
        ) -> Result<(), String> {
            *self.secret.borrow_mut() = snapshot.clone();
            Ok(())
        }

        fn delete_secret(&self, _provider_id: &str) -> Result<(), String> {
            *self.secret.borrow_mut() = SecretSnapshot::Missing;
            Ok(())
        }

        fn save_provider(&self, provider: &StoredProvider) -> Result<(), String> {
            self.fail_once(FailStage::Provider)?;
            if self.fail_rollback.get() && provider.base_url.contains("old.example") {
                return Err("injected provider rollback failure".into());
            }
            *self.provider.borrow_mut() = Some(provider.clone());
            Ok(())
        }

        fn remove_provider(&self, _provider_id: &str) -> Result<(), String> {
            self.fail_once(FailStage::Removal)?;
            *self.provider.borrow_mut() = None;
            self.fail_once(FailStage::RemovalAfterCommit)?;
            Ok(())
        }

        fn set_selection(&self, value: serde_json::Value) -> Result<(), String> {
            self.fail_once(FailStage::Selection)?;
            self.settings
                .borrow_mut()
                .insert(MODEL_SELECTION_KEY.into(), value);
            Ok(())
        }
    }

    fn changed_provider() -> StoredProvider {
        let mut changed = provider("custom:test");
        changed.base_url = "https://new.example/v1".into();
        changed
    }

    fn new_selection() -> ModelSelection {
        ModelSelection {
            provider_id: "custom:test".into(),
            model: "model".into(),
        }
    }

    #[test]
    fn every_failed_transaction_stage_restores_the_previous_bound_state() {
        for stage in [
            FailStage::Secret,
            FailStage::Provider,
            FailStage::Selection,
            FailStage::Activation,
        ] {
            let backend = FakeBackend::seeded(stage);
            let error = save_custom_with(
                &backend,
                &changed_provider(),
                Some("new-secret"),
                Some(&new_selection()),
            )
            .unwrap_err();
            backend.assert_previous_state();
            assert!(!error.to_string().contains("new-secret"));
            assert!(!error.to_string().contains("old-secret"));
        }
    }

    #[test]
    fn endpoint_change_without_key_reentry_performs_no_writes() {
        let backend = FakeBackend::seeded(FailStage::Selection);
        assert_eq!(
            save_custom_with(&backend, &changed_provider(), None, Some(&new_selection())),
            Err(ProviderMutationError::CredentialReentryRequired)
        );
        assert_eq!(backend.fail.get(), Some(FailStage::Selection));
        backend.assert_previous_state();
    }

    #[test]
    fn failed_config_rollback_leaves_every_credential_unavailable() {
        let backend = FakeBackend::seeded(FailStage::Selection);
        backend.fail_rollback.set(true);
        let error = save_custom_with(
            &backend,
            &changed_provider(),
            Some("new-secret"),
            Some(&new_selection()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("rollback failed closed"));
        assert!(matches!(*backend.secret.borrow(), SecretSnapshot::Missing));
        assert_eq!(
            backend.provider.borrow().as_ref().unwrap().base_url,
            "https://new.example/v1"
        );
        assert!(!error.to_string().contains("new-secret"));
        assert!(!error.to_string().contains("old-secret"));
    }

    #[test]
    fn custom_removal_deletes_the_provider_and_credential() {
        let backend = FakeBackend::seeded(FailStage::Selection);
        let provider = backend.provider.borrow().clone().unwrap();

        remove_custom_with(&backend, &provider).unwrap();

        assert!(backend.provider.borrow().is_none());
        assert!(matches!(*backend.secret.borrow(), SecretSnapshot::Missing));
    }

    #[test]
    fn failed_custom_removal_restores_the_previous_credential() {
        let backend = FakeBackend::seeded(FailStage::Removal);
        let provider = backend.provider.borrow().clone().unwrap();

        let error = remove_custom_with(&backend, &provider).unwrap_err();

        backend.assert_previous_state();
        assert!(!error.to_string().contains("old-secret"));
    }

    #[test]
    fn post_commit_removal_failure_never_restores_an_orphan_credential() {
        let backend = FakeBackend::seeded(FailStage::RemovalAfterCommit);
        let provider = backend.provider.borrow().clone().unwrap();

        let error = remove_custom_with(&backend, &provider).unwrap_err();

        assert!(backend.provider.borrow().is_none());
        assert!(matches!(*backend.secret.borrow(), SecretSnapshot::Missing));
        assert!(!error.to_string().contains("old-secret"));
    }
}
