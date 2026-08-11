//! Scheduled tasks settings (port of `scheduled-tasks-settings.tsx`, reduced).
//!
//! Lists the persisted schedules from `aiden-data::ScheduleStore` (name, cron,
//! humanized summary, next run, enabled toggle, delete) and a new-task form
//! (prompt text + cron expression validated live through the ported cron
//! evaluator, with a workspace picker). Full task management (settings,
//! persisted run history, and explicit execution controls.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use aiden_data::schedule_store::{
    next_scheduled_run, system_timezone, validate_timezone, ScheduledTask, ScheduledTaskInput,
    ScheduledTaskMode, ScheduledTaskPermission,
};
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

const DEFAULT_SCHEDULED_MODE: ScheduledTaskMode = ScheduledTaskMode::Llm;
const DEFAULT_SCHEDULED_PERMISSION: ScheduledTaskPermission = ScheduledTaskPermission::ReadOnly;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledDefaults {
    pub default_mode: ScheduledTaskMode,
    pub default_permission: ScheduledTaskPermission,
    pub default_mcp_enabled: bool,
    pub default_notify: bool,
    pub default_timezone: String,
}

/// Resolve the persisted defaults with the same fail-closed projection as the
/// Electron settings handler. Invalid enum or timezone data is an explicit
/// loading error rather than silently replacing a user's value.
pub fn scheduled_defaults_from_settings(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> Result<ScheduledDefaults, String> {
    let default_mode = match settings
        .get("scheduledDefaultMode")
        .and_then(serde_json::Value::as_str)
    {
        None | Some("llm") => DEFAULT_SCHEDULED_MODE,
        Some("script") => ScheduledTaskMode::Script,
        Some(other) => return Err(format!("Unknown scheduled task mode: {other}")),
    };
    let default_permission = match settings
        .get("scheduledDefaultPermission")
        .and_then(serde_json::Value::as_str)
    {
        None | Some("read-only") => DEFAULT_SCHEDULED_PERMISSION,
        Some("full") => ScheduledTaskPermission::Full,
        Some(other) => return Err(format!("Unknown scheduled task permission: {other}")),
    };
    let default_mcp_enabled = match settings.get("scheduledDefaultMcpEnabled") {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "Scheduled MCP default is invalid.".to_string())?,
    };
    let default_notify = match settings.get("scheduledDefaultNotify") {
        None => true,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "Scheduled notification default is invalid.".to_string())?,
    };
    let timezone_value = settings
        .get("scheduledDefaultTimezone")
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "Scheduled timezone default is invalid.".to_string())
        })
        .transpose()?
        .unwrap_or_else(system_timezone);
    let default_timezone = validate_timezone(&timezone_value).map_err(|error| error.to_string())?;
    Ok(ScheduledDefaults {
        default_mode,
        default_permission,
        default_mcp_enabled,
        default_notify,
        default_timezone,
    })
}

/// A schedule row, owned for rendering.
#[derive(Debug, Clone)]
pub struct ScheduleRow {
    pub id: String,
    pub name: String,
    pub cron: String,
    pub last_error: Option<String>,
    pub enabled: bool,
    pub mode: ScheduledTaskMode,
    pub next_run_at: Option<u64>,
    pub last_result: Option<aiden_data::schedule_store::ScheduledRunResult>,
    pub task: ScheduledTask,
}

impl From<&ScheduledTask> for ScheduleRow {
    fn from(task: &ScheduledTask) -> Self {
        Self {
            id: task.id.clone(),
            name: task.name.clone(),
            cron: task.cron.clone(),
            last_error: task.last_error.clone(),
            enabled: task.enabled,
            mode: task.mode,
            next_run_at: task.next_run_at,
            last_result: task.last_result,
            task: task.clone(),
        }
    }
}

/// New-task form draft (input entities created when the form opens).
pub struct ScheduledDraft {
    pub id: Option<String>,
    pub expected_updated_at: Option<u64>,
    pub name: Entity<InputState>,
    pub prompt: Entity<InputState>,
    pub script: Entity<InputState>,
    pub cron: Entity<InputState>,
    pub workspace_id: String,
    pub provider_id: String,
    pub model: String,
    pub mode: ScheduledTaskMode,
    pub permission: ScheduledTaskPermission,
    pub notify: bool,
    pub mcp_server_ids: Vec<String>,
    pub saving: bool,
}

