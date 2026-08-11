//! Profile/usage view (port of `renderer/components/usage/*` — activity
//! heatmap, token mix, model scoreboard — and `renderer/lib/usage-profile-data.ts`).
//!
//! The panel renders from an injected [`UsageDataSource`] (Arc'd; an
//! in-memory impl with demo data is provided). All aggregation/formatting
//! helpers are pure and unit-tested against the renderer contract.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, Entity, FocusHandle,
    FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    dialog::DialogButtonProps,
    h_flex,
    input::{Input, InputState},
    scroll::ScrollableElement as _,
    v_flex, ActiveTheme, Disableable as _, IconName, PixelsExt as _, Sizable as _, WindowExt as _,
};

use super::profile_share::{render_profile_share_png_with_timeout, ProfileShareData};

// ===========================================================================
// Data types (mirror of renderer/lib/types.ts usage surface)
// ===========================================================================

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct UsageTokenBreakdown {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageDaySummary {
    pub date: String,
    pub requests: u64,
    pub reported_token_requests: u64,
    pub unmetered_requests: u64,
    pub tokens: UsageTokenBreakdown,
    pub hosted_cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageModelSummary {
    pub provider_id: String,
    pub provider_label: String,
    pub model_id: String,
    pub model_label: String,
    pub local: bool,
    pub requests: u64,
    pub reported_token_requests: u64,
    pub unmetered_requests: u64,
    pub tokens: UsageTokenBreakdown,
    pub hosted_cost_usd: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct UsageTotals {
    pub requests: u64,
    pub completed_requests: u64,
    pub failed_requests: u64,
    pub cancelled_requests: u64,
    pub reported_token_requests: u64,
    pub unmetered_requests: u64,
    pub local_requests: u64,
    pub costed_requests: u64,
    pub unpriced_hosted_requests: u64,
    pub active_days: u64,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub hosted_cost_usd: f64,
    pub tokens: UsageTokenBreakdown,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageSummary {
    pub range: UsageDateRange,
    pub start_date: String,
    pub end_date: String,
    pub totals: UsageTotals,
    pub days: Vec<UsageDaySummary>,
    pub models: Vec<UsageModelSummary>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UsageDateRange {
    Days7,
    Days30,
    Days90,
    #[default]
    Year1,
    All,
}

impl UsageDateRange {
    pub const ALL: [Self; 5] = [
        Self::Days7,
        Self::Days30,
        Self::Days90,
        Self::Year1,
        Self::All,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Days7 => "7 days",
            Self::Days30 => "30 days",
            Self::Days90 => "90 days",
            Self::Year1 => "Past year",
            Self::All => "All time",
        }
    }
}

impl From<UsageDateRange> for aiden_data::usage_store::UsageDateRange {
    fn from(value: UsageDateRange) -> Self {
        match value {
            UsageDateRange::Days7 => Self::Days7,
            UsageDateRange::Days30 => Self::Days30,
            UsageDateRange::Days90 => Self::Days90,
            UsageDateRange::Year1 => Self::Year1,
            UsageDateRange::All => Self::All,
        }
    }
}

impl UsageDateRange {
    fn from_store(value: &str) -> Self {
        match value {
            "7d" => Self::Days7,
            "30d" => Self::Days30,
            "90d" => Self::Days90,
            "all" => Self::All,
            _ => Self::Year1,
        }
    }
}

// ===========================================================================
// Pure aggregation logic (port of renderer/lib/usage-profile-data.ts)
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageScoreMetric {
    Requests,
    Tokens,
    Cost,
}

impl UsageScoreMetric {
    pub fn label(self) -> &'static str {
        match self {
            UsageScoreMetric::Requests => "Requests",
            UsageScoreMetric::Tokens => "Tokens",
            UsageScoreMetric::Cost => "Cost",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActivityCell {
    pub date: String,
    pub in_range: bool,
    pub requests: u64,
    pub reported_tokens: u64,
    pub unmetered_requests: u64,
    /// 0..=4 heat level (0 = no activity / out of range).
    pub level: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActivityMonthLabel {
    pub week_index: usize,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActivityCalendar {
    pub cells: Vec<ActivityCell>,
    pub months: Vec<ActivityMonthLabel>,
    pub week_count: usize,
}

use chrono::Datelike;

fn parse_date_key(date: &str) -> chrono::NaiveDate {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap_or_default()
}

fn add_days(date: chrono::NaiveDate, count: i64) -> chrono::NaiveDate {
    date + chrono::Duration::days(count)
}

fn activity_level(day: Option<&UsageDaySummary>, max_requests: u64) -> u8 {
    let Some(day) = day else {
        return 0;
    };
    if day.requests == 0 {
        return 0;
    }
    if max_requests == 0 {
        return 1;
    }
    let scaled = (day.requests as f64 / max_requests as f64).sqrt() * 4.0;
    scaled.ceil().clamp(1.0, 4.0) as u8
}

/// `buildActivityCalendar` — the weeks×7 grid with month labels.
pub fn build_activity_calendar(summary: &UsageSummary) -> ActivityCalendar {
    let range_start = parse_date_key(&summary.start_date);
    let range_end = parse_date_key(&summary.end_date);
    let grid_start = add_days(
        range_start,
        -(range_start.weekday().num_days_from_sunday() as i64),
    );
    let grid_end = add_days(
        range_end,
        6 - range_end.weekday().num_days_from_sunday() as i64,
    );

    let max_requests = summary
        .days
        .iter()
        .map(|day| day.requests)
        .max()
        .unwrap_or(0);

    let mut cells: Vec<ActivityCell> = Vec::new();
    let mut months: Vec<ActivityMonthLabel> = Vec::new();
    let mut cursor = grid_start;
    while cursor <= grid_end {
        let key = cursor.format("%Y-%m-%d").to_string();
        let in_range = cursor >= range_start && cursor <= range_end;
        let day = in_range
            .then(|| summary.days.iter().find(|day| day.date == key))
            .flatten();
        let week_index = cells.len() / 7;
        if in_range
            && (cells.len() == range_start.weekday().num_days_from_sunday() as usize
                || cursor.day() == 1)
        {
            let label = cursor.format("%b").to_string();
            if !months.iter().any(|month| month.week_index == week_index) {
                months.push(ActivityMonthLabel { week_index, label });
            }
        }
        cells.push(ActivityCell {
            date: key,
            in_range,
            requests: day.map(|day| day.requests).unwrap_or(0),
            reported_tokens: day.map(|day| day.tokens.total).unwrap_or(0),
            unmetered_requests: day.map(|day| day.unmetered_requests).unwrap_or(0),
            level: if in_range {
                activity_level(day, max_requests)
            } else {
                0
            },
        });
        cursor = add_days(cursor, 1);
    }

    let week_count = cells.len().div_ceil(7);
    ActivityCalendar {
        cells,
        months,
        week_count,
    }
}

/// `rankUsageModels` — cost ranking only considers hosted, priced models.
pub fn rank_usage_models(
    models: &[UsageModelSummary],
    metric: UsageScoreMetric,
) -> Vec<UsageModelSummary> {
    let eligible: Vec<&UsageModelSummary> = if metric == UsageScoreMetric::Cost {
        models
            .iter()
            .filter(|model| !model.local && model.hosted_cost_usd > 0.0)
            .collect()
    } else {
        models.iter().collect()
    };
    let mut ranked = eligible.into_iter().cloned().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        let score_difference =
            score_for_model(right, metric).partial_cmp(&score_for_model(left, metric));
        match score_difference {
            Some(std::cmp::Ordering::Equal) | None => {
                let requests = right.requests.cmp(&left.requests);
                if requests != std::cmp::Ordering::Equal {
                    requests
                } else {
                    left.model_label.cmp(&right.model_label)
                }
            }
            Some(order) => order,
        }
    });
    ranked
}

pub fn usage_model_score(model: &UsageModelSummary, metric: UsageScoreMetric) -> f64 {
    score_for_model(model, metric)
}

fn score_for_model(model: &UsageModelSummary, metric: UsageScoreMetric) -> f64 {
    match metric {
        UsageScoreMetric::Tokens => model.tokens.total as f64,
        UsageScoreMetric::Cost => model.hosted_cost_usd,
        UsageScoreMetric::Requests => model.requests as f64,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenMixKey {
    Input,
    Output,
    CacheRead,
    CacheWrite,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokenMixItem {
    pub key: TokenMixKey,
    pub label: &'static str,
    pub value: u64,
}

/// `buildTokenMix` — the fixed four buckets in render order.
pub fn build_token_mix(tokens: &UsageTokenBreakdown) -> Vec<TokenMixItem> {
    vec![
        TokenMixItem {
            key: TokenMixKey::Input,
            label: "Fresh input",
            value: tokens.input,
        },
        TokenMixItem {
            key: TokenMixKey::Output,
            label: "Output",
            value: tokens.output,
        },
        TokenMixItem {
            key: TokenMixKey::CacheRead,
            label: "Cache read",
            value: tokens.cache_read,
        },
        TokenMixItem {
            key: TokenMixKey::CacheWrite,
            label: "Cache write",
            value: tokens.cache_write,
        },
    ]
}

/// `formatTrackedUsd`.
pub fn format_tracked_usd(value: f64) -> String {
    if value > 0.0 && value < 0.0001 {
        return "<$0.0001".to_string();
    }
    let fraction_digits = if value > 0.0 && value < 0.01 { 4 } else { 2 };
    format!("${value:.fraction_digits$}")
}

/// `Intl.NumberFormat("en-US", { notation: "compact" })` equivalent.
pub fn compact_number(value: u64) -> String {
    let value = value as f64;
    let (divisor, suffix) = if value >= 1_000_000_000.0 {
        (1_000_000_000.0, "B")
    } else if value >= 1_000_000.0 {
        (1_000_000.0, "M")
    } else if value >= 1_000.0 {
        (1_000.0, "K")
    } else {
        return value.to_string();
    };
    let scaled = value / divisor;
    if scaled >= 100.0 {
        format!("{scaled:.0}{suffix}")
    } else {
        format!("{scaled:.1}{suffix}")
    }
}

/// `profileInitials`.
#[allow(dead_code)] // renderer-contract helper; the avatar shows a static "A" today
pub fn profile_initials(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    if words.is_empty() {
        return "A".to_string();
    }
    let selected: Vec<&str> = if words.len() == 1 {
        vec![words[0]]
    } else {
        vec![words[0], words[words.len() - 1]]
    };
    selected
        .iter()
        .filter_map(|word| word.chars().next())
        .collect::<String>()
        .to_uppercase()
}

// ===========================================================================
// Service dependencies
// ===========================================================================

/// Device-local profile and aggregate usage authority for this Mac.
pub trait UsageDataSource: Send + Sync {
    fn profile_name(&self) -> Result<String, String>;
    fn set_profile_name(&self, value: &str) -> Result<String, String>;
    fn summary(&self, range: UsageDateRange) -> Result<UsageSummary, String>;
}

/// Store-backed adapter over `aiden_data::usage_store::UsageStore`. The
/// store's summary types mirror the panel's (both port the same renderer
/// contract), so the mapping is a mechanical field copy (see the `From`
/// impls below).
pub struct StoreUsageSource {
    store: Arc<aiden_data::usage_store::UsageStore>,
    config: Arc<aiden_data::config_store::ConfigStore>,
}

impl StoreUsageSource {
    pub fn new(
        store: Arc<aiden_data::usage_store::UsageStore>,
        config: Arc<aiden_data::config_store::ConfigStore>,
    ) -> Self {
        Self { store, config }
    }
}

impl UsageDataSource for StoreUsageSource {
    fn profile_name(&self) -> Result<String, String> {
        aiden_data::profile::ProfileService::new(
            aiden_data::profile::ConfigStoreProfileSettings::new(&self.config),
        )
        .get()
        .map_err(|error| error.to_string())
    }

    fn set_profile_name(&self, value: &str) -> Result<String, String> {
        aiden_data::profile::ProfileService::new(
            aiden_data::profile::ConfigStoreProfileSettings::new(&self.config),
        )
        .set_name(value)
        .map_err(|error| error.to_string())
    }

    fn summary(&self, range: UsageDateRange) -> Result<UsageSummary, String> {
        self.store
            .summary(range.into())
            .map(Into::into)
            .map_err(|error| error.to_string())
    }
}

impl From<aiden_data::usage_store::UsageSummary> for UsageSummary {
    fn from(summary: aiden_data::usage_store::UsageSummary) -> Self {
        Self {
            range: UsageDateRange::from_store(&summary.range),
            start_date: summary.start_date,
            end_date: summary.end_date,
            totals: summary.totals.into(),
            days: summary.days.into_iter().map(Into::into).collect(),
            models: summary.models.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<aiden_data::usage_store::UsageTotals> for UsageTotals {
    fn from(totals: aiden_data::usage_store::UsageTotals) -> Self {
        Self {
            requests: totals.requests,
            completed_requests: totals.completed_requests,
            failed_requests: totals.failed_requests,
            cancelled_requests: totals.cancelled_requests,
            reported_token_requests: totals.reported_token_requests,
            unmetered_requests: totals.unmetered_requests,
            local_requests: totals.local_requests,
            costed_requests: totals.costed_requests,
            unpriced_hosted_requests: totals.unpriced_hosted_requests,
            active_days: totals.active_days,
            current_streak: totals.current_streak,
            longest_streak: totals.longest_streak,
            hosted_cost_usd: totals.hosted_cost_usd,
            tokens: totals.tokens.into(),
        }
    }
}

impl From<aiden_data::usage_store::UsageTokenBreakdown> for UsageTokenBreakdown {
    fn from(tokens: aiden_data::usage_store::UsageTokenBreakdown) -> Self {
        Self {
            input: tokens.input,
            output: tokens.output,
            cache_read: tokens.cache_read,
            cache_write: tokens.cache_write,
            reasoning: tokens.reasoning,
            total: tokens.total,
        }
    }
}

impl From<aiden_data::usage_store::UsageDaySummary> for UsageDaySummary {
    fn from(day: aiden_data::usage_store::UsageDaySummary) -> Self {
        Self {
            date: day.date,
            requests: day.requests,
            reported_token_requests: day.reported_token_requests,
            unmetered_requests: day.unmetered_requests,
            tokens: day.tokens.into(),
            hosted_cost_usd: day.hosted_cost_usd,
        }
    }
}

impl From<aiden_data::usage_store::UsageModelSummary> for UsageModelSummary {
    fn from(model: aiden_data::usage_store::UsageModelSummary) -> Self {
        Self {
            provider_id: model.provider_id,
            provider_label: model.provider_label,
            model_id: model.model_id,
            model_label: model.model_label,
            local: model.local,
            requests: model.requests,
            reported_token_requests: model.reported_token_requests,
            unmetered_requests: model.unmetered_requests,
            tokens: model.tokens.into(),
            hosted_cost_usd: model.hosted_cost_usd,
        }
    }
}

/// In-memory source (demo data for standalone use and tests).
#[allow(dead_code)] // standalone/demo scaffolding; the app uses `StoreUsageSource`
#[derive(Debug, Default)]
pub struct MemoryUsageSource {
    pub summary: std::sync::Mutex<UsageSummary>,
    pub profile_name: std::sync::Mutex<String>,
}

impl UsageDataSource for MemoryUsageSource {
    fn profile_name(&self) -> Result<String, String> {
        self.profile_name
            .lock()
            .map(|name| name.clone())
            .map_err(|_| "Profile unavailable".to_string())
    }

    fn set_profile_name(&self, value: &str) -> Result<String, String> {
        let name =
            aiden_data::profile::validate_profile_name(value).map_err(|error| error.to_string())?;
        *self
            .profile_name
            .lock()
            .map_err(|_| "Profile unavailable".to_string())? = name.clone();
        Ok(name)
    }

    fn summary(&self, range: UsageDateRange) -> Result<UsageSummary, String> {
        let guard = self
            .summary
            .lock()
            .map_err(|_| "Usage unavailable".to_string())?;
        let mut summary = guard.clone();
        summary.range = range;
        Ok(summary)
    }
}

#[allow(dead_code)] // standalone/demo scaffolding
fn demo_day(date: &str, requests: u64) -> UsageDaySummary {
    UsageDaySummary {
        date: date.to_string(),
        requests,
        reported_token_requests: requests,
        unmetered_requests: 0,
        tokens: UsageTokenBreakdown {
            input: requests * 3_000,
            output: requests * 800,
            cache_read: requests * 1_200,
            cache_write: requests * 100,
            reasoning: requests * 200,
            total: requests * 5_300,
        },
        hosted_cost_usd: requests as f64 * 0.004,
    }
}

impl MemoryUsageSource {
    /// A ~4-week window ending today.
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn sample() -> Self {
        let end = chrono::Utc::now().date_naive();
        let mut days = Vec::new();
        let mut requests_total = 0u64;
        let mut tokens_total = UsageTokenBreakdown::default();
        let mut active_days = 0u64;
        for offset in (0..28).rev() {
            let date = end - chrono::Duration::days(offset);
            let requests = match offset {
                0 | 7 | 14 | 21 => 0,
                1 | 8 | 15 | 22 => 4,
                2 | 9 | 16 | 23 => 12,
                _ => (offset % 9) as u64 * 3 + 2,
            };
            if requests > 0 {
                active_days += 1;
            }
            let day = demo_day(&date.format("%Y-%m-%d").to_string(), requests);
            requests_total += day.requests;
            tokens_total.input += day.tokens.input;
            tokens_total.output += day.tokens.output;
            tokens_total.cache_read += day.tokens.cache_read;
            tokens_total.cache_write += day.tokens.cache_write;
            tokens_total.reasoning += day.tokens.reasoning;
            tokens_total.total += day.tokens.total;
            days.push(day);
        }
        let start = end - chrono::Duration::days(27);
        Self {
            summary: std::sync::Mutex::new(UsageSummary {
                range: UsageDateRange::Year1,
                start_date: start.format("%Y-%m-%d").to_string(),
                end_date: end.format("%Y-%m-%d").to_string(),
                totals: UsageTotals {
                    requests: requests_total,
                    reported_token_requests: requests_total,
                    completed_requests: requests_total,
                    active_days,
                    current_streak: 3,
                    longest_streak: 9,
                    hosted_cost_usd: requests_total as f64 * 0.004,
                    tokens: tokens_total,
                    ..UsageTotals::default()
                },
                days,
                models: vec![
                    UsageModelSummary {
                        provider_id: "anthropic".into(),
                        provider_label: "Anthropic".into(),
                        model_id: "claude-sonnet-4-5".into(),
                        model_label: "Claude Sonnet 4.5".into(),
                        local: false,
                        requests: requests_total / 2,
                        reported_token_requests: requests_total / 2,
                        unmetered_requests: 0,
                        tokens: tokens_total.scale(2),
                        hosted_cost_usd: requests_total as f64 * 0.002,
                    },
                    UsageModelSummary {
                        provider_id: "ollama".into(),
                        provider_label: "Ollama".into(),
                        model_id: "qwen3:8b".into(),
                        model_label: "Qwen3 8B".into(),
                        local: true,
                        requests: requests_total / 4,
                        reported_token_requests: requests_total / 4,
                        unmetered_requests: 0,
                        tokens: tokens_total.scale(4),
                        hosted_cost_usd: 0.0,
                    },
                ],
            }),
            profile_name: std::sync::Mutex::new("Sambit Biswas".to_string()),
        }
    }
}

impl UsageTokenBreakdown {
    #[allow(dead_code)] // standalone/demo scaffolding
    fn scale(&self, factor: u64) -> UsageTokenBreakdown {
        UsageTokenBreakdown {
            input: self.input / factor,
            output: self.output / factor,
            cache_read: self.cache_read / factor,
            cache_write: self.cache_write / factor,
            reasoning: self.reasoning / factor,
            total: self.total / factor,
        }
    }
}

// ===========================================================================
// The panel entity
// ===========================================================================

pub struct UsagePanel {
    pub(crate) source: Arc<dyn UsageDataSource>,
    pub(crate) summary: Option<UsageSummary>,
    pub(crate) metric: UsageScoreMetric,
    pub(crate) range: UsageDateRange,
    pub(crate) profile_name: Option<String>,
    pub(crate) profile_input: Option<Entity<InputState>>,
    pub(crate) editing_profile: bool,
    pub(crate) loading: bool,
    pub(crate) saving_profile: bool,
    pub(crate) range_menu_open: bool,
    pub(crate) error: Option<String>,
    pub(crate) profile_error: Option<String>,
    pub(crate) share_error: Option<String>,
    pub(crate) share_busy_revision: Option<u64>,
    pub(crate) load_revision: Arc<AtomicU64>,
    pub(crate) profile_revision: Arc<AtomicU64>,
    pub(crate) share_revision: Arc<AtomicU64>,
    pub(crate) share: Arc<aiden_mac::profile_share::ProfileShareAuthority>,
    pub(crate) range_focus: Vec<FocusHandle>,
}

/// Dependencies for [`UsagePanel::new`].
pub struct UsagePanelDeps {
    pub source: Arc<dyn UsageDataSource>,
    pub share: Arc<aiden_mac::profile_share::ProfileShareAuthority>,
}

impl UsagePanelDeps {
    pub fn new(source: Arc<dyn UsageDataSource>) -> Self {
        Self {
            source,
            share: Arc::new(aiden_mac::profile_share::ProfileShareAuthority::new()),
        }
    }

    /// Demo wiring for standalone use and tests.
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn demo() -> Self {
        Self::new(Arc::new(MemoryUsageSource::sample()))
    }
}

impl UsagePanel {
    pub fn new(cx: &mut Context<Self>, deps: UsagePanelDeps) -> Self {
        let mut this = Self {
            source: deps.source,
            summary: None,
            metric: UsageScoreMetric::Requests,
            range: UsageDateRange::Year1,
            profile_name: None,
            profile_input: None,
            editing_profile: false,
            loading: false,
            saving_profile: false,
            range_menu_open: false,
            error: None,
            profile_error: None,
            share_error: None,
            share_busy_revision: None,
            load_revision: Arc::new(AtomicU64::new(0)),
            profile_revision: Arc::new(AtomicU64::new(0)),
            share_revision: Arc::new(AtomicU64::new(0)),
            share: deps.share,
            range_focus: (0..UsageDateRange::ALL.len())
                .map(|_| cx.focus_handle().tab_stop(true))
                .collect(),
        };
        this.refresh(cx);
        this
    }

    /// Load the summary from the source on the background executor.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.invalidate_share_render();
        let revision = self.load_revision.fetch_add(1, Ordering::SeqCst) + 1;
        let current = self.load_revision.clone();
        let range = self.range;
        self.loading = true;
        self.error = None;
        cx.notify();
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let profile = source.profile_name();
                    let summary = source.summary(range);
                    profile.and_then(|profile| summary.map(|summary| (profile, summary)))
                })
                .await;
            this.update(cx, |this, cx| {
                if current.load(Ordering::SeqCst) != revision || this.range != range {
                    return;
                }
                this.loading = false;
                match result {
                    Ok((profile, summary)) => {
                        this.profile_name = Some(profile);
                        this.summary = Some(summary);
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn set_range(&mut self, range: UsageDateRange, cx: &mut Context<Self>) {
        if self.range == range {
            self.range_menu_open = false;
            cx.notify();
            return;
        }
        self.range = range;
        self.range_menu_open = false;
        self.refresh(cx);
    }

    fn begin_profile_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.profile_name.clone().unwrap_or_default();
        let input = self.profile_input.get_or_insert_with(|| {
            cx.new(|cx| InputState::new(window, cx).default_value(value.clone()))
        });
        input.update(cx, |input, cx| {
            input.set_value(value, window, cx);
            input.focus(window, cx);
        });
        self.editing_profile = true;
        self.profile_error = None;
        cx.notify();
    }

    fn cancel_profile_edit(&mut self, cx: &mut Context<Self>) {
        if !profile_edit_can_cancel(self.saving_profile) {
            return;
        }
        self.profile_revision.fetch_add(1, Ordering::SeqCst);
        self.editing_profile = false;
        self.saving_profile = false;
        self.profile_error = None;
        cx.notify();
    }

    fn save_profile_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving_profile {
            return;
        }
        let Some(input) = self.profile_input.as_ref() else {
            return;
        };
        let value = input.read(cx).value().to_string();
        if let Err(error) = aiden_data::profile::validate_profile_name(&value) {
            self.profile_error = Some(error.to_string());
            cx.notify();
            return;
        }
        let revision = self.profile_revision.fetch_add(1, Ordering::SeqCst) + 1;
        let current = self.profile_revision.clone();
        let source = self.source.clone();
        self.saving_profile = true;
        self.profile_error = None;
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_spawn(async move { source.set_profile_name(&value) })
                .await;
            this.update_in(cx, |this, _window, cx| {
                if current.load(Ordering::SeqCst) != revision {
                    return;
                }
                this.saving_profile = false;
                match result {
                    Ok(name) => {
                        this.profile_name = Some(name);
                        this.editing_profile = false;
                    }
                    Err(error) => this.profile_error = Some(error),
                }
                cx.notify();
            })?;
            Ok::<_, anyhow::Error>(())
        })
        .detach();
    }

    fn move_range_focus(
        &mut self,
        index: usize,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let count = UsageDateRange::ALL.len();
        let next = match key {
            "arrowleft" => (index + count - 1) % count,
            "arrowright" => (index + 1) % count,
            "home" => 0,
            "end" => count - 1,
            _ => return,
        };
        self.range_focus[next].focus(window);
        self.set_range(UsageDateRange::ALL[next], cx);
    }

    fn open_share_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.share_busy_revision.is_some() {
            return;
        }
        let (Some(name), Some(summary)) = (self.profile_name.clone(), self.summary.clone()) else {
            return;
        };
        let revision = self.share_revision.fetch_add(1, Ordering::SeqCst) + 1;
        let current = self.share_revision.clone();
        let data = ProfileShareData::from_summary(&name, &summary);
        let render_data = data.clone();
        let dark = matches!(cx.theme().mode, gpui_component::theme::ThemeMode::Dark);
        self.share_busy_revision = Some(revision);
        self.share_error = None;
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    render_profile_share_png_with_timeout(render_data, dark)
                        .map_err(|error| error.to_string())
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if current.load(Ordering::SeqCst) != revision {
                    if settle_owned_revision(&mut this.share_busy_revision, revision) {
                        cx.notify();
                    }
                    return;
                }
                let png = match result {
                    Ok(png) => png,
                    Err(error) => {
                        if settle_owned_revision(&mut this.share_busy_revision, revision) {
                            this.share_error = Some(error);
                            cx.notify();
                        }
                        return;
                    }
                };
                let entity = cx.entity();
                let share = this.share.clone();
                let confirm_entity = entity.clone();
                let cancel_entity = entity.clone();
                let close_entity = entity;
                window.open_dialog(cx, move |dialog, _window, cx| {
                    let share = share.clone();
                    let png = png.clone();
                    let confirm_entity = confirm_entity.clone();
                    let cancel_entity = cancel_entity.clone();
                    let close_entity = close_entity.clone();
                    dialog
                        .title("Share profile")
                        .w(px(430.))
                        .overlay_closable(false)
                        .button_props(
                            DialogButtonProps::default()
                                .ok_text("Share…")
                                .cancel_text("Cancel"),
                        )
                        .confirm()
                        .child(share_preview_card(&data, cx))
                        .on_ok(move |_, _, cx| match share.share_png(&png) {
                            Ok(()) => {
                                confirm_entity.update(cx, |this, cx| {
                                    if settle_owned_revision(
                                        &mut this.share_busy_revision,
                                        revision,
                                    ) {
                                        this.share_error = None;
                                        cx.notify();
                                    }
                                });
                                true
                            }
                            Err(error) => {
                                confirm_entity.update(cx, |this, cx| {
                                    if this.share_busy_revision == Some(revision) {
                                        this.share_error = Some(error.to_string());
                                        cx.notify();
                                    }
                                });
                                false
                            }
                        })
                        .on_cancel(move |_, _, cx| {
                            cancel_entity.update(cx, |this, cx| {
                                this.share_revision.fetch_add(1, Ordering::SeqCst);
                                if settle_owned_revision(&mut this.share_busy_revision, revision) {
                                    cx.notify();
                                }
                            });
                            true
                        })
                        .on_close(move |_, _, cx| {
                            close_entity.update(cx, |this, cx| {
                                this.share_revision.fetch_add(1, Ordering::SeqCst);
                                if settle_owned_revision(&mut this.share_busy_revision, revision) {
                                    cx.notify();
                                }
                            });
                        })
                });
                cx.notify();
            })?;
            Ok::<_, anyhow::Error>(())
        })
        .detach();
    }

    fn invalidate_share_render(&mut self) {
        self.share_revision.fetch_add(1, Ordering::SeqCst);
        self.share_busy_revision = None;
    }

    pub fn set_metric(&mut self, metric: UsageScoreMetric, cx: &mut Context<Self>) {
        self.metric = metric;
        cx.notify();
    }

    fn heatmap_section(&self, summary: &UsageSummary, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let display = bounded_activity_summary(summary);
        let calendar = build_activity_calendar(&display);
        let weeks: Vec<Vec<&ActivityCell>> = calendar
            .cells
            .chunks(7)
            .map(|week| week.iter().collect())
            .collect();

        v_flex()
            .id("usage-heatmap")
            .w_full()
            .gap_2()
            .child(
                h_flex()
                    .w_full()
                    .items_end()
                    .justify_between()
                    .child(
                        v_flex()
                            .gap_0p5()
                            .child(
                                div()
                                    .text_base()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Model activity"),
                            )
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                "Every model call counts, including local and unmetered requests.",
                            )),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!("{} active days", summary.totals.active_days)),
                    ),
            )
            .child(
                div().w_full().overflow_x_scrollbar().child(
                    h_flex()
                        .gap_2()
                        .items_start()
                        .child(
                            // Weekday gutter.
                            v_flex()
                                .h(px(7.0 * 12.0))
                                .justify_between()
                                .py(px(10.))
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("Mon"),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("Wed"),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("Fri"),
                                ),
                        )
                        .child(h_flex().gap_1().children(weeks.into_iter().map(|week| {
                            v_flex().gap_1().children(week.into_iter().map(|cell| {
                                div()
                                    .size(px(9.))
                                    .rounded_sm()
                                    .bg(heat_color(&theme, cell.level))
                            }))
                        }))),
                ),
            )
            .child(
                h_flex()
                    .w_full()
                    .justify_end()
                    .items_center()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Less"),
                    )
                    .children((1..=4).map(|level| {
                        div()
                            .size(px(9.))
                            .rounded_sm()
                            .bg(heat_color(&theme, level))
                    }))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("More"),
                    ),
            )
    }

    fn token_mix_section(
        &self,
        summary: &UsageSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let items = build_token_mix(&summary.totals.tokens);
        let total: u64 = items.iter().map(|item| item.value).sum();

        v_flex()
            .id("usage-token-mix")
            .w_full()
            .gap_2()
            .child(
                div()
                    .text_base()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Token mix"),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("Provider-reported tokens only."),
            )
            .when(total == 0, |el| {
                el.child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("No reported tokens yet"),
                )
            })
            .when(total > 0, |el| {
                el.child(
                    h_flex()
                        .w_full()
                        .h(px(6.))
                        .rounded_full()
                        .overflow_hidden()
                        .children(items.iter().enumerate().map(|(index, item)| {
                            let fraction = item.value as f64 / total as f64;
                            div()
                                .h_full()
                                .w(px((fraction * 400.0) as f32))
                                .bg(mix_color(&theme, index))
                        })),
                )
            })
            .children(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        let percentage = if total > 0 {
                            item.value as f64 / total as f64 * 100.0
                        } else {
                            0.0
                        };
                        h_flex()
                            .w_full()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .size(px(6.))
                                    .rounded_full()
                                    .bg(mix_color(&theme, index)),
                            )
                            .child(div().flex_1().text_sm().child(item.label))
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                format!("{} · {percentage:.1}%", compact_number(item.value)),
                            ))
                            .into_any_element()
                    })
                    .collect::<Vec<_>>(),
            )
            .when(summary.totals.tokens.reasoning > 0, |el| {
                el.child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(format!(
                            "{} reasoning tokens are included in Output.",
                            compact_number(summary.totals.tokens.reasoning)
                        )),
                )
            })
    }

    fn scoreboard_section(
        &self,
        summary: &UsageSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let ranked = rank_usage_models(&summary.models, self.metric);
        let visible = ranked.iter().take(10).collect::<Vec<_>>();
        let maximum = visible
            .iter()
            .map(|model| usage_model_score(model, self.metric))
            .fold(0.0_f64, f64::max);

        v_flex()
            .id("usage-scoreboard")
            .w_full()
            .gap_2()
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .justify_between()
                    .child(
                        v_flex()
                            .gap_0p5()
                            .child(
                                div()
                                    .text_base()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Top models"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("Private rankings from this Mac."),
                            ),
                    )
                    .child(self.metric_selector(cx)),
            )
            .when(visible.is_empty(), |el| {
                el.child(div().text_sm().text_color(theme.muted_foreground).child(
                    if self.metric == UsageScoreMetric::Cost {
                        "No tracked model costs"
                    } else {
                        "No model calls yet"
                    },
                ))
            })
            .children(
                visible
                    .iter()
                    .enumerate()
                    .map(|(index, model)| {
                        let score = usage_model_score(model, self.metric);
                        let width = if maximum > 0.0 {
                            (score / maximum * 100.0) as f32
                        } else {
                            0.0
                        };
                        v_flex()
                            .w_full()
                            .gap_0p5()
                            .child(
                                h_flex()
                                    .w_full()
                                    .gap_2()
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .child((index + 1).to_string()),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(0.))
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .truncate()
                                                    .child(model.model_label.clone()),
                                            )
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(theme.muted_foreground)
                                                    .truncate()
                                                    .child(format!(
                                                        "{} · {}",
                                                        model.provider_label,
                                                        if model.local {
                                                            "Local"
                                                        } else {
                                                            "Hosted"
                                                        }
                                                    )),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .flex_shrink_0()
                                            .text_xs()
                                            .text_color(theme.secondary)
                                            .child(self.model_score_label(model)),
                                    ),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .h(px(4.))
                                    .rounded_full()
                                    .bg(theme.input)
                                    .child(
                                        div()
                                            .h_full()
                                            .rounded_full()
                                            .bg(theme.accent.opacity(0.7))
                                            .w(px(width)),
                                    ),
                            )
                            .into_any_element()
                    })
                    .collect::<Vec<_>>(),
            )
            .when(ranked.len() > visible.len(), |el| {
                el.child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(format!("Showing 10 of {} models", ranked.len())),
                )
            })
    }

    fn metric_selector(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex().id("usage-metric-selector").gap_1().children(
            [
                UsageScoreMetric::Requests,
                UsageScoreMetric::Tokens,
                UsageScoreMetric::Cost,
            ]
            .into_iter()
            .map(|metric| {
                let active = self.metric == metric;
                let mut button = Button::new(match metric {
                    UsageScoreMetric::Requests => "metric-requests",
                    UsageScoreMetric::Tokens => "metric-tokens",
                    UsageScoreMetric::Cost => "metric-cost",
                })
                .small()
                .label(metric.label());
                if active {
                    button = button.primary();
                }
                button.on_click(cx.listener(move |this, _event, _window, cx| {
                    this.set_metric(metric, cx);
                }))
            })
            .map(gpui::IntoElement::into_any_element)
            .collect::<Vec<_>>(),
        )
    }

    fn model_score_label(&self, model: &UsageModelSummary) -> String {
        match self.metric {
            UsageScoreMetric::Requests => {
                format!("{} requests", model.requests)
            }
            UsageScoreMetric::Tokens => {
                if model.tokens.total > 0 {
                    format!("{} tokens", compact_number(model.tokens.total))
                } else if model.unmetered_requests > 0 {
                    "Unmetered".to_string()
                } else {
                    "0 tokens".to_string()
                }
            }
            UsageScoreMetric::Cost => format_tracked_usd(model.hosted_cost_usd),
        }
    }

    fn range_selector(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex().id("usage-range-selector").gap_0p5().children(
            UsageDateRange::ALL
                .into_iter()
                .enumerate()
                .map(|(index, range)| {
                    let selected = self.range == range;
                    let focus = self.range_focus[index].clone();
                    let mut button = Button::new(("usage-range", index))
                        .xsmall()
                        .tab_stop(false)
                        .label(match range {
                            UsageDateRange::Days7 => "7d",
                            UsageDateRange::Days30 => "30d",
                            UsageDateRange::Days90 => "90d",
                            UsageDateRange::Year1 => "1y",
                            UsageDateRange::All => "All",
                        })
                        .tooltip(range.label())
                        .on_click(cx.listener(move |this, _, _, cx| this.set_range(range, cx)));
                    button = if selected {
                        button.primary()
                    } else {
                        button.ghost()
                    };
                    div()
                        .track_focus(&focus)
                        .tab_stop(selected)
                        .on_key_down(cx.listener(
                            move |this, event: &gpui::KeyDownEvent, window, cx| {
                                let key = event.keystroke.key.as_str();
                                if matches!(key, "arrowleft" | "arrowright" | "home" | "end") {
                                    cx.stop_propagation();
                                    this.move_range_focus(index, key, window, cx);
                                } else if matches!(key, "enter" | "space") {
                                    cx.stop_propagation();
                                    this.set_range(range, cx);
                                }
                            },
                        ))
                        .child(button)
                }),
        )
    }

    fn profile_identity(&mut self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let name = self
            .profile_name
            .clone()
            .unwrap_or_else(|| "Loading profile…".to_string());
        let editing = self.editing_profile;
        let saving = self.saving_profile;
        let error = self.profile_error.clone();
        h_flex()
            .id("usage-profile-identity")
            .w_full()
            .min_h(px(96.))
            .items_center()
            .gap_4()
            .child(
                div()
                    .size(px(52.))
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(theme.accent.opacity(0.12))
                    .text_color(theme.accent)
                    .items_center()
                    .justify_center()
                    .text_base()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(profile_initials(&name)),
            )
            .child(
                v_flex()
                    .min_w(px(0.))
                    .flex_1()
                    .gap_1()
                    .child(if editing {
                        h_flex()
                            .w_full()
                            .max_w(px(480.))
                            .gap_1()
                            .on_key_down(cx.listener(
                                |this, event: &gpui::KeyDownEvent, window, cx| {
                                    match event.keystroke.key.as_str() {
                                        "enter" => {
                                            cx.stop_propagation();
                                            this.save_profile_name(window, cx);
                                        }
                                        "escape" => {
                                            cx.stop_propagation();
                                            this.cancel_profile_edit(cx);
                                        }
                                        _ => {}
                                    }
                                },
                            ))
                            .when_some(self.profile_input.clone(), |row, input| {
                                row.child(
                                    div()
                                        .min_w(px(160.))
                                        .flex_1()
                                        .child(Input::new(&input).small().disabled(saving)),
                                )
                            })
                            .child(
                                Button::new("profile-save-name")
                                    .small()
                                    .primary()
                                    .label(if saving { "Saving…" } else { "Save" })
                                    .disabled(saving)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.save_profile_name(window, cx)
                                    })),
                            )
                            .child(
                                Button::new("profile-cancel-name")
                                    .small()
                                    .ghost()
                                    .label("Cancel")
                                    .disabled(saving)
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.cancel_profile_edit(cx)),
                                    ),
                            )
                            .into_any_element()
                    } else {
                        h_flex()
                            .gap_1()
                            .min_w(px(0.))
                            .child(
                                div()
                                    .text_xl()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(name),
                            )
                            .child(
                                Button::new("profile-edit-name")
                                    .xsmall()
                                    .ghost()
                                    .label("Edit")
                                    .tooltip("Edit profile name")
                                    .disabled(self.profile_name.is_none())
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.begin_profile_edit(window, cx)
                                    })),
                            )
                            .into_any_element()
                    })
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Only on this Mac"),
                    )
                    .when_some(error, |column, error| {
                        column.child(div().text_xs().text_color(theme.danger).child(error))
                    }),
            )
            .into_any_element()
    }

    fn summary_metrics(&self, summary: &UsageSummary, cx: &mut Context<Self>) -> impl IntoElement {
        let totals = summary.totals;
        h_flex()
            .id("usage-summary-metrics")
            .w_full()
            .flex_wrap()
            .py_4()
            .children([
                summary_metric(
                    "Reported tokens",
                    compact_number(totals.tokens.total),
                    (totals.unmetered_requests > 0).then(|| {
                        format!(
                            "{} unmetered requests",
                            compact_number(totals.unmetered_requests)
                        )
                    }),
                    cx,
                ),
                summary_metric("Requests", compact_number(totals.requests), None, cx),
                summary_metric(
                    "Current streak",
                    totals.current_streak.to_string(),
                    Some(
                        if totals.current_streak == 1 {
                            "day"
                        } else {
                            "days"
                        }
                        .to_string(),
                    ),
                    cx,
                ),
                summary_metric(
                    "Active days",
                    compact_number(totals.active_days),
                    Some(format!(
                        "Best streak {} {}",
                        totals.longest_streak,
                        if totals.longest_streak == 1 {
                            "day"
                        } else {
                            "days"
                        }
                    )),
                    cx,
                ),
            ])
    }
}

