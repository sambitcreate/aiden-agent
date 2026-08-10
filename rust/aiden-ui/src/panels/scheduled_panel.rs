//! Scheduled tasks — the main-window list view (port of the `/scheduled`
//! route surface: `renderer/lib/scheduled-task-view.ts` + its tests, rendered
//! from `aiden_data::schedule_store::ScheduledTask` records).
//!
//! The panel is a standalone entity fed by an injected [`ScheduledTaskSource`]
//! (Arc'd; the orchestrator wires a store-backed adapter later). Enabling/
//! disabling a task or triggering "Run now" emits a [`ScheduledPanelEvent`]
//! instead of touching the store directly. All formatting/countdown logic is
//! pure and unit-tested against the renderer's contract.

use std::sync::Arc;

use aiden_data::schedule_store::{
    system_timezone, ScheduledRunResult, ScheduledTask, ScheduledTaskMode,
};
use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, ElementId,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _,
};

/// Events the panel emits; the orchestrator maps them onto the schedule store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduledPanelEvent {
    ToggleEnabled { id: String, enabled: bool },
    RunNow { id: String },
    Refresh,
}

/// Filter tabs (`ScheduledTaskTab` in the renderer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TaskTab {
    #[default]
    All,
    Active,
    Paused,
}

impl TaskTab {
    pub fn label(self) -> &'static str {
        match self {
            TaskTab::All => "All",
            TaskTab::Active => "Configured",
            TaskTab::Paused => "Dormant",
        }
    }
}

// ===========================================================================
// Pure view logic (port of renderer/lib/scheduled-task-view.ts)
// ===========================================================================

/// `filterScheduledTasks` — combine the tab filter and the text query.
pub fn filter_scheduled_tasks(
    tasks: &[ScheduledTask],
    query: &str,
    tab: TaskTab,
) -> Vec<ScheduledTask> {
    let normalized = query.trim().to_lowercase();
    tasks
        .iter()
        .filter(|task| {
            if tab == TaskTab::Active && !task.enabled {
                return false;
            }
            if tab == TaskTab::Paused && task.enabled {
                return false;
            }
            if normalized.is_empty() {
                return true;
            }
            format!(
                "{} {} {} {}",
                task.name,
                task.cron,
                task.prompt.as_deref().unwrap_or(""),
                task.script.as_deref().unwrap_or("")
            )
            .to_lowercase()
            .contains(&normalized)
        })
        .cloned()
        .collect()
}

fn number_field(value: &str, minimum: u32, maximum: u32) -> Option<u32> {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let number: u32 = value.parse().ok()?;
    (number >= minimum && number <= maximum).then_some(number)
}

fn clock_label(hour: u32, minute: u32) -> String {
    let display_hour = match hour {
        0 => 12,
        13..=23 => hour - 12,
        other => other,
    };
    let period = if hour < 12 { "AM" } else { "PM" };
    format!("{display_hour}:{minute:02} {period}")
}

fn weekday_label(day: u32) -> String {
    match day {
        0 => "Sunday",
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        6 => "Saturday",
        _ => "Unknown",
    }
    .to_string()
}

fn conjunction_label(labels: &[String]) -> String {
    match labels {
        [first, second] => format!("{first} and {second}"),
        [.., last] => {
            let rest = &labels[..labels.len() - 1];
            format!("{}, and {}", rest.join(", "), last)
        }
        [] => String::new(),
    }
}

fn ordinal(value: u32) -> String {
    let remainder = value % 100;
    if (11..=13).contains(&remainder) {
        return format!("{value}th");
    }
    match value % 10 {
        1 => format!("{value}st"),
        2 => format!("{value}nd"),
        3 => format!("{value}rd"),
        _ => format!("{value}th"),
    }
}

fn timezone_suffix(timezone: &str) -> String {
    if timezone.is_empty() || timezone == system_timezone() {
        return String::new();
    }
    // Map the IANA name to a friendly label for well-known zones; anything
    // else renders bare to avoid leaking a long zone path.
    let label = match timezone {
        "America/New_York" => "Eastern Time",
        "America/Chicago" => "Central Time",
        "America/Denver" => "Mountain Time",
        "America/Los_Angeles" => "Pacific Time",
        "Europe/London" => "Greenwich Mean Time",
        "Europe/Paris" => "Central European Time",
        "Asia/Tokyo" => "Japan Standard Time",
        "Asia/Shanghai" => "China Standard Time",
        _ => return String::new(),
    };
    format!(" ({label})")
}

