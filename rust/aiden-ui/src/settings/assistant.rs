//! Assistant settings (port of `assistant-settings.tsx`, functional subset).
//!
//! Reads/writes the `assistant` object inside `settings.json` through the
//! config store (which merges the object field-by-field on `set_settings`).
//! Controls:
//!
//! - **Proactivity** master switch (`assistant.enabled`) — off by default;
//!   nudging is opt-in.
//! - **Settings permission** (`assistant.settingsPermission`) — how much the
//!   assistant may do with app settings: full / ask / none.
//! - **Workspace scope** — which watched signals feed proactivity:
//!   uncommitted git changes, untouched projects, and portable-config changes.
//!
//! Writes run on the background executor, mirroring the other sections. The
//! runtime that consumes these settings (the assistant panel's watcher) is
//! wired separately; this surface only persists intent.

use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, Sizable as _,
};

use super::{SettingsServices, SettingsView};

/// The settings key holding the whole assistant config object.
pub const ASSISTANT_SETTINGS_KEY: &str = "assistant";

/// The parsed assistant config subset this section edits.
#[derive(Debug, Clone, PartialEq)]
pub struct AssistantConfig {
    pub enabled: bool,
    pub settings_permission: AssistantPermission,
    pub watch_uncommitted: bool,
    pub watch_untouched_projects: bool,
    pub watch_config_changes: bool,
}

/// How much the assistant may do with app settings (`AssistantSettingsPermission`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssistantPermission {
    Full,
    Ask,
    None,
}

impl AssistantPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            AssistantPermission::Full => "full",
            AssistantPermission::Ask => "ask",
            AssistantPermission::None => "none",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            AssistantPermission::Full => "Full",
            AssistantPermission::Ask => "Ask",
            AssistantPermission::None => "None",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "full" => Some(AssistantPermission::Full),
            "ask" => Some(AssistantPermission::Ask),
            "none" => Some(AssistantPermission::None),
            _ => None,
        }
    }
}

impl Default for AssistantConfig {
    fn default() -> Self {
        // Mirrors DEFAULT_ASSISTANT_CONFIG in assistant-parse.ts.
        Self {
            enabled: false,
            settings_permission: AssistantPermission::Ask,
            watch_uncommitted: true,
            watch_untouched_projects: true,
            watch_config_changes: true,
        }
    }
}

