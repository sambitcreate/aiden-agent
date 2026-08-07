//! Portable config core (port of `main/services/portable-config-core.ts` plus
//! the `normalizePortableConfig` half of `config-store-core.ts`).
//!
//! Aiden splits persisted configuration into a portable half and a
//! machine-local half, migrating existing installs into that layout once:
//!
//! - `<portable root>/config.json` — portable provider intent, aliases, MCP
//!   servers, skills. The user's to edit.
//! - `<local root>/settings.json` — UI preferences for this machine.
//! - `<local root>/config.json` — workspaces + seeding/migration markers.
//! - `<local root>/provider-model-cache.json` — regenerable discovery results.
//!
//! Secrets stay safeStorage/keychain-bound in the local root, so a portable
//! config carried to a second machine lists providers with `hasKey: false`.
//!
//! The portable file is hand-editable, so its `DataStore` is configured with
//! `preserveCorruptFile` + `rejectCorruptWrite` + `rejectExternalChanges`
//! (hard-link protected publication) + `reloadBeforeWrite`; a JSON typo must
//! cost the user a restart, never the file.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{DataStore, DataStoreError, DataStoreOptions};

// ===========================================================================
// Disk shapes (main/services/types.ts)
// ===========================================================================

pub const MAX_CONFIG_ID_LENGTH: usize = 256;
pub const MAX_PROVIDER_BASE_URL_LENGTH: usize = 4_096;
pub const MAX_PROVIDER_KEY_LENGTH: usize = 1_048_576;

pub const PORTABLE_CONFIG_FILENAME: &str = "config.json";
pub const SETTINGS_FILENAME: &str = "settings.json";
pub const LOCAL_CONFIG_FILENAME: &str = "config.json";
pub const PROVIDER_MODEL_CACHE_FILENAME: &str = "provider-model-cache.json";
pub const PORTABLE_README_FILENAME: &str = "README.md";
/// Where the pre-split config.json is parked once its contents are consumed.
pub const LEGACY_CONFIG_ARCHIVE_SUFFIX: &str = ".pre-aiden-dir";

pub const MAX_PROVIDER_ALIAS_COUNT: usize = 4_096;
pub const MAX_PROVIDER_ALIAS_DEPTH: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Openai,
    Anthropic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderDeployment {
    Local,
    Hosted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderModelType {
    Llm,
    Embedding,
}

/// Distinct Aiden thinking choices (renderer/shared/generation-thinking.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationThinkingLevel {
    Off,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl GenerationThinkingLevel {
    pub const ALL: &'static [GenerationThinkingLevel] = &[
        GenerationThinkingLevel::Off,
        GenerationThinkingLevel::Low,
        GenerationThinkingLevel::Medium,
        GenerationThinkingLevel::High,
        GenerationThinkingLevel::Xhigh,
        GenerationThinkingLevel::Max,
    ];
}

pub fn is_generation_thinking_level(value: &Value) -> bool {
    matches!(
        value,
        Value::String(level)
            if matches!(
                level.as_str(),
                "off" | "low" | "medium" | "high" | "xhigh" | "max"
            )
    )
}

fn thinking_level_as_str(level: GenerationThinkingLevel) -> &'static str {
    match level {
        GenerationThinkingLevel::Off => "off",
        GenerationThinkingLevel::Low => "low",
        GenerationThinkingLevel::Medium => "medium",
        GenerationThinkingLevel::High => "high",
        GenerationThinkingLevel::Xhigh => "xhigh",
        GenerationThinkingLevel::Max => "max",
    }
}

fn thinking_level_from_str(value: &str) -> Option<GenerationThinkingLevel> {
    GenerationThinkingLevel::ALL
        .iter()
        .copied()
        .find(|candidate| thinking_level_as_str(*candidate) == value)
}

/// Provider-reported metadata captured during explicit model discovery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelMetadata {
    #[serde(rename = "source")]
    pub source: ProviderModelMetadataSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<ProviderModelType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_levels: Option<Vec<GenerationThinkingLevel>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_can_disable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_count: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderModelMetadataSource {
    Lmstudio,
    Ollama,
    Provider,
}

/// A configured connection to an LLM backend (hosted or local).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProvider {
    pub id: String,
    pub kind: ProviderKind,
    pub label: String,
    /// Base URL including the version segment, e.g. https://api.openai.com/v1
    pub base_url: String,
    /// Suggested / cached model ids for the picker.
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<BTreeMap<String, ProviderModelMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Whether this provider requires an API key (local backends often don't).
    pub needs_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<ProviderDeployment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_preset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_builtin: Option<bool>,
    /// Unknown future top-level keys survive the split verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A provider minus the caches that model discovery refills.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableProvider {
    pub id: String,
    pub kind: ProviderKind,
    pub label: String,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub needs_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<ProviderDeployment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_preset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_builtin: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspacePermission {
    Full,
    Ask,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktree {
    /// Canonical repository root used to create the worktree.
    pub repository_path: String,
    /// Canonical checkout root; the workspace may point at a nested path.
    pub worktree_path: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_git_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_device: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_inode: Option<u64>,
    /// HEAD the branch pointed to when Aiden created it; used for safe cleanup.
    pub created_from_head: String,
}

/// A named working context: an optional folder + a permission level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    pub permission: WorkspacePermission,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_worktree: Option<ManagedWorktree>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// A user-configured MCP server connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    pub enabled: bool,
}

/// An Agent Skill — instructions exposed to the model as a callable tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub enabled: bool,
}

/// The hand-editable file. Every field here is machine-independent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableConfigShape {
    pub providers: Vec<PortableProvider>,
    /// Historic custom ID -> reserved custom ID. Never expose a Pi collision again.
    /// Values are JSON strings; a `Map` preserves the file's key order.
    pub provider_id_aliases: Map<String, Value>,
    pub mcp_servers: Vec<McpServer>,
    pub skills: Vec<Skill>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for PortableConfigShape {
    fn default() -> Self {
        Self::empty()
    }
}

