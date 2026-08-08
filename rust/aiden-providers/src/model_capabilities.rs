//! models.dev model-capabilities catalog loader + parser.
//!
//! The Electron app reads `resources/model-capabilities.json` at runtime to
//! populate model pickers and resolve runtime limits. This module ports that
//! read path for the Rust app: a tolerant typed parser over the models.dev
//! snapshot schema (top-level object keyed by provider slug →
//! `{ id, name, doc, models: { modelId: { id, name, description, attachment,
//! reasoning, reasoning_options, tool_call, structured_output, limit:
//! { context, output }, cost: { input, output, ... }, ... } } }`).
//!
//! Per AGENTS.md this is build-time-only data: the Rust app only READS the
//! pre-built JSON (via `npm run models:refresh`), it never contacts models.dev.
//! Loading is best-effort — callers log and fall back to [`crate::builtin`]
//! when the file is absent (dev checkouts) or malformed. Parsing is tolerant:
//! unknown fields are ignored and missing fields default (`#[serde(default)]`
//! throughout).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The bundled snapshot filename (`resources/model-capabilities.json`).
pub const MODEL_CAPABILITIES_FILENAME: &str = "model-capabilities.json";

/// Top-level catalog: provider slug → provider model set. The file keys the
/// providers by their models.dev slug (`google`, `moonshotai`, ...), which
/// aliases in [`catalog_provider_alias`] normalize the Aiden ids to.
pub type ModelCapabilitiesCatalog = HashMap<String, ProviderModels>;

/// One provider's models (`{ id, name, doc, models }`).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ProviderModels {
    /// The models.dev provider id (mirrors the map key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Display name (`Anthropic`, `Google`, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// model id → capability row.
    pub models: HashMap<String, ModelCapability>,
}

/// The `limit` block: `limit.context` (input window) and `limit.output`
/// (max output tokens) are the numbers the runtime limits read.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ModelLimit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<u32>,
}

/// The `cost` block: per-million-token USD pricing. Unknown nested fields
/// (`tiers`, `context_over_200k`, ...) are ignored.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ModelPricing {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// One `reasoning_options` entry (`{ type: "effort", values: ["low", ...] }`).
/// `values` may contain `null` entries — models.dev marks reasoning levels the
/// model does not support with `null`, mirroring pi's thinking-level maps.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ReasoningOption {
    pub r#type: String,
    pub values: Vec<Option<String>>,
}

/// `modalities`: `input` (`["text", "image", "pdf", ...]`) and `output`.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ModelModalities {
    pub input: Vec<String>,
    pub output: Vec<String>,
}

/// One model capability row. Every field defaults so a partial row never
/// fails the whole catalog parse.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ModelCapability {
    /// The models.dev model id (mirrors the map key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Display name (`Claude Opus 4.8`, `Gemini 3 Pro Preview`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// Accepts attachments (images/pdf/...). The catalog's vision signal.
    pub attachment: bool,
    /// Native reasoning support.
    pub reasoning: bool,
    pub reasoning_options: Vec<ReasoningOption>,
    pub tool_call: bool,
    pub structured_output: bool,
    /// Context window + max output (`limit` block).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<ModelLimit>,
    /// Per-million-token pricing (`cost` block).
    #[serde(rename = "cost", skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modalities: Option<ModelModalities>,
    /// `"deprecated"` when the model has been deprecated by the vendor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

impl ModelCapability {
    /// `limit.context` — the input context window, when the snapshot reports it.
    pub fn context_length(&self) -> Option<u32> {
        self.limit.and_then(|limit| limit.context)
    }

    /// `limit.output` — the max output tokens, when the snapshot reports it.
    pub fn max_output(&self) -> Option<u32> {
        self.limit.and_then(|limit| limit.output)
    }

    /// The declared input modalities (`modalities.input`), e.g. `["text",
    /// "image", "pdf"]`.
    pub fn input_modalities(&self) -> &[String] {
        self.modalities
            .as_ref()
            .map(|modalities| modalities.input.as_slice())
            .unwrap_or_default()
    }

    /// Whether the model accepts image input (explicit `modalities.input`
    /// entry; `attachment` is the catalog's vision flag).
    pub fn accepts_images(&self) -> bool {
        self.attachment || self.input_modalities().iter().any(|entry| entry == "image")
    }
}

/// Loading failure: which path failed and why. The app never crashes on this —
/// callers log and fall back to the builtin snapshot.
#[derive(Debug, thiserror::Error)]
pub enum ModelCapabilitiesError {
    #[error("could not read model capabilities at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("could not parse model capabilities at {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
}

