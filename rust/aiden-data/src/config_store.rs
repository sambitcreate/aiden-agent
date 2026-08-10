//! Config store (port of `main/services/config-store-core.ts`).
//!
//! The read/write API the rest of the app calls, backed by the four-way split
//! of [`crate::portable_config::PortableConfigStores`]: provider intent,
//! aliases, MCP servers, and skills live in `~/.aiden/config.json`; workspaces,
//! UI settings, and the model discovery cache are machine-local. Callers see
//! none of that split.
//!
//! Seeding runs exactly once per process and is the single gate every other
//! mutation awaits: it migrates the split layout, runs the legacy Pi preset
//! retirement, backfills the workspace default, and re-homes secret/cache
//! aliases. The `SecretsPort` seam keeps the encrypted half injectable so the
//! routing and seeding order are testable without a keychain.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::portable_config::*;
use crate::secret_map::{delete_secret_key_entry, set_secret_key_entry, SecretKeyMap};

#[derive(Debug, thiserror::Error)]
pub enum ConfigStoreError {
    #[error("{0}")]
    Store(#[from] crate::DataStoreError),
    #[error("{0}")]
    Portable(#[from] PortableConfigError),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "Config migration is deferred; fix ~/.aiden/config.json and restart before changing settings."
    )]
    MigrationDeferred,
    #[error("Portable config contains invalid JSON; fix ~/.aiden/config.json first.")]
    CorruptPortable,
    #[error("Portable config is malformed; edit ~/.aiden/config.json before changing it.")]
    MalformedPortable,
    #[error("The requested change would create an invalid portable config.")]
    InvalidResult,
    #[error("Skill IDs must be 1 to 128 bytes after trimming.")]
    InvalidSkillId,
    #[error("Skill names must be 1 to 128 characters after trimming.")]
    InvalidSkillName,
    #[error("Skill descriptions may contain at most 512 characters.")]
    InvalidSkillDescription,
    #[error("Skill instructions must contain non-whitespace text and be at most 1 MiB.")]
    InvalidSkillInstructions,
    #[error("A skill with the same case-insensitive name already exists.")]
    DuplicateSkillName,
    #[error("At most 500 configured skills may be saved.")]
    SkillCatalogLimit,
    #[error("Configured skill instructions may total at most 8 MiB.")]
    SkillInstructionsBudget,
    #[error("\"assistant\" is reserved and cannot be a workspace id.")]
    ReservedWorkspaceId,
    #[error("The renderer document is no longer active.")]
    DocumentInactive,
    #[error("Legacy provider credentials contain unresolved future-version records.")]
    UnresolvedSecretMigration,
    #[error("Invalid Google model.")]
    InvalidGoogleModel,
    #[error("This Google model does not support thinking.")]
    GoogleModelNoThinking,
    #[error("This thinking level is not supported by the selected Google model.")]
    GoogleLevelUnsupported,
    #[error("Invalid Anthropic model.")]
    InvalidAnthropicModel,
    #[error("This Anthropic model does not support thinking.")]
    AnthropicModelNoThinking,
    #[error("This thinking level is not supported by the selected Anthropic model.")]
    AnthropicLevelUnsupported,
    #[error("Invalid ChatGPT/Codex model.")]
    InvalidCodexModel,
    #[error("This ChatGPT/Codex model does not support thinking.")]
    CodexModelNoThinking,
    #[error("This thinking level is not supported by the selected ChatGPT/Codex model.")]
    CodexLevelUnsupported,
    #[error("Too many thinking preferences.")]
    TooManyThinkingPreferences,
    #[error("Too many Google thinking preferences.")]
    TooManyGoogleThinkingPreferences,
    #[error("Too many ChatGPT/Codex thinking preferences.")]
    TooManyCodexThinkingPreferences,
    #[error("Too many Anthropic thinking preferences.")]
    TooManyAnthropicThinkingPreferences,
    #[error("Invalid Google thinking preference.")]
    InvalidGoogleThinkingPreference,
    #[error("Invalid ChatGPT/Codex thinking preference.")]
    InvalidCodexThinkingPreference,
    #[error("Invalid Anthropic thinking preference.")]
    InvalidAnthropicThinkingPreference,
    #[error("provider secret migration: {0}")]
    SecretMigration(String),
}

/// The slice of the keychain store this module needs (`SecretsPort`).
pub trait SecretsPort: Send + Sync {
    fn has_key(&self, provider_id: &str) -> Result<bool, ConfigStoreError>;
    fn get_provider_key(
        &self,
        provider_id: &str,
        binding: &str,
    ) -> Result<Option<String>, ConfigStoreError>;
    fn delete_key(&self, provider_id: &str) -> Result<(), ConfigStoreError>;
    fn migrate_keys(
        &self,
        migrate: &dyn Fn(&mut SecretKeyMap) -> bool,
    ) -> Result<(), ConfigStoreError>;
    fn migrate_provider_keys_with_bindings(
        &self,
        migrations: &[ProviderKeyMigration],
    ) -> Result<bool, ConfigStoreError>;
}

pub struct ProviderKeyMigration {
    pub legacy_provider_id: String,
    pub provider_id: String,
    pub binding: String,
}

/// `providerConnectionSnapshot` (provider-credential-rotation-core.ts): the
/// exact endpoint facts a stored key is bound to.
pub fn provider_connection_snapshot(provider: &StoredProvider) -> String {
    serde_json::json!({
        "id": provider.id,
        "kind": provider.kind,
        "baseUrl": provider.base_url,
        "needsKey": provider.needs_key,
    })
    .to_string()
}

/// The default workspace every install starts with.
pub fn default_workspace() -> Workspace {
    let now = crate::now_millis();
    Workspace {
        id: "default".to_string(),
        name: "Workspace".to_string(),
        folder_path: None,
        permission: WorkspacePermission::Ask,
        managed_worktree: None,
        created_at: now,
        updated_at: now,
    }
}

fn normalize_workspace(workspace: &Workspace) -> Workspace {
    let name = if workspace.name.trim().is_empty() {
        "Workspace".to_string()
    } else {
        workspace.name.trim().to_string()
    };
    let permission = workspace.permission;
    let managed_worktree = workspace
        .managed_worktree
        .as_ref()
        .filter(|worktree| {
            PathBuf::from(&worktree.repository_path).is_absolute()
                && PathBuf::from(&worktree.worktree_path).is_absolute()
                && !worktree.branch.is_empty()
                && !worktree.created_from_head.is_empty()
                && match &worktree.worktree_git_dir {
                    None => true,
                    Some(path) => PathBuf::from(path).is_absolute(),
                }
        })
        .cloned();
    Workspace {
        id: workspace.id.clone(),
        name,
        folder_path: workspace
            .folder_path
            .as_ref()
            .filter(|path| PathBuf::from(path).is_absolute())
            .cloned(),
        permission,
        managed_worktree,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
    }
}

fn has_provider_cache(entry: Option<&ProviderModelCacheEntry>) -> bool {
    matches!(
        entry,
        Some(entry) if entry.models.is_some() || entry.model_metadata.is_some()
    )
}

/// Renderer-exposed provider: `hasKey` is derived; the key itself never leaves
/// the backend.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub kind: ProviderKind,
    pub label: String,
    pub base_url: String,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<std::collections::BTreeMap<String, ProviderModelMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub needs_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<ProviderDeployment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_preset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_builtin: Option<bool>,
    pub has_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_ids: Option<Vec<String>>,
}

// -- thinking preference helpers ----------------------------------------------

const MAX_THINKING_MODEL_PREFERENCES: usize = 256;
const MAX_MODEL_ID_CHARS: usize = 256;

