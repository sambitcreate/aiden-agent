//! Privacy-safe aggregate model usage (port of `main/services/usage-store-core.ts`
//! + the `usage-store.ts` binding).
//!
//! Layout: `userData/usage.json` → `{ version: 1, buckets: DailyUsageBucket[] }`
//! where each bucket aggregates one (day × source × provider × model ×
//! local/hosted) dimension. A `UsageRequestRecord` intentionally **cannot**
//! carry prompts, chat ids, workspace ids, paths, or generated content — the
//! same privacy property as the TS side.
//!
//! The store tolerantly normalizes whatever is on disk (`normalize_database`),
//! serializes every mutation behind one lock tail, and answers
//! [`UsageStore::summary`] over `7d / 30d / 90d / 1y / all` windows with the
//! calendar-streak logic used by the heatmap / scoreboard renderer views
//! (`renderer/components/usage/*`).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::DataStore;

/// `UsageRequestSource` in usage-store-core.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageRequestSource {
    #[default]
    Chat,
    ChatTitle,
    VoiceTranscription,
    Scheduled,
    Subagent,
}

impl UsageRequestSource {
    pub fn as_str(self) -> &'static str {
        match self {
            UsageRequestSource::Chat => "chat",
            UsageRequestSource::ChatTitle => "chat-title",
            UsageRequestSource::VoiceTranscription => "voice-transcription",
            UsageRequestSource::Scheduled => "scheduled",
            UsageRequestSource::Subagent => "subagent",
        }
    }

    pub fn parse(value: &str) -> Option<UsageRequestSource> {
        match value {
            "chat" => Some(UsageRequestSource::Chat),
            "chat-title" => Some(UsageRequestSource::ChatTitle),
            "voice-transcription" => Some(UsageRequestSource::VoiceTranscription),
            "scheduled" => Some(UsageRequestSource::Scheduled),
            "subagent" => Some(UsageRequestSource::Subagent),
            _ => None,
        }
    }
}

/// `UsageRequestStatus` in usage-store-core.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageRequestStatus {
    Completed,
    Failed,
    Cancelled,
}

/// `UsageCostStatus` in usage-store-core.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageCostStatus {
    Reported,
    Unavailable,
    NotApplicable,
}

/// `UsageTokenBreakdown` in types.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageTokenBreakdown {
    pub input: u64,
    pub output: u64,
    #[serde(rename = "cacheRead")]
    pub cache_read: u64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: u64,
    pub reasoning: u64,
    pub total: u64,
}

/// `UsageRequestRecord` in usage-store-core.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRequestRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
    pub source: UsageRequestSource,
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "providerLabel")]
    pub provider_label: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "modelLabel")]
    pub model_label: String,
    pub local: bool,
    pub status: UsageRequestStatus,
    pub tokens: Option<UsageTokenBreakdown>,
    #[serde(rename = "costStatus")]
    pub cost_status: UsageCostStatus,
    #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// `DailyUsageBucket` in usage-store-core.ts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DailyUsageBucket {
    pub date: String,
    pub source: UsageRequestSource,
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "providerLabel")]
    pub provider_label: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "modelLabel")]
    pub model_label: String,
    pub local: bool,
    pub requests: u64,
    #[serde(rename = "completedRequests")]
    pub completed_requests: u64,
    #[serde(rename = "failedRequests")]
    pub failed_requests: u64,
    #[serde(rename = "cancelledRequests")]
    pub cancelled_requests: u64,
    #[serde(rename = "reportedTokenRequests")]
    pub reported_token_requests: u64,
    #[serde(rename = "unmeteredRequests")]
    pub unmetered_requests: u64,
    #[serde(rename = "costedRequests")]
    pub costed_requests: u64,
    #[serde(rename = "unpricedHostedRequests")]
    pub unpriced_hosted_requests: u64,
    pub tokens: UsageTokenBreakdown,
    #[serde(rename = "hostedCostUsd")]
    pub hosted_cost_usd: f64,
}

/// `UsageDatabase` in usage-store-core.ts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageDatabase {
    pub version: u8,
    pub buckets: Vec<DailyUsageBucket>,
}

/// `UsageDateRange` in types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageDateRange {
    Days7,
    Days30,
    Days90,
    Year1,
    All,
}

