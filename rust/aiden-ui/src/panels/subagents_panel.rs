//! Subagent roster — the read-only run list for the active chat (port of
//! `renderer/components/subagents-panel.tsx`, `subagent-roster.tsx`, and
//! `subagent-chips.tsx` display logic over the V2 snapshot states in
//! `aiden_core::subagent_runs`).
//!
//! The panel groups runs into Active/Done, renders a state icon, title,
//! duration, and child counts, and expands into a detail row. It is fed by an
//! injected [`SubagentRunSource`] (Arc'd) returning renderer-safe V2
//! snapshots; the app wires the shared production
//! [`SubagentAuthority`](crate::services::subagents::SubagentAuthority) owned
//! by [`Stores`](crate::services::stores::Stores). All view logic (grouping,
//! counts, elapsed formatting, selection) is pure and unit-tested.

use std::sync::Arc;

use aiden_core::subagent_runs::{
    SubagentEffectActivityStateV1, SubagentEffectActivityV1, SubagentRunSnapshotV2,
    SubagentRunStateV2, SubagentSnapshotRole,
};
use gpui::{
    div, percentage, prelude::FluentBuilder as _, px, AppContext as _, Context, ElementId,
    FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _};

/// One event the panel emits; the orchestrator can route it to the run
/// registry (read-only surface, so today only selection changes are emitted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentPanelEvent {
    Selected(String),
}

// ===========================================================================
// Pure view logic (port of renderer/lib/subagent-view-state.ts)
// ===========================================================================

/// `isSubagentRunViewStateActive` — queued/starting/running/needs_attention.
pub fn is_state_active(state: SubagentRunStateV2) -> bool {
    matches!(
        state,
        SubagentRunStateV2::Queued
            | SubagentRunStateV2::Starting
            | SubagentRunStateV2::Running
            | SubagentRunStateV2::NeedsAttention
    )
}

/// `subagentStateLabel` — the human label for a run state.
pub fn state_label(state: SubagentRunStateV2) -> &'static str {
    match state {
        SubagentRunStateV2::Queued => "Queued",
        SubagentRunStateV2::Starting => "Starting",
        SubagentRunStateV2::Running => "Working",
        SubagentRunStateV2::Completed => "Finished",
        SubagentRunStateV2::Failed => "Failed",
        SubagentRunStateV2::TimedOut => "Timed out",
        SubagentRunStateV2::Interrupted => "Interrupted",
        SubagentRunStateV2::NeedsAttention => "Needs attention",
        SubagentRunStateV2::Stopped => "Stopped",
        SubagentRunStateV2::Unknown => "Outcome unknown",
    }
}

/// The rendered group for a run: Active or Done.
#[allow(dead_code)] // renderer-contract grouping type (the panel uses `split_runs`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunGroup {
    Active,
    Done,
}

/// `splitSubagentRunViews` — active runs first, then terminal ones.
pub fn split_runs(
    runs: &[SubagentRunSnapshotV2],
) -> (Vec<&SubagentRunSnapshotV2>, Vec<&SubagentRunSnapshotV2>) {
    let mut active = Vec::new();
    let mut done = Vec::new();
    for run in runs {
        if is_state_active(run.state) {
            active.push(run);
        } else {
            done.push(run);
        }
    }
    (active, done)
}

/// `summarizeSubagentRunViews` — the counts rendered in headers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunCounts {
    pub total: usize,
    pub active: usize,
    pub done: usize,
    pub completed: usize,
    pub failed: usize,
    pub timed_out: usize,
    pub interrupted: usize,
}

pub fn summarize_runs(runs: &[SubagentRunSnapshotV2]) -> RunCounts {
    let (active, done) = split_runs(runs);
    let all = active.iter().chain(done.iter());
    let mut counts = RunCounts {
        total: runs.len(),
        active: active.len(),
        done: done.len(),
        ..RunCounts::default()
    };
    for run in all {
        match run.state {
            SubagentRunStateV2::Completed => counts.completed += 1,
            SubagentRunStateV2::Failed => counts.failed += 1,
            SubagentRunStateV2::TimedOut => counts.timed_out += 1,
            SubagentRunStateV2::Interrupted | SubagentRunStateV2::Stopped => {
                counts.interrupted += 1;
            }
            _ => {}
        }
    }
    counts
}

