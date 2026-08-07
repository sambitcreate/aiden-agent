//! The chat pane: message transcript, empty states, and the composer.

use gpui::{
    div, prelude::FluentBuilder as _, px, Context, InteractiveElement as _, IntoElement,
    ParentElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::Input,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _, WindowExt,
};

use crate::app::AppState;
use crate::services::chat_service::ChatSnapshot;

impl AppState {
    /// The main chat area: message list + composer (+ empty states).
    pub(crate) fn chat_pane(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let snapshot = self.service.read(cx).snapshot();

        v_flex()
            .id("chat-pane")
            .flex_1()
            .h_full()
            .min_w(px(0.))
            .bg(theme.background)
            .child(self.chat_empty_or_list(&snapshot, window, cx))
            .child(self.composer(&snapshot, window, cx))
    }

    /// Empty states (no chats yet, no chat selected, no providers) or the
    /// message transcript.
    fn chat_empty_or_list(
        &self,
        snapshot: &ChatSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = cx.theme();
        let no_messages = snapshot.messages.is_empty() && snapshot.generation.is_none();

        if !no_messages {
            return self.message_list(window, cx).into_any_element();
        }

        let has_chats = !self.service.read(cx).filtered_chats().is_empty();
        let body = if !snapshot.has_providers {
            // No provider configured: inline notice with a settings action.
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    v_flex()
                        .gap_1()
                        .child(
                            div()
                                .text_base()
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .child("No providers configured yet"),
                        )
                        .child(
                            div().text_sm().text_color(theme.muted_foreground).child(
                                "Add a provider in Settings to start chatting with a model.",
                            ),
                        ),
                )
                .child(
                    Button::new("open-settings-placeholder")
                        .small()
                        .label("Open Settings")
                        .on_click(cx.listener(|this, _event, window, cx| {
                            window.push_notification("Settings will arrive in a later phase.", cx);
                            let _ = this;
                        })),
                )
                .into_any_element()
        } else if !has_chats {
            // Quiet empty state: no chats at all (per PRODUCT.md, no
            // decorative buttons).
            v_flex()
                .gap_2()
                .items_center()
                .child(
                    Icon::new(IconName::Bot)
                        .small()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    div()
                        .text_lg()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(theme.foreground)
                        .child("Welcome to Aiden"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Press ⌘N for a new chat, or type below to begin."),
                )
                .into_any_element()
        } else {
            // Chat selected but empty.
            v_flex()
                .gap_1()
                .items_center()
                .child(
                    div()
                        .text_base()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child("New chat"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Ask anything to get started."),
                )
                .into_any_element()
        };

        v_flex()
            .id("chat-empty")
            .flex_1()
            .w_full()
            .items_center()
            .justify_center()
            .gap_3()
            .child(body)
            .into_any_element()
    }

    /// The composer: multiline input + send/stop button (+ model label).
    fn composer(
        &self,
        snapshot: &ChatSnapshot,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let generating = snapshot
            .generation
            .as_ref()
            .is_some_and(|generation| !generation.complete);
        let text = self.composer_input.read(cx).value().to_string();
        let has_text = !text.trim().is_empty();
        let can_send = has_text
            && !generating
            && snapshot.has_providers
            && snapshot.has_key_for_selection
            && snapshot.selection.is_some();

        let readiness = if !snapshot.has_providers {
            Some("Select a provider and model to start chatting.".to_string())
        } else if snapshot.selection.is_none() {
            Some("Pick a model from the sidebar to start chatting.".to_string())
        } else if !snapshot.has_key_for_selection {
            Some("The selected provider has no API key yet.".to_string())
        } else {
            None
        };

        v_flex().id("composer").w_full().px_4().pb_4().pt_2().child(
            v_flex()
                .w_full()
                .rounded_2xl()
                .bg(theme.popover)
                .border_1()
                .border_color(theme.border)
                .shadow_md()
                .px_3()
                .py_2()
                .gap_1()
                .child(
                    Input::new(&self.composer_input)
                        .appearance(false)
                        .bordered(false)
                        .focus_bordered(true),
                )
                .when_some(readiness, |el, message| {
                    el.child(
                        div()
                            .px_1p5()
                            .pb_1()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(message),
                    )
                })
                .child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .child(
                            snapshot
                                .selection
                                .as_ref()
                                .map(|selection| {
                                    div()
                                        .px_1p5()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .truncate()
                                        .child(format!(
                                            "{} · {}",
                                            selection.provider_id, selection.model
                                        ))
                                        .into_any_element()
                                })
                                .unwrap_or_else(|| div().into_any_element()),
                        )
                        .child(if generating {
                            Button::new("composer-stop")
                                .primary()
                                .small()
                                .icon(IconName::Close)
                                .tooltip("Stop generating")
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.service.update(cx, |service, cx| {
                                        service.stop_generation(cx);
                                    });
                                }))
                                .into_any_element()
                        } else {
                            Button::new("composer-send")
                                .primary()
                                .small()
                                .icon(IconName::ArrowUp)
                                .disabled(!can_send)
                                .tooltip("Send message (Enter)")
                                .on_click(cx.listener(|this, _event, window, cx| {
                                    let text = this.composer_input.read(cx).value().to_string();
                                    this.send_composer(&text, window, cx);
                                }))
                                .into_any_element()
                        }),
                ),
        )
    }
}
