//! Artificial Analysis model catalog — port of the four Electron-free cores in
//! `main/services/artificial-analysis-*.ts`:
//!
//! - `artificial-analysis-catalog-core.ts` — the normalized cache types,
//!   `parseArtificialAnalysisUserCache` validation, alias-based model lookup,
//!   and ranking projection;
//! - `artificial-analysis-runtime-core.ts` — the paginated Free-endpoint fetch,
//!   percentile normalization, `ArtificialAnalysisRuntime` (serialized action +
//!   state mutexes), and the `ArtificialAnalysisStatus` model;
//! - `artificial-analysis-cache.ts` — the atomic device-local cache store
//!   (`FileArtificialAnalysisCacheStore`, ≤32 MB, mode 0600);
//! - `artificial-analysis-action-core.ts` — the IPC-safe action wrapper.
//!
//! ## The explicit-user-action contract
//!
//! AGENTS.md forbids fetching Artificial Analysis data without an explicit user
//! action. That invariant is encoded in the **type system**: every network path
//! requires a [`UserInitiated`] token, and the only way to obtain one is
//! [`UserInitiated::explicit`]. `status()`/`catalog()` reads are offline and
//! take no token.
//!
//! The user's own API key is **never bundled or stored by this crate**: the
//! binding layer resolves it from the user's keychain through the
//! [`crate::registry::ApiKeyResolver`] pattern under the `artificial-analysis`
//! credential id, and the runtime stores it only through the injected
//! [`ArtificialAnalysisCredentialStore`] (keychain-backed ciphertext in the
//! Electron app). The key travels to the fixed Free endpoint in the
//! `x-api-key` header only — never in the URL.
//!
//! Tests mirror the TS suites (`artificial-analysis-catalog-core.test.ts`,
//! `-cache.test.ts`, `-runtime-core.test.ts`, `-action-core.test.ts`) and run
//! entirely against fixtures/in-memory stores — no network.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::registry::ApiKeyResolver;

/// The fixed Free endpoint (pinned; never a parameter).
pub const ARTIFICIAL_ANALYSIS_FREE_ENDPOINT: &str =
    "https://artificialanalysis.ai/api/v2/language/models/free";
/// Human-readable source page for the cache (`ARTIFICIAL_ANALYSIS_SOURCE_URL`).
pub const ARTIFICIAL_ANALYSIS_SOURCE_URL: &str = "https://artificialanalysis.ai/data-api";
/// Safety cap on normalized models (`MAX_ARTIFICIAL_ANALYSIS_MODELS`).
pub const MAX_ARTIFICIAL_ANALYSIS_MODELS: usize = 10_000;
/// The credential id the binding layer resolves the key under
/// (`piCredentialStore` `CREDENTIAL_ID` in `artificial-analysis-runtime.ts`).
pub const ARTIFICIAL_ANALYSIS_CREDENTIAL_ID: &str = "artificial-analysis";
/// The legacy fallback generation bound to pre-generation stored keys.
pub const LEGACY_UNBOUND_GENERATION: &str = "legacy-unbound-generation";

const DEFAULT_MAX_PAGES: usize = 10_000;
const DEFAULT_MAX_PAGE_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_CACHE_BYTES: u64 = 32 * 1024 * 1024;
const READ_CHUNK_BYTES: u64 = 64 * 1024;

/// The pace metric every ranking row carries (literal contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtificialAnalysisPaceMetric;

pub const ARTIFICIAL_ANALYSIS_PACE_METRIC: &str = "median_end_to_end_response_time_seconds";

impl Serialize for ArtificialAnalysisPaceMetric {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(ARTIFICIAL_ANALYSIS_PACE_METRIC)
    }
}

impl<'de> Deserialize<'de> for ArtificialAnalysisPaceMetric {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == ARTIFICIAL_ANALYSIS_PACE_METRIC {
            Ok(ArtificialAnalysisPaceMetric)
        } else {
            Err(serde::de::Error::custom("unsupported pace metric"))
        }
    }
}

/// `ArtificialAnalysisTier` in `artificial-analysis-catalog-core.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtificialAnalysisTier {
    Free,
    Pro,
    Commercial,
}

impl ArtificialAnalysisTier {
    pub fn as_str(self) -> &'static str {
        match self {
            ArtificialAnalysisTier::Free => "free",
            ArtificialAnalysisTier::Pro => "pro",
            ArtificialAnalysisTier::Commercial => "commercial",
        }
    }
}

impl std::str::FromStr for ArtificialAnalysisTier {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "free" => Ok(ArtificialAnalysisTier::Free),
            "pro" => Ok(ArtificialAnalysisTier::Pro),
            "commercial" => Ok(ArtificialAnalysisTier::Commercial),
            _ => Err(()),
        }
    }
}

/// A normalized snapshot model (`ArtificialAnalysisSnapshotModel`). Optional
/// fields are omitted when absent so the cache file matches the TS
/// `omitUndefined` output byte for byte.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtificialAnalysisSnapshotModel {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub creator: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intelligence_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coding_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agentic_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_output_tokens_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_time_to_first_token_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_end_to_end_response_time_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_count_billions: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_weights: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub huggingface_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openrouter_api_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranking: Option<ArtificialAnalysisRanking>,
}

impl ArtificialAnalysisSnapshotModel {
    fn minimal(id: &str, slug: &str, name: &str, creator: &str) -> Self {
        Self {
            id: id.to_string(),
            slug: slug.to_string(),
            name: name.to_string(),
            creator: creator.to_string(),
            release_date: None,
            reasoning: None,
            intelligence_index: None,
            coding_index: None,
            agentic_index: None,
            median_output_tokens_per_second: None,
            median_time_to_first_token_seconds: None,
            median_end_to_end_response_time_seconds: None,
            context_window_tokens: None,
            parameter_count_billions: None,
            input_modalities: None,
            output_modalities: None,
            open_weights: None,
            huggingface_url: None,
            openrouter_api_id: None,
            ranking: None,
        }
    }
}

/// The percentile pair attached to ranked rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtificialAnalysisRanking {
    pub capability_percentile: f64,
    pub response_time_percentile: f64,
    pub pace_metric: ArtificialAnalysisPaceMetric,
}

/// `ArtificialAnalysisCatalog` — the source shape used for lookup/ranking (no
/// generation/endpoint; those belong to the user cache).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtificialAnalysisCatalog {
    pub schema_version: u8,
    pub source: ArtificialAnalysisCatalogSource,
    pub models: Vec<ArtificialAnalysisSnapshotModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtificialAnalysisCatalogSource {
    pub name: String,
    pub url: String,
    pub fetched_at: Option<String>,
    pub intelligence_index_version: Option<f64>,
}

/// `ArtificialAnalysisUserCache` — the validated device-local cache produced by
/// a user's own API request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtificialAnalysisUserCache {
    pub schema_version: u8,
    pub source: ArtificialAnalysisUserCacheSource,
    pub models: Vec<ArtificialAnalysisSnapshotModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtificialAnalysisUserCacheSource {
    pub name: String,
    pub url: String,
    pub endpoint: String,
    pub generation: String,
    pub fetched_at: String,
    pub tier: ArtificialAnalysisTier,
    pub intelligence_index_version: f64,
}

/// The empty catalog (`EMPTY_ARTIFICIAL_ANALYSIS_CATALOG`).
pub fn empty_artificial_analysis_catalog() -> ArtificialAnalysisCatalog {
    ArtificialAnalysisCatalog {
        schema_version: 1,
        source: ArtificialAnalysisCatalogSource {
            name: "Artificial Analysis".to_string(),
            url: ARTIFICIAL_ANALYSIS_SOURCE_URL.to_string(),
            fetched_at: None,
            intelligence_index_version: None,
        },
        models: Vec::new(),
    }
}

// ===========================================================================
// Value helpers (mirroring the TS `record`/`optional*` helpers)
// ===========================================================================

fn record(value: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value.as_object()
}

fn record_opt(
    value: Option<&serde_json::Value>,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value.and_then(serde_json::Value::as_object)
}

fn optional_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn finite_number(value: Option<&serde_json::Value>) -> Option<f64> {
    value
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
}

fn positive_number(value: Option<&serde_json::Value>) -> Option<f64> {
    finite_number(value).filter(|value| *value > 0.0)
}

fn integer_count(value: Option<&serde_json::Value>) -> Option<usize> {
    value
        .and_then(serde_json::Value::as_u64)
        .map(|value| value as usize)
}

fn valid_generation(value: &str) -> bool {
    // TS: /^[a-z0-9][a-z0-9-]{7,127}$/iu — the `i` flag accepts uppercase.
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    if !(bytes[0].is_ascii_alphanumeric()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn is_iso_timestamp(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
}

// ===========================================================================
// Validation of the normalized cache (parseArtificialAnalysisUserCache)
// ===========================================================================

fn parse_model(
    value: &serde_json::Value,
    index: usize,
) -> Result<ArtificialAnalysisSnapshotModel, String> {
    let model = record(value)
        .ok_or_else(|| format!("Artificial Analysis snapshot model {index} must be an object."))?;
    let id = optional_string(model.get("id"));
    let slug = optional_string(model.get("slug"));
    let name = optional_string(model.get("name"));
    let creator = optional_string(model.get("creator"));
    let (Some(id), Some(slug), Some(name), Some(creator)) = (id, slug, name, creator) else {
        return Err(format!(
            "Artificial Analysis snapshot model {index} is missing identity fields."
        ));
    };

    let field = |key: &str| -> Result<Option<String>, String> {
        match model.get(key) {
            None => Ok(None),
            Some(value) if value.is_string() && !value.as_str().unwrap().is_empty() => {
                Ok(value.as_str().map(str::to_string))
            }
            Some(_) => Err(format!(
                "Artificial Analysis snapshot field \"{key}\" must be a non-empty string."
            )),
        }
    };
    let boolean = |key: &str| -> Result<Option<bool>, String> {
        match model.get(key) {
            None => Ok(None),
            Some(value) if value.is_boolean() => Ok(value.as_bool()),
            Some(_) => Err(format!(
                "Artificial Analysis snapshot field \"{key}\" must be a boolean."
            )),
        }
    };
    let number = |key: &str, positive: bool| -> Result<Option<f64>, String> {
        match model.get(key) {
            None => Ok(None),
            Some(value) => match value.as_f64() {
                Some(number) if number.is_finite() && (!positive || number > 0.0) => {
                    Ok(Some(number))
                }
                _ => Err(format!(
                    "Artificial Analysis snapshot field \"{key}\" must be {}.",
                    if positive {
                        "a positive number"
                    } else {
                        "a finite number"
                    }
                )),
            },
        }
    };
    let strings = |key: &str| -> Result<Option<Vec<String>>, String> {
        match model.get(key) {
            None => Ok(None),
            Some(value) => {
                let entries = value.as_array().ok_or_else(|| {
                    format!("Artificial Analysis snapshot field \"{key}\" must be a string array.")
                })?;
                if entries
                    .iter()
                    .any(|entry| !entry.is_string() || entry.as_str().unwrap().is_empty())
                {
                    return Err(format!(
                        "Artificial Analysis snapshot field \"{key}\" must be a string array."
                    ));
                }
                let mut seen = HashSet::new();
                let mut out = Vec::new();
                for entry in entries {
                    if seen.insert(entry.as_str().unwrap()) {
                        out.push(entry.as_str().unwrap().to_string());
                    }
                }
                Ok(Some(out))
            }
        }
    };
    let percentile =
        |map: &serde_json::Map<String, serde_json::Value>, key: &str| -> Result<f64, String> {
            match map.get(key).and_then(serde_json::Value::as_f64) {
                Some(value) if value.is_finite() && (0.0..=1.0).contains(&value) => Ok(value),
                _ => Err(format!(
                    "Artificial Analysis snapshot field \"{key}\" must be between 0 and 1."
                )),
            }
        };

    let raw_ranking = record_opt(model.get("ranking"));
    let ranking = match raw_ranking {
        Some(raw) => {
            if raw.get("pace_metric").and_then(serde_json::Value::as_str)
                != Some(ARTIFICIAL_ANALYSIS_PACE_METRIC)
            {
                return Err(format!(
                    "Artificial Analysis snapshot model {index} has an unsupported pace metric."
                ));
            }
            Some(ArtificialAnalysisRanking {
                capability_percentile: percentile(raw, "capability_percentile")?,
                response_time_percentile: percentile(raw, "response_time_percentile")?,
                pace_metric: ArtificialAnalysisPaceMetric,
            })
        }
        None => None,
    };

    Ok(ArtificialAnalysisSnapshotModel {
        id,
        slug,
        name,
        creator,
        release_date: field("release_date")?,
        reasoning: boolean("reasoning")?,
        intelligence_index: number("intelligence_index", false)?,
        coding_index: number("coding_index", false)?,
        agentic_index: number("agentic_index", false)?,
        median_output_tokens_per_second: number("median_output_tokens_per_second", true)?,
        median_time_to_first_token_seconds: number("median_time_to_first_token_seconds", true)?,
        median_end_to_end_response_time_seconds: number(
            "median_end_to_end_response_time_seconds",
            true,
        )?,
        context_window_tokens: number("context_window_tokens", true)?,
        parameter_count_billions: number("parameter_count_billions", true)?,
        input_modalities: strings("input_modalities")?,
        output_modalities: strings("output_modalities")?,
        open_weights: boolean("open_weights")?,
        huggingface_url: field("huggingface_url")?,
        openrouter_api_id: field("openrouter_api_id")?,
        ranking,
    })
}

/// Validate the normalized device-local cache created from a user's own API
/// request (`parseArtificialAnalysisUserCache`).
pub fn parse_artificial_analysis_user_cache(
    value: &serde_json::Value,
) -> Result<ArtificialAnalysisUserCache, String> {
    let cache = record(value)
        .ok_or_else(|| "Artificial Analysis user cache must use schema version 1.".to_string())?;
    if cache
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err("Artificial Analysis user cache must use schema version 1.".to_string());
    }
    let raw_source = record_opt(cache.get("source"))
        .ok_or_else(|| "Artificial Analysis user cache has an invalid source.".to_string())?;
    if raw_source.get("name").and_then(serde_json::Value::as_str) != Some("Artificial Analysis") {
        return Err("Artificial Analysis user cache has an invalid source.".to_string());
    }
    if raw_source.get("url").and_then(serde_json::Value::as_str)
        != Some(ARTIFICIAL_ANALYSIS_SOURCE_URL)
        || raw_source
            .get("endpoint")
            .and_then(serde_json::Value::as_str)
            != Some(ARTIFICIAL_ANALYSIS_FREE_ENDPOINT)
    {
        return Err("Artificial Analysis user cache has an unexpected endpoint.".to_string());
    }
    let generation = raw_source
        .get("generation")
        .and_then(serde_json::Value::as_str);
    match generation {
        Some(generation) if valid_generation(generation) => {}
        _ => return Err("Artificial Analysis user cache has an invalid generation.".to_string()),
    }
    let fetched_at = raw_source
        .get("fetched_at")
        .and_then(serde_json::Value::as_str);
    match fetched_at {
        Some(fetched_at) if is_iso_timestamp(fetched_at) => {}
        _ => {
            return Err(
                "Artificial Analysis user cache fetched_at must be an ISO timestamp.".to_string(),
            )
        }
    }
    let tier = raw_source
        .get("tier")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "Artificial Analysis user cache has an invalid tier.".to_string())?;
    let intelligence_index_version = raw_source
        .get("intelligence_index_version")
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            "Artificial Analysis user cache has an invalid index version.".to_string()
        })?;
    let raw_models = cache.get("models").and_then(serde_json::Value::as_array);
    match raw_models {
        Some(models) if !models.is_empty() && models.len() <= MAX_ARTIFICIAL_ANALYSIS_MODELS => {}
        _ => return Err("Artificial Analysis user cache must contain models.".to_string()),
    }
    let models = raw_models
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, value)| parse_model(value, index))
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids = HashSet::new();
    if models.iter().any(|model| !ids.insert(model.id.as_str())) {
        return Err(
            "Artificial Analysis user cache contains duplicate model identifiers.".to_string(),
        );
    }
    if !models.iter().any(|model| model.ranking.is_some()) {
        return Err(
            "Artificial Analysis user cache contains no usable benchmark rankings.".to_string(),
        );
    }
    Ok(ArtificialAnalysisUserCache {
        schema_version: 1,
        source: ArtificialAnalysisUserCacheSource {
            name: "Artificial Analysis".to_string(),
            url: ARTIFICIAL_ANALYSIS_SOURCE_URL.to_string(),
            endpoint: ARTIFICIAL_ANALYSIS_FREE_ENDPOINT.to_string(),
            generation: generation.unwrap().to_string(),
            fetched_at: fetched_at.unwrap().to_string(),
            tier,
            intelligence_index_version,
        },
        models,
    })
}