fn weekday_schedule_label(day_of_week: &str, at: &str) -> Option<String> {
    if day_of_week == "1-5" {
        return Some(format!("Weekdays at {at}"));
    }
    let mut days = Vec::new();
    for value in day_of_week.split(',') {
        let day = number_field(value.trim(), 0, 7)?;
        days.push(if day == 7 { 0 } else { day });
    }
    let mut labels: Vec<String> = Vec::new();
    for day in days {
        let label = weekday_label(day);
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    if labels.len() == 1 {
        return Some(format!("Every {} at {at}", labels[0]));
    }
    if labels.len() > 1 {
        return Some(format!("Every {} at {at}", conjunction_label(&labels)));
    }
    None
}

/// `formatSchedule` — the common schedules Aiden creates as confirmation copy;
/// anything unusual degrades to "Custom schedule".
pub fn format_schedule(cron: &str, timezone: &str) -> String {
    let fields: Vec<&str> = cron.split_whitespace().collect();
    let normalized: Vec<&str> = match fields.len() {
        5 => fields.clone(),
        6 if fields[0] == "0" => fields[1..].to_vec(),
        _ => return "Custom schedule".to_string(),
    };
    if normalized.len() != 5 {
        return "Custom schedule".to_string();
    }
    let minute_field = normalized[0];
    let hour_field = normalized[1];
    let day_of_month = normalized[2];
    let month = normalized[3];
    let day_of_week = normalized[4];

    let suffix = timezone_suffix(timezone);
    if day_of_month == "*" && month == "*" && day_of_week == "*" {
        if minute_field == "*" && hour_field == "*" {
            return format!("Every minute{suffix}");
        }
        if let Some(interval_raw) = minute_field.strip_prefix("*/") {
            if hour_field == "*" {
                if let Some(interval) = number_field(interval_raw, 2, 59) {
                    return format!("Every {interval} minutes{suffix}");
                }
            }
        }
        if minute_field == "0" && hour_field == "*" {
            return format!("Every hour{suffix}");
        }
    }

    let Some(minute) = number_field(minute_field, 0, 59) else {
        return "Custom schedule".to_string();
    };
    let Some(hour) = number_field(hour_field, 0, 23) else {
        return "Custom schedule".to_string();
    };
    if month != "*" {
        return "Custom schedule".to_string();
    }
    let at = clock_label(hour, minute);

    if day_of_month == "*" && day_of_week == "*" {
        return format!("Every day at {at}{suffix}");
    }
    if day_of_month == "*" {
        if let Some(schedule) = weekday_schedule_label(day_of_week, &at) {
            return format!("{schedule}{suffix}");
        }
        return "Custom schedule".to_string();
    }
    let Some(month_day) = number_field(day_of_month, 1, 31) else {
        return "Custom schedule".to_string();
    };
    if day_of_week == "*" {
        return format!("Monthly on the {} at {at}{suffix}", ordinal(month_day));
    }
    "Custom schedule".to_string()
}

// ===========================================================================
// Service dependencies
// ===========================================================================

/// Read-only task source. The orchestrator wires a store-backed adapter; the
/// in-memory demo lets the panel run standalone and drives the tests.
pub trait ScheduledTaskSource: Send + Sync {
    fn tasks(&self) -> Vec<ScheduledTask>;
}

/// Store-backed adapter over `aiden_data::schedule_store::ScheduleStore`.
pub struct StoreScheduledSource<T, U>
where
    T: aiden_data::schedule_store::Persistence<Vec<serde_json::Value>> + Send + Sync,
    U: aiden_data::schedule_store::Persistence<Vec<serde_json::Value>> + Send + Sync,
{
    store: Arc<aiden_data::schedule_store::ScheduleStore<T, U>>,
}

impl<T, U> StoreScheduledSource<T, U>
where
    T: aiden_data::schedule_store::Persistence<Vec<serde_json::Value>> + Send + Sync,
    U: aiden_data::schedule_store::Persistence<Vec<serde_json::Value>> + Send + Sync,
{
    pub fn new(store: Arc<aiden_data::schedule_store::ScheduleStore<T, U>>) -> Self {
        Self { store }
    }
}

impl<T, U> ScheduledTaskSource for StoreScheduledSource<T, U>
where
    T: aiden_data::schedule_store::Persistence<Vec<serde_json::Value>> + Send + Sync,
    U: aiden_data::schedule_store::Persistence<Vec<serde_json::Value>> + Send + Sync,
{
    fn tasks(&self) -> Vec<ScheduledTask> {
        self.store.list().unwrap_or_default()
    }
}

/// In-memory source with sample data.
#[allow(dead_code)] // standalone/demo scaffolding; the app uses `StoreScheduledSource`
#[derive(Debug, Default)]
pub struct MemoryScheduledSource {
    pub tasks: std::sync::Mutex<Vec<ScheduledTask>>,
}

impl ScheduledTaskSource for MemoryScheduledSource {
    fn tasks(&self) -> Vec<ScheduledTask> {
        let guard = self.tasks.lock();
        guard.map(|tasks| tasks.clone()).unwrap_or_default()
    }
}

#[allow(dead_code)] // standalone/demo scaffolding
fn sample_task(
    id: &str,
    name: &str,
    cron: &str,
    enabled: bool,
    last_result: Option<ScheduledRunResult>,
) -> ScheduledTask {
    ScheduledTask {
        id: id.to_string(),
        name: name.to_string(),
        enabled,
        mode: ScheduledTaskMode::Llm,
        cron: cron.to_string(),
        timezone: "America/New_York".to_string(),
        next_run_at: Some(1_800_000_000_000),
        last_run_at: Some(1_790_000_000_000),
        workspace_id: None,
        provider_id: None,
        model: None,
        provider_fingerprint: None,
        prompt: Some("Summarize unread changes.".to_string()),
        script: None,
        permission: aiden_data::schedule_store::ScheduledTaskPermission::ReadOnly,
        mcp_server_ids: None,
        mcp_server_bindings: None,
        execution_profile: None,
        chat_id: None,
        notify: true,
        last_result,
        last_error: None,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
    }
}

impl MemoryScheduledSource {
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn sample() -> Self {
        Self {
            tasks: std::sync::Mutex::new(vec![
                sample_task("task-1", "Daily brief", "0 9 * * 1-5", true, None),
                sample_task(
                    "task-2",
                    "Weekly review",
                    "0 8 * * 1",
                    false,
                    Some(ScheduledRunResult::Success),
                ),
                sample_task(
                    "task-3",
                    "Log watcher",
                    "*/15 * * * *",
                    true,
                    Some(ScheduledRunResult::Blocked),
                ),
            ]),
        }
    }
}

// ===========================================================================
// The panel entity
// ===========================================================================

pub struct ScheduledPanel {
    pub(crate) source: Arc<dyn ScheduledTaskSource>,
    pub(crate) tasks: Vec<ScheduledTask>,
    pub(crate) query: String,
    pub(crate) tab: TaskTab,
    pub(crate) now: u64,
    pub(crate) loaded: bool,
    filter_input: Option<gpui::Entity<gpui_component::input::InputState>>,
    _subscriptions: Vec<gpui::Subscription>,
    _tick: Option<gpui::Task<()>>,
}

/// Dependencies for [`ScheduledPanel::new`].
pub struct ScheduledPanelDeps {
    pub source: Arc<dyn ScheduledTaskSource>,
}

impl ScheduledPanelDeps {
    pub fn new(source: Arc<dyn ScheduledTaskSource>) -> Self {
        Self { source }
    }

    /// Demo wiring for standalone use and tests.
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn demo() -> Self {
        Self::new(Arc::new(MemoryScheduledSource::sample()))
    }
}

impl ScheduledPanel {
    pub fn new(cx: &mut Context<Self>, deps: ScheduledPanelDeps) -> Self {
        let now = aiden_data::now_millis();
        let mut this = Self {
            source: deps.source,
            tasks: Vec::new(),
            query: String::new(),
            tab: TaskTab::All,
            now,
            loaded: false,
            filter_input: None,
            _subscriptions: Vec::new(),
            _tick: None,
        };
        this.refresh(cx);
        this.start_ticking(cx);
        this
    }

    /// Lazily create the filter `InputState` on first render (the panel's
    /// `new` has no window yet); subscription is deferred to the next update.
    fn filter_input_state(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Entity<gpui_component::input::InputState> {
        if let Some(state) = &self.filter_input {
            return state.clone();
        }
        let state = cx.new(|cx| {
            gpui_component::input::InputState::new(window, cx).placeholder("Filter tasks…")
        });
        let state_entity = state.clone();
        cx.defer_in(window, move |this, window, cx| {
            this._subscriptions.push(cx.subscribe_in(
                &state_entity,
                window,
                |this, _source, event, _window, cx| {
                    if matches!(event, gpui_component::input::InputEvent::Change) {
                        let query = this
                            .filter_input
                            .as_ref()
                            .map(|state| state.read(cx).value().to_string())
                            .unwrap_or_default();
                        this.set_query(&query, cx);
                    }
                },
            ));
        });
        self.filter_input = Some(state.clone());
        state
    }

    /// Load the task list from the source on the background executor.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let tasks = cx.background_spawn(async move { source.tasks() }).await;
            this.update(cx, |this, cx| {
                this.tasks = tasks;
                this.loaded = true;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Keep the relative countdowns fresh while the panel is mounted.
    fn start_ticking(&mut self, cx: &mut Context<Self>) {
        let tick = cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(1))
                .await;
            this.update(cx, |this, cx| {
                this.now = aiden_data::now_millis();
                cx.notify();
            })
            .ok();
        });
        self._tick = Some(tick);
    }

    pub fn set_query(&mut self, query: &str, cx: &mut Context<Self>) {
        self.query = query.to_string();
        cx.notify();
    }

    pub fn set_tab(&mut self, tab: TaskTab, cx: &mut Context<Self>) {
        self.tab = tab;
        cx.notify();
    }

    /// The filtered rows for the current tab + query.
    pub fn visible_tasks(&self) -> Vec<ScheduledTask> {
        filter_scheduled_tasks(&self.tasks, &self.query, self.tab)
    }

    pub fn toggle_enabled(&mut self, id: &str, enabled: bool, cx: &mut Context<Self>) {
        cx.emit(ScheduledPanelEvent::ToggleEnabled {
            id: id.to_string(),
            enabled,
        });
    }

    pub fn run_now(&mut self, id: &str, cx: &mut Context<Self>) {
        cx.emit(ScheduledPanelEvent::RunNow { id: id.to_string() });
    }

    fn task_row(&self, task: &ScheduledTask, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let cadence = format_schedule(&task.cron, &task.timezone);
        let last_run = task
            .last_run_at
            .map(|timestamp| {
                format!(
                    "Last run {}",
                    crate::services::chat_service::relative_time(timestamp, self.now)
                )
            })
            .unwrap_or_else(|| "Never run".to_string());

        let status_icon = IconName::CircleX;
        let status_color = theme.muted_foreground;

        let id = task.id.clone();
        let toggle_id = id.clone();
        let run_now_id = id.clone();
        h_flex()
            .id(ElementId::Name(SharedString::from(format!(
                "scheduled-task-{id}"
            ))))
            .w_full()
            .px_3()
            .py_2()
            .gap_2()
            .items_center()
            .rounded_md()
            .bg(theme.popover)
            .border_1()
            .border_color(theme.border)
            .child(Icon::new(status_icon).xsmall().text_color(status_color))
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(0.))
                    .gap_0p5()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .truncate()
                            .child(task.name.clone()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(format!("Dormant · {cadence} · execution unsupported")),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(last_run),
                    ),
            )
            .child(
                gpui_component::switch::Switch::new(ElementId::Name(SharedString::from(format!(
                    "scheduled-enabled-{id}"
                ))))
                .checked(false)
                .disabled(true)
                .tooltip("Scheduled execution is unsupported")
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    let target = this
                        .tasks
                        .iter()
                        .find(|candidate| candidate.id == toggle_id)
                        .map(|candidate| !candidate.enabled)
                        .unwrap_or(false);
                    this.toggle_enabled(&toggle_id, target, cx);
                })),
            )
            .child(
                Button::new(ElementId::Name(SharedString::from(format!(
                    "scheduled-run-now-{id}"
                ))))
                .small()
                .ghost()
                .icon(IconName::SquareTerminal)
                .disabled(true)
                .tooltip("Run now is unavailable until scheduled execution is configured")
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    this.run_now(&run_now_id, cx);
                })),
            )
    }
}