pub struct ScheduledState {
    pub schedules: Vec<ScheduleRow>,
    /// (id, name) workspace choices from the local config.
    pub workspaces: Vec<(String, String)>,
    pub providers: Vec<(String, String, Vec<String>)>,
    pub mcp_servers: Vec<aiden_data::portable_config::McpServer>,
    pub adding: Option<ScheduledDraft>,
    pub removing: Option<String>,
    /// Live cron feedback: error message or next-run preview.
    pub cron_feedback: Option<String>,
    pub cron_ok: bool,
    pub error: Option<String>,
    pub global_enabled: bool,
    pub executor_ready: bool,
    pub global_saving: bool,
    pub defaults: ScheduledDefaults,
    pub defaults_loading: bool,
    pub defaults_error: Option<String>,
    pub defaults_saving: bool,
    pub default_timezone_input: Option<Entity<InputState>>,
    pub settings_revision: Arc<AtomicU64>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl Default for ScheduledState {
    fn default() -> Self {
        Self {
            schedules: Vec::new(),
            workspaces: Vec::new(),
            providers: Vec::new(),
            mcp_servers: Vec::new(),
            adding: None,
            removing: None,
            cron_feedback: None,
            cron_ok: false,
            error: None,
            global_enabled: false,
            executor_ready: false,
            global_saving: false,
            defaults: ScheduledDefaults {
                default_mode: DEFAULT_SCHEDULED_MODE,
                default_permission: DEFAULT_SCHEDULED_PERMISSION,
                default_mcp_enabled: false,
                default_notify: true,
                default_timezone: system_timezone(),
            },
            defaults_loading: true,
            defaults_error: None,
            defaults_saving: false,
            default_timezone_input: None,
            settings_revision: Arc::new(AtomicU64::new(0)),
            _subscriptions: Vec::new(),
        }
    }
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

/// Validate a cron expression and preview its next occurrence.
pub fn cron_feedback(cron: &str) -> Result<String, String> {
    let trimmed = cron.trim();
    if trimmed.is_empty() {
        return Err("A cron schedule is required.".to_string());
    }
    let timezone = system_timezone();
    match next_scheduled_run(trimmed, &timezone, aiden_data::now_millis()) {
        Ok(next) => Ok(format!(
            "Schedule valid · next occurrence {}",
            crate::services::chat_service::relative_time(next, aiden_data::now_millis())
        )),
        Err(error) => Err(error.to_string()),
    }
}

impl SettingsView {
    /// The Scheduled tasks section.
    pub(crate) fn scheduled_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if self.scheduled.default_timezone_input.is_none() {
            let timezone = self.scheduled.defaults.default_timezone.clone();
            self.scheduled.default_timezone_input =
                Some(cx.new(|cx| InputState::new(window, cx).default_value(timezone)));
        }
        let theme = cx.theme().clone();
        let state = &self.scheduled;
        let timezone_input = state
            .default_timezone_input
            .clone()
            .expect("scheduled timezone input is initialized before rendering");
        let defaults_editable = state.defaults_editable();

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
                                    .child("Run explicit, locally stored automations while Aiden is open."),
                            ),
                    )
                    .child(
                        Button::new("add-schedule")
                            .small()
                            .icon(IconName::Plus)
                            .label("New task")
                            .disabled(!state.executor_ready)
                            .tooltip("Create a scheduled prompt or local script")
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.scheduled.open_draft(window, cx);
                            })),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .px_3()
                    .py_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .child(
                        v_flex()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Allow scheduled execution"))
                            .child(div().text_xs().text_color(theme.muted_foreground).child(if state.executor_ready {
                                "Off by default. Enabling may send task prompts to the pinned provider and run approved local scripts."
                            } else {
                                "The scheduled executor is unavailable; tasks remain paused."
                            })),
                    )
                    .child(
                        Switch::new("scheduled-global-enabled")
                            .checked(state.global_enabled)
                            .disabled(!state.executor_ready || state.global_saving)
                            .label(if state.global_enabled { "On" } else { "Off" })
                            .on_click(cx.listener(|this, enabled, _window, cx| {
                                this.scheduled.set_global_enabled(*enabled, &this.services, cx);
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
            .when(state.defaults_loading, |el| {
                el.child(
                    div()
                        .id("scheduled-defaults-loading")
                        .w_full()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.muted.opacity(0.12))
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Loading scheduled-task defaults…"),
                )
            })
            .when_some(state.defaults_error.clone(), |el, message| {
                el.child(
                    h_flex()
                        .id("scheduled-defaults-error")
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap_3()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(theme.danger.opacity(0.12))
                        .child(
                            div()
                                .flex_1()
                                .text_sm()
                                .text_color(theme.danger)
                                .child(message),
                        )
                        .child(
                            Button::new("scheduled-defaults-retry")
                                .small()
                                .ghost()
                                .label("Retry")
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.reload_scheduled_defaults(cx);
                                })),
                        ),
                )
            })
            .child(
                v_flex()
                    .id("scheduled-defaults")
                    .w_full()
                    .gap_2()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .px_3()
                    .py_3()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Defaults for new tasks"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("These defaults are saved on this Mac and can be changed before each task runs."),
                    )
                    .child(
                        h_flex()
                            .id("scheduled-default-mode")
                            .w_full()
                            .items_center()
                            .gap_2()
                            .child(div().flex_1().text_sm().child("Default task mode"))
                            .child({
                                let mut button = Button::new("scheduled-default-mode-llm")
                                    .small()
                                    .ghost()
                                    .label("Ask Aiden");
                                if state.defaults.default_mode == ScheduledTaskMode::Llm {
                                    button = button.primary();
                                }
                                button
                                    .disabled(!defaults_editable)
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        let mut patch = serde_json::Map::new();
                                        patch.insert(
                                            "scheduledDefaultMode".into(),
                                            serde_json::Value::String("llm".into()),
                                        );
                                        this.scheduled
                                            .save_defaults_patch(patch, &this.services, cx);
                                    }))
                            })
                            .child({
                                let mut button = Button::new("scheduled-default-mode-script")
                                    .small()
                                    .ghost()
                                    .label("Run script");
                                if state.defaults.default_mode == ScheduledTaskMode::Script {
                                    button = button.primary();
                                }
                                button
                                    .disabled(!defaults_editable)
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        let mut patch = serde_json::Map::new();
                                        patch.insert(
                                            "scheduledDefaultMode".into(),
                                            serde_json::Value::String("script".into()),
                                        );
                                        this.scheduled
                                            .save_defaults_patch(patch, &this.services, cx);
                                    }))
                            }),
                    )
                    .child(
                        h_flex()
                            .id("scheduled-default-permission")
                            .w_full()
                            .items_center()
                            .gap_2()
                            .child(div().flex_1().text_sm().child("Default permission"))
                            .child({
                                let mut button = Button::new("scheduled-default-permission-read-only")
                                    .small()
                                    .ghost()
                                    .label("Read-only");
                                if state.defaults.default_permission
                                    == ScheduledTaskPermission::ReadOnly
                                {
                                    button = button.primary();
                                }
                                button
                                    .disabled(!defaults_editable)
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        let mut patch = serde_json::Map::new();
                                        patch.insert(
                                            "scheduledDefaultPermission".into(),
                                            serde_json::Value::String("read-only".into()),
                                        );
                                        patch.insert(
                                            "scheduledDefaultMcpEnabled".into(),
                                            serde_json::Value::Bool(false),
                                        );
                                        this.scheduled
                                            .save_defaults_patch(patch, &this.services, cx);
                                    }))
                            })
                            .child({
                                let mut button = Button::new("scheduled-default-permission-full")
                                    .small()
                                    .ghost()
                                    .label("Full");
                                if state.defaults.default_permission == ScheduledTaskPermission::Full {
                                    button = button.primary();
                                }
                                button
                                    .disabled(!defaults_editable)
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        let mut patch = serde_json::Map::new();
                                        patch.insert(
                                            "scheduledDefaultPermission".into(),
                                            serde_json::Value::String("full".into()),
                                        );
                                        this.scheduled
                                            .save_defaults_patch(patch, &this.services, cx);
                                    }))
                            }),
                    )
                    .child(
                        h_flex()
                            .id("scheduled-default-mcp")
                            .w_full()
                            .items_center()
                            .gap_2()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .child(div().text_sm().child("Default MCP access"))
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .child("Select enabled servers when creating a new Full task."),
                                    ),
                            )
                            .child(
                                Switch::new("scheduled-default-mcp-switch")
                                    .checked(
                                        state.defaults.default_permission
                                            == ScheduledTaskPermission::Full
                                            && state.defaults.default_mcp_enabled,
                                    )
                                    .disabled(
                                        !defaults_editable
                                            || state.defaults.default_permission
                                                != ScheduledTaskPermission::Full
                                            || state.mcp_servers.iter().all(|server| !server.enabled),
                                    )
                                    .label(if state.defaults.default_mcp_enabled {
                                        "On"
                                    } else {
                                        "Off"
                                    })
                                    .on_click(cx.listener(|this, enabled, _window, cx| {
                                        let mut patch = serde_json::Map::new();
                                        patch.insert(
                                            "scheduledDefaultMcpEnabled".into(),
                                            serde_json::Value::Bool(*enabled),
                                        );
                                        if *enabled {
                                            patch.insert(
                                                "scheduledDefaultPermission".into(),
                                                serde_json::Value::String("full".into()),
                                            );
                                        }
                                        this.scheduled
                                            .save_defaults_patch(patch, &this.services, cx);
                                    })),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("scheduled-default-notify")
                            .w_full()
                            .items_center()
                            .gap_2()
                            .child(div().flex_1().text_sm().child("Notifications"))
                            .child(
                                Switch::new("scheduled-default-notify-switch")
                                    .checked(state.defaults.default_notify)
                                    .disabled(!defaults_editable)
                                    .label(if state.defaults.default_notify {
                                        "On"
                                    } else {
                                        "Off"
                                    })
                                    .on_click(cx.listener(|this, enabled, _window, cx| {
                                        let mut patch = serde_json::Map::new();
                                        patch.insert(
                                            "scheduledDefaultNotify".into(),
                                            serde_json::Value::Bool(*enabled),
                                        );
                                        this.scheduled
                                            .save_defaults_patch(patch, &this.services, cx);
                                    })),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("scheduled-default-timezone")
                            .w_full()
                            .items_center()
                            .gap_2()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .child(div().text_sm().child("Default timezone"))
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .child("Use an IANA timezone such as America/New_York."),
                                    ),
                            )
                            .child(Input::new(&timezone_input).small().disabled(!defaults_editable))
                            .child(
                                Button::new("scheduled-default-timezone-save")
                                    .small()
                                    .ghost()
                                    .label("Save")
                                    .disabled(!defaults_editable)
                                    .on_click(cx.listener(move |this, _event, window, cx| {
                                        let timezone = timezone_input.read(cx).value().to_string();
                                        let trimmed_timezone = timezone.trim().to_string();
                                        this.scheduled
                                            .save_default_timezone(trimmed_timezone.clone(), &this.services, cx);
                                        timezone_input.update(cx, |input, cx| {
                                            input.set_value(trimmed_timezone, window, cx);
                                        });
                                    })),
                            ),
                    )
                    .child(
                        v_flex()
                            .id("scheduled-script-folders")
                            .w_full()
                            .gap_1()
                            .child(div().text_sm().child("Script folders"))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("Workspace scripts take precedence over global scripts with the same name."),
                            )
                            .child(
                                div()
                                    .id("scheduled-script-folders-paths")
                                    .rounded_md()
                                    .bg(theme.muted.opacity(0.12))
                                    .px_2()
                                    .py_2()
                                    .font_family("monospace")
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("<workspace>/.aiden/scripts/\n~/.aiden/scripts/"),
                            ),
                    ),
            )
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
        let dot_color =
            if row.last_result == Some(aiden_data::schedule_store::ScheduledRunResult::Error) {
                theme.danger
            } else if row.enabled && self.scheduled.global_enabled {
                theme.success
            } else {
                theme.muted_foreground
            };
        let status = if !self.scheduled.global_enabled {
            "Paused by global setting".to_string()
        } else if !row.enabled {
            "Paused".to_string()
        } else if let Some(next) = row.next_run_at {
            format!(
                "Next run {}",
                crate::services::chat_service::relative_time(next, aiden_data::now_millis())
            )
        } else {
            "Enabled".to_string()
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
                            .child(format!(
                                "{} · {} · {}",
                                status,
                                humanize_cron(&row.cron),
                                match row.mode {
                                    ScheduledTaskMode::Llm => "Ask Aiden",
                                    ScheduledTaskMode::Script => "Local script",
                                }
                            )),
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
                let edit_task = row.task.clone();
                Button::new(ElementId::Name(SharedString::from(format!(
                    "schedule-edit-{id}"
                ))))
                .small()
                .ghost()
                .icon(IconName::Settings2)
                .tooltip("Edit task")
                .on_click(cx.listener(move |this, _event, window, cx| {
                    this.scheduled.open_edit(&edit_task, window, cx);
                }))
            })
            .child({
                let click_id = id.clone();
                Switch::new(ElementId::Name(SharedString::from(format!(
                    "schedule-enabled-{id}"
                ))))
                .checked(row.enabled)
                .disabled(!self.scheduled.global_enabled || !self.scheduled.executor_ready)
                .label(if row.enabled { "Enabled" } else { "Paused" })
                .on_click(cx.listener(move |this, checked, _window, cx| {
                    this.scheduled
                        .toggle_enabled(&click_id, *checked, &this.services, cx);
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
        let theme = cx.theme().clone();
        let name_value = draft.name.read(cx).value().to_string();
        let prompt_value = draft.prompt.read(cx).value().to_string();
        let script_value = draft.script.read(cx).value().to_string();
        let can_save = !name_value.trim().is_empty()
            && match draft.mode {
                ScheduledTaskMode::Llm => {
                    !prompt_value.trim().is_empty()
                        && !draft.provider_id.is_empty()
                        && !draft.model.is_empty()
                        && match draft.permission {
                            ScheduledTaskPermission::ReadOnly => draft.mcp_server_ids.is_empty(),
                            ScheduledTaskPermission::Full => {
                                draft.workspace_id.is_empty() && !draft.mcp_server_ids.is_empty()
                            }
                        }
                }
                ScheduledTaskMode::Script => {
                    !script_value.trim().is_empty()
                        && draft.permission == ScheduledTaskPermission::Full
                }
            }
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
                            .child(if draft.id.is_some() { "Edit scheduled task" } else { "New scheduled task" }),
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
                h_flex()
                    .w_full()
                    .gap_2()
                    .child({
                        let mut button = Button::new("schedule-mode-llm").small().label("Ask Aiden");
                        if draft.mode == ScheduledTaskMode::Llm { button = button.primary(); }
                        button.on_click(cx.listener(|this, _, _, cx| {
                            if let Some(draft) = this.scheduled.adding.as_mut() { draft.mode = ScheduledTaskMode::Llm; }
                            cx.notify();
                        }))
                    })
                    .child({
                        let mut button = Button::new("schedule-mode-script").small().label("Local script");
                        if draft.mode == ScheduledTaskMode::Script { button = button.primary(); }
                        button.on_click(cx.listener(|this, _, _, cx| {
                            if let Some(draft) = this.scheduled.adding.as_mut() {
                                draft.mode = ScheduledTaskMode::Script;
                                draft.permission = ScheduledTaskPermission::Full;
                            }
                            cx.notify();
                        }))
                    }),
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
            .when(draft.mode == ScheduledTaskMode::Llm, |el| el.child(
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
            ))
            .when(draft.mode == ScheduledTaskMode::Script, |el| el.child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(theme.muted_foreground).child("Script from .aiden/scripts"))
                    .child(Input::new(&draft.script).small())
                    .child(div().text_xs().text_color(theme.muted_foreground).child("Scripts run with Full access, a 60-second timeout, and a 1 MB output limit.")),
            ))
            .when(draft.mode == ScheduledTaskMode::Llm, |el| el.child(self.schedule_provider_select(draft, cx)))
            .when(draft.mode == ScheduledTaskMode::Llm, |el| el.child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("Native scheduled prompts are bounded provider turns. Project paths ground context, but filesystem and shell tools are not exposed; Full access only enables explicitly selected MCP servers."),
            ))
            .when(
                draft.mode == ScheduledTaskMode::Llm
                    && draft.permission == ScheduledTaskPermission::Full
                    && draft.workspace_id.is_empty(),
                |el| el.child(self.schedule_mcp_select(draft, cx)),
            )
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_2()
                    .child(div().text_xs().text_color(theme.muted_foreground).child("Permission"))
                    .child({
                        let mut button = Button::new("schedule-read-only").xsmall().ghost().label("Read-only");
                        if draft.permission == ScheduledTaskPermission::ReadOnly { button = button.primary(); }
                        button.disabled(draft.mode == ScheduledTaskMode::Script).on_click(cx.listener(|this, _, _, cx| {
                            if let Some(draft) = this.scheduled.adding.as_mut() { draft.permission = ScheduledTaskPermission::ReadOnly; }
                            cx.notify();
                        }))
                    })
                    .child({
                        let mut button = Button::new("schedule-full").xsmall().ghost().label("Full");
                        if draft.permission == ScheduledTaskPermission::Full { button = button.primary(); }
                        button.on_click(cx.listener(|this, _, _, cx| {
                            if let Some(draft) = this.scheduled.adding.as_mut() { draft.permission = ScheduledTaskPermission::Full; }
                            cx.notify();
                        }))
                    })
                    .child(div().flex_1())
                    .child(
                        Switch::new("schedule-notify")
                            .checked(draft.notify)
                            .label("Notify when finished")
                            .on_click(cx.listener(|this, enabled, _, cx| {
                                if let Some(draft) = this.scheduled.adding.as_mut() { draft.notify = *enabled; }
                                cx.notify();
                            })),
                    ),
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
                                this.scheduled.save_draft(&this.services, cx);
                            })),
                    ),
            )
    }

    fn schedule_provider_select(
        &self,
        draft: &ScheduledDraft,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let providers = self.scheduled.providers.clone();
        v_flex()
            .w_full()
            .gap_1()
            .child(
                div()
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.muted_foreground)
                    .child("Pinned provider and model"),
            )
            .children(
                providers
                    .clone()
                    .into_iter()
                    .map(|(provider_id, label, models)| {
                        let selected = draft.provider_id == provider_id;
                        let click_id = provider_id.clone();
                        let default_model = models.first().cloned().unwrap_or_default();
                        let mut button = Button::new(SharedString::from(format!(
                            "schedule-provider-{provider_id}"
                        )))
                        .xsmall()
                        .ghost()
                        .label(label);
                        if selected {
                            button = button.primary();
                        }
                        button.on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(draft) = this.scheduled.adding.as_mut() {
                                draft.provider_id = click_id.clone();
                                draft.model = default_model.clone();
                            }
                            cx.notify();
                        }))
                    }),
            )
            .when(!draft.provider_id.is_empty(), |el| {
                el.children(
                    providers
                        .iter()
                        .find(|(id, _, _)| id == &draft.provider_id)
                        .into_iter()
                        .flat_map(|(_, _, models)| models.iter())
                        .map(|model| {
                            let active = model == &draft.model;
                            let model_id = model.clone();
                            let mut button = Button::new(SharedString::from(format!(
                                "schedule-model-{}",
                                model
                            )))
                            .xsmall()
                            .ghost()
                            .label(model.clone());
                            if active {
                                button = button.primary();
                            }
                            button.on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(draft) = this.scheduled.adding.as_mut() {
                                    draft.model = model_id.clone();
                                }
                                cx.notify();
                            }))
                        }),
                )
            })
    }

    /// A simple workspace button row (radio-like) since the select state would
    /// need another window-created entity.
    fn workspace_select(&self, draft: &ScheduledDraft, cx: &mut Context<Self>) -> impl IntoElement {
        let workspaces = self.scheduled.workspaces.clone();
        let selected = draft.workspace_id.clone();
        h_flex()
            .w_full()
            .gap_1()
            .child({
                let mut button = Button::new("schedule-workspace-none")
                    .ghost()
                    .xsmall()
                    .label("No project");
                if selected.is_empty() {
                    button = button.primary();
                }
                button.on_click(cx.listener(|this, _, _, cx| {
                    if let Some(draft) = this.scheduled.adding.as_mut() {
                        draft.workspace_id.clear();
                    }
                    cx.notify();
                }))
            })
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

    fn schedule_mcp_select(
        &self,
        draft: &ScheduledDraft,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let servers = self.scheduled.mcp_servers.clone();
        v_flex()
            .w_full()
            .gap_1()
            .child(
                div()
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.muted_foreground)
                    .child("Unattended MCP access (optional)"),
            )
            .children(
                servers
                    .into_iter()
                    .filter(|server| server.enabled)
                    .map(|server| {
                        let active = draft.mcp_server_ids.contains(&server.id);
                        let id = server.id.clone();
                        let mut button =
                            Button::new(SharedString::from(format!("schedule-mcp-{}", server.id)))
                                .xsmall()
                                .ghost()
                                .label(server.name);
                        if active {
                            button = button.primary();
                        }
                        button.on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(draft) = this.scheduled.adding.as_mut() {
                                if let Some(index) = draft
                                    .mcp_server_ids
                                    .iter()
                                    .position(|candidate| candidate == &id)
                                {
                                    draft.mcp_server_ids.remove(index);
                                } else if draft.mcp_server_ids.len() < 16 {
                                    draft.mcp_server_ids.push(id.clone());
                                }
                            }
                            cx.notify();
                        }))
                    }),
            )
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
                        this.scheduled.confirm_remove(&removing, &this.services, cx);
                    })),
            )
    }
}