// ===========================================================================
// Model lookup + ranking projection
// ===========================================================================

fn identity(value: &str) -> String {
    let lower = value.to_lowercase();
    let mut out = String::new();
    if let Some(stripped) = lower.strip_prefix("https://huggingface.co/") {
        out.push_str(stripped);
    } else if let Some(stripped) = lower.strip_prefix("http://huggingface.co/") {
        out.push_str(stripped);
    } else {
        out.push_str(&lower);
    }
    // Replace every run of non [a-z0-9] with "-", then trim leading/trailing "-".
    let mut result = String::with_capacity(out.len());
    let mut pending_dash = false;
    for character in out.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash {
                result.push('-');
                pending_dash = false;
            }
            result.push(character);
        } else {
            pending_dash = true;
        }
    }
    result.trim_matches('-').to_string()
}

fn leaf_identity(value: &str) -> String {
    let normalized = identity(value);
    let leaf = value.rsplit('/').next().unwrap_or(value);
    let leaf_identity = identity(leaf);
    if leaf_identity.is_empty() {
        normalized
    } else {
        leaf_identity
    }
}

fn model_aliases(model: &ArtificialAnalysisSnapshotModel) -> HashSet<String> {
    let mut aliases = HashSet::new();
    for value in [
        Some(model.slug.as_str()),
        model.openrouter_api_id.as_deref(),
        model.huggingface_url.as_deref(),
        Some(model.name.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        aliases.insert(identity(value));
        aliases.insert(leaf_identity(value));
    }
    aliases
}

fn creator_matches(model: &ArtificialAnalysisSnapshotModel, creator_hint: Option<&str>) -> bool {
    match creator_hint {
        Some(hint) => identity(&model.creator) == identity(hint),
        None => true,
    }
}

/// Exact aliases win. A canonical display-name fallback is accepted only when
/// the creator matches and exactly one snapshot row qualifies
/// (`findArtificialAnalysisModel`).
pub fn find_artificial_analysis_model(
    snapshot: &ArtificialAnalysisCatalog,
    model_id: &str,
    creator_hint: Option<&str>,
    canonical_name: Option<&str>,
) -> Option<ArtificialAnalysisSnapshotModel> {
    let identities = [identity(model_id), leaf_identity(model_id)];
    let exact: Vec<&ArtificialAnalysisSnapshotModel> = snapshot
        .models
        .iter()
        .filter(|model| {
            creator_matches(model, creator_hint)
                && identities
                    .iter()
                    .any(|candidate| model_aliases(model).contains(candidate))
        })
        .collect();
    if exact.len() == 1 {
        return Some(exact[0].clone());
    }
    let canonical_name = canonical_name?;
    let canonical_identity = identity(canonical_name);
    let by_name: Vec<&ArtificialAnalysisSnapshotModel> = snapshot
        .models
        .iter()
        .filter(|model| {
            creator_matches(model, creator_hint) && identity(&model.name) == canonical_identity
        })
        .collect();
    if by_name.len() == 1 {
        Some(by_name[0].clone())
    } else {
        None
    }
}

/// The renderer-facing ranking projection (`artificialAnalysisRanking`).
#[derive(Debug, Clone, PartialEq)]
pub struct ArtificialAnalysisModelRanking {
    pub capability_percentile: f64,
    pub response_time_percentile: f64,
    pub source: String,
    pub source_url: String,
    pub measured_at: Option<String>,
}

pub fn artificial_analysis_ranking(
    snapshot: &ArtificialAnalysisCatalog,
    model: &ArtificialAnalysisSnapshotModel,
) -> Option<ArtificialAnalysisModelRanking> {
    let ranking = model.ranking.as_ref()?;
    let version = snapshot.source.intelligence_index_version;
    Some(ArtificialAnalysisModelRanking {
        capability_percentile: ranking.capability_percentile,
        response_time_percentile: ranking.response_time_percentile,
        source: match version {
            Some(version) => format!("Artificial Analysis · Intelligence Index v{version}"),
            None => "Artificial Analysis".to_string(),
        },
        source_url: "https://artificialanalysis.ai".to_string(),
        measured_at: snapshot.source.fetched_at.clone(),
    })
}

// ===========================================================================
// Percentiles
// ===========================================================================

/// Map numeric values to 0…1 using average ranks for ties
/// (`artificialAnalysisPercentiles`).
pub fn artificial_analysis_percentiles(
    models: &[ArtificialAnalysisSnapshotModel],
    select: impl Fn(&ArtificialAnalysisSnapshotModel) -> Option<f64>,
) -> HashMap<String, f64> {
    let mut rows: Vec<(&String, f64)> = models
        .iter()
        .filter_map(|model| select(model).map(|value| (&model.id, value)))
        .collect();
    rows.sort_by(|left, right| left.1.total_cmp(&right.1).then_with(|| left.0.cmp(right.0)));
    let mut result = HashMap::new();
    if rows.is_empty() {
        return result;
    }
    if rows.len() == 1 {
        result.insert(rows[0].0.clone(), 0.5);
        return result;
    }
    let mut start = 0usize;
    while start < rows.len() {
        let mut end = start;
        while end + 1 < rows.len() && rows[end + 1].1 == rows[start].1 {
            end += 1;
        }
        // JS `(start + end) / 2 / (rows.length - 1)` is float math.
        let percentile = (start + end) as f64 / 2.0 / (rows.len() - 1) as f64;
        for (id, _) in rows.iter().skip(start).take(end - start + 1) {
            result.insert((*id).clone(), percentile);
        }
        start = end + 1;
    }
    result
}

// ===========================================================================
// Fetch errors / action errors
// ===========================================================================

/// `ArtificialAnalysisFetchErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtificialAnalysisFetchErrorCode {
    InvalidKey,
    AccessDenied,
    RateLimited,
    ServiceUnavailable,
    NetworkError,
    InvalidResponse,
}

impl ArtificialAnalysisFetchErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ArtificialAnalysisFetchErrorCode::InvalidKey => "invalid_key",
            ArtificialAnalysisFetchErrorCode::AccessDenied => "access_denied",
            ArtificialAnalysisFetchErrorCode::RateLimited => "rate_limited",
            ArtificialAnalysisFetchErrorCode::ServiceUnavailable => "service_unavailable",
            ArtificialAnalysisFetchErrorCode::NetworkError => "network_error",
            ArtificialAnalysisFetchErrorCode::InvalidResponse => "invalid_response",
        }
    }
}

/// `ArtificialAnalysisFetchError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtificialAnalysisFetchError {
    pub code: ArtificialAnalysisFetchErrorCode,
    pub message: String,
}

impl ArtificialAnalysisFetchError {
    pub fn new(code: ArtificialAnalysisFetchErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ArtificialAnalysisFetchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

/// `ArtificialAnalysisInputError` (code `invalid_input`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtificialAnalysisInputError {
    pub message: String,
}

/// `ArtificialAnalysisStateError` (code `not_connected`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtificialAnalysisStateError {
    pub message: String,
}

/// `ArtificialAnalysisActionErrorCode` — every code the IPC-safe action result
/// can carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtificialAnalysisActionErrorCode {
    InvalidKey,
    AccessDenied,
    RateLimited,
    ServiceUnavailable,
    NetworkError,
    InvalidResponse,
    InvalidInput,
    NotConnected,
    LocalError,
}

impl ArtificialAnalysisActionErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ArtificialAnalysisActionErrorCode::InvalidKey => "invalid_key",
            ArtificialAnalysisActionErrorCode::AccessDenied => "access_denied",
            ArtificialAnalysisActionErrorCode::RateLimited => "rate_limited",
            ArtificialAnalysisActionErrorCode::ServiceUnavailable => "service_unavailable",
            ArtificialAnalysisActionErrorCode::NetworkError => "network_error",
            ArtificialAnalysisActionErrorCode::InvalidResponse => "invalid_response",
            ArtificialAnalysisActionErrorCode::InvalidInput => "invalid_input",
            ArtificialAnalysisActionErrorCode::NotConnected => "not_connected",
            ArtificialAnalysisActionErrorCode::LocalError => "local_error",
        }
    }
}

/// The unified error the runtime raises. Mirrors the three TS error classes
/// plus the opaque "local" bucket the action wrapper hides behind a fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtificialAnalysisError {
    Fetch(ArtificialAnalysisFetchError),
    Input(ArtificialAnalysisInputError),
    State(ArtificialAnalysisStateError),
    Local(String),
}

impl ArtificialAnalysisError {
    pub fn message(&self) -> &str {
        match self {
            ArtificialAnalysisError::Fetch(error) => &error.message,
            ArtificialAnalysisError::Input(error) => &error.message,
            ArtificialAnalysisError::State(error) => &error.message,
            ArtificialAnalysisError::Local(message) => message,
        }
    }