/// Parse the persisted `assistant` object. Unknown/malformed fields fall back
/// to the defaults (the TS `parseAssistantConfig` behaves the same way).
pub fn parse_assistant_config(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> AssistantConfig {
    let defaults = AssistantConfig::default();
    let Some(value) = settings
        .get(ASSISTANT_SETTINGS_KEY)
        .and_then(|value| value.as_object())
    else {
        return defaults;
    };
    let enabled = value
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(defaults.enabled);
    let settings_permission = value
        .get("settingsPermission")
        .and_then(|value| value.as_str())
        .and_then(AssistantPermission::from_str)
        .unwrap_or(defaults.settings_permission);
    let watch_uncommitted = value
        .get("watchUncommitted")
        .and_then(|value| value.as_bool())
        .unwrap_or(defaults.watch_uncommitted);
    let watch_untouched_projects = value
        .get("watchUntouchedProjects")
        .and_then(|value| value.as_bool())
        .unwrap_or(defaults.watch_untouched_projects);
    let watch_config_changes = value
        .get("watchConfigChanges")
        .and_then(|value| value.as_bool())
        .unwrap_or(defaults.watch_config_changes);
    AssistantConfig {
        enabled,
        settings_permission,
        watch_uncommitted,
        watch_untouched_projects,
        watch_config_changes,
    }
}

/// Serialize the editable subset back into a settings patch for the `assistant`
/// key (only the fields this section manages, so other assistant settings like
/// the hotkey survive untouched).
pub fn assistant_patch(config: &AssistantConfig) -> serde_json::Value {
    serde_json::json!({
        "enabled": config.enabled,
        "settingsPermission": config.settings_permission.as_str(),
        "watchUncommitted": config.watch_uncommitted,
        "watchUntouchedProjects": config.watch_untouched_projects,
        "watchConfigChanges": config.watch_config_changes,
    })
}

#[derive(Default)]
pub struct AssistantState {
    pub config: Option<AssistantConfig>,
    pub saving: bool,
    pub error: Option<String>,
}

impl AssistantState {
    pub fn hydrate(&mut self, settings: &serde_json::Map<String, serde_json::Value>) {
        self.config = Some(parse_assistant_config(settings));
    }

    fn config(&self) -> AssistantConfig {
        self.config.clone().unwrap_or_default()
    }

    /// Persist a full config snapshot (background write) and mirror it into
    /// local state immediately so the UI never waits on the disk write.
    fn save(
        &mut self,
        config: AssistantConfig,
        services: &SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.saving {
            return;
        }
        self.saving = true;
        self.error = None;
        self.config = Some(config.clone());
        let services = services.clone();
        let patch = assistant_patch(&config);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let mut root = serde_json::Map::new();
                    root.insert(ASSISTANT_SETTINGS_KEY.to_string(), patch);
                    services.config.set_settings(&root, &|| true).is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                this.assistant.saving = false;
                if !result {
                    this.assistant.error =
                        Some("The assistant settings could not be saved.".to_string());
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

impl SettingsView {
    /// The Assistant section: proactivity + permission + workspace scope.
    pub(crate) fn assistant_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let config = self.assistant.config();
        v_flex()
            .id("assistant-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Assistant"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(
                                "Shape how the Aiden assistant behaves. Changes are saved \
                                 automatically.",
                            ),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
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
                                v_flex()
                                    .gap_0p5()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Background suggestions"),
                                    )
                                    .child(
                                        div().text_xs().text_color(theme.muted_foreground).child(
                                            "Allow the assistant to watch your workspace and \
                                                 propose proactive nudges. Off by default.",
                                        ),
                                    ),
                            )
                            .child(
                                Switch::new("assistant-enabled")
                                    .checked(config.enabled)
                                    .label(if config.enabled { "On" } else { "Off" })
                                    .disabled(self.assistant.saving)
                                    .on_click(cx.listener(|this, checked, _window, cx| {
                                        let mut next = this.assistant.config();
                                        next.enabled = *checked;
                                        this.assistant.save(next, &this.services, cx);
                                    })),
                            ),
                    )
                    .when(config.enabled, |el| {
                        el.child(
                            v_flex()
                                .w_full()
                                .gap_2()
                                .child(
                                    div()
                                        .text_xs()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.muted_foreground)
                                        .child("Settings permission"),
                                )
                                .child(
                                    h_flex().w_full().gap_2().children(
                                        [
                                            AssistantPermission::Full,
                                            AssistantPermission::Ask,
                                            AssistantPermission::None,
                                        ]
                                        .into_iter()
                                        .map(
                                            |permission| {
                                                let active =
                                                    config.settings_permission == permission;
                                                let mut button =
                                                    Button::new(SharedString::from(format!(
                                                        "assistant-permission-{}",
                                                        permission.as_str()
                                                    )))
                                                    .outline()
                                                    .small();
                                                if active {
                                                    button = button.primary();
                                                }
                                                button
                                                    .label(permission.label())
                                                    .disabled(self.assistant.saving)
                                                    .on_click(cx.listener(
                                                        move |this, _event, _window, cx| {
                                                            let mut next = this.assistant.config();
                                                            next.settings_permission = permission;
                                                            this.assistant.save(
                                                                next,
                                                                &this.services,
                                                                cx,
                                                            );
                                                        },
                                                    ))
                                            },
                                        ),
                                    ),
                                )
                                .child(div().text_xs().text_color(theme.muted_foreground).child(
                                    match config.settings_permission {
                                        AssistantPermission::Full => {
                                            "The assistant may change app settings directly."
                                        }
                                        AssistantPermission::Ask => {
                                            "The assistant asks before changing app settings."
                                        }
                                        AssistantPermission::None => {
                                            "The assistant cannot change app settings."
                                        }
                                    },
                                )),
                        )
                    })
                    .child(
                        v_flex()
                            .w_full()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.muted_foreground)
                                    .child("Workspace scope"),
                            )
                            .child(self.scope_toggle(
                                WatchField::Uncommitted,
                                "Watch uncommitted changes",
                                "Notice edits and uncommitted work in the active workspace.",
                                config.watch_uncommitted,
                                cx,
                            ))
                            .child(self.scope_toggle(
                                WatchField::UntouchedProjects,
                                "Watch untouched projects",
                                "Notice projects that have not been touched recently.",
                                config.watch_untouched_projects,
                                cx,
                            ))
                            .child(self.scope_toggle(
                                WatchField::ConfigChanges,
                                "Watch config changes",
                                "Notice changes to Aiden's portable config file.",
                                config.watch_config_changes,
                                cx,
                            )),
                    ),
            )
            .when_some(self.assistant.error.clone(), |el, message| {
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
    }

    /// One workspace-scope toggle row.
    fn scope_toggle(
        &self,
        field: WatchField,
        label: &str,
        description: &str,
        checked: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let field_key = field.settings_key();
        h_flex()
            .id(SharedString::from(format!(
                "assistant-{}-toggle",
                field.key()
            )))
            .w_full()
            .items_center()
            .justify_between()
            .gap_3()
            .child(
                v_flex()
                    .gap_0p5()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(label.to_string()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(description.to_string()),
                    ),
            )
            .child(
                Switch::new(SharedString::from(format!(
                    "assistant-{}-switch",
                    field.key()
                )))
                .checked(checked)
                .label(if checked { "On" } else { "Off" })
                .disabled(self.assistant.saving)
                .on_click(cx.listener(move |this, is_checked, _window, cx| {
                    let mut next = this.assistant.config();
                    match field_key {
                        "watchUncommitted" => next.watch_uncommitted = *is_checked,
                        "watchUntouchedProjects" => next.watch_untouched_projects = *is_checked,
                        "watchConfigChanges" => next.watch_config_changes = *is_checked,
                        _ => {}
                    }
                    this.assistant.save(next, &this.services, cx);
                })),
            )
    }
}