/// `subagentElapsedMilliseconds` + `formatSubagentElapsed`.
pub fn elapsed_ms(run: &SubagentRunSnapshotV2, now: u64) -> u64 {
    if is_state_active(run.state) {
        now.saturating_sub(run.started_at)
    } else {
        run.finished_at
            .unwrap_or(run.updated_at)
            .saturating_sub(run.started_at)
    }
}

pub fn format_elapsed(milliseconds: u64) -> String {
    let total_seconds = milliseconds / 1_000;
    let days = total_seconds / 86_400;
    let hours = (total_seconds % 86_400) / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let seconds = total_seconds % 60;
    if days > 0 {
        format!("{days}d {hours}h {minutes}m")
    } else if hours > 0 {
        format!("{hours}h {minutes}m {seconds}s")
    } else if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
    }
}

/// Direct children of a run (V2 `parentRunId` lineage, depth ≤ 2).
pub fn children_of<'a>(
    parent: &SubagentRunSnapshotV2,
    all: &'a [SubagentRunSnapshotV2],
) -> Vec<&'a SubagentRunSnapshotV2> {
    all.iter()
        .filter(|run| run.parent_run_id.as_deref() == Some(parent.run_id.as_str()))
        .collect()
}

/// `resolveSubagentSelection` — keep a valid selection, else the first run.
#[allow(dead_code)] // renderer-contract helper; selection state stays in the panel
pub fn resolve_selection<'a>(
    runs: &'a [SubagentRunSnapshotV2],
    requested: Option<&str>,
) -> Option<&'a SubagentRunSnapshotV2> {
    if let Some(requested) = requested {
        if let Some(run) = runs.iter().find(|run| run.run_id == requested) {
            return Some(run);
        }
    }
    runs.first()
}

// ===========================================================================
// Service dependencies
// ===========================================================================

/// Read-only source of V2 subagent run snapshots for the current chat.
pub trait SubagentRunSource: Send + Sync {
    fn snapshots(&self) -> Vec<SubagentRunSnapshotV2>;

    /// Snapshots scoped to one chat. The default returns everything; live
    /// sources narrow to the active chat's lineage.
    fn snapshots_for_chat(&self, _chat_id: &str) -> Vec<SubagentRunSnapshotV2> {
        self.snapshots()
    }

    fn unavailable_message(&self) -> Option<String> {
        None
    }

    fn effect_activity_for_run(
        &self,
        _run_id: &str,
        _chat_id: &str,
    ) -> Vec<SubagentEffectActivityV1> {
        Vec::new()
    }

    fn stop(&self, _run_id: &str) -> bool {
        false
    }
}

impl SubagentRunSource for crate::services::subagents::SubagentAuthority {
    fn snapshots(&self) -> Vec<SubagentRunSnapshotV2> {
        crate::services::subagents::SubagentAuthority::snapshots(self)
    }

    fn snapshots_for_chat(&self, chat_id: &str) -> Vec<SubagentRunSnapshotV2> {
        crate::services::subagents::SubagentAuthority::snapshots_for_chat(self, chat_id)
    }

    fn unavailable_message(&self) -> Option<String> {
        self.availability()
            .err()
            .map(|reason| reason.message().to_string())
    }

    fn effect_activity_for_run(
        &self,
        run_id: &str,
        chat_id: &str,
    ) -> Vec<SubagentEffectActivityV1> {
        crate::services::subagents::SubagentAuthority::effect_activity_for_run(
            self, run_id, chat_id,
        )
    }

    fn stop(&self, run_id: &str) -> bool {
        self.stop_run(run_id)
    }
}

/// In-memory source (demo data for standalone use and tests).
#[derive(Debug, Default)]
pub struct MemoryRunSource {
    pub runs: std::sync::Mutex<Vec<SubagentRunSnapshotV2>>,
}