impl UsageDateRange {
    pub fn as_str(self) -> &'static str {
        match self {
            UsageDateRange::Days7 => "7d",
            UsageDateRange::Days30 => "30d",
            UsageDateRange::Days90 => "90d",
            UsageDateRange::Year1 => "1y",
            UsageDateRange::All => "all",
        }
    }
}

/// `UsageDaySummary` in types.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageDaySummary {
    pub date: String,
    pub requests: u64,
    #[serde(rename = "reportedTokenRequests")]
    pub reported_token_requests: u64,
    #[serde(rename = "unmeteredRequests")]
    pub unmetered_requests: u64,
    pub tokens: UsageTokenBreakdown,
    #[serde(rename = "hostedCostUsd")]
    pub hosted_cost_usd: f64,
}

/// `UsageModelSummary` in types.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageModelSummary {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "providerLabel")]
    pub provider_label: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "modelLabel")]
    pub model_label: String,
    pub local: bool,
    pub requests: u64,
    #[serde(rename = "reportedTokenRequests")]
    pub reported_token_requests: u64,
    #[serde(rename = "unmeteredRequests")]
    pub unmetered_requests: u64,
    pub tokens: UsageTokenBreakdown,
    #[serde(rename = "hostedCostUsd")]
    pub hosted_cost_usd: f64,
}

/// `UsageSummary` in types.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageSummary {
    pub range: String,
    #[serde(rename = "startDate")]
    pub start_date: String,
    #[serde(rename = "endDate")]
    pub end_date: String,
    pub totals: UsageTotals,
    pub days: Vec<UsageDaySummary>,
    pub models: Vec<UsageModelSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageTotals {
    pub requests: u64,
    #[serde(rename = "completedRequests")]
    pub completed_requests: u64,
    #[serde(rename = "failedRequests")]
    pub failed_requests: u64,
    #[serde(rename = "cancelledRequests")]
    pub cancelled_requests: u64,
    #[serde(rename = "reportedTokenRequests")]
    pub reported_token_requests: u64,
    #[serde(rename = "unmeteredRequests")]
    pub unmetered_requests: u64,
    #[serde(rename = "localRequests")]
    pub local_requests: u64,
    #[serde(rename = "costedRequests")]
    pub costed_requests: u64,
    #[serde(rename = "unpricedHostedRequests")]
    pub unpriced_hosted_requests: u64,
    #[serde(rename = "hostedCostUsd")]
    pub hosted_cost_usd: f64,
    #[serde(rename = "activeDays")]
    pub active_days: u64,
    #[serde(rename = "currentStreak")]
    pub current_streak: u64,
    #[serde(rename = "longestStreak")]
    pub longest_streak: u64,
    pub tokens: UsageTokenBreakdown,
}

#[derive(Debug, thiserror::Error)]
pub enum UsageStoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("usage persistence error: {0}")]
    Store(#[from] crate::DataStoreError),
    #[error("Usage timestamp is outside the valid date range.")]
    InvalidTimestamp,
}

// ---------------------------------------------------------------------------
// Pure helpers (ported 1:1 from usage-store-core.ts)
// ---------------------------------------------------------------------------

pub fn empty_usage_tokens() -> UsageTokenBreakdown {
    UsageTokenBreakdown::default()
}

pub fn create_empty_usage_database() -> UsageDatabase {
    UsageDatabase {
        version: 1,
        buckets: Vec::new(),
    }
}

fn non_negative(value: &serde_json::Value) -> f64 {
    value
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0)
}

fn non_negative_integer(value: &serde_json::Value) -> u64 {
    non_negative(value).floor() as u64
}

fn normalize_tokens(value: Option<&serde_json::Value>) -> UsageTokenBreakdown {
    let value = value.and_then(|value| value.as_object());
    let get = |key: &str| {
        value
            .and_then(|map| map.get(key))
            .map(non_negative_integer)
            .unwrap_or(0)
    };
    UsageTokenBreakdown {
        input: get("input"),
        output: get("output"),
        cache_read: get("cacheRead"),
        cache_write: get("cacheWrite"),
        reasoning: get("reasoning"),
        total: get("total"),
    }
}

fn add_tokens(target: &mut UsageTokenBreakdown, value: &UsageTokenBreakdown) {
    target.input += value.input;
    target.output += value.output;
    target.cache_read += value.cache_read;
    target.cache_write += value.cache_write;
    target.reasoning += value.reasoning;
    target.total += value.total;
}

