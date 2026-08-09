//! Computer use settings (port of `computer-use-settings.tsx`, reduced).
//!
//! The persisted surface is the flat `computerUseEnabled` flag in
//! `settings.json` (the same key the TS helper and the chat service read).
//! This section wires the enable toggle + the safety posture explainer; the
//! signed-helper readiness check (`cua-driver` status, Accessibility / Screen
//! Recording probes) is not wired into the GPUI build yet, so that row shows a
//! "coming soon" note instead of a fake status.

use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Styled as _, Window,
};
use gpui_component::{h_flex, switch::Switch, v_flex, ActiveTheme, Disableable as _};

use super::SettingsView;

/// The settings key holding the computer-use flag.
pub const COMPUTER_USE_ENABLED_KEY: &str = "computerUseEnabled";

/// Read the persisted enable flag from the settings map.
pub fn computer_use_enabled_from_settings(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    settings
        .get(COMPUTER_USE_ENABLED_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

#[derive(Default)]
pub struct ComputerUseState {
    pub enabled: bool,
    pub saving: bool,
    pub error: Option<String>,
}

impl ComputerUseState {
    pub fn hydrate(&mut self, settings: &serde_json::Map<String, serde_json::Value>) {
        self.enabled = computer_use_enabled_from_settings(settings);
    }

    fn services(&self, cx: &mut Context<SettingsView>) -> super::SettingsServices {
        cx.entity().read(cx).services.clone()
    }

    /// Persist the enable flag on the background executor.
    fn set_enabled(&mut self, enabled: bool, cx: &mut Context<SettingsView>) {
        if self.saving {
            return;
        }
        self.saving = true;
        self.error = None;
        self.enabled = enabled;
        let services = self.services(cx);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let mut patch = serde_json::Map::new();
                    patch.insert(
                        COMPUTER_USE_ENABLED_KEY.to_string(),
                        serde_json::json!(enabled),
                    );
                    services.config.set_settings(&patch, &|| true).is_ok()
                })
                .await;
            this.update(cx, |this, cx| {
                this.computer_use.saving = false;
                if !result {
                    this.computer_use.error =
                        Some("Computer use settings could not be saved.".to_string());
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
    /// The Computer use section: enable toggle + safety posture + readiness
    /// (coming soon).
    pub(crate) fn computer_use_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let state = &self.computer_use;
        v_flex()
            .id("computer-use-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Computer use"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(
                                "Makes Aiden's pinned external cua-driver available as an \
                                 opt-in tool in individual chats.",
                            ),
                    ),
            )
            .child(
                v_flex()
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
                                v_flex()
                                    .gap_0p5()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Enable Computer Use"),
                                    )
                                    .child(
                                        div().text_xs().text_color(theme.muted_foreground).child(
                                            "When enabled, individual chats can opt in to the \
                                                 Computer Use tool.",
                                        ),
                                    ),
                            )
                            .child(
                                Switch::new("computer-use-enabled")
                                    .checked(state.enabled)
                                    .label(if state.enabled { "On" } else { "Off" })
                                    .disabled(state.saving)
                                    .on_click(cx.listener(|this, checked, _window, cx| {
                                        this.computer_use.set_enabled(*checked, cx);
                                    })),
                            ),
                    )
                    .child(
                        v_flex()
                            .w_full()
                            .gap_1()
                            .child(
                                h_flex()
                                    .w_full()
                                    .items_center()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Readiness"),
                                    )
                                    .child(
                                        div()
                                            .px_1p5()
                                            .py_0p5()
                                            .rounded_md()
                                            .bg(theme.muted_foreground.opacity(0.14))
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .child("Coming soon"),
                                    ),
                            )
                            .child(div().text_xs().text_color(theme.muted_foreground).child(
                                "Checking the signed Computer Use helper (Accessibility \
                                         and Screen Recording probes) is not wired into this \
                                         build yet. The enable toggle above persists and the \
                                         chat service already consults it.",
                            )),
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
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("How it behaves"),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        "Only chats you turn on can use Computer Use. For those \
                                 responses, your selected model may receive screenshots, window \
                                 details, and accessibility text. Aiden doesn't save that \
                                 content; your provider handles it under its data policy. \
                                 Read-only inspection runs without prompts, while every control \
                                 action requires Allow once.",
                    ))
                    .child(
                        h_flex()
                            .w_full()
                            .gap_2()
                            .child(
                                div()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_md()
                                    .bg(theme.info.opacity(0.14))
                                    .text_xs()
                                    .text_color(theme.info)
                                    .child("Per-chat opt-in"),
                            )
                            .child(
                                div()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_md()
                                    .bg(theme.info.opacity(0.14))
                                    .text_xs()
                                    .text_color(theme.info)
                                    .child("Actions ask first"),
                            ),
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computer_use_enabled_reads_the_flat_flag() {
        let mut settings = serde_json::Map::new();
        assert!(!computer_use_enabled_from_settings(&settings));
        settings.insert(
            COMPUTER_USE_ENABLED_KEY.to_string(),
            serde_json::json!(true),
        );
        assert!(computer_use_enabled_from_settings(&settings));
        settings.insert(
            COMPUTER_USE_ENABLED_KEY.to_string(),
            serde_json::json!("yes"),
        );
        assert!(!computer_use_enabled_from_settings(&settings));
    }
}