impl PortableConfigShape {
    pub fn empty() -> Self {
        Self {
            providers: Vec::new(),
            provider_id_aliases: Map::new(),
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsShape {
    pub settings: Map<String, Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Machine-local config: workspaces + seeding/migration markers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfigShape {
    pub workspaces: Vec<Workspace>,
    /// True once the first-ever launch reset the provider list. Predates ~/.aiden.
    pub seeded: bool,
    /// Set once the ~/.aiden split has run. Deliberately not `seeded`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aiden_dir_migrated_at: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCacheEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<BTreeMap<String, ProviderModelMetadata>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCacheShape {
    pub by_provider: BTreeMap<String, ProviderModelCacheEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

pub fn empty_portable_config() -> PortableConfigShape {
    PortableConfigShape::empty()
}

pub fn merge_provider_model_cache_entries(
    fallback: Option<&ProviderModelCacheEntry>,
    preferred: Option<&ProviderModelCacheEntry>,
) -> ProviderModelCacheEntry {
    let mut merged = ProviderModelCacheEntry {
        models: None,
        model_metadata: None,
    };
    if let Some(fallback) = fallback {
        if fallback.models.is_some() {
            merged.models = fallback.models.clone();
        }
    }
    if let Some(preferred) = preferred {
        if preferred.models.is_some() {
            merged.models = preferred.models.clone();
        }
    }
    let mut metadata: BTreeMap<String, ProviderModelMetadata> = BTreeMap::new();
    if let Some(fallback) = fallback {
        if let Some(fallback_metadata) = &fallback.model_metadata {
            for (key, value) in fallback_metadata {
                metadata.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some(preferred) = preferred {
        if let Some(preferred_metadata) = &preferred.model_metadata {
            for (key, value) in preferred_metadata {
                metadata.insert(key.clone(), value.clone());
            }
        }
    }
    if !metadata.is_empty() {
        merged.model_metadata = Some(metadata);
    }
    merged
}

// ===========================================================================
// Value-level validators (portable-config-core.ts)
// ===========================================================================

pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn is_string_map(value: &Value) -> bool {
    match value {
        Value::Object(entries) => entries.values().all(Value::is_string),
        _ => false,
    }
}

/// View an alias record (`providerId -> string`) as a plain string map. The
/// JSON object is stored as `Map<String, Value>` to preserve key order.
fn aliases_view(record: &Map<String, Value>) -> std::collections::BTreeMap<String, String> {
    record
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect()
}

fn has_unique_ids<T>(values: &[T]) -> bool
where
    T: IdRef,
{
    let mut seen = HashSet::new();
    values.iter().all(|value| seen.insert(value.id()))
}

pub trait IdRef {
    fn id(&self) -> &str;
}

impl IdRef for McpServer {
    fn id(&self) -> &str {
        &self.id
    }
}

impl IdRef for Skill {
    fn id(&self) -> &str {
        &self.id
    }
}

impl IdRef for PortableProvider {
    fn id(&self) -> &str {
        &self.id
    }
}

impl IdRef for Workspace {
    fn id(&self) -> &str {
        &self.id
    }
}

fn provider_alias_resolutions(
    aliases: &std::collections::BTreeMap<String, String>,
) -> Option<BTreeMap<String, (String, usize)>> {
    let mut resolved: BTreeMap<String, (String, usize)> = BTreeMap::new();
    let mut resolving: HashSet<String> = HashSet::new();

    fn visit(
        aliases: &std::collections::BTreeMap<String, String>,
        source: &str,
        depth: usize,
        resolved: &mut BTreeMap<String, (String, usize)>,
        resolving: &mut HashSet<String>,
    ) -> Option<(String, usize)> {
        if let Some(cached) = resolved.get(source) {
            return Some(cached.clone());
        }
        if depth > MAX_PROVIDER_ALIAS_DEPTH || resolving.contains(source) {
            return None;
        }
        let target = aliases.get(source);
        let target = match target {
            Some(target) => target.clone(),
            None => return Some((source.to_string(), 0)),
        };
        resolving.insert(source.to_string());
        let downstream = visit(aliases, &target, depth + 1, resolved, resolving);
        resolving.remove(source);
        let downstream = downstream?;
        if downstream.1 + 1 > MAX_PROVIDER_ALIAS_DEPTH {
            return None;
        }
        let result = (downstream.0, downstream.1 + 1);
        resolved.insert(source.to_string(), result.clone());
        Some(result)
    }

    let keys: Vec<String> = aliases.keys().cloned().collect();
    for source in keys {
        visit(aliases, &source, 0, &mut resolved, &mut resolving)?;
    }
    Some(resolved)
}

pub fn is_provider_alias_map(value: &Value) -> bool {
    let Value::Object(aliases) = value else {
        return false;
    };
    if !aliases.values().all(Value::is_string) {
        return false;
    }
    let aliases: std::collections::BTreeMap<String, String> = aliases_view(aliases);
    if aliases.len() > MAX_PROVIDER_ALIAS_COUNT {
        return false;
    }
    for (source, target) in &aliases {
        if source.trim().is_empty()
            || target.trim().is_empty()
            || source.len() > MAX_CONFIG_ID_LENGTH
            || target.len() > MAX_CONFIG_ID_LENGTH
            || source == target
        {
            return false;
        }
    }
    provider_alias_resolutions(&aliases).is_some()
}

/// Resolve an accepted alias chain without consulting inherited object keys.
pub fn resolve_provider_alias(aliases: &Map<String, Value>, provider_id: &str) -> Option<String> {
    let aliases = aliases_view(aliases);
    let mut cursor = provider_id.to_string();
    let mut visited: HashSet<String> = HashSet::new();
    let mut depth = 0;
    while let Some(target) = aliases.get(&cursor) {
        let target = target.clone();
        if visited.contains(&cursor) || depth >= MAX_PROVIDER_ALIAS_DEPTH {
            return None;
        }
        visited.insert(cursor);
        cursor = target;
        depth += 1;
    }
    if cursor == provider_id {
        None
    } else {
        Some(cursor)
    }
}

/// All alias routes, ordered by source (TS `resolvedProviderAliasRoutes`).
pub fn resolved_provider_alias_routes(
    aliases: &Map<String, Value>,
) -> Vec<(String, String, usize)> {
    let aliases = aliases_view(aliases);
    let Some(resolutions) = provider_alias_resolutions(&aliases) else {
        return Vec::new();
    };
    resolutions
        .into_iter()
        .map(|(source, (terminal, depth))| (source, terminal, depth))
        .collect()
}

pub fn provider_alias_sources_are_inactive(
    aliases: &Map<String, Value>,
    providers: &[impl IdRef],
) -> bool {
    let active: HashSet<&str> = providers.iter().map(IdRef::id).collect();
    aliases
        .keys()
        .all(|source| !active.contains(source.as_str()))
}

fn is_managed_worktree(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let str_abs = |key: &str| -> bool {
        matches!(record.get(key), Some(Value::String(path)) if Path::new(path).is_absolute())
    };
    str_abs("repositoryPath")
        && str_abs("worktreePath")
        && record.get("branch").map(Value::is_string).unwrap_or(false)
        && record
            .get("createdFromHead")
            .map(Value::is_string)
            .unwrap_or(false)
        && match record.get("worktreeGitDir") {
            None | Some(Value::Null) => true,
            Some(Value::String(path)) => Path::new(path).is_absolute(),
            Some(_) => false,
        }
        && match record.get("ownershipToken") {
            None | Some(Value::String(_)) => true,
            Some(_) => false,
        }
        && match record.get("worktreeDevice") {
            Some(Value::Number(number)) => number.as_u64().is_some(),
            _ => true,
        }
        && match record.get("worktreeInode") {
            Some(Value::Number(number)) => number.as_u64().is_some(),
            _ => true,
        }
}

pub fn is_workspace(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let id = record.get("id").and_then(Value::as_str);
    let name = record.get("name").and_then(Value::as_str);
    let permission = record.get("permission").and_then(Value::as_str);
    let created_at = record.get("createdAt").and_then(Value::as_u64);
    let updated_at = record.get("updatedAt").and_then(Value::as_u64);
    id.map(|id| !id.trim().is_empty()).unwrap_or(false)
        && name.is_some()
        && matches!(permission, Some("full" | "ask" | "none"))
        && created_at.is_some()
        && updated_at.is_some()
        && match record.get("folderPath") {
            None | Some(Value::Null) => true,
            Some(Value::String(path)) => Path::new(path).is_absolute(),
            Some(_) => false,
        }
        && match record.get("managedWorktree") {
            None | Some(Value::Null) => true,
            Some(value) => is_managed_worktree(value),
        }
}

pub fn is_mcp_server(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let id = record.get("id").and_then(Value::as_str);
    let name = record.get("name").and_then(Value::as_str);
    let transport = record.get("transport").and_then(Value::as_str);
    let enabled = record.get("enabled").and_then(Value::as_bool);
    id.map(|id| !id.trim().is_empty() && id.len() <= MAX_CONFIG_ID_LENGTH)
        .unwrap_or(false)
        && name.is_some()
        && matches!(transport, Some("stdio" | "http" | "sse"))
        && enabled.is_some()
        && match record.get("command") {
            None | Some(Value::String(_)) => true,
            Some(_) => false,
        }
        && match record.get("args") {
            Some(Value::Array(args)) => args.iter().all(Value::is_string),
            _ => true,
        }
        && match record.get("env") {
            Some(value) => is_string_map(value),
            _ => true,
        }
        && match record.get("url") {
            None | Some(Value::String(_)) => true,
            Some(_) => false,
        }
        && match record.get("headers") {
            Some(value) => is_string_map(value),
            _ => true,
        }
        && match record.get("oauth") {
            None | Some(Value::Bool(_)) => true,
            Some(_) => false,
        }
        && match record.get("presetId") {
            None | Some(Value::String(_)) => true,
            Some(_) => false,
        }
}

pub fn is_skill(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    record
        .get("id")
        .and_then(Value::as_str)
        .map(|id| !id.trim().is_empty())
        .unwrap_or(false)
        && record.get("name").map(Value::is_string).unwrap_or(false)
        && record
            .get("description")
            .map(Value::is_string)
            .unwrap_or(false)
        && record
            .get("instructions")
            .map(Value::is_string)
            .unwrap_or(false)
        && record.get("enabled").and_then(Value::as_bool).is_some()
}

pub fn is_mcp_server_list(value: &Value) -> bool {
    match value {
        Value::Array(servers) => {
            servers.iter().all(is_mcp_server) && has_unique_ids(&to_servers(servers))
        }
        _ => false,
    }
}

fn to_servers(values: &[Value]) -> Vec<McpServer> {
    values
        .iter()
        .filter_map(|value| serde_json::from_value(value.clone()).ok())
        .collect()
}

pub fn is_skill_list(value: &Value) -> bool {
    match value {
        Value::Array(skills) => skills.iter().all(is_skill) && has_unique_ids(&to_skills(skills)),
        _ => false,
    }
}

fn to_skills(values: &[Value]) -> Vec<Skill> {
    values
        .iter()
        .filter_map(|value| serde_json::from_value(value.clone()).ok())
        .collect()
}

fn is_provider_base_url(value: &Value) -> bool {
    let Some(url) = value.as_str() else {
        return false;
    };
    if url.trim().is_empty() || url.len() > MAX_PROVIDER_BASE_URL_LENGTH {
        return false;
    }
    parse_http_url(url)
        .map(|parsed| {
            parsed.hostname.is_some()
                && parsed.username.is_none()
                && parsed.password.is_none()
                && parsed.search.is_none()
                && parsed.hash.is_none()
        })
        .unwrap_or(false)
}

fn has_sensitive_provider_url(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let Some(Value::String(base_url)) = record.get("baseUrl") else {
        return false;
    };
    parse_http_url(base_url)
        .map(|parsed| {
            parsed.hostname.is_some()
                && (parsed.username.is_some()
                    || parsed.password.is_some()
                    || parsed.search.is_some()
                    || parsed.hash.is_some())
        })
        .unwrap_or(false)
}

/// Minimal http(s) URL split matching the properties `new URL()` exposes that
/// the validators inspect (scheme, hostname, userinfo, search, hash).
struct ParsedHttpUrl {
    hostname: Option<String>,
    username: Option<String>,
    password: Option<String>,
    search: Option<String>,
    hash: Option<String>,
}

fn parse_http_url(url: &str) -> Option<ParsedHttpUrl> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let (authority, fragment) = match rest.split_once('#') {
        Some((authority, fragment)) => (authority, Some(fragment.to_string())),
        None => (rest, None),
    };
    let (authority, search) = match authority.split_once('?') {
        Some((authority, search)) => (authority, Some(search.to_string())),
        None => (authority, None),
    };
    let (authority, _path) = match authority.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => (authority, ""),
    };
    let (userinfo, hostport) = match authority.split_once('@') {
        Some((userinfo, hostport)) => (Some(userinfo.to_string()), hostport),
        None => (None, authority),
    };
    let (username, password) = match userinfo {
        Some(userinfo) => match userinfo.split_once(':') {
            Some((username, password)) => (Some(username.to_string()), Some(password.to_string())),
            None => (Some(userinfo), None),
        },
        None => (None, None),
    };
    let hostname = if hostport.is_empty() {
        None
    } else {
        Some(hostport.to_string())
    };
    Some(ParsedHttpUrl {
        hostname,
        username,
        password,
        search,
        hash: fragment,
    })
}

/// Runtime guard for the provider intent that crosses the portable-file boundary.
pub fn is_portable_provider(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let id = record.get("id").and_then(Value::as_str);
    let kind = record.get("kind").and_then(Value::as_str);
    let label = record.get("label").and_then(Value::as_str);
    let base_url = record.get("baseUrl");
    let needs_key = record.get("needsKey").and_then(Value::as_bool);
    id.map(|id| !id.trim().is_empty() && id.len() <= MAX_CONFIG_ID_LENGTH)
        .unwrap_or(false)
        && matches!(kind, Some("openai" | "anthropic"))
        && label.map(|label| !label.trim().is_empty()).unwrap_or(false)
        && base_url.map(is_provider_base_url).unwrap_or(false)
        && needs_key.is_some()
        && match record.get("defaultModel") {
            None | Some(Value::String(_)) => true,
            Some(_) => false,
        }
        && !matches!(
            record.get("deployment"),
            Some(Value::String(deployment)) if !matches!(deployment.as_str(), "local" | "hosted")
        )
        && match record.get("isPreset") {
            None | Some(Value::Bool(_)) => true,
            Some(_) => false,
        }
        && match record.get("isBuiltin") {
            None | Some(Value::Bool(_)) => true,
            Some(_) => false,
        }
}

pub fn is_portable_provider_list(value: &Value) -> bool {
    match value {
        Value::Array(providers) => {
            providers.iter().all(is_portable_provider) && has_unique_ids(&to_providers(providers))
        }
        _ => false,
    }
}

fn to_providers(values: &[Value]) -> Vec<PortableProvider> {
    values
        .iter()
        .filter_map(|value| serde_json::from_value(value.clone()).ok())
        .collect()
}

fn is_provider_model_metadata(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let source = record.get("source").and_then(Value::as_str);
    let context_length = record.get("contextLength");
    matches!(source, Some("lmstudio" | "ollama" | "provider"))
        && match record.get("name") {
            None | Some(Value::String(_)) => true,
            Some(_) => false,
        }
        && !matches!(
            record.get("type"),
            Some(Value::String(r#type)) if !matches!(r#type.as_str(), "llm" | "embedding")
        )
        && match record.get("vision") {
            None | Some(Value::Bool(_)) => true,
            Some(_) => false,
        }
        && match record.get("toolCall") {
            None | Some(Value::Bool(_)) => true,
            Some(_) => false,
        }
        && match record.get("reasoning") {
            None | Some(Value::Bool(_)) => true,
            Some(_) => false,
        }
        && match record.get("thinkingLevels") {
            Some(Value::Array(levels)) => levels.iter().all(is_generation_thinking_level),
            _ => true,
        }
        && match record.get("thinkingCanDisable") {
            None | Some(Value::Bool(_)) => true,
            Some(_) => false,
        }
        && match context_length {
            Some(Value::Number(number)) => number.as_u64().is_some(),
            _ => true,
        }
        && match record.get("parameterCount") {
            None | Some(Value::String(_)) => true,
            Some(_) => false,
        }
        && match record.get("format") {
            None | Some(Value::String(_)) => true,
            Some(_) => false,
        }
}

fn normalize_provider_model_metadata_map(
    value: &Value,
) -> Option<BTreeMap<String, ProviderModelMetadata>> {
    let Value::Object(entries) = value else {
        return None;
    };
    let mut safe = BTreeMap::new();
    for (key, entry) in entries {
        if is_provider_model_metadata(entry) {
            if let Ok(parsed) = serde_json::from_value::<ProviderModelMetadata>(entry.clone()) {
                safe.insert(key.clone(), parsed);
            }
        }
    }
    if entries.is_empty() {
        Some(safe)
    } else if safe.is_empty() {
        None
    } else {
        Some(safe)
    }
}

fn normalize_model_ids(value: Option<&Value>) -> Option<Vec<String>> {
    let Value::Array(models) = value? else {
        return None;
    };
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for model in models {
        if let Some(id) = model.as_str() {
            if !id.trim().is_empty() && seen.insert(id.to_string()) {
                result.push(id.to_string());
            }
        }
    }
    Some(result)
}

fn normalize_stored_provider(value: &Value) -> Option<StoredProvider> {
    if !is_portable_provider(value) {
        return None;
    }
    let mut raw = value.clone();
    let models = normalize_model_ids(raw.get("models")).unwrap_or_default();
    let model_metadata = raw
        .get("modelMetadata")
        .and_then(normalize_provider_model_metadata_map);
    if let Value::Object(record) = &mut raw {
        record.remove("models");
        record.remove("modelMetadata");
    }
    let mut intent: PortableProvider = serde_json::from_value(raw).ok()?;
    if model_metadata.is_some() {
        intent.extra.remove("modelMetadata");
    }
    let _ = intent.extra.remove("models");
    Some(StoredProvider {
        id: intent.id.clone(),
        kind: intent.kind,
        label: intent.label.clone(),
        base_url: intent.base_url.clone(),
        models,
        model_metadata,
        default_model: intent.default_model.clone(),
        needs_key: intent.needs_key,
        deployment: intent.deployment,
        is_preset: intent.is_preset,
        is_builtin: intent.is_builtin,
        extra: intent.extra.clone(),
    })
}

fn normalize_legacy_mcp_servers(value: &Value) -> Vec<McpServer> {
    let Value::Array(servers) = value else {
        return Vec::new();
    };
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for server in servers {
        if is_mcp_server(server) {
            if let Some(id) = server.get("id").and_then(Value::as_str) {
                *counts.entry(id.to_string()).or_default() += 1;
            }
        }
    }
    servers
        .iter()
        .filter(|server| {
            is_mcp_server(server)
                && server
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| counts.get(id).copied() == Some(1))
                    .unwrap_or(false)
        })
        .filter_map(|server| serde_json::from_value(server.clone()).ok())
        .collect()
}

fn normalize_legacy_skills(value: &Value) -> Vec<Skill> {
    let Value::Array(skills) = value else {
        return Vec::new();
    };
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for skill in skills {
        if is_skill(skill) {
            if let Some(id) = skill.get("id").and_then(Value::as_str) {
                *counts.entry(id.to_string()).or_default() += 1;
            }
        }
    }
    skills
        .iter()
        .filter(|skill| {
            is_skill(skill)
                && skill
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| counts.get(id).copied() == Some(1))
                    .unwrap_or(false)
        })
        .filter_map(|skill| serde_json::from_value(skill.clone()).ok())
        .collect()
}

// ===========================================================================
// normalizePortableConfig (config-store-core.ts)
// ===========================================================================

/// Tolerantly project a raw portable document into the typed shape, reporting
/// whether any present field was unsafe (and therefore not persistable).
pub fn normalize_portable_config(value: &Value) -> (PortableConfigShape, bool) {
    let Some(root) = value.as_object() else {
        return (PortableConfigShape::empty(), true);
    };
    let mut unsafe_config = false;
    let has = |key: &str| root.contains_key(key);

    let mut providers: Vec<PortableProvider> = Vec::new();
    if !has("providers") {
        providers = Vec::new();
    } else if let Some(raw) = root.get("providers") {
        if is_portable_provider_list(raw) {
            providers = to_providers(raw.as_array().unwrap());
        } else {
            unsafe_config = true;
        }
    }

    let mut aliases: Map<String, Value> = Map::new();
    if !has("providerIdAliases") {
        aliases = Map::new();
    } else if let Some(raw) = root.get("providerIdAliases") {
        if is_provider_alias_map(raw) {
            aliases = raw
                .as_object()
                .map(|entries| {
                    entries
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect()
                })
                .unwrap_or_default();
        } else {
            unsafe_config = true;
        }
    }
    if !provider_alias_sources_are_inactive(&aliases, &providers) {
        unsafe_config = true;
        aliases = Map::new();
    }

    let mcp_servers = if !has("mcpServers") {
        Vec::new()
    } else if let Some(raw) = root.get("mcpServers") {
        if is_mcp_server_list(raw) {
            to_servers(raw.as_array().unwrap())
        } else {
            unsafe_config = true;
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let skills = if !has("skills") {
        Vec::new()
    } else if let Some(raw) = root.get("skills") {
        if is_skill_list(raw) {
            to_skills(raw.as_array().unwrap())
        } else {
            unsafe_config = true;
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let mut extra = root.clone();
    extra.remove("providers");
    extra.remove("providerIdAliases");
    extra.remove("mcpServers");
    extra.remove("skills");

    (
        PortableConfigShape {
            providers,
            provider_id_aliases: aliases,
            mcp_servers,
            skills,
            extra,
        },
        unsafe_config,
    )
}

// ===========================================================================
// Settings normalization (portable-config-core.ts + assistant-parse.ts)
// ===========================================================================

const DEFAULT_ASSISTANT_HOTKEY: &str = "Command+Alt+A";

/// Fill defaults and fail closed around malformed device-local persisted data
/// (`assistantConfigFrom` in main/handlers/assistant-parse.ts).
pub fn assistant_config_from(settings: &Map<String, Value>) -> Map<String, Value> {
    let input = settings.get("assistant").and_then(Value::as_object);
    let get = |key: &str| input.and_then(|record| record.get(key));

    fn stored_boolean(value: Option<&Value>, fallback: bool) -> bool {
        match value {
            Some(Value::Bool(value)) => *value,
            _ => fallback,
        }
    }

    fn stored_integer(value: Option<&Value>, fallback: u64, min: u64, max: u64) -> u64 {
        match value.and_then(Value::as_u64) {
            Some(value) => value.clamp(min, max),
            None => fallback,
        }
    }

    fn stored_time(value: Option<&Value>, fallback: &str) -> String {
        match value.and_then(Value::as_str) {
            Some(value) if is_hhmm(value) => value.to_string(),
            _ => fallback.to_string(),
        }
    }

    fn stored_pin(value: Option<&Value>) -> Option<String> {
        value
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn stored_permission(value: Option<&Value>) -> String {
        match value.and_then(Value::as_str) {
            Some("full" | "ask" | "none") => value.unwrap().as_str().unwrap().to_string(),
            _ => "ask".to_string(),
        }
    }

    let mut config = Map::new();
    config.insert(
        "enabled".into(),
        Value::Bool(stored_boolean(get("enabled"), false)),
    );
    config.insert(
        "hotkeyEnabled".into(),
        Value::Bool(stored_boolean(get("hotkeyEnabled"), true)),
    );
    let accelerator = match get("hotkeyAccelerator").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() && value.len() <= 128 => value.trim().to_string(),
        _ => DEFAULT_ASSISTANT_HOTKEY.to_string(),
    };
    config.insert("hotkeyAccelerator".into(), Value::String(accelerator));
    config.insert(
        "providerId".into(),
        stored_pin(get("providerId"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    config.insert(
        "model".into(),
        stored_pin(get("model"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    config.insert(
        "watchUncommitted".into(),
        Value::Bool(stored_boolean(get("watchUncommitted"), true)),
    );
    config.insert(
        "watchUntouchedProjects".into(),
        Value::Bool(stored_boolean(get("watchUntouchedProjects"), true)),
    );
    config.insert(
        "watchConfigChanges".into(),
        Value::Bool(stored_boolean(get("watchConfigChanges"), true)),
    );
    config.insert(
        "pollIntervalMinutes".into(),
        Value::Number(stored_integer(get("pollIntervalMinutes"), 30, 5, 1440).into()),
    );
    config.insert(
        "untouchedThresholdDays".into(),
        Value::Number(stored_integer(get("untouchedThresholdDays"), 14, 1, 365).into()),
    );
    config.insert(
        "quietHoursEnabled".into(),
        Value::Bool(stored_boolean(get("quietHoursEnabled"), false)),
    );
    config.insert(
        "quietHoursStart".into(),
        Value::String(stored_time(get("quietHoursStart"), "22:00")),
    );
    config.insert(
        "quietHoursEnd".into(),
        Value::String(stored_time(get("quietHoursEnd"), "08:00")),
    );
    config.insert(
        "maxNudgesPerDay".into(),
        Value::Number(stored_integer(get("maxNudgesPerDay"), 5, 1, 50).into()),
    );
    config.insert(
        "urgencyThreshold".into(),
        Value::Number(stored_integer(get("urgencyThreshold"), 7, 0, 10).into()),
    );
    config.insert(
        "settingsPermission".into(),
        Value::String(stored_permission(get("settingsPermission"))),
    );
    config
}

fn is_hhmm(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[2] == b':'
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && (0..=23).contains(&((bytes[0] - b'0') * 10 + (bytes[1] - b'0')))
        && (0..=59).contains(&((bytes[3] - b'0') * 10 + (bytes[4] - b'0')))
}

/// Normalize a settings document for persistence: drop known keys whose value
/// has the wrong type, retain every raw unknown property, and tolerate nested
/// versioned documents (assistant, appearance, keybindings, thinking maps).
pub fn normalize_settings_shape(value: &Value) -> SettingsShape {
    let root = match value.as_object() {
        Some(root) => root.clone(),
        None => Map::new(),
    };
    let mut extra = root.clone();
    let settings_raw = extra.remove("settings");
    let Some(mut normalized) = settings_raw.and_then(|settings| match settings {
        Value::Object(settings) => Some(settings),
        _ => None,
    }) else {
        return SettingsShape {
            settings: Map::new(),
            extra,
        };
    };

    for key in [
        "lastProviderId",
        "lastModel",
        "voiceModel",
        "localVoiceModel",
        "shortcutAccelerator",
        "dictationAccelerator",
        "scheduledDefaultTimezone",
        "profileName",
    ] {
        if let Some(value) = normalized.get(key) {
            if !value.is_string() {
                normalized.remove(key);
            }
        }
    }
    for key in [
        "exaEnabled",
        "shortcutEnabled",
        "dictationEnabled",
        "computerUseEnabled",
        "scheduledTasksEnabled",
        "scheduledDefaultMcpEnabled",
        "scheduledDefaultNotify",
    ] {
        if let Some(value) = normalized.get(key) {
            if !value.is_boolean() {
                normalized.remove(key);
            }
        }
    }
    for key in [
        "voiceProvider",
        "chatTitleProviderId",
        "scheduledDefaultMode",
        "scheduledDefaultPermission",
    ] {
        if let Some(value) = normalized.get(key) {
            if !value.is_string() {
                normalized.remove(key);
            }
        }
    }
    // Assistant, appearance, and keybindings are versioned/tolerant nested
    // documents; the persistence normalizer retains every raw property.
    if let Some(value) = normalized.get("assistant") {
        if !value.is_object() {
            normalized.remove("assistant");
        }
    }
    for key in [
        "googleThinkingByModel",
        "codexThinkingByModel",
        "anthropicThinkingByModel",
    ] {
        if let Some(value) = normalized.get(key) {
            if !value.is_object() {
                normalized.remove(key);
            }
        }
    }
    SettingsShape {
        settings: normalized,
        extra,
    }
}

/// Safe projection for consumers; persistence retains unknown nested future data.
pub fn runtime_settings_from(settings: &Map<String, Value>) -> Map<String, Value> {
    let mut runtime = settings.clone();

    let retain_known_value = |runtime: &mut Map<String, Value>, key: &str, allowed: &[&str]| {
        if let Some(value) = runtime.get(key) {
            if !matches!(value, Value::String(level) if allowed.contains(&level.as_str())) {
                runtime.remove(key);
            }
        }
    };
    retain_known_value(
        &mut runtime,
        "voiceProvider",
        &["openai", "gemini", "local"],
    );
    retain_known_value(
        &mut runtime,
        "chatTitleProviderId",
        &["automatic", "apple-foundation-models", "chat-model"],
    );
    retain_known_value(&mut runtime, "scheduledDefaultMode", &["llm", "script"]);
    retain_known_value(
        &mut runtime,
        "scheduledDefaultPermission",
        &["read-only", "full"],
    );

    if settings.contains_key("assistant") {
        // `runtimeAssistantSettings`: keep only entries that are defined.
        let projected = assistant_config_from(settings);
        let mut kept = Map::new();
        for (key, value) in projected {
            if !value.is_null() {
                kept.insert(key, value);
            }
        }
        if !kept.is_empty() {
            runtime.insert("assistant".into(), Value::Object(kept));
        } else {
            runtime.remove("assistant");
        }
    }

    let project_thinking_map = |runtime: &mut Map<String, Value>, key: &str, levels: &[&str]| {
        let Some(Value::Object(entries)) = settings.get(key) else {
            return;
        };
        let mut safe = Map::new();
        for (model_id, level) in entries.iter().take(256) {
            let model_id_ok = !model_id.is_empty() && model_id.len() <= 256;
            let level_ok =
                matches!(level, Value::String(level) if levels.contains(&level.as_str()));
            if model_id_ok && level_ok {
                safe.insert(model_id.clone(), level.clone());
            }
        }
        if safe.is_empty() {
            runtime.remove(key);
        } else {
            runtime.insert(key.into(), Value::Object(safe));
        }
    };
    project_thinking_map(
        &mut runtime,
        "googleThinkingByModel",
        &["off", "low", "medium", "high"],
    );
    project_thinking_map(
        &mut runtime,
        "codexThinkingByModel",
        &["low", "medium", "high", "xhigh", "max"],
    );
    project_thinking_map(
        &mut runtime,
        "anthropicThinkingByModel",
        &["off", "low", "medium", "high", "xhigh", "max"],
    );
    runtime
}

// ===========================================================================
// Local config + model cache normalization
// ===========================================================================

fn normalize_local_config_shape(value: &Value) -> LocalConfigShape {
    let root = match value.as_object() {
        Some(root) => root.clone(),
        None => Map::new(),
    };
    let mut extra = root.clone();
    let workspaces_raw = extra.remove("workspaces");
    let seeded_raw = extra.remove("seeded");
    let aiden_dir_migrated_at = extra.remove("aidenDirMigratedAt");

    let valid: Vec<Workspace> = match workspaces_raw {
        Some(Value::Array(workspaces)) => workspaces
            .iter()
            .filter(|workspace| is_workspace(workspace))
            .filter_map(|workspace| serde_json::from_value(workspace.clone()).ok())
            .collect(),
        _ => Vec::new(),
    };
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for workspace in &valid {
        *counts.entry(workspace.id.clone()).or_default() += 1;
    }
    let workspaces = valid
        .into_iter()
        .filter(|workspace| counts.get(&workspace.id).copied() == Some(1))
        .collect();
    let seeded = matches!(seeded_raw, Some(Value::Bool(true)));
    let aiden_dir_migrated_at = match aiden_dir_migrated_at {
        Some(Value::Number(number)) => number.as_u64(),
        _ => None,
    };
    LocalConfigShape {
        workspaces,
        seeded,
        aiden_dir_migrated_at,
        extra,
    }
}

fn is_local_config_shape_safe(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return true;
    };
    let Some(workspaces) = record.get("workspaces") else {
        return true;
    };
    let Value::Array(workspaces) = workspaces else {
        return false;
    };
    let valid = workspaces
        .iter()
        .filter(|workspace| is_workspace(workspace))
        .count();
    valid == workspaces.len() && has_unique_ids(&to_workspaces(workspaces))
}

fn to_workspaces(values: &[Value]) -> Vec<Workspace> {
    values
        .iter()
        .filter_map(|value| serde_json::from_value(value.clone()).ok())
        .collect()
}

fn normalize_provider_model_cache_shape(value: &Value) -> ProviderModelCacheShape {
    let root = match value.as_object() {
        Some(root) => root.clone(),
        None => Map::new(),
    };
    let mut extra = root.clone();
    let by_provider_raw = extra.remove("byProvider");
    let mut by_provider = BTreeMap::new();
    if let Some(Value::Object(entries)) = by_provider_raw {
        for (provider_id, raw_entry) in entries {
            let Some(entry) = raw_entry.as_object() else {
                continue;
            };
            let mut safe_entry = ProviderModelCacheEntry {
                models: None,
                model_metadata: None,
            };
            let models = normalize_model_ids(entry.get("models"));
            let model_metadata = entry
                .get("modelMetadata")
                .and_then(normalize_provider_model_metadata_map);
            if let Some(models) = models {
                safe_entry.models = Some(models);
            }
            if let Some(model_metadata) = model_metadata {
                safe_entry.model_metadata = Some(model_metadata);
            }
            if safe_entry.models.is_some() || safe_entry.model_metadata.is_some() {
                by_provider.insert(provider_id, safe_entry);
            }
        }
    }
    ProviderModelCacheShape { by_provider, extra }
}

// ===========================================================================
// Provider intent / cache split
// ===========================================================================

/// Separate a provider into portable intent and regenerable cache.
pub fn split_stored_provider(
    provider: &StoredProvider,
) -> (PortableProvider, ProviderModelCacheEntry) {
    let mut extra = provider.extra.clone();
    let _ = extra.remove("models");
    let _ = extra.remove("modelMetadata");
    let intent = PortableProvider {
        id: provider.id.clone(),
        kind: provider.kind,
        label: provider.label.clone(),
        base_url: provider.base_url.clone(),
        default_model: provider.default_model.clone(),
        needs_key: provider.needs_key,
        deployment: provider.deployment,
        is_preset: provider.is_preset,
        is_builtin: provider.is_builtin,
        extra,
    };
    let cache = ProviderModelCacheEntry {
        models: Some(provider.models.clone()),
        model_metadata: provider.model_metadata.clone(),
    };
    (intent, cache)
}

/// Recombine portable intent with this machine's discovery cache.
pub fn compose_stored_provider(
    intent: &PortableProvider,
    cache: Option<&ProviderModelCacheEntry>,
) -> StoredProvider {
    let mut extra = intent.extra.clone();
    extra.remove("models");
    extra.remove("modelMetadata");
    StoredProvider {
        id: intent.id.clone(),
        kind: intent.kind,
        label: intent.label.clone(),
        base_url: intent.base_url.clone(),
        models: cache
            .and_then(|cache| cache.models.clone())
            .unwrap_or_default(),
        model_metadata: cache.and_then(|cache| cache.model_metadata.clone()),
        default_model: intent.default_model.clone(),
        needs_key: intent.needs_key,
        deployment: intent.deployment,
        is_preset: intent.is_preset,
        is_builtin: intent.is_builtin,
        extra,
    }
}

fn same_provider_connection(left: &PortableProvider, right: &PortableProvider) -> bool {
    left.id == right.id
        && left.kind == right.kind
        && left.base_url == right.base_url
        && left.needs_key == right.needs_key
        && left.deployment == right.deployment
}

// ===========================================================================
// Legacy Pi provider preset migration (provider-config-migration-core.ts)
// ===========================================================================

pub const CUSTOM_PROVIDER_ID_PREFIX: &str = "custom:";

pub fn is_custom_provider_id(provider_id: &str) -> bool {
    provider_id.starts_with(CUSTOM_PROVIDER_ID_PREFIX)
        && provider_id.len() > CUSTOM_PROVIDER_ID_PREFIX.len()
}

pub fn custom_provider_id(provider_id: &str) -> String {
    let normalized = provider_id.trim();
    if is_custom_provider_id(normalized) {
        normalized.to_string()
    } else if normalized.is_empty() {
        format!("{CUSTOM_PROVIDER_ID_PREFIX}connection")
    } else {
        format!("{CUSTOM_PROVIDER_ID_PREFIX}{normalized}")
    }
}

const GOOGLE_PROVIDER_ID: &str = "google";
const LEGACY_GEMINI_PROVIDER_ID: &str = "gemini";
const MOONSHOT_AI_PROVIDER_ID: &str = "moonshotai";
const LEGACY_MOONSHOT_PROVIDER_ID: &str = "moonshot";
const GOOGLE_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_DEFAULT_MODEL: &str = "gemini-2.5-flash";

/// `migrateLegacyPiProviderId` (renderer/shared/google-provider.ts).
pub fn migrate_legacy_pi_provider_id(provider_id: Option<&str>) -> Option<String> {
    match provider_id {
        Some(LEGACY_GEMINI_PROVIDER_ID) => Some(GOOGLE_PROVIDER_ID.to_string()),
        Some(LEGACY_MOONSHOT_PROVIDER_ID) => Some(MOONSHOT_AI_PROVIDER_ID.to_string()),
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

const LEGACY_PI_PROVIDER_IDS: &[&str] = &[
    "openai",
    "anthropic",
    GOOGLE_PROVIDER_ID,
    LEGACY_GEMINI_PROVIDER_ID,
    "deepseek",
    LEGACY_MOONSHOT_PROVIDER_ID,
];

fn legacy_pi_base_urls() -> std::collections::HashMap<&'static str, &'static str> {
    [
        ("openai", "https://api.openai.com/v1"),
        ("anthropic", "https://api.anthropic.com/v1"),
        (GOOGLE_PROVIDER_ID, GOOGLE_BASE_URL),
        (LEGACY_GEMINI_PROVIDER_ID, GOOGLE_BASE_URL),
        ("deepseek", "https://api.deepseek.com/v1"),
        (LEGACY_MOONSHOT_PROVIDER_ID, "https://api.moonshot.ai/v1"),
    ]
    .into_iter()
    .collect()
}

const ANTHROPIC_DEFAULT_MODELS: &[&str] =
    &["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-5";
const LEGACY_ANTHROPIC_PRESET_MODELS: &[&str] = &[
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-latest",
    "claude-3-5-haiku-latest",
];

/// Snapshot of `googleProviderModelIds()` — pi-ai's vendored builtin Google
/// model list at port time (`node_modules/@earendil-works/pi-ai`).
pub const GOOGLE_PROVIDER_MODEL_IDS: &[&str] = &[
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemma-4-26b-a4b-it",
    "gemma-4-31b-it",
];

/// One row of the static Google model metadata snapshot:
/// (id, name, vision, reasoning, thinking_levels, thinking_can_disable,
/// context_window).
pub type GoogleModelMetadataRow = (
    &'static str,
    &'static str,
    bool,
    bool,
    &'static [&'static str],
    bool,
    u64,
);

/// Snapshot of pi-ai's Google models, derived with the same
/// `googleThinkingLevelsForModel` / `googleThinkingCanDisable` rules the TS
/// `googleProviderModelMetadata()` uses.
#[rustfmt::skip]
pub const GOOGLE_PROVIDER_MODEL_METADATA: &[GoogleModelMetadataRow] = &[
    ("gemini-2.0-flash", "Gemini 2.0 Flash", true, false, &[], false, 1_048_576),
    ("gemini-2.0-flash-lite", "Gemini 2.0 Flash-Lite", true, false, &[], false, 1_048_576),
    ("gemini-2.5-flash", "Gemini 2.5 Flash", true, true, &["off", "low", "medium", "high"], true, 1_048_576),
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", true, true, &["off", "low", "medium", "high"], true, 1_048_576),
    ("gemini-2.5-pro", "Gemini 2.5 Pro", true, true, &["off", "low", "medium", "high"], true, 1_048_576),
    ("gemini-3-flash-preview", "Gemini 3 Flash Preview", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemini-3-pro-preview", "Gemini 3 Pro Preview", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite Preview", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemini-3.1-pro-preview-customtools", "Gemini 3.1 Pro Preview Custom Tools", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemini-3.5-flash", "Gemini 3.5 Flash", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemini-flash-latest", "Gemini Flash Latest", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemini-flash-lite-latest", "Gemini Flash-Lite Latest", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemma-4-26b-a4b-it", "Gemma 4 26B A4B IT", true, true, &["low", "medium", "high"], false, 1_048_576),
    ("gemma-4-31b-it", "Gemma 4 31B IT", true, true, &["low", "medium", "high"], false, 1_048_576),
];

fn google_provider_model_metadata() -> BTreeMap<String, ProviderModelMetadata> {
    let mut metadata = BTreeMap::new();
    for (id, name, vision, reasoning, levels, can_disable, context) in
        GOOGLE_PROVIDER_MODEL_METADATA
    {
        metadata.insert(
            (*id).to_string(),
            ProviderModelMetadata {
                source: ProviderModelMetadataSource::Provider,
                name: Some((*name).to_string()),
                r#type: Some(ProviderModelType::Llm),
                vision: Some(*vision),
                tool_call: None,
                reasoning: Some(*reasoning),
                thinking_levels: Some(
                    levels
                        .iter()
                        .filter_map(|level| thinking_level_from_str(level))
                        .collect(),
                ),
                thinking_can_disable: Some(*can_disable),
                context_length: Some(*context),
                parameter_count: None,
                format: None,
            },
        );
    }
    metadata
}

fn legacy_preset_models() -> std::collections::HashMap<&'static str, Vec<String>> {
    let stringify = |values: &[&str]| {
        values
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
    };
    let mut models: std::collections::HashMap<&'static str, Vec<String>> =
        std::collections::HashMap::new();
    models.insert(
        "openai",
        stringify(&["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"]),
    );
    models.insert("anthropic", stringify(ANTHROPIC_DEFAULT_MODELS));
    models.insert(GOOGLE_PROVIDER_ID, stringify(GOOGLE_PROVIDER_MODEL_IDS));
    models.insert(
        LEGACY_GEMINI_PROVIDER_ID,
        stringify(GOOGLE_PROVIDER_MODEL_IDS),
    );
    models.insert(
        "deepseek",
        stringify(&["deepseek-chat", "deepseek-reasoner"]),
    );
    models.insert(
        LEGACY_MOONSHOT_PROVIDER_ID,
        stringify(&[
            "kimi-k2-0711-preview",
            "moonshot-v1-128k",
            "moonshot-v1-32k",
        ]),
    );
    models
}

fn legacy_preset_default_models() -> std::collections::HashMap<&'static str, &'static str> {
    [
        ("openai", "gpt-4o"),
        ("anthropic", ANTHROPIC_DEFAULT_MODEL),
        (GOOGLE_PROVIDER_ID, GOOGLE_DEFAULT_MODEL),
        (LEGACY_GEMINI_PROVIDER_ID, GOOGLE_DEFAULT_MODEL),
        ("deepseek", "deepseek-chat"),
        (LEGACY_MOONSHOT_PROVIDER_ID, "kimi-k2-0711-preview"),
    ]
    .into_iter()
    .collect()
}

fn legacy_preset_labels() -> std::collections::HashMap<&'static str, &'static str> {
    [
        ("openai", "OpenAI"),
        ("anthropic", "Anthropic (Claude)"),
        (GOOGLE_PROVIDER_ID, "Google Gemini"),
        (LEGACY_GEMINI_PROVIDER_ID, "Google Gemini"),
        ("deepseek", "DeepSeek"),
        (LEGACY_MOONSHOT_PROVIDER_ID, "Moonshot (Kimi)"),
    ]
    .into_iter()
    .collect()
}

fn exactly_equal(left: &[String], right: &[String]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(a, b)| a == b)
}

fn has_only_expected_metadata(provider: &StoredProvider) -> bool {
    if provider.id == GOOGLE_PROVIDER_ID || provider.id == LEGACY_GEMINI_PROVIDER_ID {
        let expected = google_provider_model_metadata();
        match &provider.model_metadata {
            Some(metadata) => metadata == &expected,
            None => false,
        }
    } else {
        match &provider.model_metadata {
            None => true,
            Some(metadata) => metadata.is_empty(),
        }
    }
}

fn has_expected_preset_models(provider: &StoredProvider, models: &[String]) -> bool {
    if exactly_equal(&provider.models, models) {
        return true;
    }
    provider.id == "anthropic"
        && provider.default_model.as_deref() == Some(LEGACY_ANTHROPIC_PRESET_MODELS[0])
        && exactly_equal(
            &provider.models,
            &LEGACY_ANTHROPIC_PRESET_MODELS
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>(),
        )
}

fn has_expected_preset_default(provider: &StoredProvider, expected: &str) -> bool {
    provider.default_model.as_deref() == Some(expected)
        || (provider.id == "anthropic"
            && provider.default_model.as_deref() == Some(LEGACY_ANTHROPIC_PRESET_MODELS[0]))
}

/// Remove only a byte-for-byte logical seeded preset. A user-saved model list,
/// default, label, auth requirement, deployment, or metadata is a real custom
/// connection even when it still points at the vendor's canonical URL.
fn is_untouched_pi_preset(provider: &StoredProvider) -> bool {
    let preset_models = legacy_preset_models();
    let Some(models) = preset_models.get(provider.id.as_str()) else {
        return false;
    };
    let base_urls = legacy_pi_base_urls();
    let default_models = legacy_preset_default_models();
    let labels = legacy_preset_labels();
    provider.is_preset == Some(true)
        && base_urls.get(provider.id.as_str()).copied() == Some(provider.base_url.as_str())
        && labels.get(provider.id.as_str()).copied() == Some(provider.label.as_str())
        && has_expected_preset_default(
            provider,
            default_models
                .get(provider.id.as_str())
                .copied()
                .unwrap_or(""),
        )
        && provider.needs_key
        && provider.deployment == Some(ProviderDeployment::Hosted)
        && has_expected_preset_models(provider, models)
        && has_only_expected_metadata(provider)
}

fn unique_custom_id(source_id: &str, used_ids: &mut HashSet<String>) -> String {
    let unbounded = custom_provider_id(source_id);
    let digest = crate::sha256_hex(unbounded.as_bytes());
    let digest = &digest[..12];
    let base = if unbounded.len() <= MAX_CONFIG_ID_LENGTH {
        unbounded
    } else {
        format!(
            "{}-{}",
            &unbounded[..MAX_CONFIG_ID_LENGTH - digest.len() - 1],
            digest
        )
    };
    let mut candidate = base.clone();
    let mut suffix = 2;
    while used_ids.contains(&candidate) {
        let collision_suffix = format!("-{suffix}");
        suffix += 1;
        candidate = format!(
            "{}{}",
            &base[..MAX_CONFIG_ID_LENGTH - collision_suffix.len()],
            collision_suffix
        );
    }
    used_ids.insert(candidate.clone());
    candidate
}

fn terminal_alias(
    aliases: &std::collections::BTreeMap<String, String>,
    source: &str,
) -> Option<String> {
    let mut cursor = source.to_string();
    let mut target = aliases.get(&cursor).cloned();
    target.as_ref()?;
    let mut visited: HashSet<String> = HashSet::from([source.to_string()]);
    while let Some(next) = target {
        if visited.contains(&next) {
            return None;
        }
        visited.insert(next.clone());
        cursor = next;
        target = aliases.get(&cursor).cloned();
    }
    Some(cursor)
}

fn flatten_alias_targets(aliases: &mut std::collections::BTreeMap<String, String>) {
    let sources: Vec<String> = aliases.keys().cloned().collect();
    for source in sources {
        if let Some(terminal) = terminal_alias(aliases, &source) {
            aliases.insert(source, terminal);
        }
    }
}

/// The composite config migration run during seeding. Mirrors
/// `migratePiProviderConfig` in provider-config-migration-core.ts.
pub fn migrate_pi_provider_config(
    providers: &mut Vec<StoredProvider>,
    provider_id_aliases: &mut Map<String, Value>,
    last_provider_id: &mut Option<String>,
) -> bool {
    let before_providers = serde_json::to_string(providers).unwrap_or_default();
    let before_aliases = serde_json::to_string(provider_id_aliases).unwrap_or_default();
    let mut aliases: Map<String, Value> = provider_id_aliases.clone();
    let mut used_ids: HashSet<String> = HashSet::new();
    for provider in providers.iter() {
        used_ids.insert(provider.id.clone());
    }
    for source in aliases.keys() {
        used_ids.insert(source.clone());
    }
    for target in aliases.values() {
        if let Some(target) = target.as_str() {
            used_ids.insert(target.to_string());
        }
    }

    let mut next: Vec<StoredProvider> = Vec::new();
    for provider in providers.drain(..) {
        let is_legacy_pi_provider = LEGACY_PI_PROVIDER_IDS.contains(&provider.id.as_str());
        if is_legacy_pi_provider && is_untouched_pi_preset(&provider) {
            continue;
        }
        if !is_custom_provider_id(&provider.id) {
            let source_id = provider.id.clone();
            let custom_id = unique_custom_id(
                if is_legacy_pi_provider {
                    format!("{source_id}-legacy")
                } else {
                    source_id.clone()
                }
                .as_str(),
                &mut used_ids,
            );
            aliases.insert(source_id.clone(), Value::String(custom_id.clone()));
            let mut renamed = provider;
            renamed.id = custom_id;
            if is_legacy_pi_provider {
                renamed.label = format!("{} (custom)", renamed.label);
            }
            renamed.is_preset = Some(false);
            renamed.is_builtin = Some(false);
            next.push(renamed);
        } else {
            let mut retained = provider;
            retained.is_preset = Some(false);
            retained.is_builtin = Some(false);
            next.push(retained);
        }
    }
    let mut aliases_strings: std::collections::BTreeMap<String, String> = aliases_view(&aliases);
    flatten_alias_targets(&mut aliases_strings);
    let aliases_restored: Map<String, Value> = aliases_strings
        .into_iter()
        .map(|(source, target)| (source, Value::String(target)))
        .collect();
    aliases = aliases_restored;

    let previous_provider_id = last_provider_id.clone();
    let aliases_for_terminal = aliases_view(&aliases);
    let migrated_provider_id = previous_provider_id
        .as_deref()
        .and_then(|previous| terminal_alias(&aliases_for_terminal, previous))
        .or_else(|| migrate_legacy_pi_provider_id(previous_provider_id.as_deref()));
    if migrated_provider_id != previous_provider_id {
        *last_provider_id = migrated_provider_id.clone();
    }
    *provider_id_aliases = aliases;
    *providers = next;

    migrated_provider_id != previous_provider_id
        || serde_json::to_string(providers).unwrap_or_default() != before_providers
        || serde_json::to_string(provider_id_aliases).unwrap_or_default() != before_aliases
}

// ===========================================================================
// Seeded README
// ===========================================================================

pub fn portable_readme() -> String {
    "# ~/.aiden\n\nThis folder is yours. Aiden creates it on first run and re-reads it whenever the\nwindow regains focus, so you can edit anything here by hand and the app picks the\nchange up without a restart.\n\n## config.json\n\nYour portable configuration. Copy it to another machine to take your setup with\nyou.\n\n| Field | What it holds |\n| --- | --- |\n| `providers` | Custom provider connections: `id`, `kind`, `label`, `baseUrl`, `needsKey`, `defaultModel`, `deployment`. |\n| `providerIdAliases` | Append-only record of provider IDs Aiden has renamed. Leave it alone unless you know why it exists. |\n| `mcpServers` | MCP server definitions. |\n| `skills` | Inline skills: `name`, `description`, `instructions`, `enabled`. |\n\nAiden rewrites this file when you change those settings in the UI, so it round\ntrips in both directions. Invalid JSON is ignored in favour of the built-in\ndefaults, and nothing is written back until you next change one of these settings\nfrom the UI.\n\n## What is deliberately not here\n\n**API keys and OAuth tokens.** They are encrypted against this machine's keychain\nand stay in Aiden's application-support folder. After copying `config.json` to a\nnew machine your providers appear with no key attached; re-enter them there.\n\n**Model lists.** `providers[].models` is discovery output rather than\nconfiguration, so it is cached per machine and refilled when you refresh a\nprovider's models.\n\n**Workspaces, UI preferences, and chat history.** Workspaces point at absolute\nfolder paths and git worktrees that exist on one machine only, so they stay\nmachine-local along with your theme, sidebar, and window state.\n\n## skill/ and skills/\n\nFolder-based Agent Skills, one folder per skill with a `SKILL.md` inside:\n\n```\n~/.aiden/skills/my-skill/SKILL.md\n```\n\nThese are separate from the `skills` array in `config.json`. The array holds\nskills typed into Aiden's UI; these folders hold skills that live as files and can\nbe version-controlled. Both are offered to the agent.\n\n## scripts/\n\nExecutables that scheduled tasks may run by name.\n"
        .to_string()
}

// ===========================================================================
// Store bundle + one-time migration
// ===========================================================================

/// Test seams passed to [`create_portable_config_stores`] (portable-config-core.ts).
#[derive(Default)]
pub struct PortableConfigTestHooks {
    pub before_local_protected_publish: Option<Box<dyn Fn() + Send + Sync>>,
    pub before_legacy_archive: Option<Box<dyn Fn() + Send + Sync>>,
    pub before_portable_external_cache_commit:
        Option<Box<dyn Fn(Option<&PortableConfigShape>, &PortableConfigShape) + Send + Sync>>,
    pub before_portable_write_publish:
        Option<Box<dyn Fn(Option<&PortableConfigShape>, &PortableConfigShape) + Send + Sync>>,
}

#[derive(Debug, thiserror::Error)]
pub enum PortableConfigError {
    #[error("{0}")]
    Store(#[from] DataStoreError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Cannot archive a legacy config that was not loaded from disk.")]
    LegacyNotLoaded,
    #[error("Could not preserve the legacy config recovery archive.")]
    ArchiveUnpreservable,
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

/// The four stores plus the one-time migration that fills them.
pub struct PortableConfigStores {
    pub portable: DataStore<PortableConfigShape>,
    pub settings: DataStore<SettingsShape>,
    pub local: DataStore<LocalConfigShape>,
    pub model_cache: DataStore<ProviderModelCacheShape>,
    portable_root: PathBuf,
    hooks: PortableConfigTestHooks,
    migration_succeeded: std::sync::Mutex<bool>,
    migration_attempted: std::sync::Mutex<bool>,
}

fn exists(target: &Path) -> bool {
    fs::symlink_metadata(target).is_ok()
}

fn append_missing_by_id<T: Clone + IdRef>(current: &[T], recovered: &[T]) -> Vec<T> {
    let ids: HashSet<&str> = current.iter().map(IdRef::id).collect();
    let mut merged = current.to_vec();
    for item in recovered {
        if !ids.contains(item.id()) {
            merged.push(item.clone());
        }
    }
    merged
}

fn append_missing_settings(
    current: &Map<String, Value>,
    recovered: &Map<String, Value>,
) -> Map<String, Value> {
    let mut merged = current.clone();
    for (key, recovered_value) in recovered {
        if !current.contains_key(key) {
            merged.insert(key.clone(), recovered_value.clone());
            continue;
        }
        let current_value = &merged[key];
        if current_value.is_object() && recovered_value.is_object() {
            let nested = append_missing_settings(
                current_value.as_object().unwrap(),
                recovered_value.as_object().unwrap(),
            );
            merged.insert(key.clone(), Value::Object(nested));
        }
    }
    merged
}

fn file_equals_contents(contents: &[u8], target: &Path) -> bool {
    fs::read(target)
        .map(|read| read == contents)
        .unwrap_or(false)
}

fn write_file_atomically_if_absent(
    contents: &[u8],
    destination: &Path,
) -> Result<bool, std::io::Error> {
    if exists(destination) {
        return Ok(false);
    }
    let directory = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent dir"))?;
    let staged = directory.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        crate::unique_id()
    ));
    let mut published = false;
    let result = (|| -> Result<(), std::io::Error> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        // A hard link publishes the fully copied sibling in one no-overwrite
        // operation.
        match fs::hard_link(&staged, destination) {
            Ok(()) => {
                published = true;
                crate::sync_directory(directory)
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        Ok(())
    })();
    let _ = fs::remove_file(&staged);
    result?;
    Ok(published)
}

fn ensure_complete_legacy_archive(
    source_contents: &[u8],
    destination: &Path,
) -> Result<PathBuf, PortableConfigError> {
    if file_equals_contents(source_contents, destination) {
        return Ok(destination.to_path_buf());
    }
    if write_file_atomically_if_absent(source_contents, destination)? {
        return Ok(destination.to_path_buf());
    }
    if file_equals_contents(source_contents, destination) {
        return Ok(destination.to_path_buf());
    }

    // An older non-atomic migration may already have left the canonical archive
    // truncated, empty, or replaced by a non-file. Never overwrite it; preserve
    // the current complete source under a second atomically published name.
    let directory = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent dir"))?;
    let recovery_prefix = format!(
        "{}.recovery-",
        destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&recovery_prefix) {
            continue;
        }
        if file_equals_contents(source_contents, &entry.path()) {
            return Ok(entry.path());
        }
    }
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H-%M-%S%.3f")
        .to_string()
        .replace([':', '.'], "-");
    let recovery = destination.with_file_name(format!(
        "{}.recovery-{}-{}",
        destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        now,
        crate::unique_id()
    ));
    if !write_file_atomically_if_absent(source_contents, &recovery)? {
        return Err(PortableConfigError::ArchiveUnpreservable);
    }
    Ok(recovery)
}

fn legacy_archive_state(source: &Path, destination: &Path) -> (bool, bool) {
    let mut candidates = vec![destination.to_path_buf()];
    let directory = destination
        .parent()
        .map(|parent| parent.to_path_buf())
        .unwrap_or_default();
    let recovery_prefix = format!(
        "{}.recovery-",
        destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&recovery_prefix) {
                candidates.push(entry.path());
            }
        }
    }
    let Ok(source_bytes) = fs::read(source) else {
        return (false, false);
    };
    let mut has_usable_snapshot = false;
    for candidate in candidates {
        if let Ok(candidate_bytes) = fs::read(&candidate) {
            if candidate_bytes == source_bytes {
                return (true, true);
            }
            if let Ok(parsed) = serde_json::from_slice::<Value>(&candidate_bytes) {
                if parsed.is_object() {
                    has_usable_snapshot = true;
                }
            }
        }
    }
    (has_usable_snapshot, false)
}

impl PortableConfigStores {
    /// Seed the README if absent. Never overwrites a copy the user has edited.
    pub fn ensure_readme(&self) -> Result<(), PortableConfigError> {
        let target = self.portable_root.join(PORTABLE_README_FILENAME);
        let directory = target
            .parent()
            .ok_or_else(|| std::io::Error::other("no parent dir"))?;
        fs::create_dir_all(directory)?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                file.write_all(portable_readme().as_bytes())?;
                file.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    /// Migrate onto the split layout, exactly once per process. Returns false
    /// (leaving the layout retryable) when the portable root is unreadable or
    /// the existing portable document is unsafe — the stores keep returning
    /// defaults and every write stays protected until the filesystem is fixed.
    pub fn ensure_migrated(&self) -> Result<bool, PortableConfigError> {
        let mut attempted = self.migration_attempted.lock().unwrap();
        if *attempted {
            return Ok(*self.migration_succeeded.lock().unwrap());
        }
        *attempted = true;
        let result = self.run_migration();
        match &result {
            Ok(completed) => {
                if *completed {
                    *self.migration_succeeded.lock().unwrap() = true;
                } else {
                    *attempted = false;
                }
            }
            Err(_) => {
                *attempted = false;
            }
        }
        result
    }

    fn run_migration(&self) -> Result<bool, PortableConfigError> {
        let legacy_path = self.local.path()?;
        let archive_path = legacy_path.with_file_name(format!(
            "{}{}",
            legacy_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            LEGACY_CONFIG_ARCHIVE_SUFFIX
        ));
        // The legacy file *is* <localRoot>/config.json, so this load sees the
        // pre-split superset; the extra keys survive in `extra`.
        let loaded = self.local.load()?;
        if self.local.loaded_from_corrupt_file()? || self.local.loaded_from_unsafe_file()? {
            self.ensure_readme()?;
            return Ok(false);
        }
        let loaded_legacy_contents = self.local.loaded_disk_contents()?;
        if loaded.aiden_dir_migrated_at.is_some() {
            return Ok(true);
        }

        let legacy_get = |key: &str| loaded.extra.get(key).cloned();

        let portable_path = self.portable.path()?;
        let portable_exists = exists(&portable_path);
        // The typed DataStore cannot tell "key absent" from "key present but
        // empty", and the TS migration depends on that distinction (an empty
        // `providers: []` means the user cleared the list; absent means
        // "recover from legacy"). Read the raw document for presence checks
        // and run the per-key strict validation over it, exactly like TS.
        let raw_portable: Option<Value> = if portable_exists {
            match fs::read(&portable_path) {
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(parsed) => Some(parsed),
                    Err(_) => {
                        self.ensure_readme()?;
                        return Ok(false);
                    }
                },
                Err(_) => {
                    self.ensure_readme()?;
                    return Ok(false);
                }
            }
        } else {
            None
        };
        let raw_portable = match raw_portable {
            Some(raw) => raw,
            None => Value::Object(Map::new()),
        };
        if portable_exists && self.portable.loaded_from_corrupt_file()? {
            self.ensure_readme()?;
            return Ok(false);
        }
        if !raw_portable.is_object() {
            self.ensure_readme()?;
            return Ok(false);
        }
        let (existing_portable, unsafe_portable) = normalize_portable_config(&raw_portable);
        if unsafe_portable {
            self.ensure_readme()?;
            return Ok(false);
        }
        let has = |key: &str| {
            raw_portable
                .as_object()
                .map(|object| object.contains_key(key))
                .unwrap_or(false)
        };

        // Do not archive a connection string containing embedded credentials or
        // URL-only state that the portable schema intentionally forbids.
        if let Some(Value::Array(legacy_providers)) = legacy_get("providers") {
            if legacy_providers.iter().any(has_sensitive_provider_url) {
                self.ensure_readme()?;
                return Ok(false);
            }
        }

        let structurally_valid_legacy_providers: Vec<StoredProvider> = match legacy_get("providers")
        {
            Some(Value::Array(providers)) => providers
                .iter()
                .filter_map(normalize_stored_provider)
                .collect(),
            _ => Vec::new(),
        };
        let mut legacy_provider_id_counts: BTreeMap<String, usize> = BTreeMap::new();
        for provider in &structurally_valid_legacy_providers {
            *legacy_provider_id_counts
                .entry(provider.id.clone())
                .or_default() += 1;
        }
        let legacy_providers: Vec<StoredProvider> = structurally_valid_legacy_providers
            .into_iter()
            .filter(|provider| legacy_provider_id_counts.get(&provider.id).copied() == Some(1))
            .collect();
        let legacy_split: Vec<(PortableProvider, ProviderModelCacheEntry)> =
            legacy_providers.iter().map(split_stored_provider).collect();
        let recovered_provider_intents: Vec<PortableProvider> = legacy_split
            .iter()
            .map(|(intent, _)| intent.clone())
            .collect();

        let archive_state = legacy_archive_state(&legacy_path, &archive_path);
        let recovering_late_legacy_edit = portable_exists && archive_state.0 && !archive_state.1;

        let existing_providers = &existing_portable.providers;
        let existing_aliases = &existing_portable.provider_id_aliases;
        let existing_mcp_servers = &existing_portable.mcp_servers;
        let existing_skills = &existing_portable.skills;

        let portable_providers: Vec<PortableProvider> = if !has("providers") {
            // Absent providers key on a fresh portable file: recover legacy intent.
            recovered_provider_intents.clone()
        } else if recovering_late_legacy_edit {
            append_missing_by_id(existing_providers, &recovered_provider_intents)
        } else {
            existing_providers.clone()
        };

        if !provider_alias_sources_are_inactive(existing_aliases, &portable_providers) {
            self.ensure_readme()?;
            return Ok(false);
        }

        let recovered_mcp_servers = legacy_get("mcpServers")
            .as_ref()
            .map(normalize_legacy_mcp_servers)
            .unwrap_or_default();
        let recovered_skills = legacy_get("skills")
            .as_ref()
            .map(normalize_legacy_skills)
            .unwrap_or_default();

        let mut next_portable = existing_portable.clone();
        next_portable.providers = portable_providers.clone();
        next_portable.provider_id_aliases = if has("providerIdAliases") {
            existing_aliases.clone()
        } else if let Some(legacy_aliases) = legacy_get("providerIdAliases") {
            if is_provider_alias_map(&legacy_aliases)
                && provider_alias_sources_are_inactive(
                    &alias_map_from_value(&legacy_aliases),
                    &portable_providers,
                )
            {
                alias_map_from_value(&legacy_aliases)
            } else {
                Map::new()
            }
        } else {
            Map::new()
        };
        next_portable.mcp_servers = if has("mcpServers") {
            if recovering_late_legacy_edit {
                append_missing_by_id(existing_mcp_servers, &recovered_mcp_servers)
            } else {
                existing_mcp_servers.clone()
            }
        } else {
            recovered_mcp_servers
        };
        next_portable.skills = if has("skills") {
            if recovering_late_legacy_edit {
                append_missing_by_id(existing_skills, &recovered_skills)
            } else {
                existing_skills.clone()
            }
        } else {
            recovered_skills
        };

        if serde_json::to_string(&next_portable)? != serde_json::to_string(&existing_portable)? {
            self.portable.save(&next_portable)?;
        }

        let portable_provider_by_id: std::collections::HashMap<&str, &PortableProvider> =
            portable_providers
                .iter()
                .map(|provider| (provider.id.as_str(), provider))
                .collect();
        let mut cacheable: Vec<(String, ProviderModelCacheEntry)> = Vec::new();
        for (index, (intent, cache)) in legacy_split.iter().enumerate() {
            let legacy = &legacy_providers[index];
            let matched = portable_provider_by_id
                .get(legacy.id.as_str())
                .map(|portable| same_provider_connection(portable, intent))
                .unwrap_or(false);
            if matched && (cache.models.is_some() || cache.model_metadata.is_some()) {
                cacheable.push((legacy.id.clone(), cache.clone()));
            }
        }
        if !cacheable.is_empty() {
            self.model_cache.update(|draft| {
                for (id, cache) in &cacheable {
                    let merged =
                        merge_provider_model_cache_entries(Some(cache), draft.by_provider.get(id));
                    draft.by_provider.insert(id.clone(), merged);
                }
            })?;
        }

        if !exists(&self.settings.path()?) {
            let legacy_settings = legacy_get("settings").unwrap_or(Value::Object(Map::new()));
            let normalized = normalize_settings_shape(&legacy_settings);
            self.settings.save(&normalized)?;
        } else if recovering_late_legacy_edit {
            if let Some(legacy_settings) = legacy_get("settings") {
                if legacy_settings.is_object() {
                    self.settings.update(|document| {
                        let merged = append_missing_settings(
                            &document.settings,
                            legacy_settings.as_object().unwrap(),
                        );
                        document.settings =
                            normalize_settings_shape(&Value::Object(merged)).settings;
                    })?;
                }
            }
        }

        self.ensure_readme()?;

        // Consume the legacy file. Archiving is not a courtesy copy: if the
        // pre-split superset stayed at config.json, a user who deleted the
        // portable file to start clean would have everything resurrected from
        // it. Retiring it makes an absent portable file mean "use defaults".
        if exists(&legacy_path) {
            let Some(contents) = loaded_legacy_contents else {
                return Err(PortableConfigError::LegacyNotLoaded);
            };
            if let Some(hook) = &self.hooks.before_legacy_archive {
                hook();
            }
            ensure_complete_legacy_archive(&contents, &archive_path)?;
        }

        // Copy-then-overwrite rather than rename, so no crash window leaves the
        // legacy fields existing in neither file.
        let mut next_local = serde_json::to_value(&loaded)?;
        if let Some(record) = next_local.as_object_mut() {
            record.remove("providers");
            record.remove("providerIdAliases");
            record.remove("settings");
            record.remove("mcpServers");
            record.remove("skills");
            record.insert(
                "workspaces".into(),
                serde_json::to_value(&loaded.workspaces)?,
            );
            record.insert("seeded".into(), Value::Bool(loaded.seeded));
            let now = crate::now_millis();
            record.insert("aidenDirMigratedAt".into(), Value::Number(now.into()));
        }
        let next_local: LocalConfigShape = serde_json::from_value(next_local)?;
        match self.local.save(&next_local) {
            Ok(()) => Ok(true),
            Err(DataStoreError::ExternalChange) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

fn alias_map_from_value(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// Build the four stores plus the one-time migration that fills them.
///
/// `local_root` defaults to the machine-local data directory when `None`.
pub fn create_portable_config_stores(
    portable_root: PathBuf,
    local_root: Option<PathBuf>,
    hooks: PortableConfigTestHooks,
) -> PortableConfigStores {
    let PortableConfigTestHooks {
        before_local_protected_publish,
        before_legacy_archive,
        before_portable_external_cache_commit,
        before_portable_write_publish,
    } = hooks;

    let mut portable_options = DataStoreOptions::new();
    portable_options.preserve_corrupt_file = true;
    portable_options.reload_before_write = true;
    portable_options.reject_corrupt_write = true;
    portable_options.reject_unsafe_write = true;
    portable_options.reject_external_changes = true;
    portable_options.before_external_cache_commit = before_portable_external_cache_commit;
    portable_options.before_write_publish = before_portable_write_publish;

    let mut settings_options = DataStoreOptions::new();
    settings_options.normalize = Some(Box::new(|value: Value| normalize_settings_shape(&value)));
    settings_options.preserve_corrupt_file = true;
    settings_options.reload_before_write = true;
    settings_options.reject_corrupt_write = true;
    settings_options.reject_external_changes = true;

    let mut local_options = DataStoreOptions::new();
    local_options.normalize = Some(Box::new(|value: Value| {
        normalize_local_config_shape(&value)
    }));
    local_options.is_safe = Some(Box::new(|value: &Value| is_local_config_shape_safe(value)));
    local_options.reload_before_write = true;
    local_options.reject_corrupt_write = true;
    local_options.reject_unsafe_write = true;
    local_options.reject_external_changes = true;
    local_options.before_protected_publish = before_local_protected_publish;

    let mut cache_options = DataStoreOptions::new();
    cache_options.normalize = Some(Box::new(|value: Value| {
        normalize_provider_model_cache_shape(&value)
    }));

    let portable = DataStore::new(
        PORTABLE_CONFIG_FILENAME,
        PortableConfigShape::empty(),
        Some(portable_root.clone()),
        portable_options,
    );
    let settings = DataStore::new(
        SETTINGS_FILENAME,
        SettingsShape {
            settings: Map::new(),
            extra: Map::new(),
        },
        local_root.clone(),
        settings_options,
    );
    let local = DataStore::new(
        LOCAL_CONFIG_FILENAME,
        LocalConfigShape {
            workspaces: Vec::new(),
            seeded: false,
            aiden_dir_migrated_at: None,
            extra: Map::new(),
        },
        local_root.clone(),
        local_options,
    );
    let model_cache = DataStore::new(
        PROVIDER_MODEL_CACHE_FILENAME,
        ProviderModelCacheShape {
            by_provider: BTreeMap::new(),
            extra: Map::new(),
        },
        local_root,
        cache_options,
    );

    PortableConfigStores {
        portable,
        settings,
        local,
        model_cache,
        portable_root,
        hooks: PortableConfigTestHooks {
            before_local_protected_publish: None,
            before_legacy_archive,
            before_portable_external_cache_commit: None,
            before_portable_write_publish: None,
        },
        migration_succeeded: std::sync::Mutex::new(false),
        migration_attempted: std::sync::Mutex::new(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn split_stored_provider_separates_portable_intent_from_regenerable_cache() {
        let provider: StoredProvider = serde_json::from_value(value(
            r#"{
                "id": "custom:lmstudio",
                "kind": "openai",
                "label": "LM Studio",
                "baseUrl": "http://localhost:1234/v1",
                "models": ["model-a"],
                "defaultModel": "model-a",
                "needsKey": false,
                "deployment": "local"
            }"#,
        ))
        .unwrap();
        let (intent, cache) = split_stored_provider(&provider);
        assert_eq!(intent.id, "custom:lmstudio");
        assert!(intent.extra.get("models").is_none());
        assert_eq!(cache.models.unwrap(), vec!["model-a".to_string()]);
    }

    #[test]
    fn compose_stored_provider_round_trips_through_the_split() {
        let provider: StoredProvider = serde_json::from_value(value(
            r#"{
                "id": "custom:x",
                "kind": "anthropic",
                "label": "X",
                "baseUrl": "https://x.example/v1",
                "models": ["a", "b"],
                "needsKey": true,
                "deployment": "hosted"
            }"#,
        ))
        .unwrap();
        let (intent, cache) = split_stored_provider(&provider);
        let composed = compose_stored_provider(&intent, Some(&cache));
        assert_eq!(composed.models, vec!["a", "b"]);
        assert_eq!(composed.id, "custom:x");
    }

    #[test]
    fn compose_stored_provider_yields_an_empty_model_list_when_nothing_is_cached() {
        let intent: PortableProvider = serde_json::from_value(value(
            r#"{
                "id": "custom:x",
                "kind": "openai",
                "label": "X",
                "baseUrl": "https://x.example/v1",
                "needsKey": true
            }"#,
        ))
        .unwrap();
        let composed = compose_stored_provider(&intent, None);
        assert!(composed.models.is_empty());
        assert!(composed.model_metadata.is_none());
    }

    #[test]
    fn compose_stored_provider_ignores_cache_fields_smuggled_into_portable_intent() {
        let intent: PortableProvider = serde_json::from_value(value(
            r#"{
                "id": "custom:x",
                "kind": "openai",
                "label": "X",
                "baseUrl": "https://x.example/v1",
                "needsKey": true,
                "models": ["smuggled"],
                "modelMetadata": { "smuggled": { "source": "provider" } }
            }"#,
        ))
        .unwrap();
        let composed = compose_stored_provider(&intent, None);
        assert!(
            composed.models.is_empty(),
            "portable cache fields must not leak"
        );
        assert!(composed.model_metadata.is_none());
    }

    #[test]
    fn provider_alias_validation_is_bounded_and_resolves_accepted_chains_linearly() {
        assert!(is_provider_alias_map(&value("{}")));
        assert!(is_provider_alias_map(&value(r#"{"old": "custom:new"}"#)));
        assert!(is_provider_alias_map(&value(r#"{"a": "b", "b": "c"}"#)));
        // Self-referential cycles are rejected.
        assert!(!is_provider_alias_map(&value(r#"{"a": "a"}"#)));
        assert!(!is_provider_alias_map(&value(r#"{"a": "b", "b": "a"}"#)));
        // Non-string values are rejected.
        assert!(!is_provider_alias_map(&value(r#"{"a": 1}"#)));
        // Empty sources/targets are rejected.
        assert!(!is_provider_alias_map(&value(r#"{" ": "custom:x"}"#)));
        assert!(!is_provider_alias_map(&value(r#"{"a": " "}"#)));

        let aliases = alias_map_from_value(&value(r#"{"old": "custom:new"}"#));
        assert_eq!(
            resolve_provider_alias(&aliases, "old"),
            Some("custom:new".into())
        );
        assert_eq!(resolve_provider_alias(&aliases, "custom:new"), None);
        let routes = resolved_provider_alias_routes(&aliases);
        assert_eq!(
            routes,
            vec![("old".to_string(), "custom:new".to_string(), 1)]
        );
    }

    #[test]
    fn active_provider_ids_cannot_also_redirect_through_the_alias_map() {
        let aliases = alias_map_from_value(&value(r#"{"old": "custom:new"}"#));
        let providers: Vec<PortableProvider> =
            vec![serde_json::from_value(value(
                r#"{"id": "old", "kind": "openai", "label": "X", "baseUrl": "https://x/v1", "needsKey": true}"#,
            ))
            .unwrap()];
        assert!(!provider_alias_sources_are_inactive(&aliases, &providers));
    }

    #[test]
    fn portable_provider_urls_reject_embedded_credentials_and_url_only_state() {
        assert!(is_provider_base_url(&Value::String(
            "https://api.openai.com/v1".into()
        )));
        assert!(is_provider_base_url(&Value::String(
            "http://localhost:1234/v1".into()
        )));
        assert!(!is_provider_base_url(&Value::String(
            "https://user:pass@api.openai.com/v1".into()
        )));
        assert!(!is_provider_base_url(&Value::String(
            "https://api.openai.com/v1?key=1".into()
        )));
        assert!(!is_provider_base_url(&Value::String(
            "https://api.openai.com/v1#frag".into()
        )));
        assert!(!is_provider_base_url(&Value::String("ftp://x/v1".into())));
        assert!(!is_provider_base_url(&Value::String("https:///v1".into())));

        let sensitive = value(r#"{"baseUrl": "https://user:pass@x.example/v1"}"#);
        assert!(has_sensitive_provider_url(&sensitive));
        let clean = value(r#"{"baseUrl": "https://x.example/v1"}"#);
        assert!(!has_sensitive_provider_url(&clean));
    }

    #[test]
    fn normalize_portable_config_flags_unsafe_sections() {
        let (config, unsafe_config) = normalize_portable_config(&value(
            r#"{
                "providers": [{ "id": "custom:x", "kind": "openai", "label": "X", "baseUrl": "https://x/v1", "needsKey": true }],
                "providerIdAliases": { "old": "custom:x" },
                "mcpServers": [],
                "skills": [],
                "future": { "unknown": true }
            }"#,
        ));
        assert!(!unsafe_config);
        assert_eq!(config.providers.len(), 1);
        assert!(config.extra.get("future").is_some());

        let (_config, unsafe_config) =
            normalize_portable_config(&value(r#"{"providers": "not-a-list"}"#));
        assert!(unsafe_config);

        let (config, unsafe_config) = normalize_portable_config(&value(
            r#"{"providerIdAliases": {"active": "custom:y"}, "providers": [{"id": "active", "kind": "openai", "label": "Y", "baseUrl": "https://y/v1", "needsKey": true}]}"#,
        ));
        assert!(unsafe_config);
        assert!(config.provider_id_aliases.is_empty());
    }

    #[test]
    fn migrate_pi_provider_config_retires_untouched_presets_and_aliases_edited_ones() {
        let mut providers = vec![serde_json::from_value::<StoredProvider>(value(
            r#"{
                "id": "openai",
                "kind": "openai",
                "label": "OpenAI",
                "baseUrl": "https://api.openai.com/v1",
                "models": ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
                "defaultModel": "gpt-4o",
                "needsKey": true,
                "deployment": "hosted",
                "isPreset": true
            }"#,
        ))
        .unwrap()];
        let mut aliases = Map::new();
        let mut last_provider_id = Some("openai".to_string());
        let changed =
            migrate_pi_provider_config(&mut providers, &mut aliases, &mut last_provider_id);
        assert!(changed);
        assert!(providers.is_empty(), "untouched presets are retired");
        assert_eq!(last_provider_id.as_deref(), Some("openai"));
        assert!(aliases.is_empty());

        // An edited preset is a custom connection: it moves to the reserved id.
        let mut providers = vec![serde_json::from_value::<StoredProvider>(value(
            r#"{
                "id": "openai",
                "kind": "openai",
                "label": "My OpenAI",
                "baseUrl": "https://api.openai.com/v1",
                "models": ["gpt-4o"],
                "defaultModel": "gpt-4o",
                "needsKey": true,
                "deployment": "hosted",
                "isPreset": true
            }"#,
        ))
        .unwrap()];
        let mut aliases = Map::new();
        let mut last_provider_id = Some("openai".to_string());
        migrate_pi_provider_config(&mut providers, &mut aliases, &mut last_provider_id);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "custom:openai-legacy");
        assert_eq!(providers[0].label, "My OpenAI (custom)");
        assert_eq!(aliases.get("openai").unwrap(), "custom:openai-legacy");
        assert_eq!(last_provider_id.as_deref(), Some("custom:openai-legacy"));
    }

    #[test]
    fn normalize_settings_shape_drops_wrong_typed_known_keys_and_keeps_unknowns() {
        let shape = normalize_settings_shape(&value(
            r#"{
                "settings": {
                    "lastProviderId": 123,
                    "voiceModel": "whisper",
                    "exaEnabled": "yes",
                    "future": { "x": 1 },
                    "googleThinkingByModel": "not-an-object"
                }
            }"#,
        ));
        assert!(shape.settings.get("lastProviderId").is_none());
        assert_eq!(shape.settings.get("voiceModel").unwrap(), "whisper");
        assert!(shape.settings.get("exaEnabled").is_none());
        assert!(shape.settings.get("googleThinkingByModel").is_none());
        assert!(shape.settings.get("future").is_some());
    }

    #[test]
    fn runtime_settings_from_projects_known_enum_values() {
        let settings: Map<String, Value> = serde_json::from_value(value(
            r#"{
                "voiceProvider": "bogus",
                "chatTitleProviderId": "automatic",
                "lastModel": "m"
            }"#,
        ))
        .unwrap();
        let runtime = runtime_settings_from(&settings);
        assert!(runtime.get("voiceProvider").is_none());
        assert_eq!(runtime.get("chatTitleProviderId").unwrap(), "automatic");
        assert_eq!(runtime.get("lastModel").unwrap(), "m");
    }

    #[test]
    fn legacy_providers_salvage_valid_intent_while_dropping_malformed_optional_metadata() {
        let provider = normalize_stored_provider(&value(
            r#"{
                "id": "custom:local",
                "kind": "openai",
                "label": "Local",
                "baseUrl": "http://localhost:11434/v1",
                "models": ["m1", "m1", "  "],
                "needsKey": false,
                "modelMetadata": { "m1": { "source": "provider", "contextLength": -1 } }
            }"#,
        ))
        .unwrap();
        assert_eq!(provider.models, vec!["m1"]);
        assert!(
            provider.model_metadata.is_none(),
            "invalid metadata is dropped"
        );
    }

    #[test]
    fn migration_writes_the_portable_fields_to_the_portable_root() {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        // A pre-split config.json at the local root.
        std::fs::write(
            local.path().join("config.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "providers": [{
                    "id": "custom:local",
                    "kind": "openai",
                    "label": "Local",
                    "baseUrl": "http://localhost:11434/v1",
                    "models": ["llama"],
                    "needsKey": false
                }],
                "workspaces": [],
                "seeded": false,
                "futureLocal": 1
            }))
            .unwrap(),
        )
        .unwrap();
        let stores = create_portable_config_stores(
            portable.path().to_path_buf(),
            Some(local.path().to_path_buf()),
            PortableConfigTestHooks::default(),
        );
        assert!(stores.ensure_migrated().unwrap());

        let portable_config: Value = serde_json::from_str(
            &std::fs::read_to_string(portable.path().join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(portable_config["providers"][0]["id"], "custom:local");
        assert_eq!(
            portable_config["providers"][0]["models"],
            serde_json::Value::Null
        );

        let local_config: Value = serde_json::from_str(
            &std::fs::read_to_string(local.path().join("config.json")).unwrap(),
        )
        .unwrap();
        assert!(local_config.get("providers").is_none());
        assert!(local_config.get("settings").is_none());
        assert_eq!(local_config["futureLocal"], 1);
        assert_eq!(local_config["seeded"], false);
        assert!(local_config["aidenDirMigratedAt"].is_number());

        // The pre-split superset is archived, not left readable.
        let archive = local.path().join("config.json.pre-aiden-dir");
        assert!(archive.exists());
        let archived: Value =
            serde_json::from_str(&std::fs::read_to_string(&archive).unwrap()).unwrap();
        assert!(archived["providers"].is_array());

        // The README is seeded.
        assert!(portable.path().join("README.md").exists());

        // Idempotent across a second process.
        let stores2 = create_portable_config_stores(
            portable.path().to_path_buf(),
            Some(local.path().to_path_buf()),
            PortableConfigTestHooks::default(),
        );
        assert!(stores2.ensure_migrated().unwrap());
        let portable_config2: Value = serde_json::from_str(
            &std::fs::read_to_string(portable.path().join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(portable_config2["providers"][0]["id"], "custom:local");
    }

    #[test]
    fn a_fresh_install_with_no_legacy_file_still_gets_a_portable_config() {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let stores = create_portable_config_stores(
            portable.path().to_path_buf(),
            Some(local.path().to_path_buf()),
            PortableConfigTestHooks::default(),
        );
        assert!(stores.ensure_migrated().unwrap());
        assert!(portable.path().join("README.md").exists());
        let local_config: Value = serde_json::from_str(
            &std::fs::read_to_string(local.path().join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(local_config["seeded"], false);
        assert!(local_config["aidenDirMigratedAt"].is_number());
        assert_eq!(stores.portable.load().unwrap().providers.len(), 0);
    }

    #[test]
    fn a_crash_between_archiving_and_slimming_still_converges_on_the_next_launch() {
        let portable = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let legacy = serde_json::json!({
            "providers": [{
                "id": "custom:local",
                "kind": "openai",
                "label": "Local",
                "baseUrl": "http://localhost:11434/v1",
                "models": ["llama"],
                "needsKey": false
            }],
            "workspaces": [],
            "seeded": false
        });
        std::fs::write(
            local.path().join("config.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let stores = create_portable_config_stores(
            portable.path().to_path_buf(),
            Some(local.path().to_path_buf()),
            PortableConfigTestHooks::default(),
        );
        assert!(stores.ensure_migrated().unwrap());

        // Simulate a crash: the archive exists, the slimmed local write landed
        // but the portable split was never published (missing portable file).
        std::fs::remove_file(portable.path().join("config.json")).unwrap();
        let local_config: Value = serde_json::from_str(
            &std::fs::read_to_string(local.path().join("config.json")).unwrap(),
        )
        .unwrap();
        assert!(local_config.get("providers").is_none());

        let stores2 = create_portable_config_stores(
            portable.path().to_path_buf(),
            Some(local.path().to_path_buf()),
            PortableConfigTestHooks::default(),
        );
        assert!(stores2.ensure_migrated().unwrap());
        // The local file is already migrated; the portable file was deleted by
        // the user's own hand (absent portable file means "use defaults").
        assert_eq!(stores2.portable.load().unwrap().providers.len(), 0);
    }
}