impl gpui::EventEmitter<ScheduledPanelEvent> for ScheduledPanel {}

impl Render for ScheduledPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let tasks = self.visible_tasks();
        let filter_input = self.filter_input_state(window, cx);

        v_flex()
            .id("scheduled-panel")
            .size_full()
            .bg(theme.background)
            .child(
                h_flex()
                    .id("scheduled-header")
                    .w_full()
                    .px_3()
                    .py_2()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .text_base()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Scheduled tasks"),
                    )
                    .child(div().flex_1())
                    .children(
                        [TaskTab::All, TaskTab::Active, TaskTab::Paused]
                            .into_iter()
                            .map(|tab| {
                                let active = self.tab == tab;
                                let mut button = Button::new(match tab {
                                    TaskTab::All => "tab-all",
                                    TaskTab::Active => "tab-active",
                                    TaskTab::Paused => "tab-paused",
                                })
                                .small()
                                .label(tab.label());
                                if active {
                                    button = button.primary();
                                }
                                button.on_click(cx.listener(move |this, _event, _window, cx| {
                                    this.set_tab(tab, cx);
                                }))
                            })
                            .map(gpui::IntoElement::into_any_element)
                            .collect::<Vec<_>>(),
                    )
                    .child(
                        Button::new("scheduled-refresh")
                            .small()
                            .ghost()
                            .icon(IconName::LoaderCircle)
                            .tooltip("Reload tasks")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                cx.emit(ScheduledPanelEvent::Refresh);
                                this.refresh(cx);
                            })),
                    ),
            )
            .child(
                div().w_full().px_3().pb_2().child(
                    gpui_component::input::Input::new(&filter_input)
                        .small()
                        .appearance(false),
                ),
            )
            .child(
                div()
                    .id("scheduled-list")
                    .flex_1()
                    .w_full()
                    .overflow_y_scroll()
                    .px_2()
                    .py_1()
                    .gap_1()
                    .when(tasks.is_empty() && self.loaded, |el| {
                        el.child(
                            div()
                                .w_full()
                                .py_3()
                                .items_center()
                                .justify_center()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("No scheduled tasks match."),
                        )
                    })
                    .children(
                        tasks
                            .iter()
                            .map(|task| self.task_row(task, cx).into_any_element()),
                    ),
            )
    }
}

