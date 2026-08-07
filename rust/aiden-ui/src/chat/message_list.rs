//! Message transcript: user bubbles, assistant markdown (via gpui-component's
//! `TextView`), collapsible thinking blocks, the streaming assistant bubble,
//! and the terminal error banner with retry.

use aiden_core::{ChatMessage, ChatRole};
use gpui::{
    div, prelude::FluentBuilder as _, px, relative, App, Context, ElementId, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    spinner::Spinner,
    text::TextView,
    v_flex, ActiveTheme, Icon, IconName, Sizable as _,
};

use crate::app::AppState;
use crate::chat::activity_feed::timeline_feed;
use crate::services::chat_service::{ChatSnapshot, GenerationState};

impl AppState {
    /// The scrollable transcript. Renders persisted messages, then the live
    /// streaming bubble for the active generation (hidden once the assistant
    /// reply has been persisted back into `messages`).
    pub(crate) fn message_list(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let snapshot = self.service.read(cx).snapshot();
        let scroll = self.message_scroll.clone();
        let show_stream = should_show_stream_bubble(&snapshot);
        let generation = snapshot.generation.clone();

        v_flex()
            .id("message-list")
            .track_scroll(&scroll)
            .flex_1()
            .w_full()
            .overflow_y_scroll()
            .px_4()
            .py_3()
            .gap_2()
            .children(
                snapshot.messages.iter().map(|message| {
                    render_persisted_message(message, window, cx).into_any_element()
                }),
            )
            .when(show_stream, |el| {
                el.child(render_stream_bubble(&generation, window, cx))
            })
    }

    /// Toggle the streaming thinking block's expanded state.
    fn toggle_stream_thinking(&mut self, cx: &mut Context<Self>) {
        self.service.update(cx, |service, _cx| {
            if let Some(generation) = service.generation.as_mut() {
                generation.thinking_expanded = !generation.thinking_expanded;
            }
        });
    }
}

/// Whether the live streaming bubble should render on top of the transcript.
fn should_show_stream_bubble(snapshot: &ChatSnapshot) -> bool {
    let Some(generation) = &snapshot.generation else {
        return false;
    };
    if generation.complete {
        // Hidden once the persisted assistant message landed in the transcript.
        let already_persisted = snapshot.messages.last().is_some_and(|message| {
            message.role == ChatRole::Assistant && message.content == generation.text
        });
        !already_persisted
    } else {
        true
    }
}

// ===========================================================================
// Persisted messages
// ===========================================================================

fn render_persisted_message(
    message: &ChatMessage,
    window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    match message.role {
        ChatRole::User => render_user_bubble(message, cx).into_any_element(),
        ChatRole::Assistant => render_assistant_message(message, window, cx).into_any_element(),
        ChatRole::System => div().into_any_element(),
    }
}

fn render_user_bubble(message: &ChatMessage, cx: &mut App) -> impl IntoElement {
    let muted = cx.theme().muted;
    h_flex()
        .id(ElementId::Name(SharedString::from(format!(
            "user-message-{}",
            message.id
        ))))
        .w_full()
        .justify_end()
        .child(
            div()
                .max_w(relative(0.8))
                .rounded_2xl()
                .bg(muted)
                .px_4()
                .py_2()
                .child(prewrap(&message.content)),
        )
}

fn render_assistant_message(
    message: &ChatMessage,
    window: &mut Window,
    cx: &mut App,
) -> impl IntoElement {
    let muted = cx.theme().muted;
    v_flex()
        .id(ElementId::Name(SharedString::from(format!(
            "assistant-message-{}",
            message.id
        ))))
        .w_full()
        .gap_1()
        // Persisted activity timeline: thinking/tool steps survive reloads
        // via the message's `timeline` field.
        .when_some(
            message
                .timeline
                .as_ref()
                .filter(|timeline| !timeline.steps.is_empty()),
            |el, timeline| el.child(timeline_feed(timeline, false, cx)),
        )
        .when_some(
            message.reasoning.as_ref().filter(|r| !r.trim().is_empty()),
            |el, reasoning| {
                let header_id = ElementId::Name(SharedString::from(format!(
                    "thinking-header-{}",
                    message.id
                )));
                el.child(
                    v_flex()
                        .w_full()
                        .gap_1()
                        .child(thinking_header(header_id, false, None, cx))
                        .child(
                            div()
                                .w_full()
                                .px_3()
                                .py_2()
                                .rounded_md()
                                .bg(muted)
                                .child(prewrap(reasoning)),
                        ),
                )
            },
        )
        .child(
            TextView::markdown(
                ElementId::Name(SharedString::from(format!(
                    "assistant-markdown-{}",
                    message.id
                ))),
                message.content.clone(),
                window,
                cx,
            )
            .style(Default::default()),
        )
}

// ===========================================================================
// Streaming bubble + thinking
// ===========================================================================

