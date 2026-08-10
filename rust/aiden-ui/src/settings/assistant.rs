//! Truthful Assistant settings.
//!
//! The attended Assistant panel has no independently persisted behavior
//! preferences. This surface therefore reports live product boundaries rather
//! than presenting controls that no runtime consumes.

use gpui::{
    div, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, Disableable as _, Sizable as _,
};

use super::{SettingsSection, SettingsView};
use aiden_core::keybindings::GlobalShortcutState;

#[derive(Default)]
pub struct AssistantState {
    _runtime_facts: (),
}

impl AssistantState {
    /// Kept as a no-op while the settings bootstrap hydrates every section.
    /// The Assistant settings shown here are runtime facts, not saved intent.
    pub fn hydrate(&mut self, _settings: &serde_json::Map<String, serde_json::Value>) {}
}

impl SettingsView {
    pub(crate) fn assistant_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let global_status = self
            .services
            .shortcuts
            .read(cx)
            .snapshot()
            .global
            .iter()
            .find(|status| status.command_id == aiden_core::CommandId::AssistantOpen)
            .cloned();
        let (shortcut_value, shortcut_detail, can_retry) = match global_status {
            Some(status) => match status.state {
                GlobalShortcutState::Active => (
                    format!(
                        "{} · Active",
                        aiden_core::keybindings::pretty_accelerator(status.binding.as_deref())
                    ),
                    "Available while Aiden is running.".to_string(),
                    false,
                ),
                GlobalShortcutState::Unavailable => (
                    format!(
                        "{} · Unavailable",
                        aiden_core::keybindings::pretty_accelerator(status.binding.as_deref())
                    ),
                    status.message.unwrap_or_else(|| {
                        "The global shortcut could not be registered.".to_string()
                    }),
                    true,
                ),
                GlobalShortcutState::Disabled => (
                    "Off".to_string(),
                    "The global Assistant shortcut is disabled.".to_string(),
                    false,
                ),
            },
            None => (
                "Unavailable".to_string(),
                "Shortcut runtime status is unavailable.".to_string(),
                true,
            ),
        };

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
                            .child("Current behavior and access boundaries for the attended Assistant panel."),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .children([
                        assistant_fact_row(
                            "assistant-model",
                            "Chat model",
                            "Loaded when Assistant opens",
                            "Uses the composer selection captured when this Assistant panel was created. Reopen Aiden to reload a later model change.",
                            &theme,
                        ),
                        assistant_fact_row(
                            "assistant-history",
                            "History",
                            "Current app session",
                            "Closing or resetting the Assistant panel clears its conversation.",
                            &theme,
                        ),
                        assistant_fact_row(
                            "assistant-access",
                            "Access boundaries",
                            "Attended tools only",
                            "Can list configured projects and servers, propose scheduled automations, and call enabled MCP connector tools. It has no direct app-settings tool.",
                            &theme,
                        ),
                        assistant_fact_row(
                            "assistant-background",
                            "Background suggestions",
                            "Not active",
                            "The Assistant does not watch the workspace or send proactive suggestions.",
                            &theme,
                        ),
                    ])
                    .child(
                        h_flex()
                            .id("assistant-global-shortcut")
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap_4()
                            .px_4()
                            .py_3()
                            .border_t_1()
                            .border_color(theme.border)
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w(gpui::px(0.))
                                    .gap_0p5()
                                    .child(
                                        h_flex()
                                            .gap_2()
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .child("Global shortcut"),
                                            )
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .text_color(theme.muted_foreground)
                                                    .child(shortcut_value),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .child(shortcut_detail),
                                    ),
                            )
                            .child(
                                Button::new("assistant-retry-shortcut")
                                    .small()
                                    .ghost()
                                    .label("Retry")
                                    .disabled(!can_retry)
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        this.services.shortcuts.update(cx, |runtime, cx| {
                                            runtime.retry_globals(cx)
                                        });
                                    })),
                            )
                            .child(
                                Button::new("assistant-manage-shortcut")
                                    .small()
                                    .ghost()
                                    .label("Manage")
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        this.active = SettingsSection::Shortcut;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
    }
}

fn assistant_fact_row(
    id: &'static str,
    title: &'static str,
    value: &'static str,
    detail: &'static str,
    theme: &gpui_component::Theme,
) -> impl IntoElement {
    h_flex()
        .id(SharedString::from(id))
        .w_full()
        .items_start()
        .justify_between()
        .gap_4()
        .px_4()
        .py_3()
        .border_b_1()
        .border_color(theme.border)
        .child(
            v_flex()
                .flex_1()
                .min_w(gpui::px(0.))
                .gap_0p5()
                .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title))
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(detail),
                ),
        )
        .child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(value),
        )
}

#[cfg(test)]
mod tests {
    const SOURCE: &str = include_str!("assistant.rs");

    #[test]
    fn dormant_preferences_are_absent() {
        for dormant_id in [
            concat!("assistant", "-enabled"),
            concat!("settings", "Permission"),
            concat!("watch", "Uncommitted"),
            concat!("watch", "UntouchedProjects"),
            concat!("watch", "ConfigChanges"),
        ] {
            assert!(
                !SOURCE.contains(dormant_id),
                "found dormant id {dormant_id}"
            );
        }
    }

    #[test]
    fn history_and_background_copy_match_runtime_behavior() {
        assert!(SOURCE.contains("Current app session"));
        assert!(SOURCE.contains("Background suggestions"));
        assert!(SOURCE.contains("Not active"));
        assert!(!SOURCE.contains(concat!("device-local", " history")));
        assert!(!SOURCE.contains(concat!("Changes are saved", " automatically")));
    }

    #[test]
    fn model_copy_does_not_claim_live_following() {
        assert!(SOURCE.contains("Loaded when Assistant opens"));
        assert!(!SOURCE.contains(concat!("Follows", " composer")));
    }
}