// ===========================================================================
// Tests (port of renderer/lib/scheduled-task-view.test.ts)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn task(
        id: &str,
        name: &str,
        enabled: bool,
        mode: ScheduledTaskMode,
        prompt: Option<&str>,
        script: Option<&str>,
        last_result: Option<ScheduledRunResult>,
    ) -> ScheduledTask {
        let mut task = sample_task(id, name, "0 9 * * 1-5", enabled, last_result);
        task.mode = mode;
        task.prompt = prompt.map(str::to_string);
        task.script = script.map(str::to_string);
        task.timezone = "UTC".to_string();
        task
    }

    #[test]
    fn scheduled_task_filtering_combines_tab_and_text_matches() {
        let tasks = vec![
            task(
                "active",
                "Daily brief",
                true,
                ScheduledTaskMode::Llm,
                Some("Summarize"),
                None,
                None,
            ),
            task(
                "paused",
                "Weekly review",
                false,
                ScheduledTaskMode::Llm,
                Some("Review"),
                None,
                None,
            ),
            task(
                "script",
                "Log watcher",
                true,
                ScheduledTaskMode::Script,
                None,
                Some("watch.sh"),
                None,
            ),
        ];
        let active = filter_scheduled_tasks(&tasks, "", TaskTab::Active);
        assert_eq!(
            active.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["active", "script"]
        );
        let weekly = filter_scheduled_tasks(&tasks, "weekly", TaskTab::All);
        assert_eq!(
            weekly.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["paused"]
        );
        let script = filter_scheduled_tasks(&tasks, "watch.sh", TaskTab::All);
        assert_eq!(
            script.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["script"]
        );
    }

    #[test]
    fn common_cron_schedules_are_presented_as_human_readable_cadence() {
        // Use the local timezone so no suffix is appended, matching the
        // renderer test's `localTimezone`.
        let timezone = system_timezone();
        assert_eq!(
            format_schedule("0 9 * * *", &timezone),
            "Every day at 9:00 AM"
        );
        assert_eq!(
            format_schedule("0 8 * * 1-5", &timezone),
            "Weekdays at 8:00 AM"
        );
        assert_eq!(
            format_schedule("0 16 * * 5", &timezone),
            "Every Friday at 4:00 PM"
        );
        assert_eq!(
            format_schedule("0 9 * * 1,3,5", &timezone),
            "Every Monday, Wednesday, and Friday at 9:00 AM"
        );
        assert_eq!(
            format_schedule("*/15 * * * *", &timezone),
            "Every 15 minutes"
        );
        assert_eq!(
            format_schedule("0 9 1 * *", &timezone),
            "Monthly on the 1st at 9:00 AM"
        );
        assert_eq!(format_schedule("5 0 9 * * *", &timezone), "Custom schedule");
        assert_eq!(format_schedule("garbage", &timezone), "Custom schedule");
    }
}
