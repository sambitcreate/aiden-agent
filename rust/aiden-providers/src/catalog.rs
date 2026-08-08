//! Model catalog + runtime resolution.
//!
//! Port of Aiden's `main/services/models.ts`, `main/services/model-runtime-core.ts`,
//! `main/services/models-catalog-core.ts`, `main/services/generation-runtime.ts`
//! (the pure policy parts), `main/services/custom-provider-id.ts`, and
//! `renderer/shared/provider-deployment.ts`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{ApiFamily, ProviderError};

/// Aiden's custom-connection id prefix (`custom-provider-id.ts`).
pub const CUSTOM_PROVIDER_ID_PREFIX: &str = "custom:";
/// Process-only non-secret compatibility token for keyless endpoints
/// (`generation-runtime.ts`).
pub const PI_AUTH_COMPATIBILITY_TOKEN: &str = "aiden-local-no-auth";
/// Model-discovery timeout (`models.ts`).
pub const MODEL_DISCOVERY_TIMEOUT_MS: u64 = 10_000;

// ===========================================================================
// Provider DTOs (types.ts + provider-deployment.ts)
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Openai,
    Anthropic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderDeployment {
    Local,
    Hosted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderModelType {
    Llm,
    Embedding,
}

/// Metadata reported by the configured provider during explicit discovery.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelMetadata {
    pub source: String,
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
    pub thinking_levels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_can_disable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_count: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// A configured connection to an LLM backend (hosted or local).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProvider {
    pub id: String,
    pub kind: ProviderKind,
    pub label: String,
    pub base_url: String,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<HashMap<String, ProviderModelMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub needs_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<ProviderDeployment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_preset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_builtin: Option<bool>,
}

// ===========================================================================
// Provider deployment rules (provider-deployment.ts)
// ===========================================================================

/// Loopback hosts are treated as local when no explicit deployment is stored.
pub fn is_loopback_provider_base_url(base_url: Option<&str>) -> bool {
    let Some(base_url) = base_url else {
        return false;
    };
    let Ok(url) = url::Url::parse(base_url) else {
        return false;
    };
    let hostname = url.host_str().unwrap_or_default().to_lowercase();
    let hostname = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    hostname == "localhost"
        || hostname == "::1"
        || (hostname.len() == "127.0.0.1".len() && is_ipv4_loopback(hostname))
}

fn is_ipv4_loopback(hostname: &str) -> bool {
    let octets: Vec<&str> = hostname.split('.').collect();
    if octets.len() != 4 {
        return false;
    }
    octets
        .iter()
        .all(|octet| octet.chars().all(|ch| ch.is_ascii_digit()) && octet.parse::<u8>().is_ok())
        && octets[0] == "127"
}

/// Explicit `deployment` wins; otherwise infer from the base URL loopback.
pub fn resolve_provider_deployment(provider: &StoredProvider) -> ProviderDeployment {
    if let Some(deployment) = provider.deployment {
        return deployment;
    }
    if is_loopback_provider_base_url(Some(&provider.base_url)) {
        ProviderDeployment::Local
    } else {
        ProviderDeployment::Hosted
    }
}

pub fn is_local_provider_deployment(provider: &StoredProvider) -> bool {
    resolve_provider_deployment(provider) == ProviderDeployment::Local
}

// ===========================================================================
// Custom-provider ids (custom-provider-id.ts)
// ===========================================================================

pub fn is_custom_provider_id(provider_id: &str) -> bool {
    provider_id.starts_with(CUSTOM_PROVIDER_ID_PREFIX)
        && provider_id.len() > CUSTOM_PROVIDER_ID_PREFIX.len()
}

pub fn custom_provider_id(provider_id: &str) -> String {
    let normalized = provider_id.trim();
    if is_custom_provider_id(normalized) {
        normalized.to_string()
    } else {
        let slug = if normalized.is_empty() {
            "connection"
        } else {
            normalized
        };
        format!("{CUSTOM_PROVIDER_ID_PREFIX}{slug}")
    }
}

pub fn is_lmstudio_provider_id(provider_id: &str) -> bool {
    provider_id == "lmstudio" || provider_id == "custom:lmstudio"
}

pub fn is_ollama_provider_id(provider_id: &str) -> bool {
    provider_id == "ollama" || provider_id == "custom:ollama"
}

/// Expose only provider-authored reasoning Aiden deliberately supports.
pub fn should_expose_reasoning(provider_id: &str) -> bool {
    provider_id == crate::google::GOOGLE_PROVIDER_ID
        || is_lmstudio_provider_id(provider_id)
        || is_ollama_provider_id(provider_id)
}

// ===========================================================================
// Runtime URL / key policy (generation-runtime.ts)
// ===========================================================================

/// Anthropic-compatible providers drop a trailing `/v1` at generation time.
pub fn resolve_runtime_base_url(provider: &StoredProvider) -> String {
    let base_url = provider.base_url.trim_end_matches('/');
    if provider.kind == ProviderKind::Anthropic {
        base_url
            .strip_suffix("/v1")
            .map(String::from)
            .unwrap_or_else(|| base_url.to_string())
    } else {
        base_url.to_string()
    }
}

pub fn resolve_runtime_api_key(
    provider: &StoredProvider,
    stored_api_key: Option<&str>,
) -> Option<String> {
    if !provider.needs_key {
        return Some(PI_AUTH_COMPATIBILITY_TOKEN.to_string());
    }
    let key = stored_api_key.map(str::trim).filter(|key| !key.is_empty());
    key.map(String::from)
}

/// Suppress SDK-generated auth headers for explicitly keyless providers.
pub fn resolve_runtime_headers(provider: &StoredProvider) -> Option<Vec<(String, Option<String>)>> {
    if provider.needs_key {
        return None;
    }
    if provider.kind == ProviderKind::Anthropic {
        Some(vec![
            ("Authorization".to_string(), None),
            ("x-api-key".to_string(), None),
        ])
    } else {
        Some(vec![("Authorization".to_string(), None)])
    }
}

// ===========================================================================
// Model record
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modality {
    Text,
    Image,
}