/// Parse the models.dev snapshot at `path` into the typed catalog. Any
/// provider entry with an unreadable shape degrades to its defaults; only a
/// file-level I/O or JSON failure is an error.
pub fn load_model_capabilities(
    path: &Path,
) -> Result<ModelCapabilitiesCatalog, ModelCapabilitiesError> {
    let text = std::fs::read_to_string(path).map_err(|source| ModelCapabilitiesError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let catalog: ModelCapabilitiesCatalog =
        serde_json::from_str(&text).map_err(|source| ModelCapabilitiesError::Json {
            path: path.to_path_buf(),
            source,
        })?;
    Ok(catalog)
}

/// Resolve the default snapshot location, in order:
///
/// 1. `AIDEN_MODEL_CAPABILITIES` env var (explicit override);
/// 2. `../resources/model-capabilities.json` relative to
///    `CARGO_MANIFEST_DIR` (task-specified dev layout);
/// 3. `../../resources/model-capabilities.json` relative to
///    `CARGO_MANIFEST_DIR` (workspace-root layout: `rust/<crate>` → repo
///    `resources/`);
/// 4. `resources/model-capabilities.json` in the current directory (invoking
///    `cargo run` from the repo root).
///
/// Returns the first candidate that exists, or `None` when the file is absent
/// (plain dev checkouts — callers fall back to the builtin snapshot).
pub fn default_capabilities_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AIDEN_MODEL_CAPABILITIES") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    // `concat!` requires literals, so the manifest dir is inlined (it is a
    // compile-time constant anyway).
    const CANDIDATES: [&str; 3] = [
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../resources/model-capabilities.json"
        ),
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../resources/model-capabilities.json"
        ),
        "resources/model-capabilities.json",
    ];
    for candidate in CANDIDATES {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Try loading the default snapshot: `None` (no log) when no file exists, the
/// error when a file exists but cannot be read/parsed. Convenience for boot
/// paths that want one call.
pub fn load_default_capabilities() -> Result<ModelCapabilitiesCatalog, ModelCapabilitiesError> {
    let path = default_capabilities_path().ok_or_else(|| {
        let fallback = PathBuf::from(
            "resources/model-capabilities.json (not found; AIDEN_MODEL_CAPABILITIES unset)",
        );
        ModelCapabilitiesError::Io {
            path: fallback,
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "file missing"),
        }
    })?;
    load_model_capabilities(&path)
}

/// Aiden provider ids that are stored under a different models.dev slug.
/// Mirrors [`crate::catalog::catalog_provider_slug`].
pub fn catalog_provider_alias(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "openai-codex" => Some("openai"),
        "gemini" => Some("google"),
        "moonshot" => Some("moonshotai"),
        _ => None,
    }
}

/// Resolve the provider entry for an Aiden provider id: direct slug hit, then
/// the alias slug. `"google"` matches the `google` entry directly while
/// `"gemini"` resolves through the alias, and `"moonshotai"`/`"moonshot"`
/// both reach the `moonshotai` entry.
pub fn lookup_provider<'a>(
    catalog: &'a ModelCapabilitiesCatalog,
    provider: &str,
) -> Option<&'a ProviderModels> {
    catalog
        .get(provider)
        .or_else(|| catalog_provider_alias(provider).and_then(|slug| catalog.get(slug)))
}

/// models.dev-style id normalization: lower-case, dropping a provider-path
/// prefix (`openai/gpt-4o` → `gpt-4o`), matching the TS id lookup.
pub fn normalize_model_id(id: &str) -> String {
    match id.rsplit_once('/') {
        Some((_, tail)) => tail.to_lowercase(),
        None => id.to_lowercase(),
    }
}