fn is_date_key(value: &str) -> bool {
    if value.len() != 10
        || !value.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return false;
    }
    // Validate as a real calendar date (TS: Date.UTC parse + round-trip).
    let parts: Vec<u32> = value
        .split('-')
        .filter_map(|part| part.parse().ok())
        .collect();
    let Some([year, month, day]) = parts
        .first()
        .zip(parts.get(1))
        .zip(parts.get(2))
        .map(|((y, m), d)| [*y, *m, *d])
    else {
        return false;
    };
    chrono::NaiveDate::from_ymd_opt(year as i32, month, day).is_some()
}

fn string_or(value: Option<&serde_json::Value>, fallback: &str) -> String {
    value
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn normalize_bucket(value: &serde_json::Value) -> Option<DailyUsageBucket> {
    let map = value.as_object()?;
    let date = map.get("date").and_then(|value| value.as_str())?;
    if !is_date_key(date) {
        return None;
    }
    let source = map
        .get("source")
        .and_then(|value| value.as_str())
        .and_then(UsageRequestSource::parse)?;
    let local = map
        .get("local")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let provider_id = string_or(map.get("providerId"), "unknown");
    let model_id = string_or(map.get("modelId"), "unknown");
    Some(DailyUsageBucket {
        date: date.to_string(),
        source,
        provider_id: provider_id.clone(),
        provider_label: string_or(map.get("providerLabel"), provider_id.as_str()),
        model_id: model_id.clone(),
        model_label: string_or(map.get("modelLabel"), model_id.as_str()),
        local,
        requests: map.get("requests").map(non_negative_integer).unwrap_or(0),
        completed_requests: map
            .get("completedRequests")
            .map(non_negative_integer)
            .unwrap_or(0),
        failed_requests: map
            .get("failedRequests")
            .map(non_negative_integer)
            .unwrap_or(0),
        cancelled_requests: map
            .get("cancelledRequests")
            .map(non_negative_integer)
            .unwrap_or(0),
        reported_token_requests: map
            .get("reportedTokenRequests")
            .map(non_negative_integer)
            .unwrap_or(0),
        unmetered_requests: map
            .get("unmeteredRequests")
            .map(non_negative_integer)
            .unwrap_or(0),
        costed_requests: if local {
            0
        } else {
            map.get("costedRequests")
                .map(non_negative_integer)
                .unwrap_or(0)
        },
        unpriced_hosted_requests: if local {
            0
        } else {
            map.get("unpricedHostedRequests")
                .map(non_negative_integer)
                .unwrap_or(0)
        },
        tokens: normalize_tokens(map.get("tokens")),
        hosted_cost_usd: if local {
            0.0
        } else {
            map.get("hostedCostUsd").map(non_negative).unwrap_or(0.0)
        },
    })
}

/// The tolerant on-disk reader (TS `normalizeDatabase`), also used as the
/// `DataStore` normalize hook so corrupt buckets are dropped, not fatal.
pub fn normalize_database(value: serde_json::Value) -> UsageDatabase {
    let Some(map) = value.as_object() else {
        return create_empty_usage_database();
    };
    let buckets = map
        .get("buckets")
        .and_then(|value| value.as_array())
        .map(|items| items.iter().filter_map(normalize_bucket).collect())
        .unwrap_or_default();
    UsageDatabase {
        version: 1,
        buckets,
    }
}

/// `localDateKey` in usage-store-core.ts: local-timezone `YYYY-MM-DD` for a ms
/// epoch.
pub fn local_date_key(timestamp: u64) -> Result<String, UsageStoreError> {
    let datetime = chrono::DateTime::from_timestamp_millis(timestamp as i64)
        .ok_or(UsageStoreError::InvalidTimestamp)?;
    Ok(datetime
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string())
}

/// `shiftDateKey` in usage-store-core.ts: UTC day arithmetic on `YYYY-MM-DD`.
pub fn shift_date_key(value: &str, days: i64) -> String {
    let mut parts = value.split('-').filter_map(|part| part.parse::<u32>().ok());
    let year = parts.next().unwrap_or(1970) as i32;
    let month = parts.next().unwrap_or(1);
    let day = parts.next().unwrap_or(1);
    let date = chrono::NaiveDate::from_ymd_opt(year, month, day)
        .unwrap_or_else(|| chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap());
    let shifted = date + chrono::Duration::days(days);
    shifted.format("%Y-%m-%d").to_string()
}

/// `dateOrdinal` in usage-store-core.ts: days since epoch (UTC).
fn date_ordinal(value: &str) -> i64 {
    let mut parts = value.split('-').filter_map(|part| part.parse::<u32>().ok());
    let year = parts.next().unwrap_or(1970) as i32;
    let month = parts.next().unwrap_or(1);
    let day = parts.next().unwrap_or(1);
    chrono::NaiveDate::from_ymd_opt(year, month, day)
        .map(|date| date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() / 86_400)
        .unwrap_or(0)
}

fn bucket_key(bucket: &DailyUsageBucket) -> String {
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
        bucket.date,
        bucket.source.as_str(),
        bucket.provider_id,
        bucket.model_id,
        if bucket.local { "local" } else { "hosted" },
    )
}

