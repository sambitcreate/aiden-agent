//! Generation activity feed — the thinking/tool trail of one assistant turn
//! (port of `renderer/components/activity-feed.tsx` + `renderer/lib/agent-steps.ts`).
//!
//! The pure step-line logic (`activity_line`, `summarize_activity`, ...) is
//! unit-tested; [`timeline_feed`] renders a persisted or live
//! `aiden_core::GenerationTimeline` above the message bubble.

use aiden_core::{AgentStep, AgentStepStatus, GenerationTimeline, GenerationTimelineStatus};
use gpui::{
    div, prelude::FluentBuilder as _, px, App, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, Styled as _,
};
use gpui_component::{h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _};

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

/// Render a timeline as a compact activity feed: a summary header followed by
/// the full thinking/tool trail. `live` runs an accent spinner on active
/// steps and keeps the summary shimmer-style while the turn runs.
pub fn timeline_feed(timeline: &GenerationTimeline, live: bool, cx: &mut App) -> gpui::AnyElement {
    if timeline.steps.is_empty() {
        return div().into_any_element();
    }
    let theme = cx.theme().clone();
    let running = timeline.status == GenerationTimelineStatus::Running;
    let summary = summarize_activity(timeline);
    let issues = activity_issue_count(timeline);

    v_flex()
        .id("activity-feed")
        .w_full()
        .gap_0p5()
        .child(
            h_flex()
                .id("activity-summary")
                .w_full()
                .gap_1p5()
                .items_center()
                .px_1p5()
                .py_1()
                .rounded_md()
                .cursor_pointer()
                .child(
                    div()
                        .flex_1()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(summary),
                )
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
                        .text_color(theme.muted_foreground),
                ),
        )
        .child(
            v_flex().id("activity-trail").w_full().pl_2p5().children(
                timeline
                    .steps
                    .iter()
                    .enumerate()
                    .map(|(index, step)| feed_row(step, index, live, cx).into_any_element()),
            ),
        )
        .when(running && live, |el| el.pb_0p5())
        .into_any_element()
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
    fn duration_formatting_matches_the_renderer() {
        assert_eq!(format_thinking_duration(None), "briefly");
        assert_eq!(format_thinking_duration(Some(1_500)), "briefly");
        assert_eq!(format_thinking_duration(Some(2_000)), "for 2s");
        assert_eq!(format_thinking_duration(Some(65_000)), "for 1m 5s");
        assert_eq!(format_thinking_duration(Some(120_000)), "for 2m");
    }
}