impl SubagentRunSource for MemoryRunSource {
    fn snapshots(&self) -> Vec<SubagentRunSnapshotV2> {
        let guard = self.runs.lock();
        guard.map(|runs| runs.clone()).unwrap_or_default()
    }
}

#[allow(dead_code)] // standalone/demo scaffolding
#[allow(clippy::too_many_arguments)]
fn demo_run(
    run_id: &str,
    parent: Option<&str>,
    label: &str,
    role: SubagentSnapshotRole,
    state: SubagentRunStateV2,
    started_at: u64,
    finished_at: Option<u64>,
    turns: u64,
) -> SubagentRunSnapshotV2 {
    SubagentRunSnapshotV2 {
        version: 2,
        run_id: run_id.to_string(),
        group_id: "group-1".to_string(),
        generation_id: "generation-1".to_string(),
        child_id: run_id.to_string(),
        chat_id: "chat-1".to_string(),
        workspace_id: "workspace-1".to_string(),
        revision: 1,
        role,
        label: label.to_string(),
        task_preview: "Investigate the failing build and report the root cause.".to_string(),
        state,
        activity: if is_state_active(state) {
            Some("Reading workspace files".to_string())
        } else {
            None
        },
        started_at,
        updated_at: finished_at.unwrap_or(started_at),
        finished_at,
        model_id: "claude-sonnet-4-5".to_string(),
        turns,
        tools: turns * 2,
        tokens: turns * 1_000,
        milestones: None,
        latest_text: None,
        terminal_markdown: None,
        error: None,
        warnings: Vec::new(),
        parent_run_id: parent.map(str::to_string),
        retry_of_run_id: None,
        depth: if parent.is_some() { 2 } else { 1 },
        execution: aiden_core::subagent_runs::SubagentExecutionModeV2::Foreground,
        context: aiden_core::subagent_runs::SubagentContextModeV2::Fresh,
        authority_revision: 1,
    }
}

impl MemoryRunSource {
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn sample() -> Self {
        let now = aiden_data::now_millis();
        Self {
            runs: std::sync::Mutex::new(vec![
                demo_run(
                    "scout-1",
                    None,
                    "Scout: workspace scan",
                    SubagentSnapshotRole::Scout,
                    SubagentRunStateV2::Running,
                    now - 12_000,
                    None,
                    3,
                ),
                demo_run(
                    "planner-1",
                    None,
                    "Planner: fix plan",
                    SubagentSnapshotRole::Planner,
                    SubagentRunStateV2::Completed,
                    now - 300_000,
                    Some(now - 240_000),
                    6,
                ),
                demo_run(
                    "reviewer-1",
                    Some("planner-1"),
                    "Review: plan boundary",
                    SubagentSnapshotRole::Reviewer,
                    SubagentRunStateV2::Completed,
                    now - 200_000,
                    Some(now - 180_000),
                    2,
                ),
                demo_run(
                    "scout-2",
                    None,
                    "Scout: second pass",
                    SubagentSnapshotRole::Scout,
                    SubagentRunStateV2::Failed,
                    now - 3_600_000,
                    Some(now - 3_400_000),
                    1,
                ),
            ]),
        }
    }
}

// ===========================================================================
// The panel entity
// ===========================================================================

/// Active/done grouping with child counts resolved against the full set.
pub type GroupedSubagentRuns = (
    Vec<(SubagentRunSnapshotV2, usize)>,
    Vec<(SubagentRunSnapshotV2, usize)>,
);

pub struct SubagentsPanel {
    pub(crate) source: Arc<dyn SubagentRunSource>,
    pub(crate) snapshots: Vec<SubagentRunSnapshotV2>,
    effect_activity: std::collections::HashMap<String, Vec<SubagentEffectActivityV1>>,
    pub(crate) selected_run_id: Option<String>,
    pub(crate) expanded: std::collections::BTreeSet<String>,
    pub(crate) now: u64,
    pub(crate) loaded: bool,
    /// The active chat the roster is scoped to (live sources filter on it).
    pub(crate) active_chat: Option<String>,
    /// Coalesces overlapping background refreshes (see [`RefreshGate`]).
    refresh_gate: RefreshGate,
    _tick: Option<gpui::Task<()>>,
}

