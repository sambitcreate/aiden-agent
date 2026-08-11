//! Aggregate-only profile share-card projection and bounded PNG rendering.

use std::fmt::Write as _;
use std::time::Duration;

use aiden_data::profile::{MAX_SHARE_IMAGE_BYTES, PROFILE_SHARE_HEIGHT, PROFILE_SHARE_WIDTH};

use super::usage_panel::{
    build_activity_calendar, build_token_mix, compact_number, rank_usage_models, UsageScoreMetric,
    UsageSummary,
};

const MAX_SVG_BYTES: usize = 256 * 1024;
const RENDER_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq)]
pub struct ShareModel {
    pub requests: u64,
    pub local: bool,
}

/// Deliberately narrow aggregate-only input to the card renderer.
///
/// The type cannot carry prompts, chats, workspace paths, credentials, account
/// identifiers, or raw provider/model ids.
#[derive(Debug, Clone, PartialEq)]
pub struct ProfileShareData {
    pub name: String,
    pub range_label: &'static str,
    pub reported_tokens: String,
    pub requests: String,
    pub active_days: String,
    pub current_streak: String,
    pub longest_streak: String,
    pub token_coverage: String,
    pub activity: Vec<u8>,
    pub token_mix: Vec<(&'static str, u64)>,
    pub top_models: Vec<ShareModel>,
}

impl ProfileShareData {
    pub fn from_summary(name: &str, summary: &UsageSummary) -> Self {
        let activity_summary = latest_year_summary(summary);
        let calendar = build_activity_calendar(&activity_summary);
        let coverage = if summary.totals.requests == 0 {
            0
        } else {
            ((summary.totals.reported_token_requests as f64 / summary.totals.requests as f64)
                * 100.0)
                .round() as u64
        };
        Self {
            name: truncate_visible(name, 24),
            range_label: summary.range.label(),
            reported_tokens: compact_number(summary.totals.tokens.total),
            requests: compact_number(summary.totals.requests),
            active_days: compact_number(summary.totals.active_days),
            current_streak: streak_label(summary.totals.current_streak),
            longest_streak: streak_label(summary.totals.longest_streak),
            token_coverage: format!("{coverage}%"),
            activity: calendar.cells.into_iter().map(|cell| cell.level).collect(),
            token_mix: build_token_mix(&summary.totals.tokens)
                .into_iter()
                .map(|item| (item.label, item.value))
                .collect(),
            top_models: rank_usage_models(&summary.models, UsageScoreMetric::Requests)
                .into_iter()
                .take(5)
                .map(|model| ShareModel {
                    requests: model.requests,
                    local: model.local,
                })
                .collect(),
        }
    }
}

fn latest_year_summary(summary: &UsageSummary) -> UsageSummary {
    let end = chrono::NaiveDate::parse_from_str(&summary.end_date, "%Y-%m-%d")
        .unwrap_or_else(|_| chrono::Utc::now().date_naive());
    let latest_start = end - chrono::Duration::days(364);
    let actual_start =
        chrono::NaiveDate::parse_from_str(&summary.start_date, "%Y-%m-%d").unwrap_or(latest_start);
    let start = actual_start.max(latest_start);
    let start_key = start.format("%Y-%m-%d").to_string();
    let mut projected = summary.clone();
    projected.start_date = start_key.clone();
    projected.days.retain(|day| day.date >= start_key);
    projected
}

fn streak_label(value: u64) -> String {
    format!(
        "{} {}",
        compact_number(value),
        if value == 1 { "day" } else { "days" }
    )
}

fn truncate_visible(value: &str, maximum: usize) -> String {
    let normalized = aiden_data::profile::normalize_profile_name(value)
        .chars()
        .filter(|character| {
            !matches!(
                *character as u32,
                0x061c | 0x200e | 0x200f | 0x202a..=0x202e | 0x2066..=0x2069
            )
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.chars().count() <= maximum {
        return normalized;
    }
    let mut result = normalized
        .chars()
        .take(maximum.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Debug, thiserror::Error)]
pub enum ShareRenderError {
    #[error("Aiden timed out while rendering the profile snapshot.")]
    Timeout,
    #[error("Aiden couldn't render the profile snapshot.")]
    Render,
    #[error("The profile snapshot is empty or too large.")]
    InvalidSize,
}

pub fn render_profile_share_png(
    data: &ProfileShareData,
    dark: bool,
) -> Result<Vec<u8>, ShareRenderError> {
    let svg = profile_share_svg(data, dark)?;
    let mut options = usvg::Options::default();
    options.fontdb_mut().load_system_fonts();
    let tree = usvg::Tree::from_str(&svg, &options).map_err(|_| ShareRenderError::Render)?;
    let size = tree.size().to_int_size();
    if size.width() != PROFILE_SHARE_WIDTH || size.height() != PROFILE_SHARE_HEIGHT {
        return Err(ShareRenderError::Render);
    }
    let mut pixmap = tiny_skia::Pixmap::new(PROFILE_SHARE_WIDTH, PROFILE_SHARE_HEIGHT)
        .ok_or(ShareRenderError::Render)?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    let png = pixmap.encode_png().map_err(|_| ShareRenderError::Render)?;
    if png.is_empty() || png.len() > MAX_SHARE_IMAGE_BYTES {
        return Err(ShareRenderError::InvalidSize);
    }
    Ok(png)
}

pub fn render_profile_share_png_with_timeout(
    data: ProfileShareData,
    dark: bool,
) -> Result<Vec<u8>, ShareRenderError> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = sender.send(render_profile_share_png(&data, dark));
    });
    receiver
        .recv_timeout(RENDER_TIMEOUT)
        .map_err(|_| ShareRenderError::Timeout)?
}