/// Which assistant workspace signal a scope toggle controls.
#[derive(Debug, Clone, Copy)]
enum WatchField {
    Uncommitted,
    UntouchedProjects,
    ConfigChanges,
}

impl WatchField {
    fn key(self) -> &'static str {
        match self {
            WatchField::Uncommitted => "uncommitted",
            WatchField::UntouchedProjects => "untouched",
            WatchField::ConfigChanges => "config",
        }
    }

    fn settings_key(self) -> &'static str {
        match self {
            WatchField::Uncommitted => "watchUncommitted",
            WatchField::UntouchedProjects => "watchUntouchedProjects",
            WatchField::ConfigChanges => "watchConfigChanges",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(config: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();
        map.insert(ASSISTANT_SETTINGS_KEY.to_string(), config);
        map
    }

    #[test]
    fn absent_assistant_key_yields_defaults() {
        let config = parse_assistant_config(&serde_json::Map::new());
        assert!(!config.enabled);
        assert_eq!(config.settings_permission, AssistantPermission::Ask);
        assert!(config.watch_uncommitted);
        assert!(config.watch_untouched_projects);
        assert!(config.watch_config_changes);
    }

    #[test]
    fn parses_the_editable_subset_and_ignores_unknown_fields() {
        let settings = settings_with(serde_json::json!({
            "enabled": true,
            "settingsPermission": "full",
            "watchUncommitted": false,
            "hotkeyEnabled": true,
            "pollIntervalMinutes": 5,
        }));
        let config = parse_assistant_config(&settings);
        assert!(config.enabled);
        assert_eq!(config.settings_permission, AssistantPermission::Full);
        assert!(!config.watch_uncommitted);
        // Defaults for the fields not present.
        assert!(config.watch_untouched_projects);
        assert!(config.watch_config_changes);
    }

    #[test]
    fn invalid_permission_falls_back_to_ask() {
        let settings = settings_with(serde_json::json!({ "settingsPermission": "root" }));
        let config = parse_assistant_config(&settings);
        assert_eq!(config.settings_permission, AssistantPermission::Ask);
    }

    #[test]
    fn patch_roundtrips_through_parse() {
        let config = AssistantConfig {
            enabled: true,
            settings_permission: AssistantPermission::None,
            watch_uncommitted: false,
            watch_untouched_projects: true,
            watch_config_changes: false,
        };
        let mut map = serde_json::Map::new();
        map.insert(ASSISTANT_SETTINGS_KEY.to_string(), assistant_patch(&config));
        assert_eq!(parse_assistant_config(&map), config);
    }
}