    pub fn action_code(&self) -> ArtificialAnalysisActionErrorCode {
        match self {
            ArtificialAnalysisError::Fetch(error) => match error.code {
                ArtificialAnalysisFetchErrorCode::InvalidKey => {
                    ArtificialAnalysisActionErrorCode::InvalidKey
                }
                ArtificialAnalysisFetchErrorCode::AccessDenied => {
                    ArtificialAnalysisActionErrorCode::AccessDenied
                }
                ArtificialAnalysisFetchErrorCode::RateLimited => {
                    ArtificialAnalysisActionErrorCode::RateLimited
                }
                ArtificialAnalysisFetchErrorCode::ServiceUnavailable => {
                    ArtificialAnalysisActionErrorCode::ServiceUnavailable
                }
                ArtificialAnalysisFetchErrorCode::NetworkError => {
                    ArtificialAnalysisActionErrorCode::NetworkError
                }
                ArtificialAnalysisFetchErrorCode::InvalidResponse => {
                    ArtificialAnalysisActionErrorCode::InvalidResponse
                }
            },
            ArtificialAnalysisError::Input(_) => ArtificialAnalysisActionErrorCode::InvalidInput,
            ArtificialAnalysisError::State(_) => ArtificialAnalysisActionErrorCode::NotConnected,
            ArtificialAnalysisError::Local(_) => ArtificialAnalysisActionErrorCode::LocalError,
        }
    }
}

impl std::fmt::Display for ArtificialAnalysisError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

// ===========================================================================
// UserInitiated — the explicit-user-action token
// ===========================================================================

/// A proof that the caller performed an explicit user action. The **only**
/// constructor is [`UserInitiated::explicit`]; the private field makes the
/// token impossible to fabricate, so every network path that takes it is
/// statically gated on user intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserInitiated {
    _explicit: (),
}

impl UserInitiated {
    pub fn explicit() -> Self {
        Self { _explicit: () }
    }
}

// ===========================================================================
// API key normalization (normalizeArtificialAnalysisApiKey)
// ===========================================================================

/// Validate a pasted Artificial Analysis key. Returns the trimmed key, never
/// echoing control characters back.
pub fn normalize_artificial_analysis_api_key(
    value: &str,
) -> Result<String, ArtificialAnalysisInputError> {
    if value.trim().is_empty() {
        return Err(ArtificialAnalysisInputError {
            message: "Paste an Artificial Analysis API key.".to_string(),
        });
    }
    let key = value.trim();
    if key.len() > 4_096 {
        return Err(ArtificialAnalysisInputError {
            message: "The Artificial Analysis API key is too long.".to_string(),
        });
    }
    if key.chars().any(|character| {
        let code = character as u32;
        code <= 0x1f || code == 0x7f
    }) {
        return Err(ArtificialAnalysisInputError {
            message: "The Artificial Analysis API key contains unsupported characters.".to_string(),
        });
    }
    Ok(key.to_string())
}

fn response_error(status: u16) -> ArtificialAnalysisFetchError {
    let (code, message) = match status {
        401 => (
            ArtificialAnalysisFetchErrorCode::InvalidKey,
            "Artificial Analysis did not accept that API key. Check the key and try again.",
        ),
        403 => (
            ArtificialAnalysisFetchErrorCode::AccessDenied,
            "This Artificial Analysis key cannot access the model data endpoint.",
        ),
        429 => (
            ArtificialAnalysisFetchErrorCode::RateLimited,
            "Artificial Analysis has reached this key's daily request limit. Try again after the quota resets.",
        ),
        _ if status >= 500 => (
            ArtificialAnalysisFetchErrorCode::ServiceUnavailable,
            "Artificial Analysis is temporarily unavailable. Try fetching again later.",
        ),
        _ => (
            ArtificialAnalysisFetchErrorCode::InvalidResponse,
            "Artificial Analysis rejected the model data request.",
        ),
    };
    ArtificialAnalysisFetchError::new(code, message)
}

// ===========================================================================
// Fetch transport + paginated fetch
// ===========================================================================

/// The injectable HTTP surface (`FetchLike` in the TS runtime-core). Tests
/// inject fixtures; production uses the reqwest-backed default.
#[async_trait]
pub trait FetchLike: Send + Sync {
    /// GET `url` with the given headers (`accept` + `x-api-key`). A transport
    /// failure is `Err`; an HTTP status is carried in the response.
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<FetchResponse, String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The production transport: reqwest with redirects disabled (the TS sends
/// `redirect: "error"`) and a per-request timeout.
pub struct ReqwestFetchLike {
    client: reqwest::Client,
    timeout: std::time::Duration,
}

impl Default for ReqwestFetchLike {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_else(|error| {
                    tracing::warn!(%error, "could not build the Artificial Analysis HTTP client");
                    reqwest::Client::new()
                }),
            timeout: std::time::Duration::from_millis(DEFAULT_TIMEOUT_MS),
        }
    }
}

#[async_trait]
impl FetchLike for ReqwestFetchLike {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<FetchResponse, String> {
        let mut request = self.client.get(url);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = tokio::time::timeout(self.timeout, request.send())
            .await
            .map_err(|_| "request timed out".to_string())?
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        Ok(FetchResponse {
            status,
            body: bytes.to_vec(),
        })
    }
}

/// Fetch limits (`ArtificialAnalysisFetchLimits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtificialAnalysisFetchLimits {
    pub max_pages: usize,
    pub max_models: usize,
    pub max_page_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for ArtificialAnalysisFetchLimits {
    fn default() -> Self {
        Self {
            max_pages: DEFAULT_MAX_PAGES,
            max_models: MAX_ARTIFICIAL_ANALYSIS_MODELS,
            max_page_bytes: DEFAULT_MAX_PAGE_BYTES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
        }
    }
}

/// Options for [`fetch_artificial_analysis_user_cache`].
#[derive(Default)]
pub struct ArtificialAnalysisFetchOptions {
    pub fetch: Option<Arc<dyn FetchLike>>,
    /// Injectable clock returning an RFC 3339 UTC timestamp.
    pub now: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub timeout_ms: Option<u64>,
    pub limits: Option<ArtificialAnalysisFetchLimits>,
    pub generation: Option<String>,
}

fn read_json_response(
    body: Vec<u8>,
    max_bytes: u64,
) -> Result<(serde_json::Value, u64), ArtificialAnalysisFetchError> {
    let bytes = body.len() as u64;
    if bytes > max_bytes {
        return Err(ArtificialAnalysisFetchError::new(
            ArtificialAnalysisFetchErrorCode::InvalidResponse,
            "Artificial Analysis returned a response that was too large.",
        ));
    }
    match serde_json::from_slice(&body) {
        Ok(value) => Ok((value, bytes)),
        Err(_) => Err(ArtificialAnalysisFetchError::new(
            ArtificialAnalysisFetchErrorCode::InvalidResponse,
            "Artificial Analysis returned data Aiden could not read.",
        )),
    }
}

async fn request_page(
    page: usize,
    key: &str,
    fetch: &dyn FetchLike,
    max_page_bytes: u64,
) -> Result<(serde_json::Value, u64), ArtificialAnalysisFetchError> {
    let url = format!("{ARTIFICIAL_ANALYSIS_FREE_ENDPOINT}?page={page}");
    let headers = [("accept", "application/json"), ("x-api-key", key)];
    let response = fetch.get(&url, &headers).await.map_err(|_| {
        ArtificialAnalysisFetchError::new(
            ArtificialAnalysisFetchErrorCode::NetworkError,
            "Aiden could not reach Artificial Analysis. Check your connection and try again.",
        )
    })?;
    if response.status != 200 {
        return Err(response_error(response.status));
    }
    read_json_response(response.body, max_page_bytes)
}

/// The cache builder (`ArtificialAnalysisCacheBuilder`): validates pagination
/// metadata, normalizes models, and emits the ranked user cache.
pub struct ArtificialAnalysisCacheBuilder {
    tier: Option<ArtificialAnalysisTier>,
    index_version: Option<f64>,
    total_pages: Option<usize>,
    page_size: Option<usize>,
    pages_read: usize,
    models: Vec<ArtificialAnalysisSnapshotModel>,
    ids: HashSet<String>,
    max_pages: usize,
    max_models: usize,
}

impl ArtificialAnalysisCacheBuilder {
    pub fn new(max_pages: usize, max_models: usize) -> Self {
        Self {
            tier: None,
            index_version: None,
            total_pages: None,
            page_size: None,
            pages_read: 0,
            models: Vec::new(),
            ids: HashSet::new(),
            max_pages,
            max_models,
        }
    }

    /// Consume one raw page. Returns the declared total page count.
    pub fn add_page(
        &mut self,
        value: &serde_json::Value,
    ) -> Result<usize, ArtificialAnalysisFetchError> {
        let page_number = self.pages_read + 1;
        let page = record(value);
        let pagination = page.and_then(|page| record_opt(page.get("pagination")));
        let tier = page
            .and_then(|page| page.get("tier"))
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.parse().ok());
        let index_version = page
            .and_then(|page| page.get("intelligence_index_version"))
            .and_then(serde_json::Value::as_f64);
        let total_pages =
            pagination.and_then(|pagination| integer_count(pagination.get("total_pages")));
        let page_size =
            pagination.and_then(|pagination| integer_count(pagination.get("page_size")));
        let page_field = pagination.and_then(|pagination| integer_count(pagination.get("page")));
        let has_more = pagination
            .and_then(|pagination| pagination.get("has_more"))
            .and_then(serde_json::Value::as_bool);
        let data_is_array = page
            .and_then(|page| page.get("data"))
            .is_some_and(serde_json::Value::is_array);

        let metadata_ok = page.is_some()
            && tier.is_some()
            && index_version.is_some()
            && total_pages.is_some_and(|total| (1..=self.max_pages).contains(&total))
            && page_size.is_some_and(|size| size >= 1)
            && page_field == Some(page_number)
            && has_more == Some(page_number < total_pages.unwrap_or(0))
            && data_is_array;
        if !metadata_ok {
            return Err(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                format!("Artificial Analysis page {page_number} returned invalid metadata."),
            ));
        }

        if self.pages_read == 0 {
            self.tier = tier;
            self.index_version = index_version;
            self.total_pages = total_pages;
            self.page_size = page_size;
        } else if tier != self.tier
            || index_version != self.index_version
            || total_pages != self.total_pages
            || page_size != self.page_size
        {
            return Err(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                format!("Artificial Analysis page {page_number} returned inconsistent pagination."),
            ));
        }

        let data = page.unwrap().get("data").unwrap().as_array().unwrap();
        for raw in data {
            if self.models.len() >= self.max_models {
                return Err(ArtificialAnalysisFetchError::new(
                    ArtificialAnalysisFetchErrorCode::InvalidResponse,
                    "Artificial Analysis returned more models than Aiden can safely process.",
                ));
            }
            let model = normalize_fetch_model(raw, self.models.len())?;
            if self.ids.contains(&model.id) {
                return Err(ArtificialAnalysisFetchError::new(
                    ArtificialAnalysisFetchErrorCode::InvalidResponse,
                    "Artificial Analysis returned duplicate model identifiers.",
                ));
            }
            self.ids.insert(model.id.clone());
            self.models.push(model);
        }
        self.pages_read = page_number;
        Ok(self.total_pages.unwrap_or(0))
    }

    /// Emit the ranked, validated user cache. Like the TS, the built object is
    /// re-validated through `parseArtificialAnalysisUserCache` before it can
    /// be persisted.
    pub fn finish(
        &self,
        fetched_at: &str,
        generation: &str,
    ) -> Result<ArtificialAnalysisUserCache, ArtificialAnalysisFetchError> {
        if self.pages_read == 0
            || Some(self.pages_read) != self.total_pages
            || self.tier.is_none()
            || self.index_version.is_none()
        {
            return Err(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                "Artificial Analysis returned incomplete model data.",
            ));
        }
        if !is_iso_timestamp(fetched_at) {
            return Err(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                "Artificial Analysis fetchedAt must be an ISO timestamp.",
            ));
        }
        if !valid_generation(generation) {
            return Err(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                "Artificial Analysis cache generation is invalid.",
            ));
        }
        if self.models.is_empty() {
            return Err(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                "Artificial Analysis returned no models.",
            ));
        }

        let capability =
            artificial_analysis_percentiles(&self.models, |model| model.intelligence_index);
        let response_time = artificial_analysis_percentiles(&self.models, |model| {
            model.median_end_to_end_response_time_seconds
        });
        let mut ranked: Vec<ArtificialAnalysisSnapshotModel> = self
            .models
            .iter()
            .map(|model| {
                let mut model = model.clone();
                if let (Some(capability), Some(response_time)) =
                    (capability.get(&model.id), response_time.get(&model.id))
                {
                    model.ranking = Some(ArtificialAnalysisRanking {
                        capability_percentile: *capability,
                        response_time_percentile: *response_time,
                        pace_metric: ArtificialAnalysisPaceMetric,
                    });
                }
                model
            })
            .collect();
        ranked.sort_by(|left, right| {
            left.creator
                .cmp(&right.creator)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.slug.cmp(&right.slug))
                .then_with(|| left.id.cmp(&right.id))
        });

        let tier = self.tier.unwrap();
        let index_version = self.index_version.unwrap();
        let cache = ArtificialAnalysisUserCache {
            schema_version: 1,
            source: ArtificialAnalysisUserCacheSource {
                name: "Artificial Analysis".to_string(),
                url: ARTIFICIAL_ANALYSIS_SOURCE_URL.to_string(),
                endpoint: ARTIFICIAL_ANALYSIS_FREE_ENDPOINT.to_string(),
                generation: generation.to_string(),
                fetched_at: fetched_at.to_string(),
                tier,
                intelligence_index_version: index_version,
            },
            models: ranked,
        };
        // The TS calls parseArtificialAnalysisUserCache on the built object.
        let serialized = serde_json::to_value(&cache).map_err(|error| {
            ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                error.to_string(),
            )
        })?;
        parse_artificial_analysis_user_cache(&serialized).map_err(|message| {
            ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                message,
            )
        })
    }
}