fn profile_edit_can_cancel(saving: bool) -> bool {
    !saving
}

fn settle_owned_revision(active: &mut Option<u64>, revision: u64) -> bool {
    if *active != Some(revision) {
        return false;
    }
    *active = None;
    true
}

fn bounded_activity_summary(summary: &UsageSummary) -> UsageSummary {
    let Ok(end) = chrono::NaiveDate::parse_from_str(&summary.end_date, "%Y-%m-%d") else {
        return summary.clone();
    };
    let latest_start = end - chrono::Duration::days(364);
    let Ok(start) = chrono::NaiveDate::parse_from_str(&summary.start_date, "%Y-%m-%d") else {
        return summary.clone();
    };
    if start >= latest_start {
        return summary.clone();
    }
    let start_key = latest_start.format("%Y-%m-%d").to_string();
    let mut bounded = summary.clone();
    bounded.start_date = start_key.clone();
    bounded.days.retain(|day| day.date >= start_key);
    bounded
}

fn summary_metric(
    label: &'static str,
    value: String,
    detail: Option<String>,
    cx: &mut Context<UsagePanel>,
) -> gpui::AnyElement {
    let theme = cx.theme().clone();
    v_flex()
        .min_w(px(150.))
        .flex_1()
        .px_3()
        .py_1()
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.muted_foreground)
                .child(label.to_uppercase()),
        )
        .child(
            div()
                .text_xl()
                .font_weight(FontWeight::SEMIBOLD)
                .child(value),
        )
        .when_some(detail, |column, detail| {
            column.child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(detail),
            )
        })
        .into_any_element()
}

