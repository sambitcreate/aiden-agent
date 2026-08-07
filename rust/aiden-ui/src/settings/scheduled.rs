//! Scheduled tasks settings (port of `scheduled-tasks-settings.tsx`, reduced).
//!
//! Lists the persisted schedules from `aiden-data::ScheduleStore` (name, cron,
//! humanized summary, next run, enabled toggle, delete) and a new-task form
//! (prompt text + cron expression validated live through the ported cron
//! evaluator, with a workspace picker). Full task management (settings,
//! notifications, run history) is out of scope for this pass.

use aiden_data::schedule_store::{
    next_scheduled_run, system_timezone, ScheduledTask, ScheduledTaskInput, ScheduledTaskMode,
    ScheduledTaskPermission,
};
use chrono::{DateTime, Utc};
use gpui::{
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _,
};

use super::{SettingsServices, SettingsView};

/// A schedule row, owned for rendering.
#[derive(Debug, Clone)]
pub struct ScheduleRow {
    pub id: String,
    pub name: String,
    pub cron: String,
    pub enabled: bool,
    pub next_run_at: Option<u64>,
    pub last_result: Option<String>,
    pub last_error: Option<String>,
}

impl From<&ScheduledTask> for ScheduleRow {
    fn from(task: &ScheduledTask) -> Self {
        Self {
            id: task.id.clone(),
            name: task.name.clone(),
            cron: task.cron.clone(),
            enabled: task.enabled,
            next_run_at: task.next_run_at,
            last_result: task
                .last_result
                .map(|result| format!("{result:?}").to_lowercase()),
            last_error: task.last_error.clone(),
        }
    }
}

/// New-task form draft (input entities created when the form opens).
pub struct ScheduledDraft {
    pub name: Entity<InputState>,
    pub prompt: Entity<InputState>,
    pub cron: Entity<InputState>,
    pub workspace_id: String,
    pub saving: bool,
}

#[derive(Default)]
pub struct ScheduledState {
    pub schedules: Vec<ScheduleRow>,
    /// (id, name) workspace choices from the local config.
    pub workspaces: Vec<(String, String)>,
    pub adding: Option<ScheduledDraft>,
    pub removing: Option<String>,
    /// Live cron feedback: error message or next-run preview.
    pub cron_feedback: Option<String>,
    pub cron_ok: bool,
    pub error: Option<String>,
    _subscriptions: Vec<gpui::Subscription>,
}

/// Humanize a cron expression into a short summary. Best-effort: unknown
/// shapes fall back to the raw expression. Mirrors the renderer's cronstrue
/// intent for the common shapes without pulling in a full engine.
pub fn humanize_cron(cron: &str) -> String {
    let trimmed = cron.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "@yearly" | "@annually" => return "Every year".to_string(),
        "@monthly" => return "Every month".to_string(),
        "@weekly" => return "Every week".to_string(),
        "@daily" | "@midnight" => return "Every day".to_string(),
        "@hourly" => return "Every hour".to_string(),
        _ => {}
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    // Support both 5-part and 6-part expressions (drop the seconds field).
    let fields = if fields.len() == 6 {
        &fields[1..]
    } else {
        &fields[..]
    };
    if fields.len() != 5 {
        return trimmed.to_string();
    }
    let [minute, hour, dom, month, dow] = [fields[0], fields[1], fields[2], fields[3], fields[4]];
    let hour = match hour {
        "*" => None,
        other => other.parse::<u8>().ok(),
    };
    let minutes = match minute {
        "0" => "at the top of the hour".to_string(),
        "*" => "every minute".to_string(),
        other => format!("at minute {other}"),
    };
    let time_label = match hour {
        Some(0) => "midnight".to_string(),
        Some(12) => "noon".to_string(),
        Some(hour) if hour < 12 => {
            format!("{hour}:{:0>2} AM", minute.parse::<u8>().unwrap_or(0) % 60)
        }
        Some(hour) => format!(
            "{}:{:0>2} PM",
            hour - 12,
            minute.parse::<u8>().unwrap_or(0) % 60
        ),
        None => minutes.clone(),
    };
    let every = format!("Every day at {time_label}");
    let scope = if dom == "*" && dow == "*" {
        every
    } else if dom == "*" && dow != "*" {
        let day = match dow {
            "0" | "7" => "Sunday",
            "1" => "Monday",
            "2" => "Tuesday",
            "3" => "Wednesday",
            "4" => "Thursday",
            "5" => "Friday",
            "6" => "Saturday",
            "mon-fri" | "1-5" => "Weekdays",
            "sat-sun" | "0-6" => "Weekends",
            other => other,
        };
        format!("Every {day} at {time_label}")
    } else if dom != "*" && dow == "*" {
        let day = match dom {
            "1" => "1st".to_string(),
            "2" => "2nd".to_string(),
            "3" => "3rd".to_string(),
            other => format!("{other}th"),
        };
        format!("Every month on the {day} at {time_label}")
    } else {
        every
    };
    if month != "*" {
        return format!("{scope} (in the month of {month})");
    }
    scope
}