/// Normalize one raw model row from the Free endpoint (`normalizeModel`).
fn normalize_fetch_model(
    value: &serde_json::Value,
    index: usize,
) -> Result<ArtificialAnalysisSnapshotModel, ArtificialAnalysisFetchError> {
    let model = record(value);
    let creator = model.and_then(|model| record_opt(model.get("model_creator")));
    let evaluations = model.and_then(|model| record_opt(model.get("evaluations")));
    let performance = model.and_then(|model| record_opt(model.get("performance")));
    let id = model.and_then(|model| optional_string(model.get("id")));
    let slug = model.and_then(|model| optional_string(model.get("slug")));
    let name = model.and_then(|model| optional_string(model.get("name")));
    let creator_name = creator.and_then(|creator| optional_string(creator.get("name")));
    let (Some(id), Some(slug), Some(name)) = (id, slug, name) else {
        return Err(ArtificialAnalysisFetchError::new(
            ArtificialAnalysisFetchErrorCode::InvalidResponse,
            format!(
                "Artificial Analysis model {} is missing identity data.",
                index + 1
            ),
        ));
    };
    let mut model_row = ArtificialAnalysisSnapshotModel::minimal(&id, &slug, &name, "Unknown");
    model_row.creator = creator_name.unwrap_or_else(|| "Unknown".to_string());
    model_row.release_date = model.and_then(|model| optional_string(model.get("release_date")));
    model_row.intelligence_index = evaluations.and_then(|evaluations| {
        finite_number(evaluations.get("artificial_analysis_intelligence_index"))
    });
    model_row.coding_index = evaluations
        .and_then(|evaluations| finite_number(evaluations.get("artificial_analysis_coding_index")));
    model_row.agentic_index = evaluations.and_then(|evaluations| {
        finite_number(evaluations.get("artificial_analysis_agentic_index"))
    });
    model_row.median_output_tokens_per_second = performance.and_then(|performance| {
        positive_number(performance.get("median_output_tokens_per_second"))
    });
    model_row.median_time_to_first_token_seconds = performance.and_then(|performance| {
        positive_number(performance.get("median_time_to_first_token_seconds"))
    });
    model_row.median_end_to_end_response_time_seconds = performance.and_then(|performance| {
        positive_number(performance.get("median_end_to_end_response_time_seconds"))
    });
    Ok(model_row)
}

/// Fetch and normalize the complete catalog from the fixed Free endpoint.
/// **Requires [`UserInitiated`]** — this is the only place the network is
/// reachable, and it cannot be reached without an explicit user action.
pub async fn fetch_artificial_analysis_user_cache(
    api_key: &str,
    _initiated: UserInitiated,
    options: &ArtificialAnalysisFetchOptions,
) -> Result<ArtificialAnalysisUserCache, ArtificialAnalysisFetchError> {
    let key = normalize_artificial_analysis_api_key(api_key).map_err(|error| {
        ArtificialAnalysisFetchError::new(
            ArtificialAnalysisFetchErrorCode::InvalidResponse,
            error.message,
        )
    })?;
    let fetch: Arc<dyn FetchLike> = options
        .fetch
        .clone()
        .unwrap_or_else(|| Arc::new(ReqwestFetchLike::default()));
    let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if timeout_ms == 0 {
        return Err(ArtificialAnalysisFetchError::new(
            ArtificialAnalysisFetchErrorCode::InvalidResponse,
            "Artificial Analysis request timeout must be positive.",
        ));
    }
    let limits = options.limits.unwrap_or_default();
    if limits.max_pages == 0
        || limits.max_models == 0
        || limits.max_page_bytes == 0
        || limits.max_total_bytes == 0
        || limits.max_total_bytes < limits.max_page_bytes
    {
        return Err(ArtificialAnalysisFetchError::new(
            ArtificialAnalysisFetchErrorCode::InvalidResponse,
            "Artificial Analysis response limits must be positive and internally valid.",
        ));
    }
    let generation = options.generation.clone().unwrap_or_else(new_uuid_like);
    let fetched_at = (options.now.as_deref())
        .map(|now| now())
        .unwrap_or_else(|| Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));

    let operation = async {
        let mut builder = ArtificialAnalysisCacheBuilder::new(limits.max_pages, limits.max_models);
        let (first, first_bytes) =
            request_page(1, &key, fetch.as_ref(), limits.max_page_bytes).await?;
        let mut total_bytes = first_bytes;
        if total_bytes > limits.max_total_bytes {
            return Err(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidResponse,
                "Artificial Analysis returned more data than Aiden can safely process.",
            ));
        }
        let total_pages = builder.add_page(&first)?;
        for page in 2..=total_pages {
            let (next, next_bytes) =
                request_page(page, &key, fetch.as_ref(), limits.max_page_bytes).await?;
            total_bytes += next_bytes;
            if total_bytes > limits.max_total_bytes {
                return Err(ArtificialAnalysisFetchError::new(
                    ArtificialAnalysisFetchErrorCode::InvalidResponse,
                    "Artificial Analysis returned more data than Aiden can safely process.",
                ));
            }
            builder.add_page(&next)?;
        }
        builder.finish(&fetched_at, &generation)
    };

    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), operation).await {
        Ok(result) => result,
        Err(_) => Err(ArtificialAnalysisFetchError::new(
            ArtificialAnalysisFetchErrorCode::NetworkError,
            "Artificial Analysis did not respond in time. Try fetching again.",
        )),
    }
}

/// `buildArtificialAnalysisUserCache` — normalize pages already in memory
/// (tests, offline builds).
pub fn build_artificial_analysis_user_cache(
    pages: &[serde_json::Value],
    fetched_at: &str,
    generation: &str,
) -> Result<ArtificialAnalysisUserCache, ArtificialAnalysisFetchError> {
    let mut builder =
        ArtificialAnalysisCacheBuilder::new(DEFAULT_MAX_PAGES, MAX_ARTIFICIAL_ANALYSIS_MODELS);
    for page in pages {
        builder.add_page(page)?;
    }
    builder.finish(fetched_at, generation)
}

// ===========================================================================
// Stored credential + store traits
// ===========================================================================

/// `ArtificialAnalysisStoredCredential`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtificialAnalysisStoredCredential {
    pub key: String,
    pub generation: String,
}

/// Keychain-backed credential store (`ArtificialAnalysisCredentialStore`).
#[async_trait]
pub trait ArtificialAnalysisCredentialStore: Send + Sync {
    async fn read(&self) -> Result<Option<ArtificialAnalysisStoredCredential>, String>;
    async fn write(&self, credential: &ArtificialAnalysisStoredCredential) -> Result<(), String>;
    async fn delete_key(&self) -> Result<(), String>;
}

/// Device-local normalized cache store (`ArtificialAnalysisCacheStore`).
#[async_trait]
pub trait ArtificialAnalysisCacheStore: Send + Sync {
    async fn read(&self) -> Result<Option<ArtificialAnalysisUserCache>, String>;
    async fn write(&self, cache: &ArtificialAnalysisUserCache) -> Result<(), String>;
    async fn delete(&self) -> Result<(), String>;
}

/// The catalog fetcher the runtime calls on connect/refresh. Defaults to
/// [`fetch_artificial_analysis_user_cache`].
#[async_trait]
pub trait ArtificialAnalysisCatalogFetcher: Send + Sync {
    async fn fetch_catalog(
        &self,
        api_key: &str,
    ) -> Result<ArtificialAnalysisUserCache, ArtificialAnalysisFetchError>;
}

/// The production fetcher: the user's own key against the fixed Free endpoint,
/// gated on [`UserInitiated`] by the runtime entry points.
pub struct DefaultArtificialAnalysisCatalogFetcher;

#[async_trait]
impl ArtificialAnalysisCatalogFetcher for DefaultArtificialAnalysisCatalogFetcher {
    async fn fetch_catalog(
        &self,
        api_key: &str,
    ) -> Result<ArtificialAnalysisUserCache, ArtificialAnalysisFetchError> {
        fetch_artificial_analysis_user_cache(
            api_key,
            UserInitiated::explicit(),
            &ArtificialAnalysisFetchOptions::default(),
        )
        .await
    }
}

/// Resolve the stored Artificial Analysis key through the
/// [`ApiKeyResolver`] pattern (keychain binding in `aiden-data`). Returns
/// `None` when no key is stored — the connection state is then
/// `not_connected`.
pub fn resolve_artificial_analysis_key<R: ApiKeyResolver>(resolver: &R) -> Option<String> {
    resolver.api_key(ARTIFICIAL_ANALYSIS_CREDENTIAL_ID)
}

// ===========================================================================
// Status + runtime
// ===========================================================================

/// `ArtificialAnalysisConnectionState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtificialAnalysisConnectionState {
    NotConnected,
    Connected,
    Ready,
}

/// `ArtificialAnalysisStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtificialAnalysisStatus {
    pub state: ArtificialAnalysisConnectionState,
    pub has_key: bool,
    pub cleanup_needed: bool,
    pub ready: bool,
    pub cached_model_count: usize,
    pub ranked_model_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<ArtificialAnalysisTier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intelligence_index_version: Option<f64>,
}

fn cache_matches_credential(
    credential: &ArtificialAnalysisStoredCredential,
    cache: &ArtificialAnalysisUserCache,
) -> bool {
    cache.source.generation == credential.generation
}

fn status_from(
    credential: Option<&ArtificialAnalysisStoredCredential>,
    cache: Option<&ArtificialAnalysisUserCache>,
) -> ArtificialAnalysisStatus {
    let has_key = credential.is_some();
    let ready = match (credential, cache) {
        (Some(credential), Some(cache)) => cache_matches_credential(credential, cache),
        _ => false,
    };
    let cleanup_needed = !has_key && cache.is_some();
    let state = if ready {
        ArtificialAnalysisConnectionState::Ready
    } else if has_key {
        ArtificialAnalysisConnectionState::Connected
    } else {
        ArtificialAnalysisConnectionState::NotConnected
    };
    ArtificialAnalysisStatus {
        state,
        has_key,
        cleanup_needed,
        ready,
        cached_model_count: if ready {
            cache.unwrap().models.len()
        } else {
            0
        },
        ranked_model_count: if ready {
            cache
                .unwrap()
                .models
                .iter()
                .filter(|model| model.ranking.is_some())
                .count()
        } else {
            0
        },
        fetched_at: if ready {
            Some(cache.unwrap().source.fetched_at.clone())
        } else {
            None
        },
        tier: if ready {
            Some(cache.unwrap().source.tier)
        } else {
            None
        },
        intelligence_index_version: if ready {
            Some(cache.unwrap().source.intelligence_index_version)
        } else {
            None
        },
    }
}

/// The runtime dependencies (`ArtificialAnalysisRuntimeDependencies`).
pub struct ArtificialAnalysisRuntimeDependencies {
    pub credentials: Arc<dyn ArtificialAnalysisCredentialStore>,
    pub cache: Arc<dyn ArtificialAnalysisCacheStore>,
    pub fetch_catalog: Arc<dyn ArtificialAnalysisCatalogFetcher>,
}

/// `ArtificialAnalysisRuntime`: serializes mutations while allowing fail-closed
/// offline reads during a manual network fetch. `connect`/`refresh` require a
/// [`UserInitiated`] token.
pub struct ArtificialAnalysisRuntime {
    dependencies: ArtificialAnalysisRuntimeDependencies,
    action_mutex: tokio::sync::Mutex<()>,
    state_mutex: tokio::sync::Mutex<()>,
}

impl ArtificialAnalysisRuntime {
    pub fn new(dependencies: ArtificialAnalysisRuntimeDependencies) -> Self {
        Self {
            dependencies,
            action_mutex: tokio::sync::Mutex::new(()),
            state_mutex: tokio::sync::Mutex::new(()),
        }
    }

    /// Offline read: never fetches.
    pub async fn status(&self) -> Result<ArtificialAnalysisStatus, ArtificialAnalysisError> {
        let _state = self.state_mutex.lock().await;
        let credential = self
            .dependencies
            .credentials
            .read()
            .await
            .map_err(ArtificialAnalysisError::Local)?;
        let cache = self
            .dependencies
            .cache
            .read()
            .await
            .map_err(ArtificialAnalysisError::Local)?;
        Ok(status_from(credential.as_ref(), cache.as_ref()))
    }

    /// Offline read: returns the cache only when its generation matches the
    /// stored credential.
    pub async fn catalog(
        &self,
    ) -> Result<Option<ArtificialAnalysisUserCache>, ArtificialAnalysisError> {
        let _state = self.state_mutex.lock().await;
        let credential = self
            .dependencies
            .credentials
            .read()
            .await
            .map_err(ArtificialAnalysisError::Local)?;
        let cache = self
            .dependencies
            .cache
            .read()
            .await
            .map_err(ArtificialAnalysisError::Local)?;
        match (credential.as_ref(), cache.as_ref()) {
            (Some(credential), Some(cache)) if cache_matches_credential(credential, cache) => {
                Ok(Some(cache.clone()))
            }
            _ => Ok(None),
        }
    }