fn render_stream_bubble(
    generation: &Option<GenerationState>,
    window: &mut Window,
    cx: &mut Context<AppState>,
) -> impl IntoElement {
    let muted = cx.theme().muted;
    let danger = cx.theme().danger;
    let foreground = cx.theme().foreground;
    let thinking_text = generation
        .as_ref()
        .map(|generation| generation.thinking.clone())
        .unwrap_or_default();
    let thinking_active = generation
        .as_ref()
        .is_some_and(|generation| generation.thinking_active);
    let expanded = generation
        .as_ref()
        .is_some_and(|generation| generation.thinking_expanded);
    let text = generation
        .as_ref()
        .map(|generation| generation.text.clone())
        .unwrap_or_default();
    let error = generation
        .as_ref()
        .and_then(|generation| generation.error.clone());
    let live_timeline = generation
        .as_ref()
        .and_then(|generation| generation.timeline.clone());

    v_flex()
        .id("stream-bubble")
        .w_full()
        .gap_1()
        // Live activity timeline: tool steps and thinking stretches render as
        // they're recorded by the driver's `TimelineProjector`.
        .when_some(
            live_timeline
                .as_ref()
                .filter(|timeline| !timeline.steps.is_empty()),
            |el, timeline| el.child(timeline_feed(timeline, true, cx)),
        )
        .when(thinking_active || !thinking_text.trim().is_empty(), |el| {
            el.child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        thinking_header("stream-thinking-header", true, Some(thinking_active), cx)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.toggle_stream_thinking(cx);
                            })),
                    )
                    .when(expanded, |el| {
                        el.child(
                            div()
                                .w_full()
                                .px_3()
                                .py_2()
                                .rounded_md()
                                .bg(muted)
                                .child(prewrap(&thinking_text)),
                        )
                    }),
            )
        })
        .child(
            TextView::markdown(
                ElementId::Name(SharedString::from("stream-markdown")),
                text,
                window,
                cx,
            )
            .style(Default::default()),
        )
        .when_some(error, |el, message| {
            el.child(
                h_flex()
                    .id("stream-error")
                    .w_full()
                    .gap_2()
                    .items_center()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(danger.opacity(0.12))
                    .child(
                        Icon::new(IconName::TriangleAlert)
                            .small()
                            .text_color(danger),
                    )
                    .child(
                        div()
                            .flex_1()
                            .text_sm()
                            .text_color(foreground)
                            .child(message),
                    )
                    .child(
                        Button::new("stream-retry")
                            .small()
                            .ghost()
                            .label("Retry")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.service
                                    .update(cx, |service, cx| service.retry_last(cx));
                            })),
                    ),
            )
        })
}

/// The collapsible "Thinking" header. `interactive` renders the toggle afford
/// (chevron when settled, spinner while thinking) and is clickable.
fn thinking_header(
    id: impl Into<ElementId>,
    interactive: bool,
    active: Option<bool>,
    cx: &mut App,
) -> gpui::Stateful<gpui::Div> {
    let muted_foreground = cx.theme().muted_foreground;
    let accent = cx.theme().accent;
    let afford = match (interactive, active) {
        (true, Some(true)) => Spinner::new().small().color(accent).into_any_element(),
        (true, _) => Icon::new(IconName::ChevronDown)
            .small()
            .text_color(muted_foreground)
            .into_any_element(),
        (false, _) => div().into_any_element(),
    };
    h_flex()
        .id(id)
        .gap_1()
        .items_center()
        .px_2()
        .py_0p5()
        .rounded_md()
        .cursor_pointer()
        .child(
            Icon::new(IconName::Loader)
                .small()
                .text_color(muted_foreground),
        )
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(muted_foreground)
                .child("Thinking"),
        )
        .child(afford)
}

/// Render plain text preserving newlines (user bubbles, thinking blocks). The
/// markdown view only powers assistant messages.
fn prewrap(text: &str) -> impl IntoElement {
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect();
    v_flex().gap_0p5().children(lines.into_iter().map(|line| {
        div()
            .min_h(px(1.))
            .when(line.is_empty(), |el| el.min_h(px(14.)))
            .child(line)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_bubble_hidden_once_persisted() {
        let persisted = ChatMessage {
            id: "m2".into(),
            role: ChatRole::Assistant,
            content: "the answer".into(),
            created_at: 1,
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        };
        let mut snapshot = ChatSnapshot {
            messages: vec![persisted],
            generation: Some(GenerationState {
                chat_id: "c".into(),
                counter: 1,
                text: "the answer".into(),
                thinking: String::new(),
                thinking_active: false,
                thinking_expanded: false,
                complete: true,
                error: None,
                model: None,
                timeline: None,
            }),
            ..Default::default()
        };
        assert!(!should_show_stream_bubble(&snapshot));

        // Different text than the persisted message → still show it.
        snapshot.messages[0].content = "older".into();
        assert!(should_show_stream_bubble(&snapshot));

        // In-flight generations always show.
        snapshot.generation.as_mut().unwrap().complete = false;
        assert!(should_show_stream_bubble(&snapshot));
    }
}