fn model_key(bucket: &DailyUsageBucket) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        bucket.provider_id,
        bucket.model_id,
        if bucket.local { "local" } else { "hosted" },
    )
}

fn streaks(active_dates: &[String], end_date: &str) -> (u64, u64) {
    let mut ordered: Vec<String> = active_dates.to_vec();
    ordered.sort();
    ordered.dedup();
    if ordered.is_empty() {
        return (0, 0);
    }
    let mut longest = 1u64;
    let mut run = 1u64;
    for index in 1..ordered.len() {
        if date_ordinal(&ordered[index]) - date_ordinal(&ordered[index - 1]) == 1 {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 1;
        }
    }
    let active: std::collections::HashSet<String> = ordered.iter().cloned().collect();
    let mut cursor = if active.contains(end_date) {
        Some(end_date.to_string())
    } else {
        let previous = shift_date_key(end_date, -1);
        if active.contains(&previous) {
            Some(previous)
        } else {
            None
        }
    };
    let mut current = 0u64;
    while let Some(day) = cursor {
        if !active.contains(&day) {
            break;
        }
        current += 1;
        cursor = Some(shift_date_key(&day, -1));
    }
    (current, longest)
}

fn summary_from_database(
    database: &UsageDatabase,
    range: UsageDateRange,
    now: u64,
) -> Result<UsageSummary, UsageStoreError> {
    let end_date = local_date_key(now)?;
    let earliest = database
        .buckets
        .iter()
        .map(|bucket| bucket.date.as_str())
        .min();
    let start_date = if range == UsageDateRange::All {
        earliest.unwrap_or(end_date.as_str()).to_string()
    } else {
        let days = match range {
            UsageDateRange::Days7 => 7,
            UsageDateRange::Days30 => 30,
            UsageDateRange::Days90 => 90,
            UsageDateRange::Year1 => 365,
            UsageDateRange::All => unreachable!(),
        };
        shift_date_key(&end_date, -(days - 1))
    };

    let mut totals = UsageTotals::default();
    let mut day_map: BTreeMap<String, UsageDaySummary> = BTreeMap::new();
    let mut models: BTreeMap<String, UsageModelSummary> = BTreeMap::new();

    for bucket in database.buckets.iter().filter(|bucket| {
        bucket.date.as_str() >= start_date.as_str() && bucket.date.as_str() <= end_date.as_str()
    }) {
        totals.requests += bucket.requests;
        totals.completed_requests += bucket.completed_requests;
        totals.failed_requests += bucket.failed_requests;
        totals.cancelled_requests += bucket.cancelled_requests;
        totals.reported_token_requests += bucket.reported_token_requests;
        totals.unmetered_requests += bucket.unmetered_requests;
        if bucket.local {
            totals.local_requests += bucket.requests;
        }
        totals.costed_requests += bucket.costed_requests;
        totals.unpriced_hosted_requests += bucket.unpriced_hosted_requests;
        totals.hosted_cost_usd += bucket.hosted_cost_usd;
        add_tokens(&mut totals.tokens, &bucket.tokens);

        let day = day_map
            .entry(bucket.date.clone())
            .or_insert_with(|| UsageDaySummary {
                date: bucket.date.clone(),
                requests: 0,
                reported_token_requests: 0,
                unmetered_requests: 0,
                tokens: empty_usage_tokens(),
                hosted_cost_usd: 0.0,
            });
        day.requests += bucket.requests;
        day.reported_token_requests += bucket.reported_token_requests;
        day.unmetered_requests += bucket.unmetered_requests;
        day.hosted_cost_usd += bucket.hosted_cost_usd;
        add_tokens(&mut day.tokens, &bucket.tokens);

        let key = model_key(bucket);
        let model = models.entry(key).or_insert_with(|| UsageModelSummary {
            provider_id: bucket.provider_id.clone(),
            provider_label: bucket.provider_label.clone(),
            model_id: bucket.model_id.clone(),
            model_label: bucket.model_label.clone(),
            local: bucket.local,
            requests: 0,
            reported_token_requests: 0,
            unmetered_requests: 0,
            tokens: empty_usage_tokens(),
            hosted_cost_usd: 0.0,
        });
        model.provider_label = bucket.provider_label.clone();
        model.model_label = bucket.model_label.clone();
        model.requests += bucket.requests;
        model.reported_token_requests += bucket.reported_token_requests;
        model.unmetered_requests += bucket.unmetered_requests;
        model.hosted_cost_usd += bucket.hosted_cost_usd;
        add_tokens(&mut model.tokens, &bucket.tokens);
    }

    let days: Vec<UsageDaySummary> = day_map.into_values().collect();
    let active_dates: Vec<String> = days
        .iter()
        .filter(|day| day.requests > 0)
        .map(|day| day.date.clone())
        .collect();
    let (current_streak, longest_streak) = streaks(&active_dates, &end_date);
    totals.active_days = active_dates.len() as u64;
    totals.current_streak = current_streak;
    totals.longest_streak = longest_streak;

    let mut models: Vec<UsageModelSummary> = models.into_values().collect();
    models.sort_by(|left, right| {
        right
            .requests
            .cmp(&left.requests)
            .then_with(|| right.tokens.total.cmp(&left.tokens.total))
            .then_with(|| left.model_label.cmp(&right.model_label))
    });

    Ok(UsageSummary {
        range: range.as_str().to_string(),
        start_date,
        end_date,
        totals,
        days,
        models,
    })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// The persistence seam (TS `UsagePersistence`).
pub trait UsagePersistence: Send + Sync {
    fn load(&self) -> Result<serde_json::Value, UsageStoreError>;
    fn save(&self, database: &UsageDatabase) -> Result<(), UsageStoreError>;
}

/// `DataStore`-backed persistence for `userData/usage.json`.
pub struct DataStoreUsagePersistence {
    store: DataStore<UsageDatabase>,
}

impl DataStoreUsagePersistence {
    pub fn new(root: Option<PathBuf>) -> Self {
        let mut options = crate::DataStoreOptions::new();
        options.normalize = Some(Box::new(normalize_database));
        Self {
            store: DataStore::new("usage.json", create_empty_usage_database(), root, options),
        }
    }
}

impl UsagePersistence for DataStoreUsagePersistence {
    fn load(&self) -> Result<serde_json::Value, UsageStoreError> {
        let database = self.store.load()?;
        Ok(serde_json::to_value(database)?)
    }

    fn save(&self, database: &UsageDatabase) -> Result<(), UsageStoreError> {
        self.store.save(database)?;
        Ok(())
    }
}

/// A load/save seam for in-memory tests (the TS `memoryPersistence` helper).
pub struct MemoryUsagePersistence {
    value: parking_lot::Mutex<UsageDatabase>,
}

impl MemoryUsagePersistence {
    pub fn new() -> Self {
        Self {
            value: parking_lot::Mutex::new(create_empty_usage_database()),
        }
    }

    pub fn read(&self) -> UsageDatabase {
        self.value.lock().clone()
    }

    pub fn replace(&self, database: UsageDatabase) {
        *self.value.lock() = database;
    }
}

impl Default for MemoryUsagePersistence {
    fn default() -> Self {
        Self::new()
    }
}

impl UsagePersistence for MemoryUsagePersistence {
    fn load(&self) -> Result<serde_json::Value, UsageStoreError> {
        let value = self.value.lock().clone();
        Ok(serde_json::to_value(value)?)
    }

    fn save(&self, database: &UsageDatabase) -> Result<(), UsageStoreError> {
        *self.value.lock() = database.clone();
        Ok(())
    }
}

/// The store (TS `createUsageStore`): lazy tolerant load + serialized
/// mutations behind one lock tail, `record` + `summary`.
pub struct UsageStore {
    persistence: Arc<dyn UsagePersistence>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    tail: parking_lot::Mutex<()>,
}

impl UsageStore {
    pub fn new(
        persistence: Arc<dyn UsagePersistence>,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            persistence,
            now,
            tail: parking_lot::Mutex::new(()),
        }
    }

    pub fn new_data_store(root: Option<PathBuf>) -> Self {
        Self::new(
            Arc::new(DataStoreUsagePersistence::new(root)),
            Box::new(crate::now_millis),
        )
    }

    /// `store.record(record)`: append one privacy-safe aggregate mutation.
    pub fn record(&self, record: &UsageRequestRecord) -> Result<(), UsageStoreError> {
        let _guard = self.tail.lock();
        let mut database = normalize_database(self.persistence.load()?);
        let timestamp = record
            .timestamp
            .filter(|value| *value > 0)
            .unwrap_or_else(|| (self.now)());
        let date = local_date_key(timestamp)?;
        let provider_id = string_or_value(&record.provider_id, "unknown");
        let provider_label = string_or_value(&record.provider_label, provider_id.as_str());
        let model_id = string_or_value(&record.model_id, "unknown");
        let model_label = string_or_value(&record.model_label, model_id.as_str());

        let descriptor = DailyUsageBucket {
            date,
            source: record.source,
            provider_id: provider_id.clone(),
            provider_label,
            model_id: model_id.clone(),
            model_label,
            local: record.local,
            requests: 0,
            completed_requests: 0,
            failed_requests: 0,
            cancelled_requests: 0,
            reported_token_requests: 0,
            unmetered_requests: 0,
            costed_requests: 0,
            unpriced_hosted_requests: 0,
            tokens: empty_usage_tokens(),
            hosted_cost_usd: 0.0,
        };
        let key = bucket_key(&descriptor);
        let bucket_index = database
            .buckets
            .iter()
            .position(|candidate| bucket_key(candidate) == key)
            .unwrap_or_else(|| {
                database.buckets.push(descriptor.clone());
                database.buckets.len() - 1
            });
        let bucket = &mut database.buckets[bucket_index];
        bucket.provider_label = descriptor.provider_label.clone();
        bucket.model_label = descriptor.model_label.clone();
        bucket.requests += 1;
        match record.status {
            UsageRequestStatus::Completed => bucket.completed_requests += 1,
            UsageRequestStatus::Cancelled => bucket.cancelled_requests += 1,
            UsageRequestStatus::Failed => bucket.failed_requests += 1,
        }
        if let Some(tokens) = &record.tokens {
            bucket.reported_token_requests += 1;
            add_tokens(
                &mut bucket.tokens,
                &normalize_tokens(Some(&serde_json::json!(tokens))),
            );
        } else {
            bucket.unmetered_requests += 1;
        }
        if !record.local && record.cost_status == UsageCostStatus::Reported {
            bucket.costed_requests += 1;
            bucket.hosted_cost_usd += record.cost_usd.unwrap_or(0.0).max(0.0);
        } else if !record.local {
            bucket.unpriced_hosted_requests += 1;
        }
        self.persistence.save(&database)?;
        Ok(())
    }

    /// `store.summary(range)`: the renderer heatmap/scoreboard data.
    pub fn summary(&self, range: UsageDateRange) -> Result<UsageSummary, UsageStoreError> {
        let _guard = self.tail.lock();
        let database = normalize_database(self.persistence.load()?);
        summary_from_database(&database, range, (self.now)())
    }
}

