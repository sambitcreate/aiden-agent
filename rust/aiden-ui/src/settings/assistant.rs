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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssistantBadgeTone {
    Neutral,
    Positive,
    Caution,
    Negative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AssistantFactCopy {
    id: &'static str,
    title: &'static str,
    value: &'static str,
    detail: &'static str,
    tone: AssistantBadgeTone,
}

/// Copy is kept as one static contract so the settings surface cannot drift
/// from the retained Assistant panel's actual boundaries. These are facts,
/// not persisted Assistant preferences.
const ASSISTANT_FACTS: [AssistantFactCopy; 4] = [
    AssistantFactCopy {
        id: "assistant-model",
        title: "Chat model",
        value: "Follows composer",
        detail: "Uses the provider and model selected in the main composer and follows live readiness while the dock is open.",
        tone: AssistantBadgeTone::Positive,
    },
    AssistantFactCopy {
        id: "assistant-history",
        title: "History",
        value: "Current app session",
        detail: "The transcript stays local to this Assistant session; New conversation or resetting the panel clears it.",
        tone: AssistantBadgeTone::Neutral,
    },
    AssistantFactCopy {
        id: "assistant-access",
        title: "Access boundaries",
        value: "Attended tools",
        detail: "Can list configured project and MCP server identities, list scheduled automations, propose new ones, and edit existing ones, plus use configured MCP tools for remote data with per-call approval. It cannot inspect or change app settings, read or write files, run commands, monitor projects in the background, or delegate work.",
        tone: AssistantBadgeTone::Caution,
    },
    AssistantFactCopy {
        id: "assistant-background",
        title: "Background suggestions",
        value: "Not active",
        detail: "Workspace monitoring, proactive suggestions, background runs, and notifications are not active in this build.",
        tone: AssistantBadgeTone::Neutral,
    },
];

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
        let (shortcut_value, shortcut_badge, shortcut_tone, shortcut_detail, can_retry) =
            match global_status {
                Some(status) => match status.state {
                    GlobalShortcutState::Active => (
                        aiden_core::keybindings::pretty_accelerator(status.binding.as_deref())
                            .to_string(),
                        "Active",
                        AssistantBadgeTone::Positive,
                        "Available while Aiden is running.".to_string(),
                        false,
                    ),
                    GlobalShortcutState::Unavailable => (
                        aiden_core::keybindings::pretty_accelerator(status.binding.as_deref())
                            .to_string(),
                        "Unavailable",
                        AssistantBadgeTone::Negative,
                        status.message.unwrap_or_else(|| {
                            "The global shortcut could not be registered.".to_string()
                        }),
                        true,
                    ),
                    GlobalShortcutState::Disabled => (
                        "—".to_string(),
                        "Off",
                        AssistantBadgeTone::Neutral,
                        "The global Assistant shortcut is disabled.".to_string(),
                        false,
                    ),
                },
                None => (
                    "—".to_string(),
                    "Unavailable",
                    AssistantBadgeTone::Negative,
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
                    .children(ASSISTANT_FACTS.iter().map(|fact| assistant_fact_row(*fact, &theme)))
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
                                            .child(assistant_badge(
                                                shortcut_badge,
                                                shortcut_tone,
                                                &theme,
                                            ))
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

fn assistant_fact_row(fact: AssistantFactCopy, theme: &gpui_component::Theme) -> impl IntoElement {
    h_flex()
        .id(SharedString::from(fact.id))
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
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child(fact.title),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(fact.detail),
                ),
        )
        .child(assistant_badge(fact.value, fact.tone, theme))
}

fn assistant_badge(
    label: &'static str,
    tone: AssistantBadgeTone,
    theme: &gpui_component::Theme,
) -> impl IntoElement {
    let (background, foreground) = match tone {
        AssistantBadgeTone::Neutral => (theme.muted_foreground, theme.muted_foreground),
        AssistantBadgeTone::Positive => (theme.success, theme.success),
        AssistantBadgeTone::Caution => (theme.warning, theme.warning),
        AssistantBadgeTone::Negative => (theme.danger, theme.danger),
    };
    div()
        .rounded_full()
        .bg(background.opacity(0.14))
        .text_color(foreground)
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .px_2()
        .py_0p5()
        .child(label)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(SOURCE.contains("stays local to this Assistant session"));
        assert!(SOURCE.contains("Background suggestions"));
        assert!(SOURCE.contains("Not active"));
        assert!(SOURCE.contains("background runs"));
        assert!(!SOURCE.contains(concat!("device-local", " history")));
        assert!(!SOURCE.contains(concat!("Changes are saved", " automatically")));
    }

    #[test]
    fn model_copy_tracks_live_composer_selection() {
        assert!(SOURCE.contains("Follows composer"));
        assert!(SOURCE.contains("follows live readiness"));
        assert!(!SOURCE.contains(concat!("Loaded when ", "Assistant opens")));
        assert!(!SOURCE.contains(concat!("Reopen Aiden to ", "reload")));
    }

    #[test]
    fn access_copy_names_the_attended_boundary_without_false_capabilities() {
        assert!(SOURCE.contains("Attended tools"));
        assert!(SOURCE.contains("configured project and MCP server identities"));
        assert!(SOURCE.contains("scheduled automations"));
        assert!(SOURCE.contains("configured MCP tools for remote data"));
        assert!(SOURCE.contains("per-call approval"));
        for unavailable in [
            "inspect or change app settings",
            "read or write files",
            "run commands",
            "monitor projects in the background",
            "delegate work",
        ] {
            assert!(
                SOURCE.contains(unavailable),
                "missing boundary: {unavailable}"
            );
        }
        assert!(!SOURCE.contains(concat!("Automations", " only")));
        assert!(!SOURCE.contains(concat!("cannot use ", "connected tools")));
    }

    #[test]
    fn fact_rows_have_stable_ids_and_semantic_badges() {
        assert_eq!(ASSISTANT_FACTS.len(), 4);
        assert!(ASSISTANT_FACTS.iter().all(|fact| {
            !fact.id.is_empty() && !fact.title.is_empty() && !fact.value.is_empty()
        }));
        assert_eq!(
            ASSISTANT_FACTS
                .iter()
                .find(|fact| fact.id == "assistant-model")
                .map(|fact| fact.tone),
            Some(AssistantBadgeTone::Positive)
        );
        assert_eq!(
            ASSISTANT_FACTS
                .iter()
                .find(|fact| fact.id == "assistant-access")
                .map(|fact| fact.tone),
            Some(AssistantBadgeTone::Caution)
        );
    }
}