    /// Fetch with a new key and persist both the credential and the cache.
    /// **Explicit user action required.**
    pub async fn connect(
        &self,
        api_key: &str,
        _initiated: UserInitiated,
    ) -> Result<ArtificialAnalysisStatus, ArtificialAnalysisError> {
        let key = normalize_artificial_analysis_api_key(api_key)
            .map_err(ArtificialAnalysisError::Input)?;
        let _action = self.action_mutex.lock().await;
        let cache = self
            .dependencies
            .fetch_catalog
            .fetch_catalog(&key)
            .await
            .map_err(ArtificialAnalysisError::Fetch)?;
        let _state = self.state_mutex.lock().await;
        let previous = self
            .dependencies
            .credentials
            .read()
            .await
            .map_err(ArtificialAnalysisError::Local)?;
        let next = ArtificialAnalysisStoredCredential {
            key,
            generation: cache.source.generation.clone(),
        };
        self.dependencies
            .credentials
            .write(&next)
            .await
            .map_err(ArtificialAnalysisError::Local)?;
        if let Err(error) = self.dependencies.cache.write(&cache).await {
            let rollback = match previous.as_ref() {
                Some(previous) => self.dependencies.credentials.write(previous).await,
                None => self.dependencies.credentials.delete_key().await,
            };
            if rollback.is_err() {
                return Err(ArtificialAnalysisError::Local(
                    "Aiden could not save the Artificial Analysis cache or restore the previous key."
                        .to_string(),
                ));
            }
            return Err(ArtificialAnalysisError::Local(error));
        }
        Ok(status_from(Some(&next), Some(&cache)))
    }

    /// Re-fetch with the stored key. **Explicit user action required.**
    pub async fn refresh(
        &self,
        _initiated: UserInitiated,
    ) -> Result<ArtificialAnalysisStatus, ArtificialAnalysisError> {
        let _action = self.action_mutex.lock().await;
        let previous = {
            let _state = self.state_mutex.lock().await;
            self.dependencies
                .credentials
                .read()
                .await
                .map_err(ArtificialAnalysisError::Local)?
        };
        let Some(previous) = previous else {
            return Err(ArtificialAnalysisError::State(
                ArtificialAnalysisStateError {
                    message: "Connect Artificial Analysis before fetching model data.".to_string(),
                },
            ));
        };
        let cache = self
            .dependencies
            .fetch_catalog
            .fetch_catalog(&previous.key)
            .await
            .map_err(ArtificialAnalysisError::Fetch)?;
        let _state = self.state_mutex.lock().await;
        let current = self
            .dependencies
            .credentials
            .read()
            .await
            .map_err(ArtificialAnalysisError::Local)?;
        let unchanged = current.as_ref().is_some_and(|current| {
            current.key == previous.key && current.generation == previous.generation
        });
        if !unchanged {
            return Err(ArtificialAnalysisError::State(
                ArtificialAnalysisStateError {
                    message: "Artificial Analysis connection changed while model data was being fetched. Try again."
                        .to_string(),
                },
            ));
        }
        let next = ArtificialAnalysisStoredCredential {
            key: previous.key.clone(),
            generation: cache.source.generation.clone(),
        };
        self.dependencies
            .credentials
            .write(&next)
            .await
            .map_err(ArtificialAnalysisError::Local)?;
        if let Err(error) = self.dependencies.cache.write(&cache).await {
            let rollback = self.dependencies.credentials.write(&previous).await;
            if rollback.is_err() {
                return Err(ArtificialAnalysisError::Local(
                    "Aiden could not save the Artificial Analysis cache or restore its previous generation."
                        .to_string(),
                ));
            }
            return Err(ArtificialAnalysisError::Local(error));
        }
        Ok(status_from(Some(&next), Some(&cache)))
    }

    /// Remove both the credential and the cache. No network.
    pub async fn disconnect(&self) -> Result<ArtificialAnalysisStatus, ArtificialAnalysisError> {
        let _action = self.action_mutex.lock().await;
        let _state = self.state_mutex.lock().await;
        let key_result = self.dependencies.credentials.delete_key().await;
        let cache_result = self.dependencies.cache.delete().await;
        if let Err(error) = key_result {
            return Err(ArtificialAnalysisError::Local(error));
        }
        if let Err(error) = cache_result {
            return Err(ArtificialAnalysisError::Local(error));
        }
        Ok(status_from(None, None))
    }
}

// ===========================================================================
// Action wrapper (artificial-analysis-action-core.ts)
// ===========================================================================

/// The IPC-safe action result (`ArtificialAnalysisActionResult`).
#[derive(Debug, Clone, PartialEq)]
pub enum ArtificialAnalysisActionResult {
    Ok {
        status: ArtificialAnalysisStatus,
    },
    Err {
        code: ArtificialAnalysisActionErrorCode,
        message: String,
    },
}

/// Wrap a runtime operation in the renderer-visible action contract. Stable
/// error codes cross the boundary; unexpected (local) failures collapse to the
/// fallback message while the diagnostic hook still observes them.
pub async fn run_artificial_analysis_action<F, Fut>(
    operation: F,
    fallback_message: &str,
    on_unexpected: Option<UnexpectedErrorHook>,
) -> ArtificialAnalysisActionResult
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<ArtificialAnalysisStatus, ArtificialAnalysisError>>,
{
    match operation().await {
        Ok(status) => ArtificialAnalysisActionResult::Ok { status },
        Err(
            error @ (ArtificialAnalysisError::Fetch(_)
            | ArtificialAnalysisError::Input(_)
            | ArtificialAnalysisError::State(_)),
        ) => ArtificialAnalysisActionResult::Err {
            code: error.action_code(),
            message: error.message().to_string(),
        },
        Err(ArtificialAnalysisError::Local(message)) => {
            // Diagnostics must not change the renderer-visible action contract.
            if let Some(hook) = on_unexpected {
                let _ = hook(&message);
            }
            ArtificialAnalysisActionResult::Err {
                code: ArtificialAnalysisActionErrorCode::LocalError,
                message: fallback_message.to_string(),
            }
        }
    }
}

// ===========================================================================
// File cache store (artificial-analysis-cache.ts)
// ===========================================================================

/// A best-effort durability/diagnostic hook that must never break the action
/// contract.
pub type ArtificialAnalysisDiagnosticHook = Arc<dyn Fn(String) + Send + Sync>;
/// An injectable directory-sync used by the file cache store.
pub type DirectorySyncer = Arc<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;
/// A best-effort diagnostic observer for unexpected action failures.
pub type UnexpectedErrorHook = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Options for [`FileArtificialAnalysisCacheStore`].
pub struct FileArtificialAnalysisCacheStoreOptions {
    pub file_path: PathBuf,
    pub max_bytes: Option<u64>,
    pub on_invalid: Option<ArtificialAnalysisDiagnosticHook>,
    pub on_durability_warning: Option<ArtificialAnalysisDiagnosticHook>,
    /// Injectable directory-sync (tests inject failures). Defaults to a real
    /// open + fsync of the directory.
    pub sync_directory: Option<DirectorySyncer>,
}

impl Default for FileArtificialAnalysisCacheStoreOptions {
    fn default() -> Self {
        Self {
            file_path: PathBuf::new(),
            max_bytes: None,
            on_invalid: None,
            on_durability_warning: None,
            sync_directory: None,
        }
    }
}

/// Atomic device-local cache containing normalized public model data, never
/// credentials (`FileArtificialAnalysisCacheStore`).
pub struct FileArtificialAnalysisCacheStore {
    options: FileArtificialAnalysisCacheStoreOptions,
}

/// The default directory-sync: open the directory and fsync it (durability of
/// the rename above).
fn default_directory_syncer() -> DirectorySyncer {
    Arc::new(|directory: &Path| -> Result<(), String> {
        let file = std::fs::File::open(directory).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    })
}

/// Stage + fsync + rename a file into place (0600 on unix), matching the TS
/// `FileArtificialAnalysisCacheStore.write` atomic dance.
async fn write_atomic(
    temporary: &Path,
    destination: &Path,
    serialized: &str,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(temporary)
            .await
            .map_err(|error| error.to_string())?;
        file.write_all(serialized.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
    }
    #[cfg(not(unix))]
    {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary)
            .await
            .map_err(|error| error.to_string())?;
        file.write_all(serialized.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
    }
    tokio::fs::rename(temporary, destination)
        .await
        .map_err(|error| error.to_string())
}

impl FileArtificialAnalysisCacheStore {
    pub fn new(options: FileArtificialAnalysisCacheStoreOptions) -> Self {
        Self { options }
    }

    fn max_bytes(&self) -> Result<u64, String> {
        let max_bytes = self.options.max_bytes.unwrap_or(MAX_CACHE_BYTES);
        if max_bytes == 0 {
            return Err("Artificial Analysis cache size limit must be positive.".to_string());
        }
        Ok(max_bytes)
    }
}

#[async_trait]
impl ArtificialAnalysisCacheStore for FileArtificialAnalysisCacheStore {
    async fn read(&self) -> Result<Option<ArtificialAnalysisUserCache>, String> {
        use tokio::io::AsyncReadExt;
        let max_bytes = self.max_bytes()?;
        let path = self.options.file_path.clone();
        // Bounded chunked read: an oversized file is rejected before the whole
        // body is buffered (matching the TS `readBoundedFile`).
        let mut file = match tokio::fs::File::open(&path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let mut chunks = Vec::new();
        let mut total = 0u64;
        loop {
            let mut buffer = vec![0u8; READ_CHUNK_BYTES as usize];
            let read = file
                .read(&mut buffer)
                .await
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > max_bytes {
                if let Some(report) = self.options.on_invalid.as_ref() {
                    report(
                        "Artificial Analysis cache exceeds Aiden's local size limit.".to_string(),
                    );
                }
                return Ok(None);
            }
            buffer.truncate(read);
            chunks.push(buffer);
        }
        let raw: Vec<u8> = chunks.into_iter().flatten().collect();
        let value: serde_json::Value = match serde_json::from_slice(&raw) {
            Ok(value) => value,
            Err(error) => {
                if let Some(report) = self.options.on_invalid.as_ref() {
                    report(error.to_string());
                }
                return Ok(None);
            }
        };
        match parse_artificial_analysis_user_cache(&value) {
            Ok(cache) => Ok(Some(cache)),
            Err(message) => {
                if let Some(report) = self.options.on_invalid.as_ref() {
                    report(message);
                }
                Ok(None)
            }
        }
    }

    async fn write(&self, cache: &ArtificialAnalysisUserCache) -> Result<(), String> {
        let max_bytes = self.max_bytes()?;
        let serialized = match serde_json::to_value(cache) {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        };
        let serialized = format!(
            "{}\n",
            serde_json::to_string(&serialized).map_err(|e| e.to_string())?
        );
        if (serialized.len() as u64) > max_bytes {
            return Err("Artificial Analysis cache exceeds Aiden's local size limit.".to_string());
        }
        let destination = self.options.file_path.clone();
        let directory = destination
            .parent()
            .ok_or_else(|| "Artificial Analysis cache path has no parent directory.".to_string())?;
        tokio::fs::create_dir_all(directory)
            .await
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        let temporary = directory.join(format!(
            ".{}.{}.tmp",
            destination
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "cache".to_string()),
            new_uuid_like()
        ));
        let result = write_atomic(&temporary, &destination, &serialized).await;
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        // Directory sync is post-commit and best-effort; a warning must never
        // turn a committed write into a failure.
        let sync = self
            .options
            .sync_directory
            .clone()
            .unwrap_or_else(default_directory_syncer);
        if let Err(error) = sync(directory) {
            if let Some(report) = self.options.on_durability_warning.as_ref() {
                let _ = report(error);
            }
        }
        Ok(())
    }