fn is_thinking_level(levels: &[&str], value: &Value) -> bool {
    matches!(value, Value::String(level) if levels.contains(&level.as_str()))
}

fn merge_thinking_preference(
    current: Option<&Value>,
    model_id: &str,
    level: Value,
    levels: &[&str],
    too_many: ConfigStoreError,
    invalid: ConfigStoreError,
) -> Result<Map<String, Value>, ConfigStoreError> {
    if model_id.is_empty() || model_id.len() > MAX_MODEL_ID_CHARS {
        return Err(invalid);
    }
    if !is_thinking_level(levels, &level) {
        return Err(invalid);
    }
    let mut entries: Vec<(String, Value)> = Vec::new();
    if let Some(Value::Object(current)) = current {
        for (id, value) in current {
            if id.is_empty() || id.len() > MAX_MODEL_ID_CHARS || id == model_id {
                continue;
            }
            entries.push((id.clone(), value.clone()));
        }
    }
    if entries.len() >= MAX_THINKING_MODEL_PREFERENCES {
        return Err(too_many);
    }
    entries.push((model_id.to_string(), level));
    let mut map = Map::new();
    for (id, value) in entries {
        map.insert(id, value);
    }
    Ok(map)
}

// ===========================================================================
// The store
// ===========================================================================

/// The config store. Seeding and mutations are serialized behind one lock tail
/// (the TS seeding gate is the single point every other caller awaits).
pub struct ConfigStore {
    stores: PortableConfigStores,
    secrets: Arc<dyn SecretsPort>,
    report_deferred_error: Option<Box<dyn Fn(&str, &str) + Send + Sync>>,
    seed_done: Mutex<bool>,
    seed_ok: Mutex<bool>,
    secret_migration_aliases: Mutex<Vec<(String, String)>>,
    secret_migration_targets: Mutex<Vec<(String, String)>>,
    secret_migration_complete: Mutex<bool>,
    tail: Mutex<()>,
}

impl ConfigStore {
    pub fn new(
        stores: PortableConfigStores,
        secrets: Arc<dyn SecretsPort>,
        report_deferred_error: Option<Box<dyn Fn(&str, &str) + Send + Sync>>,
    ) -> Self {
        Self {
            stores,
            secrets,
            report_deferred_error,
            seed_done: Mutex::new(false),
            seed_ok: Mutex::new(false),
            secret_migration_aliases: Mutex::new(Vec::new()),
            secret_migration_targets: Mutex::new(Vec::new()),
            secret_migration_complete: Mutex::new(false),
            tail: Mutex::new(()),
        }
    }

    fn serialized<R>(
        &self,
        operation: impl FnOnce(&ConfigStore) -> Result<R, ConfigStoreError>,
    ) -> Result<R, ConfigStoreError> {
        let _guard = self.tail.lock();
        operation(self)
    }

    // -- seeding ------------------------------------------------------------

    fn ensure_seeded(&self) -> Result<bool, ConfigStoreError> {
        if *self.seed_done.lock() {
            return Ok(*self.seed_ok.lock());
        }
        let result = self.run_seeding();
        if let Ok(completed) = &result {
            if *completed {
                *self.seed_ok.lock() = true;
                *self.seed_done.lock() = true;
            }
        }
        let completed = result?;
        if completed {
            self.attempt_secret_migration();
        }
        Ok(completed)
    }

    fn run_seeding(&self) -> Result<bool, ConfigStoreError> {
        if !self.stores.ensure_migrated()? {
            return Ok(false);
        }
        if self.stores.local.loaded_from_unsafe_file()? {
            return Ok(false);
        }
        if self.stores.portable.loaded_from_corrupt_file()? {
            return Ok(false);
        }

        let seeded = self.stores.local.load()?.seeded;
        let cache_before = self.stores.model_cache.load()?.by_provider;
        let current_settings = runtime_settings_from(&self.stores.settings.load()?.settings);
        let mut last_provider_id = current_settings
            .get("lastProviderId")
            .and_then(Value::as_str)
            .map(str::to_string);

        let before = self.stores.portable.load()?;
        if !configured_skill_instructions_fit(&before.skills) {
            return Err(ConfigStoreError::SkillInstructionsBudget);
        }
        let (config, unsafe_config) = normalize_portable_config(&serde_json::to_value(&before)?);
        if unsafe_config {
            return Ok(false);
        }
        let aliases_before_migration = config.provider_id_aliases.clone();

        // A fresh install already starts with no providers. Never use this
        // machine's local seed marker to clear portable provider intent.
        let mut draft_providers: Vec<StoredProvider> = config
            .providers
            .iter()
            .map(|intent| compose_stored_provider(intent, cache_before.get(&intent.id)))
            .collect();
        let mut draft_aliases = config.provider_id_aliases.clone();
        let providers_changed = migrate_pi_provider_config(
            &mut draft_providers,
            &mut draft_aliases,
            &mut last_provider_id,
        );
        let mut config = config;
        config.providers = draft_providers
            .iter()
            .map(|provider| split_stored_provider(provider).0)
            .collect();
        config.provider_id_aliases = draft_aliases.clone();
        let mut alias_routes_for_migration = aliases_before_migration.clone();
        for (source, target) in &config.provider_id_aliases {
            if !alias_routes_for_migration.contains_key(source) {
                alias_routes_for_migration.insert(source.clone(), target.clone());
            }
        }
        let migrated = draft_providers.clone();
        if normalize_portable_config(&serde_json::to_value(&config)?).1 {
            // Migration may add an alias to an otherwise maximum-capacity
            // graph. Never publish a document this build would reject.
            return Ok(false);
        }

        if serde_json::to_string(&config)? != serde_json::to_string(&before)? {
            self.stores.portable.save(&config)?;
        }

        if !seeded {
            self.stores.local.update(|config| config.seeded = true)?;
        }
        let current_last_provider_id = current_settings
            .get("lastProviderId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if last_provider_id != current_last_provider_id {
            self.stores.settings.update(|document| {
                if let Some(last_provider_id) = &last_provider_id {
                    document.settings.insert(
                        "lastProviderId".into(),
                        Value::String(last_provider_id.clone()),
                    );
                } else {
                    document.settings.remove("lastProviderId");
                }
            })?;
        }

        let active_provider_ids: std::collections::HashSet<String> = config
            .providers
            .iter()
            .map(|provider| provider.id.clone())
            .collect();
        let mut cache_alias_entries: Vec<(String, String)> = Vec::new();
        for (source, target, _depth) in provider_alias_routes(&config.provider_id_aliases) {
            if source != target
                && !active_provider_ids.contains(&source)
                && active_provider_ids.contains(&target)
            {
                cache_alias_entries.push((source, target));
            }
        }
        {
            let mut targets = self.secret_migration_targets.lock();
            let mut unique = HashMap::new();
            for (_, target_id) in &cache_alias_entries {
                if let Some(intent) = config
                    .providers
                    .iter()
                    .find(|provider| &provider.id == target_id)
                {
                    let stored = compose_stored_provider(intent, cache_before.get(target_id));
                    unique.insert(target_id.clone(), provider_connection_snapshot(&stored));
                }
            }
            *targets = unique.into_iter().collect();
        }
        {
            let mut aliases = self.secret_migration_aliases.lock();
            *aliases = cache_alias_entries.clone();
        }

        let cache_alias_repair_needed = cache_alias_entries
            .iter()
            .any(|(legacy_id, _)| has_provider_cache(cache_before.get(legacy_id)));
        if providers_changed || cache_alias_repair_needed {
            self.stores.model_cache.update(|draft| {
                if providers_changed {
                    let mut next: std::collections::BTreeMap<String, ProviderModelCacheEntry> =
                        std::collections::BTreeMap::new();
                    for provider in &migrated {
                        let (_, embedded) = split_stored_provider(provider);
                        let existing = cache_before.get(&provider.id);
                        let mut legacy: ProviderModelCacheEntry = ProviderModelCacheEntry {
                            models: None,
                            model_metadata: None,
                        };
                        for (legacy_id, _) in &cache_alias_entries {
                            if legacy_id == &provider.id {
                                continue;
                            }
                            let entry = cache_before.get(legacy_id);
                            legacy = merge_provider_model_cache_entries(entry, Some(&legacy));
                        }
                        let cache =
                            merge_provider_model_cache_entries(Some(&embedded), Some(&legacy));
                        let cache = merge_provider_model_cache_entries(existing, Some(&cache));
                        if has_provider_cache(Some(&cache)) {
                            next.insert(provider.id.clone(), cache);
                        }
                    }
                    draft.by_provider = next;
                } else {
                    for (legacy_id, target_id) in &cache_alias_entries {
                        let Some(legacy) = draft.by_provider.get(legacy_id).cloned() else {
                            continue;
                        };
                        if !has_provider_cache(Some(&legacy)) {
                            continue;
                        }
                        let merged = merge_provider_model_cache_entries(
                            Some(&legacy),
                            draft.by_provider.get(target_id),
                        );
                        draft.by_provider.insert(target_id.clone(), merged);
                        draft.by_provider.remove(legacy_id);
                    }
                }
            })?;
        }
        self.stores.local.update(|config| {
            if config.workspaces.is_empty() {
                config.workspaces = vec![default_workspace()];
            }
        })?;
        Ok(true)
    }