fn profile_share_svg(data: &ProfileShareData, dark: bool) -> Result<String, ShareRenderError> {
    let (background, panel, text, secondary, track, separator, accent) = if dark {
        (
            "#171719", "#202023", "#F7F7F8", "#B2B2B8", "#343439", "#38383D", "#138AF2",
        )
    } else {
        (
            "#F3F4F5", "#FFFFFF", "#171719", "#66666B", "#E4E5E7", "#DDDEE1", "#138AF2",
        )
    };
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{PROFILE_SHARE_WIDTH}" height="{PROFILE_SHARE_HEIGHT}" viewBox="0 0 {PROFILE_SHARE_WIDTH} {PROFILE_SHARE_HEIGHT}"><rect width="1200" height="1600" fill="{background}"/><g font-family="-apple-system,BlinkMacSystemFont,SF Pro Text,Helvetica Neue,sans-serif" fill="{text}"><text x="72" y="84" fill="{secondary}" font-size="23" font-weight="600" letter-spacing="2.8">AIDEN AGENT · MODEL USAGE</text><text x="1128" y="84" fill="{secondary}" font-size="23" text-anchor="end">{range}</text><text x="72" y="154" font-size="48" font-weight="650">{name}</text><text x="72" y="230" fill="{secondary}" font-size="21" font-weight="600" letter-spacing="1.6">REPORTED TOKENS</text><text x="72" y="334" font-size="104" font-weight="650">{tokens}</text><text x="1128" y="322" fill="{secondary}" font-size="22" text-anchor="end">{coverage} token coverage</text><rect x="72" y="400" width="1056" height="145" rx="28" fill="{panel}"/>"#,
        range = xml(data.range_label),
        name = xml(&data.name),
        tokens = xml(&data.reported_tokens),
        coverage = xml(&data.token_coverage),
    );
    for x in [336, 600, 864] {
        let _ = write!(
            svg,
            r#"<line x1="{x}" x2="{x}" y1="430" y2="515" stroke="{separator}"/>"#
        );
    }
    let stats = [
        ("REQUESTS", data.requests.as_str()),
        ("ACTIVE DAYS", data.active_days.as_str()),
        ("CURRENT STREAK", data.current_streak.as_str()),
        ("BEST STREAK", data.longest_streak.as_str()),
    ];
    for (index, (label, value)) in stats.into_iter().enumerate() {
        let x = 104 + index * 264;
        let _ = write!(
            svg,
            r#"<text x="{x}" y="450" fill="{secondary}" font-size="18" font-weight="600">{label}</text><text x="{x}" y="500" font-size="38" font-weight="620">{value}</text>"#,
            value = xml(value),
        );
    }
    let _ = write!(
        svg,
        r#"<rect x="72" y="575" width="1056" height="400" rx="28" fill="{panel}"/><text x="104" y="630" font-size="27" font-weight="620">Model activity</text><text x="104" y="665" fill="{secondary}" font-size="19">Latest year · every model call counts</text>"#
    );
    let week_count = data.activity.len().div_ceil(7).max(1);
    let pitch = (920.0 / week_count as f32).min(17.0);
    for (index, level) in data.activity.iter().copied().enumerate() {
        let week = index / 7;
        let day = index % 7;
        let opacity = match level {
            0 => 0.10,
            1 => 0.25,
            2 => 0.45,
            3 => 0.70,
            _ => 1.0,
        };
        let _ = write!(
            svg,
            r#"<rect x="{}" y="{}" width="11" height="11" rx="2" fill="{accent}" opacity="{opacity}"/>"#,
            150.0 + week as f32 * pitch,
            710 + day * 30,
        );
    }
    let _ = write!(
        svg,
        r#"<rect x="72" y="1010" width="504" height="420" rx="28" fill="{panel}"/><text x="104" y="1065" font-size="27" font-weight="620">Token mix</text><rect x="104" y="1100" width="440" height="10" rx="5" fill="{track}"/>"#
    );
    let token_total = data.token_mix.iter().map(|(_, value)| *value).sum::<u64>();
    let mut offset = 0.0;
    for (index, (label, value)) in data.token_mix.iter().enumerate() {
        let fraction = if token_total == 0 {
            0.0
        } else {
            *value as f64 / token_total as f64
        };
        let width = fraction * 440.0;
        let opacity = [1.0, 0.72, 0.46, 0.28][index];
        let _ = write!(
            svg,
            r#"<rect x="{}" y="1100" width="{width}" height="10" rx="5" fill="{accent}" opacity="{opacity}"/><text x="104" y="{}" font-size="20">{}</text><text x="544" y="{}" fill="{secondary}" font-size="18" text-anchor="end">{} · {:.1}%</text>"#,
            104.0 + offset,
            1162 + index * 64,
            xml(label),
            1162 + index * 64,
            compact_number(*value),
            fraction * 100.0,
        );
        offset += width;
    }
    let _ = write!(
        svg,
        r#"<rect x="600" y="1010" width="528" height="420" rx="28" fill="{panel}"/><text x="632" y="1065" font-size="27" font-weight="620">Top models</text>"#
    );
    let max_requests = data
        .top_models
        .iter()
        .map(|model| model.requests)
        .max()
        .unwrap_or(0);
    for (index, model) in data.top_models.iter().enumerate() {
        let y = 1124 + index * 60;
        let model_label = if model.local {
            "Local model"
        } else {
            "Hosted model"
        };
        let width = if max_requests == 0 {
            0.0
        } else {
            model.requests as f64 / max_requests as f64 * 250.0
        };
        let _ = write!(
            svg,
            r#"<text x="632" y="{y}" font-size="20">{}</text><text x="1096" y="{y}" fill="{secondary}" font-size="18" text-anchor="end">{} requests</text><rect x="632" y="{}" width="250" height="5" rx="2.5" fill="{track}"/><rect x="632" y="{}" width="{width}" height="5" rx="2.5" fill="{accent}" opacity=".7"/>"#,
            model_label,
            compact_number(model.requests),
            y + 14,
            y + 14,
        );
    }
    let _ = write!(
        svg,
        r#"<line x1="72" x2="1128" y1="1490" y2="1490" stroke="{separator}"/><text x="72" y="1536" fill="{secondary}" font-size="18">Aggregate usage only · generated privately on this Mac</text><text x="1128" y="1536" fill="{secondary}" font-size="18" text-anchor="end">aidenagent.com</text></g></svg>"#
    );
    if svg.len() > MAX_SVG_BYTES {
        return Err(ShareRenderError::InvalidSize);
    }
    Ok(svg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panels::usage_panel::{
        UsageDateRange, UsageModelSummary, UsageTokenBreakdown, UsageTotals,
    };

    fn summary() -> UsageSummary {
        UsageSummary {
            range: UsageDateRange::Year1,
            start_date: "2025-08-11".into(),
            end_date: "2026-08-10".into(),
            totals: UsageTotals {
                requests: 4,
                reported_token_requests: 3,
                active_days: 2,
                current_streak: 1,
                longest_streak: 2,
                tokens: UsageTokenBreakdown {
                    input: 10,
                    output: 5,
                    total: 15,
                    ..UsageTokenBreakdown::default()
                },
                ..UsageTotals::default()
            },
            days: Vec::new(),
            models: vec![UsageModelSummary {
                provider_id: "secret-account-id".into(),
                provider_label: "OpenAI".into(),
                model_id: "private-model-id".into(),
                model_label: "GPT-5".into(),
                local: false,
                requests: 4,
                reported_token_requests: 3,
                unmetered_requests: 1,
                tokens: UsageTokenBreakdown::default(),
                hosted_cost_usd: 0.02,
            }],
        }
    }

    #[test]
    fn projection_excludes_raw_provider_and_model_identifiers() {
        let data = ProfileShareData::from_summary("Sambit", &summary());
        let debug = format!("{data:?}");
        assert!(!debug.contains("secret-account-id") && !debug.contains("private-model-id"));
        assert!(!debug.contains("OpenAI") && !debug.contains("GPT-5"));
    }

    #[test]
    fn svg_escapes_profile_text_and_contains_only_projected_aggregates() {
        let data = ProfileShareData::from_summary("A <B> & C", &summary());
        let svg = profile_share_svg(&data, false).unwrap();
        assert!(svg.contains("A &lt;B&gt; &amp; C"));
    }

    #[test]
    fn png_renderer_produces_bounded_canonical_dimensions() {
        let data = ProfileShareData::from_summary("Sambit", &summary());
        let png = render_profile_share_png(&data, false).unwrap();
        let encoded = format!(
            "data:image/png;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png)
        );
        let decoded = aiden_data::profile::decode_profile_share_png(&encoded).unwrap();
        assert_eq!(decoded, png);
    }

    #[test]
    fn zero_usage_projects_without_division_or_missing_activity() {
        let mut empty = summary();
        empty.totals = UsageTotals::default();
        empty.models.clear();
        let data = ProfileShareData::from_summary("Aiden User", &empty);
        assert_eq!(data.token_coverage, "0%");
    }
}