    async fn delete(&self) -> Result<(), String> {
        match tokio::fs::remove_file(&self.options.file_path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

// ===========================================================================
// Dependency-free uuid-v4-like generator (same xorshift as aiden-data)
// ===========================================================================

static RNG_STATE: AtomicU64 = AtomicU64::new(0x5eed_5eed_5eed_5eed);

fn new_uuid_like() -> String {
    let mut bytes = [0u8; 16];
    let mut state = RNG_STATE.load(Ordering::Relaxed);
    for byte in bytes.iter_mut() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *byte = (state >> 33) as u8;
    }
    RNG_STATE.store(state, Ordering::Relaxed);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    // =====================================================================
    // catalog-core tests (artificial-analysis-catalog-core.test.ts)
    // =====================================================================

    fn model(overrides: serde_json::Value) -> serde_json::Value {
        let mut value = json!({
            "id": "m1",
            "slug": "model-one",
            "name": "Model One",
            "creator": "acme",
            "ranking": {
                "capability_percentile": 0.9,
                "response_time_percentile": 0.3,
                "pace_metric": "median_end_to_end_response_time_seconds",
            },
        });
        if let Some(object) = value.as_object_mut() {
            for (key, value) in overrides.as_object().unwrap() {
                if value.is_null() {
                    object.remove(key);
                } else {
                    object.insert(key.clone(), value.clone());
                }
            }
        }
        value
    }

    fn valid_cache_payload(models: serde_json::Value) -> serde_json::Value {
        json!({
            "schema_version": 1,
            "source": {
                "name": "Artificial Analysis",
                "url": "https://artificialanalysis.ai/data-api",
                "endpoint": "https://artificialanalysis.ai/api/v2/language/models/free",
                "generation": "2026-07-15-abc",
                "fetched_at": "2026-07-15T12:00:00.000Z",
                "tier": "free",
                "intelligence_index_version": 2,
            },
            "models": models,
        })
    }

    #[test]
    fn parse_accepts_a_well_formed_payload() {
        let cache =
            parse_artificial_analysis_user_cache(&valid_cache_payload(json!([model(json!({}))])))
                .unwrap();
        assert_eq!(cache.schema_version, 1);
        assert_eq!(cache.source.tier, ArtificialAnalysisTier::Free);
        assert_eq!(cache.source.intelligence_index_version, 2.0);
        assert_eq!(cache.models.len(), 1);
        assert_eq!(cache.models[0].id, "m1");
    }

    #[test]
    fn parse_rejects_wrong_schema_version() {
        let mut payload = valid_cache_payload(json!([model(json!({}))]));
        payload["schema_version"] = json!(2);
        assert!(parse_artificial_analysis_user_cache(&payload)
            .unwrap_err()
            .contains("schema version 1"));
    }

    #[test]
    fn parse_rejects_wrong_source_name() {
        let mut payload = valid_cache_payload(json!([model(json!({}))]));
        payload["source"]["name"] = json!("Someone Else");
        assert!(parse_artificial_analysis_user_cache(&payload)
            .unwrap_err()
            .contains("invalid source"));
    }

    #[test]
    fn parse_rejects_unexpected_endpoint() {
        let mut payload = valid_cache_payload(json!([model(json!({}))]));
        payload["source"]["endpoint"] = json!("https://example.com/api");
        assert!(parse_artificial_analysis_user_cache(&payload)
            .unwrap_err()
            .contains("unexpected endpoint"));
    }

    #[test]
    fn parse_rejects_malformed_generation() {
        let mut payload = valid_cache_payload(json!([model(json!({}))]));
        payload["source"]["generation"] = json!("BAD GEN!");
        assert!(parse_artificial_analysis_user_cache(&payload)
            .unwrap_err()
            .contains("invalid generation"));
    }

    #[test]
    fn parse_rejects_a_non_timestamp_fetched_at() {
        let mut payload = valid_cache_payload(json!([model(json!({}))]));
        payload["source"]["fetched_at"] = json!("not-a-date");
        assert!(parse_artificial_analysis_user_cache(&payload)
            .unwrap_err()
            .contains("ISO timestamp"));
    }

    #[test]
    fn parse_rejects_an_invalid_tier() {
        let mut payload = valid_cache_payload(json!([model(json!({}))]));
        payload["source"]["tier"] = json!("enterprise");
        assert!(parse_artificial_analysis_user_cache(&payload)
            .unwrap_err()
            .contains("invalid tier"));
    }

    #[test]
    fn parse_rejects_empty_or_oversized_models() {
        let empty = valid_cache_payload(json!([]));
        assert!(parse_artificial_analysis_user_cache(&empty)
            .unwrap_err()
            .contains("must contain models"));
        let too_many = valid_cache_payload(json!((0..=MAX_ARTIFICIAL_ANALYSIS_MODELS)
            .map(|_| model(json!({})))
            .collect::<Vec<_>>()));
        assert!(parse_artificial_analysis_user_cache(&too_many)
            .unwrap_err()
            .contains("must contain models"));
    }

    #[test]
    fn parse_rejects_duplicate_model_ids() {
        let duplicate = valid_cache_payload(json!([model(json!({})), model(json!({}))]));
        assert!(parse_artificial_analysis_user_cache(&duplicate)
            .unwrap_err()
            .contains("duplicate model identifiers"));
    }

    #[test]
    fn parse_rejects_snapshots_without_usable_rankings() {
        let no_ranking = valid_cache_payload(json!([model(json!({ "ranking": null }))]));
        assert!(parse_artificial_analysis_user_cache(&no_ranking)
            .unwrap_err()
            .contains("no usable benchmark rankings"));
    }

    #[test]
    fn parse_rejects_out_of_range_percentiles() {
        let bad = valid_cache_payload(json!([model(json!({
            "ranking": {
                "capability_percentile": 1.5,
                "response_time_percentile": 0.3,
                "pace_metric": "median_end_to_end_response_time_seconds",
            }
        }))]));
        assert!(parse_artificial_analysis_user_cache(&bad)
            .unwrap_err()
            .contains("between 0 and 1"));
    }

    #[test]
    fn parse_rejects_a_missing_identity_field() {
        let mut row = model(json!({}));
        row.as_object_mut().unwrap().remove("id");
        let payload = valid_cache_payload(json!([row]));
        assert!(parse_artificial_analysis_user_cache(&payload)
            .unwrap_err()
            .contains("identity fields"));
    }

    #[test]
    fn parse_dedupes_repeated_modality_entries() {
        let payload = valid_cache_payload(json!([model(json!({
            "input_modalities": ["text", "text", "image"],
        }))]));
        let cache = parse_artificial_analysis_user_cache(&payload).unwrap();
        assert_eq!(
            cache.models[0].input_modalities.as_deref(),
            Some(&["text".to_string(), "image".to_string()][..])
        );
    }

    fn find_snapshot() -> ArtificialAnalysisCatalog {
        let models = vec![
            serde_json::from_value(model(json!({
                "id": "openai/gpt-5",
                "slug": "gpt-5",
                "name": "GPT-5",
                "creator": "openai",
                "openrouter_api_id": "openai/gpt-5",
            })))
            .unwrap(),
            serde_json::from_value(model(json!({
                "id": "anthropic/claude-opus-5",
                "slug": "claude-opus-5",
                "name": "Claude Opus 5",
                "creator": "anthropic",
                "huggingface_url": "https://huggingface.co/anthropic/claude-opus-5",
            })))
            .unwrap(),
        ];
        let payload = valid_cache_payload(json!([]));
        let source: ArtificialAnalysisCatalogSource = serde_json::from_value(json!({
            "name": "Artificial Analysis",
            "url": "https://artificialanalysis.ai/data-api",
            "fetched_at": "2026-07-15T12:00:00.000Z",
            "intelligence_index_version": 2,
        }))
        .unwrap();
        let _ = payload;
        ArtificialAnalysisCatalog {
            schema_version: 1,
            source,
            models,
        }
    }

    #[test]
    fn find_matches_by_exact_slug_alias() {
        let snapshot = find_snapshot();
        let found = find_artificial_analysis_model(&snapshot, "gpt-5", None, None).unwrap();
        assert_eq!(found.id, "openai/gpt-5");
    }

    #[test]
    fn find_matches_by_openrouter_api_id() {
        let snapshot = find_snapshot();
        let found = find_artificial_analysis_model(&snapshot, "openai/gpt-5", None, None).unwrap();
        assert_eq!(found.id, "openai/gpt-5");
    }

    #[test]
    fn find_matches_by_huggingface_leaf_identity() {
        let snapshot = find_snapshot();
        let found = find_artificial_analysis_model(
            &snapshot,
            "https://huggingface.co/anthropic/claude-opus-5",
            None,
            None,
        )
        .unwrap();
        assert_eq!(found.id, "anthropic/claude-opus-5");
    }

    #[test]
    fn find_filters_by_creator_hint() {
        let snapshot = find_snapshot();
        assert_eq!(
            find_artificial_analysis_model(&snapshot, "gpt-5", Some("anthropic"), None),
            None
        );
    }

    #[test]
    fn find_falls_back_to_canonical_name_only_when_unique_and_creator_matches() {
        let snapshot = find_snapshot();
        let found =
            find_artificial_analysis_model(&snapshot, "no-such-id", Some("openai"), Some("GPT-5"))
                .unwrap();
        assert_eq!(found.id, "openai/gpt-5");
        assert_eq!(
            find_artificial_analysis_model(&snapshot, "no-such-id", Some("openai"), None),
            None
        );
    }

    #[test]
    fn find_returns_null_on_ambiguous_exact_matches() {
        let models = vec![
            serde_json::from_value(model(
                json!({ "id": "a", "slug": "twin", "name": "Twin A" }),
            ))
            .unwrap(),
            serde_json::from_value(model(
                json!({ "id": "b", "slug": "twin", "name": "Twin B" }),
            ))
            .unwrap(),
        ];
        let mut snapshot = find_snapshot();
        snapshot.models = models;
        assert_eq!(
            find_artificial_analysis_model(&snapshot, "twin", None, None),
            None
        );
    }

    #[test]
    fn find_returns_null_on_an_empty_catalog() {
        assert_eq!(
            find_artificial_analysis_model(
                &empty_artificial_analysis_catalog(),
                "gpt-5",
                None,
                None
            ),
            None
        );
    }

    #[test]
    fn ranking_returns_none_when_the_model_has_no_ranking() {
        let snapshot = find_snapshot();
        let plain: ArtificialAnalysisSnapshotModel =
            serde_json::from_value(model(json!({ "ranking": null }))).unwrap();
        assert_eq!(artificial_analysis_ranking(&snapshot, &plain), None);
    }

    #[test]
    fn ranking_shapes_with_the_index_version_label() {
        let snapshot = find_snapshot();
        let ranked: ArtificialAnalysisSnapshotModel =
            serde_json::from_value(model(json!({}))).unwrap();
        let ranking = artificial_analysis_ranking(&snapshot, &ranked).unwrap();
        assert_eq!(ranking.capability_percentile, 0.9);
        assert_eq!(ranking.response_time_percentile, 0.3);
        assert_eq!(
            ranking.source,
            "Artificial Analysis · Intelligence Index v2"
        );
        assert_eq!(ranking.source_url, "https://artificialanalysis.ai");
        assert_eq!(
            ranking.measured_at.as_deref(),
            Some("2026-07-15T12:00:00.000Z")
        );
    }

    #[test]
    fn ranking_omits_the_version_label_when_the_index_version_is_null() {
        let mut snapshot = find_snapshot();
        snapshot.source.intelligence_index_version = None;
        let ranked: ArtificialAnalysisSnapshotModel =
            serde_json::from_value(model(json!({}))).unwrap();
        let ranking = artificial_analysis_ranking(&snapshot, &ranked).unwrap();
        assert_eq!(ranking.source, "Artificial Analysis");
    }

    // =====================================================================
    // runtime-core tests (artificial-analysis-runtime-core.test.ts)
    // =====================================================================

    fn raw_model(
        id: &str,
        intelligence: Option<f64>,
        response_time: Option<f64>,
        creator: &str,
    ) -> serde_json::Value {
        json!({
            "id": id,
            "slug": id,
            "name": id,
            "release_date": "2026-07-01",
            "model_creator": { "id": format!("creator-{creator}"), "name": creator },
            "evaluations": {
                "artificial_analysis_intelligence_index": intelligence,
                "artificial_analysis_coding_index": intelligence.map(|v| v - 1.0),
                "artificial_analysis_agentic_index": intelligence.map(|v| v - 2.0),
            },
            "performance": {
                "median_output_tokens_per_second": response_time.map(|_| 100.0),
                "median_time_to_first_token_seconds": response_time.map(|_| 0.5),
                "median_end_to_end_response_time_seconds": response_time,
            },
        })
    }

    fn page(
        page_number: usize,
        total_pages: usize,
        data: Vec<serde_json::Value>,
        tier: &str,
    ) -> serde_json::Value {
        json!({
            "tier": tier,
            "intelligence_index_version": 4.1,
            "pagination": {
                "page": page_number,
                "page_size": 200,
                "total_pages": total_pages,
                "has_more": page_number < total_pages,
            },
            "data": data,
        })
    }

    fn catalog(id: &str, generation: &str) -> ArtificialAnalysisUserCache {
        build_artificial_analysis_user_cache(
            &[page(
                1,
                1,
                vec![raw_model(id, Some(50.0), Some(5.0), "Example")],
                "free",
            )],
            "2026-07-22T18:00:00.000Z",
            generation,
        )
        .unwrap()
    }

    #[test]
    fn normalizes_the_free_endpoint_into_stable_percentiles() {
        let result = build_artificial_analysis_user_cache(
            &[
                page(
                    1,
                    2,
                    vec![
                        raw_model("fast", Some(20.0), Some(2.0), "Example"),
                        raw_model("tied-a", Some(70.0), Some(8.0), "Example"),
                    ],
                    "free",
                ),
                page(
                    2,
                    2,
                    vec![
                        raw_model("tied-b", Some(70.0), Some(8.0), "Example"),
                        raw_model("slow", Some(90.0), Some(12.0), "Example"),
                    ],
                    "free",
                ),
            ],
            "2026-07-22T18:00:00.000Z",
            "generation-percentiles",
        )
        .unwrap();
        assert_eq!(result.source.tier, ArtificialAnalysisTier::Free);
        assert_eq!(result.source.intelligence_index_version, 4.1);
        assert_eq!(result.models.len(), 4);
        let by_id = |id: &str| result.models.iter().find(|m| m.id == id).unwrap();
        assert_eq!(
            by_id("fast")
                .ranking
                .as_ref()
                .unwrap()
                .capability_percentile,
            0.0
        );
        assert_eq!(
            by_id("fast")
                .ranking
                .as_ref()
                .unwrap()
                .response_time_percentile,
            0.0
        );
        assert_eq!(
            by_id("tied-a")
                .ranking
                .as_ref()
                .unwrap()
                .capability_percentile,
            0.5
        );
        assert_eq!(
            by_id("tied-b")
                .ranking
                .as_ref()
                .unwrap()
                .capability_percentile,
            0.5
        );
        assert_eq!(
            by_id("slow")
                .ranking
                .as_ref()
                .unwrap()
                .capability_percentile,
            1.0
        );
        assert_eq!(
            by_id("slow")
                .ranking
                .as_ref()
                .unwrap()
                .response_time_percentile,
            1.0
        );
    }

    #[test]
    fn percentiles_ignore_missing_values_and_place_a_single_measured_value_in_the_middle() {
        let base = catalog("model-a", "generation-model-a");
        let mut models = base.models.clone();
        let mut missing = base.models[0].clone();
        missing.id = "missing".to_string();
        missing.intelligence_index = None;
        models.push(missing);
        let result = artificial_analysis_percentiles(&models, |m| m.intelligence_index);
        assert_eq!(result.get("model-a"), Some(&0.5));
        assert!(!result.contains_key("missing"));
    }

    #[test]
    fn normalizes_contract_valid_models_with_a_null_creator() {
        let mut row = raw_model("creator-unknown", Some(40.0), Some(4.0), "Example");
        row["model_creator"] = json!(null);
        let result = build_artificial_analysis_user_cache(
            &[page(1, 1, vec![row], "free")],
            "2026-07-22T18:00:00.000Z",
            "generation-null-creator",
        )
        .unwrap();
        assert_eq!(result.models[0].creator, "Unknown");
        assert!(result.models[0].ranking.is_some());
    }

    #[test]
    fn accepts_pagination_beyond_twenty_pages() {
        let pages: Vec<serde_json::Value> = (0..21)
            .map(|index| {
                page(
                    index + 1,
                    21,
                    vec![raw_model(
                        &format!("model-{}", index + 1),
                        Some(index as f64 + 1.0),
                        Some(index as f64 + 1.0),
                        "Example",
                    )],
                    "free",
                )
            })
            .collect();
        let result = build_artificial_analysis_user_cache(
            &pages,
            "2026-07-22T18:00:00.000Z",
            "generation-twenty-one-pages",
        )
        .unwrap();
        assert_eq!(result.models.len(), 21);
    }

    #[test]
    fn rejects_inconsistent_pages_duplicates_and_responses_without_usable_rankings() {
        let mut inconsistent_page = page(
            2,
            2,
            vec![raw_model("two", Some(2.0), Some(2.0), "Example")],
            "free",
        );
        inconsistent_page["pagination"]["page_size"] = json!(100);
        let error = build_artificial_analysis_user_cache(
            &[
                page(
                    1,
                    2,
                    vec![raw_model("one", Some(1.0), Some(1.0), "Example")],
                    "free",
                ),
                inconsistent_page,
            ],
            "2026-07-22T18:00:00.000Z",
            "gen",
        )
        .unwrap_err();
        assert!(error.message.contains("inconsistent pagination"));

        let error = build_artificial_analysis_user_cache(
            &[page(
                1,
                2,
                vec![raw_model("one", Some(1.0), Some(1.0), "Example")],
                "free",
            )],
            "2026-07-22T18:00:00.000Z",
            "gen",
        )
        .unwrap_err();
        assert!(error.message.contains("incomplete model data"));

        let error = build_artificial_analysis_user_cache(
            &[page(
                1,
                1,
                vec![
                    raw_model("same", Some(1.0), Some(1.0), "Example"),
                    raw_model("same", Some(2.0), Some(2.0), "Example"),
                ],
                "free",
            )],
            "2026-07-22T18:00:00.000Z",
            "gen",
        )
        .unwrap_err();
        assert!(error.message.contains("duplicate model identifiers"));

        let error = build_artificial_analysis_user_cache(
            &[page(
                1,
                1,
                vec![raw_model("unmeasured", None, None, "Example")],
                "free",
            )],
            "2026-07-22T18:00:00.000Z",
            "gen",
        )
        .unwrap_err();
        assert!(error.message.contains("no usable benchmark rankings"));
    }

    struct RecordingFetch {
        responses: Mutex<Vec<serde_json::Value>>,
        requests: Mutex<Vec<FetchRequest>>,
        status: u16,
    }

    type FetchRequest = (String, Vec<(String, String)>);

    impl RecordingFetch {
        fn queue(pages: Vec<serde_json::Value>) -> Self {
            Self {
                responses: Mutex::new(pages),
                requests: Mutex::new(Vec::new()),
                status: 200,
            }
        }
    }

    #[async_trait]
    impl FetchLike for RecordingFetch {
        async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<FetchResponse, String> {
            self.requests.lock().unwrap().push((
                url.to_string(),
                headers
                    .iter()
                    .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
                    .collect(),
            ));
            let response = self
                .responses
                .lock()
                .unwrap()
                .pop()
                .map(|value| serde_json::to_vec(&value))
                .transpose()
                .map_err(|e| e.to_string())?;
            match response {
                Some(body) => Ok(FetchResponse {
                    status: self.status,
                    body,
                }),
                None => Ok(FetchResponse {
                    status: self.status,
                    body: Vec::new(),
                }),
            }
        }
    }

    #[tokio::test]
    async fn fetches_every_page_only_from_the_fixed_endpoint_without_placing_the_key_in_the_url() {
        let secret = "aa-secret-value";
        let fetch = Arc::new(RecordingFetch::queue(vec![
            page(
                2,
                2,
                vec![raw_model("two", Some(2.0), Some(2.0), "Example")],
                "free",
            ),
            page(
                1,
                2,
                vec![raw_model("one", Some(1.0), Some(1.0), "Example")],
                "free",
            ),
        ]));
        let fetched = fetch_artificial_analysis_user_cache(
            secret,
            UserInitiated::explicit(),
            &ArtificialAnalysisFetchOptions {
                fetch: Some(fetch.clone()),
                now: Some(Arc::new(|| "2026-07-22T18:00:00.000Z".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(fetched.models.len(), 2);
        let requests = fetch.requests.lock().unwrap().clone();
        assert_eq!(
            requests
                .iter()
                .map(|(url, _)| url.clone())
                .collect::<Vec<_>>(),
            vec![
                format!("{ARTIFICIAL_ANALYSIS_FREE_ENDPOINT}?page=1"),
                format!("{ARTIFICIAL_ANALYSIS_FREE_ENDPOINT}?page=2"),
            ]
        );
        for (url, headers) in &requests {
            assert!(
                !url.contains(secret),
                "the API key must never appear in the URL"
            );
            assert_eq!(
                headers
                    .iter()
                    .find(|(name, _)| name == "x-api-key")
                    .map(|(_, value)| value.as_str()),
                Some(secret)
            );
            assert_eq!(
                headers
                    .iter()
                    .find(|(name, _)| name == "accept")
                    .map(|(_, value)| value.as_str()),
                Some("application/json")
            );
        }
    }

    #[test]
    fn validates_key_input_without_returning_credential_material() {
        assert_eq!(
            normalize_artificial_analysis_api_key("  valid-key  ").unwrap(),
            "valid-key"
        );
        assert!(normalize_artificial_analysis_api_key("")
            .unwrap_err()
            .message
            .contains("Paste"));
        assert!(normalize_artificial_analysis_api_key("key\nheader")
            .unwrap_err()
            .message
            .contains("unsupported"));
    }

    // =====================================================================
    // action-core tests (artificial-analysis-action-core.test.ts)
    // =====================================================================

    fn ready_status() -> ArtificialAnalysisStatus {
        ArtificialAnalysisStatus {
            state: ArtificialAnalysisConnectionState::Ready,
            has_key: true,
            cleanup_needed: false,
            ready: true,
            cached_model_count: 3,
            ranked_model_count: 2,
            fetched_at: None,
            tier: None,
            intelligence_index_version: None,
        }
    }

    #[tokio::test]
    async fn action_returns_successful_status_as_a_plain_value() {
        let result =
            run_artificial_analysis_action(|| async { Ok(ready_status()) }, "fallback", None).await;
        assert_eq!(
            result,
            ArtificialAnalysisActionResult::Ok {
                status: ready_status()
            }
        );
    }

    #[tokio::test]
    async fn action_preserves_stable_input_state_and_fetch_error_codes() {
        let errors = [
            ArtificialAnalysisError::Input(ArtificialAnalysisInputError {
                message: "bad input".to_string(),
            }),
            ArtificialAnalysisError::State(ArtificialAnalysisStateError {
                message: "not connected".to_string(),
            }),
            ArtificialAnalysisError::Fetch(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::RateLimited,
                "quota reached",
            )),
        ];
        let expected_codes = [
            ArtificialAnalysisActionErrorCode::InvalidInput,
            ArtificialAnalysisActionErrorCode::NotConnected,
            ArtificialAnalysisActionErrorCode::RateLimited,
        ];
        for (error, expected_code) in errors.into_iter().zip(expected_codes) {
            let result = run_artificial_analysis_action(
                || {
                    let error = error.clone();
                    async move { Err(error) }
                },
                "fallback",
                None,
            )
            .await;
            match result {
                ArtificialAnalysisActionResult::Err { code, message } => {
                    assert_eq!(code, expected_code);
                    assert_eq!(
                        message,
                        "fallback".to_string().replace("fallback", error.message())
                    );
                }
                _ => panic!("expected Err"),
            }
        }
    }

    // =====================================================================
    // Runtime fixture tests
    // =====================================================================

    struct TestCredentialStore {
        credential: Mutex<Option<ArtificialAnalysisStoredCredential>>,
        delete_error: Mutex<Option<String>>,
    }

    #[async_trait]
    impl ArtificialAnalysisCredentialStore for TestCredentialStore {
        async fn read(&self) -> Result<Option<ArtificialAnalysisStoredCredential>, String> {
            Ok(self.credential.lock().unwrap().clone())
        }
        async fn write(
            &self,
            credential: &ArtificialAnalysisStoredCredential,
        ) -> Result<(), String> {
            *self.credential.lock().unwrap() = Some(credential.clone());
            Ok(())
        }
        async fn delete_key(&self) -> Result<(), String> {
            if let Some(error) = self.delete_error.lock().unwrap().clone() {
                return Err(error);
            }
            *self.credential.lock().unwrap() = None;
            Ok(())
        }
    }

    struct TestCacheStore {
        cache: Mutex<Option<ArtificialAnalysisUserCache>>,
        write_error: Mutex<Option<String>>,
        delete_error: Mutex<Option<String>>,
        read_gate: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    #[async_trait]
    impl ArtificialAnalysisCacheStore for TestCacheStore {
        async fn read(&self) -> Result<Option<ArtificialAnalysisUserCache>, String> {
            if let Some(receiver) = self.read_gate.lock().unwrap().take() {
                let _ = receiver.recv();
            }
            Ok(self.cache.lock().unwrap().clone())
        }
        async fn write(&self, cache: &ArtificialAnalysisUserCache) -> Result<(), String> {
            if let Some(error) = self.write_error.lock().unwrap().clone() {
                return Err(error);
            }
            *self.cache.lock().unwrap() = Some(cache.clone());
            Ok(())
        }
        async fn delete(&self) -> Result<(), String> {
            if let Some(error) = self.delete_error.lock().unwrap().clone() {
                return Err(error);
            }
            *self.cache.lock().unwrap() = None;
            Ok(())
        }
    }

    struct TestFetcher {
        calls: AtomicU64,
        behavior: Mutex<FetcherBehavior>,
    }

    enum FetcherBehavior {
        Default,
        Fail(ArtificialAnalysisFetchError),
        Blocked {
            started: std::sync::mpsc::Sender<()>,
            may_finish: std::sync::mpsc::Receiver<()>,
        },
    }

    #[async_trait]
    impl ArtificialAnalysisCatalogFetcher for TestFetcher {
        async fn fetch_catalog(
            &self,
            api_key: &str,
        ) -> Result<ArtificialAnalysisUserCache, ArtificialAnalysisFetchError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match &*self.behavior.lock().unwrap() {
                FetcherBehavior::Default => {
                    let slug = id_slug(api_key);
                    Ok(catalog(
                        &format!("from-{slug}"),
                        &format!("generation-{slug}"),
                    ))
                }
                FetcherBehavior::Fail(error) => Err(error.clone()),
                FetcherBehavior::Blocked {
                    started,
                    may_finish,
                } => {
                    let _ = started.send(());
                    let _ = may_finish.recv();
                    Ok(catalog(
                        &format!("from-{}", id_slug(api_key)),
                        "generation-new-model",
                    ))
                }
            }
        }
    }

    fn id_slug(value: &str) -> String {
        value
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' {
                    character
                } else {
                    '-'
                }
            })
            .collect()
    }

    fn runtime_fixture(
        initial_key: Option<&str>,
        initial_cache: Option<ArtificialAnalysisUserCache>,
    ) -> (
        ArtificialAnalysisRuntime,
        Arc<TestCredentialStore>,
        Arc<TestCacheStore>,
        Arc<TestFetcher>,
    ) {
        let initial_generation = initial_cache
            .as_ref()
            .map(|cache| cache.source.generation.clone())
            .unwrap_or_else(|| "generation-initial".to_string());
        let credentials = Arc::new(TestCredentialStore {
            credential: Mutex::new(initial_key.map(|key| ArtificialAnalysisStoredCredential {
                key: key.to_string(),
                generation: initial_generation,
            })),
            delete_error: Mutex::new(None),
        });
        let cache_store = Arc::new(TestCacheStore {
            cache: Mutex::new(initial_cache),
            write_error: Mutex::new(None),
            delete_error: Mutex::new(None),
            read_gate: Mutex::new(None),
        });
        let fetcher = Arc::new(TestFetcher {
            calls: AtomicU64::new(0),
            behavior: Mutex::new(FetcherBehavior::Default),
        });
        let runtime = ArtificialAnalysisRuntime::new(ArtificialAnalysisRuntimeDependencies {
            credentials: credentials.clone(),
            cache: cache_store.clone(),
            fetch_catalog: fetcher.clone(),
        });
        (runtime, credentials, cache_store, fetcher)
    }

    #[tokio::test]
    async fn status_and_catalog_reads_are_offline_and_connecting_fetches_exactly_once() {
        let (runtime, _, _, fetcher) = runtime_fixture(None, None);
        assert_eq!(
            runtime.status().await.unwrap(),
            ArtificialAnalysisStatus {
                state: ArtificialAnalysisConnectionState::NotConnected,
                has_key: false,
                cleanup_needed: false,
                ready: false,
                cached_model_count: 0,
                ranked_model_count: 0,
                fetched_at: None,
                tier: None,
                intelligence_index_version: None,
            }
        );
        assert_eq!(runtime.catalog().await.unwrap(), None);
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 0);

        let connected = runtime
            .connect("new-key", UserInitiated::explicit())
            .await
            .unwrap();
        assert_eq!(connected.state, ArtificialAnalysisConnectionState::Ready);
        assert_eq!(connected.cached_model_count, 1);
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        let catalog = runtime.catalog().await.unwrap().unwrap();
        assert!(catalog.models[0].id.starts_with("from-new-key"));
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn offline_reads_do_not_wait_for_an_in_flight_manual_fetch() {
        let old_cache = catalog("old-model", "generation-old-model");
        let (runtime, _, cache_store, fetcher) =
            runtime_fixture(Some("old-key"), Some(old_cache.clone()));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *fetcher.behavior.lock().unwrap() = FetcherBehavior::Blocked {
            started: started_tx,
            may_finish: release_rx,
        };

        let connect = runtime.connect("new-key", UserInitiated::explicit());
        tokio::pin!(connect);
        let _ = started_rx.recv_timeout(std::time::Duration::from_secs(2));
        let status_during = runtime.status().await.unwrap();
        let catalog_during = runtime.catalog().await.unwrap().unwrap();
        assert_eq!(
            status_during.state,
            ArtificialAnalysisConnectionState::Ready
        );
        assert_eq!(catalog_during.models[0].id, "old-model");
        let _ = release_tx.send(());
        let connected = connect.await.unwrap();
        assert_eq!(connected.state, ArtificialAnalysisConnectionState::Ready);
        let after = runtime.catalog().await.unwrap().unwrap();
        assert!(after.models[0].id.starts_with("from-new-key"));
        let _ = cache_store;
    }

    #[tokio::test]
    async fn failed_replacement_preserves_the_previous_key_and_cache() {
        let old_cache = catalog("old-model", "generation-old-model");
        let (runtime, credentials, cache_store, fetcher) =
            runtime_fixture(Some("old-key"), Some(old_cache.clone()));
        *fetcher.behavior.lock().unwrap() =
            FetcherBehavior::Fail(ArtificialAnalysisFetchError::new(
                ArtificialAnalysisFetchErrorCode::InvalidKey,
                "The replacement key was rejected.",
            ));
        let error = runtime
            .connect("bad-key", UserInitiated::explicit())
            .await
            .unwrap_err();
        assert!(error.message().contains("replacement key was rejected"));
        assert_eq!(
            credentials.credential.lock().unwrap().as_ref().unwrap().key,
            "old-key"
        );
        assert_eq!(
            cache_store.cache.lock().unwrap().as_ref().unwrap().models[0].id,
            "old-model"
        );
    }

    #[tokio::test]
    async fn cache_persistence_failure_rolls_a_replacement_key_back() {
        let old_cache = catalog("old-model", "generation-old-model");
        let (runtime, credentials, cache_store, fetcher) =
            runtime_fixture(Some("old-key"), Some(old_cache.clone()));
        *cache_store.write_error.lock().unwrap() = Some("disk full".to_string());
        let error = runtime
            .connect("new-key", UserInitiated::explicit())
            .await
            .unwrap_err();
        assert!(error.message().contains("disk full"));
        assert_eq!(
            credentials.credential.lock().unwrap().as_ref().unwrap().key,
            "old-key"
        );
        assert_eq!(
            cache_store.cache.lock().unwrap().as_ref().unwrap().models[0].id,
            "old-model"
        );
        let _ = fetcher;
    }

    #[tokio::test]
    async fn refresh_is_explicit_uses_the_stored_key_and_disconnect_removes_both() {
        let old_cache = catalog("old-model", "generation-old-model");
        let (runtime, credentials, cache_store, fetcher) =
            runtime_fixture(Some("saved-key"), Some(old_cache));
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 0);
        let refreshed = runtime.refresh(UserInitiated::explicit()).await.unwrap();
        assert_eq!(refreshed.state, ArtificialAnalysisConnectionState::Ready);
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        let cache = cache_store.cache.lock().unwrap().clone().unwrap();
        assert_eq!(
            credentials
                .credential
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .generation,
            cache.source.generation
        );
        assert_eq!(cache.models[0].id, "from-saved-key");
        let disconnected = runtime.disconnect().await.unwrap();
        assert_eq!(
            disconnected,
            ArtificialAnalysisStatus {
                state: ArtificialAnalysisConnectionState::NotConnected,
                has_key: false,
                cleanup_needed: false,
                ready: false,
                cached_model_count: 0,
                ranked_model_count: 0,
                fetched_at: None,
                tier: None,
                intelligence_index_version: None,
            }
        );
        assert_eq!(*credentials.credential.lock().unwrap(), None);
        assert_eq!(*cache_store.cache.lock().unwrap(), None);
    }

    #[tokio::test]
    async fn partial_disconnect_failures_remain_offline_readable_and_fail_closed() {
        // Key deletion fails.
        let old_cache = catalog("old-model", "generation-old-model");
        let (runtime, credentials, cache_store, _fetcher) =
            runtime_fixture(Some("saved-key"), Some(old_cache));
        *credentials.delete_error.lock().unwrap() = Some("keychain unavailable".to_string());
        let error = runtime.disconnect().await.unwrap_err();
        assert!(error.message().contains("keychain unavailable"));
        assert_eq!(
            credentials.credential.lock().unwrap().as_ref().unwrap().key,
            "saved-key"
        );
        assert_eq!(*cache_store.cache.lock().unwrap(), None);
        let status = runtime.status().await.unwrap();
        assert_eq!(status.state, ArtificialAnalysisConnectionState::Connected);
        assert!(status.has_key);
        assert!(!status.cleanup_needed);
        assert!(!status.ready);
        assert_eq!(runtime.catalog().await.unwrap(), None);
        *credentials.delete_error.lock().unwrap() = None;
        assert!(!runtime.disconnect().await.unwrap().cleanup_needed);
        assert_eq!(*credentials.credential.lock().unwrap(), None);

        // Cache deletion fails.
        let old_cache = catalog("old-model", "generation-old-model");
        let (runtime, credentials, cache_store, fetcher) =
            runtime_fixture(Some("saved-key"), Some(old_cache));
        *cache_store.delete_error.lock().unwrap() = Some("cache unavailable".to_string());
        let error = runtime.disconnect().await.unwrap_err();
        assert!(error.message().contains("cache unavailable"));
        assert_eq!(*credentials.credential.lock().unwrap(), None);
        assert!(cache_store.cache.lock().unwrap().is_some());
        let status = runtime.status().await.unwrap();
        assert_eq!(
            status.state,
            ArtificialAnalysisConnectionState::NotConnected
        );
        assert!(!status.has_key);
        assert!(status.cleanup_needed);
        assert_eq!(runtime.catalog().await.unwrap(), None);
        *cache_store.delete_error.lock().unwrap() = None;
        assert!(!runtime.disconnect().await.unwrap().cleanup_needed);
        assert_eq!(*cache_store.cache.lock().unwrap(), None);
        let _ = fetcher;
    }

    // =====================================================================
    // cache store tests (artificial-analysis-cache.test.ts)
    // =====================================================================

    #[tokio::test]
    async fn file_store_writes_and_reads_a_validated_cache_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("nested").join("cache.json");
        let invalid = Arc::new(Mutex::new(Vec::new()));
        let store = Arc::new(FileArtificialAnalysisCacheStore::new(
            FileArtificialAnalysisCacheStoreOptions {
                file_path: file.clone(),
                on_invalid: Some(Arc::new({
                    let invalid = invalid.clone();
                    move |message| invalid.lock().unwrap().push(message)
                })),
                ..Default::default()
            },
        ));
        let expected = catalog("model-a", "generation-model-a");
        assert_eq!(store.read().await.unwrap(), None);
        store.write(&expected).await.unwrap();
        assert_eq!(store.read().await.unwrap().unwrap(), expected);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let raw = tokio::fs::read_to_string(&file).await.unwrap();
        assert!(raw.contains("Artificial Analysis"));
        assert!(!raw.contains("x-api-key"));
        assert!(!raw.contains("credential"));
        assert!(!raw.contains("secret"));
    }