/// Validate a cron expression and produce either an error or the next-run
/// preview label.
pub fn cron_feedback(cron: &str) -> Result<String, String> {
    let trimmed = cron.trim();
    if trimmed.is_empty() {
        return Err("A cron schedule is required.".to_string());
    }
    let timezone = system_timezone();
    match next_scheduled_run(trimmed, &timezone, aiden_data::now_millis()) {
        Ok(next) => {
            let when = DateTime::<Utc>::from_timestamp_millis(next as i64)
                .map(|date| date.format("%a %b %d %H:%M").to_string())
                .unwrap_or_else(|| "soon".to_string());
            Ok(format!("Next run: {when}"))
        }
        Err(error) => Err(error.to_string()),
    }
}

impl SettingsView {
    /// The Scheduled tasks section.
    pub(crate) fn scheduled_section(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let state = &self.scheduled;

        v_flex()
            .id("scheduled-section")
            .w_full()
            .gap_4()
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .justify_between()
                    .gap_4()
                    .child(
                        v_flex()
                            .flex_1()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Scheduled tasks"),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme.muted_foreground)
                                    .mt_0p5()
                                    .child(
                                    "Automate recurring Ask Aiden prompts. Pausing a task keeps \
                                         its schedule.",
                                ),
                            ),
                    )
                    .child(
                        Button::new("add-schedule")
                            .small()
                            .icon(IconName::Plus)
                            .label("New task")
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.scheduled.open_draft(window, cx);
                            })),
                    ),
            )
            .when_some(state.error.clone(), |el, message| {
                el.child(
                    div()
                        .w_full()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.danger.opacity(0.12))
                        .text_sm()
                        .text_color(theme.danger)
                        .child(message),
                )
            })
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Current tasks"),
                    )
                    .child(self.schedule_card(cx)),
            )
            .when_some(state.adding.as_ref(), |el, draft| {
                el.child(self.schedule_editor(draft, cx))
            })
            .when_some(state.removing.clone(), |el, removing| {
                el.child(self.schedule_remove_confirm(&removing, cx))
            })
    }

    /// The schedule list card (empty state or rows).
    fn schedule_card(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let border = theme.border;
        let muted_foreground = theme.muted_foreground;
        let rows = self.scheduled.schedules.clone();
        if rows.is_empty() {
            return h_flex()
                .w_full()
                .gap_2()
                .items_center()
                .px_3()
                .py_3()
                .rounded_lg()
                .border_1()
                .border_color(border)
                .child(
                    Icon::new(IconName::Calendar)
                        .small()
                        .text_color(muted_foreground),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(muted_foreground)
                        .child("No scheduled tasks yet."),
                )
                .into_any_element();
        }
        v_flex()
            .w_full()
            .rounded_lg()
            .border_1()
            .border_color(border)
            .children(rows.iter().enumerate().map(|(index, row)| {
                let row = row.clone();
                div()
                    .w_full()
                    .when(index > 0, |el| el.border_t_1().border_color(border))
                    .child(self.schedule_row(&row, cx))
            }))
            .into_any_element()
    }

    fn schedule_row(&self, row: &ScheduleRow, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let id = row.id.clone();
        let name = row.name.clone();
        let dot_color = if !row.enabled {
            theme.muted_foreground
        } else if row.last_result.as_deref() == Some("error") {
            theme.danger
        } else {
            theme.success
        };
        h_flex()
            .id(ElementId::Name(SharedString::from(format!(
                "schedule-row-{id}"
            ))))
            .w_full()
            .px_3()
            .py_2p5()
            .gap_3()
            .items_center()
            .child(div().size(px(8.)).rounded_full().bg(dot_color))
            .child(
                v_flex()
                    .flex_1()
                    .min_w(gpui::px(0.))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .truncate()
                            .child(name),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .truncate()
                            .child(if row.enabled {
                                format!(
                                    "{} · {}",
                                    humanize_cron(&row.cron),
                                    next_run_label(row.next_run_at)
                                )
                            } else {
                                "Paused".to_string()
                            }),
                    )
                    .when_some(row.last_error.clone(), |el, error| {
                        el.child(
                            div()
                                .text_xs()
                                .text_color(theme.danger)
                                .mt_0p5()
                                .child(error),
                        )
                    }),
            )
            .child({
                let click_id = id.clone();
                Switch::new(ElementId::Name(SharedString::from(format!(
                    "schedule-enabled-{id}"
                ))))
                .checked(row.enabled)
                .label(if row.enabled { "Enabled" } else { "Disabled" })
                .on_click(cx.listener(move |this, checked, _window, cx| {
                    this.scheduled.toggle_enabled(&click_id, *checked, cx);
                }))
            })
            .child({
                let click_id = id.clone();
                Button::new(ElementId::Name(SharedString::from(format!(
                    "schedule-remove-{id}"
                ))))
                .small()
                .ghost()
                .icon(IconName::Delete)
                .tooltip("Delete task")
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    this.scheduled.removing = Some(click_id.clone());
                    cx.notify();
                }))
            })
    }

    /// The new-task form.
    fn schedule_editor(&self, draft: &ScheduledDraft, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let name_value = draft.name.read(cx).value().to_string();
        let prompt_value = draft.prompt.read(cx).value().to_string();
        let can_save = !name_value.trim().is_empty()
            && !prompt_value.trim().is_empty()
            && self.scheduled.cron_ok;

        v_flex()
            .id("schedule-editor")
            .w_full()
            .gap_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
            .px_4()
            .py_3()
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("New scheduled task"),
                    )
                    .child(
                        Button::new("close-schedule-editor")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .tooltip("Close")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.scheduled.adding = None;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child("Name"),
                    )
                    .child(Input::new(&draft.name).small()),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child("Prompt"),
                    )
                    .child(Input::new(&draft.prompt).small()),
            )
            .child(
                h_flex()
                    .w_full()
                    .gap_3()
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("Cron expression"),
                            )
                            .child(Input::new(&draft.cron).small())
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(if self.scheduled.cron_ok {
                                        theme.success
                                    } else {
                                        theme.danger
                                    })
                                    .child(self.scheduled.cron_feedback.clone().unwrap_or_else(
                                        || "Enter a 5- or 6-part cron expression.".to_string(),
                                    )),
                            ),
                    )
                    .child(
                        v_flex()
                            .w(px(220.))
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("Workspace"),
                            )
                            .child(self.workspace_select(draft, cx)),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .justify_end()
                    .gap_2()
                    .child(
                        Button::new("cancel-schedule-edit")
                            .small()
                            .ghost()
                            .label("Cancel")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.scheduled.adding = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("save-schedule")
                            .small()
                            .primary()
                            .label(if draft.saving { "Saving…" } else { "Save" })
                            .disabled(!can_save || draft.saving)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.scheduled.save_draft(cx);
                            })),
                    ),
            )
    }

    /// A simple workspace button row (radio-like) since the select state would
    /// need another window-created entity.
    fn workspace_select(&self, draft: &ScheduledDraft, cx: &mut Context<Self>) -> impl IntoElement {
        let workspaces = self.scheduled.workspaces.clone();
        let selected = draft.workspace_id.clone();
        h_flex()
            .w_full()
            .gap_1()
            .children(workspaces.iter().map(|(id, name)| {
                let active = selected == *id;
                let id = id.clone();
                let name = name.clone();
                let mut button =
                    Button::new(SharedString::from(format!("schedule-workspace-{id}")))
                        .ghost()
                        .xsmall()
                        .label(name);
                if active {
                    button = button.primary();
                }
                button.on_click(cx.listener(move |this, _event, _window, cx| {
                    if let Some(draft) = this.scheduled.adding.as_mut() {
                        draft.workspace_id = id.clone();
                        cx.notify();
                    }
                }))
            }))
    }

    /// Inline delete-confirmation card.
    fn schedule_remove_confirm(&self, removing: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let removing = removing.to_string();
        let label = self
            .scheduled
            .schedules
            .iter()
            .find(|row| row.id == removing)
            .map(|row| row.name.clone())
            .unwrap_or_else(|| "this task".to_string());
        h_flex()
            .id("schedule-remove-confirm")
            .w_full()
            .gap_3()
            .items_center()
            .px_4()
            .py_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.danger.opacity(0.5))
            .child(div().flex_1().text_sm().child(format!(
                "Delete “{label}” and its run history? This cannot be undone."
            )))
            .child(
                Button::new("cancel-schedule-remove")
                    .small()
                    .ghost()
                    .label("Cancel")
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.scheduled.removing = None;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("confirm-schedule-remove")
                    .small()
                    .danger()
                    .label("Delete")
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.scheduled.confirm_remove(&removing, cx);
                    })),
            )
    }
}

