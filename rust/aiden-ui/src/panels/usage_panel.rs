//! Profile/usage view (port of `renderer/components/usage/*` — activity
//! heatmap, token mix, model scoreboard — and `renderer/lib/usage-profile-data.ts`).
//!
//! The panel renders from an injected [`UsageDataSource`] (Arc'd; an
//! in-memory impl with demo data is provided). All aggregation/formatting
//! helpers are pure and unit-tested against the renderer contract.

use std::sync::Arc;

use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, IconName, Sizable as _,
};

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
    pub active_days: u64,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub hosted_cost_usd: f64,
    pub tokens: UsageTokenBreakdown,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageSummary {
    pub start_date: String,
    pub end_date: String,
    pub totals: UsageTotals,
    pub days: Vec<UsageDaySummary>,
    pub models: Vec<UsageModelSummary>,
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

/// Read-only source of the usage summary for this Mac.
pub trait UsageDataSource: Send + Sync {
    fn summary(&self) -> UsageSummary;
}

/// Store-backed adapter over `aiden_data::usage_store::UsageStore`. The
/// store's summary types mirror the panel's (both port the same renderer
/// contract), so the mapping is a mechanical field copy (see the `From`
/// impls below).
pub struct StoreUsageSource {
    store: Arc<aiden_data::usage_store::UsageStore>,
}

impl StoreUsageSource {
    pub fn new(store: Arc<aiden_data::usage_store::UsageStore>) -> Self {
        Self { store }
    }
}

impl UsageDataSource for StoreUsageSource {
    fn summary(&self) -> UsageSummary {
        self.store
            .summary(aiden_data::usage_store::UsageDateRange::Days30)
            .map(Into::into)
            .unwrap_or_default()
    }
}

impl From<aiden_data::usage_store::UsageSummary> for UsageSummary {
    fn from(summary: aiden_data::usage_store::UsageSummary) -> Self {
        Self {
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
}

impl UsageDataSource for MemoryUsageSource {
    fn summary(&self) -> UsageSummary {
        let guard = self.summary.lock();
        guard.map(|summary| summary.clone()).unwrap_or_default()
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
                start_date: start.format("%Y-%m-%d").to_string(),
                end_date: end.format("%Y-%m-%d").to_string(),
                totals: UsageTotals {
                    requests: requests_total,
                    active_days,
                    current_streak: 3,
                    longest_streak: 9,
                    hosted_cost_usd: requests_total as f64 * 0.004,
                    tokens: tokens_total,
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
    pub(crate) loaded: bool,
}

/// Dependencies for [`UsagePanel::new`].
pub struct UsagePanelDeps {
    pub source: Arc<dyn UsageDataSource>,
}

impl UsagePanelDeps {
    pub fn new(source: Arc<dyn UsageDataSource>) -> Self {
        Self { source }
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
            loaded: false,
        };
        this.refresh(cx);
        this
    }

    /// Load the summary from the source on the background executor.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let summary = cx.background_spawn(async move { source.summary() }).await;
            this.update(cx, |this, cx| {
                this.summary = Some(summary);
                this.loaded = true;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn set_metric(&mut self, metric: UsageScoreMetric, cx: &mut Context<Self>) {
        self.metric = metric;
        cx.notify();
    }

    fn heatmap_section(&self, summary: &UsageSummary, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let calendar = build_activity_calendar(summary);
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
}

impl Render for UsagePanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let Some(summary) = self.summary.as_ref() else {
            return v_flex()
                .id("usage-panel")
                .size_full()
                .bg(theme.background)
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(if self.loaded {
                            "No usage data yet."
                        } else {
                            "Loading usage…"
                        }),
                )
                .into_any_element();
        };

        let totals = summary.totals;
        v_flex()
            .id("usage-panel")
            .size_full()
            .bg(theme.background)
            .child(
                h_flex()
                    .id("usage-header")
                    .w_full()
                    .px_3()
                    .py_2()
                    .gap_4()
                    .items_center()
                    .child(
                        div()
                            .size(px(32.))
                            .rounded_md()
                            .bg(theme.accent)
                            .text_color(theme.accent_foreground)
                            .items_center()
                            .justify_center()
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("A")),
                    )
                    .child(
                        v_flex()
                            .gap_0p5()
                            .child(
                                div()
                                    .text_base()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Usage & profile"),
                            )
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                format!(
                                    "{} requests · {} active days · {}",
                                    totals.requests,
                                    totals.active_days,
                                    format_tracked_usd(totals.hosted_cost_usd)
                                ),
                            )),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("usage-refresh")
                            .small()
                            .ghost()
                            .icon(IconName::LoaderCircle)
                            .tooltip("Reload usage")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.refresh(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .id("usage-body")
                    .flex_1()
                    .w_full()
                    .overflow_y_scroll()
                    .px_4()
                    .py_2()
                    .child(
                        v_flex()
                            .w_full()
                            .gap_4()
                            .child(self.heatmap_section(summary, cx))
                            .child(self.token_mix_section(summary, cx))
                            .child(self.scoreboard_section(summary, cx)),
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
    fn activity_calendar_builds_a_sunday_started_grid() {
        // 2026-07-23 is a Thursday (renderer test reference date).
        let day = demo_day("2026-07-23", 5);
        let summary = UsageSummary {
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
                ..aiden_data::usage_store::UsageTotals::default()
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