/// Serializes the panel's disk-read refreshes. The 2-second tick can fire
/// while a previous refresh is still reading the (up to 8 MiB) run store on
/// the background executor; overlapping reads would pile up detached tasks and
/// could apply stale results over newer ones. [`RefreshGate`] lets at most one
/// refresh run at a time.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct RefreshGate {
    in_flight: bool,
}

impl RefreshGate {
    /// Claim the gate. `Ok(())` means this caller should start a refresh;
    /// `Err(())` means one is already running and this call is a no-op.
    fn begin(&mut self) -> Result<(), ()> {
        if self.in_flight {
            Err(())
        } else {
            self.in_flight = true;
            Ok(())
        }
    }

    fn finish(&mut self) {
        self.in_flight = false;
    }
}

/// Dependencies for [`SubagentsPanel::new`].
pub struct SubagentsPanelDeps {
    pub source: Arc<dyn SubagentRunSource>,
}

impl SubagentsPanelDeps {
    pub fn new(source: Arc<dyn SubagentRunSource>) -> Self {
        Self { source }
    }

    /// Demo wiring for standalone use and tests.
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn demo() -> Self {
        Self::new(Arc::new(MemoryRunSource::sample()))
    }
}

impl SubagentsPanel {
    pub fn new(cx: &mut Context<Self>, deps: SubagentsPanelDeps) -> Self {
        let mut this = Self {
            source: deps.source,
            snapshots: Vec::new(),
            effect_activity: std::collections::HashMap::new(),
            selected_run_id: None,
            expanded: std::collections::BTreeSet::new(),
            now: aiden_data::now_millis(),
            loaded: false,
            active_chat: None,
            refresh_gate: RefreshGate::default(),
            _tick: None,
        };
        this.refresh(cx);
        this.start_ticking(cx);
        this
    }

    /// Scope the roster to one chat and reload immediately. The orchestrator
    /// calls this when the active chat changes so live sources narrow their
    /// reads to that chat's lineage.
    #[allow(dead_code)] // wired by the shell owner (app.rs routes chat switches)
    pub fn set_active_chat(&mut self, chat_id: Option<String>, cx: &mut Context<Self>) {
        if self.active_chat.as_deref() == chat_id.as_deref() {
            return;
        }
        self.active_chat = chat_id;
        self.refresh(cx);
    }