impl ScheduledState {
    /// Open the new-task form with a live-validating cron field.
    fn open_draft(&mut self, window: &mut Window, cx: &mut Context<SettingsView>) {
        let make_input =
            |cx: &mut Context<SettingsView>, window: &mut Window, placeholder: &str| {
                let placeholder = placeholder.to_string();
                cx.new(move |cx| InputState::new(window, cx).placeholder(placeholder))
            };
        let name = make_input(cx, window, "Morning digest");
        let prompt = make_input(cx, window, "Summarize my open PRs");
        let cron = make_input(cx, window, "0 9 * * 1-5");
        let cron_entity = cron.clone();
        let subscription =
            cx.subscribe_in(&cron, window, move |this, _source, event, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    let value = cron_entity.read(cx).value().to_string();
                    match cron_feedback(&value) {
                        Ok(feedback) => {
                            this.scheduled.cron_feedback = Some(feedback);
                            this.scheduled.cron_ok = true;
                        }
                        Err(message) => {
                            this.scheduled.cron_feedback = Some(message);
                            this.scheduled.cron_ok = false;
                        }
                    }
                    cx.notify();
                }
            });
        self._subscriptions.push(subscription);
        for input in [name.clone(), prompt.clone()] {
            let subscription =
                cx.subscribe_in(&input, window, |_this, _source, event, _window, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                });
            self._subscriptions.push(subscription);
        }
        let default_workspace = self
            .workspaces
            .first()
            .map(|(id, _)| id.clone())
            .unwrap_or_default();
        self.adding = Some(ScheduledDraft {
            name,
            prompt,
            cron,
            workspace_id: default_workspace,
            saving: false,
        });
        self.cron_feedback = None;
        self.cron_ok = false;
        cx.notify();
    }

    fn services(&self, cx: &mut Context<SettingsView>) -> SettingsServices {
        cx.entity().read(cx).services.clone()
    }

    /// Persist the new-task form as an LLM scheduled task.
    fn save_draft(&mut self, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.adding.as_mut() else {
            return;
        };
        if draft.saving {
            return;
        }
        let name = draft.name.read(cx).value().to_string();
        let prompt = draft.prompt.read(cx).value().to_string();
        let cron = draft.cron.read(cx).value().to_string();
        let workspace_id = if draft.workspace_id.is_empty() {
            None
        } else {
            Some(draft.workspace_id.clone())
        };
        draft.saving = true;
        let services = self.services(cx);
        let input = ScheduledTaskInput {
            id: None,
            name: name.trim().to_string(),
            mode: ScheduledTaskMode::Llm,
            cron: cron.trim().to_string(),
            timezone: Some(system_timezone()),
            workspace_id,
            provider_id: None,
            model: None,
            provider_fingerprint: None,
            prompt: Some(prompt),
            script: None,
            permission: Some(ScheduledTaskPermission::ReadOnly),
            mcp_server_ids: None,
            mcp_server_bindings: None,
            execution_profile: None,
            notify: Some(true),
            enabled: Some(true),
        };
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { services.schedules.save(&input) })
                .await;
            this.update(cx, |this, cx| {
                this.scheduled.adding = None;
                match result {
                    Ok(_) => {
                        this.scheduled.error = None;
                        this.reload_schedules(cx);
                    }
                    Err(error) => {
                        this.scheduled.error =
                            Some(format!("The task could not be saved: {error}"));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Flip the enabled state of a schedule.
    fn toggle_enabled(&mut self, id: &str, enabled: bool, cx: &mut Context<SettingsView>) {
        let services = self.services(cx);
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { services.schedules.set_enabled(&id, enabled) })
                .await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(_) => this.scheduled.error = None,
                    Err(error) => {
                        this.scheduled.error =
                            Some(format!("The schedule could not be updated: {error}"))
                    }
                }
                this.reload_schedules(cx);
            })
            .ok();
        })
        .detach();
    }

    /// Delete a schedule.
    fn confirm_remove(&mut self, id: &str, cx: &mut Context<SettingsView>) {
        let services = self.services(cx);
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { services.schedules.remove(&id) })
                .await;
            this.update(cx, |this, cx| {
                this.scheduled.removing = None;
                match result {
                    Ok(_) => this.scheduled.error = None,
                    Err(error) => {
                        this.scheduled.error =
                            Some(format!("The task could not be removed: {error}"))
                    }
                }
                this.reload_schedules(cx);
            })
            .ok();
        })
        .detach();
    }
}

