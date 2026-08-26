//! The chat pane: message transcript, empty states, and the composer.

use std::rc::Rc;

use gpui::{
    div, img, prelude::FluentBuilder as _, px, Context, InteractiveElement as _, IntoElement,
    ParentElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::Input,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _,
};

use crate::app::AppState;
use crate::approvals::tool_approval_card::tool_approval_card;
use crate::chat::message_list::cached_attachment_image;
use crate::services::chat_service::ChatSnapshot;
use crate::services::provider_kit::ThinkingControlSnapshot;

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
            .child(self.workspace_bar(window, cx))
            .child(self.chat_empty_or_list(&snapshot, window, cx))
            .when_some(snapshot.approval.clone(), |element, approval| {
                element.child(self.chat_approval(&approval, snapshot.deciding_approval, cx))
            })
            .child(self.composer(&snapshot, window, cx))
    }

    fn chat_approval(
        &self,
        approval: &crate::approvals::queue::PendingApproval,
        deciding: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let approval_id = approval.approval_id.clone();
        let decision_tx = self.service.read(cx).approval_decision_sender();
        div().w_full().px_4().pb_2().child(tool_approval_card(
            theme,
            approval,
            deciding,
            Rc::new(move |decision| {
                let _ = decision_tx.send((approval_id.clone(), decision));
            }),
        ))
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
        let body =
            if !snapshot.has_providers {
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
                            .child(div().text_sm().text_color(theme.muted_foreground).child(
                                "Add a provider in Settings to start chatting with a model.",
                            )),
                    )
                    .child(
                        Button::new("open-settings")
                            .small()
                            .label("Open Settings")
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.open_settings_section(window, cx);
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
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let generating = snapshot
            .generation
            .as_ref()
            .is_some_and(|generation| !generation.complete);
        let text = self.composer_input.read(cx).value().to_string();
        let has_text = !text.trim().is_empty();
        let has_attachments = !self.composer_attachments.is_empty();
        let has_images = self
            .composer_attachments
            .iter()
            .any(|attachment| attachment.kind == aiden_core::AttachmentKind::Image);
        let incompatible_images = has_images && snapshot.supports_images == Some(false);
        let can_send = (has_text || has_attachments)
            && !generating
            && !snapshot.pending_send
            && !self.attaching_files
            && !incompatible_images
            && !snapshot.thinking_saving
            && snapshot.ready_for_send
            && snapshot.has_providers
            && snapshot.has_key_for_selection
            && snapshot.selection.is_some();

        let readiness = if incompatible_images {
            Some("Switch to a vision-capable model before sending these images.".to_string())
        } else if !snapshot.has_providers {
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
                .when(!self.composer_attachments.is_empty(), |composer| {
                    composer.child(
                        h_flex().w_full().flex_wrap().gap_1().children(
                            self.composer_attachments.iter().enumerate().map(
                                |(index, attachment)| {
                                    let id = attachment.id.clone();
                                    let name = attachment.name.clone();
                                    let preview = cached_attachment_image(
                                        attachment,
                                        format!("draft:{}", attachment.id),
                                        &self.attachment_image_cache,
                                    );
                                    h_flex()
                                        .max_w(px(260.))
                                        .items_center()
                                        .gap_1()
                                        .rounded_lg()
                                        .border_1()
                                        .border_color(theme.border)
                                        .bg(theme.secondary)
                                        .pl_2()
                                        .child(preview.map_or_else(
                                            || {
                                                Icon::new(IconName::File)
                                                    .xsmall()
                                                    .text_color(theme.muted_foreground)
                                                    .into_any_element()
                                            },
                                            |image| {
                                                img(image)
                                                    .size(px(28.))
                                                    .rounded_md()
                                                    .into_any_element()
                                            },
                                        ))
                                        .child(div().text_xs().truncate().child(name.clone()))
                                        .child(
                                            Button::new(("remove-attachment", index))
                                                .ghost()
                                                .xsmall()
                                                .icon(IconName::Close)
                                                .disabled(snapshot.pending_send)
                                                .tooltip(format!("Remove {name}"))
                                                .on_click(cx.listener(
                                                    move |this, _event, _window, cx| {
                                                        this.remove_composer_attachment(&id, cx);
                                                    },
                                                )),
                                        )
                                },
                            ),
                        ),
                    )
                })
                .child(
                    Input::new(&self.composer_input)
                        .appearance(false)
                        .bordered(false)
                        .focus_bordered(true)
                        .disabled(snapshot.pending_send),
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
                .when_some(snapshot.thinking_error.clone(), |el, message| {
                    el.child(
                        div()
                            .px_1p5()
                            .pb_1()
                            .text_xs()
                            .text_color(theme.danger)
                            .child(message),
                    )
                })
                .when_some(self.attachment_error.clone(), |el, message| {
                    el.child(
                        div()
                            .px_1p5()
                            .pb_1()
                            .text_xs()
                            .text_color(theme.danger)
                            .child(message),
                    )
                })
                .child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .child(
                            h_flex()
                                .items_center()
                                .min_w(px(0.))
                                .gap_1()
                                .child(
                                    Button::new("composer-attach")
                                        .ghost()
                                        .xsmall()
                                        .icon(if self.attaching_files {
                                            IconName::LoaderCircle
                                        } else {
                                            IconName::Plus
                                        })
                                        .disabled(
                                            self.attaching_files
                                                || generating
                                                || snapshot.pending_send
                                                || !snapshot.ready_for_send,
                                        )
                                        .tooltip("Attach files or images")
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.attach_files(cx);
                                        })),
                                )
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
                                ),
                        )
                        .child(
                            h_flex()
                                .min_w(px(0.))
                                .items_center()
                                .gap_1p5()
                                .when_some(snapshot.thinking.clone(), |row, thinking| {
                                    row.child(self.thinking_control(
                                        &thinking,
                                        snapshot.thinking_saving || generating,
                                        window,
                                        cx,
                                    ))
                                })
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
                                            let text =
                                                this.composer_input.read(cx).value().to_string();
                                            this.send_composer(&text, window, cx);
                                        }))
                                        .into_any_element()
                                }),
                        ),
                ),
        )
    }

    fn thinking_control(
        &self,
        control: &ThinkingControlSnapshot,
        disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let levels = control.levels.clone();
        let current = control.level;
        // Button owns a keyed FocusHandle internally. Resolve those same keys
        // here so arrow/Home/End can implement real roving focus, not merely
        // change the persisted value under the old focused button.
        let focus_handles: Vec<_> = control
            .levels
            .iter()
            .enumerate()
            .map(|(index, _)| {
                window
                    .use_keyed_state(("thinking-level", index), cx, |_, cx| cx.focus_handle())
                    .read(cx)
                    .clone()
            })
            .collect();
        let theme = cx.theme();
        h_flex()
            .id("composer-thinking-control")
            .h(px(28.))
            .items_center()
            .rounded_full()
            .bg(theme.muted.opacity(0.5))
            .p(px(2.))
            .on_key_down(
                cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                    if disabled {
                        return;
                    }
                    if let Some(next) =
                        thinking_level_for_key(&levels, current, &event.keystroke.key)
                    {
                        this.service.update(cx, |service, cx| {
                            service.set_thinking_level(next, cx);
                        });
                        if let Some(index) = levels.iter().position(|level| *level == next) {
                            focus_handles[index].focus(window);
                        }
                        cx.stop_propagation();
                    }
                }),
            )
            .children(control.levels.iter().enumerate().map(|(index, level)| {
                let selected = *level == control.level;
                let hides_minimum =
                    *level == aiden_core::GenerationThinkingLevel::Off && !control.can_disable;
                let label = if hides_minimum {
                    "Hide"
                } else {
                    match level {
                        aiden_core::GenerationThinkingLevel::Off => "Off",
                        aiden_core::GenerationThinkingLevel::Low => "Low",
                        aiden_core::GenerationThinkingLevel::Medium => "Med",
                        aiden_core::GenerationThinkingLevel::High => "High",
                        aiden_core::GenerationThinkingLevel::Xhigh => "XHigh",
                        aiden_core::GenerationThinkingLevel::Max => "Max",
                    }
                };
                let tooltip = if hides_minimum {
                    "Hide model thoughts (this model still uses its minimum thinking level)"
                        .to_string()
                } else {
                    format!("{} thinking: {}", control.provider_label, level.as_str())
                };
                let next = *level;
                Button::new(("thinking-level", index))
                    .small()
                    .label(label)
                    .tooltip(tooltip)
                    .disabled(disabled)
                    .tab_stop(selected)
                    .when(selected, |button| button.primary())
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.service.update(cx, |service, cx| {
                            service.set_thinking_level(next, cx);
                        });
                    }))
            }))
    }
}