    fn attempt_secret_migration(&self) {
        if *self.secret_migration_complete.lock() {
            return;
        }
        let result = (|| -> Result<(), ConfigStoreError> {
            let aliases = self.secret_migration_aliases.lock().clone();
            let targets = self.secret_migration_targets.lock().clone();
            let custom_alias_sources: std::collections::HashSet<String> =
                aliases.iter().map(|(legacy, _)| legacy.clone()).collect();
            let binding_by_target: HashMap<String, String> = targets.into_iter().collect();
            let migrations: Vec<ProviderKeyMigration> = aliases
                .iter()
                .filter_map(|(legacy, provider_id)| {
                    binding_by_target
                        .get(provider_id)
                        .map(|binding| ProviderKeyMigration {
                            legacy_provider_id: legacy.clone(),
                            provider_id: provider_id.clone(),
                            binding: binding.clone(),
                        })
                })
                .collect();
            if migrations.len() != aliases.len()
                || !self
                    .secrets
                    .migrate_provider_keys_with_bindings(&migrations)?
            {
                return Err(ConfigStoreError::UnresolvedSecretMigration);
            }
            let unresolved_cell = std::cell::Cell::new(false);
            self.secrets.migrate_keys(&|keys| {
                let mut changed = false;
                if let Some(legacy_google_key) = keys.get("gemini").cloned() {
                    if !custom_alias_sources.contains("gemini") {
                        if !legacy_google_key.is_string() {
                            unresolved_cell.set(true);
                            return false;
                        }
                        if !keys.contains_key("google") {
                            set_secret_key_entry(keys, "google", legacy_google_key.to_string());
                        } else {
                            unresolved_cell.set(true);
                            return changed;
                        }
                        delete_secret_key_entry(keys, "gemini");
                        changed = true;
                    }
                }
                changed
            })?;
            let unresolved = unresolved_cell.get();
            if unresolved {
                Err(ConfigStoreError::UnresolvedSecretMigration)
            } else {
                *self.secret_migration_complete.lock() = true;
                Ok(())
            }
        })();
        if let Err(error) = result {
            if let Some(report) = &self.report_deferred_error {
                report("provider-secret-migration", &error.to_string());
            }
        }
    }

    fn require_seeded_for_write(&self) -> Result<(), ConfigStoreError> {
        if !self.ensure_seeded()? {
            let config = self.stores.portable.load()?;
            if !configured_skill_instructions_fit(&config.skills) {
                return Err(ConfigStoreError::SkillInstructionsBudget);
            }
            return Err(ConfigStoreError::MigrationDeferred);
        }
        Ok(())
    }

    fn read_portable(&self) -> Result<PortableConfigShape, ConfigStoreError> {
        self.ensure_seeded()?;
        let value = serde_json::to_value(self.stores.portable.load()?)?;
        Ok(normalize_portable_config(&value).0)
    }

    fn mutate_portable<R>(
        &self,
        mutation: impl FnOnce(&mut PortableConfigShape) -> Result<R, ConfigStoreError>,
        is_current: &dyn Fn() -> bool,
    ) -> Result<R, ConfigStoreError> {
        self.require_seeded_for_write()?;
        if self.stores.portable.loaded_from_corrupt_file()? {
            return Err(ConfigStoreError::CorruptPortable);
        }
        // Equivalent to the TS `portable.update(mutation, isCurrent)`: the
        // store reloads before the write (reloadBeforeWrite), normalizes the
        // draft, runs the mutation (which may reject), and publishes only on
        // success.
        let mut draft = self.stores.portable.load()?;
        if !configured_skill_instructions_fit(&draft.skills) {
            return Err(ConfigStoreError::SkillInstructionsBudget);
        }
        let (normalized, unsafe_config) = normalize_portable_config(&serde_json::to_value(&draft)?);
        if unsafe_config {
            return Err(ConfigStoreError::MalformedPortable);
        }
        draft = normalized;
        let result = mutation(&mut draft)?;
        let (mutated, unsafe_mutated) = normalize_portable_config(&serde_json::to_value(&draft)?);
        if unsafe_mutated {
            return Err(ConfigStoreError::InvalidResult);
        }
        draft = mutated;
        self.stores.portable.save_with_current(&draft, is_current)?;
        Ok(result)
    }

    fn mutate_settings<R>(
        &self,
        mutation: impl FnOnce(&mut SettingsShape) -> Result<R, ConfigStoreError>,
        is_current: &dyn Fn() -> bool,
    ) -> Result<R, ConfigStoreError> {
        self.require_seeded_for_write()?;
        let mut draft = self.stores.settings.load()?;
        let result = mutation(&mut draft)?;
        self.stores.settings.save_with_current(&draft, is_current)?;
        Ok(result)
    }

    fn read_model_cache(&self) -> Result<ProviderModelCacheShape, ConfigStoreError> {
        self.ensure_seeded()?;
        Ok(self.stores.model_cache.load()?)
    }

    fn to_provider(
        &self,
        provider: &StoredProvider,
        aliases: &Map<String, Value>,
    ) -> Result<Provider, ConfigStoreError> {
        let has_key = self
            .secrets
            .get_provider_key(&provider.id, &provider_connection_snapshot(provider))?
            .is_some();
        let legacy_ids: Vec<String> = aliases
            .keys()
            .filter(|legacy_id| {
                resolve_provider_alias(aliases, legacy_id).as_deref() == Some(provider.id.as_str())
            })
            .cloned()
            .collect();
        Ok(Provider {
            id: provider.id.clone(),
            kind: provider.kind,
            label: provider.label.clone(),
            base_url: provider.base_url.clone(),
            models: provider.models.clone(),
            model_metadata: provider.model_metadata.clone(),
            default_model: provider.default_model.clone(),
            needs_key: provider.needs_key,
            deployment: provider.deployment,
            is_preset: provider.is_preset,
            is_builtin: provider.is_builtin,
            has_key,
            legacy_ids: if legacy_ids.is_empty() {
                None
            } else {
                Some(legacy_ids)
            },
        })
    }

    // -- public API ---------------------------------------------------------