impl Modality {
    pub fn as_str(&self) -> &'static str {
        match self {
            Modality::Text => "text",
            Modality::Image => "image",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// The runtime `Model<Api>` record (pi `Model`).
#[derive(Debug, Clone)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub api: ApiFamily,
    pub provider: String,
    pub base_url: String,
    pub reasoning: bool,
    pub thinking_level_map: Option<HashMap<String, Option<String>>>,
    pub input: Vec<Modality>,
    pub cost: ModelCost,
    pub context_window: u32,
    pub max_tokens: u32,
    pub headers: HashMap<String, String>,
}

// ===========================================================================
// Runtime limits (models-catalog-core.ts)
// ===========================================================================

#[derive(Debug, Clone, Default)]
pub struct RuntimeModelMetadata {
    pub context_window: Option<u32>,
    pub max_tokens: Option<u32>,
    pub reasoning: Option<bool>,
    pub input: Option<Vec<Modality>>,
    pub thinking_level_map: Option<HashMap<String, Option<String>>>,
    pub force_adaptive_thinking: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct RuntimeModelLimits {
    pub context_window: u32,
    pub max_tokens: u32,
    pub reasoning: bool,
    pub input: Vec<Modality>,
    pub thinking_level_map: Option<HashMap<String, Option<String>>>,
    pub force_adaptive_thinking: bool,
}

pub fn conservative_runtime_limits() -> RuntimeModelLimits {
    RuntimeModelLimits {
        context_window: 128_000,
        max_tokens: 8_192,
        reasoning: false,
        input: vec![Modality::Text],
        thinking_level_map: None,
        force_adaptive_thinking: false,
    }
}

/// Map Aiden's stored provider ids to the shared models.dev slugs.
pub fn catalog_provider_slug(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "openai" | "openai-codex" => Some("openai"),
        "anthropic" => Some("anthropic"),
        "gemini" | "google" => Some("google"),
        "deepseek" => Some("deepseek"),
        "moonshot" | "moonshotai" => Some("moonshotai"),
        _ => None,
    }
}

fn normalize_id(id: &str) -> String {
    match id.rsplit_once('/') {
        Some((_, tail)) => tail.to_lowercase(),
        None => id.to_lowercase(),
    }
}

/// `resolveRuntimeLimits` — exact metadata, then the provider-scoped bundled
/// models.dev snapshot, then conservative fallback.
pub fn resolve_runtime_limits(
    catalog: Option<&serde_json::Value>,
    provider_id: &str,
    model_id: &str,
    exact: Option<&RuntimeModelMetadata>,
) -> RuntimeModelLimits {
    let (context_window, max_tokens, reasoning, vision) =
        resolve_catalog_fields(catalog, provider_id, model_id);
    let exact_vision = exact
        .and_then(|e| e.input.as_ref())
        .map(|input| input.contains(&Modality::Image));
    let vision = exact_vision.or(vision).unwrap_or(false);
    let conservative = conservative_runtime_limits();
    let mut limits = RuntimeModelLimits {
        context_window: exact
            .and_then(|e| e.context_window)
            .or(context_window)
            .unwrap_or(conservative.context_window),
        max_tokens: exact
            .and_then(|e| e.max_tokens)
            .or(max_tokens)
            .unwrap_or(conservative.max_tokens),
        reasoning: exact
            .and_then(|e| e.reasoning)
            .or(reasoning)
            .unwrap_or(conservative.reasoning),
        input: if vision {
            vec![Modality::Text, Modality::Image]
        } else {
            vec![Modality::Text]
        },
        thinking_level_map: None,
        force_adaptive_thinking: false,
    };
    if let Some(exact) = exact {
        if exact.thinking_level_map.is_some() {
            limits.thinking_level_map = exact.thinking_level_map.clone();
        }
        if let Some(force) = exact.force_adaptive_thinking {
            limits.force_adaptive_thinking = force;
        }
    }
    limits
}

fn resolve_catalog_fields(
    catalog: Option<&serde_json::Value>,
    provider_id: &str,
    model_id: &str,
) -> (Option<u32>, Option<u32>, Option<bool>, Option<bool>) {
    let Some(catalog) = catalog else {
        return (None, None, None, None);
    };
    let Some(slug) = catalog_provider_slug(provider_id) else {
        return (None, None, None, None);
    };
    let Some(provider) = catalog.get(slug).and_then(|v| v.as_object()) else {
        return (None, None, None, None);
    };
    let Some(models) = provider.get("models").and_then(|v| v.as_object()) else {
        return (None, None, None, None);
    };
    let exact_lower = model_id.to_lowercase();
    let normalized = normalize_id(model_id);
    let Some(raw) = models
        .iter()
        .find(|(key, _)| key.to_lowercase() == exact_lower)
        .map(|(_, value)| value)
        .or_else(|| {
            models
                .iter()
                .find(|(key, _)| normalize_id(key) == normalized)
                .map(|(_, value)| value)
        })
    else {
        return (None, None, None, None);
    };
    let limit = raw.get("limit");
    let context = limit
        .and_then(|l| l.get("context"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let max_tokens = limit
        .and_then(|l| l.get("output"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let reasoning = raw.get("reasoning").and_then(|v| v.as_bool());
    let modalities = raw
        .get("modalities")
        .and_then(|m| m.get("input"))
        .and_then(|v| v.as_array());
    // Mirrors the TS `resolveRuntimeLimits` vision precedence: the models.dev
    // `attachment` flag is the first vision signal, then `modalities.input`.
    let attachment = raw.get("attachment").and_then(|v| v.as_bool());
    let modality_vision = modalities.map(|inputs| inputs.iter().any(|entry| entry == "image"));
    let vision = if attachment == Some(true) || modality_vision == Some(true) {
        Some(true)
    } else if attachment == Some(false) || modality_vision.is_some() {
        Some(false)
    } else {
        None
    };
    (context, max_tokens, reasoning, vision)
}

/// Pi-exact builtin metadata for a native provider model (`model-runtime.ts`
/// builds `piExact` from `providerRegistry.models.getModel(piProviderId, id)`;
/// here the [`crate::builtin`] snapshot is that source of truth).
pub fn builtin_runtime_metadata(provider_id: &str, model_id: &str) -> Option<RuntimeModelMetadata> {
    let model = crate::builtin::builtin_model(provider_id, model_id)?;
    Some(RuntimeModelMetadata {
        context_window: Some(model.context_window),
        max_tokens: Some(model.max_tokens),
        reasoning: Some(model.reasoning),
        input: Some(if model.vision {
            vec![Modality::Text, Modality::Image]
        } else {
            vec![Modality::Text]
        }),
        thinking_level_map: (!model.thinking_level_map.is_empty()).then(|| {
            model
                .thinking_level_map
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.map(str::to_string)))
                .collect()
        }),
        force_adaptive_thinking: model.force_adaptive_thinking.then_some(true),
    })
}

/// `resolveProviderRuntimeLimits` — discovered metadata overrides, then the
/// models.dev capability catalog, then builtin pi-exact metadata survives.
///
/// Priority chain: discovered > models.dev catalog > builtin > conservative.
/// The catalog is the richest bundled source (`resources/model-capabilities.json`
/// built by `npm run models:refresh`), so it outranks the static
/// [`crate::builtin`] snapshot while discovered metadata (reported by the
/// provider connection itself) still wins.
pub fn resolve_provider_runtime_limits(
    catalog: Option<&crate::model_capabilities::ModelCapabilitiesCatalog>,
    provider: &StoredProvider,
    model_id: &str,
    pi_exact: Option<&RuntimeModelMetadata>,
) -> RuntimeModelLimits {
    let runtime_slug = catalog_provider_slug(&provider.id);
    // Mirrors `model-runtime.ts`: piExact is only consulted for providers that
    // map to a pi/models.dev slug; the builtin snapshot is that source.
    let pi_exact = match pi_exact {
        Some(exact) => Some(exact.clone()),
        None if runtime_slug.is_some() => builtin_runtime_metadata(&provider.id, model_id),
        None => None,
    };
    let discovered = provider
        .model_metadata
        .as_ref()
        .and_then(|metadata| metadata.get(model_id))
        .map(discovered_runtime_metadata);
    let from_catalog = catalog
        .and_then(|catalog| {
            crate::model_capabilities::lookup_model(catalog, &provider.id, model_id)
        })
        .map(|capability| catalog_runtime_metadata(&capability));
    let merged = merge_limits_chain(discovered, from_catalog, pi_exact);
    // The catalog is already folded into `merged`, so the raw-JSON field
    // fallback is no longer consulted.
    resolve_runtime_limits(None, "", model_id, merged.as_ref())
}

/// Merge three layers with strict precedence — each earlier layer fills in
/// whatever the next one omits (`primary.or(fallback)` field-wise).
fn merge_limits_chain(
    discovered: Option<RuntimeModelMetadata>,
    from_catalog: Option<RuntimeModelMetadata>,
    builtin: Option<RuntimeModelMetadata>,
) -> Option<RuntimeModelMetadata> {
    let catalog_layer = match (discovered, from_catalog) {
        (Some(discovered), Some(from_catalog)) => {
            Some(merge_runtime_metadata(discovered, from_catalog))
        }
        (Some(discovered), None) => Some(discovered),
        (None, Some(from_catalog)) => Some(from_catalog),
        (None, None) => None,
    };
    match (catalog_layer, builtin) {
        (Some(primary), Some(fallback)) => Some(merge_runtime_metadata(primary, fallback)),
        (Some(primary), None) => Some(primary),
        (None, Some(fallback)) => Some(fallback),
        (None, None) => None,
    }
}

/// Project a models.dev capability row into the runtime metadata shape. The
/// catalog explicitly declares reasoning and vision (`attachment`), so those
/// fields are always known (`Some`) when the row exists.
fn catalog_runtime_metadata(
    capability: &crate::model_capabilities::ModelCapability,
) -> RuntimeModelMetadata {
    RuntimeModelMetadata {
        context_window: capability.context_length(),
        max_tokens: capability.max_output(),
        reasoning: Some(capability.reasoning),
        input: Some(if capability.accepts_images() {
            vec![Modality::Text, Modality::Image]
        } else {
            vec![Modality::Text]
        }),
        ..Default::default()
    }
}

/// Request-time limits without a models.dev catalog or discovered metadata:
/// pi-exact builtin metadata when the provider id is a native slug, otherwise
/// the conservative fallback (`buildModel` in `model-runtime-core.ts`).
pub fn provider_runtime_limits_for_request(
    provider_id: &str,
    kind: ProviderKind,
    model_id: &str,
) -> RuntimeModelLimits {
    let stored = StoredProvider {
        id: provider_id.to_string(),
        kind,
        label: String::new(),
        base_url: String::new(),
        models: Vec::new(),
        model_metadata: None,
        default_model: None,
        needs_key: true,
        deployment: None,
        is_preset: None,
        is_builtin: None,
    };
    resolve_provider_runtime_limits(None, &stored, model_id, None)
}

fn discovered_runtime_metadata(metadata: &ProviderModelMetadata) -> RuntimeModelMetadata {
    RuntimeModelMetadata {
        context_window: metadata.context_length,
        reasoning: metadata.reasoning,
        input: metadata.vision.map(|vision| {
            if vision {
                vec![Modality::Text, Modality::Image]
            } else {
                vec![Modality::Text]
            }
        }),
        ..Default::default()
    }
}

fn merge_runtime_metadata(
    primary: RuntimeModelMetadata,
    fallback: RuntimeModelMetadata,
) -> RuntimeModelMetadata {
    RuntimeModelMetadata {
        context_window: primary.context_window.or(fallback.context_window),
        max_tokens: primary.max_tokens.or(fallback.max_tokens),
        reasoning: primary.reasoning.or(fallback.reasoning),
        input: primary.input.or(fallback.input),
        thinking_level_map: primary.thinking_level_map.or(fallback.thinking_level_map),
        force_adaptive_thinking: primary
            .force_adaptive_thinking
            .or(fallback.force_adaptive_thinking),
    }
}

// ===========================================================================
// Runtime resolution (model-runtime-core.ts)
// ===========================================================================

/// Which provider family serves a resolved model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamDispatch {
    Anthropic,
    Google,
    OpenAICompletions,
    OpenAIResponses,
    Codex,
}

#[derive(Debug, Clone)]
pub struct ResolvedModelRuntime {
    pub provider: StoredProvider,
    pub model: Model,
    pub api_key: Option<String>,
    pub headers: Option<Vec<(String, Option<String>)>>,
    pub dispatch: StreamDispatch,
}

/// Pi-owned native provider lookup.
pub type ProviderLookup = Box<dyn Fn(&str) -> Option<StoredProvider> + Send + Sync>;
/// Pi-owned native model lookup.
pub type ModelLookup = Box<dyn Fn(&str, &str) -> Option<Model> + Send + Sync>;
/// Stored API-key lookup.
pub type ApiKeyLookup = Box<dyn Fn(&StoredProvider) -> Option<String> + Send + Sync>;
/// Runtime-limit resolution.
pub type LimitsLookup = Box<dyn Fn(&StoredProvider, &str) -> RuntimeModelLimits + Send + Sync>;
/// Codex model availability check.
pub type CodexModelCheck = Box<dyn Fn(&str) -> bool + Send + Sync>;

/// Pi-owned native model lookups (builtin catalog).
#[derive(Default)]
pub struct NativeModelSet {
    pub get_provider: Option<ProviderLookup>,
    pub get_model: Option<ModelLookup>,
}

/// Electron-free resolver dependencies (mirrors `ModelRuntimeDependencies`).
pub struct ModelRuntimeDeps {
    pub get_provider: ProviderLookup,
    pub get_api_key: ApiKeyLookup,
    pub resolve_runtime_limits: LimitsLookup,
    /// Codex model availability (pi builtin catalog); `None` = all unavailable.
    pub codex_model_available: CodexModelCheck,
    pub native: NativeModelSet,
}

fn codex_runtime_provider() -> StoredProvider {
    StoredProvider {
        id: crate::codex::OPENAI_CODEX_PROVIDER_ID.to_string(),
        kind: ProviderKind::Openai,
        label: crate::codex::OPENAI_CODEX_PROVIDER_LABEL.to_string(),
        base_url: crate::codex::OPENAI_CODEX_BASE_URL.to_string(),
        models: Vec::new(),
        model_metadata: None,
        default_model: None,
        needs_key: true,
        deployment: None,
        is_preset: Some(true),
        is_builtin: None,
    }
}

fn model_from_limits(
    provider: &StoredProvider,
    model_id: &str,
    api: ApiFamily,
    limits: RuntimeModelLimits,
) -> Model {
    Model {
        id: model_id.to_string(),
        name: model_id.to_string(),
        api,
        provider: provider.id.clone(),
        base_url: resolve_runtime_base_url(provider),
        reasoning: limits.reasoning,
        thinking_level_map: limits.thinking_level_map.clone(),
        input: limits.input.clone(),
        cost: ModelCost::default(),
        context_window: limits.context_window,
        max_tokens: limits.max_tokens,
        headers: HashMap::new(),
    }
}

/// `resolveModelRuntimeWith` — the single routing funnel:
/// codex family → pi built-ins → custom connections.
pub fn resolve_model_runtime(
    deps: &ModelRuntimeDeps,
    provider_id: &str,
    model_id: &str,
) -> Result<ResolvedModelRuntime, ProviderError> {
    if provider_id == crate::codex::OPENAI_CODEX_PROVIDER_ID {
        if !(deps.codex_model_available)(model_id) {
            return Err(ProviderError::Config(format!(
                "Model \"{model_id}\" is not available through Pi's {} provider. Choose another model and try again.",
                crate::codex::OPENAI_CODEX_PROVIDER_LABEL
            )));
        }
        let provider = codex_runtime_provider();
        let limits = (deps.resolve_runtime_limits)(&provider, model_id);
        let model = model_from_limits(&provider, model_id, ApiFamily::OpenAICodexResponses, limits);
        return Ok(ResolvedModelRuntime {
            provider,
            model,
            api_key: None,
            headers: None,
            dispatch: StreamDispatch::Codex,
        });
    }

    if let Some(native_provider) = deps
        .native
        .get_provider
        .as_ref()
        .and_then(|get| get(provider_id))
    {
        let model = deps
            .native
            .get_model
            .as_ref()
            .and_then(|get| get(provider_id, model_id));
        let Some(model) = model else {
            return Err(ProviderError::Config(format!(
                "Model \"{model_id}\" is not available through Pi's {} provider. Choose another model and try again.",
                native_provider.label
            )));
        };
        let dispatch = dispatch_for_api(model.api);
        return Ok(ResolvedModelRuntime {
            provider: native_provider,
            model,
            api_key: None,
            headers: None,
            dispatch,
        });
    }

    let provider = (deps.get_provider)(provider_id)
        .ok_or_else(|| ProviderError::Config(format!("Provider \"{provider_id}\" not found.")))?;
    if !provider.models.contains(&model_id.to_string()) {
        return Err(ProviderError::Config(format!(
            "Model \"{model_id}\" is no longer available for {}. Choose another model and try again.",
            provider.label
        )));
    }
    let stored_api_key = if provider.needs_key {
        (deps.get_api_key)(&provider)
    } else {
        None
    };
    let api_key = resolve_runtime_api_key(&provider, stored_api_key.as_deref());
    if provider.needs_key && api_key.is_none() {
        return Err(ProviderError::Config(format!(
            "No API key set for {}. Add one in Settings → Providers.",
            provider.label
        )));
    }
    let limits = (deps.resolve_runtime_limits)(&provider, model_id);
    let api = match provider.kind {
        ProviderKind::Anthropic => ApiFamily::AnthropicMessages,
        ProviderKind::Openai => ApiFamily::OpenAICompletions,
    };
    let model = model_from_limits(&provider, model_id, api, limits);
    let headers = resolve_runtime_headers(&provider);
    let dispatch = dispatch_for_api(model.api);
    Ok(ResolvedModelRuntime {
        provider,
        model,
        api_key,
        headers,
        dispatch,
    })
}

fn dispatch_for_api(api: ApiFamily) -> StreamDispatch {
    match api {
        ApiFamily::AnthropicMessages => StreamDispatch::Anthropic,
        ApiFamily::GoogleGenerativeAi => StreamDispatch::Google,
        ApiFamily::OpenAICompletions => StreamDispatch::OpenAICompletions,
        ApiFamily::OpenAIResponses => StreamDispatch::OpenAIResponses,
        ApiFamily::OpenAICodexResponses => StreamDispatch::Codex,
    }
}

// ===========================================================================
// Base URL normalization (models.ts)
// ===========================================================================

/// Validate connection URLs before they are persisted or used for discovery.
pub fn normalize_provider_base_url(value: &str) -> Result<String, ProviderError> {
    let input = value.trim();
    let Ok(url) = url::Url::parse(input) else {
        return Err(ProviderError::Config(
            "Enter a valid HTTP(S) base URL.".into(),
        ));
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ProviderError::Config(
            "Provider URLs must use HTTP or HTTPS.".into(),
        ));
    }
    if url.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(ProviderError::Config(
            "Provider URL must include a host.".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ProviderError::Config(
            "Put credentials in the API key field, not the URL.".into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ProviderError::Config(
            "Provider URL cannot include a query string or fragment.".into(),
        ));
    }
    let trimmed_path = url.path().trim_end_matches('/');
    let mut normalized = url.clone();
    normalized.set_path(trimmed_path);
    normalized.set_query(None);
    normalized.set_fragment(None);
    let mut text = normalized.to_string();
    text = text.trim_end_matches('/').to_string();
    Ok(text)
}

// ===========================================================================
// Model discovery parsers (models.ts, pure)
// ===========================================================================

/// `DiscoveredModels` from a generic OpenAI-style `/models` response.
pub fn parse_generic_response(value: &serde_json::Value) -> Option<DiscoveredModels> {
    let entries = value
        .get("data")
        .and_then(|v| v.as_array())
        .or_else(|| value.get("models").and_then(|v| v.as_array()))?;
    Some(normalize_discovery(entries))
}

#[derive(Debug, Clone)]
pub struct DiscoveredModels {
    pub models: Vec<String>,
    pub model_metadata: HashMap<String, ProviderModelMetadata>,
}

fn capability_flags(value: &serde_json::Value) -> (Option<bool>, Option<bool>, Option<bool>, bool) {
    if let Some(array) = value.as_array() {
        let capabilities: Vec<String> = array
            .iter()
            .filter_map(|entry| entry.as_str())
            .map(|entry| entry.to_lowercase())
            .collect();
        let has = |name: &str| capabilities.iter().any(|entry| entry == name);
        return (
            has("vision").then_some(true),
            (has("tools") || has("tool_use")).then_some(true),
            (has("reasoning") || has("thinking")).then_some(true),
            has("embedding") || has("embeddings"),
        );
    }
    let Some(object) = value.as_object() else {
        return (None, None, None, false);
    };
    let vision = object.get("vision").and_then(|v| v.as_bool());
    let tool_call = object
        .get("trained_for_tool_use")
        .and_then(|v| v.as_bool())
        .or_else(|| object.get("tool_use").and_then(|v| v.as_bool()));
    let reasoning = object
        .get("reasoning")
        .map(|v| v.as_bool().unwrap_or(false))
        .or_else(|| object.get("thinking").and_then(|v| v.as_bool()));
    (vision, tool_call, reasoning, false)
}

fn finite_positive(value: &serde_json::Value) -> Option<u32> {
    value.as_u64().map(|v| v as u32).filter(|v| *v > 0)
}

fn generic_metadata(entry: &serde_json::Value) -> ProviderModelMetadata {
    let (vision, tool_call, reasoning, embedding) = entry
        .get("capabilities")
        .map(capability_flags)
        .unwrap_or((None, None, None, false));
    let raw_type = entry
        .get("type")
        .and_then(|v| v.as_str())
        .map(str::to_lowercase);
    let quantization = entry.get("quantization").and_then(|v| {
        if let Some(name) = v.as_str() {
            Some(name.to_string())
        } else {
            v.get("name").and_then(|n| n.as_str()).map(String::from)
        }
    });
    let model_type = if raw_type
        .as_deref()
        .map(|t| t.contains("embed"))
        .unwrap_or(false)
        || embedding
    {
        Some(ProviderModelType::Embedding)
    } else if raw_type.as_deref() == Some("llm") || raw_type.as_deref() == Some("vlm") {
        Some(ProviderModelType::Llm)
    } else {
        None
    };
    ProviderModelMetadata {
        source: "provider".to_string(),
        name: entry
            .get("display_name")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("name").and_then(|v| v.as_str()))
            .map(String::from),
        r#type: model_type,
        vision,
        tool_call,
        reasoning,
        thinking_levels: None,
        thinking_can_disable: None,
        context_length: entry
            .get("max_context_length")
            .and_then(finite_positive)
            .or_else(|| entry.get("context_length").and_then(finite_positive)),
        parameter_count: entry
            .get("params_string")
            .and_then(|v| v.as_str())
            .map(String::from),
        format: quantization.or_else(|| {
            entry
                .get("format")
                .and_then(|v| v.as_str())
                .map(String::from)
        }),
    }
}

fn normalize_discovery(entries: &[serde_json::Value]) -> DiscoveredModels {
    let mut metadata: HashMap<String, ProviderModelMetadata> = HashMap::new();
    for entry in entries {
        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("key").and_then(|v| v.as_str()))
            .or_else(|| entry.get("name").and_then(|v| v.as_str()));
        let Some(id) = id else {
            continue;
        };
        metadata.insert(id.to_string(), generic_metadata(entry));
    }
    let mut models: Vec<String> = metadata
        .iter()
        .filter(|(_, metadata)| metadata.r#type != Some(ProviderModelType::Embedding))
        .map(|(id, _)| id.clone())
        .collect();
    models.sort();
    models.dedup();
    DiscoveredModels {
        models,
        model_metadata: metadata,
    }
}

/// `parseLmStudioResponse` — LM Studio extended `/api/v1/models`.
pub fn parse_lmstudio_response(value: &serde_json::Value) -> Option<DiscoveredModels> {
    let response = value.as_object()?;
    let models = response.get("models")?.as_array()?;
    let mut metadata: HashMap<String, ProviderModelMetadata> = HashMap::new();
    for entry in models {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let Some(key) = object.get("key").and_then(|v| v.as_str()) else {
            continue;
        };
        let (vision, tool_call, reasoning, _embedding) = object
            .get("capabilities")
            .map(capability_flags)
            .unwrap_or((None, None, None, false));
        let model_type = match object.get("type").and_then(|v| v.as_str()) {
            Some("embedding") => Some(ProviderModelType::Embedding),
            Some("llm") => Some(ProviderModelType::Llm),
            _ => None,
        };
        let quantization = object
            .get("quantization")
            .and_then(|v| v.as_object())
            .and_then(|q| q.get("name").and_then(|n| n.as_str()).map(String::from));
        metadata.insert(
            key.to_string(),
            ProviderModelMetadata {
                source: "lmstudio".to_string(),
                name: object
                    .get("display_name")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                r#type: model_type,
                vision,
                tool_call,
                reasoning,
                thinking_levels: None,
                thinking_can_disable: None,
                context_length: object.get("max_context_length").and_then(finite_positive),
                parameter_count: object
                    .get("params_string")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                format: quantization.or_else(|| {
                    object
                        .get("format")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                }),
            },
        );
    }
    let mut models: Vec<String> = metadata
        .iter()
        .filter(|(_, metadata)| metadata.r#type != Some(ProviderModelType::Embedding))
        .map(|(id, _)| id.clone())
        .collect();
    models.sort();
    Some(DiscoveredModels {
        models,
        model_metadata: metadata,
    })
}

/// Ollama `/api/tags` + `/api/show` metadata folding.
pub fn ollama_model_metadata(
    tag: &serde_json::Value,
    detail: &serde_json::Value,
) -> Option<(String, ProviderModelMetadata)> {
    let tag_object = tag.as_object()?;
    let id = tag_object
        .get("model")
        .and_then(|v| v.as_str())
        .or_else(|| tag_object.get("name").and_then(|v| v.as_str()))?
        .to_string();
    let (vision, tool_call, reasoning, embedding) = detail
        .get("capabilities")
        .map(capability_flags)
        .unwrap_or((None, None, None, false));
    let context_length = detail
        .get("model_info")
        .and_then(|info| info.as_object())
        .and_then(|info| {
            info.iter()
                .filter(|(key, value)| {
                    key.ends_with(".context_length") && finite_positive(value).is_some()
                })
                .filter_map(|(_, value)| value.as_u64())
                .max()
                .map(|v| v as u32)
        });
    let details = detail.get("details").or_else(|| tag_object.get("details"));
    let parameter_count = details
        .and_then(|d| d.get("parameter_size"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let format = details
        .and_then(|d| d.get("quantization_level"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            details
                .and_then(|d| d.get("format"))
                .and_then(|v| v.as_str())
        })
        .map(String::from);
    Some((
        id.clone(),
        ProviderModelMetadata {
            source: "ollama".to_string(),
            name: tag_object
                .get("name")
                .and_then(|v| v.as_str())
                .map(String::from),
            r#type: if embedding {
                Some(ProviderModelType::Embedding)
            } else {
                Some(ProviderModelType::Llm)
            },
            vision,
            tool_call,
            reasoning,
            thinking_levels: None,
            thinking_can_disable: None,
            context_length,
            parameter_count,
            format,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, kind: ProviderKind, base_url: &str) -> StoredProvider {
        StoredProvider {
            id: id.to_string(),
            kind,
            label: id.to_string(),
            base_url: base_url.to_string(),
            models: vec!["m1".to_string()],
            model_metadata: None,
            default_model: None,
            needs_key: true,
            deployment: None,
            is_preset: None,
            is_builtin: None,
        }
    }

    #[test]
    fn deployment_rules_follow_base_url_and_override() {
        let local = provider("custom:x", ProviderKind::Openai, "http://127.0.0.1:1234/v1");
        assert_eq!(
            resolve_provider_deployment(&local),
            ProviderDeployment::Local
        );
        let tailscale = provider("custom:t", ProviderKind::Openai, "http://100.64.0.1:8080");
        assert_eq!(
            resolve_provider_deployment(&tailscale),
            ProviderDeployment::Hosted
        );
        let mut forced = tailscale.clone();
        forced.deployment = Some(ProviderDeployment::Local);
        assert_eq!(
            resolve_provider_deployment(&forced),
            ProviderDeployment::Local
        );
        assert!(is_loopback_provider_base_url(Some(
            "http://localhost:11434"
        )));
        assert!(is_loopback_provider_base_url(Some("http://[::1]:8080")));
        assert!(!is_loopback_provider_base_url(Some(
            "https://api.openai.com/v1"
        )));
        assert!(!is_loopback_provider_base_url(None));
    }

    #[test]
    fn custom_provider_id_helpers() {
        assert!(is_custom_provider_id("custom:lmstudio"));
        assert!(!is_custom_provider_id("custom:"));
        assert!(!is_custom_provider_id("lmstudio"));
        assert_eq!(custom_provider_id("lmstudio"), "custom:lmstudio");
        assert_eq!(custom_provider_id("custom:ollama"), "custom:ollama");
        assert_eq!(custom_provider_id(""), "custom:connection");
        assert!(is_lmstudio_provider_id("lmstudio"));
        assert!(is_lmstudio_provider_id("custom:lmstudio"));
        assert!(is_ollama_provider_id("custom:ollama"));
        assert!(should_expose_reasoning("google"));
        assert!(should_expose_reasoning("custom:ollama"));
        assert!(!should_expose_reasoning("openai-codex"));
    }

    #[test]
    fn runtime_url_and_key_policy() {
        let anthropic = provider(
            "custom:a",
            ProviderKind::Anthropic,
            "https://proxy.example/v1",
        );
        assert_eq!(
            resolve_runtime_base_url(&anthropic),
            "https://proxy.example"
        );
        let openai = provider("custom:o", ProviderKind::Openai, "https://api.example/v1/");
        assert_eq!(resolve_runtime_base_url(&openai), "https://api.example/v1");

        let keyless = provider("custom:o", ProviderKind::Openai, "http://127.0.0.1:8080");
        let keyless = StoredProvider {
            needs_key: false,
            ..keyless
        };
        assert_eq!(
            resolve_runtime_api_key(&keyless, None).as_deref(),
            Some(PI_AUTH_COMPATIBILITY_TOKEN)
        );
        assert_eq!(
            resolve_runtime_api_key(&keyless, Some("  ")),
            Some(PI_AUTH_COMPATIBILITY_TOKEN.to_string())
        );
        assert_eq!(
            resolve_runtime_api_key(&provider("x", ProviderKind::Openai, "u"), Some(" k "))
                .as_deref(),
            Some("k")
        );
        assert_eq!(
            resolve_runtime_api_key(&provider("x", ProviderKind::Openai, "u"), None),
            None
        );

        let headers = resolve_runtime_headers(&keyless).unwrap();
        assert_eq!(headers, vec![("Authorization".to_string(), None)]);
        let keyless_anthropic = StoredProvider {
            needs_key: false,
            kind: ProviderKind::Anthropic,
            ..keyless
        };
        let headers = resolve_runtime_headers(&keyless_anthropic).unwrap();
        assert_eq!(
            headers,
            vec![
                ("Authorization".to_string(), None),
                ("x-api-key".to_string(), None)
            ]
        );
        assert!(resolve_runtime_headers(&provider("x", ProviderKind::Openai, "u")).is_none());
    }

    #[test]
    fn base_url_normalization() {
        assert_eq!(
            normalize_provider_base_url(" https://api.example.com/v1/ ").unwrap(),
            "https://api.example.com/v1"
        );
        assert!(normalize_provider_base_url("ftp://x").is_err());
        assert!(normalize_provider_base_url("https://user:pass@host").is_err());
        assert!(normalize_provider_base_url("https://host?q=1").is_err());
        assert!(normalize_provider_base_url("not a url").is_err());
    }

    #[test]
    fn catalog_slug_and_limits() {
        assert_eq!(catalog_provider_slug("openai-codex"), Some("openai"));
        assert_eq!(catalog_provider_slug("gemini"), Some("google"));
        assert_eq!(catalog_provider_slug("custom:x"), None);

        let catalog = serde_json::json!({
            "anthropic": {
                "models": {
                    "claude-sonnet-5": {
                        "name": "Claude Sonnet 5",
                        "reasoning": true,
                        "modalities": { "input": ["text", "image"], "output": ["text"] },
                        "limit": { "context": 200000, "output": 64000 }
                    }
                }
            }
        });
        let limits = resolve_runtime_limits(Some(&catalog), "anthropic", "claude-sonnet-5", None);
        assert_eq!(limits.context_window, 200_000);
        assert_eq!(limits.max_tokens, 64_000);
        assert!(limits.reasoning);
        assert!(limits.input.contains(&Modality::Image));

        // Conservative fallback for unknown models.
        let fallback = resolve_runtime_limits(Some(&catalog), "custom:x", "unknown", None);
        assert_eq!(
            fallback.context_window,
            conservative_runtime_limits().context_window
        );
        assert!(!fallback.reasoning);
    }

    #[test]
    fn exact_metadata_wins_over_catalog() {
        let exact = RuntimeModelMetadata {
            context_window: Some(10_000),
            reasoning: Some(false),
            thinking_level_map: Some(HashMap::new()),
            force_adaptive_thinking: Some(true),
            ..Default::default()
        };
        let limits = resolve_runtime_limits(None, "custom:x", "m", Some(&exact));
        assert_eq!(limits.context_window, 10_000);
        assert!(!limits.reasoning);
        assert!(limits.force_adaptive_thinking);
    }

    #[test]
    fn generic_discovery_parses_models_responses() {
        let value = serde_json::json!({
            "data": [
                {"id": "llama-3.1", "display_name": "Llama 3.1", "type": "llm",
                 "max_context_length": 128000, "capabilities": ["vision", "tools"]},
                {"id": "embed-model", "type": "embedding"},
                {"key": "no-id-key", "type": "llm"}
            ]
        });
        let discovered = parse_generic_response(&value).unwrap();
        assert_eq!(discovered.models, vec!["llama-3.1", "no-id-key"]);
        let metadata = &discovered.model_metadata["llama-3.1"];
        assert_eq!(metadata.context_length, Some(128_000));
        assert_eq!(metadata.vision, Some(true));
        assert_eq!(metadata.tool_call, Some(true));
        assert_eq!(metadata.source, "provider");
    }

    #[test]
    fn lmstudio_discovery_parses_extended_fields() {
        let value = serde_json::json!({
            "models": [
                {"key": "qwen2.5", "display_name": "Qwen", "type": "llm",
                 "max_context_length": 32768, "params_string": "7B",
                 "quantization": {"name": "Q4_K_M"},
                 "capabilities": {"reasoning": true, "vision": false}}
            ]
        });
        let discovered = parse_lmstudio_response(&value).unwrap();
        let metadata = &discovered.model_metadata["qwen2.5"];
        assert_eq!(metadata.source, "lmstudio");
        assert_eq!(metadata.parameter_count.as_deref(), Some("7B"));
        assert_eq!(metadata.format.as_deref(), Some("Q4_K_M"));
        assert_eq!(metadata.reasoning, Some(true));
    }

    #[test]
    fn ollama_metadata_folds_show_response() {
        let tag = serde_json::json!({"model": "llama3.2", "name": "llama3.2:latest"});
        let detail = serde_json::json!({
            "capabilities": ["tools", "reasoning"],
            "details": {"parameter_size": "3B", "quantization_level": "Q4_K_M"},
            "model_info": {"llama.context_length": 131072, "other.context_length": 4096}
        });
        let (id, metadata) = ollama_model_metadata(&tag, &detail).unwrap();
        assert_eq!(id, "llama3.2");
        assert_eq!(metadata.source, "ollama");
        assert_eq!(metadata.context_length, Some(131_072));
        assert_eq!(metadata.tool_call, Some(true));
        assert_eq!(metadata.reasoning, Some(true));
        assert_eq!(metadata.format.as_deref(), Some("Q4_K_M"));
    }

    #[test]
    fn runtime_resolution_routes_custom_connections() {
        let stored = provider(
            "custom:lmstudio",
            ProviderKind::Openai,
            "http://127.0.0.1:1234/v1",
        );
        let stored_for_keyless = stored.clone();
        let deps = ModelRuntimeDeps {
            get_provider: Box::new(move |id| {
                (id == "custom:lmstudio").then_some(stored_for_keyless.clone())
            }),
            get_api_key: Box::new(|_| Some("key".to_string())),
            resolve_runtime_limits: Box::new(|_provider, _model| RuntimeModelLimits {
                context_window: 128_000,
                max_tokens: 8192,
                reasoning: true,
                input: vec![Modality::Text],
                thinking_level_map: None,
                force_adaptive_thinking: false,
            }),
            codex_model_available: Box::new(|_| false),
            native: NativeModelSet::default(),
        };
        let resolved = resolve_model_runtime(&deps, "custom:lmstudio", "m1").unwrap();
        assert_eq!(resolved.dispatch, StreamDispatch::OpenAICompletions);
        assert_eq!(resolved.api_key.as_deref(), Some("key"));
        assert_eq!(resolved.model.provider, "custom:lmstudio");
        assert!(resolved.model.reasoning);

        // Unknown provider → typed error message.
        let err = resolve_model_runtime(&deps, "custom:missing", "m1").unwrap_err();
        assert!(err.to_string().contains("not found"));

        // Keyless provider gets the compatibility token and no headers.
        let keyless = StoredProvider {
            needs_key: false,
            ..stored
        };
        let deps = ModelRuntimeDeps {
            get_provider: Box::new(move |_| Some(keyless.clone())),
            ..deps
        };
        let resolved = resolve_model_runtime(&deps, "custom:lmstudio", "m1").unwrap();
        assert_eq!(
            resolved.api_key.as_deref(),
            Some(PI_AUTH_COMPATIBILITY_TOKEN)
        );
        assert_eq!(resolved.headers.unwrap().len(), 1);
    }

    #[test]
    fn runtime_resolution_routes_codex_and_native() {
        let deps = ModelRuntimeDeps {
            get_provider: Box::new(|_| None),
            get_api_key: Box::new(|_| None),
            resolve_runtime_limits: Box::new(|_provider, _model| RuntimeModelLimits {
                context_window: 400_000,
                max_tokens: 32_000,
                reasoning: true,
                input: vec![Modality::Text, Modality::Image],
                thinking_level_map: None,
                force_adaptive_thinking: false,
            }),
            codex_model_available: Box::new(|id| id == "gpt-5.4"),
            native: NativeModelSet {
                get_provider: Some(Box::new(|id| {
                    (id == "anthropic").then_some(StoredProvider {
                        id: "anthropic".into(),
                        kind: ProviderKind::Openai,
                        label: "Anthropic".into(),
                        base_url: "https://api.anthropic.com/v1".into(),
                        models: vec![],
                        model_metadata: None,
                        default_model: None,
                        needs_key: true,
                        deployment: None,
                        is_preset: Some(true),
                        is_builtin: Some(true),
                    })
                })),
                get_model: Some(Box::new(|_provider, id| {
                    (id == "claude-sonnet-5").then_some(Model {
                        id: "claude-sonnet-5".into(),
                        name: "Claude Sonnet 5".into(),
                        api: ApiFamily::AnthropicMessages,
                        provider: "anthropic".into(),
                        base_url: "https://api.anthropic.com/v1".into(),
                        reasoning: true,
                        thinking_level_map: None,
                        input: vec![Modality::Text],
                        cost: ModelCost::default(),
                        context_window: 200_000,
                        max_tokens: 64_000,
                        headers: Default::default(),
                    })
                })),
            },
        };
        let codex = resolve_model_runtime(&deps, "openai-codex", "gpt-5.4").unwrap();
        assert_eq!(codex.dispatch, StreamDispatch::Codex);
        assert_eq!(codex.provider.id, "openai-codex");

        let native = resolve_model_runtime(&deps, "anthropic", "claude-sonnet-5").unwrap();
        assert_eq!(native.dispatch, StreamDispatch::Anthropic);
        assert_eq!(native.model.context_window, 200_000);

        let err = resolve_model_runtime(&deps, "openai-codex", "gpt-3.5").unwrap_err();
        assert!(err.to_string().contains("not available through Pi's"));
        let err = resolve_model_runtime(&deps, "anthropic", "claude-haiku").unwrap_err();
        assert!(err.to_string().contains("not available through Pi's"));
    }

    #[test]
    fn stored_provider_serializes_with_camel_case() {
        let stored = provider("custom:x", ProviderKind::Openai, "http://127.0.0.1:1");
        let json = serde_json::to_string(&stored).unwrap();
        assert!(json.contains("\"baseUrl\""));
        assert!(json.contains("\"needsKey\""));
        assert!(!json.contains("base_url"));
        let back: StoredProvider = serde_json::from_str(&json).unwrap();
        assert_eq!(back, stored);
    }

    #[test]
    fn api_family_mapping_matches_the_ts_api_for() {
        // TS `apiFor` (model-runtime-core.ts): kind=anthropic → anthropic-messages,
        // every other kind → openai-completions.
        let anthropic_connection = provider(
            "custom:a",
            ProviderKind::Anthropic,
            "https://proxy.example/v1",
        );
        let openai_connection = provider("custom:o", ProviderKind::Openai, "https://x/v1");
        let deps = ModelRuntimeDeps {
            get_provider: Box::new(|_| None),
            get_api_key: Box::new(|_| Some("k".to_string())),
            resolve_runtime_limits: Box::new(|_provider, _model| RuntimeModelLimits {
                context_window: 128_000,
                max_tokens: 8192,
                reasoning: false,
                input: vec![Modality::Text],
                thinking_level_map: None,
                force_adaptive_thinking: false,
            }),
            codex_model_available: Box::new(|_| false),
            native: NativeModelSet {
                get_provider: Some(Box::new(|_| None)),
                get_model: None,
            },
        };
        let mut deps = deps;
        deps.get_provider = Box::new(move |id| {
            if id == "custom:a" {
                Some(anthropic_connection.clone())
            } else if id == "custom:o" {
                Some(openai_connection.clone())
            } else {
                None
            }
        });
        let resolved = resolve_model_runtime(&deps, "custom:a", "m1").unwrap();
        assert_eq!(resolved.model.api, ApiFamily::AnthropicMessages);
        assert_eq!(resolved.dispatch, StreamDispatch::Anthropic);
        let resolved = resolve_model_runtime(&deps, "custom:o", "m1").unwrap();
        assert_eq!(resolved.model.api, ApiFamily::OpenAICompletions);
        assert_eq!(resolved.dispatch, StreamDispatch::OpenAICompletions);
    }

    #[test]
    fn provider_runtime_limits_fall_back_to_builtin_pi_exact_metadata() {
        // `model-runtime.ts` passes the pi builtin model as `piExact`; the
        // builtin snapshot must reproduce that for the native providers.
        let anthropic = provider(
            "anthropic",
            ProviderKind::Openai,
            "https://api.anthropic.com/v1",
        );
        let limits = resolve_provider_runtime_limits(None, &anthropic, "claude-sonnet-5", None);
        assert_eq!(limits.context_window, 1_000_000);
        assert_eq!(limits.max_tokens, 128_000);
        assert!(limits.reasoning);
        assert!(limits.input.contains(&Modality::Image));
        let map = limits.thinking_level_map.as_ref().expect("thinking map");
        assert_eq!(map.get("xhigh"), Some(&Some("xhigh".to_string())));
        assert_eq!(map.get("max"), Some(&Some("max".to_string())));
        assert!(!limits.force_adaptive_thinking);

        // claude-fable-5: `compat.forceAdaptiveThinking` surfaces as the limit.
        let fable = resolve_provider_runtime_limits(None, &anthropic, "claude-fable-5", None);
        assert!(fable.force_adaptive_thinking);
        // off is nulled: thinking cannot be disabled.
        let map = fable.thinking_level_map.as_ref().unwrap();
        assert_eq!(map.get("off"), Some(&None));

        // Google: native provider id maps to google-generative-ai family data.
        let google = provider(
            "google",
            ProviderKind::Openai,
            "https://generativelanguage.googleapis.com/v1beta",
        );
        let gemma = resolve_provider_runtime_limits(None, &google, "gemma-4-31b-it", None);
        assert_eq!(gemma.context_window, 262_144);
        assert!(gemma.reasoning);

        // An unrelated custom provider must not borrow anthropic builtin data.
        let custom = provider("custom:x", ProviderKind::Openai, "http://127.0.0.1:1");
        let limits = resolve_provider_runtime_limits(None, &custom, "claude-sonnet-5", None);
        assert_eq!(
            limits.context_window,
            conservative_runtime_limits().context_window
        );
        assert!(limits.thinking_level_map.is_none());
    }

    #[test]
    fn codex_runtime_provider_matches_the_ts_codex_runtime_provider() {
        // TS `codexRuntimeProvider` (model-runtime-core.ts:20-28): same id,
        // kind "openai", label, base URL, empty models, keyed, preset.
        let deps = ModelRuntimeDeps {
            get_provider: Box::new(|_| None),
            get_api_key: Box::new(|_| None),
            resolve_runtime_limits: Box::new(|_provider, _model| RuntimeModelLimits {
                context_window: 272_000,
                max_tokens: 128_000,
                reasoning: true,
                input: vec![Modality::Text, Modality::Image],
                thinking_level_map: None,
                force_adaptive_thinking: false,
            }),
            codex_model_available: Box::new(|id| id == crate::codex::OPENAI_CODEX_DEFAULT_MODEL),
            native: NativeModelSet::default(),
        };
        let resolved = resolve_model_runtime(
            &deps,
            "openai-codex",
            crate::codex::OPENAI_CODEX_DEFAULT_MODEL,
        )
        .unwrap();
        assert_eq!(resolved.provider.id, crate::codex::OPENAI_CODEX_PROVIDER_ID);
        assert_eq!(resolved.provider.kind, ProviderKind::Openai);
        assert_eq!(
            resolved.provider.label,
            crate::codex::OPENAI_CODEX_PROVIDER_LABEL
        );
        assert_eq!(
            resolved.provider.base_url,
            crate::codex::OPENAI_CODEX_BASE_URL
        );
        assert!(resolved.provider.models.is_empty());
        assert!(resolved.provider.needs_key);
        assert_eq!(resolved.provider.is_preset, Some(true));
        assert_eq!(resolved.model.api, ApiFamily::OpenAICodexResponses);
        assert_eq!(resolved.dispatch, StreamDispatch::Codex);
        assert_eq!(resolved.api_key, None);
        assert!(resolved.headers.is_none());
    }

    #[test]
    fn provider_runtime_limits_merge_discovered_over_builtin() {
        let mut anthropic = provider(
            "anthropic",
            ProviderKind::Openai,
            "https://api.anthropic.com/v1",
        );
        anthropic.model_metadata = Some(HashMap::from([(
            "claude-sonnet-5".to_string(),
            ProviderModelMetadata {
                source: "provider".to_string(),
                context_length: Some(10_000),
                reasoning: Some(false),
                vision: Some(false),
                ..Default::default()
            },
        )]));
        // Discovered metadata wins (TS `mergeRuntimeMetadata(discovered, piExact)`),
        // while pi-exact fields the discovery did not report survive.
        let limits = resolve_provider_runtime_limits(None, &anthropic, "claude-sonnet-5", None);
        assert_eq!(limits.context_window, 10_000);
        assert!(!limits.reasoning);
        assert!(!limits.input.contains(&Modality::Image));
        assert_eq!(limits.max_tokens, 128_000, "builtin maxTokens survives");
        assert!(
            limits.thinking_level_map.is_some(),
            "builtin thinking map survives"
        );
    }

    #[test]
    fn catalog_runtime_limits_override_builtin_defaults() {
        use crate::model_capabilities::tests::fixture_catalog_json;
        use crate::model_capabilities::{lookup_provider, ModelCapabilitiesCatalog};

        let catalog: ModelCapabilitiesCatalog =
            serde_json::from_value(fixture_catalog_json()).expect("fixture parses");
        let anthropic = provider(
            "anthropic",
            ProviderKind::Openai,
            "https://api.anthropic.com/v1",
        );
        // The fixture catalog reports a *different* window for claude-sonnet-5
        // than the builtin snapshot (1M/128k): the catalog must win while the
        // builtin thinking map survives (the catalog has no thinking levels).
        let limits =
            resolve_provider_runtime_limits(Some(&catalog), &anthropic, "claude-sonnet-5", None);
        assert_eq!(limits.context_window, 900_000);
        assert_eq!(limits.max_tokens, 100_000);
        assert!(limits.reasoning);
        assert!(limits.input.contains(&Modality::Image));
        let map = limits
            .thinking_level_map
            .as_ref()
            .expect("builtin map survives");
        assert_eq!(map.get("xhigh"), Some(&Some("xhigh".to_string())));

        // A model that exists only in the catalog (not in builtin) resolves
        // from the catalog alone, never the conservative fallback.
        let only_catalog =
            resolve_provider_runtime_limits(Some(&catalog), &anthropic, "claude-sonnet-6", None);
        assert_eq!(only_catalog.context_window, 300_000);
        assert_eq!(only_catalog.max_tokens, 80_000);

        // Discovered metadata still outranks the catalog.
        let mut discovered = anthropic.clone();
        discovered.model_metadata = Some(HashMap::from([(
            "claude-sonnet-5".to_string(),
            ProviderModelMetadata {
                source: "provider".to_string(),
                context_length: Some(10_000),
                reasoning: Some(false),
                vision: Some(false),
                ..Default::default()
            },
        )]));
        let limits =
            resolve_provider_runtime_limits(Some(&catalog), &discovered, "claude-sonnet-5", None);
        assert_eq!(
            limits.context_window, 10_000,
            "discovered wins over catalog"
        );
        assert!(!limits.reasoning);
        assert!(!limits.input.contains(&Modality::Image));
        // The catalog still supplies the fields discovery did not report...
        assert_eq!(
            limits.max_tokens, 100_000,
            "catalog beats builtin maxTokens"
        );

        // Custom providers never borrow catalog data (no slug match).
        let custom = provider("custom:x", ProviderKind::Openai, "http://127.0.0.1:1");
        let limits =
            resolve_provider_runtime_limits(Some(&catalog), &custom, "claude-sonnet-5", None);
        assert_eq!(
            limits.context_window,
            conservative_runtime_limits().context_window
        );

        // Enrichment helper sanity: the catalog entry lists all three models.
        assert_eq!(
            lookup_provider(&catalog, "anthropic").map(|p| p.models.len()),
            Some(3)
        );
    }

    #[test]
    fn catalog_vision_uses_the_attachment_flag_like_ts() {
        // TS `resolveRuntimeLimits`: `attachment === true` counts as vision
        // even when `modalities.input` lacks an explicit "image" entry.
        let catalog = serde_json::json!({
            "anthropic": {
                "models": {
                    "attachment-only": {
                        "name": "Attachment Only",
                        "attachment": true,
                        "modalities": { "input": ["text", "pdf"] },
                        "limit": { "context": 200000, "output": 32000 }
                    },
                    "image-input": {
                        "name": "Image Input",
                        "attachment": false,
                        "modalities": { "input": ["text", "image"] }
                    },
                    "text-only": {
                        "name": "Text Only",
                        "attachment": false,
                        "modalities": { "input": ["text"] }
                    }
                }
            }
        });
        let limits = resolve_runtime_limits(Some(&catalog), "anthropic", "attachment-only", None);
        assert!(limits.input.contains(&Modality::Image));
        // `attachment === true || inputs include image` → vision (TS OR).
        let limits = resolve_runtime_limits(Some(&catalog), "anthropic", "image-input", None);
        assert!(limits.input.contains(&Modality::Image));
        // Explicit `attachment === false` with text-only input → no vision.
        let limits = resolve_runtime_limits(Some(&catalog), "anthropic", "text-only", None);
        assert!(!limits.input.contains(&Modality::Image));
    }

    #[test]
    fn request_limits_for_custom_providers_are_conservative() {
        // Custom connections have no catalog slug and no builtin row, so the
        // request path lands on `CONSERVATIVE_RUNTIME_LIMITS` (128k/8k).
        let limits =
            provider_runtime_limits_for_request("custom:lmstudio", ProviderKind::Openai, "m1");
        assert_eq!(limits.context_window, 128_000);
        assert_eq!(limits.max_tokens, 8_192);
        assert!(!limits.reasoning);
        assert!(limits.thinking_level_map.is_none());

        // Native anthropic models resolve pi-exact builtin data.
        let limits = provider_runtime_limits_for_request(
            "anthropic",
            ProviderKind::Anthropic,
            "claude-sonnet-5",
        );
        assert_eq!(limits.context_window, 1_000_000);
        assert!(limits.reasoning);
        assert!(limits.thinking_level_map.is_some());
    }
}