    /// Load snapshots from the source on the background executor. Overlapping
    /// refreshes are coalesced: at most one disk read is in flight at a time,
    /// and a refresh that outlives a chat switch never applies results for the
    /// previous scope.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.refresh_gate.begin().is_err() {
            return;
        }
        let source = self.source.clone();
        let chat_id = self.active_chat.clone();
        let read_scope = chat_id.clone();
        cx.spawn(async move |this, cx| {
            let (snapshots, effects) = cx
                .background_spawn(async move {
                    let snapshots = match read_scope.as_deref() {
                        Some(chat_id) => source.snapshots_for_chat(chat_id),
                        None => source.snapshots(),
                    };
                    let effects = snapshots
                        .iter()
                        .map(|run| {
                            (
                                run.run_id.clone(),
                                source.effect_activity_for_run(&run.run_id, &run.chat_id),
                            )
                        })
                        .collect();
                    (snapshots, effects)
                })
                .await;
            this.update(cx, |this, cx| {
                this.refresh_gate.finish();
                if this.active_chat.as_deref() != chat_id.as_deref() {
                    // The scoped chat changed while reading; re-read for the
                    // new scope instead of applying stale results.
                    this.refresh(cx);
                    return;
                }
                this.snapshots = snapshots;
                this.effect_activity = effects;
                this.loaded = true;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Keep running durations fresh while the panel is mounted, and re-read
    /// the run store every 2 seconds so live runs advance while visible.
    fn start_ticking(&mut self, cx: &mut Context<Self>) {
        let tick = cx.spawn(async move |this, cx| {
            let mut refresh_every = 0u8;
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
                this.update(cx, |this, cx| {
                    this.now = aiden_data::now_millis();
                    refresh_every += 1;
                    if refresh_every >= 2 {
                        refresh_every = 0;
                        this.refresh(cx);
                    } else {
                        cx.notify();
                    }
                })
                .ok();
            }
        });
        self._tick = Some(tick);
    }

    pub fn select_run(&mut self, run_id: &str, cx: &mut Context<Self>) {
        self.selected_run_id = Some(run_id.to_string());
        cx.emit(SubagentPanelEvent::Selected(run_id.to_string()));
        cx.notify();
    }

    pub fn toggle_expanded(&mut self, run_id: &str, cx: &mut Context<Self>) {
        if !self.expanded.remove(run_id) {
            self.expanded.insert(run_id.to_string());
        }
        cx.notify();
    }

    /// Active/done grouping with child counts resolved against the full set.
    pub fn grouped(&self) -> GroupedSubagentRuns {
        let (active, done) = split_runs(&self.snapshots);
        let with_children = |runs: Vec<&SubagentRunSnapshotV2>| {
            runs.into_iter()
                .map(|run| {
                    let count = children_of(run, &self.snapshots).len();
                    (run.clone(), count)
                })
                .collect::<Vec<_>>()
        };
        (with_children(active), with_children(done))
    }

    fn row(
        &self,
        run: &SubagentRunSnapshotV2,
        child_count: usize,
        depth: u8,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let selected = self.selected_run_id.as_deref() == Some(run.run_id.as_str());
        let expanded = self.expanded.contains(&run.run_id);
        let display_state = if depth == 1 && is_state_active(run.state) {
            "Active"
        } else {
            state_label(run.state)
        };
        let duration = format_elapsed(elapsed_ms(run, self.now));
        let (bg, fg) = if selected {
            (theme.accent, theme.accent_foreground)
        } else {
            (theme.background, theme.foreground)
        };
        let run_id = run.run_id.clone();
        let click_id = run_id.clone();
        let expand_id = run_id.clone();

        h_flex()
            .id(ElementId::Name(SharedString::from(format!(
                "subagent-{run_id}"
            ))))
            .w_full()
            .px_2()
            .py_1p5()
            .gap_2()
            .items_center()
            .rounded_md()
            .when(
                crate::services::appearance::pointer_cursors_enabled(cx),
                |el| el.cursor_pointer(),
            )
            .bg(bg)
            .text_color(fg)
            .when(depth > 1, |el| el.pl_6())
            .on_click(cx.listener(move |this, _event, _window, cx| {
                this.select_run(&click_id, cx);
            }))
            .child(self.state_orb(run, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(0.))
                    .gap_0p5()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .truncate()
                            .child(run.label.clone()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(run.task_preview.clone()),
                    ),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(duration),
            )
            .when(child_count > 0, |el| {
                let expand_click = expand_id.clone();
                el.child(
                    div()
                        .id(ElementId::Name(SharedString::from(format!(
                            "subagent-expand-{expand_click}"
                        ))))
                        .flex_shrink_0()
                        .size(px(18.))
                        .items_center()
                        .justify_center()
                        .child(
                            Icon::new(IconName::ChevronRight)
                                .xsmall()
                                .text_color(theme.muted_foreground)
                                .rotate(if expanded {
                                    percentage(0.25)
                                } else {
                                    percentage(0.0)
                                }),
                        )
                        .on_click(cx.listener(move |this, _event, _window, cx| {
                            cx.stop_propagation();
                            this.toggle_expanded(&expand_click, cx);
                        })),
                )
            })
            .child(
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .text_color(match run.state {
                        SubagentRunStateV2::Failed => theme.danger,
                        SubagentRunStateV2::TimedOut | SubagentRunStateV2::NeedsAttention => {
                            theme.warning
                        }
                        _ => theme.muted_foreground,
                    })
                    .child(display_state),
            )
    }

    fn state_orb(&self, run: &SubagentRunSnapshotV2, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let (color, icon) = match run.state {
            SubagentRunStateV2::Running | SubagentRunStateV2::NeedsAttention => {
                (theme.primary, Some(IconName::LoaderCircle))
            }
            SubagentRunStateV2::Queued | SubagentRunStateV2::Starting => {
                (theme.secondary, Some(IconName::LoaderCircle))
            }
            SubagentRunStateV2::Completed => (theme.success, Some(IconName::CircleCheck)),
            SubagentRunStateV2::Failed => (theme.danger, Some(IconName::CircleX)),
            SubagentRunStateV2::TimedOut => (theme.warning, Some(IconName::TriangleAlert)),
            SubagentRunStateV2::Interrupted | SubagentRunStateV2::Stopped => {
                (theme.muted_foreground, Some(IconName::CircleX))
            }
            SubagentRunStateV2::Unknown => (theme.muted_foreground, None),
        };
        div()
            .size(px(18.))
            .rounded_full()
            .bg(color)
            .text_color(theme.background)
            .items_center()
            .justify_center()
            .when_some(icon, |el, icon| el.child(Icon::new(icon).xsmall()))
    }

    fn detail(&self, run: &SubagentRunSnapshotV2, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let children = children_of(run, &self.snapshots);
        let effects = self
            .effect_activity
            .get(&run.run_id)
            .cloned()
            .unwrap_or_default();
        v_flex()
            .id(ElementId::Name(SharedString::from(format!(
                "subagent-detail-{}",
                run.run_id
            ))))
            .w_full()
            .pl_8()
            .pr_2()
            .py_1()
            .gap_1()
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(format!(
                        "{} · {} turns · {} tools · {} tokens",
                        run.model_id, run.turns, run.tools, run.tokens
                    )),
            )
            .when_some(run.activity.clone(), |el, activity| {
                el.child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(activity),
                )
            })
            .when_some(run.error.clone(), |el, error| {
                el.child(
                    div()
                        .text_xs()
                        .text_color(theme.danger)
                        .child(format!("Error: {error}")),
                )
            })
            .children(effects.into_iter().map(|effect| {
                let color = match effect.state {
                    SubagentEffectActivityStateV1::RemoteError
                    | SubagentEffectActivityStateV1::Unknown => theme.danger,
                    SubagentEffectActivityStateV1::Prepared
                    | SubagentEffectActivityStateV1::Authorized => theme.warning,
                    _ => theme.muted_foreground,
                };
                div().text_xs().text_color(color).child(effect.label)
            }))
            .when(is_state_active(run.state), |el| {
                let run_id = run.run_id.clone();
                el.child(
                    div()
                        .id(ElementId::Name(SharedString::from(format!(
                            "subagent-stop-{run_id}"
                        ))))
                        .px_2()
                        .py_1()
                        .rounded_md()
                        .bg(theme.secondary)
                        .text_xs()
                        .child("Stop run")
                        .on_click(cx.listener(move |this, _event, _window, cx| {
                            if this.source.stop(&run_id) {
                                this.refresh(cx);
                            }
                        })),
                )
            })
            .when(!children.is_empty(), |el| {
                el.child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.muted_foreground)
                        .child(format!("{} child run(s)", children.len())),
                )
            })
            .children(children.into_iter().map(|child| self.row(child, 0, 2, cx)))
    }

    fn empty_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        v_flex()
            .id("subagents-empty")
            .flex_1()
            .w_full()
            .items_center()
            .justify_center()
            .gap_1()
            .child(
                div()
                    .text_base()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("No subagents yet"),
            )
            .child(div().text_sm().text_color(theme.muted_foreground).child(
                self.source.unavailable_message().unwrap_or_else(|| {
                    "Subagents used by this conversation will appear here.".to_string()
                }),
            ))
    }
}