    pub fn portable_config_safe_for_credential_reconciliation(
        &self,
    ) -> Result<bool, ConfigStoreError> {
        self.serialized(|store| {
            if !store.ensure_seeded()? {
                return Ok(false);
            }
            store.stores.portable.reload()?;
            if store.stores.portable.loaded_from_corrupt_file()? {
                return Ok(false);
            }
            let value = serde_json::to_value(store.stores.portable.load()?)?;
            Ok(!normalize_portable_config(&value).1)
        })
    }

    pub fn cached_portable_config_safe_for_credential_reconciliation(
        &self,
    ) -> Result<bool, ConfigStoreError> {
        self.serialized(|store| {
            if !store.ensure_seeded()? {
                return Ok(false);
            }
            if store.stores.portable.loaded_from_corrupt_file()? {
                return Ok(false);
            }
            let value = serde_json::to_value(store.stores.portable.load()?)?;
            Ok(!normalize_portable_config(&value).1)
        })
    }

    pub fn provider_legacy_credential_migration_ready(&self) -> Result<bool, ConfigStoreError> {
        self.serialized(|store| {
            if !store.ensure_seeded()? || !*store.secret_migration_complete.lock() {
                return Ok(false);
            }
            if store.stores.portable.loaded_from_corrupt_file()? {
                return Ok(false);
            }
            let value = serde_json::to_value(store.stores.portable.load()?)?;
            Ok(!normalize_portable_config(&value).1)
        })
    }

    pub fn list_providers(&self) -> Result<Vec<Provider>, ConfigStoreError> {
        self.serialized(|store| {
            let config = store.read_portable()?;
            let cache = store.read_model_cache()?;
            let mut providers = Vec::new();
            for intent in &config.providers {
                let stored = compose_stored_provider(intent, cache.by_provider.get(&intent.id));
                providers.push(store.to_provider(&stored, &config.provider_id_aliases)?);
            }
            Ok(providers)
        })
    }

    pub fn get_provider(&self, id: &str) -> Result<Option<StoredProvider>, ConfigStoreError> {
        self.serialized(|store| {
            let config = store.read_portable()?;
            let Some(intent) = config.providers.iter().find(|provider| provider.id == id) else {
                return Ok(None);
            };
            let cache = store.read_model_cache()?;
            Ok(Some(compose_stored_provider(
                intent,
                cache.by_provider.get(id),
            )))
        })
    }

    /// Resolve the API key bound to this exact provider connection snapshot.
    ///
    /// A key saved for a different endpoint, API kind, or authentication
    /// posture is deliberately treated as absent.
    pub fn get_bound_provider_key(
        &self,
        provider: &StoredProvider,
    ) -> Result<Option<String>, ConfigStoreError> {
        self.serialized(|store| {
            store
                .secrets
                .get_provider_key(&provider.id, &provider_connection_snapshot(provider))
        })
    }

    /// Insert or update a provider record (upsert by id).
    pub fn save_provider(
        &self,
        provider: &StoredProvider,
        is_current: &dyn Fn() -> bool,
    ) -> Result<Provider, ConfigStoreError> {
        self.serialized(|store| {
            let (intent, cache) = split_stored_provider(provider);
            let stored = store.mutate_portable(
                |config| {
                    let index = config
                        .providers
                        .iter()
                        .position(|candidate| candidate.id == intent.id);
                    match index {
                        Some(index) => {
                            let mut merged = config.providers[index].clone();
                            merged = merge_portable_provider(merged, &intent);
                            config.providers[index] = merged.clone();
                            Ok(merged)
                        }
                        None => {
                            config.providers.push(intent.clone());
                            Ok(intent.clone())
                        }
                    }
                },
                is_current,
            )?;
            let entry = store.stores.model_cache.update_with_current(
                |draft| {
                    let next = merge_provider_model_cache_entries(
                        draft.by_provider.get(&intent.id),
                        Some(&cache),
                    );
                    draft.by_provider.insert(intent.id.clone(), next.clone());
                    next
                },
                is_current,
            )?;
            let config = store.read_portable()?;
            store.to_provider(
                &compose_stored_provider(&stored, Some(&entry)),
                &config.provider_id_aliases,
            )
        })
    }

    pub fn remove_provider(
        &self,
        id: &str,
        is_current: &dyn Fn() -> bool,
    ) -> Result<(), ConfigStoreError> {
        self.serialized(|store| {
            store.mutate_portable(
                |config| {
                    config.providers.retain(|provider| provider.id != id);
                    Ok(())
                },
                is_current,
            )?;
            store.stores.model_cache.update_with_current(
                |draft| {
                    draft.by_provider.remove(id);
                },
                is_current,
            )?;
            store.secrets.delete_key(id)?;
            Ok(())
        })
    }

    /// Resolve a historical provider identity without ever falling through to
    /// a new Pi provider.
    pub fn resolve_provider_id(
        &self,
        id: Option<&str>,
    ) -> Result<Option<String>, ConfigStoreError> {
        self.serialized(|store| {
            let Some(id) = id else {
                return Ok(None);
            };
            let config = store.read_portable()?;
            Ok(resolve_provider_alias(&config.provider_id_aliases, id)
                .or_else(|| migrate_legacy_pi_provider_id(Some(id))))
        })
    }

    pub fn get_settings(&self) -> Result<Map<String, Value>, ConfigStoreError> {
        self.serialized(|store| {
            store.ensure_seeded()?;
            Ok(runtime_settings_from(
                &store.stores.settings.load()?.settings,
            ))
        })
    }

    pub fn set_settings(
        &self,
        patch: &Map<String, Value>,
        is_current: &dyn Fn() -> bool,
    ) -> Result<Map<String, Value>, ConfigStoreError> {
        self.serialized(|store| {
            let aliases = store.read_portable()?.provider_id_aliases;
            let saved = store.mutate_settings(
                |document| {
                    if let Some(last_provider_id) = patch.get("lastProviderId") {
                        if let Some(last_provider_id) = last_provider_id.as_str() {
                            let resolved = resolve_provider_alias(&aliases, last_provider_id)
                                .or_else(|| migrate_legacy_pi_provider_id(Some(last_provider_id)));
                            if let Some(resolved) = resolved {
                                document
                                    .settings
                                    .insert("lastProviderId".into(), Value::String(resolved));
                            }
                        }
                    }
                    for (key, value) in patch {
                        if key == "lastProviderId" {
                            continue;
                        }
                        document.settings.insert(key.clone(), value.clone());
                    }
                    if let Some(assistant_patch) = patch.get("assistant").and_then(Value::as_object)
                    {
                        let merged = match document.settings.get("assistant") {
                            Some(Value::Object(current)) => {
                                let mut merged = current.clone();
                                for (key, value) in assistant_patch {
                                    merged.insert(key.clone(), value.clone());
                                }
                                merged
                            }
                            _ => assistant_patch.clone(),
                        };
                        document
                            .settings
                            .insert("assistant".into(), Value::Object(merged));
                    }
                    Ok(document.settings.clone())
                },
                is_current,
            )?;
            Ok(runtime_settings_from(&saved))
        })
    }

    /// Remove one machine-local setting atomically. This is used for durable
    /// transaction journals where `null` must not be confused with absence.
    pub fn remove_setting(
        &self,
        key: &str,
        is_current: &dyn Fn() -> bool,
    ) -> Result<(), ConfigStoreError> {
        self.serialized(|store| {
            store.mutate_settings(
                |document| {
                    document.settings.remove(key);
                    Ok(())
                },
                is_current,
            )
        })
    }