fn thinking_level_for_key(
    levels: &[aiden_core::GenerationThinkingLevel],
    current: aiden_core::GenerationThinkingLevel,
    key: &str,
) -> Option<aiden_core::GenerationThinkingLevel> {
    let current_index = levels.iter().position(|level| *level == current)?;
    let next_index = match key {
        "left" | "up" => current_index.checked_sub(1).unwrap_or(levels.len() - 1),
        "right" | "down" => (current_index + 1) % levels.len(),
        "home" => 0,
        "end" => levels.len() - 1,
        _ => return None,
    };
    levels.get(next_index).copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::GenerationThinkingLevel::{High, Low, Medium, Off};

    #[test]
    fn thinking_keyboard_navigation_wraps_and_supports_home_end() {
        let levels = [Off, Low, Medium, High];
        assert_eq!(thinking_level_for_key(&levels, Off, "left"), Some(High));
        assert_eq!(thinking_level_for_key(&levels, High, "right"), Some(Off));
        assert_eq!(thinking_level_for_key(&levels, Medium, "up"), Some(Low));
        assert_eq!(thinking_level_for_key(&levels, Low, "down"), Some(Medium));
        assert_eq!(thinking_level_for_key(&levels, Medium, "home"), Some(Off));
        assert_eq!(thinking_level_for_key(&levels, Low, "end"), Some(High));
        assert_eq!(thinking_level_for_key(&levels, Low, "escape"), None);
    }
}