impl ScheduledState {
    pub fn hydrate_defaults(
        &mut self,
        settings: &serde_json::Map<String, serde_json::Value>,
        load_error: Option<String>,
    ) {
        self.defaults_loading = false;
        self.defaults_error = load_error.map(|_| {
            "Scheduled task defaults could not be loaded. Retry before changing settings."
                .to_string()
        });
        if self.defaults_error.is_none() {
            match scheduled_defaults_from_settings(settings) {
                Ok(defaults) => self.defaults = defaults,
                Err(error) => self.defaults_error = Some(error),
            }
        }
    }

    fn defaults_editable(&self) -> bool {
        !self.defaults_loading && self.defaults_error.is_none() && !self.defaults_saving
    }

    fn save_defaults_patch(
        &mut self,
        patch: serde_json::Map<String, serde_json::Value>,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if !self.defaults_editable() || patch.is_empty() {
            return;
        }
        self.defaults_saving = true;
        self.defaults_error = None;
        let revision = self.settings_revision.fetch_add(1, Ordering::AcqRel) + 1;
        let current_revision = self.settings_revision.clone();
        let config = services.config.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    config
                        .set_settings(&patch, &|| {
                            current_revision.load(Ordering::Acquire) == revision
                        })
                        .map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.scheduled.settings_revision.load(Ordering::Acquire) != revision {
                    return;
                }
                this.scheduled.defaults_saving = false;
                match result {
                    Ok(settings) => match scheduled_defaults_from_settings(&settings) {
                        Ok(defaults) => {
                            this.scheduled.defaults = defaults;
                            this.scheduled.defaults_error = None;
                        }
                        Err(error) => this.scheduled.defaults_error = Some(error),
                    },
                    Err(error) => {
                        this.scheduled.defaults_error = Some(format!(
                            "Scheduled task defaults could not be saved: {error}"
                        ));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn save_default_timezone(
        &mut self,
        timezone: String,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let timezone = timezone.trim().to_string();
        let timezone = match validate_timezone(&timezone) {
            Ok(timezone) => timezone,
            Err(error) => {
                self.defaults_error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        let mut patch = serde_json::Map::new();
        patch.insert(
            "scheduledDefaultTimezone".into(),
            serde_json::Value::String(timezone),
        );
        self.save_defaults_patch(patch, services, cx);
    }

    fn open_edit(
        &mut self,
        task: &ScheduledTask,
        window: &mut Window,
        cx: &mut Context<SettingsView>,
    ) {
        let name_value = task.name.clone();
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Morning digest")
                .default_value(name_value)
        });
        let prompt_value = task.prompt.clone().unwrap_or_default();
        let prompt = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Summarize updates")
                .default_value(prompt_value)
        });
        let script_value = task.script.clone().unwrap_or_default();
        let script = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("daily-report.sh")
                .default_value(script_value)
        });
        let cron_value = task.cron.clone();
        let cron = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("0 9 * * 1-5")
                .default_value(cron_value)
        });
        for entity in [name.clone(), prompt.clone(), script.clone(), cron.clone()] {
            self._subscriptions.push(cx.subscribe_in(
                &entity,
                window,
                |_this, _source, event, _window, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ));
        }
        self.cron_ok = true;
        self.cron_feedback = cron_feedback(&task.cron).ok();
        self.adding = Some(ScheduledDraft {
            id: Some(task.id.clone()),
            expected_updated_at: Some(task.updated_at),
            name,
            prompt,
            script,
            cron,
            workspace_id: task.workspace_id.clone().unwrap_or_default(),
            provider_id: task.provider_id.clone().unwrap_or_default(),
            model: task.model.clone().unwrap_or_default(),
            mode: task.mode,
            permission: task.permission,
            notify: task.notify,
            mcp_server_ids: task.mcp_server_ids.clone().unwrap_or_default(),
            saving: false,
        });
        cx.notify();
    }

    fn set_global_enabled(
        &mut self,
        enabled: bool,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.global_saving {
            return;
        }
        self.global_saving = true;
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    if !enabled {
                        services
                            .scheduler
                            .set_global_enabled(false)
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                    let mut patch = serde_json::Map::new();
                    patch.insert(
                        crate::services::scheduled_execution::SCHEDULED_TASKS_ENABLED_KEY.into(),
                        serde_json::Value::Bool(enabled),
                    );
                    if let Err(error) = services.config.set_settings(&patch, &|| true) {
                        if !enabled {
                            let _ = services.scheduler.set_global_enabled(true).await;
                        }
                        return Err(error.to_string());
                    }
                    if enabled {
                        let start_result = if services.scheduler.is_started() {
                            services
                                .scheduler
                                .set_global_enabled(true)
                                .await
                                .map_err(|error| error.to_string())
                        } else {
                            services
                                .scheduler
                                .start()
                                .await
                                .map_err(|error| error.to_string())
                        };
                        if let Err(error) = start_result {
                            let mut rollback = serde_json::Map::new();
                            rollback.insert(
                                crate::services::scheduled_execution::SCHEDULED_TASKS_ENABLED_KEY
                                    .into(),
                                serde_json::Value::Bool(false),
                            );
                            return match services.config.set_settings(&rollback, &|| true) {
                                Ok(_) => Err(error),
                                Err(rollback_error) => Err(format!(
                                    "{error}; the durable enable rollback also failed: {rollback_error}"
                                )),
                            };
                        }
                    }
                    Ok::<(), String>(())
                })
                .await;
            this.update(cx, |this, cx| {
                this.scheduled.global_saving = false;
                match result {
                    Ok(()) => {
                        this.scheduled.global_enabled = enabled;
                        this.scheduled.error = None;
                    }
                    Err(error) => {
                        this.scheduled.error = Some(format!(
                            "Scheduled execution could not be {}: {error}",
                            if enabled { "enabled" } else { "disabled" }
                        ));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Open the new-task form with a live-validating cron field.
    fn open_draft(&mut self, window: &mut Window, cx: &mut Context<SettingsView>) {
        let make_input =
            |cx: &mut Context<SettingsView>, window: &mut Window, placeholder: &str| {
                let placeholder = placeholder.to_string();
                cx.new(move |cx| InputState::new(window, cx).placeholder(placeholder))
            };
        let name = make_input(cx, window, "Morning digest");
        let prompt = make_input(cx, window, "Summarize my open PRs");
        let script = make_input(cx, window, "daily-report.sh");
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
        for input in [name.clone(), prompt.clone(), script.clone()] {
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
        let mode = self.defaults.default_mode;
        let permission = if mode == ScheduledTaskMode::Script {
            ScheduledTaskPermission::Full
        } else {
            self.defaults.default_permission
        };
        let mcp_server_ids = if mode == ScheduledTaskMode::Llm
            && permission == ScheduledTaskPermission::Full
            && self.defaults.default_mcp_enabled
        {
            self.mcp_servers
                .iter()
                .filter(|server| server.enabled)
                .map(|server| server.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        let workspace_id = if !mcp_server_ids.is_empty() {
            String::new()
        } else {
            default_workspace
        };
        self.adding = Some(ScheduledDraft {
            id: None,
            expected_updated_at: None,
            name,
            prompt,
            script,
            cron,
            workspace_id,
            provider_id: self
                .providers
                .first()
                .map(|(id, _, _)| id.clone())
                .unwrap_or_default(),
            model: self
                .providers
                .first()
                .and_then(|(_, _, models)| models.first().cloned())
                .unwrap_or_default(),
            mode,
            permission,
            notify: self.defaults.default_notify,
            mcp_server_ids,
            saving: false,
        });
        self.cron_feedback = None;
        self.cron_ok = false;
        cx.notify();
    }

    /// Persist the new-task form as an LLM scheduled task.
    fn save_draft(&mut self, services: &SettingsServices, cx: &mut Context<SettingsView>) {
        let Some(draft) = self.adding.as_mut() else {
            return;
        };
        if draft.saving {
            return;
        }
        let name = draft.name.read(cx).value().to_string();
        let prompt = draft.prompt.read(cx).value().to_string();
        let script = draft.script.read(cx).value().to_string();
        let cron = draft.cron.read(cx).value().to_string();
        let workspace_id = if draft.workspace_id.is_empty() {
            None
        } else {
            Some(draft.workspace_id.clone())
        };
        let provider_id = (!draft.provider_id.is_empty()).then(|| draft.provider_id.clone());
        let model = (!draft.model.is_empty()).then(|| draft.model.clone());
        let mode = draft.mode;
        let permission = draft.permission;
        let notify = draft.notify;
        let mcp_server_ids = draft.mcp_server_ids.clone();
        let timezone = self.defaults.default_timezone.clone();
        let id = draft.id.clone();
        let expected_updated_at = draft.expected_updated_at;
        draft.saving = true;
        let services = services.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let provider_fingerprint = match provider_id.as_deref() {
                        Some(id) => services
                            .config
                            .get_provider(id)
                            .map_err(|error| error.to_string())?
                            .map(|provider| {
                                aiden_scheduler::binding::scheduled_provider_fingerprint(
                                    &crate::services::scheduled_execution::provider_binding_for_schedule(&provider),
                                )
                            }),
                        None => None,
                    };
                    let configured_servers = services
                        .config
                        .list_mcp_servers()
                        .map_err(|error| error.to_string())?;
                    let mut mcp_server_bindings = Vec::new();
                    for server_id in &mcp_server_ids {
                        let server = configured_servers
                            .iter()
                            .find(|server| &server.id == server_id && server.enabled)
                            .ok_or_else(|| "A selected MCP server is unavailable.".to_string())?;
                        let binding_server = serde_json::to_value(server)
                            .and_then(serde_json::from_value::<aiden_scheduler::binding::McpServer>)
                            .map_err(|_| "A selected MCP server binding is invalid.".to_string())?;
                        mcp_server_bindings.push(
                            aiden_scheduler::binding::scheduled_mcp_server_binding(&binding_server),
                        );
                    }
                    let input = ScheduledTaskInput {
                        id,
                        name: name.trim().to_string(),
                        mode,
                        cron: cron.trim().to_string(),
                        timezone: Some(timezone),
                        workspace_id,
                        provider_id: (mode == ScheduledTaskMode::Llm).then_some(provider_id).flatten(),
                        model: (mode == ScheduledTaskMode::Llm).then_some(model).flatten(),
                        provider_fingerprint: (mode == ScheduledTaskMode::Llm).then_some(provider_fingerprint).flatten(),
                        prompt: (mode == ScheduledTaskMode::Llm).then_some(prompt),
                        script: (mode == ScheduledTaskMode::Script).then_some(script),
                        permission: Some(permission),
                        mcp_server_ids: Some(mcp_server_ids),
                        mcp_server_bindings: Some(mcp_server_bindings),
                        execution_profile: None,
                        notify: Some(notify),
                        enabled: Some(false),
                    };
                    let cancellation = tokio_util::sync::CancellationToken::new();
                    services.scheduler.save(&input, expected_updated_at, &cancellation).await.map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(_) => {
                        this.scheduled.adding = None;
                        this.scheduled.error = None;
                        this.reload_schedules(cx);
                    }
                    Err(error) => {
                        if let Some(draft) = this.scheduled.adding.as_mut() {
                            draft.saving = false;
                        }
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
    fn toggle_enabled(
        &mut self,
        id: &str,
        enabled: bool,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let services = services.clone();
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    if enabled {
                        services.scheduler.resume(&id).await
                    } else {
                        services.scheduler.pause(&id).await
                    }
                })
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
    fn confirm_remove(
        &mut self,
        id: &str,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let services = services.clone();
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { services.scheduler.remove(&id).await })
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
    pub(crate) fn reload_scheduled_defaults(&mut self, cx: &mut Context<Self>) {
        self.scheduled.defaults_loading = true;
        self.scheduled.defaults_error = None;
        let config = self.services.config.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { config.get_settings() })
                .await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(settings) => {
                        this.providers.settings = settings.clone();
                        this.scheduled.hydrate_defaults(&settings, None);
                    }
                    Err(error) => {
                        this.scheduled
                            .hydrate_defaults(&serde_json::Map::new(), Some(error.to_string()));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

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
        assert!(ok.starts_with("Schedule valid · next occurrence "));
        let with_seconds = cron_feedback("30 9 * * *").unwrap();
        assert!(with_seconds.starts_with("Schedule valid · next occurrence "));
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
        assert_eq!(row.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn scheduled_defaults_round_trip_persisted_values() {
        let settings = serde_json::Map::from_iter([
            (
                "scheduledDefaultMode".into(),
                serde_json::Value::String("script".into()),
            ),
            (
                "scheduledDefaultPermission".into(),
                serde_json::Value::String("full".into()),
            ),
            (
                "scheduledDefaultMcpEnabled".into(),
                serde_json::Value::Bool(true),
            ),
            (
                "scheduledDefaultNotify".into(),
                serde_json::Value::Bool(false),
            ),
            (
                "scheduledDefaultTimezone".into(),
                serde_json::Value::String("America/New_York".into()),
            ),
        ]);
        assert_eq!(
            scheduled_defaults_from_settings(&settings).unwrap(),
            ScheduledDefaults {
                default_mode: ScheduledTaskMode::Script,
                default_permission: ScheduledTaskPermission::Full,
                default_mcp_enabled: true,
                default_notify: false,
                default_timezone: "America/New_York".into(),
            }
        );
    }

    #[test]
    fn scheduled_defaults_use_safe_defaults_when_persisted_values_are_absent() {
        let defaults = scheduled_defaults_from_settings(&serde_json::Map::new()).unwrap();
        assert_eq!(defaults.default_mode, ScheduledTaskMode::Llm);
        assert_eq!(
            defaults.default_permission,
            ScheduledTaskPermission::ReadOnly
        );
        assert!(!defaults.default_mcp_enabled);
        assert!(defaults.default_notify);
        assert_eq!(
            defaults.default_timezone,
            validate_timezone(&system_timezone()).unwrap()
        );
    }

    #[test]
    fn scheduled_defaults_reject_unknown_enums_and_invalid_types() {
        let mut mode = serde_json::Map::new();
        mode.insert(
            "scheduledDefaultMode".into(),
            serde_json::Value::String("future".into()),
        );
        assert!(scheduled_defaults_from_settings(&mode).is_err());

        let mut permission = serde_json::Map::new();
        permission.insert(
            "scheduledDefaultPermission".into(),
            serde_json::Value::String("unsafe".into()),
        );
        assert!(scheduled_defaults_from_settings(&permission).is_err());

        let mut mcp = serde_json::Map::new();
        mcp.insert(
            "scheduledDefaultMcpEnabled".into(),
            serde_json::Value::String("true".into()),
        );
        assert!(scheduled_defaults_from_settings(&mcp).is_err());
    }

    #[test]
    fn scheduled_defaults_reject_invalid_timezone_and_notification_type() {
        let mut timezone = serde_json::Map::new();
        timezone.insert(
            "scheduledDefaultTimezone".into(),
            serde_json::Value::String("Mars/Olympus".into()),
        );
        assert!(scheduled_defaults_from_settings(&timezone).is_err());

        let mut notify = serde_json::Map::new();
        notify.insert(
            "scheduledDefaultNotify".into(),
            serde_json::Value::String("yes".into()),
        );
        assert!(scheduled_defaults_from_settings(&notify).is_err());
    }
}