    pub fn set_google_thinking_level(
        &self,
        model_id: &str,
        level: &str,
    ) -> Result<Map<String, Value>, ConfigStoreError> {
        let level = Value::String(level.to_string());
        self.serialized(|store| {
            let saved = store.mutate_settings(
                |document| {
                    let merged = merge_thinking_preference(
                        document.settings.get("googleThinkingByModel"),
                        model_id,
                        level,
                        &["off", "low", "medium", "high"],
                        ConfigStoreError::TooManyGoogleThinkingPreferences,
                        ConfigStoreError::InvalidGoogleThinkingPreference,
                    )?;
                    document
                        .settings
                        .insert("googleThinkingByModel".into(), Value::Object(merged));
                    Ok(document.settings.clone())
                },
                &|| true,
            )?;
            Ok(runtime_settings_from(&saved))
        })
    }

    pub fn set_codex_thinking_level(
        &self,
        model_id: &str,
        level: &str,
    ) -> Result<Map<String, Value>, ConfigStoreError> {
        let level = Value::String(level.to_string());
        self.serialized(|store| {
            let saved = store.mutate_settings(
                |document| {
                    let merged = merge_thinking_preference(
                        document.settings.get("codexThinkingByModel"),
                        model_id,
                        level,
                        &["low", "medium", "high", "xhigh", "max"],
                        ConfigStoreError::TooManyCodexThinkingPreferences,
                        ConfigStoreError::InvalidCodexThinkingPreference,
                    )?;
                    document
                        .settings
                        .insert("codexThinkingByModel".into(), Value::Object(merged));
                    Ok(document.settings.clone())
                },
                &|| true,
            )?;
            Ok(runtime_settings_from(&saved))
        })
    }

    pub fn set_anthropic_thinking_level(
        &self,
        model_id: &str,
        level: &str,
    ) -> Result<Map<String, Value>, ConfigStoreError> {
        let level = Value::String(level.to_string());
        self.serialized(|store| {
            let saved = store.mutate_settings(
                |document| {
                    let merged = merge_thinking_preference(
                        document.settings.get("anthropicThinkingByModel"),
                        model_id,
                        level,
                        &["off", "low", "medium", "high", "xhigh", "max"],
                        ConfigStoreError::TooManyAnthropicThinkingPreferences,
                        ConfigStoreError::InvalidAnthropicThinkingPreference,
                    )?;
                    document
                        .settings
                        .insert("anthropicThinkingByModel".into(), Value::Object(merged));
                    Ok(document.settings.clone())
                },
                &|| true,
            )?;
            Ok(runtime_settings_from(&saved))
        })
    }

    // -- MCP servers --------------------------------------------------------

    pub fn list_mcp_servers(&self) -> Result<Vec<McpServer>, ConfigStoreError> {
        self.serialized(|store| Ok(store.read_portable()?.mcp_servers))
    }

    pub fn save_mcp_server(
        &self,
        server: &McpServer,
        is_current: &dyn Fn() -> bool,
    ) -> Result<McpServer, ConfigStoreError> {
        if !is_mcp_server(&serde_json::to_value(server)?) {
            return Err(ConfigStoreError::InvalidResult);
        }
        self.serialized(|store| {
            store.mutate_portable(
                |config| {
                    let index = config
                        .mcp_servers
                        .iter()
                        .position(|candidate| candidate.id == server.id);
                    match index {
                        Some(index) => {
                            let mut merged = config.mcp_servers[index].clone();
                            merged = merge_mcp_server(merged, server);
                            config.mcp_servers[index] = merged.clone();
                            Ok(merged)
                        }
                        None => {
                            if config.mcp_servers.len() >= MAX_MCP_SERVERS {
                                return Err(ConfigStoreError::InvalidResult);
                            }
                            config.mcp_servers.push(server.clone());
                            Ok(server.clone())
                        }
                    }
                },
                is_current,
            )
        })
    }

    pub fn remove_mcp_server(
        &self,
        id: &str,
        is_current: &dyn Fn() -> bool,
    ) -> Result<(), ConfigStoreError> {
        self.serialized(|store| {
            store.mutate_portable(
                |config| {
                    config.mcp_servers.retain(|server| server.id != id);
                    Ok(())
                },
                is_current,
            )
        })
    }

    // -- Skills -------------------------------------------------------------

    pub fn list_skills(&self) -> Result<Vec<Skill>, ConfigStoreError> {
        self.serialized(|store| {
            store.ensure_seeded()?;
            let config = store.stores.portable.load()?;
            if !configured_skill_instructions_fit(&config.skills) {
                return Err(ConfigStoreError::SkillInstructionsBudget);
            }
            let (normalized, unsafe_config) =
                normalize_portable_config(&serde_json::to_value(&config)?);
            if unsafe_config {
                return Err(ConfigStoreError::MalformedPortable);
            }
            Ok(normalized.skills)
        })
    }

    pub fn save_skill(&self, skill: &Skill) -> Result<Skill, ConfigStoreError> {
        let mut skill = skill.clone();
        skill.id = skill.id.trim().to_string();
        skill.name = skill.name.trim().to_string();
        self.serialized(|store| {
            store.mutate_portable(
                |config| {
                    validate_skill_for_save(&skill, &config.skills)?;
                    let index = config
                        .skills
                        .iter()
                        .position(|candidate| candidate.id.trim() == skill.id);
                    match index {
                        Some(index) => {
                            let mut merged = config.skills[index].clone();
                            merged = merge_skill(merged, &skill);
                            config.skills[index] = merged.clone();
                            Ok(merged)
                        }
                        None => {
                            if config.skills.len() >= MAX_CONFIGURED_SKILLS {
                                return Err(ConfigStoreError::SkillCatalogLimit);
                            }
                            config.skills.push(skill.clone());
                            Ok(skill.clone())
                        }
                    }
                },
                &|| true,
            )
        })
    }

    pub fn remove_skill(&self, id: &str) -> Result<(), ConfigStoreError> {
        self.serialized(|store| {
            store.mutate_portable(
                |config| {
                    config.skills.retain(|skill| skill.id != id);
                    Ok(())
                },
                &|| true,
            )
        })
    }

    // -- Workspaces ---------------------------------------------------------

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, ConfigStoreError> {
        self.serialized(|store| {
            store.ensure_seeded()?;
            Ok(store.stores.local.load()?.workspaces)
        })
    }

    pub fn get_workspace(&self, id: &str) -> Result<Option<Workspace>, ConfigStoreError> {
        self.serialized(|store| {
            store.ensure_seeded()?;
            Ok(store
                .stores
                .local
                .load()?
                .workspaces
                .into_iter()
                .find(|workspace| workspace.id == id))
        })
    }

    pub fn save_workspace(&self, workspace: &Workspace) -> Result<Workspace, ConfigStoreError> {
        self.serialized(|store| {
            if workspace.id == crate::aiden_core_assistant_workspace_id() {
                return Err(ConfigStoreError::ReservedWorkspaceId);
            }
            let mut next = workspace.clone();
            next.updated_at = crate::now_millis();
            let next = normalize_workspace(&next);
            store.require_seeded_for_write()?;
            store.stores.local.update(|config| {
                let index = config
                    .workspaces
                    .iter()
                    .position(|candidate| candidate.id == next.id);
                match index {
                    Some(index) => {
                        let mut merged = config.workspaces[index].clone();
                        merged = merge_workspace(merged, &next);
                        config.workspaces[index] = merged.clone();
                        merged
                    }
                    None => {
                        config.workspaces.push(next.clone());
                        next.clone()
                    }
                }
            })?;
            Ok(next)
        })
    }

    pub fn remove_workspace(&self, id: &str) -> Result<(), ConfigStoreError> {
        self.serialized(|store| {
            store.require_seeded_for_write()?;
            store.stores.local.update(|config| {
                config.workspaces.retain(|workspace| workspace.id != id);
                // Never leave the app without a workspace.
                if config.workspaces.is_empty() {
                    config.workspaces = vec![default_workspace()];
                }
            })?;
            Ok(())
        })
    }
}