impl SettingsView {
    /// Reload the schedule list from the store (background) — used after
    /// mutations and shared with `boot`.
    pub(crate) fn reload_schedules(&mut self, cx: &mut Context<Self>) {
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let rows = cx
                .background_spawn(async move {
                    services
                        .schedules
                        .list()
                        .map(|list| list.iter().map(ScheduleRow::from).collect::<Vec<_>>())
                        .unwrap_or_default()
                })
                .await;
            this.update(cx, |this, cx| {
                this.scheduled.schedules = rows;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

/// Format a millisecond timestamp as a short local label.
fn next_run_label(next_run_at: Option<u64>) -> String {
    match next_run_at {
        Some(next) => DateTime::<Utc>::from_timestamp_millis(next as i64)
            .map(|date| date.format("%a %b %d %H:%M").to_string())
            .unwrap_or_else(|| "no future run".to_string()),
        None => "no future run".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanizes_common_cron_shapes() {
        assert!(humanize_cron("0 9 * * *").contains("9:00 AM"));
        assert!(humanize_cron("@daily").contains("Every day"));
        assert!(humanize_cron("@hourly").contains("Every hour"));
        assert!(humanize_cron("0 9 * * 1-5").contains("Weekdays"));
        assert!(humanize_cron("0 9 * * 0").contains("Sunday"));
        assert!(humanize_cron("0 9 1 * *").contains("1st"));
        // Unknown shapes fall back to the raw expression.
        assert_eq!(humanize_cron("weird"), "weird");
    }

    #[test]
    fn cron_feedback_validates_and_previews() {
        assert!(cron_feedback("").is_err());
        assert!(cron_feedback("not a cron").is_err());
        let ok = cron_feedback("0 9 * * 1-5").unwrap();
        assert!(ok.starts_with("Next run: "));
        let with_seconds = cron_feedback("30 9 * * *").unwrap();
        assert!(with_seconds.starts_with("Next run: "));
    }

    #[test]
    fn rows_mark_failed_last_results() {
        let task = ScheduledTask {
            id: "t1".into(),
            name: "Digest".into(),
            enabled: true,
            mode: ScheduledTaskMode::Llm,
            cron: "0 9 * * *".into(),
            timezone: "UTC".into(),
            next_run_at: Some(1_800_000_000_000),
            last_run_at: None,
            workspace_id: None,
            provider_id: None,
            model: None,
            provider_fingerprint: None,
            prompt: Some("hi".into()),
            script: None,
            permission: ScheduledTaskPermission::ReadOnly,
            mcp_server_ids: None,
            mcp_server_bindings: None,
            execution_profile: None,
            chat_id: None,
            notify: true,
            last_result: Some(aiden_data::schedule_store::ScheduledRunResult::Error),
            last_error: Some("boom".into()),
            created_at: 1,
            updated_at: 2,
        };
        let row = ScheduleRow::from(&task);
        assert_eq!(row.last_result.as_deref(), Some("error"));
        assert_eq!(row.last_error.as_deref(), Some("boom"));
        assert!(row.enabled);
    }
}