fn share_preview_card(data: &ProfileShareData, cx: &mut gpui::App) -> gpui::AnyElement {
    let theme = cx.theme().clone();
    v_flex()
        .w_full()
        .gap_3()
        .child(
            v_flex()
                .w_full()
                .rounded_xl()
                .p_4()
                .gap_3()
                .bg(theme.muted)
                .child(
                    h_flex()
                        .justify_between()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.muted_foreground)
                                .child("AIDEN AGENT · MODEL USAGE"),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(data.range_label),
                        ),
                )
                .child(
                    div()
                        .text_xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(data.name.clone()),
                )
                .child(
                    v_flex()
                        .gap_0p5()
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("REPORTED TOKENS"),
                        )
                        .child(
                            div()
                                .text_3xl()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(data.reported_tokens.clone()),
                        ),
                )
                .child(
                    h_flex()
                        .justify_between()
                        .child(format!("{} requests", data.requests))
                        .child(format!("{} active days", data.active_days))
                        .child(format!("{} coverage", data.token_coverage)),
                ),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child("The 3:4 PNG includes your name and aggregate usage only—never prompts, chats, workspaces, file paths, credentials, or account identifiers."),
        )
        .into_any_element()
}

impl Render for UsagePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let compact = window.viewport_size().width.as_f64() < 760.0;
        let identity = self.profile_identity(cx);
        let summary = self.summary.clone();
        let share_busy = self.share_busy_revision.is_some();
        let share_disabled = summary.is_none() || self.profile_name.is_none() || share_busy;

        let body =
            if let Some(summary) = summary {
                let totals = summary.totals;
                let coverage = if totals.requests == 0 {
                    0.0
                } else {
                    totals.reported_token_requests as f64 / totals.requests as f64 * 100.0
                };
                let coverage_copy = if totals.requests == 0 {
                    "Tracking begins with your next model call.".to_string()
                } else {
                    format!("{coverage:.0}% of requests reported token usage.")
                };
                let mut cost_copy = if totals.costed_requests > 0 {
                    format!(
                        "Tracked hosted cost {}",
                        format_tracked_usd(totals.hosted_cost_usd)
                    )
                } else {
                    "No tracked hosted cost".to_string()
                };
                if totals.unpriced_hosted_requests > 0 {
                    cost_copy.push_str(&format!(
                        " · Cost unavailable for {} hosted requests",
                        totals.unpriced_hosted_requests
                    ));
                }
                if totals.local_requests > 0 {
                    cost_copy.push_str(&format!(
                        " · {} local excluded from cost",
                        totals.local_requests
                    ));
                }

                let lower = if compact {
                    v_flex()
                        .w_full()
                        .gap_5()
                        .py_5()
                        .child(self.token_mix_section(&summary, cx))
                        .child(div().h(px(1.)).w_full().bg(theme.border))
                        .child(self.scoreboard_section(&summary, cx))
                        .into_any_element()
                } else {
                    h_flex()
                        .w_full()
                        .items_start()
                        .py_5()
                        .child(
                            div()
                                .w_1_2()
                                .pr_5()
                                .child(self.token_mix_section(&summary, cx)),
                        )
                        .child(
                            div()
                                .w_1_2()
                                .pl_5()
                                .border_l_1()
                                .border_color(theme.border)
                                .child(self.scoreboard_section(&summary, cx)),
                        )
                        .into_any_element()
                };

                v_flex()
                    .w_full()
                    .child(self.heatmap_section(&summary, cx))
                    .child(div().h(px(1.)).w_full().my_5().bg(theme.border))
                    .child(self.summary_metrics(&summary, cx))
                    .child(div().h(px(1.)).w_full().my_5().bg(theme.border))
                    .child(lower)
                    .child(div().h(px(1.)).w_full().my_5().bg(theme.border))
                    .child(
                        h_flex()
                            .w_full()
                            .flex_wrap()
                            .items_start()
                            .justify_between()
                            .gap_3()
                            .pb_5()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(coverage_copy),
                            )
                            .child(
                                div()
                                    .max_w(px(560.))
                                    .text_right()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(cost_copy),
                            ),
                    )
                    .into_any_element()
            } else {
                let error = self.error.clone();
                v_flex()
                    .w_full()
                    .min_h(px(288.))
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .child(div().text_sm().text_color(theme.muted_foreground).child(
                        if self.loading {
                            "Loading usage…".to_string()
                        } else {
                            error.unwrap_or_else(|| "No usage data yet.".to_string())
                        },
                    ))
                    .when(!self.loading, |column| {
                        column.child(
                            Button::new("usage-retry")
                                .small()
                                .primary()
                                .label("Try again")
                                .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                        )
                    })
                    .into_any_element()
            };

        v_flex()
            .id("usage-panel")
            .size_full()
            .bg(theme.background)
            .child(
                h_flex()
                    .id("usage-header")
                    .w_full()
                    .min_h(px(48.))
                    .px_4()
                    .py_2()
                    .gap_2()
                    .items_center()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .text_base()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Profile"),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("usage-share")
                            .small()
                            .ghost()
                            .label(if share_busy { "Preparing…" } else { "Share" })
                            .tooltip("Share profile snapshot")
                            .disabled(share_disabled)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_share_preview(window, cx)
                            })),
                    )
                    .child(self.range_selector(cx))
                    .child(
                        Button::new("usage-refresh")
                            .small()
                            .ghost()
                            .icon(IconName::LoaderCircle)
                            .tooltip("Reload usage")
                            .disabled(self.loading)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                    ),
            )
            .child(
                div()
                    .id("usage-body")
                    .flex_1()
                    .w_full()
                    .overflow_y_scroll()
                    .child(
                        v_flex()
                            .mx_auto()
                            .w_full()
                            .max_w(px(980.))
                            .px_6()
                            .pb_8()
                            .child(identity)
                            .child(div().h(px(1.)).w_full().bg(theme.border))
                            .when_some(self.share_error.clone(), |column, error| {
                                column.child(
                                    div().py_2().text_xs().text_color(theme.danger).child(error),
                                )
                            })
                            .child(body),
                    ),
            )
            .into_any_element()
    }
}