impl gpui::EventEmitter<SubagentPanelEvent> for SubagentsPanel {}

/// Renderer-safe role label (the renderer shows the role string verbatim).
#[allow(dead_code)] // renderer-contract helper; roles render through the state orb today
fn role_name(role: SubagentSnapshotRole) -> &'static str {
    match role {
        SubagentSnapshotRole::Scout => "scout",
        SubagentSnapshotRole::Planner => "planner",
        SubagentSnapshotRole::Reviewer => "reviewer",
    }
}

impl Render for SubagentsPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        if self.snapshots.is_empty() {
            return self.empty_state(cx).into_any_element();
        }

        let (active, done) = self.grouped();
        let counts = summarize_runs(&self.snapshots);

        let mut groups: Vec<(String, Vec<(SubagentRunSnapshotV2, usize)>)> = Vec::new();
        if !active.is_empty() {
            groups.push((format!("Active · {}", counts.active), active));
        }
        if !done.is_empty() {
            groups.push((format!("Done · {}", counts.done), done));
        }

        let mut rows: Vec<gpui::AnyElement> = Vec::new();
        for (label, runs) in groups {
            rows.push(
                div()
                    .px_2()
                    .pt_2()
                    .pb_1()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.muted_foreground)
                    .child(label)
                    .into_any_element(),
            );
            for (run, child_count) in runs {
                let expanded = self.expanded.contains(&run.run_id);
                let item = v_flex()
                    .w_full()
                    .child(self.row(&run, child_count, run.depth, cx))
                    .when(expanded, |el| el.child(self.detail(&run, cx)));
                rows.push(item.into_any_element());
            }
        }

        v_flex()
            .id("subagents-panel")
            .size_full()
            .bg(theme.background)
            .child(
                h_flex()
                    .id("subagents-header")
                    .w_full()
                    .px_3()
                    .py_2()
                    .items_center()
                    .child(
                        div()
                            .text_base()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Subagents"),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "{} runs · {} failed · {} timed out",
                                counts.total, counts.failed, counts.timed_out
                            )),
                    ),
            )
            .child(
                div()
                    .id("subagents-list")
                    .flex_1()
                    .w_full()
                    .overflow_y_scroll()
                    .px_1p5()
                    .py_1()
                    .children(rows),
            )
            .into_any_element()
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_authority_source_reports_unavailable_and_routes_stop() {
        let authority = crate::services::subagents::SubagentAuthority::new(None);
        let source: Arc<dyn SubagentRunSource> = authority;
        assert_eq!(
            source.unavailable_message().as_deref(),
            Some("Subagent history is unavailable on this device.")
        );
        assert!(source.snapshots().is_empty());
        assert!(source.snapshots_for_chat("chat-1").is_empty());
        assert!(!source.stop("run-missing"));
    }

    #[test]
    fn state_labels_match_the_renderer() {
        assert_eq!(state_label(SubagentRunStateV2::Running), "Working");
        assert_eq!(state_label(SubagentRunStateV2::Completed), "Finished");
        assert_eq!(state_label(SubagentRunStateV2::Failed), "Failed");
        assert_eq!(state_label(SubagentRunStateV2::TimedOut), "Timed out");
        assert_eq!(state_label(SubagentRunStateV2::Interrupted), "Interrupted");
        assert_eq!(
            state_label(SubagentRunStateV2::NeedsAttention),
            "Needs attention"
        );
        assert_eq!(state_label(SubagentRunStateV2::Stopped), "Stopped");
        assert_eq!(state_label(SubagentRunStateV2::Unknown), "Outcome unknown");
    }

    #[test]
    fn active_states_are_queued_starting_running_and_needs_attention() {
        assert!(is_state_active(SubagentRunStateV2::Queued));
        assert!(is_state_active(SubagentRunStateV2::Starting));
        assert!(is_state_active(SubagentRunStateV2::Running));
        assert!(is_state_active(SubagentRunStateV2::NeedsAttention));
        assert!(!is_state_active(SubagentRunStateV2::Completed));
        assert!(!is_state_active(SubagentRunStateV2::Unknown));
    }

    #[test]
    fn elapsed_formatting_matches_the_renderer() {
        assert_eq!(format_elapsed(5_000), "5s");
        assert_eq!(format_elapsed(5 * 60_000 + 3_000), "5m 3s");
        assert_eq!(
            format_elapsed(2 * 3_600_000 + 3 * 60_000 + 5_000),
            "2h 3m 5s"
        );
        assert_eq!(
            format_elapsed(86_400_000 + 2 * 3_600_000 + 3 * 60_000),
            "1d 2h 3m"
        );
        assert_eq!(format_elapsed(0), "0s");
    }

    #[test]
    fn elapsed_uses_finished_at_for_terminal_runs_and_now_for_active() {
        let now = 10_000;
        let active = demo_run(
            "a",
            None,
            "A",
            SubagentSnapshotRole::Scout,
            SubagentRunStateV2::Running,
            8_000,
            None,
            1,
        );
        assert_eq!(elapsed_ms(&active, now), 2_000);

        let done = demo_run(
            "b",
            None,
            "B",
            SubagentSnapshotRole::Scout,
            SubagentRunStateV2::Completed,
            2_000,
            Some(6_000),
            1,
        );
        assert_eq!(elapsed_ms(&done, now), 4_000);
    }

    #[test]
    fn split_and_summarize_runs_group_active_and_done() {
        let now = aiden_data::now_millis();
        let runs = vec![
            demo_run(
                "r1",
                None,
                "A",
                SubagentSnapshotRole::Scout,
                SubagentRunStateV2::Running,
                now - 100,
                None,
                1,
            ),
            demo_run(
                "r2",
                None,
                "B",
                SubagentSnapshotRole::Scout,
                SubagentRunStateV2::Completed,
                now - 200,
                Some(now - 100),
                1,
            ),
            demo_run(
                "r3",
                None,
                "C",
                SubagentSnapshotRole::Scout,
                SubagentRunStateV2::Failed,
                now - 300,
                Some(now - 100),
                1,
            ),
        ];
        let (active, done) = split_runs(&runs);
        assert_eq!(active.len(), 1);
        assert_eq!(done.len(), 2);
        let counts = summarize_runs(&runs);
        assert_eq!(counts.total, 3);
        assert_eq!(counts.active, 1);
        assert_eq!(counts.done, 2);
        assert_eq!(counts.completed, 1);
        assert_eq!(counts.failed, 1);
    }

    #[test]
    fn children_of_uses_v2_parent_lineage() {
        let parent = demo_run(
            "parent",
            None,
            "P",
            SubagentSnapshotRole::Planner,
            SubagentRunStateV2::Running,
            1,
            None,
            1,
        );
        let child = demo_run(
            "child",
            Some("parent"),
            "C",
            SubagentSnapshotRole::Reviewer,
            SubagentRunStateV2::Running,
            1,
            None,
            1,
        );
        let other = demo_run(
            "other",
            None,
            "O",
            SubagentSnapshotRole::Scout,
            SubagentRunStateV2::Running,
            1,
            None,
            1,
        );
        let all = vec![parent, child, other];
        let children = children_of(&all[0], &all);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].run_id, "child");
    }

    #[test]
    fn resolve_selection_falls_back_to_first_run() {
        let now = aiden_data::now_millis();
        let runs = vec![
            demo_run(
                "one",
                None,
                "A",
                SubagentSnapshotRole::Scout,
                SubagentRunStateV2::Running,
                now,
                None,
                1,
            ),
            demo_run(
                "two",
                None,
                "B",
                SubagentSnapshotRole::Scout,
                SubagentRunStateV2::Running,
                now,
                None,
                1,
            ),
        ];
        assert_eq!(
            resolve_selection(&runs, Some("two")).map(|run| run.run_id.as_str()),
            Some("two")
        );
        assert_eq!(
            resolve_selection(&runs, Some("missing")).map(|run| run.run_id.as_str()),
            Some("one")
        );
        assert_eq!(resolve_selection(&runs, None).unwrap().run_id, "one");
    }

    // =====================================================================
    // RefreshGate (refresh coalescing)
    // =====================================================================

    #[test]
    fn refresh_gate_coalesces_overlapping_refreshes() {
        let mut gate = RefreshGate::default();
        // First refresh claims the gate.
        assert_eq!(gate.begin(), Ok(()));
        // A second refresh while one is in flight is a no-op (the 2s tick can
        // fire during a slow run-store read).
        assert_eq!(gate.begin(), Err(()));
        assert_eq!(gate.begin(), Err(()));
        // Finishing reopens the gate.
        gate.finish();
        assert_eq!(gate.begin(), Ok(()));
        gate.finish();
        assert_eq!(gate, RefreshGate::default());
    }
}