fn validate_skill_for_save(skill: &Skill, existing: &[Skill]) -> Result<(), ConfigStoreError> {
    let id = skill.id.trim();
    if id.is_empty() || id.len() > MAX_SKILL_ID_LENGTH {
        return Err(ConfigStoreError::InvalidSkillId);
    }
    let name = skill.name.trim();
    if name.is_empty() || name.chars().count() > MAX_SKILL_NAME_LENGTH {
        return Err(ConfigStoreError::InvalidSkillName);
    }
    if skill.description.chars().count() > MAX_SKILL_DESCRIPTION_LENGTH {
        return Err(ConfigStoreError::InvalidSkillDescription);
    }
    let instructions = skill.instructions.trim();
    if instructions.is_empty() || skill.instructions.len() > MAX_SKILL_INSTRUCTIONS_LENGTH {
        return Err(ConfigStoreError::InvalidSkillInstructions);
    }
    if existing.iter().any(|candidate| {
        candidate.id.trim() != skill.id.trim()
            && candidate.name.trim().to_lowercase() == name.to_lowercase()
    }) {
        return Err(ConfigStoreError::DuplicateSkillName);
    }
    if existing.len() >= MAX_CONFIGURED_SKILLS
        && !existing
            .iter()
            .any(|candidate| candidate.id.trim() == skill.id.trim())
    {
        return Err(ConfigStoreError::SkillCatalogLimit);
    }
    let mut total = 0usize;
    let mut replaced = false;
    for candidate in existing {
        let instructions = if candidate.id.trim() == id {
            replaced = true;
            skill.instructions.len()
        } else {
            candidate.instructions.len()
        };
        total = total
            .checked_add(instructions)
            .ok_or(ConfigStoreError::SkillInstructionsBudget)?;
    }
    if !replaced {
        total = total
            .checked_add(skill.instructions.len())
            .ok_or(ConfigStoreError::SkillInstructionsBudget)?;
    }
    if total > MAX_CONFIGURED_SKILL_INSTRUCTIONS_BYTES {
        return Err(ConfigStoreError::SkillInstructionsBudget);
    }
    Ok(())
}

/// Merging helpers mirror the TS `{ ...existing, ...incoming }` upserts.
fn merge_portable_provider(
    mut existing: PortableProvider,
    incoming: &PortableProvider,
) -> PortableProvider {
    existing.kind = incoming.kind;
    existing.label = incoming.label.clone();
    existing.base_url = incoming.base_url.clone();
    existing.default_model = incoming.default_model.clone();
    existing.needs_key = incoming.needs_key;
    existing.deployment = incoming.deployment;
    existing.is_preset = incoming.is_preset;
    existing.is_builtin = incoming.is_builtin;
    existing
}

fn merge_mcp_server(mut existing: McpServer, incoming: &McpServer) -> McpServer {
    existing.name = incoming.name.clone();
    existing.transport = incoming.transport;
    existing.command = incoming.command.clone();
    existing.args = incoming.args.clone();
    existing.env = incoming.env.clone();
    existing.url = incoming.url.clone();
    existing.headers = incoming.headers.clone();
    existing.oauth = incoming.oauth;
    existing.preset_id = incoming.preset_id.clone();
    existing.enabled = incoming.enabled;
    existing
}

fn merge_skill(mut existing: Skill, incoming: &Skill) -> Skill {
    existing.name = incoming.name.clone();
    existing.description = incoming.description.clone();
    existing.instructions = incoming.instructions.clone();
    existing.enabled = incoming.enabled;
    existing
}

fn merge_workspace(mut existing: Workspace, incoming: &Workspace) -> Workspace {
    existing.name = incoming.name.clone();
    existing.folder_path = incoming.folder_path.clone();
    existing.permission = incoming.permission;
    existing.managed_worktree = incoming.managed_worktree.clone();
    existing.updated_at = incoming.updated_at;
    existing
}

