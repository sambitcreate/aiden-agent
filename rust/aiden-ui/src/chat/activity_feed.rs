//! Generation activity feed — the thinking/tool trail of one assistant turn
//! (port of `renderer/components/activity-feed.tsx` + `renderer/lib/agent-steps.ts`).
//!
//! The pure step-line logic (`activity_line`, `summarize_activity`, ...) is
//! unit-tested; [`timeline_feed`] renders a persisted or live
//! `aiden_core::GenerationTimeline` above the message bubble.

use aiden_core::{
    AgentStep, AgentStepStatus, GenerationClaimCheck, GenerationTimeline, GenerationTimelineStatus,
};
use gpui::{
    div, prelude::FluentBuilder as _, px, Animation, AnimationExt as _, App, ElementId,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _,
};

use std::time::Duration;

const TICKER_ROWS: usize = 3;
const TICKER_ROW_HEIGHT_PX: f32 = 24.0;

/// Render-owned disclosure state for one generation timeline. The state is
/// keyed by `generation_id`, so a new turn starts collapsed while a user's
/// explicit open/close choice survives ordinary streaming re-renders.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ActivityFeedState {
    generation_id: String,
    open: bool,
    auto_open_key: Option<String>,
}

impl ActivityFeedState {
    fn reconcile(&mut self, timeline: &GenerationTimeline) {
        if self.generation_id != timeline.generation_id {
            self.generation_id = timeline.generation_id.clone();
            self.open = false;
            self.auto_open_key = None;
        }

        let attention_key = if has_unverified_success_claim(timeline) {
            Some(format!("{}:claim", timeline.generation_id))
        } else if activity_issue_count(timeline) > 0 {
            Some(format!("{}:issue", timeline.generation_id))
        } else {
            None
        };
        if let Some(key) = attention_key {
            if self.auto_open_key.as_deref() != Some(key.as_str()) {
                self.auto_open_key = Some(key);
                self.open = true;
            }
        }
    }
}

/// The feed-line tone, mapped to a theme color at render time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepTone {
    Normal,
    Warning,
    Error,
}

/// One feed row, split so the verb stays legible while the object it acted on
/// recedes (mirrors `ActivityLine` in `agent-steps.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityLine {
    pub verb: String,
    pub object: Option<String>,
    pub tone: StepTone,
}

/// `isToolStep`.
pub fn is_tool_step(step: &AgentStep) -> bool {
    matches!(step, AgentStep::Tool(_))
}

/// `isActiveStep`.
pub fn is_active_step(step: &AgentStep) -> bool {
    match step {
        AgentStep::Tool(tool) => matches!(
            tool.status,
            AgentStepStatus::Pending | AgentStepStatus::AwaitingApproval | AgentStepStatus::Running
        ),
        AgentStep::Thinking(thinking) => thinking.finished_at.is_none(),
    }
}

/// The live ticker only shimmers a tool that is actively running. Pending and
/// approval-gated rows remain readable without implying that work is executing,
/// matching Electron's `TickerRow` predicate.
fn is_ticker_active_step(step: &AgentStep) -> bool {
    match step {
        AgentStep::Tool(tool) => tool.status == AgentStepStatus::Running,
        AgentStep::Thinking(thinking) => thinking.finished_at.is_none(),
    }
}

/// `formatThinkingDuration`.
pub fn format_thinking_duration(duration_ms: Option<u64>) -> String {
    match duration_ms {
        Some(duration) if duration >= 2_000 => {
            let seconds = (duration as f64 / 1_000.0).round() as u64;
            if seconds < 60 {
                format!("for {seconds}s")
            } else {
                let minutes = seconds / 60;
                let remainder = seconds % 60;
                if remainder > 0 {
                    format!("for {minutes}m {remainder}s")
                } else {
                    format!("for {minutes}m")
                }
            }
        }
        _ => "briefly".to_string(),
    }
}

/// The object a tool acted on: a pattern, a query, or a workspace-relative
/// path (mirrors `stepObject`).
fn step_object(step: &aiden_core::AgentToolStep) -> Option<String> {
    if step.tool_name == "grep" {
        if let (Some(detail), Some(target)) = (&step.detail, &step.target) {
            return Some(format!("{detail} in {target}"));
        }
    }
    step.detail.clone().or_else(|| step.target.clone())
}