/// Look up one model capability for a provider id. Tries the exact key, then
/// a case-insensitive match, then a normalized (path-stripped) match — the
/// same tolerant resolution the runtime limits use.
pub fn lookup_model(
    catalog: &ModelCapabilitiesCatalog,
    provider: &str,
    model: &str,
) -> Option<ModelCapability> {
    let entry = lookup_provider(catalog, provider)?;
    let exact_lower = model.to_lowercase();
    let normalized = normalize_model_id(model);
    entry
        .models
        .get(model)
        .or_else(|| {
            entry
                .models
                .iter()
                .find(|(key, _)| key.to_lowercase() == exact_lower)
                .map(|(_, capability)| capability)
        })
        .or_else(|| {
            entry
                .models
                .iter()
                .find(|(key, _)| normalize_model_id(key) == normalized)
                .map(|(_, capability)| capability)
        })
        .cloned()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 3 providers × 2 models — the fixture shape used across the module and
    /// the catalog runtime-limit tests (the real snapshot has dozens of
    /// providers and hundreds of models, so a tiny inline JSON keeps tests
    /// fast and readable while exercising every parse branch).
    pub(crate) fn fixture_catalog_json() -> serde_json::Value {
        serde_json::json!({
            "anthropic": {
                "id": "anthropic",
                "name": "Anthropic",
                "models": {
                    "claude-sonnet-5": {
                        "id": "claude-sonnet-5",
                        "name": "Claude Sonnet 5",
                        "description": "Flagship sonnet tier",
                        "family": "claude-sonnet",
                        "attachment": true,
                        "reasoning": true,
                        "reasoning_options": [
                            { "type": "effort", "values": ["low", "medium", "high", "xhigh", "max"] }
                        ],
                        "tool_call": true,
                        "structured_output": true,
                        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
                        // Deliberately different from the builtin snapshot
                        // (1M/128k) so the catalog-overrides-builtin tests
                        // actually distinguish the two sources.
                        "limit": { "context": 900_000, "output": 100_000 },
                        "cost": { "input": 5, "output": 25, "cache_read": 0.5 }
                    },
                    "claude-sonnet-6": {
                        "id": "claude-sonnet-6",
                        "name": "Claude Sonnet 6",
                        "attachment": true,
                        "reasoning": true,
                        "tool_call": true,
                        "structured_output": true,
                        "limit": { "context": 300_000, "output": 80_000 },
                        "cost": { "input": 6, "output": 30 }
                    },
                    "claude-haiku-4-5": {
                        "id": "claude-haiku-4-5",
                        "name": "Claude Haiku 4.5",
                        "attachment": true,
                        "reasoning": true,
                        "tool_call": true,
                        "structured_output": true,
                        "limit": { "context": 200_000, "output": 64_000 },
                        "cost": { "input": 1, "output": 5 }
                    }
                }
            },
            "google": {
                "id": "google",
                "name": "Google",
                "models": {
                    "gemini-2.5-flash": {
                        "id": "gemini-2.5-flash",
                        "name": "Gemini 2.5 Flash",
                        "attachment": true,
                        "reasoning": true,
                        "tool_call": true,
                        "limit": { "context": 1_048_576, "output": 65_536 }
                    },
                    "gemma-4-31b-it": {
                        "id": "gemma-4-31b-it",
                        "name": "Gemma 4 31B IT",
                        "attachment": false,
                        "reasoning": true,
                        "limit": { "context": 262_144, "output": 32_768 }
                    }
                }
            },
            "openai": {
                "id": "openai",
                "name": "OpenAI",
                "models": {
                    "gpt-5.4": {
                        "id": "gpt-5.4",
                        "name": "GPT-5.4",
                        "attachment": false,
                        "reasoning": true,
                        "tool_call": true,
                        "structured_output": true,
                        "limit": { "context": 400_000, "output": 128_000 },
                        "cost": { "input": 1.25, "output": 10 }
                    },
                    "gpt-4o-mini": {
                        "id": "gpt-4o-mini",
                        "name": "GPT-4o mini",
                        "attachment": false,
                        "reasoning": false,
                        "limit": { "context": 128_000, "output": 16_384 }
                    }
                }
            }
        })
    }

    fn fixture_catalog() -> ModelCapabilitiesCatalog {
        serde_json::from_value(fixture_catalog_json()).expect("fixture parses")
    }

    #[test]
    fn loads_and_parses_the_fixture_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model-capabilities.json");
        std::fs::write(&path, serde_json::to_vec(&fixture_catalog_json()).unwrap()).unwrap();
        let catalog = load_model_capabilities(&path).expect("loads");
        assert_eq!(catalog.len(), 3);
        let anthropic = catalog.get("anthropic").expect("anthropic present");
        assert_eq!(anthropic.name.as_deref(), Some("Anthropic"));
        assert_eq!(anthropic.models.len(), 3);
        let sonnet = &anthropic.models["claude-sonnet-5"];
        assert_eq!(sonnet.context_length(), Some(900_000));
        assert_eq!(sonnet.max_output(), Some(100_000));
        assert!(sonnet.attachment);
        assert!(sonnet.reasoning);
        assert!(sonnet.tool_call);
        assert_eq!(sonnet.input_modalities(), &["text", "image", "pdf"]);
        assert!(sonnet.accepts_images());
        let pricing = sonnet.pricing.unwrap();
        assert_eq!(pricing.input, 5.0);
        assert_eq!(pricing.output, 25.0);
        assert_eq!(pricing.cache_read, 0.5);
        assert_eq!(pricing.cache_write, 0.0, "missing field defaults");
        assert_eq!(sonnet.reasoning_options.len(), 1);
        assert_eq!(
            sonnet.reasoning_options[0].values,
            vec![
                Some("low".to_string()),
                Some("medium".to_string()),
                Some("high".to_string()),
                Some("xhigh".to_string()),
                Some("max".to_string())
            ]
        );
        // Text-only model: no attachment, no image modality.
        let gemma = catalog["google"].models["gemma-4-31b-it"].clone();
        assert!(!gemma.accepts_images());
        assert_eq!(gemma.context_length(), Some(262_144));
    }

    #[test]
    fn missing_fields_default_to_false() {
        // A row with only a name and limit must not fail the parse, and its
        // booleans read as false (tolerant "missing fields defaulted").
        let value = serde_json::json!({
            "anthropic": {
                "models": {
                    "bare-model": { "name": "Bare", "limit": { "context": 1000 } }
                }
            }
        });
        let catalog: ModelCapabilitiesCatalog = serde_json::from_value(value).unwrap();
        let model = &catalog["anthropic"].models["bare-model"];
        assert!(!model.attachment);
        assert!(!model.reasoning);
        assert!(!model.tool_call);
        assert_eq!(model.context_length(), Some(1000));
        assert_eq!(model.max_output(), None);
        assert!(model.pricing.is_none());
    }

    #[test]
    fn looks_up_models_by_exact_alias_and_normalized_ids() {
        let catalog = fixture_catalog();
        // Exact provider + exact model.
        let sonnet = lookup_model(&catalog, "anthropic", "claude-sonnet-5").expect("sonnet");
        assert_eq!(sonnet.context_length(), Some(900_000));
        // Alias provider slug ("gemini" → "google").
        let flash = lookup_model(&catalog, "gemini", "gemini-2.5-flash").expect("gemini alias");
        assert_eq!(flash.name.as_deref(), Some("Gemini 2.5 Flash"));
        assert_eq!(
            lookup_model(&catalog, "google", "gemini-2.5-flash"),
            Some(flash.clone())
        );
        // Case-insensitive + path-normalized model ids.
        assert_eq!(
            lookup_model(&catalog, "openai", "openai/gpt-5.4").and_then(|m| m.id),
            Some("gpt-5.4".to_string())
        );
        assert!(lookup_model(&catalog, "anthropic", "CLAUDE-SONNET-5").is_some());
        // Unknown provider or model → None (never a panic).
        assert!(lookup_model(&catalog, "anthropic", "not-a-model").is_none());
        assert!(lookup_model(&catalog, "openai", "gpt-5").is_none());
        assert!(lookup_model(&catalog, "custom:lmstudio", "anything").is_none());
    }

    #[test]
    fn lookup_provider_resolves_alias_slugs() {
        let catalog = fixture_catalog();
        assert_eq!(
            lookup_provider(&catalog, "google").map(|entry| entry.id.as_deref().unwrap()),
            Some("google")
        );
        assert_eq!(
            lookup_provider(&catalog, "gemini").map(|entry| entry.id.as_deref().unwrap()),
            Some("google")
        );
        assert!(
            lookup_provider(&catalog, "moonshotai").is_none(),
            "fixture has no moonshotai"
        );
        assert!(lookup_provider(&catalog, "moonshot").is_none());
        assert!(lookup_provider(&catalog, "custom:x").is_none());
    }

    #[test]
    fn missing_provider_returns_none() {
        let catalog = fixture_catalog();
        assert!(lookup_provider(&catalog, "missing").is_none());
        assert!(lookup_provider(&catalog, "").is_none());
        assert!(lookup_model(&catalog, "missing", "anything").is_none());
    }

    #[test]
    fn malformed_json_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.json");
        std::fs::write(&path, b"{ not valid json").unwrap();
        let error = load_model_capabilities(&path).unwrap_err();
        assert!(matches!(error, ModelCapabilitiesError::Json { .. }));
        // A missing file is an I/O error.
        let missing = dir.path().join("absent.json");
        let error = load_model_capabilities(&missing).unwrap_err();
        assert!(matches!(error, ModelCapabilitiesError::Io { .. }));
    }
}