fn heat_color(theme: &gpui_component::Theme, level: u8) -> gpui::Hsla {
    match level {
        0 => theme.transparent,
        1 => theme.accent.opacity(0.2),
        2 => theme.accent.opacity(0.4),
        3 => theme.accent.opacity(0.65),
        _ => theme.accent,
    }
}

fn mix_color(theme: &gpui_component::Theme, index: usize) -> gpui::Hsla {
    match index {
        0 => theme.accent,
        1 => theme.accent.opacity(0.7),
        2 => theme.accent.opacity(0.45),
        _ => theme.accent.opacity(0.25),
    }
}

#[allow(dead_code)] // renderer-contract helper; heatmap cells render from the calendar grid
fn activity_description(cell: &ActivityCell) -> String {
    let date = chrono::NaiveDate::parse_from_str(&cell.date, "%Y-%m-%d")
        .map(|date| date.format("%b %d, %Y").to_string())
        .unwrap_or_else(|_| cell.date.clone());
    if cell.requests == 0 {
        return format!("{date}: no model activity");
    }
    let token_label = if cell.reported_tokens > 0 {
        format!("{} reported tokens", cell.reported_tokens)
    } else {
        "no reported tokens".to_string()
    };
    let unmetered_label = if cell.unmetered_requests > 0 {
        format!(", {} unmetered", cell.unmetered_requests)
    } else {
        String::new()
    };
    format!(
        "{date}: {} requests, {token_label}{unmetered_label}",
        cell.requests
    )
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> UsageTokenBreakdown {
        UsageTokenBreakdown {
            input: 1_000_000,
            output: 300_000,
            cache_read: 500_000,
            cache_write: 50_000,
            reasoning: 20_000,
            total: 1_870_000,
        }
    }

    #[test]
    fn token_mix_buckets_render_in_fixed_order() {
        let items = build_token_mix(&tokens());
        assert_eq!(items[0].label, "Fresh input");
        assert_eq!(items[1].label, "Output");
        assert_eq!(items[2].label, "Cache read");
        assert_eq!(items[3].label, "Cache write");
        assert_eq!(items.iter().map(|item| item.value).sum::<u64>(), 1_850_000);
    }

    #[test]
    fn tracked_usd_formatting_handles_small_values() {
        assert_eq!(format_tracked_usd(0.0), "$0.00");
        assert_eq!(format_tracked_usd(0.000_05), "<$0.0001");
        assert_eq!(format_tracked_usd(0.005), "$0.0050");
        assert_eq!(format_tracked_usd(1.25), "$1.25");
    }

    #[test]
    fn compact_numbers_use_metric_suffixes() {
        assert_eq!(compact_number(950), "950");
        assert_eq!(compact_number(1_500), "1.5K");
        assert_eq!(compact_number(2_300_000), "2.3M");
        assert_eq!(compact_number(12_000_000), "12.0M");
        assert_eq!(compact_number(1_400_000_000), "1.4B");
    }

    #[test]
    fn profile_initials_capitalize_first_and_last() {
        assert_eq!(profile_initials("aiden"), "A");
        assert_eq!(profile_initials("Jane Cooper"), "JC");
        assert_eq!(profile_initials("  spaced   out  "), "SO");
        assert_eq!(profile_initials(""), "A");
    }

    #[test]
    fn every_usage_range_round_trips_and_the_session_default_is_one_year() {
        assert_eq!(UsageDateRange::default(), UsageDateRange::Year1);
        let cases = [
            (UsageDateRange::Days7, "7d", "7 days"),
            (UsageDateRange::Days30, "30d", "30 days"),
            (UsageDateRange::Days90, "90d", "90 days"),
            (UsageDateRange::Year1, "1y", "Past year"),
            (UsageDateRange::All, "all", "All time"),
        ];
        let source = MemoryUsageSource::default();
        for (range, key, label) in cases {
            let store_range: aiden_data::usage_store::UsageDateRange = range.into();
            assert_eq!(store_range.as_str(), key);
            assert_eq!(UsageDateRange::from_store(key), range);
            assert_eq!(range.label(), label);
            assert_eq!(source.summary(range).unwrap().range, range);
        }
    }

    #[test]
    fn profile_editor_cannot_cancel_after_the_durable_write_starts() {
        assert!(profile_edit_can_cancel(false));
        assert!(!profile_edit_can_cancel(true));
    }

    #[test]
    fn stale_share_completion_cannot_settle_a_newer_render() {
        let mut active = Some(42);
        assert!(!settle_owned_revision(&mut active, 41));
        assert_eq!(active, Some(42));
        assert!(settle_owned_revision(&mut active, 42));
        assert_eq!(active, None);
        assert!(!settle_owned_revision(&mut active, 42));
    }

    #[test]
    fn zero_usage_calendar_is_bounded_and_contains_no_active_cells() {
        let summary = UsageSummary {
            range: UsageDateRange::Days7,
            start_date: "2026-08-04".into(),
            end_date: "2026-08-10".into(),
            ..UsageSummary::default()
        };
        let calendar = build_activity_calendar(&summary);
        assert_eq!(calendar.week_count, 2);
        assert!(calendar.cells.iter().all(|cell| cell.level == 0));
        assert!(calendar.cells.iter().all(|cell| cell.requests == 0));
    }

    #[test]
    fn activity_calendar_builds_a_sunday_started_grid() {
        // 2026-07-23 is a Thursday (renderer test reference date).
        let day = demo_day("2026-07-23", 5);
        let summary = UsageSummary {
            range: UsageDateRange::Year1,
            start_date: "2026-07-20".into(),
            end_date: "2026-07-23".into(),
            totals: UsageTotals {
                requests: 5,
                active_days: 1,
                ..UsageTotals::default()
            },
            days: vec![day],
            models: Vec::new(),
        };
        let grid = build_activity_calendar(&summary);
        // 2026-07-20 is Monday; grid starts on the preceding Sunday and
        // spans the full week through the following Saturday.
        assert_eq!(grid.cells.len(), 7); // Sun 07-19 .. Sat 07-25
        assert_eq!(grid.week_count, 1);
        assert!(!grid.cells[0].in_range);
        assert_eq!(grid.cells[1].date, "2026-07-20");
        let active = grid.cells.iter().find(|cell| cell.requests == 5).unwrap();
        assert!(active.level >= 1 && active.level <= 4);
        assert!(!grid.months.is_empty());
    }

    #[test]
    fn activity_level_scales_with_request_density() {
        let busy = demo_day("2026-07-20", 100);
        let sparse = demo_day("2026-07-21", 1);
        assert_eq!(activity_level(Some(&busy), 100), 4);
        assert!(activity_level(Some(&sparse), 100) < 4);
        assert_eq!(activity_level(None, 100), 0);
    }

    #[test]
    fn ranking_sorts_by_score_then_requests_then_name() {
        let models = vec![
            UsageModelSummary {
                provider_id: "a".into(),
                provider_label: "A".into(),
                model_id: "a1".into(),
                model_label: "Alpha".into(),
                local: false,
                requests: 10,
                reported_token_requests: 10,
                unmetered_requests: 0,
                tokens: UsageTokenBreakdown {
                    total: 500,
                    ..UsageTokenBreakdown::default()
                },
                hosted_cost_usd: 0.01,
            },
            UsageModelSummary {
                provider_id: "b".into(),
                provider_label: "B".into(),
                model_id: "b1".into(),
                model_label: "Beta".into(),
                local: false,
                requests: 20,
                reported_token_requests: 20,
                unmetered_requests: 0,
                tokens: UsageTokenBreakdown {
                    total: 500,
                    ..UsageTokenBreakdown::default()
                },
                hosted_cost_usd: 0.02,
            },
            UsageModelSummary {
                provider_id: "c".into(),
                provider_label: "C".into(),
                model_id: "c1".into(),
                model_label: "Gamma".into(),
                local: true,
                requests: 999,
                reported_token_requests: 999,
                unmetered_requests: 0,
                tokens: UsageTokenBreakdown {
                    total: 999,
                    ..UsageTokenBreakdown::default()
                },
                hosted_cost_usd: 0.0,
            },
        ];
        let by_requests = rank_usage_models(&models, UsageScoreMetric::Requests);
        assert_eq!(by_requests[0].model_id, "c1"); // local still ranks by requests
                                                   // Cost ranking excludes the local model and sorts by price.
        let by_cost = rank_usage_models(&models, UsageScoreMetric::Cost);
        assert_eq!(by_cost.len(), 2);
        assert_eq!(by_cost[0].model_id, "b1");
        // Tokens tie-breaks by requests.
        let by_tokens = rank_usage_models(&models, UsageScoreMetric::Tokens);
        assert_eq!(by_tokens[0].model_id, "c1");
    }

    #[test]
    fn usage_model_scores_match_the_metric() {
        let model = UsageModelSummary {
            provider_id: "a".into(),
            provider_label: "A".into(),
            model_id: "a1".into(),
            model_label: "Alpha".into(),
            local: false,
            requests: 10,
            reported_token_requests: 10,
            unmetered_requests: 0,
            tokens: UsageTokenBreakdown {
                total: 500,
                ..UsageTokenBreakdown::default()
            },
            hosted_cost_usd: 0.25,
        };
        assert_eq!(usage_model_score(&model, UsageScoreMetric::Requests), 10.0);
        assert_eq!(usage_model_score(&model, UsageScoreMetric::Tokens), 500.0);
        assert_eq!(usage_model_score(&model, UsageScoreMetric::Cost), 0.25);
    }

    #[test]
    fn store_summary_converts_field_by_field_into_the_panel_shape() {
        let store = aiden_data::usage_store::UsageSummary {
            range: "30d".into(),
            start_date: "2026-06-22".into(),
            end_date: "2026-07-21".into(),
            totals: aiden_data::usage_store::UsageTotals {
                requests: 7,
                completed_requests: 4,
                failed_requests: 2,
                cancelled_requests: 1,
                reported_token_requests: 5,
                unmetered_requests: 2,
                local_requests: 3,
                costed_requests: 2,
                unpriced_hosted_requests: 2,
                active_days: 3,
                current_streak: 2,
                longest_streak: 4,
                hosted_cost_usd: 0.5,
                tokens: aiden_data::usage_store::UsageTokenBreakdown {
                    input: 100,
                    output: 50,
                    cache_read: 10,
                    cache_write: 5,
                    reasoning: 20,
                    total: 185,
                },
            },
            days: vec![aiden_data::usage_store::UsageDaySummary {
                date: "2026-07-21".into(),
                requests: 7,
                reported_token_requests: 7,
                unmetered_requests: 0,
                tokens: aiden_data::usage_store::UsageTokenBreakdown {
                    input: 100,
                    output: 50,
                    cache_read: 10,
                    cache_write: 5,
                    reasoning: 20,
                    total: 185,
                },
                hosted_cost_usd: 0.5,
            }],
            models: vec![aiden_data::usage_store::UsageModelSummary {
                provider_id: "anthropic".into(),
                provider_label: "Anthropic".into(),
                model_id: "claude-sonnet-4-5".into(),
                model_label: "Claude Sonnet 4.5".into(),
                local: false,
                requests: 7,
                reported_token_requests: 7,
                unmetered_requests: 0,
                tokens: aiden_data::usage_store::UsageTokenBreakdown {
                    total: 185,
                    ..aiden_data::usage_store::UsageTokenBreakdown::default()
                },
                hosted_cost_usd: 0.5,
            }],
        };
        let converted: UsageSummary = store.into();
        assert_eq!(converted.start_date, "2026-06-22");
        assert_eq!(converted.totals.requests, 7);
        assert_eq!(converted.totals.completed_requests, 4);
        assert_eq!(converted.totals.failed_requests, 2);
        assert_eq!(converted.totals.cancelled_requests, 1);
        assert_eq!(converted.totals.reported_token_requests, 5);
        assert_eq!(converted.totals.unmetered_requests, 2);
        assert_eq!(converted.totals.local_requests, 3);
        assert_eq!(converted.totals.costed_requests, 2);
        assert_eq!(converted.totals.unpriced_hosted_requests, 2);
        assert_eq!(converted.totals.current_streak, 2);
        assert_eq!(converted.totals.longest_streak, 4);
        assert_eq!(converted.totals.tokens.total, 185);
        assert_eq!(converted.totals.tokens.reasoning, 20);
        assert_eq!(converted.days.len(), 1);
        assert_eq!(converted.days[0].date, "2026-07-21");
        assert_eq!(converted.models[0].model_id, "claude-sonnet-4-5");
        assert_eq!(converted.models[0].hosted_cost_usd, 0.5);
    }
}