fn verb_pair(tool_name: &str) -> Option<(&'static str, &'static str)> {
    Some(match tool_name {
        "read_file" => ("Reading", "Read"),
        "list_dir" => ("Listing", "Listed"),
        "glob" => ("Searching files", "Searched files"),
        "grep" => ("Grepping", "Grepped"),
        "write_file" => ("Writing", "Wrote"),
        "edit_file" => ("Editing", "Edited"),
        "run_command" => ("Running", "Ran"),
        "web_search" => ("Searching the web", "Searched the web"),
        "schedule_task" => ("Scheduling", "Scheduled"),
        "edit_automation" => ("Editing automation", "Edited automation"),
        "computer_use" => ("Using Mac", "Used Mac"),
        _ => return None,
    })
}

/// `activityLine`.
pub fn activity_line(step: &AgentStep) -> ActivityLine {
    match step {
        AgentStep::Thinking(_) => {
            if is_active_step(step) {
                ActivityLine {
                    verb: "Thinking".to_string(),
                    object: None,
                    tone: StepTone::Normal,
                }
            } else {
                let duration = match step {
                    AgentStep::Thinking(thinking) => thinking.duration_ms,
                    AgentStep::Tool(_) => None,
                };
                ActivityLine {
                    verb: "Thought".to_string(),
                    object: Some(format_thinking_duration(duration)),
                    tone: StepTone::Normal,
                }
            }
        }
        AgentStep::Tool(tool) => {
            let object = step_object(tool);
            let (active, complete) = verb_pair(&tool.tool_name)
                .map(|(active, complete)| (active.to_string(), complete.to_string()))
                .unwrap_or_else(|| (tool.label.clone(), tool.label.clone()));
            let (verb, tone) = match tool.status {
                AgentStepStatus::Pending | AgentStepStatus::Running => (active, StepTone::Normal),
                AgentStepStatus::Completed => (complete, StepTone::Normal),
                AgentStepStatus::AwaitingApproval => {
                    (format!("{} needs approval", tool.label), StepTone::Warning)
                }
                AgentStepStatus::Failed => (format!("{} failed", tool.label), StepTone::Error),
                AgentStepStatus::Blocked => (format!("{} denied", tool.label), StepTone::Warning),
                AgentStepStatus::Cancelled => {
                    (format!("{} cancelled", tool.label), StepTone::Warning)
                }
            };
            ActivityLine { verb, object, tone }
        }
    }
}

/// `activityLineText` — the flattened row text for accessible names.
#[allow(dead_code)] // renderer-contract helper; the feed rows render verb/object directly
pub fn activity_line_text(step: &AgentStep) -> String {
    let line = activity_line(step);
    match line.object {
        Some(object) => format!("{} {object}", line.verb),
        None => line.verb,
    }
}

/// `activityIssueCount`.
pub fn activity_issue_count(timeline: &GenerationTimeline) -> usize {
    timeline
        .steps
        .iter()
        .filter(|step| {
            matches!(
                step,
                AgentStep::Tool(tool)
                    if matches!(
                        tool.status,
                        AgentStepStatus::Failed
                            | AgentStepStatus::Blocked
                            | AgentStepStatus::Cancelled
                    )
            )
        })
        .count()
}

/// Whether the terminal prose contains a consequential success claim that the
/// recorded tool evidence could not verify. This is kept separate from the
/// issue count so a warning remains visible even when every tool step has a
/// normal terminal status.
pub fn has_unverified_success_claim(timeline: &GenerationTimeline) -> bool {
    matches!(
        timeline.claim_check,
        Some(GenerationClaimCheck::UnverifiedSuccess { .. })
    )
}

fn plural(count: usize, singular: &str, plural_form: &str) -> String {
    format!(
        "{count} {}",
        if count == 1 { singular } else { plural_form }
    )
}

fn count_tools(steps: &[AgentStep], names: &[&str]) -> usize {
    steps
        .iter()
        .filter(|step| {
            matches!(step, AgentStep::Tool(tool) if names.contains(&tool.tool_name.as_str()))
        })
        .count()
}