    #[tokio::test]
    async fn file_store_warns_but_does_not_fail_when_directory_sync_fails() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("cache.json");
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let store = Arc::new(FileArtificialAnalysisCacheStore::new(
            FileArtificialAnalysisCacheStoreOptions {
                file_path: file.clone(),
                on_durability_warning: Some(Arc::new({
                    let warnings = warnings.clone();
                    move |message| warnings.lock().unwrap().push(message)
                })),
                sync_directory: Some(Arc::new(|_| Err("directory sync unsupported".to_string()))),
                ..Default::default()
            },
        ));
        let expected = catalog("model-a", "generation-model-a");
        store.write(&expected).await.unwrap();
        assert_eq!(store.read().await.unwrap().unwrap(), expected);
        assert_eq!(warnings.lock().unwrap().len(), 1);
        assert!(warnings.lock().unwrap()[0].contains("unsupported"));
    }

    #[tokio::test]
    async fn file_store_ignores_a_malformed_local_cache_and_reports_it() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("nested").join("cache.json");
        tokio::fs::create_dir_all(file.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&file, "not json").await.unwrap();
        let invalid = Arc::new(Mutex::new(Vec::new()));
        let store = Arc::new(FileArtificialAnalysisCacheStore::new(
            FileArtificialAnalysisCacheStoreOptions {
                file_path: file.clone(),
                on_invalid: Some(Arc::new({
                    let invalid = invalid.clone();
                    move |message| invalid.lock().unwrap().push(message)
                })),
                ..Default::default()
            },
        ));
        assert_eq!(store.read().await.unwrap(), None);
        assert_eq!(invalid.lock().unwrap().len(), 1);
        assert_eq!(tokio::fs::read_to_string(&file).await.unwrap(), "not json");
    }

    #[tokio::test]
    async fn file_store_rejects_an_oversized_serialized_cache_before_replacing_the_destination() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("cache.json");
        let store = Arc::new(FileArtificialAnalysisCacheStore::new(
            FileArtificialAnalysisCacheStoreOptions {
                file_path: file.clone(),
                max_bytes: Some(128),
                ..Default::default()
            },
        ));
        let error = store
            .write(&catalog("model-a", "generation-model-a"))
            .await
            .unwrap_err();
        assert!(error.contains("size limit"));
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn file_store_deletes_without_failing_when_already_absent() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("cache.json");
        let store = Arc::new(FileArtificialAnalysisCacheStore::new(
            FileArtificialAnalysisCacheStoreOptions {
                file_path: file.clone(),
                ..Default::default()
            },
        ));
        store.delete().await.unwrap();
        store
            .write(&catalog("model-a", "generation-model-a"))
            .await
            .unwrap();
        store.delete().await.unwrap();
        assert!(!file.exists());
        store.delete().await.unwrap();
    }
}