fn string_or_value(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// `new Date(2026, 6, 21, 12).getTime()` in *local* time (mirrors the TS
    /// test constant).
    fn local_ts(year: i32, month: u32, day: u32, hour: u32) -> u64 {
        use chrono::{Local, TimeZone};
        Local
            .with_ymd_and_hms(year, month, day, hour, 0, 0)
            .single()
            .expect("valid local datetime")
            .timestamp_millis() as u64
    }

    fn now_ts() -> u64 {
        local_ts(2026, 7, 21, 12)
    }

    /// `new Date(2026, 6, day, 12).getTime()` (local).
    fn day_ts(day: u32) -> u64 {
        local_ts(2026, 7, day, 12)
    }

    fn record(patch: &serde_json::Value) -> UsageRequestRecord {
        serde_json::from_value(patch.clone()).expect("valid record")
    }

    fn store_with(persistence: Arc<MemoryUsagePersistence>) -> UsageStore {
        UsageStore::new(persistence, Box::new(now_ts))
    }

    fn memory_store() -> (UsageStore, Arc<MemoryUsagePersistence>) {
        let persistence = Arc::new(MemoryUsagePersistence::new());
        let store = store_with(persistence.clone());
        (store, persistence)
    }

    #[test]
    fn aggregates_reported_tokens_while_keeping_unmetered_and_local_visible() {
        let (store, persistence) = memory_store();
        store
            .record(&record(&serde_json::json!({
                "timestamp": now_ts(),
                "source": "chat",
                "providerId": "openai",
                "providerLabel": "OpenAI",
                "modelId": "gpt-test",
                "modelLabel": "GPT Test",
                "local": false,
                "status": "completed",
                "tokens": {"input": 80, "output": 20, "cacheRead": 10, "cacheWrite": 0, "reasoning": 5, "total": 110},
                "costStatus": "reported",
                "costUsd": 0.025,
            })))
            .unwrap();
        store
            .record(&record(&serde_json::json!({
                "timestamp": now_ts(),
                "source": "chat",
                "providerId": "ollama",
                "providerLabel": "Ollama (local)",
                "modelId": "qwen-local",
                "modelLabel": "Qwen Local",
                "local": true,
                "status": "completed",
                "tokens": null,
                "costStatus": "not-applicable",
            })))
            .unwrap();
        store
            .record(&record(&serde_json::json!({
                "timestamp": now_ts(),
                "source": "chat",
                "providerId": "anthropic",
                "providerLabel": "Anthropic",
                "modelId": "claude-test",
                "modelLabel": "Claude Test",
                "local": false,
                "status": "completed",
                "tokens": {"input": 40, "output": 10, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "total": 50},
                "costStatus": "unavailable",
            })))
            .unwrap();

        let summary = store.summary(UsageDateRange::Year1).unwrap();
        assert_eq!(summary.totals.requests, 3);
        assert_eq!(summary.totals.reported_token_requests, 2);
        assert_eq!(summary.totals.unmetered_requests, 1);
        assert_eq!(summary.totals.local_requests, 1);
        assert_eq!(summary.totals.costed_requests, 1);
        assert_eq!(summary.totals.unpriced_hosted_requests, 1);
        assert!((summary.totals.hosted_cost_usd - 0.025).abs() < 1e-9);
        assert_eq!(
            summary.totals.tokens,
            UsageTokenBreakdown {
                input: 120,
                output: 30,
                cache_read: 10,
                cache_write: 0,
                reasoning: 5,
                total: 160
            }
        );
        let model_ids: Vec<&str> = summary
            .models
            .iter()
            .map(|model| model.model_id.as_str())
            .collect();
        assert_eq!(model_ids, vec!["gpt-test", "claude-test", "qwen-local"]);
        assert_eq!(
            summary
                .models
                .iter()
                .find(|model| model.local)
                .unwrap()
                .unmetered_requests,
            1
        );
        // The on-disk layout keeps only the aggregate shape (no content fields).
        assert!(persistence.read().version == 1);
    }

    #[test]
    fn persists_subagent_requests_as_a_first_class_source() {
        let (store, persistence) = memory_store();
        store
            .record(&record(&serde_json::json!({
                "timestamp": now_ts(),
                "source": "subagent",
                "providerId": "openai",
                "providerLabel": "OpenAI",
                "modelId": "child-model",
                "modelLabel": "Child Model",
                "local": false,
                "status": "completed",
                "tokens": null,
                "costStatus": "unavailable",
            })))
            .unwrap();
        assert_eq!(
            persistence.read().buckets[0].source,
            UsageRequestSource::Subagent
        );
        let reloaded = store_with(persistence.clone());
        assert_eq!(
            reloaded
                .summary(UsageDateRange::Days7)
                .unwrap()
                .totals
                .requests,
            1
        );
    }

    #[test]
    fn computes_calendar_streaks_and_honors_inclusive_date_ranges() {
        let (store, _persistence) = memory_store();
        for day in [15u32, 18, 19, 20] {
            let ts = day_ts(day);
            store
                .record(&record(&serde_json::json!({
                    "timestamp": ts,
                    "source": "chat",
                    "providerId": "openai",
                    "providerLabel": "OpenAI",
                    "modelId": "gpt-test",
                    "modelLabel": "GPT Test",
                    "local": false,
                    "status": "completed",
                    "tokens": null,
                    "costStatus": "unavailable",
                })))
                .unwrap();
        }
        // A far older record (2025-01-02) falls outside the 7d window.
        let old_ts = local_ts(2025, 1, 2, 12);
        store
            .record(&record(&serde_json::json!({
                "timestamp": old_ts,
                "source": "chat",
                "providerId": "openai",
                "providerLabel": "OpenAI",
                "modelId": "gpt-test",
                "modelLabel": "GPT Test",
                "local": false,
                "status": "completed",
                "tokens": null,
                "costStatus": "unavailable",
            })))
            .unwrap();

        let week = store.summary(UsageDateRange::Days7).unwrap();
        assert_eq!(week.start_date, "2026-07-15");
        assert_eq!(week.totals.active_days, 4);
        assert_eq!(week.totals.current_streak, 3);
        assert_eq!(week.totals.longest_streak, 3);
        assert_eq!(week.totals.requests, 4);

        let all = store.summary(UsageDateRange::All).unwrap();
        assert_eq!(all.start_date, "2025-01-02");
        assert_eq!(all.totals.requests, 5);
    }

    #[test]
    fn ignores_impossible_dates_and_recovers_with_a_valid_record() {
        let persistence = Arc::new(MemoryUsagePersistence::new());
        persistence.replace(normalize_database(serde_json::json!({
            "version": 1,
            "buckets": [{
                "date": "2026-02-31",
                "source": "chat",
                "providerId": "openai",
                "providerLabel": "OpenAI",
                "modelId": "gpt-test",
                "modelLabel": "GPT Test",
                "local": false,
                "requests": 99,
            }],
        })));
        let store = store_with(persistence.clone());
        assert_eq!(
            store.summary(UsageDateRange::All).unwrap().totals.requests,
            0
        );
        store
            .record(&record(&serde_json::json!({
                "timestamp": now_ts(),
                "source": "chat",
                "providerId": "openai",
                "providerLabel": "OpenAI",
                "modelId": "gpt-test",
                "modelLabel": "GPT Test",
                "local": false,
                "status": "completed",
                "tokens": null,
                "costStatus": "unavailable",
            })))
            .unwrap();
        let summary = store.summary(UsageDateRange::All).unwrap();
        assert_eq!(summary.totals.requests, 1);
        assert_eq!(summary.start_date, local_date_key(now_ts()).unwrap());
        assert_eq!(persistence.read().buckets.len(), 1);
    }

    #[test]
    fn drops_hosted_cost_fields_from_corrupt_local_buckets() {
        let persistence = Arc::new(MemoryUsagePersistence::new());
        persistence.replace(normalize_database(serde_json::json!({
            "version": 1,
            "buckets": [{
                "date": "2026-07-21",
                "source": "chat",
                "providerId": "ollama",
                "providerLabel": "Ollama",
                "modelId": "local-model",
                "modelLabel": "Local Model",
                "local": true,
                "requests": 1,
                "completedRequests": 1,
                "unmeteredRequests": 1,
                "costedRequests": 1,
                "unpricedHostedRequests": 1,
                "hostedCostUsd": 99,
            }],
        })));
        let store = store_with(persistence.clone());
        let summary = store.summary(UsageDateRange::Days7).unwrap();
        assert_eq!(summary.totals.local_requests, 1);
        assert_eq!(summary.totals.costed_requests, 0);
        assert_eq!(summary.totals.unpriced_hosted_requests, 0);
        assert_eq!(summary.totals.hosted_cost_usd, 0.0);
        assert_eq!(summary.models[0].hosted_cost_usd, 0.0);
    }

    #[test]
    fn date_helpers_match_ts() {
        assert_eq!(local_date_key(now_ts()).unwrap().len(), 10);
        assert_eq!(shift_date_key("2026-07-21", -1), "2026-07-20");
        assert_eq!(shift_date_key("2026-03-01", -1), "2026-02-28");
        assert_eq!(shift_date_key("2024-03-01", -1), "2024-02-29"); // leap year
        assert!(is_date_key("2026-07-21"));
        assert!(!is_date_key("2026-02-31"));
        assert!(!is_date_key("2026-7-21"));
    }
}