fn provider_alias_routes(aliases: &Map<String, Value>) -> Vec<(String, String, usize)> {
    resolved_provider_alias_routes(aliases)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct FakeSecrets {
        keys: StdMutex<SecretKeyMap>,
        bindings: StdMutex<HashMap<String, String>>,
        pending: StdMutex<HashSet<String>>,
    }

    impl SecretsPort for FakeSecrets {
        fn has_key(&self, provider_id: &str) -> Result<bool, ConfigStoreError> {
            Ok(self.keys.lock().unwrap().contains_key(provider_id))
        }

        fn get_provider_key(
            &self,
            provider_id: &str,
            binding: &str,
        ) -> Result<Option<String>, ConfigStoreError> {
            if self.pending.lock().unwrap().contains(provider_id)
                || self
                    .bindings
                    .lock()
                    .unwrap()
                    .get(provider_id)
                    .map(String::as_str)
                    != Some(binding)
            {
                return Ok(None);
            }
            Ok(self
                .keys
                .lock()
                .unwrap()
                .get(provider_id)
                .and_then(Value::as_str)
                .map(str::to_string))
        }

        fn delete_key(&self, provider_id: &str) -> Result<(), ConfigStoreError> {
            self.keys.lock().unwrap().remove(provider_id);
            Ok(())
        }

        fn migrate_keys(
            &self,
            migrate: &dyn Fn(&mut SecretKeyMap) -> bool,
        ) -> Result<(), ConfigStoreError> {
            let mut keys = self.keys.lock().unwrap();
            let _ = migrate(&mut keys);
            Ok(())
        }

        fn migrate_provider_keys_with_bindings(
            &self,
            _migrations: &[ProviderKeyMigration],
        ) -> Result<bool, ConfigStoreError> {
            Ok(true)
        }
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, ConfigStore) {
        let (portable, local, _, store) = fixture_with_secrets();
        (portable, local, store)
    }

    fn fixture_with_secrets() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<FakeSecrets>,
        ConfigStore,
    ) {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let stores = create_portable_config_stores(
            portable.path().to_path_buf(),
            Some(local.path().to_path_buf()),
            PortableConfigTestHooks::default(),
        );
        let secrets = Arc::new(FakeSecrets::default());
        let store = ConfigStore::new(stores, secrets.clone(), None);
        (portable, local, secrets, store)
    }

    #[test]
    fn remove_setting_publishes_absence_across_reopen_instead_of_null() {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let make = || {
            ConfigStore::new(
                create_portable_config_stores(
                    portable.path().to_path_buf(),
                    Some(local.path().to_path_buf()),
                    PortableConfigTestHooks::default(),
                ),
                Arc::new(FakeSecrets::default()),
                None,
            )
        };
        let store = make();
        let mut patch = Map::new();
        patch.insert(
            "pendingMcpCredentialCleanup".into(),
            serde_json::json!({"version": 1}),
        );
        store.set_settings(&patch, &|| true).unwrap();
        store
            .remove_setting("pendingMcpCredentialCleanup", &|| true)
            .unwrap();
        drop(store);
        assert!(!make()
            .get_settings()
            .unwrap()
            .contains_key("pendingMcpCredentialCleanup"));
    }

    fn intent_provider(id: &str, label: &str) -> StoredProvider {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "kind": "openai",
            "label": label,
            "baseUrl": "https://api.example.com/v1",
            "models": ["m1"],
            "needsKey": true,
            "deployment": "hosted"
        }))
        .unwrap()
    }

    #[test]
    fn seeding_creates_the_default_workspace_and_returns_providers() {
        let (_portable, _local, store) = fixture();
        assert!(store.ensure_seeded_wrapper());
        assert!(store.ensure_seeded().unwrap());
        let workspaces = store.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].id, "default");
        assert_eq!(workspaces[0].name, "Workspace");
    }

    #[test]
    fn provider_crud_round_trips_through_portable_intent_and_local_cache() {
        let (_portable, _local, store) = fixture();
        let saved = store
            .save_provider(&intent_provider("custom:test", "Test"), &|| true)
            .unwrap();
        assert_eq!(saved.id, "custom:test");
        assert!(!saved.has_key);
        assert_eq!(
            store.get_provider("custom:test").unwrap().unwrap().models,
            vec!["m1"]
        );

        let listed = store.list_providers().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "Test");

        store.remove_provider("custom:test", &|| true).unwrap();
        assert!(store.get_provider("custom:test").unwrap().is_none());
        assert!(store.list_providers().unwrap().is_empty());
    }

    #[test]
    fn provider_readiness_requires_an_exact_active_bound_credential() {
        let (_portable, _local, secrets, store) = fixture_with_secrets();
        let provider = intent_provider("custom:test", "Test");
        store.save_provider(&provider, &|| true).unwrap();
        secrets
            .keys
            .lock()
            .unwrap()
            .insert(provider.id.clone(), Value::String("raw-key".into()));
        assert!(!store.list_providers().unwrap()[0].has_key);

        secrets
            .bindings
            .lock()
            .unwrap()
            .insert(provider.id.clone(), "wrong-binding".into());
        assert!(!store.list_providers().unwrap()[0].has_key);

        secrets
            .bindings
            .lock()
            .unwrap()
            .insert(provider.id.clone(), provider_connection_snapshot(&provider));
        secrets.pending.lock().unwrap().insert(provider.id.clone());
        assert!(!store.list_providers().unwrap()[0].has_key);

        secrets.pending.lock().unwrap().remove(&provider.id);
        assert!(store.list_providers().unwrap()[0].has_key);
    }

    #[test]
    fn mcp_servers_and_skills_upsert_into_the_portable_file() {
        let (_portable, _local, store) = fixture();
        let server = McpServer {
            id: "gmail".into(),
            name: "Gmail".into(),
            transport: McpTransport::Http,
            command: None,
            args: None,
            env: None,
            url: Some("https://mcp.gmail.com/mcp".into()),
            headers: None,
            oauth: Some(true),
            preset_id: None,
            enabled: true,
        };
        let saved = store.save_mcp_server(&server, &|| true).unwrap();
        assert_eq!(saved.id, "gmail");
        assert_eq!(store.list_mcp_servers().unwrap().len(), 1);

        let skill = Skill {
            id: "skill-1".into(),
            name: "Skill".into(),
            description: "desc".into(),
            instructions: "instr".into(),
            enabled: true,
        };
        store.save_skill(&skill).unwrap();
        assert_eq!(store.list_skills().unwrap().len(), 1);
        store.remove_skill("skill-1").unwrap();
        assert!(store.list_skills().unwrap().is_empty());
    }

    #[test]
    fn configured_skill_validation_enforces_exact_limits_and_normalized_duplicates() {
        let valid = Skill {
            id: "skill-1".into(),
            name: "Résumé".into(),
            description: "d".repeat(MAX_SKILL_DESCRIPTION_LENGTH),
            instructions: "i".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
            enabled: true,
        };
        assert!(validate_skill_for_save(&valid, &[]).is_ok());

        let invalid_cases = [
            (
                Skill {
                    id: String::new(),
                    ..valid.clone()
                },
                ConfigStoreError::InvalidSkillId,
            ),
            (
                Skill {
                    id: "x".repeat(MAX_SKILL_ID_LENGTH + 1),
                    ..valid.clone()
                },
                ConfigStoreError::InvalidSkillId,
            ),
            (
                Skill {
                    name: "x".repeat(MAX_SKILL_NAME_LENGTH + 1),
                    ..valid.clone()
                },
                ConfigStoreError::InvalidSkillName,
            ),
            (
                Skill {
                    description: "x".repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1),
                    ..valid.clone()
                },
                ConfigStoreError::InvalidSkillDescription,
            ),
            (
                Skill {
                    instructions: " ".into(),
                    ..valid.clone()
                },
                ConfigStoreError::InvalidSkillInstructions,
            ),
            (
                Skill {
                    instructions: "x".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH + 1),
                    ..valid.clone()
                },
                ConfigStoreError::InvalidSkillInstructions,
            ),
        ];
        for (skill, expected) in invalid_cases {
            assert_eq!(
                validate_skill_for_save(&skill, &[])
                    .unwrap_err()
                    .to_string(),
                expected.to_string()
            );
        }

        let duplicate = Skill {
            id: "other".into(),
            name: "  RÉSUMÉ  ".into(),
            ..valid.clone()
        };
        assert!(matches!(
            validate_skill_for_save(&duplicate, &[valid]),
            Err(ConfigStoreError::DuplicateSkillName)
        ));

        let full = (0..MAX_CONFIGURED_SKILLS)
            .map(|index| Skill {
                id: format!("id-{index}"),
                name: format!("Name {index}"),
                description: String::new(),
                instructions: "i".into(),
                enabled: true,
            })
            .collect::<Vec<_>>();
        assert!(matches!(
            validate_skill_for_save(
                &Skill {
                    id: "overflow".into(),
                    name: "Overflow".into(),
                    description: String::new(),
                    instructions: "i".into(),
                    enabled: true,
                },
                &full
            ),
            Err(ConfigStoreError::SkillCatalogLimit)
        ));

        let unicode_name = Skill {
            id: "unicode".into(),
            name: "界".repeat(MAX_SKILL_NAME_LENGTH),
            description: String::new(),
            instructions: "i".into(),
            enabled: true,
        };
        assert!(validate_skill_for_save(&unicode_name, &[]).is_ok());
    }

    #[test]
    fn configured_skill_save_trims_identity_without_forking_an_edit() {
        let (_portable, _local, store) = fixture();
        let initial = Skill {
            id: "skill-1".into(),
            name: "Review".into(),
            description: String::new(),
            instructions: "First".into(),
            enabled: true,
        };
        store.save_skill(&initial).unwrap();
        let edited = Skill {
            id: "  skill-1  ".into(),
            name: "  Review  ".into(),
            instructions: "Second".into(),
            ..initial
        };
        let saved = store.save_skill(&edited).unwrap();
        assert_eq!(
            (saved.id.as_str(), saved.name.as_str()),
            ("skill-1", "Review")
        );
        assert_eq!(store.list_skills().unwrap().len(), 1);
    }

    #[test]
    fn configured_skill_aggregate_budget_checks_post_replacement_list() {
        let existing = (0..8)
            .map(|index| Skill {
                id: format!("skill-{index}"),
                name: format!("Skill {index}"),
                description: String::new(),
                instructions: "i".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
                enabled: true,
            })
            .collect::<Vec<_>>();
        assert!(configured_skill_instructions_fit(&existing));

        let overflow = Skill {
            id: "overflow".into(),
            name: "Overflow".into(),
            description: String::new(),
            instructions: "x".into(),
            enabled: true,
        };
        assert!(matches!(
            validate_skill_for_save(&overflow, &existing),
            Err(ConfigStoreError::SkillInstructionsBudget)
        ));

        let shrinking = Skill {
            instructions: "short".into(),
            ..existing[0].clone()
        };
        assert!(validate_skill_for_save(&shrinking, &existing).is_ok());

        let mut below_limit = existing.clone();
        below_limit[0].instructions = "short".into();
        let growing = Skill {
            instructions: "g".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
            ..below_limit[0].clone()
        };
        assert!(validate_skill_for_save(&growing, &below_limit).is_ok());
        let growing_over = Skill {
            instructions: "g".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
            ..Skill {
                id: "ninth".into(),
                name: "Ninth".into(),
                description: String::new(),
                instructions: String::new(),
                enabled: true,
            }
        };
        assert!(matches!(
            validate_skill_for_save(&growing_over, &below_limit),
            Err(ConfigStoreError::SkillInstructionsBudget)
        ));
    }

    #[test]
    fn configured_skill_validation_orders_fields_identity_catalog_then_aggregate() {
        let full_budget = (0..8)
            .map(|index| Skill {
                id: format!("id-{index}"),
                name: format!("Name {index}"),
                description: String::new(),
                instructions: "i".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
                enabled: true,
            })
            .collect::<Vec<_>>();
        let invalid_duplicate = Skill {
            id: "other".into(),
            name: "Name 0".into(),
            description: String::new(),
            instructions: "x".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH + 1),
            enabled: true,
        };
        assert!(matches!(
            validate_skill_for_save(&invalid_duplicate, &full_budget),
            Err(ConfigStoreError::InvalidSkillInstructions)
        ));

        let duplicate = Skill {
            instructions: "x".into(),
            ..invalid_duplicate
        };
        assert!(matches!(
            validate_skill_for_save(&duplicate, &full_budget),
            Err(ConfigStoreError::DuplicateSkillName)
        ));

        let catalog = (0..MAX_CONFIGURED_SKILLS)
            .map(|index| Skill {
                id: format!("catalog-{index}"),
                name: format!("Catalog {index}"),
                description: String::new(),
                instructions: "i".into(),
                enabled: true,
            })
            .collect::<Vec<_>>();
        assert!(matches!(
            validate_skill_for_save(
                &Skill {
                    id: "extra".into(),
                    name: "Extra".into(),
                    description: String::new(),
                    instructions: "x".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
                    enabled: true,
                },
                &catalog,
            ),
            Err(ConfigStoreError::SkillCatalogLimit)
        ));
    }

    #[test]
    fn legacy_over_budget_skill_lists_fail_closed_with_typed_error() {
        let (_portable, _local, store) = fixture();
        let mut config = store.stores.portable.load().unwrap();
        config.skills = (0..9)
            .map(|index| Skill {
                id: format!("legacy-{index}"),
                name: format!("Legacy {index}"),
                description: String::new(),
                instructions: "i".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
                enabled: true,
            })
            .collect();
        store.stores.portable.save(&config).unwrap();

        assert!(matches!(
            store.list_skills(),
            Err(ConfigStoreError::SkillInstructionsBudget)
        ));
        assert!(matches!(
            store.save_skill(&Skill {
                id: "new".into(),
                name: "New".into(),
                description: String::new(),
                instructions: "i".into(),
                enabled: true,
            }),
            Err(ConfigStoreError::SkillInstructionsBudget)
        ));
    }

    #[test]
    fn configured_skill_persistence_applies_budget_after_replacement() {
        let (_portable, _local, store) = fixture();
        store.list_skills().unwrap();
        let mut config = store.stores.portable.load().unwrap();
        config.skills = (0..8)
            .map(|index| Skill {
                id: format!("stored-{index}"),
                name: format!("Stored {index}"),
                description: String::new(),
                instructions: "i".repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
                enabled: true,
            })
            .collect();
        store.stores.portable.save(&config).unwrap();

        assert!(matches!(
            store.save_skill(&Skill {
                id: "overflow".into(),
                name: "Overflow".into(),
                description: String::new(),
                instructions: "x".into(),
                enabled: true,
            }),
            Err(ConfigStoreError::SkillInstructionsBudget)
        ));
        store
            .save_skill(&Skill {
                instructions: "short".into(),
                ..config.skills[0].clone()
            })
            .unwrap();
        store
            .save_skill(&Skill {
                id: "new".into(),
                name: "New".into(),
                description: String::new(),
                instructions: "x".into(),
                enabled: true,
            })
            .unwrap();
        assert!(matches!(
            store.save_skill(&config.skills[0]),
            Err(ConfigStoreError::SkillInstructionsBudget)
        ));
    }

    #[test]
    fn settings_merge_preserves_unknown_fields_and_resolves_aliases() {
        let (_portable, _local, store) = fixture();
        let mut patch = Map::new();
        patch.insert("lastModel".into(), Value::String("m1".into()));
        patch.insert("futureSetting".into(), Value::Bool(true));
        let saved = store.set_settings(&patch, &|| true).unwrap();
        assert_eq!(saved["lastModel"], "m1");
        assert_eq!(saved["futureSetting"], true);

        let mut patch = Map::new();
        patch.insert("lastProviderId".into(), Value::String("custom:new".into()));
        // A pending alias resolves to its terminal id at write time.
        let saved = store.set_settings(&patch, &|| true).unwrap();
        assert_eq!(saved["lastProviderId"], "custom:new");
    }

    #[test]
    fn reversed_appearance_publications_reload_the_newest_intent() {
        use std::sync::atomic::{AtomicU64, Ordering};

        let (portable, local, store) = fixture();
        let current = AtomicU64::new(2);

        let mut newest = Map::new();
        newest.insert(
            "appearance".into(),
            serde_json::json!({ "mode": "dark", "preset": "graphite" }),
        );
        store
            .set_settings(&newest, &|| current.load(Ordering::Acquire) == 2)
            .unwrap();

        let mut older = Map::new();
        older.insert(
            "appearance".into(),
            serde_json::json!({ "mode": "light", "preset": "blue" }),
        );
        assert!(store
            .set_settings(&older, &|| current.load(Ordering::Acquire) == 1)
            .is_err());

        let reloaded = ConfigStore::new(
            create_portable_config_stores(
                portable.path().to_path_buf(),
                Some(local.path().to_path_buf()),
                PortableConfigTestHooks::default(),
            ),
            Arc::new(FakeSecrets::default()),
            None,
        );
        let settings = reloaded.get_settings().unwrap();
        assert_eq!(settings["appearance"]["mode"], "dark");
        assert_eq!(settings["appearance"]["preset"], "graphite");
    }

    #[test]
    fn thinking_level_merges_are_bounded() {
        let (_portable, _local, store) = fixture();
        let saved = store
            .set_google_thinking_level("gemini-test", "high")
            .unwrap();
        assert_eq!(saved["googleThinkingByModel"]["gemini-test"], "high");
        let saved = store
            .set_anthropic_thinking_level("claude-x", "max")
            .unwrap();
        assert_eq!(saved["anthropicThinkingByModel"]["claude-x"], "max");
        assert!(store
            .set_google_thinking_level("gemini-test", "max")
            .is_err());
    }

    #[test]
    fn workspace_crud_reserves_the_assistant_id() {
        let (_portable, _local, store) = fixture();
        let workspace = Workspace {
            id: "w1".into(),
            name: "  Project  ".into(),
            folder_path: Some("/tmp/project".into()),
            permission: WorkspacePermission::Full,
            managed_worktree: None,
            created_at: 1,
            updated_at: 1,
        };
        let saved = store.save_workspace(&workspace).unwrap();
        assert_eq!(saved.name, "Project");
        assert_eq!(store.list_workspaces().unwrap().len(), 2);

        store.remove_workspace("w1").unwrap();
        assert_eq!(store.list_workspaces().unwrap().len(), 1);

        let assistant = Workspace {
            id: crate::aiden_core_assistant_workspace_id().to_string(),
            ..workspace
        };
        assert!(matches!(
            store.save_workspace(&assistant),
            Err(ConfigStoreError::ReservedWorkspaceId)
        ));
    }

    impl ConfigStore {
        fn ensure_seeded_wrapper(&self) -> bool {
            self.ensure_seeded().unwrap_or(false)
        }
    }
}