const TALLIED_TOOLS: &[&str] = &[
    "read_file",
    "grep",
    "glob",
    "list_dir",
    "run_command",
    "write_file",
    "edit_file",
    "web_search",
    "computer_use",
];

/// `summarizeActivity` — a deterministic one-sentence account of the turn.
pub fn summarize_activity(timeline: &GenerationTimeline) -> String {
    let running = timeline.status == GenerationTimelineStatus::Running;
    let tool_steps: Vec<&AgentStep> = timeline
        .steps
        .iter()
        .filter(|step| is_tool_step(step))
        .collect();
    if tool_steps.is_empty() {
        let thinking: u64 = timeline
            .steps
            .iter()
            .filter_map(|step| match step {
                AgentStep::Tool(_) => None,
                AgentStep::Thinking(thinking) => thinking.duration_ms,
            })
            .sum();
        if timeline.steps.is_empty() {
            return if running {
                "Working".to_string()
            } else {
                "No activity".to_string()
            };
        }
        return if running {
            "Thinking".to_string()
        } else {
            format!("Thought {}", format_thinking_duration(Some(thinking)))
        };
    }
    let files = count_tools(&timeline.steps, &["read_file"]);
    let searches = count_tools(&timeline.steps, &["grep", "glob"]);
    let directories = count_tools(&timeline.steps, &["list_dir"]);
    let commands = count_tools(&timeline.steps, &["run_command"]);
    let changes = count_tools(&timeline.steps, &["write_file", "edit_file"]);
    let web = count_tools(&timeline.steps, &["web_search"]);
    let mac = count_tools(&timeline.steps, &["computer_use"]);
    let other = tool_steps
        .iter()
        .filter(|step| {
            matches!(step, AgentStep::Tool(tool) if !TALLIED_TOOLS.contains(&tool.tool_name.as_str()))
        })
        .count();

    let explored: Vec<String> = [
        (files > 0).then(|| plural(files, "file", "files")),
        (searches > 0).then(|| plural(searches, "search", "searches")),
        (directories > 0).then(|| plural(directories, "directory", "directories")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let clauses: Vec<String> = [
        (changes > 0).then(|| {
            format!(
                "{} {}",
                if running { "editing" } else { "edited" },
                plural(changes, "file", "files")
            )
        }),
        (commands > 0).then(|| {
            format!(
                "{} {}",
                if running { "running" } else { "ran" },
                plural(commands, "command", "commands")
            )
        }),
        (web > 0).then(|| plural(web, "web search", "web searches")),
        (mac > 0).then(|| plural(mac, "Mac action", "Mac actions")),
        (other > 0).then(|| plural(other, "tool call", "tool calls")),
    ]
    .into_iter()
    .flatten()
    .collect();

    if !explored.is_empty() {
        let lead = format!(
            "{} {}",
            if running { "Exploring" } else { "Explored" },
            explored.join(", ")
        );
        return [lead, clauses.join(", ")]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
    }
    let joined = clauses.join(", ");
    if joined.is_empty() {
        return "No activity".to_string();
    }
    let mut chars = joined.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => joined,
    }
}

// ===========================================================================
// View
// ===========================================================================

/// Render a timeline as a compact activity feed. Live turns start as a
/// bounded three-row ticker; settled turns start as one deterministic summary.
/// The summary is a real focusable button, so Enter/Space and pointer clicks
/// share the same disclosure state. Issues and claim-check warnings auto-open
/// once per generation, matching the Electron attention contract.
pub fn timeline_feed(
    timeline: &GenerationTimeline,
    live: bool,
    window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    if timeline.steps.is_empty() {
        return div().into_any_element();
    }
    let theme = cx.theme().clone();
    let running = timeline.status == GenerationTimelineStatus::Running;
    let summary = summarize_activity(timeline);
    let issues = activity_issue_count(timeline);
    let motion_reduced = cx
        .try_global::<crate::services::appearance::AidenAppearanceRuntime>()
        .is_some_and(|appearance| appearance.motion_reduced);
    let state = window.use_keyed_state(
        ElementId::Name(SharedString::from(format!(
            "activity-feed-state-{}",
            timeline.generation_id
        ))),
        cx,
        |_, _| ActivityFeedState::default(),
    );
    if state.read(cx).generation_id != timeline.generation_id
        || (has_unverified_success_claim(timeline)
            && state.read(cx).auto_open_key.as_deref()
                != Some(format!("{}:claim", timeline.generation_id).as_str()))
        || (!has_unverified_success_claim(timeline)
            && issues > 0
            && state.read(cx).auto_open_key.as_deref()
                != Some(format!("{}:issue", timeline.generation_id).as_str()))
    {
        state.update(cx, |state, _| state.reconcile(timeline));
    }
    let open = state.read(cx).open;
    let show_ticker = live && running && !open;
    let ticker_count = timeline.steps.len().min(TICKER_ROWS);
    let ticker_start = ticker_start_index(timeline.steps.len());
    let ticker_steps = timeline.steps.iter().skip(ticker_start);
    let summary_state = state.clone();
    let summary_id = ElementId::Name(SharedString::from(format!(
        "activity-summary-{}",
        timeline.generation_id
    )));
    let summary_content = h_flex()
        .id("activity-summary-content")
        .w_full()
        .min_w(px(0.))
        .gap_1p5()
        .items_center()
        .px_1p5()
        .py_1()
        .rounded_md()
        .when(show_ticker, |el| {
            el.child(
                v_flex()
                    .id("activity-ticker")
                    .w_full()
                    .h(px(TICKER_ROW_HEIGHT_PX * ticker_count as f32))
                    .justify_end()
                    .overflow_hidden()
                    .children(ticker_steps.enumerate().map(|(index, step)| {
                        ticker_row(step, index, ticker_count, live, motion_reduced, cx)
                    })),
            )
        })
        .when(!show_ticker, |el| {
            el.child(summary_element(
                &summary,
                running && live && !motion_reduced,
                theme.muted_foreground,
            ))
        })
        .when(issues > 0, |el| {
            el.child(
                div()
                    .text_xs()
                    .text_color(theme.warning)
                    .child(if issues == 1 {
                        "1 issue".to_string()
                    } else {
                        format!("{issues} issues")
                    }),
            )
        })
        .child(
            Icon::new(IconName::ChevronRight)
                .small()
                .text_color(theme.muted_foreground)
                .rotate(if open {
                    gpui::percentage(0.25)
                } else {
                    gpui::percentage(0.0)
                }),
        );
    let summary_button = Button::new(summary_id)
        .ghost()
        .h_auto()
        .w_full()
        .p_0()
        .justify_start()
        .tab_stop(true)
        .on_click(move |_event, _window, cx| {
            summary_state.update(cx, |state, cx| {
                state.open = !state.open;
                cx.notify();
            });
        })
        .child(summary_content);

    v_flex()
        .id("activity-feed")
        .w_full()
        .gap_0p5()
        .child(summary_button)
        .when(open, |el| {
            el.child(
                v_flex()
                    .id("activity-trail")
                    .w_full()
                    .pl_2p5()
                    .children(
                        timeline.steps.iter().enumerate().map(|(index, step)| {
                            feed_row(step, index, live, cx).into_any_element()
                        }),
                    )
                    .when(has_unverified_success_claim(timeline), |el| {
                        el.child(claim_warning(theme.clone()))
                    }),
            )
        })
        .when(running && live, |el| el.pb_0p5())
        .into_any_element()
}

fn summary_element(summary: &str, animate: bool, text_color: gpui::Hsla) -> gpui::AnyElement {
    let base = div()
        .flex_1()
        .min_w(px(0.))
        .text_xs()
        .text_color(text_color)
        .child(summary.to_string());
    if animate {
        base.with_animation(
            "activity-summary-pulse",
            Animation::new(Duration::from_millis(1200)).repeat(),
            |el, progress| el.opacity(0.72 + 0.28 * pulse(progress)),
        )
        .into_any_element()
    } else {
        base.into_any_element()
    }
}

/// A compact live ticker row. Older rows are intentionally dimmer than the
/// newest row; this is the GPUI equivalent of Electron's top fade mask while
/// keeping the row count and layout bounded even for very long turns.
fn ticker_row(
    step: &AgentStep,
    index: usize,
    row_count: usize,
    live: bool,
    motion_reduced: bool,
    cx: &mut App,
) -> gpui::AnyElement {
    let theme = cx.theme().clone();
    let line = activity_line(step);
    let text_color = match line.tone {
        StepTone::Error => theme.danger,
        StepTone::Warning => theme.warning,
        StepTone::Normal => theme.muted_foreground,
    };
    let object_color = theme.muted_foreground.opacity(0.8);
    let active = live && is_ticker_active_step(step);
    let base_opacity = ticker_row_opacity(index, row_count);
    let step_key = match step {
        AgentStep::Tool(tool) => tool.id.as_str(),
        AgentStep::Thinking(thinking) => thinking.id.as_str(),
    };
    let row = h_flex()
        .id(ElementId::Name(SharedString::from(format!(
            "activity-ticker-row-{step_key}"
        ))))
        .h(px(TICKER_ROW_HEIGHT_PX))
        .w_full()
        .min_w(px(0.))
        .items_center()
        .gap_1()
        .opacity(base_opacity)
        .child(
            div()
                .min_w(px(0.))
                .flex_1()
                .truncate()
                .text_xs()
                .text_color(text_color)
                .child(line.verb),
        )
        .when_some(line.object, |el, object| {
            el.child(
                div()
                    .max_w(px(240.))
                    .truncate()
                    .text_xs()
                    .text_color(object_color)
                    .child(object),
            )
        });
    if active && !motion_reduced {
        row.with_animation(
            ElementId::Name(SharedString::from(format!(
                "activity-ticker-pulse-{step_key}"
            ))),
            Animation::new(Duration::from_millis(1200)).repeat(),
            move |row, progress| row.opacity(base_opacity * (0.78 + 0.22 * pulse(progress))),
        )
        .into_any_element()
    } else {
        row.into_any_element()
    }
}

fn ticker_row_opacity(index: usize, row_count: usize) -> f32 {
    if row_count <= 1 {
        return 1.0;
    }
    let oldest = row_count.saturating_sub(1) as f32;
    0.45 + 0.55 * (index as f32 / oldest)
}

fn ticker_start_index(step_count: usize) -> usize {
    step_count.saturating_sub(TICKER_ROWS)
}

fn pulse(progress: f32) -> f32 {
    0.5 + 0.5 * (progress * std::f32::consts::TAU).cos()
}

fn claim_warning(theme: gpui_component::theme::Theme) -> impl IntoElement {
    h_flex()
        .id("activity-claim-warning")
        .w_full()
        .gap_2()
        .items_start()
        .mt_1p5()
        .px_2p5()
        .py_2()
        .rounded_md()
        .bg(theme.warning.opacity(0.12))
        .border_1()
        .border_color(theme.warning.opacity(0.35))
        .child(
            Icon::new(IconName::TriangleAlert)
                .small()
                .text_color(theme.warning),
        )
        .child(
            v_flex()
                .gap_0p5()
                .child(
                    div()
                        .text_xs()
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(theme.warning)
                        .child("Success not verified"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("A tool action may not have completed."),
                ),
        )
}

/// One trail row: a status icon (spinner while active + live) and the
/// verb/object line, colored by tone.
fn feed_row(step: &AgentStep, index: usize, live: bool, cx: &mut App) -> impl IntoElement {
    let theme = cx.theme().clone();
    let line = activity_line(step);
    let active = live && is_active_step(step);
    let icon = if active {
        Some(IconName::LoaderCircle)
    } else {
        match line.tone {
            StepTone::Error => Some(IconName::CircleX),
            StepTone::Warning => Some(IconName::TriangleAlert),
            StepTone::Normal => None,
        }
    };
    let icon_color = match line.tone {
        StepTone::Error => theme.danger,
        StepTone::Warning => theme.warning,
        StepTone::Normal => theme.accent,
    };
    let is_loader = matches!(icon, Some(IconName::LoaderCircle));
    let has_icon = icon.is_some();
    let text_color = match line.tone {
        StepTone::Error => theme.danger,
        StepTone::Warning => theme.warning,
        StepTone::Normal => theme.muted_foreground,
    };
    let step_id = SharedString::from(format!(
        "activity-step-{}-{index}",
        match step {
            AgentStep::Tool(tool) => tool.id.as_str(),
            AgentStep::Thinking(thinking) => thinking.id.as_str(),
        }
    ));
    h_flex()
        .id(ElementId::Name(step_id))
        .w_full()
        .gap_1p5()
        .items_center()
        .px_1p5()
        .py_0p5()
        .child(
            div()
                .size(px(14.))
                .items_center()
                .justify_center()
                .when_some(icon, |el, icon| {
                    el.child(
                        Icon::new(icon)
                            .xsmall()
                            .text_color(icon_color)
                            .rotate(if is_loader {
                                gpui::percentage(0.25)
                            } else {
                                gpui::percentage(0.0)
                            }),
                    )
                })
                .when(!has_icon, |el| {
                    el.child(
                        div()
                            .size(px(5.))
                            .rounded_full()
                            .bg(theme.muted_foreground.opacity(0.6)),
                    )
                }),
        )
        .child(
            h_flex()
                .flex_1()
                .min_w(px(0.))
                .gap_1()
                .child(div().text_xs().text_color(text_color).child(line.verb))
                .when_some(line.object, |el, object| {
                    el.child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(object),
                    )
                }),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{
        AgentThinkingStep, AgentToolStep, GenerationTimelineStatus, GENERATION_TIMELINE_VERSION,
    };
    use gpui::AppContext as _;

    fn tool_step(
        name: &str,
        label: &str,
        status: AgentStepStatus,
        target: Option<&str>,
        detail: Option<&str>,
    ) -> AgentStep {
        AgentStep::Tool(AgentToolStep {
            id: "tool-1".into(),
            order: 0,
            tool_call_id: "call-1".into(),
            tool_name: name.into(),
            label: label.into(),
            status,
            started_at: 1,
            updated_at: 1,
            finished_at: None,
            target: target.map(str::to_string),
            detail: detail.map(str::to_string),
        })
    }

    fn thinking_step(finished: bool, duration_ms: Option<u64>) -> AgentStep {
        AgentStep::Thinking(AgentThinkingStep {
            id: "think-1".into(),
            order: 0,
            started_at: 1,
            updated_at: 2,
            finished_at: finished.then_some(2),
            duration_ms,
        })
    }

    fn timeline(steps: Vec<AgentStep>, status: GenerationTimelineStatus) -> GenerationTimeline {
        GenerationTimeline {
            version: GENERATION_TIMELINE_VERSION,
            generation_id: "generation-1".into(),
            status,
            started_at: 1,
            finished_at: None,
            steps,
            claim_check: None,
        }
    }

    #[test]
    fn activity_lines_use_active_and_complete_verbs() {
        let running = tool_step(
            "read_file",
            "Read file",
            AgentStepStatus::Running,
            Some("src/main.rs"),
            None,
        );
        let line = activity_line(&running);
        assert_eq!(line.verb, "Reading");
        assert_eq!(line.object.as_deref(), Some("src/main.rs"));
        assert_eq!(line.tone, StepTone::Normal);

        let done = tool_step(
            "read_file",
            "Read file",
            AgentStepStatus::Completed,
            Some("src/main.rs"),
            None,
        );
        assert_eq!(activity_line(&done).verb, "Read");
    }

    #[test]
    fn failed_blocked_and_cancelled_tools_tone_warning_or_error() {
        let failed = tool_step(
            "run_command",
            "Run command",
            AgentStepStatus::Failed,
            None,
            None,
        );
        assert_eq!(activity_line(&failed).verb, "Run command failed");
        assert_eq!(activity_line(&failed).tone, StepTone::Error);
        let blocked = tool_step(
            "write_file",
            "Write file",
            AgentStepStatus::Blocked,
            None,
            None,
        );
        assert_eq!(activity_line(&blocked).verb, "Write file denied");
        assert_eq!(activity_line(&blocked).tone, StepTone::Warning);
        let cancelled = tool_step(
            "edit_file",
            "Edit file",
            AgentStepStatus::Cancelled,
            None,
            None,
        );
        assert_eq!(activity_line(&cancelled).verb, "Edit file cancelled");
        let approval = tool_step(
            "web_search",
            "Web search",
            AgentStepStatus::AwaitingApproval,
            None,
            None,
        );
        assert_eq!(activity_line(&approval).verb, "Web search needs approval");
    }

    #[test]
    fn ticker_only_marks_running_tools_as_live() {
        assert!(is_ticker_active_step(&tool_step(
            "run_command",
            "Run command",
            AgentStepStatus::Running,
            None,
            None,
        )));
        assert!(!is_ticker_active_step(&tool_step(
            "run_command",
            "Run command",
            AgentStepStatus::Pending,
            None,
            None,
        )));
        assert!(!is_ticker_active_step(&tool_step(
            "run_command",
            "Run command",
            AgentStepStatus::AwaitingApproval,
            None,
            None,
        )));
    }

    #[test]
    fn claim_check_warning_is_visible_only_for_unverified_success() {
        let mut timeline = timeline(
            vec![tool_step(
                "write_file",
                "Write file",
                AgentStepStatus::Completed,
                Some("src/main.rs"),
                None,
            )],
            GenerationTimelineStatus::Completed,
        );
        assert!(!has_unverified_success_claim(&timeline));
        timeline.claim_check = Some(GenerationClaimCheck::UnverifiedSuccess {
            step_ids: vec!["tool-1".into()],
        });
        assert!(has_unverified_success_claim(&timeline));
        let source = include_str!("activity_feed.rs");
        assert!(source.contains("activity-claim-warning"));
        assert!(source.contains("Success not verified"));
    }

    #[test]
    fn thinking_lines_resolve_to_thought_with_duration_once_finished() {
        let open = thinking_step(false, None);
        assert_eq!(activity_line(&open).verb, "Thinking");
        assert!(is_active_step(&open));
        let settled = thinking_step(true, Some(2_000));
        assert_eq!(activity_line(&settled).verb, "Thought");
        assert_eq!(activity_line(&settled).object.as_deref(), Some("for 2s"));
        assert!(!is_active_step(&settled));
    }

    #[test]
    fn summary_counts_files_searches_and_commands() {
        let completed = timeline(
            vec![
                tool_step(
                    "read_file",
                    "Read file",
                    AgentStepStatus::Completed,
                    Some("a.rs"),
                    None,
                ),
                tool_step(
                    "read_file",
                    "Read file",
                    AgentStepStatus::Completed,
                    Some("b.rs"),
                    None,
                ),
                tool_step(
                    "grep",
                    "Search files",
                    AgentStepStatus::Completed,
                    Some("src"),
                    Some("TODO"),
                ),
                tool_step(
                    "run_command",
                    "Run command",
                    AgentStepStatus::Completed,
                    None,
                    None,
                ),
            ],
            GenerationTimelineStatus::Completed,
        );
        let summary = summarize_activity(&completed);
        assert!(summary.contains("Explored 2 files, 1 search"));
        assert!(summary.contains("ran 1 command"));

        // The per-step grep detail lands on the feed row, not the summary.
        let grep_line = activity_line(&tool_step(
            "grep",
            "Search files",
            AgentStepStatus::Completed,
            Some("src"),
            Some("TODO"),
        ));
        assert_eq!(grep_line.object.as_deref(), Some("TODO in src"));
    }

    #[test]
    fn summary_of_a_running_thinking_only_turn_says_thinking() {
        let running = timeline(
            vec![thinking_step(false, None)],
            GenerationTimelineStatus::Running,
        );
        assert_eq!(summarize_activity(&running), "Thinking");
        let settled = timeline(
            vec![thinking_step(true, Some(3_500))],
            GenerationTimelineStatus::Completed,
        );
        assert_eq!(summarize_activity(&settled), "Thought for 4s");
        let empty = timeline(Vec::new(), GenerationTimelineStatus::Completed);
        assert_eq!(summarize_activity(&empty), "No activity");
    }

    #[test]
    fn issue_count_tallies_failed_blocked_and_cancelled() {
        let fed = timeline(
            vec![
                tool_step(
                    "read_file",
                    "Read file",
                    AgentStepStatus::Completed,
                    None,
                    None,
                ),
                tool_step(
                    "read_file",
                    "Read file",
                    AgentStepStatus::Failed,
                    None,
                    None,
                ),
                tool_step(
                    "read_file",
                    "Read file",
                    AgentStepStatus::Blocked,
                    None,
                    None,
                ),
                tool_step(
                    "read_file",
                    "Read file",
                    AgentStepStatus::Cancelled,
                    None,
                    None,
                ),
            ],
            GenerationTimelineStatus::Completed,
        );
        assert_eq!(activity_issue_count(&fed), 3);
    }

    #[test]
    fn live_ticker_is_bounded_and_fades_older_rows() {
        assert_eq!(ticker_start_index(0), 0);
        assert_eq!(ticker_start_index(2), 0);
        assert_eq!(ticker_start_index(3), 0);
        assert_eq!(ticker_start_index(8), 5);
        assert!(ticker_row_opacity(0, TICKER_ROWS) < ticker_row_opacity(1, TICKER_ROWS));
        assert!(ticker_row_opacity(1, TICKER_ROWS) < ticker_row_opacity(2, TICKER_ROWS));
        assert_eq!(ticker_row_opacity(2, TICKER_ROWS), 1.0);
    }

    #[test]
    fn summary_is_a_focusable_keyboard_toggle() {
        let source = include_str!("activity_feed.rs");
        assert!(source.contains("Button::new(summary_id)"));
        assert!(source.contains(".tab_stop(true)"));
        assert!(source.contains("state.open = !state.open"));
        assert!(source.contains("timeline.steps.iter().skip(ticker_start)"));
        assert!(source.contains("let ticker_count = timeline.steps.len().min(TICKER_ROWS)"));
    }

    #[test]
    fn settled_feed_stays_collapsed_unless_attention_requires_opening() {
        let clean = timeline(
            vec![tool_step(
                "read_file",
                "Read file",
                AgentStepStatus::Completed,
                None,
                None,
            )],
            GenerationTimelineStatus::Completed,
        );
        let mut state = ActivityFeedState::default();
        state.reconcile(&clean);
        assert!(!state.open);

        let mut failed = clean.clone();
        failed.steps[0] = tool_step(
            "run_command",
            "Run command",
            AgentStepStatus::Failed,
            None,
            None,
        );
        state.reconcile(&failed);
        assert!(state.open);
        assert_eq!(state.auto_open_key.as_deref(), Some("generation-1:issue"));

        // A user's explicit close wins after the one-shot attention reveal;
        // ordinary timeline updates must not force it open again.
        state.open = false;
        state.reconcile(&failed);
        assert!(!state.open);

        failed.claim_check = Some(GenerationClaimCheck::UnverifiedSuccess {
            step_ids: vec!["tool-1".into()],
        });
        state.reconcile(&failed);
        assert!(state.open);
        assert_eq!(state.auto_open_key.as_deref(), Some("generation-1:claim"));
    }

    #[gpui::test]
    fn disclosure_state_survives_in_a_gpui_entity_and_respects_user_close(
        cx: &mut gpui::TestAppContext,
    ) {
        let state = cx.new(|_| ActivityFeedState::default());
        let mut timeline = timeline(
            vec![tool_step(
                "run_command",
                "Run command",
                AgentStepStatus::Failed,
                None,
                None,
            )],
            GenerationTimelineStatus::Completed,
        );
        state.update(cx, |state, _| state.reconcile(&timeline));
        assert!(cx.read(|app| state.read(app).open));

        state.update(cx, |state, _| state.open = false);
        state.update(cx, |state, _| state.reconcile(&timeline));
        assert!(!cx.read(|app| state.read(app).open));

        timeline.generation_id = "generation-2".into();
        state.update(cx, |state, _| state.reconcile(&timeline));
        assert!(cx.read(|app| state.read(app).open));
        assert_eq!(
            cx.read(|app| state.read(app).generation_id.clone()),
            "generation-2"
        );
    }

    #[test]
    fn duration_formatting_matches_the_renderer() {
        assert_eq!(format_thinking_duration(None), "briefly");
        assert_eq!(format_thinking_duration(Some(1_500)), "briefly");
        assert_eq!(format_thinking_duration(Some(2_000)), "for 2s");
        assert_eq!(format_thinking_duration(Some(65_000)), "for 1m 5s");
        assert_eq!(format_thinking_duration(Some(120_000)), "for 2m");
    }
}
